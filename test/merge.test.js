/* 자막 병합 불변식 — Phase 5 목록을 실행 가능한 형태로 고정한다.
 *
 * 여기 있는 검사는 전부 Phase 4 에서 실제로 깨졌거나(1·5), 깨질 뻔했던 지점이다.
 * 특히 [중간 상태] 검사가 핵심이다 — 지난 세션은 모든 청크를 병합한 뒤에만
 * 확인해서 청크 경계 결함을 놓쳤다. 최종 상태만 보면 지금도 통과한다.
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

  const untranslated = y.state.lines.filter((l) => l.tier !== "full");
  assert.equal(untranslated.length, 0, "남의 full 을 지운 청크가 있다");
  assert.deepEqual(holes(segments, y.state.lines), []);
});

test("fast → full 승급: fast 잔존이 없고 구멍도 없다", () => {
  const { y, segments } = fresh();
  const [chunk] = makeChunks(segments, 8);

  y.applyFast(chunk.segs, chunk.segs.map((s) => `빠름[${s.text}]`));
  assert.equal(y.state.lines.filter((l) => l.tier === "fast").length, 8);

  y.mergeTranslated(fullLinesFor(chunk), chunk.t0, chunk.t1);

  const stillFast = y.state.lines.filter((l) => l.tier === "fast");
  assert.equal(stillFast.length, 0, "승급 후에도 fast 가 남았다");
  assert.deepEqual(holes(segments, y.state.lines), []);
});

test("I21 — full 이 붙은 뒤 늦게 온 fast 는 무시된다", () => {
  const { y, segments } = fresh();
  const [chunk] = makeChunks(segments, 8);

  y.mergeTranslated(fullLinesFor(chunk), chunk.t0, chunk.t1);
  const before = JSON.stringify(y.state.lines);

  y.applyFast(chunk.segs, chunk.segs.map((s) => `늦음[${s.text}]`));

  assert.equal(JSON.stringify(y.state.lines), before, "늦은 fast 가 full 을 덮었다");
  assert.equal(y.state.lines.some((l) => String(l.trans).includes("늦음")), false);
});

test("I22 — 병합으로 인덱스가 밀린 뒤에도 fast 가 올바른 줄에 붙는다", () => {
  const { y, segments } = fresh();
  const chunks = makeChunks(segments, 12);

  // 앞 청크를 full 로 병합해 배열을 재구성한다 → 인덱스 대응이 깨진다
  y.mergeTranslated(fullLinesFor(chunks[0]), chunks[0].t0, chunks[0].t1);
  y.mergeTranslated(fullLinesFor(chunks[1]), chunks[1].t0, chunks[1].t1);

  const target = chunks[3];
  y.applyFast(target.segs, target.segs.map((s) => `빠름[${s.text}]`));

  // 각 fast 줄의 번역이 자기 원문과 짝이 맞아야 한다
  for (const line of y.state.lines.filter((l) => l.tier === "fast")) {
    assert.equal(
      line.trans, `빠름[${line.orig}]`,
      `조각이 어긋났다: orig=${line.orig} trans=${line.trans}`,
    );
  }
  assert.equal(y.state.lines.filter((l) => l.tier === "fast").length, target.segs.length);
});

test("I5 — 빈 번역은 등급을 올리지 않고 원문을 남긴다", () => {
  const { y, segments } = fresh();
  const [chunk] = makeChunks(segments, 8);

  y.applyFast(chunk.segs, chunk.segs.map((_, i) => (i % 2 ? "" : "번역")));

  const lines = y.state.lines.slice(0, 8);
  lines.forEach((l, i) => {
    if (i % 2) {
      assert.equal(l.tier, null, `빈 번역인데 등급이 올랐다 (${i})`);
      assert.equal(l.orig, `frag ${i}`, "원문이 사라졌다");
    } else {
      assert.equal(l.tier, "fast");
    }
  });
  assert.deepEqual(holes(segments, y.state.lines), []);
});

test("I18 — fast 응답 길이가 요청 조각 수와 다르면 어긋남이 생긴다(가드 부재 확인)", () => {
  const { y, segments } = fresh();
  const [chunk] = makeChunks(segments, 8);

  // 워커가 7개만 돌려준 상황. applyFast 는 길이를 검사하지 않는다.
  y.applyFast(chunk.segs, ["가", "나", "다", "라", "마", "바", "사"]);

  const fast = y.state.lines.filter((l) => l.tier === "fast");
  assert.equal(fast.length, 7, "길이 불일치가 조용히 통과했다 — 호출자가 I18 을 지켜야 한다");
});
