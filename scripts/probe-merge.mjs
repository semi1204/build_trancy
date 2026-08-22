/* 구두점 없는 자막에서 문장을 합칠 수 있는가 — 지연을 얼마나 치르고.
 *
 * 지금은 기계가 묶는다. 구두점이 있는 자막에서는 잘 된다(George Hotz 90% 가
 * 문장 경계에서 끝난다). 그런데 구두점이 0% 인 자동생성 자막에서는 찾을 경계가
 * 없어 85자에서 아무 데나 잘린다:
 *     "about 20 different storerooms divided into freezers fridges walking fridges"
 *     "and rice stores seafood meat vegetables and fruit are all divided and stored in"
 * 각 줄의 번역은 토막이 된다.
 *
 * 옛날에 모델에게 병합을 시켰다가 버린 이유는 지연이었다(자동 ja 47초). 그런데
 * 그때는 병합 + 자막줄 분할 + 원문 재출력 + 번역을 한 번에 시켰다. 출력의 절반이
 * 원문 재출력이었다. 병합만 시키고 출력을 "번역 + 시작 인덱스"로 줄이면 출력
 * 토큰이 지금과 비슷해진다 — 그러면 지연도 비슷할 수 있다.
 *
 * 인덱스를 s 하나만 받는 것이 중요하다. 각 줄은 자기 s 부터 다음 줄의 s 직전까지를
 * 덮으므로 커버리지에 구멍이 생길 수 없다. 옛 {s,e} 방식은 모델이 조각을 빠뜨려
 * 화면이 비는 사고가 실제로 났다(W20).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWorker } from "../test/worker-harness.js";
import { loadContent } from "../test/harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const W = loadWorker();
const Y = loadContent();
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

/* 병합까지 시키는 프롬프트. 과제는 둘이다 — 어디서 문장이 끝나는지 정하고 번역한다.
 * 원문은 돌려받지 않는다(확장이 이미 갖고 있다). 인덱스도 시작 하나만 받는다. */
const MERGE_SYSTEM = (target, n) => `You translate caption fragments into natural ${target}.

The ${n} numbered fragments below have no punctuation and are cut mid-sentence.
Join consecutive fragments that belong to the same sentence, then translate each
resulting sentence.

- "s" = index of the FIRST fragment the sentence starts at.
- The first line must have s=0. s must strictly increase. A line covers everything
  from its s up to the next line's s.
- "t" = natural ${target} translation of that whole sentence. Translate meaning,
  not word-for-word. Keep proper nouns and technical terms.
- Do not echo the original text. Do not add or omit content.

Output ONLY: {"lines":[{"s":0,"t":"..."}]}`;

const CASES = [
  { id: "R2vXbFp5C9o", dur: 473, lang: "en", i0: 40 },
  { id: "a0CVCcb0RJM", dur: 719, lang: "en", i0: 60 },
  { id: "SCS1dJ35lig", dur: 479, lang: "es", i0: 40 },
  { id: "RDrTtZwQ0k4", dur: 412, lang: "es", i0: 40 },
];
const TRIALS = 3;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const pad = (s, n) => String(s ?? "").padEnd(n);
const padL = (s, n) => String(s ?? "").padStart(n);

async function call(system, user, effort) {
  const t0 = Date.now();
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: W.LLM_MODEL, reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system },
          { role: "user", content: `${user}\n<!--${Math.random().toString(36).slice(2, 8)}-->` }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return { ms: Date.now() - t0, ok: false };
    const j = await res.json();
    const u = j.usage || {};
    let parsed = null;
    try { parsed = JSON.parse(j.choices[0].message.content); } catch { /* 아래 */ }
    return { ms: Date.now() - t0, ok: true, parsed,
      out: u.completion_tokens ?? null,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null };
  } catch { return { ms: Date.now() - t0, ok: false }; }
}

console.log(`\n구두점 없는 자막에서 문장 합치기  모델 ${W.LLM_MODEL}  ${TRIALS}회 중앙값\n`);
console.log(`  ${pad("fixture", 14)} ${pad("방식", 18)} ${padL("ms", 7)} ${padL("출력", 6)} ${padL("reason", 7)} ${padL("줄", 4)} 계약`);

