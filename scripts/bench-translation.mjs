/* 번역 지연 벤치마크 — 실제 워커 + 실제 LLM 을 때린다.
 *
 * 왜 필요한가:
 *   test/worker.test.js 의 합성 텍스트(반복 문장)로 재면 절대값이 2배 이상
 *   낙관적으로 나온다. 여기서는 실제 fixture 조각을 그대로 보낸다.
 *
 * 이것은 테스트가 아니라 측정이다. 지연은 분산이 커서 단정하면 flaky 해진다.
 * 비flaky 한 계약(커버리지·빈 번역 없음)은 test/worker.test.js 에 있다.
 *
 * 사용법:
 *   npm run dev                       # 터미널 1 (wrangler, :8787)
 *   node scripts/bench-translation.mjs
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { holes } from "../test/fixtures.js";

const BASE = process.env.YTDUAL_WORKER ?? "http://127.0.0.1:8787";
const TARGET = process.env.YTDUAL_TARGET ?? "Korean";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_DIR = join(ROOT, ".local/youtube-transcripts");
const OUT_DIR = join(ROOT, ".local/bench");

/* target=Korean 이므로 ko 원본은 제외한다 (한국어→한국어는 번역 부하가 다르다).
 * 수동 2 / 자동 2 로 나눈 이유: full 의 MERGE 부담이 두 종류에서 완전히 다르다.
 * 자동 자막은 구두점이 0 이고 문장 중간에서 끊긴다. 한쪽만 재면 답이 반쪽이다. */
const FIXTURES = [
  { id: "M7lc1UVf-VE", kind: "수동", lang: "en" },
  { id: "gIwvFMiJNVU", kind: "수동", lang: "es" },
  { id: "R2vXbFp5C9o", kind: "자동", lang: "en" },
  { id: "D8A2q3awnsU", kind: "자동", lang: "ja" },
];

/* 두 셀은 같은 i0 를 공유한다. C 는 B 의 상위집합이라 크기 효과를 읽을 수 있다. */
const CELLS = [
  { id: "B", n: 8, label: "N=8" },
  { id: "C", n: 12, label: "N=12" },
];

const CTX_N = 8;          // content.js 와 동일
const MAX_LINE_CHARS = 85; // 워커 index.js:327 과 같은 값. 넘으면 enforceShortLines 발동(W4 위반)
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** --cells A,B 로 일부 셀만 다시 잴 수 있다. 결함 하나를 파려고 36요청을 다시 쓰지 않게. */
const onlyCells = (process.argv.find((a) => a.startsWith("--cells="))?.slice(8) ?? "")
  .split(",").filter(Boolean);
const ACTIVE = onlyCells.length ? CELLS.filter((c) => onlyCells.includes(c.id)) : CELLS;

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pad = (s, n) => String(s ?? "").padEnd(n);
const padL = (s, n) => String(s ?? "").padStart(n);

async function loadFixture(f) {
  const dir = join(FIXTURE_DIR, f.id);
  const transcript = JSON.parse(await readFile(join(dir, "transcript.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  return {
    ...f,
    segments: transcript.segments,
    title: manifest.source.title,
    subtitleKind: manifest.capture.subtitleKind,
  };
}

/** content.js:963-966 과 같은 방식으로 요청 본문을 만든다. */
function buildBody(fx, i0, cell) {
  const segments = fx.segments.slice(i0, i0 + cell.n);
  return {
    videoId: `bench-${runId}-${cell.id}-${fx.id}-${i0}`,   // 캐시 확실히 미스
    lang: fx.lang,
    target: TARGET,
    segments,
    ctxBefore: fx.segments.slice(Math.max(0, i0 - CTX_N), i0).map((s) => s.text),
    ctxAfter: fx.segments.slice(i0 + cell.n, i0 + cell.n + CTX_N).map((s) => s.text),
  };
}

async function post(body, timeoutMs = 180_000) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/subtitle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, status: 0, json: { error: e.message }, ms: Math.round(performance.now() - t0) };
  }
}

/** 응답에서 측정 항목을 뽑는다. 계약 위반은 여기서 기록만 하고 중단하지 않는다
 *  (지연 표본을 모으는 것이 목적이고, 위반 자체가 결과의 일부다). */
