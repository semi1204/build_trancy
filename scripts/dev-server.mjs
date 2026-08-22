/* 브라우저 테스트 하네스용 개발 서버.
 *
 * 하는 일은 셋뿐이다:
 *   1. devtools/ 정적 파일과 ytdual/extension 의 실제 소스를 서빙한다
 *      (content.js·overlay.css 를 복사하지 않고 원본 그대로 준다 — 사본을 두면
 *       브라우저에서 본 동작과 출하물이 갈라진다)
 *   2. .local/youtube-transcripts 의 실제 자막을 JSON 으로 준다
 *   3. /api/* 를 워커(:8787)로 그대로 넘긴다 — 같은 출처가 되어 CORS·설정이 사라진다
 *
 * 주의: 인증이 없다. 로컬 테스트용이며 127.0.0.1 에만 바인딩한다.
 */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, normalize } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT || 8788);
const WORKER = process.env.YTDUAL_WORKER || "http://127.0.0.1:8787";
const FIXTURES = join(ROOT, ".local/youtube-transcripts");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** 저장소 안의 파일만 읽게 한다 (경로 탈출 차단) */
function safeJoin(base, rel) {
  const p = join(base, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  return p.startsWith(base) ? p : null;
}

const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

/** 서빙할 실제 소스. 복사본이 아니라 저장소의 그 파일이다. */
const STATIC = {
  "/": "devtools/index.html",
  "/index.html": "devtools/index.html",
  "/app.js": "devtools/app.js",
  "/app.css": "devtools/app.css",
  "/content.js": "ytdual/extension/content.js",
  "/overlay.css": "ytdual/extension/overlay.css",
};

async function listFixtures() {
  if (!existsSync(FIXTURES)) return [];
  const out = [];
  for (const id of (await readdir(FIXTURES)).sort()) {
    const mPath = join(FIXTURES, id, "manifest.json");
    if (!existsSync(mPath)) continue;
    const m = JSON.parse(await readFile(mPath, "utf8"));
    const t = JSON.parse(await readFile(join(FIXTURES, id, "transcript.json"), "utf8"));
    out.push({
      id,
      title: m.source.title,
      lang: m.capture.language,
      subtitleKind: m.capture.subtitleKind,
      durationSeconds: m.source.durationSeconds,
      count: t.segments.length,
    });
  }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    // ── 워커 프록시 ────────────────────────────────────────────────
    if (p.startsWith("/api/subtitle") || p.startsWith("/api/word")) {
      const body = await new Promise((ok, no) => {
        const bits = [];
        req.on("data", (c) => bits.push(c));
        req.on("end", () => ok(Buffer.concat(bits)));
        req.on("error", no);
      });
      const t0 = performance.now();
      try {
        const up = await fetch(`${WORKER}${p}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body: req.method === "POST" ? body : undefined,
          signal: AbortSignal.timeout(600_000),
        });
        const text = await up.text();
        res.writeHead(up.status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          // 브라우저가 서버 관측 지연도 볼 수 있게 (클라 측정과 대조용)
          "x-upstream-ms": String(Math.round(performance.now() - t0)),
        });
        return res.end(text);
      } catch (e) {
        return send(res, 502, JSON.stringify({
          error: `워커(${WORKER})에 닿지 못했습니다: ${e.message}`,
        }));
      }
    }

    if (p === "/api/health") {
      let worker = false;
      try {
        worker = (await fetch(`${WORKER}/`, { signal: AbortSignal.timeout(1500) })).ok;
      } catch { /* 꺼져 있음 */ }
      return send(res, 200, JSON.stringify({ worker, workerUrl: WORKER }));
    }

    if (p === "/api/fixtures") {
      return send(res, 200, JSON.stringify(await listFixtures()));
    }

    if (p.startsWith("/api/fixtures/")) {
      const id = decodeURIComponent(p.slice("/api/fixtures/".length));
      if (!/^[\w-]{1,64}$/.test(id)) return send(res, 400, JSON.stringify({ error: "잘못된 id" }));
      const f = join(FIXTURES, id, "transcript.json");
      if (!existsSync(f)) return send(res, 404, JSON.stringify({ error: "없는 fixture" }));
      const t = JSON.parse(await readFile(f, "utf8"));
      return send(res, 200, JSON.stringify({ id, segments: t.segments }));
    }

    // ── 정적 ──────────────────────────────────────────────────────
    const rel = STATIC[p];
    if (rel) {
      const file = safeJoin(ROOT, rel);
      if (!file || !existsSync(file)) return send(res, 404, "not found", "text/plain");
      const buf = await readFile(file);
      return send(res, 200, buf, MIME[extname(file)] || "application/octet-stream");
    }

    send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    send(res, 500, JSON.stringify({ error: String(e && e.message) }));
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  const fx = await listFixtures();
  console.log(`\n  YT Dual 테스트 하네스`);
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  워커   ${WORKER}`);
  console.log(`  자막   ${fx.length}개 fixture` + (fx.length ? "" : "  ⚠ .local/youtube-transcripts 없음"));
  console.log(`\n  워커가 꺼져 있으면: npm run dev  (다른 터미널)\n`);
});
