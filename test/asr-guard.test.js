/* 자막이 있는 영상에서 Whisper 전사(/api/transcribe)가 절대 돌지 않는가.
 *
 * 무엇이 위험했나:
 *   start() 는 segments.length === 0 이면 무조건 startAsr() 를 불렀다. 그런데
 *   빈 배열이 나오는 경로가 둘이다.
 *     (a) 이 영상에 자막이 정말 없다                      → 전사가 맞다
 *     (b) 자막은 있는데 수집이 실패했다                    → 전사는 사고다
 *   두 경우가 같은 값으로 뭉개져 구분이 불가능했다.
 *
 * (b) 는 가상의 이야기가 아니다. 실제 경로가 둘 있다:
 *   - fetchSegments 는 PoToken 없는 요청에 오는 "200 + 빈 본문"에도 [] 를 준다
 *   - scrapeTranscriptPanel 은 하드코딩된 유튜브 DOM 셀렉터에 의존한다.
 *     유튜브가 클래스명을 한 번 바꾸면 자막이 멀쩡한 영상 전체가 전사로 넘어가
 *     Groq 요금이 조용히 발생한다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./harness.js";

const y = loadContent();
const choose = y.chooseSource;

/** captionTracks 가 있는 플레이어 응답 */
const withTracks = {
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [{ languageCode: "en", baseUrl: "https://x/timedtext" }],
    },
  },
};
const noTracks = { captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } } };
const live = { videoDetails: { isLive: true }, ...withTracks };

const ok = (n = 3) => ({ segments: Array.from({ length: n }, (_, i) => ({ start: i, end: i + 1, text: `s${i}` })), reason: "ok" });
const fail = (reason) => ({ segments: [], reason });

test("★ 자막 트랙이 있는데 수집이 실패하면 전사로 넘어가지 않는다", () => {
  // timedtext 200+빈본문, 패널도 노드 0 — 지금까지 이 조합이 전사를 유발했다
  for (const [a, b] of [
    ["empty-body", "no-panel"],
    ["http-error", "no-panel"],
    ["parse-error", "parse-error"],
    ["http-error", "http-error"],
  ]) {
    const d = choose(withTracks, fail(a), fail(b));
    assert.equal(d.kind, "fail", `${a}/${b} 에서 kind=${d.kind} — 전사가 돌 뻔했다`);
    assert.ok(d.reason, "실패 사유가 비어 있다 — 사용자에게 보여줄 게 없다");
  }
});

test("★ 자막 트랙 자체가 없을 때만 전사를 허용한다", () => {
  const d = choose(noTracks, fail("no-track"), fail("no-track"));
  assert.equal(d.kind, "asr");
});

test("라이브는 완결된 트랙이 없으므로 전사로 간다", () => {
  assert.equal(choose(live, fail("no-track"), fail("no-track")).kind, "asr");
  // 트랙이 있어 보여도 라이브면 전사 (진행 중이라 자막이 완결되지 않는다)
  assert.equal(choose(live, ok(), fail("no-panel")).kind, "asr");
});

test("timedtext 가 성공하면 그 조각을 쓴다", () => {
  const d = choose(withTracks, ok(5), fail("no-panel"));
  assert.equal(d.kind, "captions");
  assert.equal(d.segments.length, 5);
});

test("timedtext 가 막히고 패널이 성공하면 패널 조각을 쓴다", () => {
  const d = choose(withTracks, fail("empty-body"), ok(4));
  assert.equal(d.kind, "captions");
  assert.equal(d.segments.length, 4);
});

test("captions 필드가 아예 없는 응답도 전사로 간다 (자막 없는 영상)", () => {
  assert.equal(choose({}, fail("no-track"), fail("no-track")).kind, "asr");
  assert.equal(choose(null, fail("no-track"), fail("no-track")).kind, "asr");
});

test("startAsr 호출부는 한 곳뿐이다 — 우회 경로가 생기면 이 검사가 깨진다", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    fileURLToPath(new URL("../ytdual/extension/content.js", import.meta.url)), "utf8");
  const hits = src.match(/\bstartAsr\s*\(/g) || [];
  // 정의 1 + 호출 1. 늘어나면 chooseSource 를 우회하는 경로가 생긴 것이다.
  assert.equal(hits.length, 2, `startAsr( 가 ${hits.length}회 — 정의 1 + 호출 1 이어야 한다`);
});

