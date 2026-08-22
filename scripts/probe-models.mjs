/* 모델 스윕 — 실제 프롬프트, 실제 자막으로.
 *
 * index.js 의 기존 스윕(terra 9.7s 등)은 합성 텍스트로 잰 것이라 절대값이
 * 2배 이상 낙관적이었다. 여기서는 워커의 실제 SYSTEM 과 실제 자막 조각을 쓴다.
 *
 * 모델 교체는 프롬프트 수술과 달리 품질 정의를 바꾸지 않는다. 그래서 먼저 본다.
 * 커버리지(모든 조각을 덮는가)를 함께 검사한다 — 빠르지만 조각을 빠뜨리는
 * 모델은 쓸 수 없다. mergeTranslated 의 I5 가 거기 걸린다.
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

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
  "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
];
const TRIALS = 2;

async function fixture(id) {
  return JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;
}
const payloadFor = (b, cb, ca) =>
  cb.map((t) => `CTX-: ${t}`).join("\n") + (cb.length ? "\n" : "") +
  b.map((s, i) => `${i}: ${s.text}`).join("\n") +
  (ca.length ? "\n" + ca.map((t) => `CTX+: ${t}`).join("\n") : "");

async function call(model, payload, n) {
  const t0 = performance.now();
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, reasoning: { effort: W.REASONING },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: W.SYSTEM("Korean") },
          { role: "user", content: `${payload}\n<!--${Math.random().toString(36).slice(2, 9)}-->` },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ms, ok: false, err: `HTTP ${res.status}` };
    const j = await res.json();
    const u = j.usage || {};
    let lines = null;
    try { lines = JSON.parse(j.choices[0].message.content).lines; } catch { /* 아래에서 처리 */ }
    if (!Array.isArray(lines)) return { ms, ok: false, err: "파싱 실패" };
    // 커버리지 — 모든 조각 인덱스가 덮이는가
    const cov = new Set();
    for (const l of lines) for (let i = Number(l.s) | 0; i <= (Number(l.e) | 0); i++) cov.add(i);
    const missing = [];
    for (let i = 0; i < n; i++) if (!cov.has(i)) missing.push(i);
    const empty = lines.filter((l) => !String(l.t ?? "").trim()).length;
    return { ms, ok: true, out: u.completion_tokens ?? null,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null,
      lines: lines.length, missing: missing.length, empty,
      sample: lines[1] || lines[0] };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), ok: false, err: e.message };
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const CASES = [
  { id: "M7lc1UVf-VE", kind: "수동", i0: 40 },
  { id: "R2vXbFp5C9o", kind: "자동", i0: 40 },
];
const N = 12;

console.log(`\n실제 SYSTEM + 실제 자막, N=${N}, ${TRIALS}회 중앙값, effort=${W.REASONING}\n`);
console.log(`  ${"모델".padEnd(22)} ${"수동 ms".padStart(9)} ${"자동 ms".padStart(9)} ${"출력토큰".padStart(9)} ${"reasoning".padStart(10)}  누락  빈번역`);

for (const model of MODELS) {
  const cells = {};
  let miss = 0, empty = 0, outs = [], reas = [], failed = null;
  for (const c of CASES) {
    const segs = await fixture(c.id);
    const b = segs.slice(c.i0, c.i0 + N);
    const payload = payloadFor(b, segs.slice(c.i0 - 8, c.i0).map((s) => s.text),
      segs.slice(c.i0 + N, c.i0 + N + 8).map((s) => s.text));
    const rs = [];
    for (let i = 0; i < TRIALS; i++) rs.push(await call(model, payload, N));
    const ok = rs.filter((r) => r.ok);
    if (!ok.length) { failed = rs[0].err; cells[c.kind] = "✗"; continue; }
    cells[c.kind] = med(ok.map((r) => r.ms));
    miss += ok.reduce((n, r) => n + r.missing, 0);
    empty += ok.reduce((n, r) => n + r.empty, 0);
    outs.push(...ok.map((r) => r.out));
    reas.push(...ok.map((r) => r.reasoning));
  }
  console.log(
    `  ${model.padEnd(22)} ${String(cells["수동"] ?? "-").padStart(9)} ${String(cells["자동"] ?? "-").padStart(9)}` +
    ` ${String(med(outs) ?? "-").padStart(9)} ${String(med(reas) ?? "-").padStart(10)}` +
    ` ${String(miss).padStart(5)} ${String(empty).padStart(6)}` +
    (failed ? `   ${failed}` : ""));
}
console.log("\n  누락 = 모델이 안 덮은 조각 수 (mergeTranslated 의 I5 가 여기 걸린다). 0 이 아니면 탈락.\n");
