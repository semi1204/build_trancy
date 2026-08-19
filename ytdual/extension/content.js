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
  asr: null,      // 전사 모드 세션 (자막 트랙 없는 영상)
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
  // 2024년부터 pot(PoToken) 없는 요청에 200 + 빈 본문을 주는 경우가 있다
  const body = await res.text();
  if (!body.trim()) return [];
  const data = JSON.parse(body);

  return (data.events || [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
      text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

/** timedtext 가 막혔을 때: 유튜브 자체 스크립트 패널을 열어 DOM 에서 긁는다.
 *  (get_transcript API 는 2026 현재 protobuf 전용 get_panel 로 바뀌어 재현 불가.
 *   패널은 잠깐 열렸다 닫힌다. 데스크톱 전용 — 모바일은 전사 모드로 넘어간다.) */
function parseTimestamp(t) {
  const p = t.trim().split(":").map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
}

async function scrapeTranscriptPanel() {
  const wasOpen = !!$("transcript-segment-view-model, ytd-transcript-segment-renderer");
  if (!wasOpen) {
    const expand = $("tp-yt-paper-button#expand, #description-inline-expander #expand");
    if (expand) { expand.click(); await new Promise((r) => setTimeout(r, 500)); }
    const btn = $("ytd-video-description-transcript-section-renderer button");
    if (!btn) return [];                   // 자막 없는 영상엔 버튼 자체가 없다
    btn.click();
  }

  let nodes = [];
  for (let i = 0; i < 40 && !nodes.length; i++) {
    await new Promise((r) => setTimeout(r, 250));
    nodes = [...document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer")];
  }

  const video = $("video");
  const dur = video && isFinite(video.duration) ? video.duration : null;
  const segments = [];
  for (const n of nodes) {
    const tsEl = n.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp");
    const txtEl = n.querySelector("span.ytAttributedStringHost, .segment-text, yt-formatted-string.segment-text");
    if (!tsEl || !txtEl) continue;
    const start = parseTimestamp(tsEl.textContent);
    const text = txtEl.textContent.replace(/\s+/g, " ").trim();
    if (start == null || !text) continue;
    segments.push({ start, end: 0, text });
  }
  for (let i = 0; i < segments.length; i++) {
    segments[i].end = i + 1 < segments.length ? segments[i + 1].start : dur || segments[i].start + 8;
  }

  if (!wasOpen) {
    $('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] #visibility-button button')?.click();
  }
  return segments;
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

// ── 전사 모드 (자막 트랙 없는 영상 → Worker → Groq Whisper) ──────────
const ASR_CHUNK_MS = 45000;

// 요소당 MediaElementSource 는 1개만 만들 수 있고, 한 번 만들면 오디오가
// 영구히 이 컨텍스트를 경유한다. ctx 를 닫으면 영상이 무음이 되므로
// 절대 닫지 말고 재사용한다.
const audioTaps = new WeakMap();
function tapAudio(video) {
  let t = audioTaps.get(video);
  if (!t) {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    src.connect(ctx.destination);          // 소리는 계속 스피커로
    t = { ctx, src };
    audioTaps.set(video, t);
  }
  if (t.ctx.state === "suspended") t.ctx.resume().catch(() => {});
  return t;
}

async function transcribeChunk(blob, chunkStart, rate) {
  const form = new FormData();
  form.append("file", blob, "chunk.webm");
  if (/^[a-z]{2}$/.test(cfg.prefer)) form.append("language", cfg.prefer);
  const res = await fetch(`${cfg.endpoint}/api/transcribe`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`전사 ${res.status}`);
  const { segments } = await res.json();
  return (segments || []).map((s) => ({
    start: chunkStart + s.start * rate,
    end: chunkStart + s.end * rate,
    text: s.text,
  }));
}

async function appendAsrLines(segments) {
  if (!segments.length) return;
  let lines;
  try {
    lines = await requestTranslation(`${state.videoId}#asr`, cfg.prefer || "auto", segments);
  } catch (e) {
    log("전사분 번역 실패, 원문만 표시", e.message);
    lines = segments.map((s) => ({ start: s.start, end: s.end, orig: s.text, trans: "" }));
  }
  state.lines = state.lines.concat(lines).sort((a, b) => a.start - b.start);
  state.idx = -2;                          // 다음 render 에서 다시 그리게
}

function startAsr() {
  const video = $("video");
  if (!video) { showStatus("영상 요소를 찾지 못했습니다"); return; }
  if (!window.MediaRecorder || !window.AudioContext) {
    showStatus("이 브라우저는 전사 모드를 지원하지 않습니다");
    return;
  }

  const tap = tapAudio(video);
  const dest = tap.ctx.createMediaStreamDestination();
  tap.src.connect(dest);

  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
      ? "audio/ogg;codecs=opus"
      : "";

  const a = (state.asr = { tap, dest, recorder: null, timer: null });

  // 청크마다 recorder 를 새로 만든다 — timeslice 조각과 달리 각 파일이 독립 재생 가능해야 Whisper 가 받는다
  const cycle = () => {
    if (state.asr !== a) return;
    const rec = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
    a.recorder = rec;
    const chunkStart = video.currentTime;
    const rate = video.playbackRate;
    rec.addEventListener("dataavailable", async (e) => {
      if (state.asr !== a || e.data.size < 2000) return;   // 중지됐거나 무음 청크
      try {
        await appendAsrLines(await transcribeChunk(e.data, chunkStart, rate));
      } catch (err) {
        log("전사 실패", err.message);
      }
    });
    rec.start();
    a.timer = setTimeout(rotate, ASR_CHUNK_MS);
  };
  const rotate = () => {
    if (state.asr !== a) return;
    clearTimeout(a.timer);
    if (a.recorder && a.recorder.state !== "inactive") a.recorder.stop();
    cycle();
  };

  // 일시정지 중 무음이 녹음되지 않게, 탐색하면 청크를 끊어 타임스탬프를 지키게
  video.addEventListener("pause", (a.onPause = () => {
    if (a.recorder?.state === "recording") a.recorder.pause();
  }));
  video.addEventListener("play", (a.onPlay = () => {
    if (tap.ctx.state === "suspended") tap.ctx.resume().catch(() => {});
    if (a.recorder?.state === "paused") a.recorder.resume();
  }));
  video.addEventListener("seeked", (a.onSeek = rotate));
  video.addEventListener("ended", (a.onEnded = rotate));   // 마지막 부분 청크 즉시 전사
  a.video = video;

  showStatus("자막 트랙 없음 → Whisper 전사 모드. 재생하면 자막이 따라옵니다");
  if (!state.rafId) loop();
  cycle();
}

function stopAsr() {
  const a = state.asr;
  if (!a) return;
  state.asr = null;                        // dataavailable 가드가 이걸 본다
  clearTimeout(a.timer);
  if (a.recorder && a.recorder.state !== "inactive") a.recorder.stop();
  a.video?.removeEventListener("pause", a.onPause);
  a.video?.removeEventListener("play", a.onPlay);
  a.video?.removeEventListener("seeked", a.onSeek);
  a.video?.removeEventListener("ended", a.onEnded);
  try { a.tap.src.disconnect(a.dest); } catch {}   // 스피커 연결은 유지
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

  // 플레이어 크기 변화(시어터 모드, 창 조절)를 따라가게 — rAF 루프가 안 도는
  // 상태 메시지 화면에서도 위치가 갱신되도록 video 를 직접 관찰한다
  const video = $("video");
  if (video && window.ResizeObserver) {
    new ResizeObserver(positionOverlay).observe(video);
  }
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
    let segments = [];
    if (track) {
      showStatus("자막 불러오는 중", true);
      segments = await fetchSegments(track).catch((e) => (log("timedtext 실패", e.message), []));
      if (!segments.length) {
        log("timedtext 빈 응답 → 스크립트 패널에서 수집");
        segments = await scrapeTranscriptPanel().catch((e) => (log("패널 수집 실패", e.message), []));
      }
    }
    // 트랙이 없거나 두 경로 모두 막힘 → Whisper 전사 모드
    if (!segments.length) { startAsr(); return; }

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
  stopAsr();
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
