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
  origColor: "#ffffff",
  transColor: "#ffe27a",
  uid: "",
};

/**
 * @typedef {object} Segment  json3(또는 패널 수집)에서 나온 원문 조각 하나
 * @property {number} start  초
 * @property {number} end    초
 * @property {string} text
 */

/**
 * @typedef {object} Line  오버레이가 실제로 렌더하는 자막 한 줄
 * @property {number}  start  초
 * @property {number}  end    초
 * @property {string}  orig   원문
 * @property {string}  trans  번역문. raw 줄은 "" 이다
 * @property {boolean} [raw]  true = 아직 번역 전인 원문 자리표시자.
 *                            번역이 도착하면 이 줄들은 제거되고 번역 줄로 교체된다.
 */

/**
 * @typedef {object} Chunk  Worker 로 한 번에 보내는 번역 단위
 * @property {number}    i0    segments 배열에서의 시작 인덱스
 * @property {Segment[]} segs
 * @property {number}    t0    segs 첫 줄의 start — 번역본을 끼워 넣을 구간의 시작
 * @property {number}    t1    segs 마지막 줄의 end — 구간의 끝
 */

/**
 * @typedef {object} Perf  지연 측정값. 전부 performance.now() 기준 ms.
 * @property {number}   t0           start() 진입 시각
 * @property {number}   tPlayer      플레이어 데이터 확보까지
 * @property {number}   tSegs        원문 세그먼트 확보까지
 * @property {number}   tFirstPaint  원문 자막이 화면에 처음 뜨기까지
 * @property {number}   tFirstTrans  번역 자막이 화면에 처음 뜨기까지
 * @property {number[]} chunkMs      청크별 왕복 시간
 */

