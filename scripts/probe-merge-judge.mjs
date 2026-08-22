/* 기계 묶기(A) vs 모델 병합(B) — 2배 지연을 치를 값이 있는가.
 *
 * B 는 A 의 2배 걸린다(14.6s vs 7.4s). 대신 완결된 문장을 만든다. 문제는
 * "완결된 문장"이 실제로 더 읽기 좋은지다. 한국어는 연결어미(-고, -며)로
 * 자연스럽게 이어지므로, 조각으로 끊겨도 연속으로 읽으면 통할 수 있다.
 *
 * 자막은 한 줄씩 보는 게 아니라 이어서 본다. 그래서 줄 하나가 아니라
 * "연속된 여러 줄"을 통째로 비교한다. 심사 모델은 어느 쪽이 A 이고 B 인지 모른다.
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
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.4";

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

const JUDGE = `두 개의 한국어 자막 묶음을 비교한다. 같은 영상의 같은 구간이고,
줄 나눔만 다르다. 시청자는 이 줄들을 순서대로 이어서 읽는다.

어느 쪽이 자막으로 더 읽기 좋은가:
- 이어서 읽었을 때 뜻이 자연스럽게 흐르는가
- 한 줄이 도중에 끊겨 뜻을 알 수 없게 되지 않는가
- 원문(영어/스페인어)의 내용을 빠뜨리거나 지어내지 않았는가
- 줄이 지나치게 길어 한눈에 안 들어오지 않는가

문체나 단어 선택 차이는 무시한다. 뚜렷한 차이가 없으면 "tie".
억지로 고르는 것이 실제 차이가 없다고 말하는 것보다 나쁘다.

출력은 오직: {"winner":"A"|"B"|"tie","why":"<한 문장>"}`;

const CASES = [
  { id: "R2vXbFp5C9o", dur: 473, spots: [40, 90, 140] },
  { id: "a0CVCcb0RJM", dur: 719, spots: [60, 150, 240] },
  { id: "SCS1dJ35lig", dur: 479, spots: [40, 80, 120] },
  { id: "RDrTtZwQ0k4", dur: 412, spots: [40, 80, 110] },
];

async function ask(system, user, effort) {
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: arguments[3] || W.LLM_MODEL, reasoning: { effort },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system },
          { role: "user", content: `${user}\n<!--${Math.random().toString(36).slice(2, 8)}-->` }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    return JSON.parse((await res.json()).choices[0].message.content);
  } catch { return null; }
}

async function judge(source, a, b) {
  const user = `원문 (자막 조각, 순서대로):\n${source}\n\n` +
    `A:\n${a.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n` +
    `B:\n${b.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL, reasoning: { effort: "low" },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: JUDGE }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return { winner: null };
    const p = JSON.parse((await res.json()).choices[0].message.content);
    return { winner: ["A", "B", "tie"].includes(p.winner) ? p.winner : null, why: String(p.why ?? "") };
  } catch { return { winner: null }; }
}

const tally = { mech: 0, model: 0, tie: 0, fail: 0 };
const notes = [];
console.log(`\n기계 묶기 vs 모델 병합 — 블라인드 판정 (심사 ${JUDGE_MODEL})\n`);

for (const c of CASES) {
  const segs = Y.normalizeSegments(
    JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${c.id}/transcript.json`, "utf8")).segments, c.dur);
  const jobs = Y.makeJobs(segs, 12);
  for (const spot of c.spots) {
    const job = jobs.find((j) => j.i0 >= spot);
    if (!job) continue;
    const batch = job.segs;
    const ctxB = segs.slice(Math.max(0, job.i0 - 8), job.i0).map((s) => s.text);
    const ctxA = segs.slice(job.i0 + batch.length, job.i0 + batch.length + 8).map((s) => s.text);

    const units = W.groupSegments(batch);
    const aRes = await ask(W.SYSTEM("Korean", units.length), W.buildPayload(units, ctxB, ctxA), W.REASONING);
    const numbered = batch.map((s, i) => `${i}: ${s.text}`).join("\n");
    const bUser = [ctxB.length ? `CONTEXT BEFORE:\n${ctxB.join("\n")}` : null,
      ctxA.length ? `CONTEXT AFTER:\n${ctxA.join("\n")}` : null,
      `FRAGMENTS (${batch.length}):\n${numbered}`].filter(Boolean).join("\n\n");
    const bRes = await ask(MERGE_SYSTEM("Korean", batch.length), bUser, "none");

    const aLines = Array.isArray(aRes?.t) && aRes.t.length === units.length ? aRes.t : null;
    const bLines = Array.isArray(bRes?.lines) && bRes.lines.every((x) => String(x.t ?? "").trim())
      ? bRes.lines.map((x) => x.t) : null;
    if (!aLines || !bLines) { tally.fail++; process.stdout.write(`\r  ${c.id}@${spot} 실패   `); continue; }

    const mechIsA = Math.random() < 0.5;
    const r = await judge(batch.map((s) => s.text).join("\n"),
      mechIsA ? aLines : bLines, mechIsA ? bLines : aLines);
    if (r.winner === null) { tally.fail++; continue; }
    if (r.winner === "tie") tally.tie++;
    else if ((r.winner === "A") === mechIsA) { tally.mech++; notes.push({ w: "기계", c, spot, why: r.why, aLines, bLines }); }
    else { tally.model++; notes.push({ w: "모델", c, spot, why: r.why, aLines, bLines }); }
    process.stdout.write(`\r  판정 ${tally.mech + tally.model + tally.tie}/${CASES.length * 3}   `);
  }
}
console.log("\n");

const dec = tally.mech + tally.model;
console.log(`  기계 묶기 승 ${tally.mech}`);
console.log(`  모델 병합 승 ${tally.model}`);
console.log(`  동점         ${tally.tie}`);
if (tally.fail) console.log(`  실패         ${tally.fail}`);
if (dec) console.log(`\n  판정 ${dec}건 중 모델 병합 ${Math.round(100 * tally.model / dec)}%`);

const C = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
if (dec) {
  let p = 0;
  const w = Math.max(tally.mech, tally.model);
  for (let k = w; k <= dec; k++) p += C(dec, k) * Math.pow(0.5, dec);
  console.log(`  이항검정 p=${p.toFixed(3)} ${p < 0.05 ? "(유의)" : "(유의하지 않음)"}`);
}

console.log("\n판정 사례");
for (const n of notes.slice(0, 3)) {
  console.log(`\n── ${n.c.id}@${n.spot} → ${n.w} 승`);
  console.log(`   기계: ${n.aLines.slice(0, 3).join(" / ").slice(0, 110)}`);
  console.log(`   모델: ${n.bLines.slice(0, 3).join(" / ").slice(0, 110)}`);
  console.log(`   이유: ${n.why.slice(0, 110)}`);
}
console.log();
