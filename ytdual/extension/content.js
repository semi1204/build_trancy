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
 *  I3  등급이 다른 두 줄이 같은 시각을 덮지 않는다. findLine 은 start 가 가장 늦은
 *      줄을 고르므로, 등급이 섞여 겹치면 정확한 번역이 거친 번역이나 원문으로
 *      되돌아가 보인다. 같은 등급끼리의 짧은 겹침은 허용한다 — I5 를 지키려면
 *      경계에서 겹침이 불가피하고, 겹침은 구멍보다 언제나 낫다.           [실측]
 *  I4  번역 도착은 낮은 등급을 "교체"한다. "추가"하면 I3 가 깨진다. 남의 full
 *      결과는 절대 지우지 않는다 (청크는 뒤섞인 순서로 도착한다).          [실측]
 *  I5  ★ 모든 시각은 어떤 줄에든 덮인다 — 조용한 빈 구간은 없다. 최종 상태뿐
 *      아니라 "번역이 절반만 도착한 중간 상태"에서도 성립해야 한다.
 *      ★★ 현재 코드는 이걸 위반한다. Phase 4 실측: 청크 하나만 병합된 중간
 *      상태에서 빈 시각 4개. 옛 raw 필터에서도 동일하게 재현되므로 거리 기반
 *      2단이 만든 것이 아니라 원래 있던 결함이다.                        [실측]
 *
 *      원인 — 유튜브 자막은 시간이 겹친다(다음 조각이 이전 조각이 끝나기 전에
 *      시작). mergeTranslated 가 "start 가 [t0,t1) 안"인 줄을 지우면, t1 직전에
 *      시작하지만 t1 이후에 끝나는 이웃 조각까지 함께 지워진다. 그런데 새로
 *      끼워 넣는 줄은 t1 까지만 덮으므로 그 뒤가 빈다.
 *        t1 = segs[23].end = 72.4,  segs[24] = [72.0, 75.4]
 *        72.0 < 72.4 라 제거 → [72.4, 75.4] 가 빔
 *
 *      지키는 방법 (I23) — 제거 조건을 "완전히 포함"으로 좁힌다.
 *        지금:  l.start >= t0 && l.start <  t1     ← 이웃을 함께 지운다
 *        고침:  l.start >= t0 && l.end   <= t1     ← 자기 조각만 지운다
 *      경계를 걸친 조각은 살아남고, 그 조각을 소유한 다음 청크가 나중에 지운다.
 *      그 사이 짧은 겹침이 생기지만 I3 가 허용하는 종류다.
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
 *  I14 유튜브 DOM 은 읽기만 한다. 쓰는 곳은 우리 오버레이뿐이다. native 자막을
 *      숨기는 것도 클래스 하나로만 하고, 유튜브의 요소를 직접 고치지 않는다.
 *  I15 번역 작업은 영상 재생을 절대 블로킹하지 않는다.
 *
 * 거리 기반 2단 (fast / full)
 *  I16 등급은 재생 위치와의 거리로만 정한다. 지금 재생 중인 구간만 fast 다 —
 *      그 구간만 속도가 정확도를 이긴다. 나머지는 몇 분 뒤에나 닿으므로 full 이다.
 *  I17 등급은 청크에 저장하지 않는다. 재큐 시점의 재생 위치로 다시 정해야 맞다
 *      (그 사이 시킹했을 수 있다). 저장하면 낡은 등급을 쓰게 된다.
 *  I18 워커가 돌려준 fast 배열의 길이는 보낸 조각 수와 반드시 같다. 다르면 통째로
 *      버린다. 하나라도 밀리면 엉뚱한 시각에 엉뚱한 번역이 붙는데, 그건 번역이
 *      없는 것보다 나쁘고 화면만 봐서는 알아챌 수 없다.
 *  I21 full 을 받은 줄은 fast 로 덮지 않는다. 늦게 도착한 거친 번역이 이미 보고
 *      있던 정확한 번역을 지우면 자막이 뒤로 후퇴한다.                    [실측]
 *  I22 ★ 줄은 배열 인덱스로 지정하지 않는다. 오직 시각으로만 찾는다.
 *      mergeTranslated 가 배열을 재구성하는 순간 state.lines 의 인덱스와
 *      segments 의 인덱스 대응이 영구히 깨지기 때문이다.
 *      Phase 4 실측: 12조각짜리 full 이 한 번 병합되자 lines[20] 이 frag 20 에서
 *      frag 32 로 밀렸고, applyFast(20,...) 이 조각 20 의 번역을 조각 32 자리에
 *      붙였다. "인덱스는 영구히 1:1" 이라는 가정은 성립하지 않는다.        [실측]
 *  I23 모든 raw 줄은 정확히 한 청크의 [t0, t1] 에 완전히 포함된다. 즉 제거 책임이
 *      유일하다. 이 성질이 I5 의 구멍을 막는 근거다 — "완전히 포함"으로 지우면
 *      각 조각은 자기 소유 청크에 의해 정확히 한 번 제거된다.
 *
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
 * @property {string}  trans  번역문. 아직 번역 전이면 "" 이다
 * @property {"fast"|"full"|null} tier  이 줄이 지금 담고 있는 번역의 품질 등급.
 *   null  = 아직 번역 전인 원문 자리표시자 (옛 raw:true 와 같은 뜻)
 *   fast  = 조각별 번역. 재생 위치 근처라 속도를 우선해 받은 것 (약 2.7초)
 *   full  = 병합·분할된 번역. 정확도를 우선해 받은 것 (약 9.7초)
 *
 * 등급을 boolean raw 와 따로 두지 않고 이 한 필드로 합친다. 두 필드를 두면
 * "raw 인데 tier 가 full" 같은 불가능한 상태가 표현 가능해지고, 그 모순이
 * 곧바로 I3(겹침) 류의 버그가 된다. raw 는 tier === null 과 동치다.
 *
 * ★ Phase 6 에서 이행한다. 현재 코드는 아직 raw:true 를 쓰며, 읽는 곳은
 *   mergeTranslated 한 곳뿐이라 이행 지점은 2곳(seedRawLines·mergeTranslated)이다.
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
 *
 * 불변식 I23: [t0, t1] 은 이 청크가 소유한 조각들을 완전히 포함한다. 첫 조각의
 *   start 부터 마지막 조각의 end 까지이므로 정의상 그렇다. 그리고 이웃 청크의
 *   조각은 완전히 포함하지 않는다 — 다음 조각은 t1 이후에 끝나기 때문이다.
 *   따라서 "완전히 포함된 줄만 제거"하면 각 조각의 제거 책임이 정확히 한 청크에만
 *   있다. 이것이 I5(빈 구간 없음)를 성립시키는 유일한 근거다.
 *
 * ★ 주의: t1 은 "이 청크가 덮는 시간의 끝"이지 "다음 청크가 시작하는 시각"이 아니다.
 *   겹치는 자막에서는 다음 청크의 t0(= 다음 조각의 start)가 이 청크의 t1 보다 이르다.
 *   두 값을 같다고 가정하는 코드를 쓰면 그 간극이 곧 빈 시각이 된다.
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
 * @property {{fast: number, full: number}} tierCounts  등급별 요청 횟수.
 *   거리 기반 2단은 같은 구간을 fast 로 한 번, full 로 다시 한 번 번역할 수 있다.
 *   fast + full 이 청크 수보다 얼마나 큰지가 곧 중복 번역 비용이고, 그게 커지면
 *   2단 설계 자체가 손해다. 이 값 없이는 그 손익을 볼 방법이 없다.
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
    tierCounts: { fast: 0, full: 0 },
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
 * @param {"fast"|"full"} mode  등급. 워커의 프롬프트·응답 형태가 이 값으로 갈린다.
 * @returns {Promise<{lines?: Line[], t?: string[], usage?: Usage}>}
 *   mode=full 이면 lines, mode=fast 면 t 가 온다. 둘은 동시에 오지 않는다.
 *   usage 를 이 경로로 끌어올리지 않으면 토큰 측정이 불가능하다 — 응답 본문은
 *   이 함수 안에서 소비되므로 호출부가 따로 읽을 방법이 없다.
 */
