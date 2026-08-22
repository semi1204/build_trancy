/* 자막 시간 정규화 — 자동생성 자막의 부풀려진 end 를 실제 표시 구간으로 되돌린다.
 *
 * 입력은 전부 실제 자막 스크립트다 (.local/youtube-transcripts, 13개:
 * 수동 7 / 자동 6, en·es·ja·ko).
 *
 * 무엇이 문제였나:
 *   parseJson3Segments 는 end = tStartMs + dDurationMs 를 그대로 쓴다. 자동생성
 *   자막은 2줄짜리 rolling 창이라 dDurationMs 가 "다음 줄로 밀려난 뒤에도 화면에
 *   남아 있는 시간"까지 포함한다. 그래서 이웃 조각과 시간이 크게 겹친다.
 *
 * 실측(수정 전):
 *   수동 7개 — 겹치는 쌍 0
 *   자동 6개 — 겹치는 쌍 85~287개, 최대 겹침 9.30초 (D8A2q3awnsU)
 *
 * 왜 고쳐야 하나:
 *   end 는 화면 표시 판정(findLine 의 +0.3 여유), 문장 반복(state.loop 이
 *   currentTime > cur.end 로 되감기), 청크 구간 t1, 그리고 워커가 돌려주는
 *   full 줄의 end(batch[e].end)에 그대로 전파된다. 9초 부풀려진 end 는
 *   "한 문장 반복"이 세 문장을 반복하게 만든다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./harness.js";
import { loadRealFixtures, skipReason } from "./real-fixtures.js";

const FIXTURES = loadRealFixtures();
const skip = skipReason(FIXTURES);

const manual = () => FIXTURES.filter((f) => f.subtitleKind === "manual");
const auto = () => FIXTURES.filter((f) => f.subtitleKind === "automatic");

/** 이웃 조각과 시간이 겹치는 쌍의 수와 최대 겹침(초) */
function overlap(segments) {
  let count = 0, max = 0;
  for (let i = 1; i < segments.length; i++) {
    const d = segments[i - 1].end - segments[i].start;
    if (d > 1e-9) { count++; max = Math.max(max, d); }
  }
  return { count, max };
}

test("★ 자동생성 자막의 rolling 겹침이 사라진다", { skip }, () => {
  const y = loadContent();
  const before = [], after = [];
  for (const fx of auto()) {
    const raw = fx.segments;
    const norm = y.normalizeSegments(raw, fx.durationSeconds);
    const b = overlap(raw), a = overlap(norm);
    before.push(`${fx.id} ${b.count}쌍/${b.max.toFixed(2)}s`);
    if (a.count) after.push(`${fx.id} ${a.count}쌍/${a.max.toFixed(2)}s`);
  }
  assert.ok(before.length >= 4, "자동 자막 fixture 가 부족하다");
  assert.deepEqual(after, [], `정규화 후에도 겹침이 남았다 (전: ${before.join(", ")})`);
});

test("★ 수동 자막은 한 글자도 바뀌지 않는다", { skip }, () => {
  const y = loadContent();
  for (const fx of manual()) {
    const norm = y.normalizeSegments(fx.segments, fx.durationSeconds);
    assert.deepEqual(
      JSON.parse(JSON.stringify(norm)),
      JSON.parse(JSON.stringify(fx.segments)),
      `수동 자막이 변형됐다 — ${fx.id}`,
    );
  }
});

test("정규화가 조각을 잃거나 0초로 만들지 않는다", { skip }, () => {
  const y = loadContent();
  for (const fx of FIXTURES) {
    const norm = y.normalizeSegments(fx.segments, fx.durationSeconds);
    assert.equal(norm.length, fx.segments.length, `조각 수가 바뀌었다 — ${fx.id}`);
    for (const [i, s] of norm.entries()) {
      assert.ok(s.end > s.start, `${fx.id}[${i}] end <= start (${s.start}→${s.end})`);
      assert.equal(s.text, fx.segments[i].text, `${fx.id}[${i}] 본문이 바뀌었다`);
      assert.equal(s.start, fx.segments[i].start, `${fx.id}[${i}] start 가 움직였다`);
    }
  }
});

test("영상 길이를 넘는 end 는 잘린다", { skip }, () => {
  const y = loadContent();
  for (const fx of FIXTURES) {
    const norm = y.normalizeSegments(fx.segments, fx.durationSeconds);
    const over = norm.filter((s) => s.end > fx.durationSeconds + 1e-6);
    assert.deepEqual(over, [], `${fx.id}: 영상 길이(${fx.durationSeconds}s)를 넘는 줄`);
  }
});

test("start 오름차순이 보장된다", { skip }, () => {
  const y = loadContent();
  for (const fx of FIXTURES) {
    const norm = y.normalizeSegments(fx.segments, fx.durationSeconds);
    for (let i = 1; i < norm.length; i++) {
      assert.ok(norm[i - 1].start <= norm[i].start, `${fx.id}[${i}] 정렬 깨짐`);
    }
  }
});

test("길이를 모르면(라이브·측정 실패) 길이 클램프만 건너뛴다", { skip }, () => {
  const y = loadContent();
  const fx = auto()[0];
  const norm = y.normalizeSegments(fx.segments, null);
  assert.equal(overlap(norm).count, 0, "길이를 몰라도 겹침은 제거해야 한다");
  assert.equal(norm.length, fx.segments.length);
});

test("뒤섞이거나 망가진 입력에도 죽지 않는다", () => {
  const y = loadContent();
  assert.deepEqual(y.normalizeSegments([], 10), []);
  // start 역순 → 정렬 후 클램프
  const out = y.normalizeSegments(
    [{ start: 5, end: 20, text: "b" }, { start: 1, end: 9, text: "a" }], 30,
  );
  assert.deepEqual(out.map((s) => s.text), ["a", "b"]);
  assert.equal(out[0].end, 5, "앞 조각이 뒤 조각 시작까지만 덮어야 한다");
  // end <= start 인 조각은 최소 길이를 받는다 (버리면 I5 의 구멍이 된다)
  const zero = y.normalizeSegments([{ start: 3, end: 3, text: "x" }], 30);
  assert.equal(zero.length, 1);
  assert.ok(zero[0].end > zero[0].start);
});

test("패널 수집처럼 end 를 모르면 다음 조각 시작까지 늘린다", () => {
  const y = loadContent();
  // scrapeTranscriptPanel 은 시작 시각만 얻으므로 end 를 Infinity 로 넘긴다
  const out = y.normalizeSegments([
    { start: 0, end: Infinity, text: "a" },
    { start: 4, end: Infinity, text: "b" },
    { start: 9, end: 17, text: "c" },
  ], 20);
  assert.deepEqual(out.map((s) => [s.start, s.end]), [[0, 4], [4, 9], [9, 17]]);

  // 뒤도 길이도 모르는 마지막 조각은 기본 길이를 받는다 (Infinity 가 새 나가면 안 된다)
  const tail = y.normalizeSegments([{ start: 5, end: Infinity, text: "z" }], null);
  assert.ok(Number.isFinite(tail[0].end) && tail[0].end > 5, `end=${tail[0].end}`);
});

test("NaN 이나 없는 end 도 유한한 값으로 나온다", () => {
  const y = loadContent();
  const out = y.normalizeSegments([
    { start: 1, end: Number.NaN, text: "a" },
    { start: 6, text: "b" },
  ], 20);
  assert.equal(out.length, 2);
  for (const s of out) assert.ok(Number.isFinite(s.end) && s.end > s.start, JSON.stringify(s));
});
