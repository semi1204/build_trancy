#!/usr/bin/env node
import { fetchTranscript } from "youtube-transcript";

const TOOL = "Kakulukian/youtube-transcript";
const TOOL_VERSION = "1.3.1";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LANGUAGE = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, tool: TOOL, toolVersion: TOOL_VERSION, ...payload })}\n`);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalize(rows) {
  /* 1.3.1은 srv3 경로에서 ms, 고전 XML 폴백에서 초를 그대로 반환한다.
   * 자막 cue 지속시간의 중앙값으로 현재 응답 단위를 판별한다. */
  const durations = rows.map((row) => Number(row.duration)).filter((value) => value > 0);
  const scale = median(durations) > 100 ? 0.001 : 1;
  return rows.map((row) => {
    const start = Number(row.offset) * scale;
    const duration = Number(row.duration) * scale;
    return { start, end: start + duration, text: cleanText(row.text) };
  }).filter((segment) => segment.text);
}

async function readRequest() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

async function main() {
  let request;
  try {
    request = await readRequest();
  } catch (error) {
    emit({ ok: false, mode: "input", libraryMs: null, error: { name: error.name, message: error.message } });
    return;
  }

  if (request.mode === "smoke") {
    emit({ ok: typeof fetchTranscript === "function", mode: "smoke", libraryMs: 0, segments: [] });
    return;
  }

  const videoId = request.videoId ?? "";
  const lang = request.lang ?? "";
  if (!VIDEO_ID.test(videoId) || !LANGUAGE.test(lang)) {
    emit({ ok: false, mode: "live", videoId, lang, libraryMs: null,
      error: { name: "InvalidInput", message: "videoId 또는 lang 형식이 잘못됐습니다" } });
    return;
  }

  const started = performance.now();
  try {
    const rows = await fetchTranscript(videoId, { lang });
    emit({ ok: true, mode: "live", videoId, lang,
      libraryMs: Math.round(performance.now() - started), segments: normalize(rows) });
  } catch (error) {
    emit({ ok: false, mode: "live", videoId, lang,
      libraryMs: Math.round(performance.now() - started),
      error: { name: error?.constructor?.name || error?.name || "Error", message: String(error?.message ?? error) } });
  }
}

main();
