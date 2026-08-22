#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  clipSegments,
  json3ToSegments,
  probeAudio,
  segmentsToText,
  segmentsToVtt,
  sha256File,
  validateSegments,
  verifyFixture,
} from "./youtube-fixture-lib.mjs";

const usage = `사용법:
  npm run fixture:capture -- <YouTube URL> [--lang en] [--seconds 45]
  npm run fixture:transcript -- <YouTube URL> [--lang en]

환경변수:
  YT_DLP_BIN  사용할 yt-dlp 실행 파일 (기본: .local/bin/yt-dlp 또는 PATH의 yt-dlp)`;

function parseArgs(argv) {
  const options = {
    language: "en",
    seconds: 45,
    secondsSpecified: false,
    transcriptOnly: false,
    url: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--lang") options.language = argv[++index];
    else if (arg === "--seconds") {
      options.seconds = Number(argv[++index]);
      options.secondsSpecified = true;
    } else if (arg === "--transcript-only") options.transcriptOnly = true;
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 옵션: ${arg}`);
    else if (!options.url) options.url = arg;
    else throw new Error(`예상하지 못한 인자: ${arg}`);
  }
  return options;
}

function validateOptions(options) {
  if (!options.url) throw new Error("YouTube URL이 필요합니다");
  let url;
  try { url = new URL(options.url); } catch { throw new Error("올바른 URL이 아닙니다"); }
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  if (url.protocol !== "https:" || url.username || url.password ||
      (host !== "youtube.com" && host !== "youtu.be")) {
    throw new Error("공개 HTTPS YouTube URL만 사용할 수 있습니다");
  }
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(options.language || "")) {
    throw new Error("--lang에는 en, en-orig, zh-Hans 같은 정확한 언어 코드 하나를 넣으세요");
  }
  if (options.transcriptOnly && options.secondsSpecified) {
    throw new Error("자막 전용 수집은 전체 자막을 저장하므로 --seconds를 사용할 수 없습니다");
  }
  if (!Number.isFinite(options.seconds) || options.seconds < 1 || options.seconds > 300) {
    throw new Error("--seconds는 1~300 사이여야 합니다");
  }
  options.url = url.toString();
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function selectYtDlp() {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;
  const local = resolve(".local/bin/yt-dlp");
  return (await executable(local)) ? local : "yt-dlp";
}

let activeChild = null;

function run(command, args, { stream = false, timeoutMs = 60_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stream) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (activeChild === child) activeChild = null;
      reject(new Error(`${command} 실행 실패: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (activeChild === child) activeChild = null;
      if (timedOut) {
        const error = new Error(`${basename(command)} 시간 초과 (${timeoutMs}ms)`);
        error.stderr = stderr;
        reject(error);
      } else if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const error = new Error(`${basename(command)} 종료 코드 ${code}`);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function commandWorks(command, args = ["--version"]) {
  try {
    await run(command, args);
    return true;
  } catch {
    return false;
  }
}

async function fileDescriptor(directory, path, extra = {}) {
  const fullPath = join(directory, path);
  const fileStat = await stat(fullPath);
  return {
    path,
    sizeBytes: fileStat.size,
    sha256: await sha256File(fullPath),
    ...extra,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
      return;
    }
    validateOptions(options);
  } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    process.exitCode = 2;
    return;
  }

  const ytDlp = await selectYtDlp();
  if (!(await commandWorks(ytDlp))) throw new Error(`yt-dlp를 찾지 못했습니다: ${ytDlp}`);
  if (!options.transcriptOnly &&
      (!(await commandWorks("ffmpeg", ["-version"])) || !(await commandWorks("ffprobe", ["-version"])))) {
    throw new Error("ffmpeg와 ffprobe가 필요합니다");
  }
  const ytDlpVersion = (await run(ytDlp, ["--version"])).stdout.trim();
  const ytDlpHelp = (await run(ytDlp, ["--help"])).stdout;
  for (const option of ["--ignore-config", "--no-plugin-dirs", "--no-cache-dir", "--no-remote-components", "--js-runtimes"]) {
    if (!ytDlpHelp.includes(option)) {
      throw new Error(`현재 yt-dlp는 ${option}을 지원하지 않습니다. 최신 버전으로 갱신하세요.`);
    }
  }
  const hasDeno = await commandWorks("deno");
  const jsRuntime = hasDeno ? "deno" : `node:${process.execPath}`;
  const jsRuntimeVersion = hasDeno
    ? (await run("deno", ["--version"])).stdout.split("\n")[0]
    : process.version;
  const ffmpegVersion = options.transcriptOnly
    ? null
    : (await run("ffmpeg", ["-version"])).stdout.split("\n")[0];
  const ffprobeVersion = options.transcriptOnly
    ? null
    : (await run("ffprobe", ["-version"])).stdout.split("\n")[0];
  const safeYtDlpArgs = [
    "--ignore-config",
    "--no-plugin-dirs",
    "--no-cache-dir",
    "--no-remote-components",
    "--no-playlist",
    "--js-runtimes", jsRuntime,
  ];

  let info;
  try {
    const result = await run(ytDlp, [
      ...safeYtDlpArgs,
      "--dump-single-json",
      "--skip-download",
      "--no-warnings",
      options.url,
    ]);
    info = JSON.parse(result.stdout);
  } catch (error) {
    const detail = String(error.stderr || "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`YouTube metadata 확인 실패: ${error.message}${detail ? `\n${detail}` : ""}`);
  }
  if (!/^[\w-]+$/.test(info.id || "")) throw new Error("안전한 YouTube video ID를 찾지 못했습니다");

  const output = resolve(options.transcriptOnly ? ".local/youtube-transcripts" : ".local/youtube");
  const destination = join(output, info.id);
  try {
    await access(destination);
    throw new Error(`이미 fixture가 있습니다: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, ".capture-"));
  let complete = false;
  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    activeChild?.kill("SIGTERM");
    rm(temporary, { recursive: true, force: true }).finally(() => process.exit(code));
  };
  const onSigint = () => stop(130);
  const onSigterm = () => stop(143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const scope = options.transcriptOnly ? "전체 자막 (오디오 없음)" : `처음 ${options.seconds}초`;
    console.log(`yt-dlp ${ytDlpVersion} · ${options.language} 자막 · ${scope}`);
    try {
      await run(ytDlp, [
        ...safeYtDlpArgs,
        "--quiet",
        "--progress",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", options.language,
        "--sub-format", "json3",
        ...(options.transcriptOnly
          ? ["--skip-download"]
          : [
              "--format", "bestaudio[ext=webm]/bestaudio",
              "--download-sections", `*0-${options.seconds}`,
            ]),
        "--output", join(temporary, "source.%(ext)s"),
        options.url,
      ], { stream: true, timeoutMs: 15 * 60_000 });
    } catch (error) {
      const hint = /403|older than 90 days/i.test(error.stderr || "")
        ? "\n현재 yt-dlp가 오래됐거나 YouTube 요청 방식이 바뀌었습니다. `brew upgrade yt-dlp` 후 재시도하거나 YT_DLP_BIN으로 최신 실행 파일을 지정하세요."
        : "";
      const detail = String(error.stderr || error.message).trim().split("\n").slice(-6).join("\n");
      throw new Error(`YouTube fixture 수집 실패.${hint}${detail ? `\n${detail}` : ""}`);
    }

    const names = await readdir(temporary);
    const captionName = `source.${options.language}.json3`;
    const audioNames = names.filter((name) => /^source\.(webm|m4a|mp3|ogg|opus|wav|aac|flac)$/i.test(name));
    if (!names.includes(captionName)) throw new Error(`${options.language} JSON3 자막이 없습니다. 먼저 yt-dlp --list-subs로 언어를 확인하세요.`);
    if (!options.transcriptOnly && audioNames.length !== 1) {
      throw new Error(`오디오 파일을 하나로 결정할 수 없습니다: ${audioNames.join(", ") || "없음"}`);
    }

    const captionsPath = `captions.${options.language}.json3`;
    await rename(join(temporary, captionName), join(temporary, captionsPath));
    if (!options.transcriptOnly) {
      const sourceAudio = join(temporary, audioNames[0]);
      if ((await stat(sourceAudio)).size > 20 * 1024 * 1024) {
        throw new Error("수집된 오디오가 Worker 제한(20 MiB)을 넘습니다");
      }
      const sourceProbe = await probeAudio(sourceAudio);
      if (sourceProbe.codec === "opus" && String(sourceProbe.format).includes("webm")) {
        await rename(sourceAudio, join(temporary, "audio.webm"));
      } else {
        await run("ffmpeg", [
          "-v", "error", "-y", "-i", sourceAudio,
          "-map", "0:a:0", "-c:a", "libopus", "-b:a", "64k",
          join(temporary, "audio.webm"),
        ], { timeoutMs: 5 * 60_000 });
        await unlink(sourceAudio);
      }
    }

    const captions = JSON.parse(await readFile(join(temporary, captionsPath), "utf8"));
    const rawSegments = json3ToSegments(captions);
    const segments = validateSegments(
      options.transcriptOnly ? rawSegments : clipSegments(rawSegments, options.seconds),
    );
    if (!segments.length) {
      throw new Error(options.transcriptOnly
        ? "수집된 자막에 텍스트 세그먼트가 없습니다"
        : `처음 ${options.seconds}초 안에 자막이 없습니다`);
    }

    const transcript = {
      videoId: info.id,
      lang: options.language,
      target: "Korean",
      mode: "full",
      segments,
    };
    await writeFile(join(temporary, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`);
    await writeFile(join(temporary, "transcript.txt"), segmentsToText(segments));
    await writeFile(join(temporary, "transcript.vtt"), segmentsToVtt(segments));

    const audio = options.transcriptOnly ? null : await probeAudio(join(temporary, "audio.webm"));
    if (audio && (audio.codec !== "opus" || !String(audio.format).includes("webm"))) {
      throw new Error(`수집된 오디오가 WebM/Opus가 아닙니다: ${audio.format}/${audio.codec}`);
    }

    const subtitleKind = info.subtitles?.[options.language]?.length
      ? "manual"
      : info.automatic_captions?.[options.language]?.length
        ? "automatic"
        : "unknown";
    const manifest = {
      schemaVersion: 1,
      source: {
        videoId: info.id,
        url: `https://www.youtube.com/watch?v=${info.id}`,
        title: info.title,
        channel: info.channel || info.uploader || null,
        durationSeconds: info.duration,
      },
      capture: {
        kind: options.transcriptOnly ? "transcript" : "media",
        createdAt: new Date().toISOString(),
        language: options.language,
        subtitleKind,
        seconds: options.transcriptOnly ? null : options.seconds,
        tools: {
          ytDlp: { version: ytDlpVersion, configIgnored: true, plugins: false, remoteComponents: false },
          ...(options.transcriptOnly ? {} : { ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion }),
          javascriptRuntime: { name: hasDeno ? "deno" : "node", version: jsRuntimeVersion },
        },
      },
      files: {
        ...(audio ? {
          audio: await fileDescriptor(temporary, "audio.webm", {
            mimeType: "audio/webm; codecs=opus",
            durationSeconds: audio.durationSeconds,
            codec: audio.codec,
          }),
        } : {}),
        captions: await fileDescriptor(temporary, captionsPath),
        transcript: await fileDescriptor(temporary, "transcript.json"),
        text: await fileDescriptor(temporary, "transcript.txt"),
        vtt: await fileDescriptor(temporary, "transcript.vtt"),
      },
    };
    await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    await verifyFixture(temporary);
    await rename(temporary, destination);
    complete = true;

    console.log(`\n${options.transcriptOnly ? "자막 fixture" : "fixture"} 생성 완료: ${destination}`);
    console.log(`- 자막 ${segments.length}개 (${subtitleKind})`);
    if (audio) {
      console.log(`- 오디오 ${audio.durationSeconds.toFixed(2)}초 / ${(audio.sizeBytes / 1024).toFixed(1)} KiB / WebM Opus`);
    } else {
      console.log("- 오디오 없음 (전체 자막 전용)");
    }
    console.log(`- 재검증: npm run fixture:check -- ${destination}`);
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (!complete && !stopping) await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
});
