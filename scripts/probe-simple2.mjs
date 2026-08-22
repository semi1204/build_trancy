/* "번역만 시킨다" 안 — 2차. 1차에서 드러난 두 결함을 고치고 다시 잰다.
 *
 * 1차 결과(probe-simple.mjs): 자동자막에서 21.6→5.2초, 41.5→5.6초(reasoning 1616→0).
 *   그러나 계약위반(개수 불일치)이 3회 중 1~2회 났다.
 *
 * 결함 1 — CTX 를 번호 목록에 섞었다. 워커 주석 W16 이 이미 경고한 것이다:
 *   "번호 없는 줄이 섞이면 모델이 그것까지 세어 t 의 길이가 밀린다."
 *   고침: CTX 를 구분된 블록으로 빼고, 번역할 줄 수를 프롬프트에 명시한다.
 *
 * 결함 2 — 묶기 한도 80자가 표시 한도(MAX_LINE_CHARS 85)와 어긋나, 81자짜리
 *   한 문장이 둘로 갈라져 URL 이 중간에서 끊겼다("Developers.Googl" / "e.com/...").
 *   고침: 한도를 표시 한도에 맞춘다.
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

/* 과제는 하나뿐이다 — 번역. 병합·분할·원문재출력을 전부 뺐다.
 * 개수는 프롬프트에 숫자로 박는다. 이것이 유일한 계약이고 기계가 검사한다. */
const SIMPLE = (target, n) => `Translate subtitle lines into natural ${target}.

You will get ${n} numbered lines to translate, and optionally CONTEXT blocks.
CONTEXT is background only — never translate or count it.

- Translate meaning, not word-for-word. Keep proper nouns and technical terms.
- Use the context so pronouns and dropped subjects read naturally.
- A line may be cut mid-sentence. Translate it as the partial phrase it is;
  do not complete it, do not borrow words from the next line.
- Do not merge, split, reorder, add, or omit anything.

Output ONLY: {"t":[...]} with exactly ${n} strings, in the same order.`;

const SENT_END = /[.!?…。？！]["'”’)\]]?$/;
function groupSegments(segs, { maxChars = 85, maxGap = 1.2, maxSecs = 8 } = {}) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (!cur) { cur = { start: s.start, end: s.end, text: s.text, n: 1 }; continue; }
    const joined = `${cur.text} ${s.text}`;
    const breakHere =
      SENT_END.test(cur.text) ||
      joined.length > maxChars ||
      s.start - cur.end > maxGap ||
      s.end - cur.start > maxSecs;
    if (breakHere) { out.push(cur); cur = { start: s.start, end: s.end, text: s.text, n: 1 }; }
    else { cur.text = joined; cur.end = s.end; cur.n++; }
  }
  if (cur) out.push(cur);
  return out;
}

/** CTX 를 번호 목록 밖으로 뺀다 (W16) */
function payload(lines, cb, ca) {
  const parts = [];
  if (cb.length) parts.push(`CONTEXT BEFORE:\n${cb.join("\n")}`);
  if (ca.length) parts.push(`CONTEXT AFTER:\n${ca.join("\n")}`);
  parts.push(`TRANSLATE THESE ${lines.length} LINES:\n${lines.map((s, i) => `${i}: ${s.text}`).join("\n")}`);
  return parts.join("\n\n");
}

async function fixture(id) {
  return JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;
}

async function call({ system, user, effort }) {
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
          { role: "user", content: `${user}\n<!--${Math.random().toString(36).slice(2, 9)}-->` },
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
    return { ms, ok: true, parsed, out: u.completion_tokens ?? null,
      reasoning: u.completion_tokens_details?.reasoning_tokens ?? null };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), ok: false, err: e.message };
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

const CASES = [
  { id: "M7lc1UVf-VE", kind: "수동 en", i0: 40 },
  { id: "gIwvFMiJNVU", kind: "수동 es", i0: 40 },
  { id: "R2vXbFp5C9o", kind: "자동 en", i0: 40 },
  { id: "D8A2q3awnsU", kind: "자동 ja", i0: 30 },
  { id: "HnvitMTkXro", kind: "자동 ko", i0: 40 },
];
const N = 12, TRIALS = 4;

console.log(`\n모델 ${W.LLM_MODEL}  원조각 N=${N}  ${TRIALS}회 중앙값`);
console.log(`묶기: 문장끝 | 85자 | 간격 1.2s | 8초\n`);

const totals = { A: [], E: [] };
for (const c of CASES) {
  const all = await fixture(c.id);
  const raw = all.slice(c.i0, c.i0 + N);
  const cb = all.slice(Math.max(0, c.i0 - 8), c.i0).map((s) => s.text);
  const ca = all.slice(c.i0 + N, c.i0 + N + 8).map((s) => s.text);
  const grouped = groupSegments(raw);

  console.log(`── ${c.id} (${c.kind}) — ${raw.length}조각 → ${grouped.length}줄  ` +
    `최장 ${Math.max(...grouped.map((g) => g.text.length))}자`);

  // A: 현재 SYSTEM (기준선)
  const aRuns = [];
  for (let i = 0; i < TRIALS; i++) {
    aRuns.push(await call({
      system: W.SYSTEM("Korean"),
      user: cb.map((t) => `CTX-: ${t}`).join("\n") + "\n" +
        raw.map((s, i2) => `${i2}: ${s.text}`).join("\n") + "\n" +
        ca.map((t) => `CTX+: ${t}`).join("\n"),
      effort: W.REASONING,
    }));
  }
  const aOk = aRuns.filter((r) => r.ok && Array.isArray(r.parsed?.lines));
  const aMs = med(aOk.map((r) => r.ms));

  // E: 단순 프롬프트 + 묶은 줄
  const eRuns = [];
  for (let i = 0; i < TRIALS; i++) {
    eRuns.push(await call({
      system: SIMPLE("Korean", grouped.length),
      user: payload(grouped, cb, ca),
      effort: "none",
    }));
  }
  const eOk = eRuns.filter((r) => r.ok);
  const eBad = eOk.filter((r) => !Array.isArray(r.parsed?.t) || r.parsed.t.length !== grouped.length).length;
  const eMs = med(eOk.map((r) => r.ms));
  totals.A.push(aMs); totals.E.push(eMs);

  console.log(`  A 현재 SYSTEM      ${String(aMs).padStart(6)}ms  out ${String(med(aOk.map((r) => r.out))).padStart(5)}  reasoning ${String(med(aOk.map((r) => r.reasoning))).padStart(5)}  계약위반 ${aRuns.length - aOk.length}/${TRIALS}`);
  console.log(`  E 단순+묶음        ${String(eMs).padStart(6)}ms  out ${String(med(eOk.map((r) => r.out))).padStart(5)}  reasoning ${String(med(eOk.map((r) => r.reasoning))).padStart(5)}  계약위반 ${eBad}/${TRIALS}   ${(eMs / aMs).toFixed(2)}배`);

  const good = eOk.find((r) => Array.isArray(r.parsed?.t) && r.parsed.t.length === grouped.length);
  if (good) {
    grouped.slice(0, 3).forEach((g, i) => {
      console.log(`    [${g.n}조각] ${g.text.slice(0, 76)}`);
      console.log(`       → ${good.parsed.t[i]}`);
    });
  }
  console.log();
}
console.log(`전체 중앙: A ${med(totals.A)}ms → E ${med(totals.E)}ms  (${(med(totals.E) / med(totals.A)).toFixed(2)}배)\n`);
