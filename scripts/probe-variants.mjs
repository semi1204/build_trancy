/* full 프롬프트의 출력 토큰을 줄이면 얼마나 빨라지는가.
 *
 * probe-prompt.mjs 결과: 지연은 출력 토큰에 거의 비례하고, 자동생성 자막에서
 * SYSTEM 이 1899토큰(reasoning 1552)을 써서 35.5초가 걸린다.
 *
 * 현재 SYSTEM 은 모델에게 셋을 동시에 시킨다:
 *   (1) 조각 병합  (2) 자막 줄로 재분할  (3) 원문 재출력("o") + 번역("t")
 * 이 중 (3)의 "원문 재출력"이 출력 토큰의 절반가량을 차지한다. s/e 인덱스가 이미
 * 어느 조각을 덮는지 알려주므로, 원문은 확장이 segments[s..e] 로 이어붙일 수 있다.
 * 잃는 것은 모델이 넣어주던 구두점·대문자 정리다.
 *
 * 각 변형을 같은 조각에 3회씩 돌려 중앙값을 본다 (단발은 분산이 커서 못 믿는다).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWorker } from "../test/worker-harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const W = loadWorker();
const E = await (async () => {
  const txt = await readFile(`${ROOT}ytdual/worker/.dev.vars`, "utf8");
  const o = {};
  for (const l of txt.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0 && !l.trimStart().startsWith("#")) o[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return o;
})();
const LLM = E.LLM_URL || "https://api.openai.com/v1/chat/completions";

/* 변형 B — 원문 재출력을 뺀다. 규칙도 필요한 것만 남긴다. */
const NO_ORIG = (target) => `You merge broken YouTube caption fragments into subtitle lines and translate them.

1) MERGE fragments into complete sentences. A fragment boundary means nothing.
2) SPLIT into subtitle lines of ~5-12 words, each a coherent phrase, broken at
   clause boundaries. Never put two sentences in one line. A trailing "So,"/"And"
   starts the next line.

- "s"/"e" = first/last source fragment index the line covers. Non-decreasing,
  covering every fragment exactly once.
- "t" = natural ${target} translation of that line. Translate meaning, not words.
- Lines starting with "CTX-"/"CTX+" are context only. Never output lines for them.
- Do NOT echo the original text.
Output ONLY: {"lines":[{"s":0,"e":1,"t":"..."}]}`;

/* 변형 C — 병합만 시키고 분할은 워커가 기계적으로 한다 (splitLine 이 이미 있다) */
const MERGE_ONLY = (target) => `You merge broken YouTube caption fragments into complete sentences and translate them.

Fragments are cut mid-sentence at random points; a fragment boundary means nothing.
Join them into complete sentences. One output line per sentence.

- "s"/"e" = first/last source fragment index the sentence covers. Non-decreasing,
  covering every fragment exactly once.
- "t" = natural ${target} translation. Translate meaning, not words.
- Lines starting with "CTX-"/"CTX+" are context only. Never output lines for them.
- Do NOT echo the original text.
Output ONLY: {"lines":[{"s":0,"e":1,"t":"..."}]}`;

async function fixture(id) {
  return JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;
}
function payloadFor(batch, ctxB, ctxA) {
  const numbered = batch.map((s, i) => `${i}: ${s.text}`).join("\n");
  return ctxB.map((t) => `CTX-: ${t}`).join("\n") + (ctxB.length ? "\n" : "") +
    numbered + (ctxA.length ? "\n" + ctxA.map((t) => `CTX+: ${t}`).join("\n") : "");
}
async function call(system, payload, effort) {
  const t0 = performance.now();
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: W.LLM_MODEL, reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${payload}\n<!--${Math.random().toString(36).slice(2, 9)}-->` },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Math.round(performance.now() - t0);
    const j = await res.json().catch(() => ({}));
    const u = j.usage || {};
    let lines = null;
    try { lines = JSON.parse(j.choices[0].message.content).lines; } catch { /* 파싱 실패 기록 */ }
    return { ms, ok: res.ok, out: u.completion_tokens ?? null,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null,
      lines: Array.isArray(lines) ? lines.length : null, sample: lines?.[1] ?? lines?.[0] ?? null };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), ok: false, err: e.message };
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

const CASES = [
  { id: "M7lc1UVf-VE", kind: "수동", i0: 40, n: 12 },
  { id: "R2vXbFp5C9o", kind: "자동", i0: 40, n: 12 },
];
const VARIANTS = [
  { name: "A 현재 SYSTEM (o+t)", sys: W.SYSTEM, effort: W.REASONING },
  { name: "B 원문 재출력 제거 (t만)", sys: NO_ORIG, effort: W.REASONING },
  { name: "C 병합만 + 분할은 워커", sys: MERGE_ONLY, effort: W.REASONING },
  { name: "C' 병합만 + effort=none", sys: MERGE_ONLY, effort: "none" },
];
const TRIALS = 3;

console.log(`\n상류 ${LLM}  모델 ${W.LLM_MODEL}  ${TRIALS}회 중앙값  N=12\n`);
for (const c of CASES) {
  const segs = await fixture(c.id);
  const batch = segs.slice(c.i0, c.i0 + c.n);
  const ctxB = segs.slice(Math.max(0, c.i0 - 8), c.i0).map((s) => s.text);
  const ctxA = segs.slice(c.i0 + c.n, c.i0 + c.n + 8).map((s) => s.text);
  const payload = payloadFor(batch, ctxB, ctxA);

  console.log(`── ${c.id} (${c.kind})`);
  let base = null;
  for (const v of VARIANTS) {
    const rs = [];
    for (let i = 0; i < TRIALS; i++) rs.push(await call(v.sys("Korean"), payload, v.effort));
    const okr = rs.filter((r) => r.ok);
    if (!okr.length) { console.log(`  ${v.name.padEnd(26)} 전부 실패`); continue; }
    const ms = med(okr.map((r) => r.ms));
    if (base === null) base = ms;
    console.log(
      `  ${v.name.padEnd(26)} ${String(ms).padStart(6)}ms` +
      `  out ${String(med(okr.map((r) => r.out))).padStart(5)}` +
      `  reasoning ${String(med(okr.map((r) => r.reasoning))).padStart(5)}` +
      `  줄 ${String(med(okr.map((r) => r.lines ?? 0))).padStart(3)}` +
      `  ${base === ms ? "" : `${(ms / base).toFixed(2)}배`}`);
  }
  const s = (await call(VARIANTS[2].sys("Korean"), payload, VARIANTS[2].effort)).sample;
  if (s) console.log(`  C 출력 예: ${JSON.stringify(s).slice(0, 150)}`);
  console.log();
}
