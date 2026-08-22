/* 긴 줄 분할 — 번역이 사라지지 않는가.
 *
 * 여기 있는 입력은 전부 실측이다. 실제 자막 스크립트(.local/youtube-transcripts)
 * 4개를 gpt-5.6-terra 로 번역해 받은 응답에서, 빈 번역이 붙은 줄들을 원래 한 줄로
 * 되돌린 것이다. 합성 예제가 아니다.
 *
 * 무엇이 깨졌었나:
 *   splitLine 은 원문을 n 조각으로 자른 뒤 packToK(clausePieces(trans), n) 로
 *   번역도 n 조각으로 나눈다. 그런데 packToK 는 pieces.length < k 면 k 개를
 *   만들지 못한다. 한국어 번역은 영어·스페인어 원문보다 절 구분 문장부호가
 *   훨씬 적어서 이 상황이 상시 발생했고, `tParts[i] || ""` 가 꼬리를 빈칸으로
 *   만들었다.
 *
 * 왜 치명적인가:
 *   mergeTranslated 가 그 줄에 tier:"full" 을 찍는다. 그러면 applyFast 가
 *   I21 로 건너뛰므로 영영 채워지지 않는다. 게다가 분할된 형태 그대로 KV 에
 *   저장되어(index.js handleSubtitle) 새로고침해도 같은 빈칸이 나온다.
 *
 * 실측 규모: 24요청 209줄 중 27줄(12.6~13.1%)이 빈 번역. 사슬 밖 단독 빈 줄은
 *   0 이었다 — 즉 LLM 이 아니라 이 분할 코드가 원인이다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadWorker } from "./worker-harness.js";

/** 실제 번역 응답에서 복원한 splitLine 입력. orig 는 실제 자막 원문,
 *  trans 는 그 줄에 대해 모델이 실제로 돌려준 한국어다. */
const REAL_CASES = [
  {
    label: "M7lc1UVf-VE 87자/절경계 1개",
    orig: "This is pretty much the default behavior when controls=1, or if you leave out controls.",
    trans: "controls=1로 설정하거나 controls를 생략하면 이것이 거의 기본 동작입니다.",
  },
  {
    label: "M7lc1UVf-VE 170자/절경계 없음",
    orig: "But for this particular show, we're going to be focusing on customizing the iframe-embedded player, which is our current recommended way of embedding videos on web pages.",
    trans: "하지만 이번 방송에서는 현재 웹페이지에 동영상을 삽입하는 데 권장되는 방식인 iframe 임베디드 플레이어의 맞춤설정에 집중하겠습니다.",
  },
  {
    label: "M7lc1UVf-VE 189자",
    orig: "And it can take some time for these underlying Flash players to all initialize, and can add some latency to the point where things look like they're ready to be interacted with on the page.",
    trans: "그리고 내부 Flash 플레이어들이 모두 초기화되는 데 시간이 걸릴 수 있어서, 페이지가 상호작용할 준비가 된 것처럼 보이기까지 지연이 추가될 수 있습니다.",
  },
  {
    label: "M7lc1UVf-VE 115자",
    orig: "If you take the same thing and you change it to controls=2 explicitly, then you should see much better performance.",
    trans: "같은 것을 controls=2로 명시적으로 바꾸면 성능이 훨씬 더 좋아지는 것을 볼 수 있습니다.",
  },
  {
    label: "M7lc1UVf-VE 100자",
    orig: "And be sure to check out the annotations on the video for links to everything that we covered today.",
    trans: "그리고 오늘 다룬 모든 내용의 링크는 영상 주석에서 꼭 확인해 보세요.",
  },
  {
    label: "gIwvFMiJNVU(es) 183자",
    orig: "Derek: El efecto mariposa es la idea de que pequeñas causas, como el aleteo de las alas de una mariposa en Brasil, pueden tener consecuencias enormes, como provocar un tornado en Texas.",
    trans: "데릭: 나비 효과란 브라질에서 나비가 날갯짓하는 것 같은 작은 원인이 텍사스에 토네이도를 일으키는 것처럼 엄청난 결과를 낳을 수 있다는 개념입니다.",
  },
  {
    label: "gIwvFMiJNVU(es) 204자/4조각",
    orig: "Bien, esa idea proviene directamente del título de un artículo científico publicado hace casi 50 años y ha capturado la imaginación del público, quizás más que cualquier otro concepto científico reciente.",
    trans: "자, 이 개념은 거의 50년 전에 발표된 한 과학 논문의 제목에서 직접 비롯되었고, 어쩌면 최근의 다른 어떤 과학 개념보다도 대중의 상상력을 사로잡았습니다.",
  },
];

const w = loadWorker();

test("★ 분할이 번역을 지우지 않는다 — 실측 실패 케이스 전부", () => {
  const failures = [];
  for (const c of REAL_CASES) {
    const parts = w.splitLine({ start: 10, end: 20, orig: c.orig, trans: c.trans });
    const empty = parts.filter((p) => !String(p.trans ?? "").trim());
    if (empty.length) {
      failures.push(`${c.label}: ${parts.length}조각 중 ${empty.length}개 빈칸`);
    }
  }
  assert.deepEqual(failures, [], `번역이 사라진 줄:\n  ${failures.join("\n  ")}`);
});

