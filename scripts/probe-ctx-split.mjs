/* 앞 문맥과 뒤 문맥을 따로 판정한다.
 *
 * 앞선 측정에서 문맥 0줄 vs 8줄은 전체적으로 구별되지 않았다 (심사 10:8, 동점 6).
 * 그런데 자리별로 보면 방향이 갈렸다 — 첫줄 6:3(문맥 쪽), 끝줄 4:5(무의미).
 * 이론과 맞는 패턴이다. 첫 줄은 앞 문맥이 있어야 대명사·생략 주어가 풀리고,
 * 끝 줄에는 뒤 문맥이 딱히 할 일이 없다.
 *
 * 여기서는 그 둘을 분리해 표본을 늘려 결정한다:
 *   ctxBefore 를 유지할 것인가?   → 첫 줄로 판정 (before 0 vs 8, after 는 8 고정)
 *   ctxAfter 를 유지할 것인가?    → 끝 줄로 판정 (after 0 vs 8, before 는 8 고정)
 *
 * 문맥은 공짜가 아니다 — 입력 토큰이 늘고, 프롬프트가 길어질수록 모델이 헷갈릴
 * 여지도 는다. 값을 못 하면 빼는 것이 맞다.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.YTDUAL_WORKER ?? "http://127.0.0.1:8787";
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
const CHUNK = 12, CTX = 8, POSITIONS = 5;
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const CASES = [
  { id: "M7lc1UVf-VE", lang: "en" },
  { id: "gIwvFMiJNVU", lang: "es" },
  { id: "R2vXbFp5C9o", lang: "en" },
  { id: "D8A2q3awnsU", lang: "ja" },
];

const JUDGE_SYSTEM = `You compare two Korean subtitle translations of the same source line.

You get surrounding original lines (context), the source line, and two candidates.
Judge which candidate reads better IN THAT CONTEXT:
- Does it resolve pronouns and dropped subjects correctly?
- Does it connect naturally to the surrounding lines?
- Is it faithful to the source line without inventing or omitting?

Ignore pure style or word-choice differences that do not change meaning or flow.
If neither is clearly better, answer "tie". Being decisive when there is no real
difference is worse than saying tie.

Output ONLY: {"winner":"A"|"B"|"tie","why":"<한 문장>"}`;

const padL = (s, n) => String(s ?? "").padStart(n);
const pad = (s, n) => String(s ?? "").padEnd(n);
const fixture = async (id) =>
  JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;

async function translate(body) {
  const res = await fetch(`${BASE}/api/subtitle`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
  });
  const j = await res.json().catch(() => ({}));
  return Array.isArray(j.lines) ? j.lines : null;
}

async function judge(contextLines, source, a, b) {
  const user = [
    `SURROUNDING CONTEXT (original language):\n${contextLines.join("\n") || "(none)"}`,
    `SOURCE LINE:\n${source}`, `CANDIDATE A:\n${a}`, `CANDIDATE B:\n${b}`,
  ].join("\n\n");
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL, reasoning: { effort: "low" },
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return { winner: null };
    const p = JSON.parse((await res.json()).choices[0].message.content);
    return { winner: ["A", "B", "tie"].includes(p.winner) ? p.winner : null, why: String(p.why ?? "") };
  } catch { return { winner: null }; }
}

async function main() {
  console.log(`\n앞 문맥 / 뒤 문맥 분리 판정 — 청크 ${CHUNK}조각, 문맥 ${CTX}줄, fixture당 ${POSITIONS}지점`);
  console.log(`번역 워커 ${BASE}   심사 ${JUDGE_MODEL}\n`);

  const trials = [];
  for (const c of CASES) {
    const segs = await fixture(c.id);
    const maxStart = segs.length - CHUNK - CTX;
    for (let p = 0; p < POSITIONS; p++) {
      const i0 = CHUNK + Math.floor((maxStart - CHUNK) * p / Math.max(1, POSITIONS - 1));
      if (i0 < CTX || i0 + CHUNK + CTX > segs.length) continue;
      const batch = segs.slice(i0, i0 + CHUNK);
      const before = segs.slice(i0 - CTX, i0).map((s) => s.text);
      const after = segs.slice(i0 + CHUNK, i0 + CHUNK + CTX).map((s) => s.text);
      const mk = (b, a, tag) => ({
        videoId: `split-${runId}-${c.id}-${i0}-${tag}`,
        lang: c.lang, target: "Korean", segments: batch, ctxBefore: b, ctxAfter: a,
      });
      const [full, noBefore, noAfter] = [
        await translate(mk(before, after, "full")),
        await translate(mk([], after, "nb")),
        await translate(mk(before, [], "na")),
      ];
      process.stdout.write(`\r  번역 ${pad(c.id, 13)} @${padL(i0, 4)}   `);
      if (!full || !noBefore || !noAfter) continue;
      if (full.length !== noBefore.length || full.length !== noAfter.length) continue;
      trials.push({ id: c.id, i0, before, after, full, noBefore, noAfter, inner: full.map((l) => l.orig) });
    }
  }
  console.log(`\n  ${trials.length}개 지점 확보\n`);

  const run = async (label, pick, ctxOf, withCtx, withoutCtx) => {
    const t = { with: 0, without: 0, tie: 0, fail: 0 };
    const shown = [];
    for (const tr of trials) {
      const i = pick(tr.full);
      const A = withCtx(tr)[i].trans, B = withoutCtx(tr)[i].trans;
      const withIsA = Math.random() < 0.5;
      const r = await judge(ctxOf(tr), tr.full[i].orig, withIsA ? A : B, withIsA ? B : A);
      if (r.winner === null) { t.fail++; continue; }
      if (r.winner === "tie") { t.tie++; continue; }
      const won = (r.winner === "A") === withIsA;
      if (won) { t.with++; } else { t.without++; }
      if (shown.length < 3 && won) shown.push({ tr, i, A, B, why: r.why });
      process.stdout.write(`\r  심사 ${label} ${t.with + t.without + t.tie}/${trials.length}   `);
    }
    console.log();
    return { t, shown };
  };

  // 앞 문맥: 첫 줄로 판정. 문맥은 "청크 앞의 원문 8줄"
  const beforeRes = await run("앞문맥", () => 0, (tr) => tr.before,
    (tr) => tr.full, (tr) => tr.noBefore);
  // 뒤 문맥: 끝 줄로 판정. 문맥은 "청크 안의 앞 줄들 + 청크 뒤 원문 8줄"
  const afterRes = await run("뒤문맥", (l) => l.length - 1,
    (tr) => [...tr.inner.slice(-4, -1), "→ (다음)", ...tr.after.slice(0, 4)],
    (tr) => tr.full, (tr) => tr.noAfter);

  console.log("\n① 판정");
  const row = (label, t) => {
    const dec = t.with + t.without;
    console.log(`  ${pad(label, 12)} 있음 ${padL(t.with, 2)} / 없음 ${padL(t.without, 2)} / 동점 ${padL(t.tie, 2)}` +
      `   판정 ${padL(dec, 2)}건 중 있음 ${padL(dec ? Math.round(100 * t.with / dec) + "%" : "-", 5)}`);
  };
  row("앞 문맥", beforeRes.t);
  row("뒤 문맥", afterRes.t);

  console.log("\n② 문맥이 이긴 사례");
  for (const [label, res] of [["앞 문맥", beforeRes], ["뒤 문맥", afterRes]]) {
    for (const s of res.shown.slice(0, 2)) {
      console.log(`\n  ── ${label}  ${s.tr.id}@${s.tr.i0}`);
      console.log(`  원문      ${s.tr.full[s.i].orig.slice(0, 74)}`);
      console.log(`  문맥 있음  ${s.A}`);
      console.log(`  문맥 없음  ${s.B}`);
      console.log(`  이유      ${String(s.why).slice(0, 100)}`);
    }
  }

  await mkdir(`${ROOT}.local/bench`, { recursive: true });
  const out = `${ROOT}.local/bench/ctxsplit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ runId, trials, beforeRes: beforeRes.t, afterRes: afterRes.t }, null, 2));
  console.log(`\n원시 기록 → ${out}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
