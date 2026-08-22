/* 자막 트랙 선택 — 영상 원어 우선, 그 안에서 수동 > 자동.
 *
 * 무엇이 문제였나:
 *   score = (prefer 언어 일치 ? 2 : 0) + (kind === "asr" ? 0 : 1)
 *   언어 일치(2)가 수동/자동(1)을 이긴다. 그래서 prefer="en" 인 사용자가
 *   스페인어 영상을 열면, 영상에 en 자동번역/자동생성 트랙이 하나라도 있으면
 *   그쪽이 뽑힌다. 듣는 소리는 스페인어인데 자막은 영어라 듣기 학습이 안 된다.
 *
 * 규칙:
 *   1) 영상 원어를 정한다 — defaultAudioLanguage → ASR 트랙의 언어 →
 *      audioTracks 의 기본 트랙 → cfg.prefer → 첫 트랙
 *   2) 원어 일치 → 수동(kind !== "asr") → prefer 일치 → 원래 순서
 *   3) 자동 번역으로 파생된 트랙은 후보에서 제외한다 (원문이 아니다)
 *
 * fixture 로는 검증할 수 없다 — 캡처한 자막 스크립트에는 playerResponse.captions
 * 가 없다. 그래서 여기 트랙 목록은 실제 유튜브 응답 형태를 본뜬 합성이다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./harness.js";

/** @param {object[]} tracks @param {object} [videoDetails] */
function player(tracks, videoDetails = {}, audioTracks) {
  return {
    videoDetails,
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: tracks,
        ...(audioTracks ? { audioTracks } : {}),
      },
    },
  };
}
const manual = (lang) => ({ languageCode: lang, baseUrl: `https://x/${lang}`, name: { simpleText: lang } });
const asr = (lang) => ({ ...manual(lang), kind: "asr" });

function withPrefer(prefer) {
  const y = loadContent();
  y.cfg = { ...y.cfg, prefer };
  return y;
}

test("★ 원어가 스페인어면 prefer=en 이어도 스페인어 트랙을 고른다", () => {
  const y = withPrefer("en");
  // 스페인어 영상에 영어 자막이 함께 달린 흔한 구성
  const p = player([manual("en"), manual("es")], { defaultAudioLanguage: "es" });
  assert.equal(y.pickTrack(p).languageCode, "es");
});

test("★ 같은 원어 안에서는 수동이 자동을 이긴다", () => {
  const y = withPrefer("en");
  const p = player([asr("en"), manual("en")], { defaultAudioLanguage: "en" });
  const t = y.pickTrack(p);
  assert.equal(t.languageCode, "en");
  assert.equal(t.kind, undefined, "자동생성 트랙이 뽑혔다");
});

test("defaultAudioLanguage 가 없으면 ASR 트랙의 언어를 원어로 본다", () => {
  const y = withPrefer("en");
  // ASR 은 들리는 소리를 옮긴 것이므로 그 언어가 곧 원어다
  const p = player([manual("en"), asr("ja"), manual("ja")]);
  assert.equal(y.pickTrack(p).languageCode, "ja");
});

test("원어를 알 수 없으면 prefer 를 쓴다", () => {
  const y = withPrefer("es");
  const p = player([manual("en"), manual("es")]);
  assert.equal(y.pickTrack(p).languageCode, "es");
});

test("원어도 prefer 도 없으면 첫 트랙", () => {
  const y = withPrefer("");
  const p = player([manual("de"), manual("fr")]);
  assert.equal(y.pickTrack(p).languageCode, "de");
});

test("지역 변종(en-US)도 원어 en 과 일치로 본다", () => {
  const y = withPrefer("ko");
  const p = player([manual("ko"), manual("en-US")], { defaultAudioLanguage: "en" });
  assert.equal(y.pickTrack(p).languageCode, "en-US");
});

test("자동 번역 파생 트랙은 후보에서 제외한다", () => {
  const y = withPrefer("ko");
  // 판정 근거는 translatedLanguage 하나뿐이다. vssId 는 아니다 —
  // "." 은 사람이 올린 자막, "a." 가 ASR 이다 (거꾸로 알아서 사람 자막을 전부
  // 걸러내던 시절이 있었다. content.js 의 pickTrack 주석 참조).
  const translated = { ...manual("ko"), vssId: ".ko", translatedLanguage: { languageCode: "ko" } };
  const p = player([translated, manual("en")], { defaultAudioLanguage: "en" });
  assert.equal(y.pickTrack(p).languageCode, "en");
});

test("후보가 자동 번역뿐이면 그거라도 준다 (빈손보다 낫다)", () => {
  const y = withPrefer("ko");
  const translated = { ...manual("ko"), translatedLanguage: { languageCode: "ko" } };
  assert.equal(y.pickTrack(player([translated])).languageCode, "ko");
});

