/* 조각 묶기 — 모델이 하던 병합을 기계가 대신한다.
 *
 * 왜 옮겼나:
 *   옛 SYSTEM 은 모델에게 병합 + 자막줄 분할 + 원문 재출력 + 번역을 한 번에
 *   시켰다. 그 복잡도가 reasoning 을 만들고, reasoning 이 지연을 만들었다.
 *   [실측 N=12, 실제 자막 5개 — 옛 방식 중앙 32.7초, 이 방식 6.6초 (0.20배).
 *    자동생성 ja 는 47.1초 → 5.2초, reasoning 1925 → 0]
 *
 * 왜 이 테스트가 중요한가:
 *   묶음이 곧 화면의 한 줄이고, 응답 커버리지를 구조적으로 보장하는 것도
 *   이 함수다. 옛 방식은 모델이 조각을 빠뜨려 화면이 1초 비는 사고가 실제로
 *   났다(W20). 여기서 "전 조각이 정확히 한 묶음에 들어간다"를 지키면 그 사고가
 *   원천적으로 불가능해진다 — 그래서 그 방어 코드(fillUncovered)를 지웠다.
 *
 * 입력은 실제 자막 스크립트 13개다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./worker-harness.js";
import { loadRealFixtures, skipReason } from "./real-fixtures.js";

const w = loadWorker();
const FIXTURES = loadRealFixtures();
const skip = skipReason(FIXTURES);

/** content.js 의 청크 격자(12조각)와 같은 단위로 잘라 실제 요청 모양을 만든다 */
function chunksOf(segments, size = 12) {
  const out = [];
  for (let i = 0; i < segments.length; i += size) out.push(segments.slice(i, i + size));
  return out;
}

test("★ 전 조각이 정확히 한 묶음에 들어간다 (커버리지의 구조적 보장)", { skip }, () => {
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(fx.segments)) {
      const groups = w.groupSegments(batch);
      const seen = new Uint8Array(batch.length);
      for (const g of groups) {
        assert.ok(g.from <= g.to, `from>to (${fx.id})`);
        for (let i = g.from; i <= g.to; i++) {
          assert.equal(seen[i], 0, `조각 ${i} 가 두 묶음에 들어갔다 (${fx.id})`);
          seen[i] = 1;
        }
      }
      const missing = [...seen].map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      assert.deepEqual(missing, [], `안 묶인 조각 (${fx.id})`);
    }
  }
});

test("★ 묶은 본문은 원조각을 순서대로 이어붙인 것이다 (글자 손실·순서 변경 없음)", { skip }, () => {
  // 공백은 규칙에 따라 넣거나 안 넣는다(CJK). 그래서 공백을 뺀 글자열로 비교한다 —
  // 이 검사가 잡아야 하는 것은 "글자가 사라지거나 순서가 바뀌는 것"이다.
  const bare = (s) => s.replace(/\s+/g, "");
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(fx.segments)) {
      for (const g of w.groupSegments(batch)) {
        assert.equal(
          bare(g.text),
          bare(batch.slice(g.from, g.to + 1).map((s) => s.text).join(" ")),
          `본문이 다르다 (${fx.id})`,
        );
      }
    }
  }
});

test("★ 일본어·중국어는 공백 없이 잇는다 — 없던 공백이 단어를 가른다", () => {
  const ja = w.groupSegments([
    { start: 0, end: 2, text: "お話を聞いてみ" },
    { start: 2, end: 4, text: "たいと思います" },
  ]);
  assert.equal(ja.length, 1);
  assert.equal(ja[0].text, "お話を聞いてみたいと思います", "일본어 사이에 공백이 들어갔다");

  // 한글은 띄어쓰기를 쓰므로 공백을 유지한다
  const ko = w.groupSegments([
    { start: 0, end: 2, text: "여기 짧은" },
    { start: 2, end: 4, text: "영화 대본이" },
  ]);
  assert.equal(ko[0].text, "여기 짧은 영화 대본이");

  // 영어도 그대로
  const en = w.groupSegments([
    { start: 0, end: 2, text: "hello there" },
    { start: 2, end: 4, text: "friend" },
  ]);
  assert.equal(en[0].text, "hello there friend");
});

test("★ 아주 짧은 조각은 혼자 남지 않는다 — 토막 번역 방지", () => {
  const g = w.groupSegments([
    { start: 0, end: 1, text: "Bien," },
    { start: 1, end: 4, text: "esa idea proviene directamente del titulo de un articulo" },
  ]);
  assert.equal(g.length, 1, "짧은 조각이 혼자 남았다");
  assert.match(g[0].text, /^Bien, esa idea/);
});

test("묶음의 시간은 구성 조각의 시간 범위와 같다", { skip }, () => {
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(fx.segments)) {
      for (const g of w.groupSegments(batch)) {
        assert.equal(g.start, batch[g.from].start, `start 불일치 (${fx.id})`);
        assert.equal(g.end, batch[g.to].end, `end 불일치 (${fx.id})`);
      }
    }
  }
});

