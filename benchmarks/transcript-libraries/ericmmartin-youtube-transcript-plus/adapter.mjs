#!/usr/bin/env node
import { fetchTranscript } from "youtube-transcript-plus";

const TOOL = "ericmmartin/youtube-transcript-plus";
const TOOL_VERSION = "2.0.1";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LANGUAGE = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, tool: TOOL, toolVersion: TOOL_VERSION, ...payload })}\n`);
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalize(result) {
  const rows = Array.isArray(result) ? result : result?.segments;
  if (!Array.isArray(rows)) throw new Error("segments 배열이 없는 응답입니다");
  return rows.map((row) => {
    const start = Number(row.offset);
    const duration = Number(row.duration);
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
    const result = await fetchTranscript(videoId, { lang, retries: 0 });
    emit({ ok: true, mode: "live", videoId, lang,
      libraryMs: Math.round(performance.now() - started), segments: normalize(result) });
  } catch (error) {
    emit({ ok: false, mode: "live", videoId, lang,
      libraryMs: Math.round(performance.now() - started),
      error: { name: error?.constructor?.name || error?.name || "Error", message: String(error?.message ?? error) } });
  }
}

main();
