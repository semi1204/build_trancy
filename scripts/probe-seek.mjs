/* 체감 지연 — "시작/시킹부터 재생 지점에 번역이 뜨기까지" 몇 초인가.
 *
 * 청크 하나의 왕복 시간이 아니라 사용자가 실제로 기다리는 시간을 잰다. 둘은 다르다:
 *   콜드 스타트 — runner 8개가 모두 비어 있으므로 재생 청크가 즉시 발사된다. 1왕복.
 *   시킹        — runner 8개가 이미 옛 재생 위치 청크를 붙잡고 있다. 하나가 빌 때까지
 *                 기다린 뒤에야 새 재생 청크가 발사된다. 최대 2왕복.
 *
 * content.js 의 runner 구조를 그대로 흉내낸다 — 같은 우선순위 함수, 같은 동시성,
 * 같은 워커. 다른 것은 "재생 위치를 도중에 바꾼다"는 것뿐이다.
 *
 * 실행: npm run dev 뒤에 node scripts/probe-seek.mjs [fixtureId]
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadContent } from "../test/harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = process.env.YTDUAL_WORKER ?? "http://127.0.0.1:8787";
const FIXTURE = process.argv[2] || "VBMUMuZBxw0";
const RUNNERS = 8, CHUNK = 12, CTX_N = 8;
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const y = loadContent();
const padL = (s, n) => String(s ?? "").padStart(n);

async function translate(videoId, lang, segs, before, after, signal) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/subtitle`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ videoId, lang, target: "Korean", segments: segs, ctxBefore: before, ctxAfter: after }),
    signal,
  });
  const j = await res.json().catch(() => ({}));
  if (!Array.isArray(j.lines)) throw new Error(`bad ${res.status}`);
  return { lines: j.lines, ms: Math.round(performance.now() - t0) };
}

/**
 * runner 풀을 돌리며 "관심 청크"가 언제 번역되는지 잰다.
 * @param {object} o
 * @param {number} o.playhead      시작 재생 위치(초)
 * @param {number} [o.seekTo]      이 시각(초)으로 도중에 시킹한다
 * @param {number} [o.seekAfterMs] 시킹 시점
 * @param {boolean} o.cancelOnSeek 시킹 때 무관해진 in-flight 를 끊는가 (개선 A)
 * @param {number} o.slice         재생 중 청크에서 먼저 번역할 조각 수 (0이면 끔, 개선 C)
 */
async function session(segments, lang, o) {
  const chunks = [];
  for (let i = 0; i < segments.length; i += CHUNK) {
    const segs = segments.slice(i, i + CHUNK);
    chunks.push({ i0: i, segs, t0: segs[0].start, t1: segs[segs.length - 1].end });
  }
  const chunkAt = (t) => chunks.find((c) => t >= c.t0 && t <= c.t1) ?? chunks[0];

  let playhead = o.playhead;
  let seekAt = null;   // 시킹이 일어난 시각. 시킹 지연은 이 시점 기준으로 재야 한다
  const target = { cold: chunkAt(o.playhead), seek: o.seekTo != null ? chunkAt(o.seekTo) : null };
  const done = new Map();          // chunk → 완료 시각(ms)
  const pending = new Set(chunks);
  const inflight = new Map();      // chunk → AbortController[]
  const t0 = performance.now();
  let stop = false;

  const nextChunk = () => {
    let best = null, bs = Infinity;
    for (const c of pending) {
      const sc = playhead >= c.t0 - 5 && playhead <= c.t1 ? -1
        : c.t0 >= playhead ? c.t0 - playhead : 1e6 + (playhead - c.t0);
      if (sc < bs) { bs = sc; best = c; }
    }
    return best && { c: best, playing: bs === -1 };
  };

  const runner = async () => {
    for (;;) {
      if (stop) return;
      const picked = nextChunk();
      if (!picked) return;
      let { c, playing } = picked;
      pending.delete(c);
      const owner = c;                                 // 관심 청크 판정용 원본
      // 개선 C: 재생 중 청크는 재생 지점부터 몇 조각만 먼저 번역한다.
      // 나머지는 별도 작업으로 되돌린다 — 시간 구간이 겹치지 않아 병합이 안전하다.
      if (playing && o.slice && c.segs.length > o.slice) {
        let pIdx = c.segs.findIndex((s) => s.end >= playhead);
        if (pIdx < 0) pIdx = 0;
        const head = c.segs.slice(pIdx, pIdx + o.slice);
        for (const rest of [c.segs.slice(0, pIdx), c.segs.slice(pIdx + o.slice)]) {
          if (rest.length) pending.add({ i0: c.i0 + c.segs.indexOf(rest[0]), segs: rest,
            t0: rest[0].start, t1: rest[rest.length - 1].end, owner });
        }
        c = { i0: c.i0 + pIdx, segs: head, t0: head[0].start, t1: head[head.length - 1].end, owner };
      }
      const ctls = [new AbortController()];
      inflight.set(c, ctls);
      try {
        const before = segments.slice(Math.max(0, c.i0 - CTX_N), c.i0).map((s) => s.text);
        const after = segments.slice(c.i0 + c.segs.length, c.i0 + c.segs.length + CTX_N).map((s) => s.text);
        const r = await translate(`seek-${runId}-${c.i0}-${Math.random().toString(36).slice(2, 6)}`,
          lang, c.segs, before, after, ctls[0].signal);
        const key = c.owner ?? c;
        if (!done.has(key)) done.set(key, Math.round(performance.now() - t0));
      } catch {
        if (!stop) pending.add(c);                     // 취소되었으면 다시 큐로
      } finally {
        inflight.delete(c);
      }
    }
  };

  const pool = Promise.all(Array.from({ length: RUNNERS }, runner));

  const result = { cold: null, seek: null };
  const watch = (async () => {
    while (!stop) {
      if (result.cold === null && done.has(target.cold)) result.cold = done.get(target.cold);
      if (target.seek && result.seek === null && done.has(target.seek)) {
        // 세션 시작이 아니라 시킹 시점부터 잰다 — 사용자가 실제로 기다린 시간이다
        result.seek = done.get(target.seek) - (seekAt ?? 0);
      }
      if (result.cold !== null && (!target.seek || result.seek !== null)) break;
      if (performance.now() - t0 > 120_000) break;     // 안전장치
      await new Promise((r) => setTimeout(r, 25));
    }
    stop = true;
    for (const ctls of inflight.values()) for (const c of ctls) c.abort();
  })();

  if (o.seekTo != null) {
    setTimeout(() => {
      playhead = o.seekTo;
      seekAt = Math.round(performance.now() - t0);
      if (o.cancelOnSeek) {
        // 개선 A: 새 재생 위치에서 멀어진 in-flight 를 끊어 runner 를 즉시 반환한다
        for (const [c, ctls] of inflight) {
          const near = playhead >= c.t0 - 5 && playhead <= c.t1;
          if (!near) for (const ctl of ctls) ctl.abort();
        }
      }
    }, o.seekAfterMs ?? 1500);
  }

  await watch;
  await pool.catch(() => {});
  return result;
}

