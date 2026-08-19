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

/* ── 불변식 ───────────────────────────────────────────────────────────
 * 이 파일이 항상 지켜야 하는 것들. [실측] 은 Phase 4 에서 실행해 확인한 것,
 * [미검증] 은 브라우저를 돌려봐야 확인되는 것이다.
 *
 * 렌더링 / state.lines
 *  I1  segments 를 확보한 뒤로 화면에 자막이 비는 순간이 없다. 번역을 기다리는
 *      동안에도 원문(raw)이 떠 있다. 이 시점 이후의 showStatus 는 위반이다.
 *  I2  state.lines 는 항상 start 오름차순이다.                          [실측]
 *  I3  같은 시각을 raw 줄과 번역 줄이 동시에 덮지 않는다. findLine 은 start 가
 *      가장 늦은 줄을 고르므로, 겹치면 번역이 원문으로 되돌아가 보인다.   [실측]
 *  I4  번역 도착은 raw 를 "교체"한다. "추가"하면 I3 가 깨진다.
 *  I5  모든 구간은 번역되었거나 raw 원문으로 남는다 — 조용한 빈 구간은 없다. [실측]
 *
 * 세션 수명
 *  I6  지난 세대(gen)의 응답은 state 를 절대 변경하지 않는다. videoId 비교만으로는
 *      같은 영상을 정지 후 재시작한 경우를 못 잡는다.
 *  I7  stop() 이후 진행 중인 fetch 는 하나도 살아남지 않는다.           [미검증]
 *  I8  abort signal 은 start() 진입 시 지역 변수로 캡처한다. stop() 이 state.abort 를
 *      null 로 만들기 때문에, runner 가 나중에 state.abort.signal 을 읽으면 터진다.
 *
 * 지연 예산 (Phase 4 실측: LLM 왕복 70~100초. 모든 항이 이 값에 비례한다)
 *  I9  청크 하나의 크리티컬 패스에 LLM 왕복은 1회 이하다.               [실측]
 *  I10 모든 fetch 는 유한한 타임아웃을 가진다. 무기한 대기는 runner 슬롯을
 *      영구 점유해 처리량을 반토막 낸다.
 *  I11 재시도 층은 하나뿐이다. 클라와 워커가 각자 재시도하면 횟수가 곱해진다
 *      (현재 2×3=6회 = 청크 하나에 최대 10분). ★ 현재 코드는 이걸 위반한다.
 *  I12 클라 타임아웃 > 워커가 쓸 수 있는 최대 시간. 아니면 워커의 재시도가
 *      끝나기도 전에 클라가 끊어 그 작업이 통째로 버려진다.
 *  I13 동시 번역 요청은 8개 이하. 8에서 실패 0·저하 15%, 그 이상은 미측정. [실측]
 *
 * 범위
 *  I14 유튜브 DOM 은 읽기만 한다. 쓰는 곳은 우리 오버레이뿐이다.
 *  I15 번역 작업은 영상 재생을 절대 블로킹하지 않는다.
 *
 * 아래 TODO(phase6) 주석들은 Phase 0 계획서의 옛 번호를 인용한다. 대응은 이렇다:
 *   옛1→I1  옛2→I2  옛3→I3  옛4→I6  옛7→I7  옛8→I5  옛9→W3  옛10→I10
 * ──────────────────────────────────────────────────────────────────── */

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
 *
 * 불변식: t1 은 반드시 마지막 seg 의 end 다. start 로 바꾸면 안 된다.
 *   유튜브 자막은 시간상 겹치므로(다음 seg 가 이전 seg 가 끝나기 전에 시작) end 로
 *   잘라내야 이웃 raw 줄까지 정리되어 I3 가 유지된다. start 로 바꾸면 겹침이 생긴다.
 *   Phase 4 에서 start 안을 실제로 구현해 측정했고 겹침 2건이 나와 폐기했다.
 */

