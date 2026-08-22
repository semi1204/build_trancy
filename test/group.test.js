/* 조각 묶기 — 무엇을 화면의 "한 줄"로 볼 것인가.
 *
 * 모델에게는 번역만 시킨다. 무엇을 한 줄로 볼지는 기계가 정한다. 그래야
 * 결정적이고, LLM 없이 테스트할 수 있고, reasoning 이 안 붙어 빠르다.
 *   [실측 N=12: 옛 병합 프롬프트 자동생성 ja 47.1초 → 이 방식 5.2초]
 *
 * 지켜야 하는 것 셋:
 *   1. 시간을 빈틈없이 덮는다        — 틈이 생기면 그 시각에 화면이 빈다 (I5)
 *   2. 문장 도중에 끝나지 않는다     — 끝나면 번역이 반쪽 난다
 *   3. 읽을 만큼 머문다              — 0.3초씩 스쳐 지나가면 못 읽는다
 *
 * 2번이 왜 중요한가: 한국어는 어순이 달라(SOV) 영어 문장을 중간에서 자르면
 * 조각들이 이어지지 않는다.
 *   "…You can access real faucet"  →  "…진짜 파우셋에 접속할 수 있어"
 *   "for me."                      →  "나 대신."
 * 문장 단위로 묶으면 한 줄이 된다:
 *   "You can access real faucet for me." → "나를 위해 진짜 파우셋에 접속할 수 있어."
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./worker-harness.js";
import { loadContent } from "./harness.js";
import { loadRealFixtures, skipReason } from "./real-fixtures.js";
import { holes } from "./fixtures.js";

const w = loadWorker();
const y = loadContent();
const FIXTURES = loadRealFixtures();
const skip = skipReason(FIXTURES);

/** 확장이 워커에 보내기 전에 반드시 통과시키는 정규화 */
const norm = (fx) => y.normalizeSegments(fx.segments, fx.durationSeconds);
/** content.js 의 청크 격자(12조각)와 같은 단위 */
function chunksOf(segments, size = 12) {
  const out = [];
  for (let i = 0; i < segments.length; i += size) out.push(segments.slice(i, i + size));
  return out;
}
const ENDS_SENTENCE = (t) =>
  /[.!?…。？！]["'”’)\]]?$/.test(t) || /^[[(（【][^\]）】]*[\])）】]$/.test(t);
/** 절 경계 — 쉼표 등에서 끊긴 줄은 온전한 구절이라 번역도 온전하다 */
const ENDS_CLAUSE = (t) => /[,;:，、—–-]$/.test(t);

/* ── 1. 시간 커버리지 ────────────────────────────────────────────── */

test("★ 묶음이 입력의 시간을 빈틈없이 덮는다 — 틈은 곧 빈 화면이다", { skip }, () => {
  const bad = [];
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(norm(fx))) {
      const gap = holes(batch, w.groupSegments(batch));
      if (gap.length) bad.push(`${fx.id}: ${JSON.stringify(gap.slice(0, 2))}`);
    }
  }
  assert.deepEqual(bad.slice(0, 5), [], `시간 구멍 ${bad.length}건`);
});

test("★ 묶음끼리 시간이 겹치지 않고 순서를 지킨다", { skip }, () => {
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(norm(fx))) {
      const gs = w.groupSegments(batch);
      for (let i = 1; i < gs.length; i++) {
        assert.ok(gs[i - 1].end <= gs[i].start + 1e-9,
          `${fx.id}: 묶음이 겹쳤다 ${gs[i - 1].end} > ${gs[i].start}`);
      }
      assert.ok(gs[0].start >= batch[0].start - 1e-9, `${fx.id}: 입력보다 앞서 시작`);
      assert.ok(gs.at(-1).end <= batch.at(-1).end + 1e-9, `${fx.id}: 입력보다 늦게 끝남`);
    }
  }
});

test("★ 글자가 사라지거나 순서가 바뀌지 않는다", { skip }, () => {
  // 공백은 규칙에 따라 넣거나 안 넣는다(CJK). 그래서 공백을 뺀 글자열로 비교한다.
  const bare = (s) => s.replace(/\s+/g, "");
  for (const fx of FIXTURES) {
    for (const batch of chunksOf(norm(fx))) {
      const got = bare(w.groupSegments(batch).map((g) => g.text).join(""));
      assert.equal(got, bare(batch.map((s) => s.text).join("")), `본문이 바뀌었다 — ${fx.id}`);
    }
  }
});