const totals = {};
for (const c of CASES) {
  const segs = Y.normalizeSegments(
    JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${c.id}/transcript.json`, "utf8")).segments, c.dur);
  const job = Y.makeJobs(segs, 12).find((j) => j.i0 >= c.i0);
  const batch = job.segs;
  const ctxB = segs.slice(Math.max(0, job.i0 - 8), job.i0).map((s) => s.text);
  const ctxA = segs.slice(job.i0 + batch.length, job.i0 + batch.length + 8).map((s) => s.text);

  // A: 지금 방식 — 기계가 묶고 1:1 번역
  const units = W.groupSegments(batch);
  const aRuns = [];
  for (let k = 0; k < TRIALS; k++) {
    aRuns.push(await call(W.SYSTEM("Korean", units.length), W.buildPayload(units, ctxB, ctxA), W.REASONING));
  }
  const aOk = aRuns.filter((r) => r.ok && Array.isArray(r.parsed?.t) && r.parsed.t.length === units.length);
  (totals["A 기계 묶기"] ??= []).push(...aOk.map((r) => r.ms));
  console.log(`  ${pad(c.id, 14)} ${pad("A 기계 묶기", 18)} ${padL(med(aOk.map((r) => r.ms)), 7)}` +
    ` ${padL(med(aOk.map((r) => r.out)), 6)} ${padL(med(aOk.map((r) => r.reasoning)), 7)}` +
    ` ${padL(units.length, 4)} ${aOk.length}/${TRIALS}`);

  // B: 모델이 병합 — 번역 + 시작 인덱스만
  const numbered = batch.map((s, i) => `${i}: ${s.text}`).join("\n");
  const user = [
    ctxB.length ? `CONTEXT BEFORE:\n${ctxB.join("\n")}` : null,
    ctxA.length ? `CONTEXT AFTER:\n${ctxA.join("\n")}` : null,
    `FRAGMENTS (${batch.length}):\n${numbered}`,
  ].filter(Boolean).join("\n\n");
  const bRuns = [];
  for (let k = 0; k < TRIALS; k++) {
    bRuns.push(await call(MERGE_SYSTEM("Korean", batch.length), user, "none"));
  }
  const valid = (r) => {
    const L = r.parsed?.lines;
    if (!Array.isArray(L) || !L.length) return false;
    if (Number(L[0].s) !== 0) return false;
    for (let i = 1; i < L.length; i++) if (!(Number(L[i].s) > Number(L[i - 1].s))) return false;
    return Number(L.at(-1).s) < batch.length && L.every((x) => String(x.t ?? "").trim());
  };
  const bOk = bRuns.filter((r) => r.ok && valid(r));
  (totals["B 모델 병합"] ??= []).push(...bOk.map((r) => r.ms));
  console.log(`  ${pad("", 14)} ${pad("B 모델 병합", 18)} ${padL(med(bOk.map((r) => r.ms)), 7)}` +
    ` ${padL(med(bOk.map((r) => r.out)), 6)} ${padL(med(bOk.map((r) => r.reasoning)), 7)}` +
    ` ${padL(med(bOk.map((r) => r.parsed.lines.length)), 4)} ${bOk.length}/${TRIALS}`);

  const sample = bOk[0];
  if (sample) {
    console.log(`      A: ${units[0].text.slice(0, 74)}`);
    console.log(`         → ${aOk[0]?.parsed?.t?.[0] ?? "?"}`);
    const L = sample.parsed.lines;
    const covered = batch.slice(L[0].s, L[1] ? L[1].s : batch.length).map((s) => s.text).join(" ");
    console.log(`      B: ${covered.slice(0, 74)}`);
    console.log(`         → ${L[0].t}`);
  }
  console.log();
}

console.log("전체 중앙값");
for (const [k, v] of Object.entries(totals)) console.log(`  ${pad(k, 14)} ${padL(med(v), 7)}ms  (n=${v.length})`);
console.log();
