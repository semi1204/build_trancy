/* 지연이 어느 층에서 생기는지 분리한다.
 *
 *   브라우저 → 하네스(:8788) → 워커(:8787) → CLIProxyAPI(:8317) → 상류 모델
 *
 * 층을 나눠 재지 않으면 "느리다"에서 "무엇을 고쳐야 하는가"로 넘어갈 수 없다.
 * 비밀값은 출력하지 않는다 (.dev.vars 에서 읽기만 한다).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEV_VARS = `${ROOT}ytdual/worker/.dev.vars`;

async function env() {
  const txt = await readFile(DEV_VARS, "utf8");
  const out = {};
  for (const line of txt.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.trimStart().startsWith("#")) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const E = await env();
const LLM = E.LLM_URL || "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5.6-terra";

const seg = (n, tag) => Array.from({ length: n }, (_, i) => ({
  start: i * 3, end: i * 3 + 2.8,
  text: `Line ${i} about ${tag} and the thing that happened next.`,
}));

const FAST_SYSTEM = `Translate each numbered subtitle fragment into natural Korean.
Keep the same numbering and the same number of items. Do not merge, split,
reorder, or explain.
Output ONLY: {"t":["...","..."]} — one translation per input, same order, same count.`;

async function raw({ n = 8, effort = "none", system = FAST_SYSTEM, label }) {
  const numbered = seg(n, `${label}-${Math.random().toString(36).slice(2, 7)}`)
    .map((s, i) => `${i}: ${s.text}`).join("\n");
  const t0 = performance.now();
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: numbered }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Math.round(performance.now() - t0);
    const body = await res.text();
    let usage = null;
    try { usage = JSON.parse(body).usage; } catch { /* 파싱 실패도 정보다 */ }
    return { ms, status: res.status, ok: res.ok,
      out: usage?.completion_tokens ?? null,
      reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      err: res.ok ? null : body.slice(0, 160) };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), status: 0, ok: false, err: e.message };
  }
}

const row = (label, r) =>
  `  ${label.padEnd(34)} ${String(r.ms).padStart(7)}ms  ${r.ok ? "ok " : "✗  "}` +
  (r.out != null ? `out=${String(r.out).padStart(4)} reasoning=${String(r.reasoning ?? "?").padStart(4)}` : "") +
  (r.err ? `  ${r.err}` : "");

console.log(`\n상류: ${LLM}   모델: ${MODEL}\n`);

console.log("① 원 LLM 호출 (워커를 거치지 않음)");
console.log(row("fast 형태 N=8 effort=none", await raw({ n: 8, effort: "none", label: "a" })));
console.log(row("fast 형태 N=8 effort=none (2회차)", await raw({ n: 8, effort: "none", label: "b" })));
console.log(row("아주 짧게 N=2 effort=none", await raw({ n: 2, effort: "none", label: "c" })));
console.log(row("N=8 effort=low", await raw({ n: 8, effort: "low", label: "d" })));

console.log("\n② 동시성 — 프록시가 직렬화하는가");
for (const c of [1, 4, 8]) {
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: c }, (_, i) =>
    raw({ n: 8, effort: "none", label: `p${c}-${i}` })));
  const wall = Math.round(performance.now() - t0);
  const each = rs.map((r) => r.ms).sort((a, b) => a - b);
  const fails = rs.filter((r) => !r.ok).length;
  console.log(`  동시 ${String(c).padStart(2)}개 → 전체 ${String(wall).padStart(7)}ms` +
    `  개별 최소 ${String(each[0]).padStart(6)} 최대 ${String(each.at(-1)).padStart(6)}` +
    `  ${fails ? `실패 ${fails}` : ""}` +
    `  ${c > 1 ? `직렬화 지수 ${(wall / each.at(-1)).toFixed(2)}` : ""}`);
}
console.log("    (직렬화 지수 ≈1 이면 병렬, ≈동시요청수 면 완전 직렬)\n");