test("분할해도 원문이 소실되지 않는다", () => {
  for (const c of REAL_CASES) {
    const parts = w.splitLine({ start: 10, end: 20, orig: c.orig, trans: c.trans });
    const joined = parts.map((p) => p.orig).join(" ").replace(/\s+/g, " ").trim();
    assert.equal(
      joined.replace(/\s/g, ""),
      c.orig.replace(/\s/g, ""),
      `원문이 바뀌었다 — ${c.label}`,
    );
  }
});

test("분할된 줄의 시간은 원본 구간 안에서 이어진다", () => {
  for (const c of REAL_CASES) {
    const parts = w.splitLine({ start: 10, end: 20, orig: c.orig, trans: c.trans });
    assert.equal(parts[0].start, 10, `시작이 밀렸다 — ${c.label}`);
    assert.equal(parts.at(-1).end, 20, `끝이 밀렸다 — ${c.label}`);
    for (let i = 0; i < parts.length; i++) {
      assert.ok(parts[i].end >= parts[i].start, `end < start — ${c.label}[${i}]`);
      if (i) assert.equal(parts[i].start, parts[i - 1].end, `시간이 끊겼다 — ${c.label}[${i}]`);
    }
  }
});

test("짧은 줄은 건드리지 않는다", () => {
  // vm 컨텍스트가 달라 배열 프로토타입이 다르므로 deepEqual 대신 내용으로 비교한다
  const line = { start: 1, end: 2, orig: "Short enough.", trans: "충분히 짧습니다." };
  const out = w.splitLine(line);
  assert.equal(out.length, 1);
  assert.equal(out[0], line, "같은 객체를 그대로 돌려줘야 한다");
});

test("번역이 아예 없으면 원문만 나눈다 (빈칸은 여기선 정상)", () => {
  const orig = REAL_CASES[1].orig;
  const parts = w.splitLine({ start: 0, end: 10, orig, trans: "" });
  assert.ok(parts.length >= 2, "긴 원문이 안 나뉘었다");
  assert.ok(parts.every((p) => p.trans === ""), "없는 번역이 생겼다");
});

test("enforceShortLines 도 같은 보장을 지킨다 (실제 호출 경로)", async () => {
  const lines = REAL_CASES.map((c, i) => ({
    start: i * 10, end: i * 10 + 8, orig: c.orig, trans: c.trans,
  }));
  const out = await w.enforceShortLines({}, lines);
  const empty = out.filter((l) => !String(l.trans ?? "").trim());
  assert.equal(empty.length, 0,
    `enforceShortLines 결과에 빈 번역 ${empty.length}개:\n  ` +
    empty.map((l) => l.orig.slice(0, 60)).join("\n  "));
});

/* ── 조각 커버리지 (W20) ─────────────────────────────────────────────
 * 모델이 조각을 통째로 빠뜨리면 mergeTranslated 가 지운 자리가 빈 시각이 된다.
 * [실측: 24요청 중 1건. gIwvFMiJNVU 의 마지막 조각 "00:43 DEREK" 이 빠져 1.00초가
 *  비었다 — 모델이 자막 부산물을 노이즈로 보고 버린 것이다]
 */
const batch = (n) => Array.from({ length: n }, (_, i) => ({
  start: i * 3, end: i * 3 + 3, text: `frag ${i}`,
}));
const line = (s, e, b) => ({ s, e, start: b[s].start, end: b[e].end, orig: `o${s}-${e}`, trans: `t${s}-${e}` });

test("★ 모델이 빠뜨린 조각을 원문으로 메운다 — 꼬리", () => {
  const b = batch(12);
  const out = [line(0, 5, b), line(6, 10, b)];       // 11번 조각이 빠졌다
  w.fillUncovered(b, out);
  const covered = new Set();
  for (const l of out) for (let i = l.s; i <= l.e; i++) covered.add(i);
  assert.equal(covered.size, 12, "안 덮인 조각이 남았다");
  const added = out.find((l) => l.s === 11);
  assert.equal(added.orig, "frag 11", "원문이 안 실렸다");
  assert.equal(added.end, b[11].end);
});

test("★ 중간에 빠진 조각도 메우고 순서를 지킨다", () => {
  const b = batch(10);
  const out = [line(0, 2, b), line(6, 9, b)];        // 3,4,5 가 빠졌다
  w.fillUncovered(b, out);
  assert.deepEqual(out.map((l) => l.s), [0, 3, 4, 5, 6], "인덱스 순서가 깨졌다");
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].start <= out[i].start, "start 정렬이 깨졌다");
  }
});

test("빠진 게 없으면 아무것도 바꾸지 않는다", () => {
  const b = batch(6);
  const out = [line(0, 2, b), line(3, 5, b)];
  const before = JSON.stringify(out);
  w.fillUncovered(b, out);
  assert.equal(JSON.stringify(out), before);
});

test("응답이 통째로 비어도 전 구간을 원문으로 덮는다", () => {
  const b = batch(4);
  const out = [];
  w.fillUncovered(b, out);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((l) => l.orig), ["frag 0", "frag 1", "frag 2", "frag 3"]);
});