test("묶음은 시간 순서를 지키고 서로 겹치지 않는다", { skip }, () => {
  for (const fx of FIXTURES) {
    // 정규화된 자막을 넣는다 — 확장이 실제로 보내는 것이 그것이다
    const segs = fx.segments;
    for (const batch of chunksOf(segs)) {
      const groups = w.groupSegments(batch);
      for (let i = 1; i < groups.length; i++) {
        assert.ok(groups[i - 1].to < groups[i].from, `묶음 순서가 어긋났다 (${fx.id})`);
        assert.ok(groups[i - 1].start <= groups[i].start, `start 정렬 깨짐 (${fx.id})`);
      }
    }
  }
});

test("★ 묶음이 표시 한도를 넘지 않는다 — splitLine 이 걸리지 않게", { skip }, () => {
  // 예외 둘: (a) 조각 하나가 이미 한도를 넘으면 묶기로는 어쩔 수 없다,
  //          (b) 짧은 조각을 흡수하느라 +15 까지 허용한다 (토막 번역보다 낫다).
  const HARD = w.MAX_LINE_CHARS + 15;
  const over = [];
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(fx.segments)) {
      for (const g of w.groupSegments(batch)) {
        if (g.from === g.to) continue;
        if (g.text.length > HARD) over.push(`${fx.id} ${g.text.length}자 (${g.to - g.from + 1}조각)`);
      }
    }
  }
  assert.deepEqual(over.slice(0, 5), [], `상한(${HARD}자)을 넘는 묶음 ${over.length}개`);
});

test("묶기가 만든 긴 줄은 드물다 — splitLine 이 걸리면 경계가 어긋난다(W19)", { skip }, () => {
  // 원조각 하나가 이미 85자를 넘는 경우는 묶기로 어쩔 수 없다 — 자막 원본이 길다.
  // [실측 13 fixture: 85자 초과 141개 중 128개가 원조각 단독. 묶기가 만든 것은 13개]
  // 그러니 "묶기가 만든 것"만 센다. 그게 이 함수가 책임지는 몫이다.
  let multi = 0, madeLong = 0;
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(fx.segments)) {
      for (const g of w.groupSegments(batch)) {
        if (g.from === g.to) continue;           // 원본이 긴 것은 splitLine 담당
        multi++;
        if (g.text.length > w.MAX_LINE_CHARS) madeLong++;
      }
    }
  }
  const pct = (100 * madeLong) / multi;
  assert.ok(pct <= 5, `묶기가 만든 초과 줄 ${pct.toFixed(1)}% (${madeLong}/${multi}) — 상한 5%`);
});

test("문장 끝에서 끊는다", () => {
  const segs = [
    { start: 0, end: 2, text: "This is one sentence." },
    { start: 2, end: 4, text: "And this starts another" },
    { start: 4, end: 6, text: "that continues here." },
  ];
  const g = w.groupSegments(segs);
  assert.equal(g.length, 2);
  assert.equal(g[0].text, "This is one sentence.");
  assert.equal(g[1].text, "And this starts another that continues here.");
});

test("침묵이 길면 끊는다", () => {
  const segs = [
    { start: 0, end: 2, text: "first part" },
    { start: 9, end: 11, text: "much later" },   // 7초 공백
  ];
  assert.equal(w.groupSegments(segs).length, 2);
});

test("자동생성 자막처럼 구두점이 없어도 길이로 끊는다", () => {
  const segs = Array.from({ length: 8 }, (_, i) => ({
    start: i * 2, end: i * 2 + 2, text: `chunk number ${i} with some words`,
  }));
  const g = w.groupSegments(segs);
  assert.ok(g.length > 1, "하나로 뭉쳤다");
  for (const x of g) assert.ok(x.text.length <= w.MAX_LINE_CHARS, `${x.text.length}자`);
});

test("빈 입력에도 죽지 않는다", () => {
  // vm 컨텍스트가 달라 배열 프로토타입이 다르므로 deepEqual 대신 길이로 본다
  assert.equal(w.groupSegments([]).length, 0);
});

test("CONTEXT 는 번호 목록 밖에 있다 (W16 — 개수가 밀리지 않게)", () => {
  const lines = [{ text: "a" }, { text: "b" }];
  const p = w.buildPayload(lines, ["before1"], ["after1"]);
  assert.match(p, /CONTEXT BEFORE:\nbefore1/);
  assert.match(p, /CONTEXT AFTER:\nafter1/);
  assert.match(p, /TRANSLATE THESE 2 LINES:\n0: a\n1: b/);
  // 문맥 줄에는 번호가 붙지 않아야 한다
  assert.equal(/^\d+: before1/m.test(p), false, "문맥에 번호가 붙었다");
  assert.equal(/^\d+: after1/m.test(p), false, "문맥에 번호가 붙었다");
});

test("문맥이 없으면 블록 자체를 넣지 않는다", () => {
  const p = w.buildPayload([{ text: "only" }], [], []);
  assert.equal(p.includes("CONTEXT"), false);
  assert.match(p, /^TRANSLATE THESE 1 LINES:\n0: only$/);
});
