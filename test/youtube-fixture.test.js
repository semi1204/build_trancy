import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContent } from "./harness.js";
import {
  clipSegments,
  json3ToSegments,
  segmentsToText,
  segmentsToVtt,
  sha256File,
  validateSegments,
  verifyFixture,
} from "../scripts/youtube-fixture-lib.mjs";

const json3 = {
  events: [
    {
      tStartMs: 500,
      dDurationMs: 1500,
      segs: [{ utf8: " Hello" }, { utf8: "   world " }],
    },
    {
      tStartMs: 2200,
      dDurationMs: 1000,
      segs: [{ utf8: "  " }],
    },
    {
      tStartMs: 3500,
      dDurationMs: 2000,
      segs: [{ utf8: "Last line" }],
    },
    { tStartMs: 6000, dDurationMs: 1000 },
  ],
};

test("로컬 fixture 파서가 확장의 JSON3 파서와 같은 세그먼트를 만든다", () => {
  const local = json3ToSegments(json3);
  const extension = loadContent().parseJson3Segments(json3);

  assert.deepEqual(JSON.parse(JSON.stringify(extension)), local);
  assert.deepEqual(local, [
    { start: 0.5, end: 2, text: "Hello world" },
    { start: 3.5, end: 5.5, text: "Last line" },
  ]);
});

test("fixture 길이에 맞춰 자막 끝을 자른다", () => {
  assert.deepEqual(clipSegments(json3ToSegments(json3), 4), [
    { start: 0.5, end: 2, text: "Hello world" },
    { start: 3.5, end: 4, text: "Last line" },
  ]);
});

test("WebVTT는 로컬 오디오와 함께 열 수 있는 타임코드를 만든다", () => {
  const vtt = segmentsToVtt(clipSegments(json3ToSegments(json3), 4));
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:00\.500 --> 00:00:02\.000/);
  assert.match(vtt, /00:00:03\.500 --> 00:00:04\.000/);
});

test("fixture 검증은 잘못되거나 뒤섞인 자막 시간을 거절한다", () => {
  assert.throws(
    () => validateSegments([{ start: Number.NaN, end: 1, text: "bad" }]),
    /숫자가 아닙니다/,
  );
  assert.throws(
    () => validateSegments([{ start: 1, end: 1, text: "zero" }]),
    /시간 범위가 잘못됐습니다/,
  );
  assert.throws(
    () => validateSegments([
      { start: 2, end: 3, text: "second" },
      { start: 1, end: 2, text: "first" },
    ]),
    /시간 순서가 뒤섞였습니다/,
  );
});

test("자막 전용 fixture는 오디오 없이 전체 JSON3 자막을 검증한다", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ytdual-transcript-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const segments = validateSegments(json3ToSegments(json3));
  const transcript = {
    videoId: "test-video",
    lang: "en",
    target: "Korean",
    mode: "full",
    segments,
  };
  const contents = {
    "captions.en.json3": `${JSON.stringify(json3)}\n`,
    "transcript.json": `${JSON.stringify(transcript, null, 2)}\n`,
    "transcript.txt": segmentsToText(segments),
    "transcript.vtt": segmentsToVtt(segments),
  };
  for (const [name, content] of Object.entries(contents)) {
    await writeFile(join(directory, name), content);
  }

  const files = {};
  for (const name of Object.keys(contents)) {
    const key = name.startsWith("captions")
      ? "captions"
      : name === "transcript.json"
        ? "transcript"
        : name === "transcript.txt"
          ? "text"
          : "vtt";
    files[key] = {
      path: name,
      sizeBytes: (await stat(join(directory, name))).size,
      sha256: await sha256File(join(directory, name)),
    };
  }

  const manifest = {
    schemaVersion: 1,
    source: {
      videoId: "test-video",
      url: "https://www.youtube.com/watch?v=test-video",
      title: "Test video",
      durationSeconds: 10,
    },
    capture: {
      kind: "transcript",
      language: "en",
      subtitleKind: "manual",
      seconds: null,
      tools: {
        ytDlp: { configIgnored: true, plugins: false, remoteComponents: false },
      },
    },
    files,
  };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await verifyFixture(directory);
  assert.equal(result.kind, "transcript");
  assert.equal(result.segments, 2);
  assert.equal(result.audio, null);
  assert.equal(segments.at(-1).end, 5.5);

  manifest.capture.kind = "media";
  manifest.capture.seconds = 4;
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(() => verifyFixture(directory), /manifest\.files\.audio 누락/);
});