test("트랙이 없으면 null", () => {
  const y = withPrefer("en");
  assert.equal(y.pickTrack(player([])), null);
  assert.equal(y.pickTrack({}), null);
  assert.equal(y.pickTrack(null), null);
});

test("점수가 같으면 유튜브가 준 순서를 지킨다", () => {
  const y = withPrefer("en");
  const a = manual("fr"), b = manual("de");
  assert.equal(y.pickTrack(player([a, b])), a);
  assert.equal(y.pickTrack(player([b, a])), b);
});

/* ── 실제 유튜브 응답에서 뽑은 트랙 목록 ──────────────────────────────
 * 합성 예제로는 안 잡히는 것들이다. 아래 셋은 전부 실제로 틀렸던 경우다.
 *   1) vssId 의 "." 을 "번역 파생"으로 오해해 사람 자막을 전부 걸러냈다
 *      → 사람 자막과 ASR 이 함께 있는 영상에서 늘 ASR 이 뽑혔다
 *   2) 업로더가 Twitch 채팅 로그를 자막 트랙으로 올린 영상에서, 말소리(ASR)가
 *      아니라 채팅이 뽑힐 뻔했다
 *   3) 유튜브 자신은 그 채팅 트랙을 audioTracks 의 기본값으로 지목한다 —
 *      defaultCaptionTrackIndex 를 믿으면 안 된다는 뜻이다
 * (2026-08 기준 watch 페이지에서 그대로 받아 적었다) */