/**
 * @typedef {object} Perf  지연 측정값. 전부 performance.now() 기준 ms.
 * @property {number}   t0           start() 진입 시각
 * @property {number}   tPlayer      플레이어 데이터 확보까지
 * @property {number}   tSegs        원문 세그먼트 확보까지
 * @property {number}   tFirstPaint  원문 자막이 화면에 처음 뜨기까지
 * @property {number}   tFirstTrans  번역 자막이 화면에 처음 뜨기까지
 * @property {number[]} chunkMs      청크별 왕복 시간
 * @property {number}   segsPerChunk 이번 세션이 실제로 쓴 청크 크기(조각 수).
 *                                   지연 수치를 크기와 함께 남겨야 서로 다른 실행끼리
 *                                   비교가 된다. 이게 없으면 Phase 4 스윕 결과가
 *                                   "어떤 크기에서 잰 값인지" 알 수 없는 숫자가 된다.
 * @property {number[]} tokens       청크별 출력 토큰 수(reasoning 포함).
 *                                   chunkMs 와 같은 인덱스로 정렬된다 — i번째 왕복의
 *                                   토큰 수가 tokens[i] 다. 워커가 usage 를 안 실어
 *                                   보내면 0 이 들어간다.
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
  gen: 0,         // start() 세대 번호. 같은 영상을 재시작해도 지난 세대 응답을 가려낸다 (I6)
  /** @type {AbortController|null} 이번 세대의 진행 중 요청들을 한 번에 끊는 손잡이.
   *  stop() 에서 null 이 되므로 runner 는 이 필드를 직접 읽지 말고 지역 캡처본을 쓴다 (I8) */
  abort: null,
  /** @type {Perf} */
  perf: {
    t0: 0, tPlayer: 0, tSegs: 0, tFirstPaint: 0, tFirstTrans: 0,
    chunkMs: [], segsPerChunk: 0, tokens: [],
  },
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
/* 불변식 I10·I11·I12 가 걸리는 지점이다.
 *  I10  이 fetch 는 반드시 유한 타임아웃을 가진다.
 *  I11  ★ 현재 위반 중: 아래 `attempt >= 1` 재시도가 워커의 3회 재시도와 곱해져
 *       청크 하나에 LLM 호출이 최대 6회(≈10분) 발생한다. 재시도는 한 층에만 둔다 —
 *       여기를 없애고 start() 의 청크 재큐에 맡기거나, 워커 재시도를 1회로 낮춘다.
 *  I12  타임아웃 값 > 워커 최대 소요. Phase 4 실측 LLM 왕복 70~100초 기준으로
 *       워커가 3회까지 쓰면 210~300초이므로 그보다 커야 한다.
 *  I8   signal 은 호출자가 지역 캡처한 것을 받는다. state.abort 를 직접 읽지 않는다. */
/**
 * 목표 계약 (Phase 6 에서 구현). 지금은 Line[] 만 반환한다.
 * 매개변수는 바뀌지 않는다. 반환이 배열에서 객체로 바뀌므로 호출부 1곳도 함께 바뀐다.
 * @returns {Promise<{lines: Line[], usage?: Usage}>}
 *   usage 를 이 경로로 끌어올리지 않으면 Phase 4 의 토큰 측정이 불가능하다.
 *   응답 본문은 이 함수 안에서 소비되므로 호출부가 따로 읽을 방법이 없다.
 */
