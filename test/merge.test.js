/* 자막 병합 불변식.
 *
 * 여기 있는 검사는 전부 실제로 깨졌거나 깨질 뻔했던 지점이다. 특히 [중간 상태]
 * 검사가 핵심이다 — 모든 청크를 병합한 뒤에만 확인하면 청크 경계 결함을 놓친다.
 * 최종 상태만 보면 결함이 있어도 통과한다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./harness.js";
import {
  makeSegments, makeChunks, fullLinesFor, holes, isSorted, shuffled,
} from "./fixtures.js";

/** 매 테스트마다 새 컨텍스트 — 모듈 수준 state 가 새어나가면 안 된다. */
function fresh(n = 240) {
  const y = loadContent();
  const segments = makeSegments(n);
  y.seedRawLines(segments);
  return { y, segments };
}

test("I2·I5 — 청크 하나만 도착한 중간 상태에서 구멍이 없다", () => {
  const { y, segments } = fresh();
  const chunks = makeChunks(segments, 12);

  y.mergeTranslated(fullLinesFor(chunks[3]), chunks[3].t0, chunks[3].t1);

  assert.deepEqual(holes(segments, y.state.lines), [], "화면이 비는 시각이 있다");
  assert.ok(isSorted(y.state.lines), "start 정렬이 깨졌다");
});

test("I5 — 무작위 도착 순서에서 매 단계마다 구멍이 없다", () => {
  const { y, segments } = fresh();
  const chunks = makeChunks(segments, 12);

  for (const c of shuffled(chunks)) {
    y.mergeTranslated(fullLinesFor(c), c.t0, c.t1);
    const h = holes(segments, y.state.lines);
    assert.deepEqual(h, [], `청크 ${c.i0} 직후 구멍: ${JSON.stringify(h)}`);
    assert.ok(isSorted(y.state.lines), `청크 ${c.i0} 직후 정렬 깨짐`);
  }
});

test("I4 — 뒤섞인 순서로 전부 도착해도 모든 청크의 번역이 살아남는다", () => {
  const { y, segments } = fresh();
  const chunks = makeChunks(segments, 12);

  for (const c of shuffled(chunks, 7)) {
    y.mergeTranslated(fullLinesFor(c), c.t0, c.t1);
  }

  const untranslated = y.state.lines.filter((l) => !l.translated);
  assert.equal(untranslated.length, 0, "남의 번역을 지운 청크가 있다");
  assert.deepEqual(holes(segments, y.state.lines), []);
});

test("I4 — 이미 번역된 줄은 다른 청크가 지우지 않는다", () => {
  const { y, segments } = fresh();
  const chunks = makeChunks(segments, 12);

  y.mergeTranslated(fullLinesFor(chunks[5]), chunks[5].t0, chunks[5].t1);
  const before = y.state.lines.filter((l) => l.translated).map((l) => l.trans);
  assert.ok(before.length > 0);

  // 이웃 청크가 도착해도 5번 청크의 결과는 그대로여야 한다
  y.mergeTranslated(fullLinesFor(chunks[4]), chunks[4].t0, chunks[4].t1);
  y.mergeTranslated(fullLinesFor(chunks[6]), chunks[6].t0, chunks[6].t1);

  for (const t of before) {
    assert.ok(y.state.lines.some((l) => l.trans === t), `사라진 번역: ${t}`);
  }
  assert.deepEqual(holes(segments, y.state.lines), []);
});

test("mergeTranslated 는 멱등이 아니다 — 호출자가 청크당 1회를 지켜야 한다", () => {
  const { y, segments } = fresh();
  const [chunk] = makeChunks(segments, 12);

  y.mergeTranslated(fullLinesFor(chunk), chunk.t0, chunk.t1);
  const n1 = y.state.lines.length;
  y.mergeTranslated(fullLinesFor(chunk), chunk.t0, chunk.t1);

  // 같은 구간이 두 벌 쌓인다. 이건 결함이 아니라 I4 의 대가다 — 이미 번역된 줄을
  // 지우지 않아야 이웃 청크의 결과가 살아남는데, 그 규칙이 자기 자신도 보호한다.
  // 멱등하게 만들려면 "구간 안의 모든 줄 제거"로 바꿔야 하고, 그러면 조각이 겹치는
  // 자막에서 이웃 청크의 번역을 지운다 (그 사고가 I4 를 만든 이유다).
  //
  // 그래서 안전은 호출자가 지킨다: start() 의 runner 는 성공한 청크를 pending 에
  // 되돌리지 않으므로 같은 청크가 두 번 병합되지 않는다. 이 테스트는 그 계약이
  // 왜 필요한지를 고정한다.
  assert.ok(y.state.lines.length > n1, "중복이 안 생겼다면 I4 가 약해진 것이다");
});

test("seedRawLines 는 번역 전 상태로 전 구간을 덮는다 (I1)", () => {
  const { y, segments } = fresh(60);
  assert.equal(y.state.lines.length, segments.length);
  assert.equal(y.state.lines.every((l) => l.translated === false), true);
  assert.equal(y.state.lines.every((l) => l.trans === ""), true);
  assert.deepEqual(holes(segments, y.state.lines), []);
});