function measure(cell, segments, json) {
  const u = json.usage;
  const rec = {
    ms: null,
    outTokens: u?.completion_tokens ?? null,
    promptTokens: u?.prompt_tokens ?? null,
    reasoning: u?.completion_tokens_details?.reasoning_tokens ?? null,
    degraded: json.degraded === true,
    cached: json.cached === true,
    violations: [],
  };

  {
    const lines = json.lines;
    if (!Array.isArray(lines) || !lines.length) rec.violations.push("lines 가 비었음");
    else {
      // 조각 커버리지 — 반환 줄이 입력 구간을 구멍 없이 덮는가.
      // mergeTranslated 의 I5 는 이게 성립한다는 전제 위에 있다.
      const gap = holes(segments, lines);
      rec.lineCount = lines.length;
      rec.holes = gap.length;
      rec.holeSec = +gap.reduce((n, [a, b]) => n + (b - a), 0).toFixed(2);
      rec.maxOrig = Math.max(...lines.map((l) => String(l.orig ?? "").length));
      if (rec.maxOrig > MAX_LINE_CHARS) rec.violations.push(`W4 최장 ${rec.maxOrig}자`);

      // ★ 번역이 빈 줄. mergeTranslated 가 tier:"full" 로 도장을 찍으므로 I21 에 의해
      //   분할된 형태로 KV 에 저장되므로 새로고침해도 같다 — 화면에 원문만 남는다.
      //   원인이 둘이라 구분해서 센다:
      //     (a) LLM 이 t 를 비워 보냄        → 이웃과 시간이 안 겹치는 단독 빈 줄
      //     (b) splitLine/packToK 의 꼬리 유실 → 앞줄이 시간상 이어지고 번역이 있는 경우
      //         (index.js:385 `tParts[i] || ""`. 번역의 절 조각 수 < 원문 분할 수면 꼬리가 빈다)
      const empty = lines.map((l, i) => ({ l, i })).filter(({ l }) => !String(l.trans ?? "").trim());
      rec.emptyTrans = empty.length;
      rec.emptyTail = empty.filter(({ i }) =>
        i > 0 && String(lines[i - 1].trans ?? "").trim() &&
        Math.abs(Number(lines[i - 1].end) - Number(lines[i].start)) < 1e-6).length;
      rec.emptySolo = rec.emptyTrans - rec.emptyTail;

      rec.lines = lines.map((l) => ({ o: l.orig, t: l.trans, s: l.start, e: l.end }));
      const mid = Math.max(0, (lines.length >> 1) - 1);
      rec.samples = lines.slice(mid, mid + 2).map((l) => ({ orig: l.orig, trans: l.trans }));
    }
  }
  return rec;
}