async function requestTranslation(videoId, lang, segments, ctx = {}, signal = null, mode = "full") {
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
          mode,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`서버 ${res.status} ${detail.slice(0, 120)}`);
      }
      const payload = await res.json();
      // I18: fast 는 길이 일치가 유일한 계약이다. 밀린 채로 받아들이면 엉뚱한 시각에
      //   엉뚱한 번역이 붙고, 화면만 봐서는 알아챌 수 없다. 통째로 버린다.
      if (mode === "fast") {
        if (!Array.isArray(payload.t) || payload.t.length !== segments.length) {
          throw new Error(`fast 길이 불일치 ${payload.t?.length}/${segments.length}`);
        }
        return { t: payload.t, usage: payload.usage };
      }
      const lines = payload.lines;
      if (!Array.isArray(lines) || !lines.length) throw new Error("빈 응답");
      return { lines, usage: payload.usage };
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
    start: s.start, end: s.end, orig: s.text, trans: "", tier: null,
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
 *    I2  state.lines 가 start 오름차순이다.                              [실측]
 *    I3  등급이 다른 두 줄이 같은 시각을 덮지 않는다.                     [실측]
 *    I4  제거 대상은 이 구간의 낮은 등급 줄뿐이다. 남의 full 결과는 건드리지
 *        않는다 (청크가 뒤섞인 순서로 도착한다).                          [실측]
 *    I5  ★ 제거한 것은 반드시 덮는다. 현재 위반 중 — 아래 참조.
 *    I23 각 조각의 제거 책임은 정확히 한 청크에만 있다.
 *
 *  ★★ 현재 이 함수는 I5 를 위반한다 (Phase 4 실측: 중간 상태에서 빈 시각 4개).
 *    제거 조건이 "start 가 [t0,t1) 안"이라, t1 직전에 시작해 t1 이후에 끝나는
 *    이웃 조각까지 지워버린다. 새로 넣는 줄은 t1 까지만 덮으므로 그 뒤가 빈다.
 *    고칠 곳은 한 줄이다 — 제거 조건을 "완전히 포함"으로 좁힌다:
 *        l.start >= t0 && l.start <  t1     (지금: 이웃까지 지움)
 *        l.start >= t0 && l.end   <= t1     (고침: 자기 조각만)
 *    이렇게 하면 경계를 걸친 조각은 살아남아 다음 청크가 지운다. 그동안 짧은
 *    겹침이 생기지만 같은 등급끼리이므로 I3 가 허용하는 종류이고, 겹침은
 *    구멍보다 언제나 낫다 — 겹치면 원문이 잠깐 보이고, 비면 아무것도 안 보인다.
 *
 *  Phase 4 검증 조건: 240조각·시간겹침·도착순서 뒤섞음. 최종 상태뿐 아니라
 *    청크가 하나만 도착한 중간 상태에서도 검사해야 한다 — 지난 세션이 이걸
 *    안 봐서 이 결함을 놓쳤다.
 *
 *  @param {Line[]} lines  워커가 돌려준 번역 줄
 *  @param {number} t0     교체할 구간의 시작(초)
 *  @param {number} t1     교체할 구간의 끝(초)
 *  @returns {void} */