const REAL = {
  "VBMUMuZBxw0 (채팅 트랙이 섞인 영상)": {
    expect: "a.en",
    audioTracks: [{ defaultCaptionTrackIndex: 1 }],
    tracks: [
      { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
      { vssId: ".en-US._5Vp3ULVrJE", languageCode: "en-US", trackName: "Twitch Chat", baseUrl: "u" },
    ],
  },
  "M7lc1UVf-VE (사람 자막 + ASR)": {
    expect: ".en",
    tracks: [
      { vssId: ".en", languageCode: "en", trackName: "", baseUrl: "u" },
      { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
    ],
  },
  "R2vXbFp5C9o (ASR 이 먼저 나열됨)": {
    expect: ".en-US",
    tracks: [
      { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
      { vssId: ".en-US", languageCode: "en-US", trackName: "", baseUrl: "u" },
    ],
  },
  "MenYHcLC16M (여러 언어 + 원어 ASR)": {
    expect: ".ko",
    tracks: [
      { vssId: ".zh-TW", languageCode: "zh-TW", trackName: "", baseUrl: "u" },
      { vssId: ".ja", languageCode: "ja", trackName: "", baseUrl: "u" },
      { vssId: ".ko", languageCode: "ko", trackName: "", baseUrl: "u" },
      { vssId: "a.ko", languageCode: "ko", kind: "asr", trackName: "", baseUrl: "u" },
    ],
  },
};

test("★ 실제 유튜브 응답에서 올바른 트랙을 고른다", () => {
  const y = withPrefer("en");
  for (const [label, c] of Object.entries(REAL)) {
    const got = y.pickTrack(player(c.tracks, {}, c.audioTracks));
    assert.equal(got?.vssId, c.expect, `${label}: ${got?.vssId} 를 골랐다`);
  }
});

test("★ 사람이 올린 자막이 ASR 을 이긴다 — vssId 의 '.' 은 번역이 아니라 수동이다", () => {
  const y = withPrefer("en");
  const t = y.pickTrack(player([
    { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
    { vssId: ".en", languageCode: "en", trackName: "", baseUrl: "u" },
  ]));
  assert.equal(t.vssId, ".en");
  assert.equal(t.kind, undefined);
});

test("★ 이름 붙은 대체 트랙(채팅·코멘터리)은 후순위", () => {
  const y = withPrefer("en");
  // 말소리는 ASR 뿐이고 사람이 올린 것은 채팅 로그다 → 말소리를 골라야 한다
  const t = y.pickTrack(player([
    { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
    { vssId: ".en-US._x", languageCode: "en-US", trackName: "Twitch Chat", baseUrl: "u" },
  ]));
  assert.equal(t.kind, "asr", "채팅 트랙이 뽑혔다");
});

test("이름 붙은 트랙뿐이면 그거라도 준다", () => {
  const y = withPrefer("en");
  const t = y.pickTrack(player([
    { vssId: ".en._x", languageCode: "en", trackName: "Commentary", baseUrl: "u" },
  ]));
  assert.equal(t.trackName, "Commentary");
});

test("유튜브의 defaultCaptionTrackIndex 는 믿지 않는다", () => {
  const y = withPrefer("en");
  // 유튜브는 채팅 트랙(index 1)을 기본으로 지목하지만 우리는 말소리를 원한다
  const t = y.pickTrack(player([
    { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
    { vssId: ".en-US._x", languageCode: "en-US", trackName: "Twitch Chat", baseUrl: "u" },
  ], {}, [{ defaultCaptionTrackIndex: 1 }]));
  assert.equal(t.kind, "asr");
});

/* ── runtimeUrlFor — pickTrack 이 고른 트랙의 pot 붙은 URL 찾기 ──────
 * 유튜브는 pot 없는 timedtext 요청에 200 + 빈 본문을 준다. pot 은 정적
 * ytInitialPlayerResponse 의 baseUrl 에는 없고, 플레이어가 초기화된 뒤 노출하는
 * #movie_player.getAudioTrack().captionTracks[].url 에만 붙는다.
 *
 * 그래서 "고르기"와 "가져오기"를 나눈다 — 선택은 검증된 pickTrack 이 playerResponse
 * 로 끝내고, 이 함수는 그 트랙에 해당하는 런타임 URL 만 찾아 준다.
 *
 * ★ 틀리면 증상이 "자막이 안 나온다"가 아니라 "다른 트랙의 자막이 나온다"다.
 *   채팅 로그를 자막으로 띄웠던 사고와 같은 종류다 (I27).
 */
const rt = (o) => ({ hasPot: true, ...o });

// [실측 VBMUMuZBxw0, Chrome 151] 런타임과 정적은 순서가 역순이고 vssId 는 같다.
const RUNTIME_VBMU = [
  rt({ vssId: ".en-US._5Vp3ULVrJE", languageCode: "en-US", kind: "", url: "u-chat" }),
  rt({ vssId: "a.en", languageCode: "en", kind: "asr", url: "u-asr" }),
];

test("★ vssId 로 대조한다 — 인덱스로 하면 순서가 달라 다른 트랙이 온다", () => {
  const y = withPrefer("ko");
  // 정적 목록은 [a.en, 채팅] 순이라 pickTrack 이 고른 것은 배열 0번이다.
  // 런타임 목록에서 0번은 채팅이다 — 인덱스로 짰다면 채팅 URL 을 가져왔을 것이다.
  const asr = { vssId: "a.en", languageCode: "en", kind: "asr", baseUrl: "b" };
  assert.equal(y.runtimeUrlFor(asr, RUNTIME_VBMU), "u-asr");
});

test("★ 채팅 트랙을 고른 경우에도 자기 URL 을 받는다", () => {
  const y = withPrefer("ko");
  const chat = { vssId: ".en-US._5Vp3ULVrJE", languageCode: "en-US", trackName: "Twitch Chat", baseUrl: "b" };
  assert.equal(y.runtimeUrlFor(chat, RUNTIME_VBMU), "u-chat");
});

test("★ pot 없는 런타임 트랙은 후보가 아니다 (I30)", () => {
  // pot 없는 URL 은 어차피 빈 본문이다. 쓰면 via 만 "runtime" 이라 거짓이 된다.
  const y = withPrefer("ko");
  const noPot = RUNTIME_VBMU.map((t) => ({ ...t, hasPot: false }));
  assert.equal(y.runtimeUrlFor({ vssId: "a.en", languageCode: "en", kind: "asr" }, noPot), null);
});

test("★ 대조가 애매하면 null — 강등이 틀린 URL 보다 낫다 (I27)", () => {
  const y = withPrefer("ko");
  const t = { vssId: "a.en", languageCode: "en", kind: "asr" };
  assert.equal(y.runtimeUrlFor(t, []), null, "후보 0개");
  const dup = [rt({ vssId: "a.en", languageCode: "en", kind: "asr", url: "x" }),
               rt({ vssId: "a.en", languageCode: "en", kind: "asr", url: "y" })];
  assert.equal(y.runtimeUrlFor(t, dup), null, "같은 vssId 가 둘이면 우리가 모르는 상황이다");
});

test("vssId 가 없으면 언어와 ASR 여부로 내려간다", () => {
  const y = withPrefer("ko");
  const pool = [rt({ languageCode: "en", kind: "asr", url: "u-asr" }),
                rt({ languageCode: "en", kind: "", url: "u-manual" })];
  assert.equal(y.runtimeUrlFor({ languageCode: "en", kind: "asr" }, pool), "u-asr");
  assert.equal(y.runtimeUrlFor({ languageCode: "en", vssId: ".en" }, pool), "u-manual");
});

test("지역 변종(en-US)도 같은 언어로 본다", () => {
  const y = withPrefer("ko");
  const pool = [rt({ languageCode: "en-US", kind: "", url: "u" })];
  assert.equal(y.runtimeUrlFor({ languageCode: "en", vssId: ".en" }, pool), "u");
});

test("입력이 망가져도 죽지 않는다", () => {
  const y = withPrefer("ko");
  assert.equal(y.runtimeUrlFor(null, RUNTIME_VBMU), null);
  assert.equal(y.runtimeUrlFor({ vssId: "a.en" }, null), null);
  assert.equal(y.runtimeUrlFor({ vssId: "a.en" }, [null, {}]), null);
});
