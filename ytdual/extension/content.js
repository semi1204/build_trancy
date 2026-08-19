/* YT Dual — content script v2
 *
 *   1. watch 페이지를 same-origin fetch → ytInitialPlayerResponse 추출
 *   2. captionTracks → json3 자막 수신
 *   3. Worker 에 보내 문장 재분할 + 번역 (Worker 가 캐싱)
 *   4. <video> 위 오버레이 렌더
 *   5. 자막 단어를 탭하면 문장 카드로 저장 → Worker 큐 → PC 에서 Anki 로
 *
 * 유튜브 DOM 의존은 querySelector('video') 하나뿐입니다.
 */

const DEFAULTS = {
  endpoint: "https://sub.example.workers.dev",
  target: "Korean",
  prefer: "en",
  fontSize: 22,
  showOriginal: true,
  showTranslation: true,
  autoStart: true,
  uid: "",
};

let cfg = { ...DEFAULTS };
let state = {
  videoId: null,
  title: "",
  lines: [],
  idx: -1,
  active: false,
  loop: false,
  rafId: null,
  queue: [],      // 아직 Worker 로 못 보낸 카드
  flushing: false,
};

const $ = (s, r = document) => r.querySelector(s);
const log = (...a) => console.log("[YT Dual]", ...a);

async function loadConfig() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...stored };
  cfg.endpoint = cfg.endpoint.replace(/\/+$/, "");
  if (!cfg.uid) {
    cfg.uid = crypto.randomUUID();
    await browser.storage.local.set({ uid: cfg.uid });
  }
}

// ── 1. 플레이어 데이터 ───────────────────────────────────────────────
function sliceBalancedJSON(src, openIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return null;
}

async function fetchPlayerResponse(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`watch 페이지 ${res.status}`);
  const html = await res.text();

  const marker = html.indexOf("ytInitialPlayerResponse");
  if (marker === -1) throw new Error("플레이어 데이터를 찾지 못했습니다");
  const raw = sliceBalancedJSON(html, html.indexOf("{", marker));
  if (!raw) throw new Error("플레이어 데이터 파싱 실패");
  return JSON.parse(raw);
}

// ── 2. 자막 트랙 ─────────────────────────────────────────────────────
function pickTrack(player) {
  const tracks =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return null;
  const score = (t) =>
    (cfg.prefer && t.languageCode?.startsWith(cfg.prefer) ? 2 : 0) +
    (t.kind === "asr" ? 0 : 1);
  return tracks.slice().sort((a, b) => score(b) - score(a))[0];
}

async function fetchSegments(track) {
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  const res = await fetch(url.toString(), { credentials: "include" });
  if (!res.ok) throw new Error(`자막 트랙 ${res.status}`);
  const data = await res.json();

  return (data.events || [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
      text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

// ── 3. Worker ────────────────────────────────────────────────────────
async function requestTranslation(videoId, lang, segments) {
  const res = await fetch(`${cfg.endpoint}/api/subtitle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, lang, target: cfg.target, segments }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`서버 ${res.status} ${detail.slice(0, 120)}`);
  }
  const { lines } = await res.json();
  if (!Array.isArray(lines) || !lines.length) throw new Error("빈 응답");
  return lines;
}

// ── 카드 저장 ────────────────────────────────────────────────────────
async function flushQueue() {
  if (state.flushing || !state.queue.length) return;
  state.flushing = true;
  const batch = state.queue.splice(0, state.queue.length);

  try {
    const res = await fetch(`${cfg.endpoint}/api/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: cfg.uid, cards: batch }),
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch (e) {
    state.queue.unshift(...batch);   // 실패하면 되돌려서 다음에 재시도
    log("카드 전송 실패, 큐에 보관", e.message);
  } finally {
    state.flushing = false;
  }
}

function saveCard(word) {
  const line = state.lines[state.idx];
  if (!line) return;
  const video = $("video");

  state.queue.push({
    id: `${state.videoId}-${line.start.toFixed(2)}-${word}`,
    word,
    sentence: line.orig,
    translation: line.trans,
    videoId: state.videoId,
    title: state.title,
    start: video ? Math.max(0, line.start) : line.start,
  });

  toast(`저장: ${word}`);
  flushQueue();
}

let toastTimer = null;
function toast(msg) {
  let t = $("#ytdual-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "ytdual-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1200);
}

// ── 4. 오버레이 ──────────────────────────────────────────────────────
function ensureOverlay() {
  let box = $("#ytdual-box");
  if (box) return box;
  box = document.createElement("div");
  box.id = "ytdual-box";
  box.innerHTML = `<div id="ytdual-orig"></div><div id="ytdual-trans"></div>`;

  // 단어 탭 → 카드 저장
  box.addEventListener("click", (e) => {
    const w = e.target.closest(".ytdual-w");
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    saveCard(w.dataset.word);
    w.classList.add("saved");
  });

  document.body.appendChild(box);
  return box;
}

function positionOverlay() {
  const video = $("video"), box = $("#ytdual-box");
  if (!video || !box) return;
  const r = video.getBoundingClientRect();
  if (!r.width) return;
  box.style.left = `${r.left}px`;
  box.style.width = `${r.width}px`;
  box.style.top = `${r.top + r.height - Math.max(90, r.height * 0.2)}px`;
  box.style.fontSize = `${cfg.fontSize}px`;
}

function findLine(t) {
  const L = state.lines;
  let lo = 0, hi = L.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].start <= t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 && t <= L[best].end + 0.3 ? best : -1;
}

/** 원문을 단어 단위 span 으로 쪼갠다 (탭해서 저장하려고) */
function renderWords(text) {
  const frag = document.createDocumentFragment();
  for (const tok of text.split(/(\s+)/)) {
    if (!tok) continue;
    if (/^\s+$/.test(tok)) { frag.append(tok); continue; }
    const clean = tok.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, "");
    if (!clean) { frag.append(tok); continue; }
    const span = document.createElement("span");
    span.className = "ytdual-w";
    span.dataset.word = clean;
    span.textContent = tok;
    frag.append(span);
  }
  return frag;
}