async function main() {
  const segs0 = JSON.parse(await readFile(
    `${ROOT}.local/youtube-transcripts/${FIXTURE}/transcript.json`, "utf8")).segments;
  const manifest = JSON.parse(await readFile(
    `${ROOT}.local/youtube-transcripts/${FIXTURE}/manifest.json`, "utf8"));
  const segments = y.normalizeSegments(segs0, manifest.source.durationSeconds);
  const lang = manifest.capture.language;

  const PLAY = 2511, SEEK = 6000;
  console.log(`\n체감 지연 — ${FIXTURE} (${segments.length}조각, ${Math.ceil(segments.length / CHUNK)}청크)`);
  console.log(`재생 ${PLAY}s 에서 시작, 1.5초 뒤 ${SEEK}s 로 시킹.  runner ${RUNNERS}\n시킹 지연은 '시킹한 순간'부터 잰다.\n`);

  const CONFIGS = [
    { label: "이전 (취소X, 슬라이스X)", cancelOnSeek: false, slice: 0 },
    { label: "A 시킹취소",             cancelOnSeek: true,  slice: 0 },
    { label: "A+C 취소+슬라이스4",      cancelOnSeek: true,  slice: 4 },
  ];
  const REPEAT = 3;

  const acc = {};
  for (let rep = 0; rep < REPEAT; rep++) {
    for (const cfg of CONFIGS) {
      const r = await session(segments, lang, {
        playhead: PLAY, seekTo: SEEK, seekAfterMs: 1500,
        cancelOnSeek: cfg.cancelOnSeek, slice: cfg.slice,
      });
      (acc[cfg.label] ??= { cold: [], seek: [] });
      if (r.cold != null) acc[cfg.label].cold.push(r.cold);
      if (r.seek != null) acc[cfg.label].seek.push(r.seek);
      console.log(`  ${rep + 1}회차 ${cfg.label.padEnd(20)} 콜드 ${padL(r.cold ?? "-", 6)}ms   시킹 ${padL(r.seek ?? "-", 6)}ms`);
    }
  }

  console.log("\n중앙값");
  console.log(`  ${"설정".padEnd(20)} ${padL("콜드", 8)} ${padL("시킹", 8)}`);
  const med = (a) => { const s = [...a].sort((x, y2) => x - y2); return s.length ? s[s.length >> 1] : null; };
  for (const [label, v] of Object.entries(acc)) {
    console.log(`  ${label.padEnd(20)} ${padL(med(v.cold) ?? "-", 8)} ${padL(med(v.seek) ?? "-", 8)}`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
