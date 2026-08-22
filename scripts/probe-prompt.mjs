/* 프롬프트별 원가를 잰다 — 워커를 거치지 않고 상류에 직접.
 *
 * probe-latency.mjs 로 상류가 느리지 않다는 것을 확인했다 (단순 프롬프트 4.4초,
 * 동시 8개도 완전 병렬). 그렇다면 워커가 보고하는 11~30초는 프롬프트가 만든다.
 * 여기서는 워커의 실제 SYSTEM / FAST_SYSTEM 을 실제 자막 텍스트에 붙여 잰다.
 *
 * 프롬프트는 사본이 아니라 test/worker-harness.js 로 워커 소스에서 직접 꺼낸다.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWorker } from "../test/worker-harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const W = loadWorker();

const E = await (async () => {
  const txt = await readFile(`${ROOT}ytdual/worker/.dev.vars`, "utf8");
  const out = {};
  for (const l of txt.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0 && !l.trimStart().startsWith("#")) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
})();
const LLM = E.LLM_URL || "https://api.openai.com/v1/chat/completions";

async function fixture(id) {
  const t = JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8"));
  return t.segments;
}

/** 워커 translateBatch 와 같은 형태로 payload 를 만든다 */
function payloadFor(batch, ctxB, ctxA, fast) {
  const numbered = batch.map((s, i) => `${i}: ${s.text}`).join("\n");
  return fast ? numbered
    : ctxB.map((t) => `CTX-: ${t}`).join("\n") + (ctxB.length ? "\n" : "") +
      numbered + (ctxA.length ? "\n" + ctxA.map((t) => `CTX+: ${t}`).join("\n") : "");
}

async function call({ system, payload, effort, nonce }) {
  const t0 = performance.now();
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: W.LLM_MODEL,
        reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${payload}\n<!--${nonce}-->` },   // 상류 캐시 회피
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const ms = Math.round(performance.now() - t0);
    const j = await res.json().catch(() => ({}));
    const u = j.usage || {};
    return {
      ms, ok: res.ok,
      prompt: u.prompt_tokens ?? null,
      out: u.completion_tokens ?? null,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null,
    };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), ok: false, err: e.message };
  }
}

const line = (label, r) =>
  `  ${label.padEnd(38)} ${String(r.ms).padStart(7)}ms  ` +
  (r.ok ? `in=${String(r.prompt).padStart(5)} out=${String(r.out).padStart(5)} reasoning=${String(r.reasoning).padStart(5)}`
        : `✗ ${r.err || ""}`);

const segs = await fixture("M7lc1UVf-VE");        // 수동 en
const auto = await fixture("R2vXbFp5C9o");        // 자동 en
const nonce = () => Math.random().toString(36).slice(2, 9);

console.log(`\n상류 ${LLM}   모델 ${W.LLM_MODEL}   REASONING(full)=${W.REASONING}\n`);

console.log("① 실제 프롬프트 — 같은 조각(N=8, 수동 자막)에 프롬프트만 다르게");
{
  const b = segs.slice(40, 48);
  const ctxB = segs.slice(32, 40).map((s) => s.text);
  const ctxA = segs.slice(48, 56).map((s) => s.text);
  console.log(line("FAST_SYSTEM  effort=none  CTX 없음",
    await call({ system: W.FAST_SYSTEM("Korean"), payload: payloadFor(b, [], [], true), effort: "none", nonce: nonce() })));
  console.log(line(`SYSTEM(full) effort=${W.REASONING}   CTX 16줄`,
    await call({ system: W.SYSTEM("Korean"), payload: payloadFor(b, ctxB, ctxA, false), effort: W.REASONING, nonce: nonce() })));
  console.log(line("SYSTEM(full) effort=none   CTX 16줄",
    await call({ system: W.SYSTEM("Korean"), payload: payloadFor(b, ctxB, ctxA, false), effort: "none", nonce: nonce() })));
  console.log(line("SYSTEM(full) effort=low    CTX 없음",
    await call({ system: W.SYSTEM("Korean"), payload: payloadFor(b, [], [], false), effort: "low", nonce: nonce() })));
}

console.log("\n② N 을 키우면 (SYSTEM full, effort=low, CTX 16줄)");
for (const n of [8, 12, 24]) {
  const b = segs.slice(40, 40 + n);
  const ctxB = segs.slice(Math.max(0, 40 - 8), 40).map((s) => s.text);
  const ctxA = segs.slice(40 + n, 40 + n + 8).map((s) => s.text);
  console.log(line(`N=${n}`, await call({
    system: W.SYSTEM("Korean"), payload: payloadFor(b, ctxB, ctxA, false),
    effort: W.REASONING, nonce: nonce(),
  })));
}

console.log("\n③ 자동생성 자막 (구두점 없음 — 병합 부담이 크다)");
{
  const b = auto.slice(40, 52);
  const ctxB = auto.slice(32, 40).map((s) => s.text);
  const ctxA = auto.slice(52, 60).map((s) => s.text);
  console.log(line("SYSTEM(full) N=12 effort=low", await call({
    system: W.SYSTEM("Korean"), payload: payloadFor(b, ctxB, ctxA, false), effort: W.REASONING, nonce: nonce() })));
  console.log(line("FAST_SYSTEM  N=8  effort=none", await call({
    system: W.FAST_SYSTEM("Korean"), payload: payloadFor(auto.slice(40, 48), [], [], true), effort: "none", nonce: nonce() })));
}
console.log();
