/* 잡음 바닥 — 같은 요청을 두 번 보내면 번역이 얼마나 달라지는가.
 *
 * probe-context.mjs 가 "문맥을 바꾸면 83% 의 줄이 다르게 번역된다"를 냈다.
 * 그 숫자만으로는 아무것도 말할 수 없다. LLM 은 같은 입력에도 매번 다르게
 * 답하기 때문이다. 잡음 바닥이 80% 라면 83% 는 "문맥은 영향이 없다"는 뜻이고,
 * 잡음 바닥이 10% 라면 "문맥이 크게 바꾼다"는 뜻이다.
 *
 * 대조군 없이 낸 차이 수치는 결론이 아니라 착시다.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.YTDUAL_WORKER ?? "http://127.0.0.1:8787";
const CHUNK = 12;
const REPEAT = 3;                 // 같은 조건을 몇 번 반복할지
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const CASES = [
  { id: "M7lc1UVf-VE", kind: "수동 en", lang: "en" },
  { id: "gIwvFMiJNVU", kind: "수동 es", lang: "es" },
  { id: "R2vXbFp5C9o", kind: "자동 en", lang: "en" },
  { id: "D8A2q3awnsU", kind: "자동 ja", lang: "ja" },
];

const fixture = async (id) =>
  JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;
const pad = (s, n) => String(s ?? "").padEnd(n);
const padL = (s, n) => String(s ?? "").padStart(n);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function ask(body) {
  const res = await fetch(`${BASE}/api/subtitle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json().catch(() => ({}));
  return Array.isArray(json.lines) ? json.lines : null;
}

/** 두 응답에서 번역이 다른 줄의 비율 */
function diffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i].trans !== b[i].trans) d++;
  return d / a.length;
}

async function main() {
  console.log(`\n잡음 바닥 측정 — 같은 요청 ${REPEAT}회 반복, 청크 ${CHUNK}조각, 문맥 앞뒤 8줄`);
  console.log(`워커 ${BASE}\n`);

  const perCase = [];
  for (const c of CASES) {
    const segs = await fixture(c.id);
    const i0 = CHUNK * 2;
    const batch = segs.slice(i0, i0 + CHUNK);
    const ctxBefore = segs.slice(i0 - 8, i0).map((s) => s.text);
    const ctxAfter = segs.slice(i0 + CHUNK, i0 + CHUNK + 8).map((s) => s.text);

    const runs = [];
    for (let k = 0; k < REPEAT; k++) {
      // videoId 만 다르다 — 내용·문맥은 완전히 동일하다. 캐시만 비껴간다.
      const lines = await ask({
        videoId: `noise-${runId}-${c.id}-${k}`,
        lang: c.lang, target: "Korean",
        segments: batch, ctxBefore, ctxAfter,
      });
      if (lines) runs.push(lines);
      process.stdout.write(`\r  ${pad(c.id, 13)} ${k + 1}/${REPEAT}   `);
    }
    // 모든 쌍의 차이 비율
    const ratios = [];
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const r = diffRatio(runs[i], runs[j]);
        if (r != null) ratios.push(r);
      }
    }
    perCase.push({ ...c, runs, ratios, lineCount: runs[0]?.length ?? 0 });
  }
  console.log("\n");

  console.log("① 같은 입력을 반복했을 때 달라지는 줄의 비율 (= 잡음 바닥)");
  console.log(`  ${pad("fixture", 14)} ${pad("종류", 9)} ${padL("줄수", 5)} ${padL("쌍", 4)} ${padL("평균", 7)} ${padL("최소", 7)} ${padL("최대", 7)}`);
  for (const c of perCase) {
    if (!c.ratios.length) { console.log(`  ${pad(c.id, 14)} 실패`); continue; }
    console.log(`  ${pad(c.id, 14)} ${pad(c.kind, 9)} ${padL(c.lineCount, 5)} ${padL(c.ratios.length, 4)}` +
      ` ${padL((100 * mean(c.ratios)).toFixed(0) + "%", 7)}` +
      ` ${padL((100 * Math.min(...c.ratios)).toFixed(0) + "%", 7)}` +
      ` ${padL((100 * Math.max(...c.ratios)).toFixed(0) + "%", 7)}`);
  }
  const all = perCase.flatMap((c) => c.ratios);
  console.log(`\n  전체 평균 잡음 바닥: ${(100 * mean(all)).toFixed(0)}%`);
  console.log(`  → probe-context 의 "문맥 바꾸면 83% 가 다름"과 비교할 기준선이다.`);
  console.log(`     둘이 비슷하면 문맥은 번역 내용에 유의미한 영향을 주지 않는다는 뜻이다.\n`);

  console.log("② 같은 입력, 다른 실행 — 실제로 무엇이 달라지는가");
  for (const c of perCase.slice(0, 3)) {
    if (c.runs.length < 2) continue;
    const [a, b] = c.runs;
    const idx = a.map((_, i) => i).filter((i) => a[i].trans !== b[i].trans).slice(0, 2);
    if (!idx.length) { console.log(`\n  ── ${c.id}: 두 실행이 완전히 동일`); continue; }
    console.log(`\n  ── ${c.id} (${c.kind})`);
    for (const i of idx) {
      console.log(`  원문: ${a[i].orig.slice(0, 76)}`);
      console.log(`    1회 → ${a[i].trans}`);
      console.log(`    2회 → ${b[i].trans}`);
    }
  }

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(`${ROOT}.local/bench`, { recursive: true });
  const out = `${ROOT}.local/bench/noise-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ runId, perCase: perCase.map((c) => ({ ...c, runs: c.runs })) }, null, 2));
  console.log(`\n원시 기록 → ${out}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