async function requestTranslation(videoId, lang, segments, ctx = {}, signal = null) {
  // TODO(phase6): 요청 1회의 타임아웃을 건다. 내부에 AbortController 를 만들고 전달받은
  //   signal 의 "abort" 이벤트를 addEventListener 로 수동 연결한다. AbortSignal.any() 는
  //   Firefox 124+ 라 manifest 의 strict_min_version 115 에서 조용히 깨진다.
  //   타임아웃이 없으면 멈춘 업스트림 하나가 runner 슬롯을 영구 점유해 처리량이 반토막 난다 (불변식 10).
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${cfg.endpoint}/api/subtitle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
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
      // TODO(phase6): 응답에서 usage 도 꺼내 { lines, usage } 로 반환한다. 반환 형태가
      //   배열에서 객체로 바뀌므로 호출부 1곳(runner)도 함께 고쳐야 한다 — 안 고치면
      //   mergeTranslated 에 객체가 들어가 자막이 통째로 사라진다.
      const { lines } = await res.json();
      if (!Array.isArray(lines) || !lines.length) throw new Error("빈 응답");
      return lines;
    } catch (e) {
      if (signal?.aborted) throw e;        // 세션 종료 — 재시도하지 않는다 (I7)
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
 *
 *  불변식: 이 함수가 I1 을 세운다. 호출된 뒤로는 어떤 코드도 오버레이를 상태
 *    메시지로 덮어써선 안 된다. 호출 전에는 I1 이 성립하지 않는다.
 *
 *  @param {Segment[]} segments
 *  @returns {void} */
function seedRawLines(segments) {
  state.lines = segments.map((s) => ({
    start: s.start, end: s.end, orig: s.text, trans: "", raw: true,
  }));
  state.idx = -2;                 // 다음 render 가 다시 계산하게
  state.perf.tFirstPaint = performance.now() - state.perf.t0;
  if (!state.rafId) loop();       // 여기서부터 I1 이 성립한다
}

/** [t0, t1) 구간의 raw 줄을 걷어내고 번역 줄로 갈아끼운다. start 정렬을 유지한다.
 *  t0/t1 은 응답이 아니라 청크에서 온다 — 워커가 일부 줄을 버려도 구간 전체가
 *  확실히 교체되어야 raw 와 번역본이 같은 시각에 겹치지 않는다.
 *
 *  불변식 — 이 함수가 반환된 뒤 항상 참이어야 한다:
 *    I2  state.lines 가 start 오름차순이다.
 *    I3  raw 줄의 start 가 어떤 번역 줄의 [start, end) 안에 들어가지 않는다.
 *    I4  제거 대상은 raw 줄뿐이다. 이미 번역된 줄은 건드리지 않는다 (청크가 뒤섞인
 *        순서로 도착하므로 남의 결과를 지우면 안 된다).
 *    I5  제거한 구간은 lines 가 반드시 덮는다. 덮지 못하면 빈 시각이 생긴다.
 *  Phase 4 에서 240조각·5청크·도착순서 뒤섞음·시간겹침 조건으로 실측 통과했다.
 *
 *  @param {Line[]} lines  워커가 돌려준 번역 줄
 *  @param {number} t0     교체할 구간의 시작(초)
 *  @param {number} t1     교체할 구간의 끝(초)
 *  @returns {void} */
function mergeTranslated(lines, t0, t1) {
  // raw 만 걷어낸다 — 청크는 뒤섞인 순서로 도착하므로 남의 번역 결과를 지우면 안 된다 (I4)
  const kept = state.lines.filter((l) => !(l.raw && l.start >= t0 && l.start < t1));
  state.lines = kept.concat(lines).sort((a, b) => a.start - b.start);   // I2
  state.idx = -2;
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
  const myGen = ++state.gen;                  // I6
  state.abort = new AbortController();
  const sig = state.abort.signal;             // I8: 지역 캡처 (stop() 이 state.abort 를 비운다)
  // TODO(phase6): segsPerChunk 와 tokens 를 여기에도 넣는다. Phase 1 에서 최상위 리터럴에만
  //   추가해 이 재초기화와 형태가 어긋나 있다 — 지금 실행하면 두 필드는 undefined 다.
  state.perf = { t0: performance.now(), tPlayer: 0, tSegs: 0, tFirstPaint: 0, tFirstTrans: 0, chunkMs: [] };
  syncBar();

  try {
    showStatus("자막 트랙 확인 중", true);
    // TODO(phase6): readPlayerResponseFromDOM() 을 먼저 시도하고 null 일 때만
    //   fetchPlayerResponse(videoId) 로 폴백한다. 여기서 인라인으로 처리하고 래퍼 함수는
    //   만들지 않는다 (호출자가 하나뿐). 같은 페이지 HTML 을 네트워크로 다시 받는 낭비 제거.
    //   단 Phase 4 에서 perf.tPlayer 가 1초 미만이면 이 항목은 통째로 버린다.
    const player = await fetchPlayerResponse(videoId);
    state.perf.tPlayer = performance.now() - state.perf.t0;
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

    state.perf.tSegs = performance.now() - state.perf.t0;
    seedRawLines(segments);        // I1: 이 시점부터 화면은 비지 않는다

    // 긴 자막을 한 요청으로 보내면 응답까지 몇 분씩 걸려 연결이 끊긴다.
    // 작은 청크로 나눠, "지금 보고 있는 지점" 주변부터 우선 번역해 바로 띄우고
    // 나머지는 백그라운드로 채운다. 이웃 세그먼트는 문맥(CTX)으로 함께 보낸다.
    // TODO(phase6): Phase 4 스윕(8/12/24/48)의 결과값으로 확정하고, 그 값을
    //   state.perf.segsPerChunk 에 기록한다. 크기를 안 남기면 로그의 지연 수치가
    //   어느 크기에서 나온 것인지 알 수 없어 실행끼리 비교가 안 된다.
    //   ★ 측정 1 에서 reasoning 이 "요청당 고정"으로 나오면 작게 쪼개도 이득이
    //   거의 없다 — 그때는 이 값을 바꾸지 말고 Phase 0 으로 되돌아간다.
    const TRANSLATE_CHUNK = 48;
    const CTX_N = 8;
    const chunks = [];
    for (let i = 0; i < segments.length; i += TRANSLATE_CHUNK) {
      const segs = segments.slice(i, i + TRANSLATE_CHUNK);
      chunks.push({ i0: i, segs, t0: segs[0].start, t1: segs[segs.length - 1].end });
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

    // showStatus 없음 — 원문이 이미 떠 있는데 덮어쓰면 I1 위반
    let done = 0, failed = 0;
    const retried = new Set();     // 청크당 재큐 1회 한정 (I5)
    const runner = async () => {
      for (;;) {
        if (state.gen !== myGen || !state.active) return;   // I6
        const c = nextChunk();
        if (!c) return;
        pending.delete(c);
        const tReq = performance.now();
        try {
          // TODO(phase6): { lines, usage } 로 구조분해하고, chunkMs.push 바로 옆에서
          //   tokens 에도 같은 인덱스로 넣는다. 두 배열의 인덱스가 어긋나면 "이 지연이
          //   이 토큰 수에서 나왔다"는 대응이 깨져 측정 전체가 무의미해진다.
          //   usage 가 없는 청크(캐시 히트 등)는 0 이 아니라 null 을 넣는다 — Phase 1
          //   typedef 의 "없으면 0" 서술도 함께 고친다.
          const lines = await requestTranslation(videoId, track.languageCode, c.segs, {
            before: segments.slice(Math.max(0, c.i0 - CTX_N), c.i0).map((s) => s.text),
            after: segments.slice(c.i0 + c.segs.length, c.i0 + c.segs.length + CTX_N).map((s) => s.text),
          }, sig);
          if (state.gen !== myGen || !state.active) return;   // I6
          state.perf.chunkMs.push(Math.round(performance.now() - tReq));
          mergeTranslated(lines, c.t0, c.t1);                 // I2·I3·I4
          if (!state.perf.tFirstTrans) state.perf.tFirstTrans = performance.now() - state.perf.t0;
          log(`번역 ${++done}/${chunks.length} 청크 (${state.lines.length}줄)`);
        } catch (e) {
          if (sig.aborted || state.gen !== myGen) return;     // 세션 종료는 실패가 아니다
          if (!retried.has(c)) { retried.add(c); pending.add(c); continue; }
          failed++;
          log(`번역 청크 실패 (${failed}번째)`, e.message);
        }
      }
    };
    // Phase 4 실측: 업스트림은 동시 8까지 거의 선형 (1개 73s / 4개 69s / 8개 84s, 실패 0). I13
    // TODO(phase6): 청크 크기를 줄이면 청크 개수가 그만큼 늘어 8 이 처음으로 실제
    //   병목이 된다(12분 영상 3개 → 12개, 1시간 15개 → 59개). 8-way 는 실측됐지만
    //   총 요청 수가 4배로 늘 때의 429 는 미측정이다. Phase 4 측정 결과를 보고 정한다.
    const RUNNERS = 8;
    await Promise.all(Array.from({ length: RUNNERS }, runner));
    if (state.gen !== myGen || !state.active) return;   // I6
    if (!done) throw new Error("번역 실패");             // lines 는 raw 로 항상 차 있다 (I1)
    if (failed) toast(`번역 ${failed}개 청크 실패`);
    const p = state.perf;
    log(`준비 완료: ${state.lines.length}줄`, {
      tPlayer: Math.round(p.tPlayer), tSegs: Math.round(p.tSegs),
      tFirstPaint: Math.round(p.tFirstPaint), tFirstTrans: Math.round(p.tFirstTrans),
      chunkMedian: p.chunkMs.slice().sort((a, b) => a - b)[p.chunkMs.length >> 1],
      // TODO(phase6): segsPerChunk 와 토큰 통계(중앙값, reasoning 비중)를 함께 찍는다.
      //   이 로그가 Phase 4 스윕의 유일한 관측창이라 크기와 토큰이 없으면 비교가 안 된다.
      tAllDone: Math.round(performance.now() - p.t0), chunks: chunks.length, failed,
    });
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
  state.abort?.abort();   // I7: 진행 중인 요청을 실제로 끊는다
  state.gen++;            // I6: 이 세대의 남은 응답을 무효화
  Object.assign(state, { rafId: null, lines: [], idx: -1, loop: false, active: false, abort: null });
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
