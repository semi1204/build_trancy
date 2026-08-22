/* 문맥(CTX)을 얼마나 보내야 하는가.
 *
 * 현재는 앞뒤 각 8줄이다 (content.js 의 CTX_N). 문맥은 번역 대상이 아니라
 * 배경으로만 들어간다 — 줄 수를 늘리면 입력 토큰이 늘고, 줄이면 청크 경계에서
 * 대명사·생략 주어가 안 풀릴 수 있다.
 *
 * 비교가 깨끗한 이유: 묶기(groupSegments)는 batch 만 보므로 CTX 를 바꿔도
 * units 가 똑같이 나온다. 즉 같은 줄끼리 1:1 로 번역만 비교하면 된다.
 *
 * 재는 것
 *   1. 지연·토큰            — 문맥을 줄이면 싸지는가
 *   2. 번역이 실제로 달라지는 비율 — 문맥이 결과에 영향을 주기는 하는가
 *   3. 청크 경계 줄          — 문맥이 효과를 내야 하는 유일한 자리다
 *
 * 실행: npm run dev (워커) 뒤에 node scripts/probe-context.mjs
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadWorker } from "../test/worker-harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.YTDUAL_WORKER ?? "http://127.0.0.1:8787";
const W = loadWorker();

const CTX_LEVELS = [0, 4, 8];     // 앞뒤 각각. 8 이 현재 값
const CHUNK = 12;
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const CASES = [
  { id: "M7lc1UVf-VE", kind: "수동 en" },
  { id: "gIwvFMiJNVU", kind: "수동 es" },
  { id: "R2vXbFp5C9o", kind: "자동 en" },
  { id: "D8A2q3awnsU", kind: "자동 ja" },
];

const fixture = async (id) =>
  JSON.parse(await readFile(`${ROOT}.local/youtube-transcripts/${id}/transcript.json`, "utf8")).segments;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const pad = (s, n) => String(s ?? "").padEnd(n);
const padL = (s, n) => String(s ?? "").padStart(n);

async function post(body) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/subtitle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json, ms: Math.round(performance.now() - t0) };
}

async function main() {
  console.log(`\n문맥 양 비교 — 앞뒤 각 ${CTX_LEVELS.join("/")}줄,  청크 ${CHUNK}조각,  캐시 미스`);
  console.log(`워커 ${BASE}\n`);

  const rows = [];       // {fixture, kind, i0, ctx, ms, promptTok, outTok, reasoning, lines}
  for (const c of CASES) {
    const segs = await fixture(c.id);
    // i0=0 은 앞 문맥이 없어 비교가 성립하지 않는다. 문맥이 꽉 차는 지점만 쓴다.
    const positions = [CHUNK * 2, CHUNK * 4, Math.max(CHUNK * 2, segs.length - CHUNK * 3)]
      .filter((i, k, a) => i + CHUNK <= segs.length && a.indexOf(i) === k);

    for (const i0 of positions) {
      const batch = segs.slice(i0, i0 + CHUNK);
      for (const ctx of CTX_LEVELS) {
        const body = {
          videoId: `ctx-${runId}-${c.id}-${i0}-${ctx}`,   // 캐시 확실히 미스
          lang: c.id.includes("D8A2") ? "ja" : "en",
          target: "Korean",
          segments: batch,
          ctxBefore: ctx ? segs.slice(Math.max(0, i0 - ctx), i0).map((s) => s.text) : [],
          ctxAfter: ctx ? segs.slice(i0 + CHUNK, i0 + CHUNK + ctx).map((s) => s.text) : [],
        };
        const { ok, json, ms } = await post(body);
        if (!ok || !Array.isArray(json.lines)) {
          console.log(`  ✗ ${c.id} @${i0} ctx=${ctx}: ${JSON.stringify(json).slice(0, 120)}`);
          continue;
        }
        rows.push({
          fixture: c.id, kind: c.kind, i0, ctx, ms,
          promptTok: json.usage?.prompt_tokens ?? null,
          outTok: json.usage?.completion_tokens ?? null,
          reasoning: json.usage?.completion_tokens_details?.reasoning_tokens ?? null,
          lines: json.lines,
        });
        process.stdout.write(`\r  ${pad(c.id, 13)} @${padL(i0, 4)} ctx=${ctx}  ${padL(ms, 6)}ms   `);
      }
    }
  }
  console.log("\n");

  // ── 1. 지연·토큰 ────────────────────────────────────────────────
  console.log("① 지연과 토큰");
  console.log(`  ${pad("문맥", 8)} ${padL("n", 3)} ${padL("중앙ms", 8)} ${padL("입력토큰", 9)} ${padL("출력토큰", 9)} ${padL("reasoning", 10)}`);
  for (const ctx of CTX_LEVELS) {
    const r = rows.filter((x) => x.ctx === ctx);
    if (!r.length) continue;
    console.log(`  ${pad(`앞뒤 ${ctx}`, 8)} ${padL(r.length, 3)} ${padL(med(r.map((x) => x.ms)), 8)}` +
      ` ${padL(med(r.map((x) => x.promptTok).filter((x) => x != null)), 9)}` +
      ` ${padL(med(r.map((x) => x.outTok).filter((x) => x != null)), 9)}` +
      ` ${padL(med(r.map((x) => x.reasoning).filter((x) => x != null)), 10)}`);
  }

  // ── 2. 문맥이 번역을 바꾸는가 ───────────────────────────────────
  console.log("\n② 문맥이 번역을 실제로 바꾸는가 (같은 줄끼리 1:1 비교)");
  console.log(`  ${pad("fixture", 13)} ${pad("비교", 12)} ${padL("다른 줄", 8)} ${padL("전체", 5)} ${padL("비율", 7)}  경계줄 변화`);
  const groups = [...new Set(rows.map((r) => `${r.fixture}@${r.i0}`))];
  const diffTotals = {};
  for (const key of groups) {
    const set = rows.filter((r) => `${r.fixture}@${r.i0}` === key);
    const base = set.find((r) => r.ctx === 8);
    if (!base) continue;
    for (const ctx of CTX_LEVELS.filter((c) => c !== 8)) {
      const other = set.find((r) => r.ctx === ctx);
      if (!other || other.lines.length !== base.lines.length) continue;
      let diff = 0;
      const edge = [];
      for (let i = 0; i < base.lines.length; i++) {
        if (base.lines[i].trans !== other.lines[i].trans) {
          diff++;
          if (i === 0 || i === base.lines.length - 1) edge.push(i === 0 ? "첫줄" : "끝줄");
        }
      }
      const label = `${ctx} vs 8`;
      (diffTotals[label] ??= []).push(diff / base.lines.length);
      console.log(`  ${pad(key.split("@")[0], 13)} ${pad(label, 12)} ${padL(diff, 8)} ${padL(base.lines.length, 5)}` +
        ` ${padL((100 * diff / base.lines.length).toFixed(0) + "%", 7)}  ${edge.join(",") || "-"}`);
    }
  }
  console.log();
  for (const [label, arr] of Object.entries(diffTotals)) {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    console.log(`  ${label}: 평균 ${(100 * avg).toFixed(0)}% 의 줄이 다르게 번역됨`);
  }

  // ── 3. 경계 줄 품질 ─────────────────────────────────────────────
  console.log("\n③ 청크 경계 줄 — 문맥이 효과를 내야 하는 유일한 자리");
  for (const key of groups.slice(0, 6)) {
    const set = rows.filter((r) => `${r.fixture}@${r.i0}` === key);
    const base = set.find((r) => r.ctx === 8);
    if (!base) continue;
    const first = base.lines[0], last = base.lines[base.lines.length - 1];
    console.log(`\n  ── ${key}`);
    console.log(`  [첫 줄] ${first.orig.slice(0, 74)}`);
    for (const ctx of CTX_LEVELS) {
      const r = set.find((x) => x.ctx === ctx);
      if (r) console.log(`     ctx${padL(ctx, 2)} → ${r.lines[0].trans}`);
    }
    console.log(`  [끝 줄] ${last.orig.slice(0, 74)}`);
    for (const ctx of CTX_LEVELS) {
      const r = set.find((x) => x.ctx === ctx);
      if (r) console.log(`     ctx${padL(ctx, 2)} → ${r.lines[r.lines.length - 1].trans}`);
    }
  }
  console.log();

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(`${ROOT}.local/bench`, { recursive: true });
  const out = `${ROOT}.local/bench/ctx-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(out, JSON.stringify({ runId, levels: CTX_LEVELS, rows }, null, 2));
  console.log(`원시 기록 → ${out}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
