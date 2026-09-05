#!/usr/bin/env node
/* 자막 수집 라이브러리 비교 — Docker 컨테이너 5개가 같은 영상을 동시에 요청한다.
 *
 * 이것은 테스트가 아니라 측정이다. 네트워크 지연과 YouTube 차단 정책은 변동하므로
 * 성공/실패와 지연 수치를 기록하되 임계값으로 단정하지 않는다. 비flaky 계약은
 * test/transcript-benchmark.test.js와 --smoke에 둔다.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSegments } from "./youtube-fixture-lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BENCH_DIR = join(ROOT, "benchmarks/transcript-libraries");
const COMPOSE_FILE = join(BENCH_DIR, "compose.yaml");
const DEFAULT_CASES = join(BENCH_DIR, "cases.example.json");
const OUT_DIR = join(ROOT, ".local/bench");

const TOOLS = [
  { service: "jdepoix", label: "jdepoix/python" },
  { service: "kakulukian", label: "kakulukian/node" },
  { service: "ericmmartin", label: "ericmmartin/node" },
  { service: "trldvix", label: "trldvix/java" },
  { service: "yt-dlp", label: "yt-dlp" },
];

const usage = `사용법:
  npm run bench:transcript:smoke
  npm run bench:transcript -- [--cases=파일] [--repeat=3] [--timeout-ms=60000]
                              [--cooldown-ms=2000] [--skip-build]

--smoke는 YouTube에 접속하지 않고 5개 이미지와 어댑터 계약만 확인합니다.`;

function integerOption(name, raw, { min, max }) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}은 ${min}~${max} 사이 정수여야 합니다`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    casesPath: DEFAULT_CASES,
    repeat: 1,
    timeoutMs: 60_000,
    cooldownMs: 2_000,
    skipBuild: false,
    smoke: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--smoke") options.smoke = true;
    else if (arg.startsWith("--cases=")) options.casesPath = resolve(arg.slice(8));
    else if (arg.startsWith("--repeat=")) {
      options.repeat = integerOption("--repeat", arg.slice(9), { min: 1, max: 20 });
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = integerOption("--timeout-ms", arg.slice(13), { min: 1_000, max: 900_000 });
    } else if (arg.startsWith("--cooldown-ms=")) {
      options.cooldownMs = integerOption("--cooldown-ms", arg.slice(14), { min: 0, max: 60_000 });
    } else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return options;
}

export function validateCases(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("케이스 파일은 비어 있지 않은 배열이어야 합니다");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`케이스 ${index}가 객체가 아닙니다`);
    const videoId = String(item.videoId ?? "");
    const lang = String(item.lang ?? "");
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error(`케이스 ${index}의 videoId가 잘못됐습니다`);
    if (!/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/.test(lang)) throw new Error(`케이스 ${index}의 lang이 잘못됐습니다`);
    return { label: String(item.label || `${videoId}/${lang}`), videoId, lang };
  });
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function textHash(segments) {
  return createHash("sha256").update(segments.map((segment) => segment.text).join("\n")).digest("hex");
}

export function summarizeAdapterResult(result) {
  if (!result || result.schemaVersion !== 1 || typeof result.tool !== "string" || typeof result.ok !== "boolean") {
    throw new Error("어댑터 결과의 기본 계약이 잘못됐습니다");
  }
  if ((result.ok && (!Number.isFinite(result.libraryMs) || result.libraryMs < 0)) ||
      (!result.ok && result.libraryMs !== null && (!Number.isFinite(result.libraryMs) || result.libraryMs < 0))) {
    throw new Error("libraryMs가 잘못됐습니다");
  }

  const base = {
    tool: result.tool,
    toolVersion: String(result.toolVersion ?? ""),
    libraryMs: result.libraryMs,
  };
  if (!result.ok) {
    if (!result.error || typeof result.error.name !== "string" || typeof result.error.message !== "string") {
      throw new Error("실패 결과에 error가 없습니다");
    }
    return {
      ...base,
      status: "tool-error",
      error: `${result.error.name}: ${result.error.message}`.slice(0, 500),
    };
  }
  if (result.mode === "smoke") return { ...base, status: "ok" };
  if (!Array.isArray(result.segments)) throw new Error("성공 결과에 segments가 없습니다");

  validateSegments(result.segments);
  if (!result.segments.length) return { ...base, status: "empty", segmentCount: 0, characterCount: 0 };

  const characterCount = result.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  return {
    ...base,
    status: "ok",
    segmentCount: result.segments.length,
    characterCount,
    firstStart: result.segments[0].start,
    lastEnd: result.segments.at(-1).end,
    textSha256: textHash(result.segments),
    sample: result.segments.slice(0, 2).map((segment) => segment.text.slice(0, 160)),
  };
}

function runProcess(command, args, { input = null, timeoutMs = 60_000, inherit = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeoutMs);

    if (!inherit) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.end(input ?? "");
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

async function buildImages() {
  console.log("Docker 이미지 빌드 …");
  const result = await runProcess("docker", ["compose", "-f", COMPOSE_FILE, "build"], {
    timeoutMs: 20 * 60_000,
    inherit: true,
  });
  if (result.timedOut) throw new Error("Docker 이미지 빌드 시간 초과");
  if (result.code !== 0) throw new Error(`Docker 이미지 빌드 실패 (${result.code})`);
}

async function runTool(tool, request, timeoutMs) {
  const started = performance.now();
  let processResult;
  try {
    processResult = await runProcess("docker", [
      "compose", "-f", COMPOSE_FILE,
      "run", "--rm", "--no-deps", "-T", tool.service,
    ], { input: `${JSON.stringify(request)}\n`, timeoutMs });
  } catch (error) {
    return { service: tool.service, label: tool.label, status: "process-error", wallMs: Math.round(performance.now() - started), error: error.message };
  }

  const wallMs = Math.round(performance.now() - started);
  if (processResult.timedOut) {
    return { service: tool.service, label: tool.label, status: "timeout", wallMs, error: `${timeoutMs}ms 초과` };
  }
  if (processResult.code !== 0) {
    return {
      service: tool.service,
      label: tool.label,
      status: "process-error",
      wallMs,
      error: String(processResult.stderr || `종료 코드 ${processResult.code}`).trim().slice(-500),
    };
  }

  try {
    const output = JSON.parse(processResult.stdout.trim());
    return { service: tool.service, label: tool.label, wallMs, ...summarizeAdapterResult(output) };
  } catch (error) {
    return {
      service: tool.service,
      label: tool.label,
      status: "protocol-error",
      wallMs,
      error: `${error.message}; stdout=${processResult.stdout.trim().slice(0, 240)}`,
    };
  }
}

function pad(value, width) {
  return String(value ?? "-").padEnd(width);
}

function padLeft(value, width) {
  return String(value ?? "-").padStart(width);
}

function printRows(rows) {
  console.log(`  ${pad("도구", 24)} ${pad("상태", 14)} ${padLeft("내부ms", 8)} ${padLeft("전체ms", 8)} ${padLeft("조각", 7)}  상세`);
  for (const row of rows) {
    const mark = row.status === "ok" ? "·" : row.status === "empty" ? "!" : "✗";
    const detail = row.error || (row.status === "ok" ? `${row.characterCount ?? 0}자` : "자막 0개");
    console.log(`  ${mark} ${pad(row.label, 22)} ${pad(row.status, 14)} ${padLeft(row.libraryMs, 8)} ${padLeft(row.wallMs, 8)} ${padLeft(row.segmentCount, 7)}  ${detail}`);
  }
}

async function pause(ms) {
  if (ms > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function printSummary(results) {
  console.log("\n집계");
  console.log(`  ${pad("도구", 24)} ${padLeft("성공", 7)} ${padLeft("빈값", 6)} ${padLeft("실패", 6)} ${padLeft("내부중앙", 10)} ${padLeft("전체중앙", 10)}`);
  for (const tool of TOOLS) {
    const rows = results.filter((row) => row.service === tool.service);
    const ok = rows.filter((row) => row.status === "ok");
    const empty = rows.filter((row) => row.status === "empty").length;
    const failed = rows.length - ok.length - empty;
    console.log(`  ${pad(tool.label, 24)} ${padLeft(`${ok.length}/${rows.length}`, 7)} ${padLeft(empty, 6)} ${padLeft(failed, 6)} ${padLeft(median(ok.map((row) => row.libraryMs)), 10)} ${padLeft(median(ok.map((row) => row.wallMs)), 10)}`);
  }
}

async function smoke(options) {
  console.log("# 자막 라이브러리 어댑터 smoke\n");
  const rows = await Promise.all(TOOLS.map((tool) => runTool(tool, { mode: "smoke" }, options.timeoutMs)));
  printRows(rows);
  if (rows.some((row) => row.status !== "ok")) process.exitCode = 1;
}

async function benchmark(options) {
  const cases = validateCases(JSON.parse(await readFile(options.casesPath, "utf8")));
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const results = [];

  console.log(`# 자막 수집 라이브러리 벤치마크  run=${runId}`);
  console.log(`  cases=${relative(ROOT, options.casesPath)}  repeat=${options.repeat}  timeout=${options.timeoutMs}ms\n`);

  for (const item of cases) {
    for (let iteration = 1; iteration <= options.repeat; iteration++) {
      console.log(`${item.label} · ${item.videoId} · ${item.lang} · ${iteration}/${options.repeat}`);
      const rows = await Promise.all(TOOLS.map((tool) => runTool(tool, {
        mode: "live",
        videoId: item.videoId,
        lang: item.lang,
      }, options.timeoutMs)));
      const enriched = rows.map((row) => ({ ...row, case: item.label, videoId: item.videoId, lang: item.lang, iteration }));
      results.push(...enriched);
      printRows(enriched);
      console.log("");
      if (!(item === cases.at(-1) && iteration === options.repeat)) await pause(options.cooldownMs);
    }
  }

  printSummary(results);
  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `transcript-libraries-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, `${JSON.stringify({
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    config: {
      casesFile: relative(ROOT, options.casesPath),
      repeat: options.repeat,
      timeoutMs: options.timeoutMs,
      cooldownMs: options.cooldownMs,
    },
    cases,
    tools: TOOLS,
    results,
  }, null, 2)}\n`);
  console.log(`\n원시 기록 → ${outPath}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.skipBuild) await buildImages();
  if (options.smoke) await smoke(options);
  else await benchmark(options);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