async function main() {
  console.log(`# 번역 벤치마크  run=${runId}`);
  console.log(`  worker=${BASE}  target=${TARGET}\n`);

  // ── 사전 점검 ──────────────────────────────────────────────────────
  const fixtures = [];
  for (const f of FIXTURES) {
    try { fixtures.push(await loadFixture(f)); }
    catch (e) { console.error(`✗ fixture ${f.id} 없음: ${e.message}`); process.exit(1); }
  }
  console.log("fixture:");
  for (const f of fixtures) {
    console.log(`  ${pad(f.id, 13)} ${f.kind} ${pad(f.lang, 3)} ${padL(f.segments.length, 4)}조각  ${f.title.slice(0, 42)}`);
  }

  // 카나리아 — 36요청을 낭비하기 전에 워커·상류(CLIProxyAPI) 경로를 확인한다.
  // 워밍업도 겸한다 (첫 요청의 연결 수립 비용이 A 셀에만 실리면 비교가 왜곡된다).
  process.stdout.write("\n카나리아(N=2) … ");
  const canary = await post({
    videoId: `bench-${runId}-canary`, lang: "en", target: TARGET,
    segments: fixtures[0].segments.slice(0, 2),
  }, 120_000);
  if (!canary.ok || !Array.isArray(canary.json.lines)) {
    console.log("실패");
    console.error(`  status=${canary.status} ${JSON.stringify(canary.json).slice(0, 300)}`);
    console.error("  → 워커(:8787) 와 CLIProxyAPI(:8317) 상태를 확인하세요. 중단합니다.");
    process.exit(1);
  }
  console.log(`ok ${canary.ms}ms`);

  // ── 측정 ───────────────────────────────────────────────────────────
  const results = [];
  const total = fixtures.length * 3 * ACTIVE.length;
  let done = 0;

  for (const fx of fixtures) {
    // 앞/중간/뒤. 가장 큰 셀(N=12)이 넘치지 않게 맞춘다.
    const maxN = Math.max(...CELLS.map((c) => c.n));
    const last = Math.max(0, fx.segments.length - maxN);
    const positions = [...new Set([0, Math.max(0, (fx.segments.length >> 1) - (maxN >> 1)), last])];

    for (const i0 of positions) {
      // 같은 (fixture, 위치) 의 세 셀을 연속으로 — 같은 조건에서 A vs B 가 나란히 측정된다
      for (const cell of ACTIVE) {
        const body = buildBody(fx, i0, cell);
        const { ok, status, json, ms } = await post(body);
        done++;

        if (json.cached === true) {
          console.error(`\n✗ 캐시 히트 발생 (${cell.id} ${fx.id} @${i0}). 수치가 무의미해집니다. 중단.`);
          process.exit(1);
        }

        const rec = ok
          ? { ...measure(cell, body.segments, json), ms }
          : { ms, error: `${status} ${String(json.error).slice(0, 120)}`, violations: [] };

        results.push({ fixture: fx.id, kind: fx.kind, lang: fx.lang, i0, cell: cell.id, n: cell.n, ...rec });

        const mark = rec.error ? "✗" : rec.violations.length ? "!" : "·";
        process.stdout.write(
          `\r[${padL(done, 2)}/${total}] ${mark} ${pad(fx.id, 13)} @${padL(i0, 4)} ${pad(cell.label, 10)} ${padL(ms, 6)}ms` +
          (rec.error ? ` ${rec.error}` : "") + "   ",
        );
        if (rec.error || rec.violations.length) process.stdout.write("\n");
      }
    }
  }
  console.log("\n");

  // ── 집계 ───────────────────────────────────────────────────────────
  const clean = (rows) => rows.filter((r) => !r.error && !r.degraded);

  console.log("① 크기별 지연");
  console.log(`  ${pad("종류", 6)} ${pad("셀", 11)} ${padL("n", 3)} ${padL("중앙ms", 8)} ${padL("최소", 7)} ${padL("최대", 7)} ${padL("out토큰", 8)} ${padL("reason", 7)} ${padL("degr", 5)}`);
  for (const kind of ["수동", "자동"]) {
    for (const cell of ACTIVE) {
      const rows = results.filter((r) => r.kind === kind && r.cell === cell.id);
      const c = clean(rows);
      console.log(`  ${pad(kind, 6)} ${pad(cell.label, 11)} ${padL(c.length, 3)} ${padL(median(c.map((r) => r.ms)) ?? "-", 8)} ${padL(Math.min(...c.map((r) => r.ms)) || "-", 7)} ${padL(Math.max(...c.map((r) => r.ms)) || "-", 7)} ${padL(median(c.map((r) => r.outTokens).filter((x) => x != null)) ?? "-", 8)} ${padL(median(c.map((r) => r.reasoning).filter((x) => x != null)) ?? "-", 7)} ${padL(rows.filter((r) => r.degraded).length, 5)}`);
    }
  }

  console.log("\n② 크기 효과 — N=8 vs N=12");
  console.log(`  ${pad("종류", 6)} ${pad("셀", 11)} ${padL("n", 3)} ${padL("중앙ms", 8)} ${padL("out토큰", 8)} ${padL("reason", 7)}`);
  for (const kind of ["수동", "자동"]) {
    for (const cell of ACTIVE) {
      const c = clean(results.filter((r) => r.kind === kind && r.cell === cell.id));
      console.log(`  ${pad(kind, 6)} ${pad(cell.label, 11)} ${padL(c.length, 3)} ${padL(median(c.map((r) => r.ms)) ?? "-", 8)} ${padL(median(c.map((r) => r.outTokens).filter((x) => x != null)) ?? "-", 8)} ${padL(median(c.map((r) => r.reasoning).filter((x) => x != null)) ?? "-", 7)}`);
    }
  }

  console.log("\n③ 조각 커버리지 — 반환 줄이 입력 구간을 덮는가 (mergeTranslated I5 의 전제)");
  console.log(`  ${pad("fixture", 13)} ${pad("셀", 11)} ${padL("요청", 5)} ${padL("구멍발생", 9)} ${padL("구멍초", 8)} ${padL("최장줄", 7)} ${padL("줄수중앙", 9)}`);
  for (const fx of fixtures) {
    for (const cell of ACTIVE) {
      const rows = results.filter((r) => r.fixture === fx.id && r.cell === cell.id && !r.error);
      if (!rows.length) continue;
      console.log(`  ${pad(fx.id, 13)} ${pad(cell.label, 11)} ${padL(rows.length, 5)} ${padL(rows.filter((r) => r.holes > 0).length, 9)} ${padL(rows.reduce((n, r) => n + (r.holeSec || 0), 0).toFixed(2), 8)} ${padL(Math.max(...rows.map((r) => r.maxOrig || 0)), 7)} ${padL(median(rows.map((r) => r.lineCount).filter((x) => x != null)) ?? "-", 9)}`);
    }
  }


  console.log("\n③-2 빈 번역 — mergeTranslated 가 tier:\"full\" 로 찍으면 I21 때문에 영영 안 채워진다");
  console.log(`  ${pad("셀", 11)} ${padL("요청", 5)} ${padL("빈줄있는요청", 13)} ${padL("빈줄", 6)} ${padL("전체줄", 7)} ${padL("비율", 7)} ${padL("꼬리유실", 9)} ${padL("단독", 5)}`);
  for (const cell of ACTIVE) {
    const rows = results.filter((r) => r.cell === cell.id && !r.error && r.lineCount);
    if (!rows.length) continue;
    const empty = rows.reduce((n, r) => n + (r.emptyTrans || 0), 0);
    const totalLines = rows.reduce((n, r) => n + r.lineCount, 0);
    console.log(`  ${pad(cell.label, 11)} ${padL(rows.length, 5)} ${padL(rows.filter((r) => r.emptyTrans > 0).length, 13)} ${padL(empty, 6)} ${padL(totalLines, 7)} ${padL((100 * empty / totalLines).toFixed(1) + "%", 7)} ${padL(rows.reduce((n, r) => n + (r.emptyTail || 0), 0), 9)} ${padL(rows.reduce((n, r) => n + (r.emptySolo || 0), 0), 5)}`);
  }
  const badLines = results.filter((r) => r.lines)
    .flatMap((r) => r.lines.map((l, i) => ({ r, l, prev: r.lines[i - 1] })))
    .filter(({ l }) => !String(l.t ?? "").trim());
  if (badLines.length) {
    console.log("\n  빈 번역 줄 실례 (최대 6개):");
    for (const { r, l, prev } of badLines.slice(0, 6)) {
      console.log(`    ${r.fixture} ${r.cell}@${r.i0}  원문: ${String(l.o).slice(0, 72)}`);
      if (prev) console.log(`      직전줄 번역: ${String(prev.t ?? "").slice(0, 60) || "(비어있음)"}`);
    }
  }

  console.log("\n④ 샘플 — 번역이 뜻이 통하는가");
  for (const fx of fixtures) {
    console.log(`\n  ── ${fx.id} (${fx.kind} ${fx.lang}) ──`);
    for (const cell of ACTIVE) {
      const row = results.find((r) => r.fixture === fx.id && r.cell === cell.id && r.samples?.length);
      if (!row) continue;
      console.log(`  [${cell.label}]`);
      for (const s of row.samples) {
        console.log(`    원문: ${s.orig}`);
        console.log(`    번역: ${s.trans}`);
      }
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify({ runId, base: BASE, target: TARGET, cells: ACTIVE, results }, null, 2));
  console.log(`\n원시 기록 → ${outPath}`);

  const errs = results.filter((r) => r.error);
  if (errs.length) console.log(`\n⚠ 실패 ${errs.length}/${results.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