function render() {
  const video = $("video"), box = $("#ytdual-box");
  if (!video || !box) return;
  positionOverlay();

  if (state.loop && state.idx >= 0) {
    const cur = state.lines[state.idx];
    if (video.currentTime > cur.end) video.currentTime = cur.start;
  }

  const i = findLine(video.currentTime);
  if (i === state.idx) return;
  state.idx = i;

  const line = i >= 0 ? state.lines[i] : null;
  const orig = $("#ytdual-orig"), trans = $("#ytdual-trans");
  orig.textContent = "";
  if (line && cfg.showOriginal) orig.append(renderWords(line.orig));
  trans.textContent = line && cfg.showTranslation ? line.trans || "" : "";
  box.classList.toggle("empty", !line);
}

function loop() {
  render();
  state.rafId = requestAnimationFrame(loop);
}

function showStatus(msg, spin = false) {
  const box = ensureOverlay();
  box.classList.remove("empty");
  $("#ytdual-orig").textContent = spin ? `⏳ ${msg}` : msg;
  $("#ytdual-trans").textContent = "";
  positionOverlay();
}

// ── 실행 ─────────────────────────────────────────────────────────────
const currentVideoId = () => (location.href.match(/[?&]v=([\w-]{11})/) || [])[1] || null;

async function start() {
  const videoId = currentVideoId();
  if (!videoId) return;

  stop({ keepBox: true });
  state.videoId = videoId;
  state.active = true;

  try {
    showStatus("자막 트랙 확인 중", true);
    const player = await fetchPlayerResponse(videoId);
    state.title = player?.videoDetails?.title || document.title;

    const track = pickTrack(player);
    if (!track) { showStatus("이 영상에는 자막 트랙이 없습니다"); return; }

    showStatus("자막 불러오는 중", true);
    const segments = await fetchSegments(track);
    if (!segments.length) { showStatus("자막이 비어 있습니다"); return; }

    showStatus(`번역 중 (${segments.length}줄)`, true);
    state.lines = await requestTranslation(videoId, track.languageCode, segments);

    state.idx = -2;
    if (!state.rafId) loop();
    log(`준비 완료: ${state.lines.length}줄`);
  } catch (e) {
    console.error("[YT Dual]", e);
    showStatus(`오류: ${e.message}`);
    state.active = false;
  }
}

function stop({ keepBox = false } = {}) {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  Object.assign(state, { rafId: null, lines: [], idx: -1, loop: false, active: false });
  if (!keepBox) $("#ytdual-box")?.remove();
}

const toggle = () => (state.active ? stop() : start());

// ── 키보드 ───────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;

  if (e.altKey && e.code === "KeyT") { e.preventDefault(); toggle(); return; }
  if (!state.active) return;

  const video = $("video");
  switch (e.code) {
    case "KeyR":
      state.loop = !state.loop;
      $("#ytdual-box")?.classList.toggle("looping", state.loop);
      break;
    case "KeyS":                       // 현재 문장 통째로 저장
      if (state.idx >= 0) saveCard(state.lines[state.idx].orig.split(/\s+/)[0] || "—");
      break;
    case "KeyZ":
      cfg.showTranslation = !cfg.showTranslation;
      state.idx = -2;
      break;
    case "Equal":
      cfg.fontSize = Math.min(48, cfg.fontSize + 2);
      browser.storage.local.set({ fontSize: cfg.fontSize });
      break;
    case "Minus":
      cfg.fontSize = Math.max(12, cfg.fontSize - 2);
      browser.storage.local.set({ fontSize: cfg.fontSize });
      break;
    case "ArrowLeft":
      if (state.idx > 0 && video) video.currentTime = state.lines[state.idx - 1].start;
      break;
    case "ArrowRight":
      if (video && state.idx >= 0 && state.idx < state.lines.length - 1)
        video.currentTime = state.lines[state.idx + 1].start;
      break;
    default:
      return;
  }
  e.preventDefault();
});

function addButton() {
  if ($("#ytdual-btn")) return;
  const b = document.createElement("button");
  b.id = "ytdual-btn";
  b.textContent = "자막";
  b.addEventListener("click", toggle);
  document.body.appendChild(b);
}

// ── SPA 내비게이션 ───────────────────────────────────────────────────
let lastId = null;
function watchNavigation() {
  const id = currentVideoId();
  if (id === lastId) return;
  lastId = id;
  stop();
  if (id) {
    addButton();
    if (cfg.autoStart) start();
  }
}

(async function init() {
  await loadConfig();
  browser.storage.onChanged.addListener(async () => {
    await loadConfig();
    state.idx = -2;
  });

  window.addEventListener("yt-navigate-finish", watchNavigation);
  setInterval(watchNavigation, 700);
  setInterval(flushQueue, 8000);        // 실패분 주기적 재전송
  window.addEventListener("resize", positionOverlay);
  watchNavigation();
})();