/* ── 패널 폴백이 "고른 트랙"과 같은가 ────────────────────────────────
 * timedtext 가 막히면 스크립트 패널로 폴백한다. 그런데 패널에는 트랙 전환 UI 도,
 * 어느 트랙인지 알려주는 라벨도 없다 — 유튜브의 기본 트랙 하나만 띄운다.
 * [2026-08 실측: target-id=PAmodern_transcript_view, 헤더는 "Transcript" 와
 *  닫기 버튼뿐. "Twitch Chat"/"auto-generated" 문자열은 DOM 어디에도 없다]
 *
 * 그래서 사고가 났다. VBMUMuZBxw0 은 음성 ASR 과 "Twitch Chat" 트랙을 함께 갖고,
 * 유튜브 기본값이 채팅이다(defaultCaptionTrackIndex=1). pickTrack 은 ASR 을 옳게
 * 골랐지만 그 트랙의 timedtext 가 200+빈본문으로 막혔고, 패널로 폴백하자
 * 채팅 로그가 자막으로 떴다.
 *
 * 이 영상은 ASR 을 가져올 방법이 아예 없다 — timedtext 는 어떤 파라미터로도
 * 빈 본문이고(PoToken), 패널이 쓰는 /youtubei/v1/get_panel 은 바이너리 protobuf 다.
 * 그러니 최소한 "다른 트랙을 자막으로 오인"하지는 않아야 한다.
 */
/** playerResponse 를 만든다 (track.test.js 와 같은 모양) */
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

const VBMU = {
  audioTracks: [{ defaultCaptionTrackIndex: 1 }],
  tracks: [
    { vssId: "a.en", languageCode: "en", kind: "asr", trackName: "", baseUrl: "u" },
    { vssId: ".en-US._5Vp3ULVrJE", languageCode: "en-US", trackName: "Twitch Chat", baseUrl: "u" },
  ],
};

test("★ 패널이 보여줄 트랙을 유튜브 기본값으로 계산한다", () => {
  const p = player(VBMU.tracks, {}, VBMU.audioTracks);
  assert.equal(y.panelTrack(p).trackName, "Twitch Chat", "기본 트랙을 잘못 짚었다");
});

test("기본 인덱스가 없으면 첫 트랙", () => {
  assert.equal(y.panelTrack(player(VBMU.tracks)).vssId, "a.en");
});

test("트랙이 없으면 null", () => {
  assert.equal(y.panelTrack(player([])), null);
  assert.equal(y.panelTrack(null), null);
});

test("★ 패널이 다른 트랙을 보여주면 그 내용을 자막으로 받지 않는다", () => {
  // 실제 사고 재현: 채팅 로그가 패널에 담겨 왔다
  const chat = { segments: [{ start: 0, end: 2, text: "RoboChris_: we back rantos9: is it back?" }], reason: "ok" };
  const d = choose(player(VBMU.tracks, {}, VBMU.audioTracks), fail("empty-body"),
    { segments: [], reason: "panel-other-track" });
  assert.equal(d.kind, "fail", "다른 트랙 내용을 자막으로 받았다");
  assert.match(d.reason, /채팅|다른 트랙/, "이유가 사용자에게 도움이 안 된다");
  // 만약 호출부가 실수로 채팅을 넘겼더라도 그건 별도 문제 — 여기서는 넘기지 않는 것을 검사한다
  assert.notEqual(chat.segments[0].text, d.segments?.[0]?.text);
});

test("패널이 고른 트랙과 같으면 정상적으로 쓴다", () => {
  // 트랙이 하나뿐인 흔한 경우 — 패널이 보여줄 수 있는 것은 그것뿐이다
  const one = [{ vssId: ".en", languageCode: "en", trackName: "", baseUrl: "u" }];
  const p = player(one);
  assert.equal(y.panelTrack(p), p.captions.playerCaptionsTracklistRenderer.captionTracks[0]);
  const d = choose(p, fail("empty-body"), ok(5));
  assert.equal(d.kind, "captions");
  assert.equal(d.reason, "panel");
});

test("★ 패널 폴백은 panelTrack 이 고른 트랙과 같을 때만 시도된다 (호출부 검사)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(fileURLToPath(new URL("../ytdual/extension/content.js", import.meta.url)), "utf8");
  // scrapeTranscriptPanel 호출이 panelTrack 비교 안에 있어야 한다
  const call = src.indexOf("await scrapeTranscriptPanel()");   // 정의부 말고 호출부
  assert.ok(call > 0, "패널 호출부를 못 찾았다");
  const before = src.slice(Math.max(0, call - 600), call);
  assert.match(before, /panelTrack\(player\)\s*!==\s*track/,
    "패널을 트랙 확인 없이 긁는다 — 다른 트랙 자막이 올 수 있다");
});