function mergeTranslated(lines, t0, t1) {
  // 제거 조건이 "완전히 포함"인 것이 I5 의 핵심이다. start 만 보면 t1 직전에 시작해
  // t1 이후에 끝나는 이웃 조각까지 지워지고, 새 줄은 t1 까지만 덮으므로 그 뒤가 빈다.
  // end <= t1 로 좁히면 각 조각은 자기를 소유한 청크에만 지워진다 (I23).
  // full 이 아닌 줄(null=원문, fast=조각번역)이 대상이다. fast 를 남기면 아래 concat 이
  // 겹쳐 등급이 다른 두 줄이 같은 시각을 덮는다 (I3). 남의 full 은 건드리지 않는다 (I4).
  const kept = state.lines.filter((l) => !(l.tier !== "full" && l.start >= t0 && l.end <= t1));
  const stamped = lines.map((l) => ({ ...l, tier: "full" }));            // I21
  state.lines = kept.concat(stamped).sort((a, b) => a.start - b.start);  // I2
  state.idx = -2;
}

/** 조각별(fast) 번역을 state.lines 에 제자리 대입한다. 배열을 재구성하지 않는다.
 *
 *  불변식 — 이 함수가 반환된 뒤 항상 참이어야 한다:
 *    I2  자명하게 유지된다. 줄을 넣거나 빼거나 재정렬하지 않는다.
 *    I3  자명하게 유지된다. start/end 를 건드리지 않으므로 겹침이 생길 수 없다.
 *    I5  빈 번역은 등급을 올리지 않는다. 원문이 그대로 남아 화면이 비지 않는다.
 *    I21 이미 full 을 받은 줄은 덮지 않는다. 늦게 도착한 거친 번역이 정확한
 *        번역을 지우면 사용자가 보던 자막이 뒤로 후퇴한다.               [실측]
 *    I22 줄을 배열 인덱스로 찾지 않는다. 오직 시각으로만 찾는다.
 *
 *  I22 를 이렇게 지킨다 — mergeTranslated 가 배열을 재구성하는 순간 state.lines 의
 *    인덱스와 segments 의 인덱스 대응은 영구히 깨진다 (Phase 4 실측: full 한 번에
 *    lines[20] 이 frag 20 → frag 32 로 밀렸고, 조각 20 의 번역이 조각 32 에 붙었다).
 *    그래서 인덱스를 받지 않고 조각 자체를 받아 start 로 줄을 찾는다. 두 배열 모두
 *    start 오름차순이므로 한 번의 병행 순회로 끝난다(이진 탐색 불필요).
 *    start 비교에 오차 허용치를 두지 않는 것은 seedRawLines 가 같은 Segment 객체의
 *    s.start 를 그대로 복사했기 때문이다 — 동일한 double 이라 정확히 일치한다.
 *
 *  @param {Segment[]} segs   이 요청으로 보낸 조각들 (segments 의 연속 구간)
 *  @param {string[]}  trans  segs 와 같은 순서·같은 길이의 번역문
 *  @returns {void} */
