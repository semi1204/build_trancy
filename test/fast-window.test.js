/* fast 미리보기 창이 "지금 보고 있는 곳"을 덮는가.
 *
 * 입력은 전부 실제 자막 스크립트다 (.local/youtube-transcripts, 13개).
 * 합성 데이터로는 이 결함이 안 잡힌다 — 균일한 조각 길이를 가정하면 재생 지점이
 * 청크 어디에 떨어지는지가 현실과 달라진다.
 *
 * 무엇이 깨졌었나:
 *   const segs = mode === "fast" ? c.segs.slice(0, FAST_CHUNK) : c.segs;
 *   청크는 12조각(약 30~45초)인데 fast 는 늘 그 "머리 8조각"을 번역했다.
 *   재생 지점이 청크 중간이면 이미 지나간 구간을 번역하는 셈이다.
 *
 * 실측(수정 전, 13 fixture × seek 200지점):
 *   재생 지점을 덮는 비율 65~70%,  번역 조각의 60~67%가 이미 지나간 것.
 *   즉 seek 의 약 1/3 에서 fast 가 완전히 헛돌았다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./harness.js";
import { loadRealFixtures, skipReason, makeChunks, pickPlaying } from "./real-fixtures.js";

const FIXTURES = loadRealFixtures();
const skip = skipReason(FIXTURES);

const TRANSLATE_CHUNK = 12;   // content.js 와 같은 값
const FAST_CHUNK = 8;
const SAMPLES = 200;          // fixture 당 seek 지점 수

/** 각 fixture 를 재생 시작~끝까지 SAMPLES 지점에서 훑으며 fast 창을 만든다. */
function sweep(y, fx) {
  const chunks = makeChunks(fx.segments, TRANSLATE_CHUNK);
  const dur = fx.segments[fx.segments.length - 1].end;
  const rows = [];
  for (let k = 0; k < SAMPLES; k++) {
    const t = (dur * k) / SAMPLES;
    const picked = pickPlaying(chunks, t);
    if (!picked || !picked.playing) continue;          // fast 를 안 쓰는 지점
    const w = y.fastWindow(fx.segments, picked.chunk, t, FAST_CHUNK);
    rows.push({ t, ...w });
  }
  return rows;
}

test("★ fast 창이 항상 재생 지점을 덮는다", { skip }, () => {
  const y = loadContent();
  const bad = [];
  for (const fx of FIXTURES) {
    for (const { t, segs } of sweep(y, fx)) {
      if (!segs.length || !segs.some((s) => s.end >= t)) {
        bad.push(`${fx.id} @${t.toFixed(1)}s`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 10), [], `재생 지점을 못 덮은 seek ${bad.length}건`);
});

test("★ fast 창에 이미 지나간 조각이 들어가지 않는다", { skip }, () => {
  const y = loadContent();
  let wasted = 0, total = 0;
  const worst = [];
  for (const fx of FIXTURES) {
    for (const { t, segs } of sweep(y, fx)) {
      const past = segs.filter((s) => s.end < t).length;
      if (past) worst.push(`${fx.id} @${t.toFixed(1)}s ${past}/${segs.length}`);
      wasted += past;
      total += segs.length;
    }
  }
  assert.equal(wasted, 0,
    `이미 지나간 조각 ${wasted}/${total} (${(100 * wasted / total).toFixed(1)}%)\n  ` +
    worst.slice(0, 5).join("\n  "));
});

test("fast 창은 segments 의 연속 구간이고 크기를 넘지 않는다", { skip }, () => {
  const y = loadContent();
  for (const fx of FIXTURES) {
    for (const { from, segs } of sweep(y, fx)) {
      assert.ok(segs.length > 0 && segs.length <= FAST_CHUNK,
        `창 크기 ${segs.length} (${fx.id})`);
      assert.ok(from >= 0 && from + segs.length <= fx.segments.length,
        `창이 범위를 벗어났다 (${fx.id})`);
      for (let i = 0; i < segs.length; i++) {
        assert.equal(segs[i], fx.segments[from + i],
          `연속 구간이 아니다 (${fx.id} from=${from} i=${i})`);
      }
    }
  }
});

test("미리보기 지평이 full 도착(약 20초)을 대체로 덮는다", { skip }, () => {
  const y = loadContent();
  let short = 0, total = 0;
  for (const fx of FIXTURES) {
    for (const { t, segs } of sweep(y, fx)) {
      total++;
      if (segs[segs.length - 1].end - t < 5) short++;   // 지평 5초 미만
    }
  }
  const pct = (100 * short) / total;
  // 청크 내로 제한하면 15.3%, 청크를 넘기면 2.7% (실측). 5% 를 상한으로 둔다.
  assert.ok(pct <= 5,
    `미리보기 지평이 5초 미만인 seek ${pct.toFixed(1)}% (${short}/${total}) — 상한 5%`);
});
