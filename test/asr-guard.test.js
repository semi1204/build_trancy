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
