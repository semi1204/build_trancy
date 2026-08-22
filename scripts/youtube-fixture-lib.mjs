import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

export function json3ToSegments(data) {
  return (data.events || [])
    .filter((event) => event.segs)
    .map((event) => ({
      start: event.tStartMs / 1000,
      end: (event.tStartMs + (event.dDurationMs || 0)) / 1000,
      text: event.segs.map((segment) => segment.utf8).join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((segment) => segment.text);
}

export function clipSegments(segments, seconds) {
  return segments
    .filter((segment) => segment.start < seconds)
    .map((segment) => ({
      ...segment,
      end: Math.min(segment.end, seconds),
    }));
}

export function validateSegments(segments) {
  let previousStart = -1;
  for (const [index, segment] of segments.entries()) {
    if (![segment.start, segment.end].every(Number.isFinite)) {
      throw new Error(`자막 ${index}의 시간이 숫자가 아닙니다`);
    }
    if (segment.start < 0 || segment.end <= segment.start) {
      throw new Error(`자막 ${index}의 시간 범위가 잘못됐습니다`);
    }
    if (segment.start < previousStart) throw new Error(`자막 ${index}의 시간 순서가 뒤섞였습니다`);
    if (typeof segment.text !== "string" || !segment.text.trim()) {
      throw new Error(`자막 ${index}의 텍스트가 비었습니다`);
    }
    previousStart = segment.start;
  }
  return segments;
}

function timestamp(seconds) {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const hh = Math.floor(millis / 3_600_000);
  const mm = Math.floor((millis % 3_600_000) / 60_000);
  const ss = Math.floor((millis % 60_000) / 1000);
  const ms = millis % 1000;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function segmentsToVtt(segments) {
  const cues = segments.map((segment, index) => {
    const end = Math.max(segment.end, segment.start + 0.001);
    return `${index + 1}\n${timestamp(segment.start)} --> ${timestamp(end)}\n${segment.text}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

export function segmentsToText(segments) {
  return segments
    .map((segment) => `[${timestamp(segment.start)} --> ${timestamp(segment.end)}] ${segment.text}`)
    .join("\n") + "\n";
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function probeAudio(path) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration,size,format_name:stream=codec_name,codec_type,sample_rate,channels",
      "-of", "json",
      path,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    throw new Error(`ffprobe 실패: ${error.stderr || error.message}`);
  }

  const data = JSON.parse(stdout);
  const stream = data.streams?.find((item) => item.codec_type === "audio");
  if (!stream) throw new Error("오디오 스트림을 찾지 못했습니다");
  return {
    codec: stream.codec_name,
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    durationSeconds: Number(data.format?.duration),
    sizeBytes: Number(data.format?.size),
    format: data.format?.format_name,
  };
}

async function fixturePath(directory, relativePath) {
  if (!relativePath || isAbsolute(relativePath)) throw new Error(`잘못된 fixture 경로: ${relativePath}`);
  const root = await realpath(resolve(directory));
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`fixture 밖을 가리키는 경로: ${relativePath}`);
  const fileStat = await lstat(path);
  if (fileStat.isSymbolicLink()) throw new Error(`fixture 파일은 심볼릭 링크일 수 없습니다: ${relativePath}`);
  const canonical = await realpath(path);
  if (!canonical.startsWith(`${root}${sep}`)) throw new Error(`fixture 밖을 가리키는 경로: ${relativePath}`);
  return { path: canonical, stat: fileStat };
}

export async function verifyFixture(directory) {
  const root = await realpath(resolve(directory));
  const { path: manifestPath, stat: manifestStat } = await fixturePath(root, "manifest.json");
  if (manifestStat.size > 1024 * 1024) throw new Error("manifest.json 크기가 제한을 넘습니다");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1) throw new Error(`지원하지 않는 schemaVersion: ${manifest.schemaVersion}`);
  const kind = manifest.capture?.kind || "media";
  if (kind !== "media" && kind !== "transcript") {
    throw new Error(`지원하지 않는 fixture 종류: ${kind}`);
  }
  const ytDlp = manifest.capture?.tools?.ytDlp;
  if (!ytDlp?.configIgnored || ytDlp.plugins !== false || ytDlp.remoteComponents !== false) {
    throw new Error("안전한 yt-dlp 설정으로 만든 fixture가 아닙니다");
  }

  const requiredFiles = kind === "transcript"
    ? ["captions", "transcript", "text", "vtt"]
    : ["audio", "captions", "transcript", "text", "vtt"];
  for (const name of requiredFiles) {
    const entry = manifest.files?.[name];
    if (!entry) throw new Error(`manifest.files.${name} 누락`);
    const { path, stat: fileStat } = await fixturePath(root, entry.path);
    const maxBytes = name === "audio" ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
    if (fileStat.size > maxBytes) throw new Error(`${entry.path} 크기가 제한을 넘습니다`);
    const actual = await sha256File(path);
    if (actual !== entry.sha256) throw new Error(`${entry.path} SHA-256 불일치`);
    if (fileStat.size !== entry.sizeBytes) throw new Error(`${entry.path} 크기 불일치`);
  }

  const { path: transcriptPath } = await fixturePath(root, manifest.files.transcript.path);
  const { path: captionsPath } = await fixturePath(root, manifest.files.captions.path);
  const transcript = JSON.parse(await readFile(transcriptPath, "utf8"));
  const captions = JSON.parse(await readFile(captionsPath, "utf8"));
  const rawSegments = json3ToSegments(captions);
  const expected = validateSegments(kind === "transcript"
    ? rawSegments
    : clipSegments(rawSegments, manifest.capture.seconds));

  if (JSON.stringify(transcript.segments) !== JSON.stringify(expected)) {
    throw new Error("transcript.json이 원본 JSON3 자막과 일치하지 않습니다");
  }
  if (!expected.length) throw new Error("검증할 자막 세그먼트가 없습니다");
  if (transcript.videoId !== manifest.source.videoId || transcript.lang !== manifest.capture.language) {
    throw new Error("transcript.json 메타데이터가 manifest와 일치하지 않습니다");
  }

  const { path: textPath } = await fixturePath(root, manifest.files.text.path);
  const { path: vttPath } = await fixturePath(root, manifest.files.vtt.path);
  if (await readFile(textPath, "utf8") !== segmentsToText(expected)) {
    throw new Error("transcript.txt가 transcript.json과 일치하지 않습니다");
  }
  if (await readFile(vttPath, "utf8") !== segmentsToVtt(expected)) {
    throw new Error("transcript.vtt가 transcript.json과 일치하지 않습니다");
  }

  let audio = null;
  if (kind === "media") {
    const { path: audioPath } = await fixturePath(root, manifest.files.audio.path);
    audio = await probeAudio(audioPath);
    if (audio.codec !== "opus" || !String(audio.format).includes("webm")) {
      throw new Error(`오디오는 WebM/Opus여야 합니다 (현재 ${audio.format}/${audio.codec})`);
    }
    if (!(audio.durationSeconds > 0)) throw new Error("오디오 길이가 0초입니다");
    const sourceDuration = Number(manifest.source.durationSeconds);
    const requested = Number(manifest.capture.seconds);
    const expectedDuration = Number.isFinite(sourceDuration) && sourceDuration > 0
      ? Math.min(requested, sourceDuration)
      : requested;
    if (!Number.isFinite(expectedDuration) || Math.abs(audio.durationSeconds - expectedDuration) > 2) {
      throw new Error(`오디오 길이가 요청과 다릅니다 (${audio.durationSeconds}/${expectedDuration}초)`);
    }
    if (manifest.files.audio.codec !== audio.codec ||
        Math.abs(manifest.files.audio.durationSeconds - audio.durationSeconds) > 0.05) {
      throw new Error("manifest의 오디오 정보가 실제 파일과 일치하지 않습니다");
    }
  }

  return {
    directory: root,
    kind,
    videoId: manifest.source.videoId,
    title: manifest.source.title,
    language: manifest.capture.language,
    subtitleKind: manifest.capture.subtitleKind,
    segments: expected.length,
    audio,
  };
}
