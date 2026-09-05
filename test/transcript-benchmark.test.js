import test from "node:test";
import assert from "node:assert/strict";
import {
  median,
  parseArgs,
  summarizeAdapterResult,
  validateCases,
} from "../scripts/bench-transcript-libraries.mjs";

test("자막 벤치 옵션은 반복·시간 제한 범위를 검증한다", () => {
  const options = parseArgs(["--repeat=3", "--timeout-ms=90000", "--cooldown-ms=0", "--skip-build"]);
  assert.equal(options.repeat, 3);
  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.cooldownMs, 0);
  assert.equal(options.skipBuild, true);
  assert.throws(() => parseArgs(["--repeat=0"]), /--repeat/);
  assert.throws(() => parseArgs(["--unknown"]), /알 수 없는 옵션/);
});

test("자막 벤치 케이스는 영상 ID와 정확한 언어 코드만 받는다", () => {
  assert.deepEqual(validateCases([{ videoId: "jNQXAC9IVRw", lang: "en-US", label: "short" }]), [
    { videoId: "jNQXAC9IVRw", lang: "en-US", label: "short" },
  ]);
  assert.throws(() => validateCases([]), /비어 있지 않은 배열/);
  assert.throws(() => validateCases([{ videoId: "https://youtu.be/x", lang: "en" }]), /videoId/);
  assert.throws(() => validateCases([{ videoId: "jNQXAC9IVRw", lang: "*" }]), /lang/);
});

test("성공한 어댑터 결과는 공통 세그먼트 요약으로 줄인다", () => {
  const result = summarizeAdapterResult({
    schemaVersion: 1,
    tool: "example/tool",
    toolVersion: "1.0.0",
    ok: true,
    mode: "live",
    libraryMs: 123,
    segments: [
      { start: 0, end: 1.5, text: "hello" },
      { start: 1.5, end: 3, text: "world" },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.segmentCount, 2);
  assert.equal(result.characterCount, 10);
  assert.equal(result.firstStart, 0);
  assert.equal(result.lastEnd, 3);
  assert.match(result.textSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.sample, ["hello", "world"]);
});

test("빈 결과와 라이브러리 오류를 측정 결과로 보존한다", () => {
  assert.equal(summarizeAdapterResult({
    schemaVersion: 1,
    tool: "empty/tool",
    toolVersion: "1",
    ok: true,
    mode: "live",
    libraryMs: 10,
    segments: [],
  }).status, "empty");

  const failed = summarizeAdapterResult({
    schemaVersion: 1,
    tool: "failed/tool",
    toolVersion: "1",
    ok: false,
    mode: "live",
    libraryMs: 30,
    error: { name: "RequestBlocked", message: "blocked" },
  });
  assert.equal(failed.status, "tool-error");
  assert.match(failed.error, /RequestBlocked/);
});

test("잘못된 시간과 깨진 오류 계약은 거절한다", () => {
  assert.throws(() => summarizeAdapterResult({
    schemaVersion: 1,
    tool: "bad/tool",
    toolVersion: "1",
    ok: true,
    mode: "live",
    libraryMs: 1,
    segments: [{ start: 1, end: 1, text: "bad" }],
  }), /시간 범위/);
  assert.throws(() => summarizeAdapterResult({
    schemaVersion: 1,
    tool: "bad/tool",
    ok: false,
    libraryMs: 1,
  }), /error/);
  assert.throws(() => summarizeAdapterResult({
    schemaVersion: 1,
    tool: "bad/tool",
    ok: true,
    mode: "live",
    libraryMs: null,
    segments: [],
  }), /libraryMs/);
});

test("중앙값은 홀수와 짝수 표본을 모두 계산한다", () => {
  assert.equal(median([]), null);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([10, 2]), 6);
});
