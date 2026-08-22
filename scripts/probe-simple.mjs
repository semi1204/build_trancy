/* "번역만 시키고, 단위는 우리가 정한다" 안을 잰다.
 *
 * 현재 SYSTEM 은 모델에게 셋을 동시에 시킨다: 병합 + 자막줄 분할 + 원문 재출력.
 * 그 복잡도가 reasoning 을 만들고, reasoning 이 지연을 만든다
 * (실측: 자동자막 N=12 에서 out 1318 / reasoning 950 / 31.6초).
 *
 * 대안 — 프롬프트는 "문맥에 맞게 자연스럽게 번역" 하나만 남기고, 무엇을 한 줄로
 * 볼지는 우리가 조각을 묶어서 정한다. 모델의 과제가 1:1 번역으로 줄면
 * reasoning 이 사라지고, 출력도 번역문뿐이라 절반이 된다.
 * 계약도 단순해진다 — 개수 일치 하나뿐이고, 그건 기계가 검사할 수 있다.
 *
 * 변형:
 *   A  현재 SYSTEM (병합+분할+원문재출력)        — 기준선
 *   D  단순 프롬프트, 원조각 그대로 1:1
 *   E  단순 프롬프트, 기계로 문장 묶은 뒤 1:1     ← 제안
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

/* ── 제안하는 프롬프트: 과제는 하나뿐이다 ────────────────────────── */
const SIMPLE = (target) => `Translate each numbered subtitle line into natural ${target}.
Use the surrounding lines as context so pronouns and dropped subjects read naturally.
Translate meaning, not word-for-word. Keep proper nouns and technical terms.
Do not merge, split, reorder, add, or omit anything.
Output ONLY: {"t":["...","..."]} — one translation per input, same order, same count.`;

/* ── 조각 묶기: 무엇을 "한 줄"로 볼지 우리가 정한다 ──────────────── */
const SENT_END = /[.!?…。？！]["'”’)\]]?$/;
/**
 * @param {{start:number,end:number,text:string}[]} segs
 * @param {object} o
 * @param {number} o.maxChars  한 줄 최대 글자 (자막 한 줄이 읽히는 한도)
 * @param {number} o.maxGap    이 이상 시간이 벌어지면 무조건 끊는다 (화면 전환·침묵)
 * @param {number} o.maxSecs   한 줄이 덮는 최대 시간
 */
function groupSegments(segs, { maxChars = 80, maxGap = 1.2, maxSecs = 8 } = {}) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (!cur) { cur = { start: s.start, end: s.end, text: s.text, from: [s] }; continue; }
    const joined = `${cur.text} ${s.text}`;
    const tooLong = joined.length > maxChars;
    const gap = s.start - cur.end;
    const breakHere =
      SENT_END.test(cur.text) ||          // 앞 줄이 문장으로 끝났다
      tooLong ||                          // 자막 한 줄로 읽기엔 길다
      gap > maxGap ||                     // 침묵이 있었다
      s.end - cur.start > maxSecs;        // 너무 오래 붙잡는다
    if (breakHere) { out.push(cur); cur = { start: s.start, end: s.end, text: s.text, from: [s] }; }
    else { cur.text = joined; cur.end = s.end; cur.from.push(s); }
  }
  if (cur) out.push(cur);
  return out;
}

async function fixture(id) {
  return JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;
}
const numbered = (b) => b.map((s, i) => `${i}: ${s.text}`).join("\n");
const withCtx = (b, cb, ca) =>
  cb.map((t) => `CTX-: ${t}`).join("\n") + (cb.length ? "\n" : "") + numbered(b) +
  (ca.length ? "\n" + ca.map((t) => `CTX+: ${t}`).join("\n") : "");

async function call({ model = W.LLM_MODEL, system, payload, effort }) {
  const t0 = performance.now();
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${payload}\n<!--${Math.random().toString(36).slice(2, 9)}-->` },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ms, ok: false, err: `HTTP ${res.status}` };
    const j = await res.json();
    const u = j.usage || {};
    let parsed = null;
    try { parsed = JSON.parse(j.choices[0].message.content); } catch { /* 아래 */ }
    return { ms, ok: true, parsed,
      out: u.completion_tokens ?? null,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), ok: false, err: e.message };
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const CASES = [
  { id: "M7lc1UVf-VE", kind: "수동", i0: 40 },
  { id: "R2vXbFp5C9o", kind: "자동", i0: 40 },
  { id: "D8A2q3awnsU", kind: "자동ja", i0: 30 },
];
const N = 12;
const TRIALS = 3;

console.log(`\n모델 ${W.LLM_MODEL}   원조각 N=${N}   ${TRIALS}회 중앙값\n`);

for (const c of CASES) {
  const all = await fixture(c.id);
  const raw = all.slice(c.i0, c.i0 + N);
  const cb = all.slice(Math.max(0, c.i0 - 8), c.i0).map((s) => s.text);
  const ca = all.slice(c.i0 + N, c.i0 + N + 8).map((s) => s.text);
  const grouped = groupSegments(raw);

  console.log(`── ${c.id} (${c.kind}) — 원조각 ${raw.length}개 → 묶은 뒤 ${grouped.length}줄`);

  const runs = {};
  const go = async (key, opts, n) => {
    const rs = [];
    for (let i = 0; i < TRIALS; i++) rs.push(await call(opts));
    const ok = rs.filter((r) => r.ok);
    if (!ok.length) { console.log(`  ${key.padEnd(30)} 실패 ${rs[0].err}`); return; }
    const bad = ok.filter((r) => {
      const t = r.parsed?.t ?? r.parsed?.lines;
      return !Array.isArray(t) || (opts.expectCount && t.length !== n);
    }).length;
    runs[key] = { ms: med(ok.map((r) => r.ms)), out: med(ok.map((r) => r.out)),
      reasoning: med(ok.map((r) => r.reasoning)), bad, sample: ok[0].parsed };
    const base = runs["A 현재 SYSTEM"]?.ms;
    console.log(`  ${key.padEnd(30)} ${String(runs[key].ms).padStart(6)}ms` +
      `  out ${String(runs[key].out).padStart(5)}` +
      `  reasoning ${String(runs[key].reasoning).padStart(5)}` +
      `  계약위반 ${bad}/${ok.length}` +
      (base && base !== runs[key].ms ? `  ${(runs[key].ms / base).toFixed(2)}배` : ""));
  };

  await go("A 현재 SYSTEM", { system: W.SYSTEM("Korean"), payload: withCtx(raw, cb, ca), effort: W.REASONING }, N);
  await go("D 단순+원조각 1:1", { system: SIMPLE("Korean"), payload: withCtx(raw, cb, ca), effort: "none", expectCount: true }, N);
  await go("E 단순+묶은줄 1:1", { system: SIMPLE("Korean"), payload: withCtx(grouped, cb, ca), effort: "none", expectCount: true }, grouped.length);

  const e = runs["E 단순+묶은줄 1:1"];
  if (e?.sample?.t) {
    console.log("  E 출력 예:");
    grouped.slice(0, 3).forEach((g, i) => {
      console.log(`    ${g.start.toFixed(1)}–${g.end.toFixed(1)} (${g.from.length}조각) ${g.text.slice(0, 78)}`);
      console.log(`      → ${e.sample.t[i]}`);
    });
  }
  console.log();
}