/* ── 2. 문장 경계 ────────────────────────────────────────────────── */

test("★ 조각 안의 문장 경계에서 쪼갠다 — 조각 경계는 문장과 무관하다", () => {
  // ASR 은 구두점을 넣지만 조각은 아무 데서나 끊긴다
  const p = w.splitBySentence([
    { start: 0, end: 6, text: "is a bitch. You can access real faucet" },
  ]);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, "is a bitch.");
  assert.equal(p[1].text, "You can access real faucet");
  // 시간은 원본 구간을 그대로 채운다 — 구멍이 생기면 안 된다
  assert.equal(p[0].start, 0);
  assert.equal(p[1].end, 6);
  assert.equal(p[0].end, p[1].start);
});

test("문장이 하나뿐이면 쪼개지 않는다", () => {
  const p = w.splitBySentence([{ start: 1, end: 3, text: "You can access real faucet" }]);
  assert.equal(p.length, 1);
  assert.equal(p[0].text, "You can access real faucet");
});

test("★ 조각을 가로지르는 문장이 한 줄로 합쳐진다", () => {
  const g = w.groupSegments([
    { start: 0, end: 4.3, text: "Kimmy Claude" },
    { start: 4.3, end: 8, text: "is a bitch. You can access real faucet" },
    { start: 8, end: 12, text: "for me." },
  ]);
  const texts = [...g].map((x) => x.text);
  assert.ok(texts.includes("Kimmy Claude is a bitch."), `못 합쳤다: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes("real faucet for me.")),
    `문장이 여전히 갈라졌다: ${JSON.stringify(texts)}`);
});

test("★ 묶음이 문장·절 경계에서 끝난다 (구두점이 있는 자막에서)", { skip }, () => {
  // "문장으로 끝나는가"만 보면 지표가 거칠다. 긴 문장은 반드시 잘려야 하고
  // (7dm2AsJ3-E8 은 문장 중앙값이 121자, 79%가 85자 초과), 그때 쉼표에서 잘리면
  // 각 줄이 온전한 구절이라 번역도 온전하다. 진짜 문제는 아무 데서나 잘리는 것이다.
  //
  // 구두점이 아예 없는 자막은 제외한다 — 쪼갤 경계가 없다. 그건 묶기가 아니라
  // 원본의 한계다 (자동생성 자막 상당수, 채팅 로그).
  for (const fx of FIXTURES) {
    const segs = norm(fx);
    const withPunct = segs.filter((s) => ENDS_SENTENCE(s.text)).length / segs.length;
    if (withPunct < 0.3) continue;
    let n = 0, raw = 0;
    for (const batch of chunksOf(segs)) {
      for (const g of w.groupSegments(batch)) {
        n++;
        if (!ENDS_SENTENCE(g.text) && !ENDS_CLAUSE(g.text)) raw++;
      }
    }
    if (n < 20) continue;                       // 표본이 너무 작다
    assert.ok(raw / n <= 0.45,
      `${fx.id}: 아무 데서나 잘린 묶음이 ${(100 * raw / n).toFixed(0)}%`);
  }
});

/* ── 3. 읽을 만큼 머무는가 ───────────────────────────────────────── */

test("★ 짧은 문장들은 한 줄로 모인다 — 0.3초씩 스쳐 지나가면 못 읽는다", () => {
  const g = w.groupSegments([
    { start: 0, end: 0.6, text: "Oh, good." },
    { start: 0.6, end: 0.9, text: "Good." },
    { start: 0.9, end: 2.0, text: "Thank you." },
    { start: 2.0, end: 5.0, text: "You better do that for me." },
  ]);
  assert.ok(g.length < 4, `전부 따로 나왔다: ${JSON.stringify([...g].map((x) => x.text))}`);
  for (const x of g) assert.ok(ENDS_SENTENCE(x.text), `문장 도중에 끝났다: ${x.text}`);
});

test("★ 실 자막에서 1초 미만 묶음이 드물다", { skip }, () => {
  for (const fx of FIXTURES) {
    if (fx.id.endsWith("-chat")) continue;      // 채팅은 원래 짧게 스친다
    const d = [];
    for (const batch of chunksOf(norm(fx))) {
      for (const g of w.groupSegments(batch)) d.push(g.end - g.start);
    }
    const quick = d.filter((x) => x < 1).length / d.length;
    assert.ok(quick <= 0.1, `${fx.id}: 1초 미만 묶음이 ${(100 * quick).toFixed(0)}%`);
  }
});

test("충분히 머문 문장은 다음 문장을 끌어오지 않는다", () => {
  const g = w.groupSegments([
    { start: 0, end: 3, text: "Good morning." },
    { start: 3, end: 7, text: "Welcome to Google I/O." },
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].text, "Good morning.");
});

/* ── 4. 그 밖의 규칙 ─────────────────────────────────────────────── */

test("★ 지문([MUSIC PLAYING] 등)은 그 자체로 한 줄이다", () => {
  const g = w.groupSegments([
    { start: 0, end: 2, text: "[MUSIC PLAYING]" },
    { start: 2, end: 4, text: "[APPLAUSE AND CHEERING]" },
    { start: 4, end: 7, text: "SUNDAR PICHAI: Hello, everyone." },
  ]);
  assert.deepEqual([...g].map((x) => x.text),
    ["[MUSIC PLAYING]", "[APPLAUSE AND CHEERING]", "SUNDAR PICHAI: Hello, everyone."]);
});

test("한국어·일본어 지문도 마찬가지", () => {
  const g = w.groupSegments([
    { start: 0, end: 2, text: "[음악]" },
    { start: 2, end: 5, text: "여기 짧은 영화 대본이 하나 있습니다." },
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].text, "[음악]");
});

test("일본어·중국어는 공백 없이 잇는다 — 없던 공백이 단어를 가른다", () => {
  const ja = w.groupSegments([
    { start: 0, end: 2, text: "お話を聞いてみ" },
    { start: 2, end: 4, text: "たいと思います" },
  ]);
  assert.equal(ja.length, 1);
  assert.equal(ja[0].text, "お話を聞いてみたいと思います");

  const ko = w.groupSegments([
    { start: 0, end: 2, text: "여기 짧은" },
    { start: 2, end: 4, text: "영화 대본이" },
  ]);
  assert.equal(ko[0].text, "여기 짧은 영화 대본이");
});

test("잘린 짧은 조각은 이웃에 붙는다 — 토막 번역 방지", () => {
  const g = w.groupSegments([
    { start: 0, end: 1, text: "Bien," },
    { start: 1, end: 4, text: "esa idea proviene directamente del titulo de un articulo" },
  ]);
  assert.equal(g.length, 1);
  assert.match(g[0].text, /^Bien, esa idea/);
});

test("침묵이 길면 끊는다", () => {
  const g = w.groupSegments([
    { start: 0, end: 2, text: "first part" },
    { start: 9, end: 11, text: "much later" },
  ]);
  assert.equal(g.length, 2);
});

test("빈 입력에도 죽지 않는다", () => {
  assert.equal(w.groupSegments([]).length, 0);
  assert.equal(w.splitBySentence([]).length, 0);
});

test("CONTEXT 는 번호 목록 밖에 있다 (W16 — 개수가 밀리지 않게)", () => {
  const p = w.buildPayload([{ text: "a" }, { text: "b" }], ["before1"], ["after1"]);
  assert.match(p, /CONTEXT BEFORE:\nbefore1/);
  assert.match(p, /CONTEXT AFTER:\nafter1/);
  assert.match(p, /TRANSLATE THESE 2 LINES:\n0: a\n1: b/);
  assert.equal(/^\d+: before1/m.test(p), false, "문맥에 번호가 붙었다");
});

test("문맥이 없으면 블록 자체를 넣지 않는다", () => {
  const p = w.buildPayload([{ text: "only" }], [], []);
  assert.equal(p.includes("CONTEXT"), false);
  assert.match(p, /^TRANSLATE THESE 1 LINES:\n0: only$/);
});