function applyFast(segs, trans) {
  let i = 0;
  for (let j = 0; j < segs.length; j++) {
    const s = segs[j];
    while (i < state.lines.length && state.lines[i].start < s.start) i++;
    const line = state.lines[i];
    if (!line || line.start !== s.start) continue;   // 이미 full 이 덮어 사라진 줄
    if (line.tier === "full") continue;              // I21
    if (!trans[j]) continue;                         // I5: 빈 번역은 원문 유지
    line.trans = trans[j];
    line.tier = "fast";
  }
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
  state.perf = {
    t0: performance.now(), tPlayer: 0, tSegs: 0, tFirstPaint: 0, tFirstTrans: 0,
    chunkMs: [], segsPerChunk: 0, tokens: [], tierCounts: { fast: 0, full: 0 },
  };
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
    // 우리 원문이 뜬 뒤에야 유튜브 native 자막을 숨긴다 (I14: 클래스 하나만 붙이고
    // 유튜브 요소는 직접 고치지 않는다). 앞에서 끄면 원문 확보를 기다리는 동안
    // 화면에 자막이 하나도 없게 된다.
    document.documentElement.classList.add("ytdual-on");

    // 긴 자막을 한 요청으로 보내면 응답까지 몇 분씩 걸려 연결이 끊긴다.
    // 작은 청크로 나눠, "지금 보고 있는 지점" 주변부터 우선 번역해 바로 띄우고
    // 나머지는 백그라운드로 채운다. 이웃 세그먼트는 문맥(CTX)으로 함께 보낸다.
    // 두 격자는 정렬될 필요가 없다 — fast 는 시각으로 제자리 대입하고(I22) full 은
    // 시간 구간을 교체하므로, 서로 다른 크기여도 안전하다.
    const TRANSLATE_CHUNK = 12;   // full 격자.       [실측: terra 9.7초]
    const FAST_CHUNK = 8;         // 재생 중 미리보기. [실측: terra 2.7초, reasoning 0]
    state.perf.segsPerChunk = TRANSLATE_CHUNK;
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
      // I16: 등급은 이 sc 를 그대로 쓴다. -1 은 "지금 재생 중"이라는 뜻이고 그 구간만
      //   속도가 정확도를 이긴다. I17: 등급을 청크에 저장하지 않는다 — 재큐 시점의
      //   재생 위치로 다시 정해야 맞다 (그 사이 시킹했을 수 있다).
      return best && { c: best, playing: bestScore === -1 };
    };

    // showStatus 없음 — 원문이 이미 떠 있는데 덮어쓰면 I1 위반
    let done = 0, failed = 0;
    const retried = new Set();     // 청크당 실패 재큐 1회 한정 (I5)
    const previewed = new Set();   // fast 미리보기를 이미 받은 청크. 승급과 실패 재큐를
                                   // 구분하는 표식이자, 같은 청크의 fast 무한 반복 방지
    const runner = async () => {
      for (;;) {
        if (state.gen !== myGen || !state.active) return;   // I6
        const picked = nextChunk();
        if (!picked) return;
        const { c, playing } = picked;
        // 재생 중이고 아직 미리보기를 안 받은 청크만 fast (I16). previewed 가 없으면
        // 같은 청크가 계속 재생 중인 동안 fast 만 무한히 반복한다.
        const mode = playing && !previewed.has(c) ? "fast" : "full";
        const segs = mode === "fast" ? c.segs.slice(0, FAST_CHUNK) : c.segs;
        pending.delete(c);
        const tReq = performance.now();
        try {
          const res = await requestTranslation(videoId, track.languageCode, segs, {
            before: segments.slice(Math.max(0, c.i0 - CTX_N), c.i0).map((s) => s.text),
            after: segments.slice(c.i0 + segs.length, c.i0 + segs.length + CTX_N).map((s) => s.text),
          }, sig, mode);
          if (state.gen !== myGen || !state.active) return;   // I6
          // 두 배열은 같은 인덱스로 정렬된다 — 어긋나면 "이 지연이 이 토큰에서
          // 나왔다"는 대응이 깨진다. usage 없는 청크는 0 이 아니라 null (해당 없음).
          state.perf.chunkMs.push(Math.round(performance.now() - tReq));
          state.perf.tokens.push(res.usage?.completion_tokens ?? null);
          if (mode === "fast") {
            applyFast(segs, res.t);                          // I2·I3·I5·I21·I22
            state.perf.tierCounts.fast++;
            previewed.add(c);
            pending.add(c);   // full 로 승급. 안 되돌리면 거친 번역인 채로 영영 남는다
          } else {
            mergeTranslated(res.lines, c.t0, c.t1);          // I2·I3·I4·I5·I23
            state.perf.tierCounts.full++;
            done++;
          }
          if (!state.perf.tFirstTrans) state.perf.tFirstTrans = performance.now() - state.perf.t0;
          log(`번역 ${done}/${chunks.length} 청크 (${mode}, ${state.lines.length}줄)`);
        } catch (e) {
          if (sig.aborted || state.gen !== myGen) return;     // 세션 종료는 실패가 아니다
          if (!retried.has(c)) { retried.add(c); pending.add(c); continue; }
          failed++;
          log(`번역 청크 실패 (${failed}번째)`, e.message);
        }
      }
    };
    // Phase 4 실측: 업스트림은 동시 8까지 거의 선형 (1개 73s / 4개 69s / 8개 84s, 실패 0). I13
    // 청크가 12조각 격자로 잘게 나뉘어 개수가 늘었지만(12분 영상 3 → 12개) 8 을 그대로
    // 둔다. 8 이상은 미측정이고, I13 이 허용하는 상한이 8 이다.
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
      tAllDone: Math.round(performance.now() - p.t0), chunks: chunks.length, failed,
      // fast+full 이 chunks 보다 얼마나 큰지가 중복 번역 비용이다. 크면 2단이 손해다.
      segsPerChunk: p.segsPerChunk, tierCounts: p.tierCounts,
      tokMedian: p.tokens.filter((t) => t != null).sort((a, b) => a - b)[p.tokens.length >> 1] ?? null,
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
  // 안 떼면 확장을 꺼도 유튜브 자막이 계속 숨겨진 채로 남는다
  document.documentElement.classList.remove("ytdual-on");
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
