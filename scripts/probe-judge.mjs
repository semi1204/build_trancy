/* 문맥이 번역 품질을 실제로 올리는가 — 블라인드 A/B 심사.
 *
 * 왜 이렇게까지 하나:
 *   줄 단위 문자열 비교는 답을 못 준다. 잡음 바닥이 81% 인데 문맥을 바꿨을 때
 *   차이도 83% 였다 (probe-noise.mjs / probe-context.mjs). 지연도 사분위가
 *   완전히 겹쳐 구별되지 않았다. 남은 것은 "읽어서 더 나은가" 하나뿐이고,
 *   그건 사람이나 심사 모델이 판단해야 한다.
 *
 * 설계:
 *   - 청크 경계 줄만 본다. 문맥이 효과를 낼 수 있는 유일한 자리다.
 *     첫 줄은 앞 문맥이, 끝 줄은 뒤 문맥이 필요하다.
 *   - 후보 두 개(ctx=0, ctx=8)를 A/B 로 무작위 배치해 심사 모델에 보낸다.
 *     어느 쪽이 어느 조건인지 알려주지 않는다.
 *   - 심사는 번역 대상 모델과 다른 모델로 한다. 같은 모델이면 자기 출력을
 *     선호하는 편향이 섞인다.
 *   - "동점"을 허용한다. 억지로 고르게 하면 잡음이 승패로 둔갑한다.
 *
 * probe-context.mjs 가 남긴 .local/bench/ctx-*.json 을 재사용하므로
 * 번역 요청은 새로 하지 않는다. 심사 호출만 발생한다.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.4";   // 번역 모델(terra)과 다른 모델
const LOW = 0, HIGH = 8;    // 비교할 두 문맥 조건

const JUDGE_SYSTEM = `You compare two Korean subtitle translations of the same source line.

You get the preceding original lines (context), the source line, and two candidate
translations. Judge which candidate reads better AS A CONTINUATION of the context:
- Does it resolve pronouns and dropped subjects correctly?
- Does it connect naturally to what came before?
- Is it faithful to the source line without inventing or omitting?

Ignore differences of pure style or word choice that do not change meaning or flow.
If neither is clearly better, answer "tie". Being decisive when there is no real
difference is worse than saying tie.

Output ONLY: {"winner":"A"|"B"|"tie","why":"<한 문장>"}`;

const pad = (s, n) => String(s ?? "").padEnd(n);
const padL = (s, n) => String(s ?? "").padStart(n);

async function judge(context, source, a, b) {
  const user = [
    `PRECEDING CONTEXT (original language):\n${context.join("\n") || "(none — start of video)"}`,
    `SOURCE LINE:\n${source}`,
    `CANDIDATE A:\n${a}`,
    `CANDIDATE B:\n${b}`,
  ].join("\n\n");
  try {
    const res = await fetch(LLM, {
      method: "POST",
      headers: { Authorization: `Bearer ${E.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        reasoning: { effort: "low" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return { winner: null, why: `HTTP ${res.status}` };
    const j = await res.json();
    const p = JSON.parse(j.choices[0].message.content);
    return { winner: ["A", "B", "tie"].includes(p.winner) ? p.winner : null, why: String(p.why ?? "") };
  } catch (e) {
    return { winner: null, why: e.message };
  }
}

async function main() {
  const dir = `${ROOT}.local/bench`;
  const file = (await readdir(dir)).filter((f) => f.startsWith("ctx-")).sort().pop();
  if (!file) { console.error("ctx-*.json 이 없습니다. 먼저 node scripts/probe-context.mjs"); process.exit(1); }
  const data = JSON.parse(await readFile(`${dir}/${file}`, "utf8"));

  console.log(`\n블라인드 A/B 심사 — 문맥 ${LOW}줄 vs ${HIGH}줄`);
  console.log(`심사 모델 ${JUDGE_MODEL} (번역 모델과 다름)   자료 ${file}\n`);

  // (fixture, i0) 별로 두 조건을 짝지어 경계 줄을 뽑는다
  const keys = [...new Set(data.rows.map((r) => `${r.fixture}@${r.i0}`))];
  const items = [];
  for (const key of keys) {
    const set = data.rows.filter((r) => `${r.fixture}@${r.i0}` === key);
    const lo = set.find((r) => r.ctx === LOW), hi = set.find((r) => r.ctx === HIGH);
    if (!lo || !hi || lo.lines.length !== hi.lines.length) continue;
    const segs = JSON.parse(await readFile(
      `${ROOT}.local/youtube-transcripts/${lo.fixture}/transcript.json`, "utf8")).segments;
    const before = segs.slice(Math.max(0, lo.i0 - 8), lo.i0).map((s) => s.text);
    // 첫 줄: 앞 문맥이 필요한 자리
    items.push({ key, where: "첫줄", context: before,
      source: hi.lines[0].orig, lo: lo.lines[0].trans, hi: hi.lines[0].trans });
    // 끝 줄: 뒤 문맥이 필요한 자리. 심사에는 청크 안의 앞 줄들을 문맥으로 준다.
    const last = hi.lines.length - 1;
    items.push({ key, where: "끝줄", context: hi.lines.slice(Math.max(0, last - 3), last).map((l) => l.orig),
      source: hi.lines[last].orig, lo: lo.lines[last].trans, hi: hi.lines[last].trans });
  }

  const tally = { hi: 0, lo: 0, tie: 0, fail: 0 };
  const detail = [];
  for (const [n, it] of items.entries()) {
    // 무작위 배치 — 심사 모델이 위치로 편향되지 않게
    const hiIsA = Math.random() < 0.5;
    const r = await judge(it.context, it.source, hiIsA ? it.hi : it.lo, hiIsA ? it.lo : it.hi);
    let verdict;
    if (r.winner === null) { tally.fail++; verdict = "실패"; }
    else if (r.winner === "tie") { tally.tie++; verdict = "동점"; }
    else {
      const hiWon = (r.winner === "A") === hiIsA;
      if (hiWon) { tally.hi++; verdict = `문맥${HIGH}`; } else { tally.lo++; verdict = `문맥${LOW}`; }
    }
    detail.push({ ...it, verdict, why: r.why });
    process.stdout.write(`\r  심사 ${n + 1}/${items.length}   `);
  }
  console.log("\n");

  const decided = tally.hi + tally.lo;
  console.log("① 승패");
  console.log(`  문맥 ${HIGH}줄 승 ${tally.hi}`);
  console.log(`  문맥 ${LOW}줄 승 ${tally.lo}`);
  console.log(`  동점        ${tally.tie}`);
  if (tally.fail) console.log(`  심사 실패   ${tally.fail}`);
  console.log(`\n  판정된 ${decided}건 중 문맥 ${HIGH}줄이 ${decided ? (100 * tally.hi / decided).toFixed(0) : 0}% 승`);
  console.log(`  (동점 포함 전체 ${items.length}건 중 동점이 ${(100 * tally.tie / items.length).toFixed(0)}%)`);

  console.log("\n② 자리별");
  for (const where of ["첫줄", "끝줄"]) {
    const d = detail.filter((x) => x.where === where);
    const h = d.filter((x) => x.verdict === `문맥${HIGH}`).length;
    const l = d.filter((x) => x.verdict === `문맥${LOW}`).length;
    const t = d.filter((x) => x.verdict === "동점").length;
    console.log(`  ${where}  문맥${HIGH} ${padL(h, 2)} / 문맥${LOW} ${padL(l, 2)} / 동점 ${padL(t, 2)}`);
  }

  console.log("\n③ 판정이 갈린 사례");
  for (const d of detail.filter((x) => x.verdict.startsWith("문맥")).slice(0, 6)) {
    console.log(`\n  ── ${d.key} ${d.where} → ${d.verdict} 승`);
    console.log(`  원문      ${d.source.slice(0, 76)}`);
    console.log(`  문맥${padL(LOW, 2)}줄  ${d.lo}`);
    console.log(`  문맥${padL(HIGH, 2)}줄  ${d.hi}`);
    console.log(`  이유      ${d.why.slice(0, 110)}`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
