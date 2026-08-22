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