let cfg = { ...DEFAULTS };
let state = {
  videoId: null,
  title: "",
  /** @type {Line[]} start 오름차순. raw 줄과 번역 줄이 한 배열에 섞여 산다 */
  lines: [],
  idx: -1,
  active: false,
  loop: false,
  rafId: null,
  queue: [],      // 아직 Worker 로 못 보낸 카드
  flushing: false,
  asr: null,      // 전사 모드 세션 (자막 트랙 없는 영상)
  gen: 0,         // start() 세대 번호. 같은 영상을 재시작해도 지난 세대 응답을 가려낸다
  /** @type {AbortController|null} 이번 세대의 진행 중 요청들을 한 번에 끊는 손잡이 */
  abort: null,
  /** @type {Perf} */
  perf: { t0: 0, tPlayer: 0, tSegs: 0, tFirstPaint: 0, tFirstTrans: 0, chunkMs: [] },
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

/** 이미 로드된 문서의 <script> 에서 ytInitialPlayerResponse 를 읽는다.
 *  못 찾으면 null — 호출부가 fetchPlayerResponse() 로 폴백한다.
 *  @returns {object|null} */
function readPlayerResponseFromDOM() {
  throw new Error("not implemented");
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
async function requestTranslation(videoId, lang, segments, ctx = {}, signal = null) {
  // TODO(phase6): 요청 1회의 타임아웃을 건다. 내부에 AbortController 를 만들고 전달받은
  //   signal 의 "abort" 이벤트를 addEventListener 로 수동 연결한다. AbortSignal.any() 는
  //   Firefox 124+ 라 manifest 의 strict_min_version 115 에서 조용히 깨진다.
  //   타임아웃이 없으면 멈춘 업스트림 하나가 runner 슬롯을 영구 점유해 처리량이 반토막 난다 (불변식 10).
  for (let attempt = 0; ; attempt++) {
    try {
      // TODO(phase6): fetch 옵션에 signal 을 넘긴다.
      const res = await fetch(`${cfg.endpoint}/api/subtitle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId,
          lang,
          target: cfg.target,
          segments,
          ctxBefore: ctx.before || [],   // 청크 경계에서도 번역이 이어지게
          ctxAfter: ctx.after || [],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`서버 ${res.status} ${detail.slice(0, 120)}`);
      }
      const { lines } = await res.json();
      if (!Array.isArray(lines) || !lines.length) throw new Error("빈 응답");
      return lines;
    } catch (e) {
      if (attempt >= 1) throw e;           // 1회 재시도 후 포기
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
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
    lines = await requestTranslation(`${state.videoId}#asr`, cfg.prefer || "auto", segments, {
      before: state.lines.slice(-8).map((l) => l.orig),   // 직전 자막을 문맥으로
    });
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

// ── 단어 팝업 (클릭 → 문맥상 뜻 → 추가 액션으로 저장) ────────────────
let popEl = null;
let popResume = false;

function closeWordPop() {
  if (!popEl) return;
  popEl.remove();
  popEl = null;
  if (popResume) {
    $("video")?.play();
    popResume = false;
  }
}

async function openWordPop(wEl) {
  const word = wEl.dataset.word;
  const line = state.lines[state.idx];
  const sentence = line ? line.orig : "";
  closeWordPop();

  const video = $("video");
  if (video && !video.paused) { video.pause(); popResume = true; }   // 읽는 동안 정지

  popEl = document.createElement("div");
  popEl.id = "ytdual-pop";
  popEl.innerHTML = `
    <div id="ytdual-pop-word"></div>
    <div id="ytdual-pop-meaning">⏳ 뜻 찾는 중…</div>
    <div id="ytdual-pop-base"></div>
    <div id="ytdual-pop-actions">
      <button id="ytdual-pop-save">문장과 함께 저장</button>
      <button id="ytdual-pop-close">닫기</button>
    </div>`;
  popEl.querySelector("#ytdual-pop-word").textContent = word;
  popEl.addEventListener("click", (e) => e.stopPropagation());
  popEl.querySelector("#ytdual-pop-save").addEventListener("click", () => {
    saveCard(word);
    wEl.classList.add("saved");
    closeWordPop();
  });
  popEl.querySelector("#ytdual-pop-close").addEventListener("click", closeWordPop);
  document.body.appendChild(popEl);

  const place = () => {
    const r = wEl.getBoundingClientRect();
    popEl.style.left =
      Math.max(8, Math.min(window.innerWidth - popEl.offsetWidth - 8, r.left + r.width / 2 - popEl.offsetWidth / 2)) + "px";
    popEl.style.top = Math.max(8, r.top - popEl.offsetHeight - 10) + "px";
  };
  place();

  try {
    const res = await fetch(`${cfg.endpoint}/api/word`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word, sentence, target: cfg.target }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    if (!popEl) return;                    // 그 사이에 닫힘
    popEl.querySelector("#ytdual-pop-meaning").textContent = d.meaning || "—";
    popEl.querySelector("#ytdual-pop-base").textContent = d.base || "";
    place();                               // 내용이 늘었을 수 있으니 재배치
  } catch (e) {
    if (popEl) popEl.querySelector("#ytdual-pop-meaning").textContent = "사전 요청 실패";
  }
}

// 팝업 밖 클릭 → 닫기
document.addEventListener(
  "click",
  (e) => {
    if (popEl && !e.target.closest("#ytdual-pop") && !e.target.closest(".ytdual-w")) closeWordPop();
  },
  true
);

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
/** 설정된 자막 색을 CSS 변수로 반영 (overlay.css 가 읽는다) */
function applyColors() {
  const box = $("#ytdual-box");
  if (!box) return;
  box.style.setProperty("--ytdual-orig-color", cfg.origColor);
  box.style.setProperty("--ytdual-trans-color", cfg.transColor);
}

function ensureOverlay() {
  let box = $("#ytdual-box");
  if (box) return box;
  box = document.createElement("div");
  box.id = "ytdual-box";
  box.innerHTML = `<div id="ytdual-orig"></div><div id="ytdual-trans"></div>`;

  // 단어 탭 → 문맥상 뜻 팝업 (저장은 팝업 안의 버튼으로)
  box.addEventListener("click", (e) => {
    const w = e.target.closest(".ytdual-w");
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    openWordPop(w);
  });

  document.body.appendChild(box);

  // 플레이어 크기 변화(시어터 모드, 창 조절)를 따라가게 — rAF 루프가 안 도는
  // 상태 메시지 화면에서도 위치가 갱신되도록 video 를 직접 관찰한다
  const video = $("video");
  if (video && window.ResizeObserver) {
    new ResizeObserver(positionOverlay).observe(video);
  }
  applyColors();
  return box;
}

function positionOverlay() {
  const video = $("video"), box = $("#ytdual-box");
  if (!video || !box) return;
  const r = video.getBoundingClientRect();
  if (!r.width) return;
  // 네이티브 자막처럼: 평소엔 영상 맨 아래, 컨트롤(재생바)이 보이면 그 위로
  const player = document.getElementById("movie_player");
  const controlsVisible = player && !player.classList.contains("ytp-autohide");
  const lift = controlsVisible ? 72 : 14;
  box.style.left = `${r.left}px`;
  box.style.width = `${r.width}px`;
  box.style.top = `${r.top + r.height - lift - box.offsetHeight}px`;
  box.style.fontSize = `${cfg.fontSize}px`;
}

// ── state.lines 조립 ─────────────────────────────────────────────────

/** 번역 전 원문을 state.lines 에 자리표시자(raw)로 깔고 렌더를 시작한다.
 *  번역을 기다리는 동안 화면이 비어 있지 않게 하는 것이 유일한 목적이다.
 *  @param {Segment[]} segments
 *  @returns {void} */
function seedRawLines(segments) {
  // TODO(phase6): segments 를 { start, end, orig: text, trans: "", raw: true } 로 옮겨
  //   state.lines 에 넣고, state.idx 를 무효화한 뒤 loop() 를 시작한다.
  //   perf.tFirstPaint 를 여기서 기록한다 (계측 1단계).
  throw new Error("not implemented");
}

/** [t0, t1) 구간의 raw 줄을 걷어내고 번역 줄로 갈아끼운다. start 정렬을 유지한다.
 *  t0/t1 은 응답이 아니라 청크에서 온다 — 워커가 일부 줄을 버려도 구간 전체가
 *  확실히 교체되어야 raw 와 번역본이 같은 시각에 겹치지 않는다.
 *  @param {Line[]} lines  워커가 돌려준 번역 줄
 *  @param {number} t0     교체할 구간의 시작(초)
 *  @param {number} t1     교체할 구간의 끝(초)
 *  @returns {void} */
function mergeTranslated(lines, t0, t1) {
  // TODO(phase6): state.lines 에서 [t0, t1) 에 걸치는 raw 줄을 전부 제거하고 lines 를 넣은 뒤
  //   start 오름차순을 복구한다 (불변식 2·3). 이미 번역된 줄(raw 아님)은 건드리지 않는다.
  //   state.idx 를 무효화해 다음 render 가 다시 계산하게 한다.
  throw new Error("not implemented");
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
  // TODO(phase6): state.gen 을 1 올리고 그 값을 지역변수(myGen)로 잡는다. 아래 모든 응답을
  //   이 세대 번호로 검사해야 같은 영상을 정지 후 재시작했을 때 이전 요청의 응답이
  //   새 세션에 섞이지 않는다 (불변식 4).
  // TODO(phase6): state.abort = new AbortController() — 이 세대의 모든 fetch 에 물릴 신호.
  // TODO(phase6): state.perf 를 초기화하고 perf.t0 = performance.now() 기록 (계측 1단계).
  syncBar();

  try {
    showStatus("자막 트랙 확인 중", true);
    // TODO(phase6): readPlayerResponseFromDOM() 을 먼저 시도하고 null 일 때만
    //   fetchPlayerResponse(videoId) 로 폴백한다. 여기서 인라인으로 처리하고 래퍼 함수는
    //   만들지 않는다 (호출자가 하나뿐). 같은 페이지 HTML 을 네트워크로 다시 받는 낭비 제거.
    //   단 Phase 4 에서 perf.tPlayer 가 1초 미만이면 이 항목은 통째로 버린다.
    const player = await fetchPlayerResponse(videoId);
    // TODO(phase6): perf.tPlayer 기록 (계측 1단계).
    state.title = player?.videoDetails?.title || document.title;

    // 라이브는 완결된 자막 트랙이 없다 → 바로 Whisper 전사 모드
    if (player?.videoDetails?.isLive) { startAsr(); return; }

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

    // TODO(phase6): perf.tSegs 기록 (계측 1단계).
    // TODO(phase6): seedRawLines(segments) 호출 — 원문을 raw 줄로 즉시 깔고 렌더를 시작한다.
    //   "첫 자막까지 오래 걸린다"의 핵심 해결책이며, 이 시점 이후로는 화면에 자막이
    //   비어 있으면 안 된다 (불변식 1).

    // 긴 자막을 한 요청으로 보내면 응답까지 몇 분씩 걸려 연결이 끊긴다.
    // 작은 청크로 나눠, "지금 보고 있는 지점" 주변부터 우선 번역해 바로 띄우고
    // 나머지는 백그라운드로 채운다. 이웃 세그먼트는 문맥(CTX)으로 함께 보낸다.
    const TRANSLATE_CHUNK = 48;
    const CTX_N = 8;
    const chunks = [];
    for (let i = 0; i < segments.length; i += TRANSLATE_CHUNK) {
      // TODO(phase6): t0/t1 도 함께 넣는다 — t0 = 첫 seg 의 start, t1 = 마지막 seg 의 end.
      //   mergeTranslated 가 raw 를 걷어낼 구간의 권위 있는 경계다. 워커가 빈 줄을 버리므로
      //   응답에서 유도하면 구간이 좁아져 가장자리 raw 가 살아남는다 (불변식 3).
      chunks.push({ i0: i, segs: segments.slice(i, i + TRANSLATE_CHUNK) });
    }
    // 우선순위는 고정 순서가 아니라 "매 청크마다" 현재 재생바 위치로 다시
    // 고른다 — 시킹해도 다음 요청부터 그 지점이 최우선이 된다.
    const pending = new Set(chunks);
    const nextChunk = () => {
      const t = $("video")?.currentTime || 0;
      let best = null, bestScore = Infinity;
      for (const c of pending) {
        const s0 = c.segs[0].start, e0 = c.segs[c.segs.length - 1].end;
        const sc = t >= s0 - 5 && t <= e0 ? -1        // 지금 재생 중인 청크 최우선
          : s0 >= t ? s0 - t                          // 앞쪽은 가까운 순서
          : 1e6 + (t - s0);                           // 지나간 쪽은 맨 뒤
        if (sc < bestScore) { bestScore = sc; best = c; }
      }
      return best;
    };

    // TODO(phase6): 이 showStatus 를 제거한다. seedRawLines 이후에는 원문 자막이 이미 떠
    //   있는데 여기서 오버레이를 "⏳ 번역 중" 으로 덮어써 버린다 (불변식 1 위반).
    //   진행 상황을 알리려면 자막을 가리지 않는 수단(하단 바 라벨 등)을 쓴다.
    showStatus(`번역 중 (${segments.length}줄)`, true);
    // TODO(phase6): 실패 청크를 1회 한정으로 pending 에 되돌리기 위한 재시도 기록
    //   (Set<Chunk>)을 여기 둔다. 지금은 실패한 청크가 영구히 버려져 그 구간이 영영
    //   번역되지 않는다 — 사용자에겐 "느리다"로 보인다 (불변식 8).
    let done = 0, failed = 0;
    const runner = async () => {
      for (;;) {
        // TODO(phase6): 이 가드를 state.gen !== myGen 검사로 바꾼다. videoId 비교는
        //   같은 영상을 정지 후 재시작한 경우를 못 잡는다 (불변식 4).
        if (state.videoId !== videoId || !state.active) return;
        const c = nextChunk();
        if (!c) return;
        pending.delete(c);
        try {
          // TODO(phase6): 요청 직전/직후 performance.now() 를 재서 perf.chunkMs 에 넣는다 (계측 1단계).
          // TODO(phase6): 5번째 인자로 state.abort.signal 을 넘긴다.
          const lines = await requestTranslation(videoId, track.languageCode, c.segs, {
            before: segments.slice(Math.max(0, c.i0 - CTX_N), c.i0).map((s) => s.text),
            after: segments.slice(c.i0 + c.segs.length, c.i0 + c.segs.length + CTX_N).map((s) => s.text),
          });
          // TODO(phase6): 이 가드도 state.gen !== myGen 로 (불변식 4).
          if (state.videoId !== videoId || !state.active) return;
          // TODO(phase6): concat+sort 를 mergeTranslated(lines, c.t0, c.t1) 로 교체한다.
          //   지금은 번역 줄을 "추가"만 하므로, raw 줄을 깔기 시작하면 같은 시각에 원문 줄과
          //   번역 줄이 둘 다 남아 자막이 겹쳐 보인다 (불변식 3).
          state.lines = state.lines.concat(lines).sort((a, b) => a.start - b.start);
          state.idx = -2;
          // TODO(phase6): 이 loop() 시동을 삭제한다 — seedRawLines 가 이미 렌더를 돌리고 있다.
          if (!state.rafId) loop();      // 첫 청크 도착 즉시 표시 시작
          // TODO(phase6): 첫 번역 도착이면 perf.tFirstTrans 기록 (계측 1단계).
          log(`번역 ${++done}/${chunks.length} 청크 (${state.lines.length}줄)`);
        } catch (e) {
          // TODO(phase6): abort 로 인한 실패는 실패로 세지 말고 조용히 return 한다.
          // TODO(phase6): 아직 재시도한 적 없는 청크면 pending 에 다시 넣는다 (1회 한정).
          //   되돌리지 않으면 그 구간은 raw 원문 상태로 영구히 남는다 (불변식 8).
          failed++;
          log(`번역 청크 실패 (${failed}번째)`, e.message);
        }
      }
    };
    // TODO(phase6): runner 개수를 Phase 4 측정 1(동시성 프로브) 결과로 정한다.
    //   업스트림(127.0.0.1:8317)이 직렬 처리로 나오면 이 항목은 폐기하고 2 를 유지한다.
    await Promise.all([runner(), runner()]);   // 2개 동시 — 따라잡기 빠르게
    // TODO(phase6): 이 가드도 state.gen !== myGen 로 (불변식 4).
    if (state.videoId !== videoId || !state.active) return;
    // TODO(phase6): seedRawLines 이후 state.lines 는 절대 비지 않으므로 이 throw 는 도달
    //   불가가 된다. "전부 실패" 판정을 done === 0 기준으로 바꾼다.
    if (!state.lines.length) throw new Error("번역 실패");
    if (failed) toast(`번역 ${failed}개 청크 실패`);
    log(`준비 완료: ${state.lines.length}줄`);
  } catch (e) {
    console.error("[YT Dual]", e);
    showStatus(`오류: ${e.message}`);
    state.active = false;
    syncBar();
  }
}

function stop({ keepBox = false } = {}) {
  stopAsr();
  if (state.rafId) cancelAnimationFrame(state.rafId);
  // TODO(phase6): state.abort?.abort() 로 진행 중인 요청을 실제로 끊고 state.abort = null.
  //   지금은 정지·영상 이동 후에도 fetch 가 살아남아 runner 슬롯을 계속 물고 있다 (불변식 7).
  // TODO(phase6): state.gen 을 올려 이 세대의 남은 응답을 무효화한다 (불변식 4).
  Object.assign(state, { rafId: null, lines: [], idx: -1, loop: false, active: false });
  syncBar();
  if (!keepBox) $("#ytdual-box")?.remove();
}

const toggle = () => (state.active ? stop() : start());

// ── 키보드 ───────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;

  if (e.code === "Escape" && popEl) { e.preventDefault(); closeWordPop(); return; }
  if (e.altKey && e.code === "KeyY") { e.preventDefault(); toggle(); return; }
  // Alt+A: 번역 줄 토글 (일반 페이지의 페이지 번역 토글과 키를 통일)
  if (e.altKey && e.code === "KeyA") {
    e.preventDefault();
    cfg.showTranslation = !cfg.showTranslation;
    state.idx = -2;
    return;
  }
  if (!state.active) return;
  // 문장 단축키는 Ctrl 조합만 — 단일 키를 가로채면 유튜브 기본 단축키가 죽는다
  if (!e.ctrlKey || e.metaKey || e.altKey) return;

  const video = $("video");
  switch (e.code) {
    case "KeyR":
      state.loop = !state.loop;
      $("#ytdual-box")?.classList.toggle("looping", state.loop);
      break;
    case "KeyS":                       // 현재 문장 통째로 저장
      if (state.idx >= 0) saveCard(state.lines[state.idx].orig.split(/\s+/)[0] || "—");
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
  if ($("#ytdual-bar")) return;
  const bar = document.createElement("div");
  bar.id = "ytdual-bar";
  bar.innerHTML = `
    <button id="ytdual-btn-toggle" title="이중 자막 켜기/끄기 (Alt+Y)">자막</button>
    <button id="ytdual-btn-opts" title="설정">⚙</button>`;
  bar.querySelector("#ytdual-btn-toggle").addEventListener("click", toggle);
  bar.querySelector("#ytdual-btn-opts").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "ytdual-open-options" });
  });
  document.body.appendChild(bar);
  syncBar();
}

function syncBar() {
  $("#ytdual-btn-toggle")?.classList.toggle("on", state.active);
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
    applyColors();
    state.idx = -2;
  });

  window.addEventListener("yt-navigate-finish", watchNavigation);
  setInterval(watchNavigation, 700);
  setInterval(flushQueue, 8000);        // 실패분 주기적 재전송
  window.addEventListener("resize", positionOverlay);
  watchNavigation();
})();
