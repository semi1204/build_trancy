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
  endpoint: "http://127.0.0.1:8787",
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
 * 지연 예산 (실측. 지연은 출력 토큰에 거의 비례한다)
 *   실제 자막 4개 fixture × 3위치, gpt-5.6-terra, 캐시 미스, 순차 요청:
 *     N=12  수동 7.1초 / 자동 7.5초   (N=8 이면 수동 3.9초 / 자동 7.3초)
 *
 *   워커가 프롬프트에서 병합·분할·원문재출력을 걷어내고 "번역"만 남기기 전에는
 *   같은 N=12 가 수동 22.5초 / 자동 18.5초였다(자동 ja 는 47초). 복잡한 과제가
 *   reasoning 을 만들고 reasoning 이 지연을 만든다 — 무엇을 한 줄로 볼지는
 *   워커의 groupSegments 가 기계적으로 정한다.
 *   재현: node scripts/bench-translation.mjs  (워커 + CLIProxyAPI 필요)
 *  I9  청크 하나의 크리티컬 패스에 LLM 왕복은 1회 이하다.               [실측]
 *  I10 모든 fetch 는 유한한 타임아웃을 가진다. 무기한 대기는 runner 슬롯을
 *      영구 점유해 처리량을 반토막 낸다.
 *  I11 재시도 층은 하나뿐이다. 클라와 워커가 각자 재시도하면 횟수가 곱해진다.
 *      requestTranslation 은 재시도하지 않는다 — 재큐(1회)와 워커(3회)뿐이다.
 *  I12 클라 타임아웃 > 워커가 쓸 수 있는 최대 시간. 아니면 워커의 재시도가
 *      끝나기도 전에 클라가 끊어 그 작업이 통째로 버려진다.
 *  I13 동시 번역 요청은 8개 이하. 8에서 실패 0·저하 15%, 그 이상은 미측정. [실측]
 *
 * 범위
 *  I14 유튜브 DOM 은 읽기만 한다. 쓰는 곳은 우리 오버레이뿐이다. native 자막을
 *      숨기는 것도 클래스 하나로만 하고, 유튜브의 요소를 직접 고치지 않는다.
 *  I15 번역 작업은 영상 재생을 절대 블로킹하지 않는다.
 *
 * 병합
 *  I22 줄은 배열 인덱스로 지정하지 않는다. 오직 시각으로만 찾는다.
 *      mergeTranslated 가 배열을 재구성하는 순간 state.lines 의 인덱스와
 *      segments 의 인덱스 대응이 영구히 깨지기 때문이다.
 *      [실측: 12조각짜리 병합 한 번에 lines[20] 이 frag 20 에서 frag 32 로 밀렸다]
 *  I23 모든 원문 줄은 정확히 한 청크의 [t0, t1] 에 완전히 포함된다. 즉 제거 책임이
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
 * @property {boolean} translated  번역이 들어왔는가. seedRawLines 가 깔아 둔
 *   원문 자리표시자는 false 다. mergeTranslated 가 이 값으로 "지워도 되는 줄"과
 *   "남이 번역해 넣은 줄"을 가른다 (I4) — 청크가 뒤섞인 순서로 도착하기 때문에
 *   이 구분이 없으면 남의 결과를 지운다.
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
 */

let cfg = { ...DEFAULTS };
let state = {
  videoId: null,
  title: "",
  /** @type {Line[]} start 오름차순. 원문 줄과 번역 줄이 한 배열에 섞여 산다 */
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
  /** @type {Function[]} 이번 세대가 등록한 리스너를 stop() 에서 되돌리는 훅.
   *  안 떼면 세션이 바뀔 때마다 <video> 에 리스너가 쌓인다. */
  cleanups: [],
  /** @type {Perf} */
  perf: {
    t0: 0, tPlayer: 0, tSegs: 0, tFirstPaint: 0, tFirstTrans: 0,
    chunkMs: [], segsPerChunk: 0, tokens: [],
  },
};

const $ = (s, r = document) => r.querySelector(s);
const log = (...a) => console.log("[YT Dual]", ...a);

/** 요소 하나를 만든다. innerHTML 을 쓰지 않는 이유 —
 *  유튜브는 CSP 에 `require-trusted-types-for 'script'` 를 건다. 그 상태에서
 *  innerHTML 에 문자열을 넣으면 TypeError 가 나고, 오버레이도 버튼도 만들어지지
 *  않아 확장이 통째로 죽은 것처럼 보인다. DOM 을 직접 세우면 그 규칙과 무관하다. */
function make(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") n.textContent = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else n.setAttribute(k, v);
  }
  for (const c of kids) n.append(c);
  return n;
}

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
function parseJson3Segments(data) {
  return (data.events || [])
    .filter((e) => e.segs)
    .map((e) => ({
      start: e.tStartMs / 1000,
      end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
      text: e.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((s) => s.text);
}

/** 자막 조각의 시간을 실제 표시 구간으로 되돌린다. timedtext·패널·전사 어느
 *  경로로 들어왔든 seedRawLines 앞에서 반드시 한 번 통과시킨다.
 *
 *  왜 필요한가 — 자동생성 자막은 2줄짜리 rolling 창이라 dDurationMs 가 "다음 줄로
 *    밀려난 뒤에도 화면에 남아 있는 시간"까지 포함한다. 그래서 end 가 이웃 조각을
 *    깊이 침범한다.
 *    [실측 13 fixture: 수동 7개는 겹침 0. 자동 6개는 85~287쌍이 겹치고
 *     최대 겹침 9.30초(D8A2q3awnsU). 클램프 후 전부 0, 조각 수·본문·start 불변,
 *     중앙 길이 2.2~3.8초 유지]
 *
 *  end 는 조용히 여러 곳으로 번진다 — findLine 의 표시 판정, state.loop 의 되감기
 *    (currentTime > cur.end), 청크 구간 t1, 워커가 돌려주는 full 줄의 end.
 *    9초 부풀려진 end 는 "이 문장 반복"을 세 문장 반복으로 만든다.
 *
 *  조각을 버리지 않는 이유 — 버리면 그 시각이 어떤 줄에도 안 덮여 I5 의 구멍이
 *    된다. 길이가 0 이하인 조각도 최소 길이를 줘서 살린다.
 *
 *  @param {Segment[]} segments
 *  @param {number|null} duration  영상 길이(초). 모르면 null — 길이 클램프만 건너뛴다
 *  @returns {Segment[]} start 오름차순, 겹침 없음, 모두 end > start */
const MIN_SEG_SEC = 0.2;   // 겹침 제거 후에도 조각이 사라지지 않게 하는 하한
const TAIL_SEG_SEC = 8;    // 끝을 알 수 없는 마지막 조각의 기본 길이 (패널 수집용)
function normalizeSegments(segments, duration) {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const out = segments
    .filter((s) => Number.isFinite(s.start) && s.text)
    // 영상이 끝난 뒤에 찍힌 조각은 재생 위치가 절대 닿지 못한다. 남겨 두면
    // 길이 클램프가 end 를 start 아래로 밀어 하한 규칙이 발동하고, 그 결과
    // 영상 길이를 넘는 줄이 생긴다.
    // [실측: Twitch 채팅 트랙에서 방송 종료 후 메시지 6개]
    .filter((s) => s.start < limit)
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Number(s.end) }))
    .sort((a, b) => a.start - b.start);

  // 같은 시각에 시작하는 조각들 — 동시에 올라온 자막(채팅 등)이다. 그대로 두면
  // findLine 이 마지막 하나만 고르고 나머지는 영영 안 보이며, 아래 하한 규칙이
  // 서로 겹치는 줄을 만든다. 다음 시작 시각까지를 균등하게 나눠 각자 자리를 준다.
  // [실측: Twitch 채팅 트랙 3381조각 중 4묶음]
  for (let i = 0; i < out.length;) {
    let j = i;
    while (j + 1 < out.length && out[j + 1].start === out[i].start) j++;
    if (j > i) {
      const t0 = out[i].start;
      const n = j - i + 1;
      const room = Math.min(out[j + 1]?.start ?? Infinity, limit) - t0;
      const step = (Number.isFinite(room) && room > 0 ? room : n * MIN_SEG_SEC) / n;
      for (let k = i + 1; k <= j; k++) out[k].start = t0 + step * (k - i);
    }
    i = j + 1;
  }

  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    // end 가 Infinity 면 "다음 조각까지 늘려라"라는 뜻이다 (패널은 시작 시각만 준다).
    // NaN 은 값이 없는 것이므로 start 로 접었다가 아래 하한 규칙에 맡긴다.
    let end = Number.isNaN(out[i].end) ? out[i].start : out[i].end;
    if (next) end = Math.min(end, next.start);   // rolling 겹침 제거
    end = Math.min(end, limit);
    if (!Number.isFinite(end)) end = out[i].start + TAIL_SEG_SEC;   // 뒤도 길이도 모를 때
    // 클램프 결과가 0 이하가 되면(겹침이 아주 심하거나 길이를 넘은 조각) 하한을
    // 준다. 다음 조각 start 와 영상 끝을 넘지 않는 선에서만 — 넘으면 겹침이나
    // 길이 초과를 다시 만든다.
    // 버리지 않는 이유: 버리면 그 시각이 어떤 줄에도 안 덮여 I5 의 구멍이 된다.
    if (end <= out[i].start) {
      const room = Math.min(next ? next.start : Infinity, limit) - out[i].start;
      end = out[i].start + (room > 0 ? Math.min(MIN_SEG_SEC, room) : MIN_SEG_SEC);
    }
    out[i].end = end;
  }
  return out;
}

/** 두 언어 코드가 같은 언어인가. "en" 과 "en-US" 는 같다. */
function sameLang(a, b) {
  if (!a || !b) return false;
  const base = (x) => String(x).toLowerCase().split("-")[0];
  return base(a) === base(b);
}

function pickTrack(player) {
  const renderer = player?.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks || [];
  if (!tracks.length) return null;

  // 자동 번역으로 파생된 트랙은 원문이 아니다. 실측상 그런 트랙은 captionTracks 에
  // 아예 안 들어오지만(translationLanguages 로 따로 온다), 들어오면 걸러낸다.
  //   ★ 예전엔 vssId 가 "." 으로 시작하면 번역으로 봤는데 정반대였다. 유튜브 규약은
  //     "." = 사람이 올린 자막, "a." = ASR 이다. 그 오해 때문에 사람 자막을 전부
  //     걸러내고 늘 ASR 을 썼다.
  //     [실측 6개 영상: M7lc1UVf-VE(.en+a.en), gIwvFMiJNVU(.es+a.es),
  //      MenYHcLC16M(.ko+a.ko), R2vXbFp5C9o(.en-US+a.en) 전부 ASR 이 뽑혔다]
  const pool = tracks.filter((t) => !t.translatedLanguage);
  const cands = pool.length ? pool : tracks;

  // 원어 판정. 앞쪽일수록 근거가 강하다.
  //   ASR 트랙의 언어가 곧 원어인 이유: 자동생성 자막은 들리는 소리를 옮긴 것이다.
  const audioDefault = renderer?.audioTracks?.[0]?.defaultCaptionTrackIndex;
  const origin =
    player?.videoDetails?.defaultAudioLanguage ||
    tracks.find((t) => t.kind === "asr")?.languageCode ||
    (Number.isInteger(audioDefault) ? tracks[audioDefault]?.languageCode : null) ||
    cfg.prefer ||
    null;

  // trackName 은 업로더가 같은 언어에 여러 트랙을 올릴 때 붙이는 꼬리표다. 보통
  // 트랙은 "" 이고, 값이 있으면 "본편 자막이 아닌 무언가"다 — 채팅 로그, 코멘터리,
  // 강제 자막 같은 것들. 말소리를 원하는 우리에겐 후순위다. 다만 배제하지는
  // 않는다. 그것뿐이면 없는 것보다 낫다.
  //   [실측 6개 영상 12트랙: 정상 트랙은 전부 trackName="" 이고,
  //    "English (United States) - Twitch Chat" 만 trackName="Twitch Chat" 이었다.
  //    유튜브 자신은 이 채팅 트랙을 audioTracks 의 기본값으로 지목한다 — 그래서
  //    defaultCaptionTrackIndex 는 이 판단에 쓸 수 없다]
  const score = (t) =>
    (sameLang(t.languageCode, origin) ? 8 : 0) +
    (t.trackName ? 0 : 4) +
    (t.kind === "asr" ? 0 : 2) +
    (sameLang(t.languageCode, cfg.prefer) ? 1 : 0);

  // 동점이면 유튜브가 준 순서를 지킨다 (sort 는 안정 정렬이다)
  return cands.slice().sort((a, b) => score(b) - score(a))[0];
}

/** 스크립트 패널이 보여줄 트랙. 유튜브는 기본 자막 트랙 하나만 띄운다.
 *
 *  왜 이 함수가 필요한가 — 패널에는 트랙 전환 UI 도, 어느 트랙인지 알려주는
 *    라벨도 없다(2026-08 실측: target-id=PAmodern_transcript_view, 헤더는
 *    "Transcript" 와 닫기 버튼뿐). 그래서 긁어온 내용이 우리가 고른 트랙인지
 *    DOM 만 봐서는 알 수 없다.
 *
 *    실제로 그래서 사고가 났다. VBMUMuZBxw0 은 음성 ASR 과 "Twitch Chat" 트랙을
 *    함께 갖는데, 유튜브의 기본값이 채팅이다(defaultCaptionTrackIndex=1).
 *    ASR 의 timedtext 가 막히자 패널로 폴백했고, 채팅 로그가 자막으로 떴다.
 *
 *  @returns {object|null} 패널이 띄울 트랙. 알 수 없으면 null */
function panelTrack(player) {
  const r = player?.captions?.playerCaptionsTracklistRenderer;
  const tracks = r?.captionTracks || [];
  if (!tracks.length) return null;
  const i = r?.audioTracks?.[0]?.defaultCaptionTrackIndex;
  return Number.isInteger(i) ? (tracks[i] ?? null) : tracks[0];
}

/**
 * @typedef {object} FetchResult  자막 수집 한 경로의 결과
 * @property {Segment[]} segments  실패하면 빈 배열
 * @property {"ok"|"no-track"|"empty-body"|"http-error"|"parse-error"|"no-panel"|"panel-other-track"} reason
 *
 * 왜 빈 배열만으로는 안 되나 — "자막이 없다"와 "수집이 실패했다"가 같은 값이 되면
 *   호출부가 둘을 구분할 수 없고, 그래서 수집 실패에도 Whisper 전사가 돌았다.
 *   전사는 유료이고 사용자는 자막이 있는 영상인 줄 알므로 사고를 알아채지 못한다.
 */
async function fetchSegments(track) {
  let res;
  try {
    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");
    res = await fetch(url.toString(), { credentials: "include" });
  } catch (e) {
    return { segments: [], reason: "http-error" };
  }
  if (!res.ok) return { segments: [], reason: "http-error" };
  // 2024년부터 pot(PoToken) 없는 요청에 200 + 빈 본문을 주는 경우가 있다.
  // 이건 "자막 없음"이 아니라 "막힘"이다 — 구분해서 올려야 전사 오발동을 막는다.
  const body = await res.text();
  if (!body.trim()) return { segments: [], reason: "empty-body" };
  try {
    const segments = parseJson3Segments(JSON.parse(body));
    return segments.length
      ? { segments, reason: "ok" }
      : { segments: [], reason: "empty-body" };
  } catch {
    return { segments: [], reason: "parse-error" };
  }
}

/** "1:23:45" / "4:56" → 초. 패널은 시각을 이 형태로만 준다. */
function parseTimestamp(t) {
  const p = t.trim().split(":").map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
}

/** timedtext 가 막혔을 때: 유튜브 자체 스크립트 패널을 열어 DOM 에서 긁는다.
 *  패널은 잠깐 열렸다 닫힌다. 데스크톱 전용 — 모바일은 전사 모드로 넘어간다.
 *
 *  ★ 이 함수는 "어느 트랙인지" 고를 수 없다. 유튜브의 기본 트랙 하나만 나온다.
 *    호출 전에 panelTrack() 으로 그것이 우리가 고른 트랙인지 확인해야 한다.
 *    [2026-08 실측 (CDP 로 실제 패널을 열어 확인):
 *      · 패널 target-id = PAmodern_transcript_view
 *      · 헤더는 "Transcript" 와 닫기 버튼뿐. 트랙 전환 UI 없음
 *      · footer 는 빈 div. 어느 트랙인지 알려주는 라벨이 DOM 어디에도 없다
 *      · 패널 데이터는 POST /youtubei/v1/get_panel 로 오는데 본문이 바이너리
 *        protobuf 라 우리가 직접 만들 수 없다]
 */
async function scrapeTranscriptPanel() {
  const wasOpen = !!$("transcript-segment-view-model, ytd-transcript-segment-renderer");
  if (!wasOpen) {
    const expand = $("tp-yt-paper-button#expand, #description-inline-expander #expand");
    if (expand) { expand.click(); await new Promise((r) => setTimeout(r, 500)); }
    const btn = $("ytd-video-description-transcript-section-renderer button");
    // 버튼이 없다 = 이 영상에 패널이 없거나, 유튜브가 셀렉터를 바꿨다.
    // 둘을 여기서 구분할 방법이 없으므로 "실패"로 올린다 — captionTracks 가 있는데
    // 이쪽이 실패했다면 자막은 있는 것이고, 전사로 넘어가면 안 된다.
    if (!btn) return { segments: [], reason: "no-panel" };
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
    // 패널은 시작 시각만 준다. 끝은 normalizeSegments 가 "다음 조각의 시작"으로
    // 채운다 — 여기서 직접 계산하면 같은 규칙이 두 곳에 생겨 갈라진다.
    segments.push({ start, end: Infinity, text });
  }
  if (segments.length) {
    const last = segments[segments.length - 1];
    last.end = dur || last.start + 8;      // 마지막 조각만 뒤가 없어 따로 정한다
  }

  if (!wasOpen) {
    $('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] #visibility-button button')?.click();
  }
  return segments.length
    ? { segments, reason: "ok" }
    : { segments: [], reason: "no-panel" };
}

/** 어느 자막 원천을 쓸지 정한다. startAsr 로 가는 유일한 관문이다.
 *
 *  규칙 — captionTracks 가 비어 있을 때(그리고 라이브일 때)만 전사를 허용한다.
 *    트랙이 있는데 두 수집 경로가 모두 실패했다면 그건 "자막 없음"이 아니라
 *    "수집 실패"이고, 전사는 사고다. 사용자는 자막이 있는 영상인 줄 알기 때문에
 *    Groq 요금이 조용히 나가도 알아채지 못한다.
 *
 *  @param {object|null} player  ytInitialPlayerResponse
 *  @param {FetchResult} cap     timedtext 결과
 *  @param {FetchResult} panel   스크립트 패널 결과
 *  @returns {{kind:"captions"|"asr"|"fail", segments?: Segment[], reason: string}} */
function chooseSource(player, cap, panel) {
  // 라이브는 완결된 트랙이 없다 — 지금 이 순간까지만 존재하므로 전사로 간다
  if (player?.videoDetails?.isLive) return { kind: "asr", reason: "live" };

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (cap.reason === "ok") return { kind: "captions", segments: cap.segments, reason: "timedtext" };
  if (panel.reason === "ok") return { kind: "captions", segments: panel.segments, reason: "panel" };
  if (!tracks.length) return { kind: "asr", reason: "no-track" };

  if (panel.reason === "panel-other-track") {
    return {
      kind: "fail",
      reason: "유튜브가 이 영상의 자막 직접 내려받기를 막고 있고, " +
        "스크립트 패널은 다른 트랙을 보여줍니다 (이 영상은 채팅 로그가 기본 자막입니다)",
    };
  }
  return {
    kind: "fail",
    reason: `자막 트랙은 있는데 수집에 실패했습니다 (timedtext: ${cap.reason}, 패널: ${panel.reason})`,
  };
}

// ── 3. Worker ────────────────────────────────────────────────────────
/* 불변식 I10·I11·I12 가 걸리는 지점이다.
 *  I10  이 fetch 는 반드시 유한 타임아웃을 가진다. 없으면 멈춘 업스트림 하나가
 *       runner 슬롯을 영구 점유해 처리량이 반토막 난다.
 *  I11  재시도는 한 층에만 둔다. 여기서는 재시도하지 않는다 — start() 의 청크
 *       재큐(1회)와 워커의 3회가 이미 있고, 여기에 한 층을 더하면 곱해진다.
 *       [실측: 요청 하나가 36,960ms 걸린 뒤 degraded 로 끝난 적이 있다 — 워커가
 *        3회를 다 쓴 결과다. 여기서 또 재시도했다면 74초였다]
 *  I12  타임아웃 값 > 워커 최대 소요. 워커 LLM_TIMEOUT_MS=165초 × 3회 + 백오프
 *       3.5초 = 최대 498초. 그보다 커야 워커의 재시도가 끝나기 전에 끊지 않는다.
 *  I8   signal 은 호출자가 지역 캡처한 것을 받는다. state.abort 를 직접 읽지 않는다. */
const REQUEST_TIMEOUT_MS = 510000;   // I12: 워커 최대 소요(498초)보다 크게

/** 확장 안에서 도는가. 하네스(devtools)는 확장이 아니므로 여기가 false 다. */
const inExtension = () => !!globalThis.browser?.runtime?.id;

/**
 * 워커 API 를 호출한다. 확장 안에서는 background 를 거친다.
 *
 * 왜 직접 fetch 하면 안 되나 — content script 는 유튜브 페이지의 출처를 쓴다.
 *   브라우저는 그것을 "youtube.com 이 사설망(127.0.0.1)에 접근한다"로 보고 막는다.
 *   Zen/Firefox 는 Local Network Access 권한을 묻고, 거절하면 CORS 오류로 끝난다.
 *     Cross-Origin Request Blocked: http://127.0.0.1:8787/api/subtitle
 *   background 는 페이지 출처가 아니라 확장 출처로 요청하므로 그 판정을 받지 않는다.
 *   페이지 CSP(connect-src)를 피하려고 page.js 가 이미 쓰던 길이다.
 *
 * @param {AbortSignal|null} signal  끊기면 즉시 거절한다. background 의 요청 자체는
 *   계속 돌지만 결과를 버린다 — 중요한 것은 runner 슬롯을 즉시 놓아주는 것이다.
 *   (그 요청이 끝나면 워커가 KV 에 캐시하므로 나중에 재요청하면 0초에 온다)
 */
async function apiPost(path, body, signal = null) {
  if (!inExtension()) {
    const res = await fetch(`${cfg.endpoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`서버 ${res.status} ${detail.slice(0, 120)}`);
    }
    return res.json();
  }

  const sent = browser.runtime.sendMessage({ type: "ytdual-fetch", path, body });
  const r = await (signal
    ? Promise.race([sent, new Promise((_, rej) => {
        if (signal.aborted) return rej(new DOMException("Aborted", "AbortError"));
        signal.addEventListener("abort",
          () => rej(new DOMException("Aborted", "AbortError")), { once: true });
      })])
    : sent);
  if (!r) throw new Error("background 무응답");
  if (!r.ok) throw new Error(r.error ? `요청 실패 ${r.error}` : `서버 ${r.status}`);
  return r.data;
}

/**
 * @returns {Promise<{lines: Line[], usage?: Usage}>}
 *   usage 를 이 경로로 끌어올리지 않으면 토큰 측정이 불가능하다 — 응답 본문은
 *   이 함수 안에서 소비되므로 호출부가 따로 읽을 방법이 없다.
 */
async function requestTranslation(videoId, lang, segments, ctx = {}, signal = null) {
  // I10: 요청 1회의 타임아웃. AbortSignal.any() 는 Firefox 124+ 라 manifest 의
  //   strict_min_version 115 에서 조용히 깨진다 — 그래서 수동으로 연결한다.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort);
  }
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };

  try {
    const payload = await apiPost("/api/subtitle", {
      videoId,
      lang,
      target: cfg.target,
      segments,
      ctxBefore: ctx.before || [],   // 청크 경계에서도 번역이 이어지게
      ctxAfter: ctx.after || [],
    }, ctl.signal);
    const lines = payload?.lines;
    if (!Array.isArray(lines) || !lines.length) throw new Error("빈 응답");
    return { lines, usage: payload.usage };
  } finally {
    cleanup();
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

/* 이것만 직접 fetch 한다. 오디오 Blob 은 runtime.sendMessage 로 보낼 수 없다
 * (Chrome 은 구조화 복제가 아니라 JSON 직렬화를 쓴다). 자막 트랙이 아예 없는
 * 영상에서만 도는 경로이고, 그때 사설망 권한을 한 번 물을 수 있다. */
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
  segments = normalizeSegments(segments, null);   // 전사분도 같은 규칙을 통과시킨다
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
    await apiPost("/api/cards", { uid: cfg.uid, cards: batch });
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

  popEl = make("div", { id: "ytdual-pop", on: { click: (e) => e.stopPropagation() } }, [
    make("div", { id: "ytdual-pop-word", text: word }),
    make("div", { id: "ytdual-pop-meaning", text: "⏳ 뜻 찾는 중…" }),
    make("div", { id: "ytdual-pop-base" }),
    make("div", { id: "ytdual-pop-actions" }, [
      make("button", {
        id: "ytdual-pop-save", text: "문장과 함께 저장",
        on: { click: () => { saveCard(word); wEl.classList.add("saved"); closeWordPop(); } },
      }),
      make("button", { id: "ytdual-pop-close", text: "닫기", on: { click: closeWordPop } }),
    ]),
  ]);
  document.body.appendChild(popEl);

  const place = () => {
    const r = wEl.getBoundingClientRect();
    popEl.style.left =
      Math.max(8, Math.min(window.innerWidth - popEl.offsetWidth - 8, r.left + r.width / 2 - popEl.offsetWidth / 2)) + "px";
    popEl.style.top = Math.max(8, r.top - popEl.offsetHeight - 10) + "px";
  };
  place();

  try {
    const d = await apiPost("/api/word", { word, sentence, target: cfg.target });
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
  box = make("div", { id: "ytdual-box" }, [
    make("div", { id: "ytdual-orig" }),
    make("div", { id: "ytdual-trans" }),
  ]);

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
    start: s.start, end: s.end, orig: s.text, trans: "", translated: false,
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
 *    I4  제거 대상은 아직 번역 안 된 줄뿐이다. 남이 번역해 넣은 줄은 건드리지
 *        않는다 — 청크는 뒤섞인 순서로 도착한다.                          [실측]
 *    I5  제거한 것은 반드시 덮는다. 조용한 빈 구간이 없다.
 *    I23 각 조각의 제거 책임은 정확히 한 청크에만 있다.
 *
 *  제거 조건이 "완전히 포함"인 것이 I5 의 핵심이다. start 만 보면 t1 직전에
 *    시작해 t1 이후에 끝나는 이웃 조각까지 지워지고, 새 줄은 t1 까지만 덮으므로
 *    그 뒤가 빈다. [실측: start 기준일 때 중간 상태에서 빈 시각 4개]
 *
 *  ★ 호출자 계약 — 같은 청크로 두 번 부르면 안 된다. I4 때문에 이미 번역된 줄이
 *    살아남아 같은 구간이 두 벌 쌓인다. start() 의 runner 는 성공한 청크를
 *    pending 에 되돌리지 않으므로 이 계약이 지켜진다.
 *
 *  @param {Line[]} lines  워커가 돌려준 번역 줄
 *  @param {number} t0     교체할 구간의 시작(초)
 *  @param {number} t1     교체할 구간의 끝(초)
 *  @returns {void} */
function mergeTranslated(lines, t0, t1) {
  // 제거 조건이 "완전히 포함"인 것이 I5 의 핵심이다. start 만 보면 t1 직전에 시작해
  // t1 이후에 끝나는 이웃 조각까지 지워지고, 새 줄은 t1 까지만 덮으므로 그 뒤가 빈다.
  // end <= t1 로 좁히면 각 조각은 자기를 소유한 청크에만 지워진다 (I23).
  // 아직 번역 안 된 원문 줄만 대상이다. 남이 번역해 넣은 줄은 건드리지 않는다 (I4) —
  // 청크는 뒤섞인 순서로 도착하므로 이 구분이 없으면 남의 결과를 지운다.
  const kept = state.lines.filter((l) => !(!l.translated && l.start >= t0 && l.end <= t1));
  const stamped = lines.map((l) => ({ ...l, translated: true }));
  state.lines = kept.concat(stamped).sort((a, b) => a.start - b.start);  // I2
  state.idx = -2;
}

/* ── 번역 작업 스케줄링 ──────────────────────────────────────────────
 * 순수 함수로 빼 둔 이유: start() 안에 두면 브라우저 하네스와 테스트가 같은
 * 로직을 베껴 갖게 되고, 베낀 순간부터 둘이 갈라진다. 여기 있으면 실코드를
 * 그대로 부를 수 있다. */

/**
 * @typedef {object} Job  번역 작업 하나. segments 의 연속 구간이며 시간 구간
 *   [t0,t1] 을 소유한다. 구간이 서로 겹치지 않는 한 mergeTranslated 가 각자
 *   자리만 교체하므로, 작업을 쪼개도 병합이 서로를 침범하지 않는다.
 * @property {number}    i0    segments 에서의 시작 인덱스
 * @property {Segment[]} segs
 * @property {number}    t0
 * @property {number}    t1
 */

/** @returns {Job} */
function makeJob(i0, segs) {
  return { i0, segs, t0: segs[0].start, t1: segs[segs.length - 1].end };
}

/* 작업 경계를 문장 끝에 맞추는 데 쓴다. 워커의 SENTENCE_END 와 같은 규칙이다 —
 * 파일이 갈라져 있어 상수를 공유할 수 없으므로 둘을 함께 고쳐야 한다. */
const JOB_SENTENCE_END = /[.!?…。？！]["'”’)\]]?$/;

/**
 * segments 를 size 조각씩 잘라 작업 목록을 만든다.
 *
 * 정확히 size 로 자르지 않고 문장 끝에 맞춘다. 작업 경계가 문장 중간을 자르면
 * 그 줄의 번역이 반쪽 난다 — 워커는 작업 안에서만 묶을 수 있어 경계 너머를 못 본다.
 *   [실측 VBMUMuZBxw0: 아무 데서나 잘린 묶음 351개 중 146개(42%)가 작업 경계였다]
 * size 의 ±40% 안에서 가장 가까운 문장 끝을 찾고, 없으면 원래 자리에서 자른다.
 *
 * @returns {Job[]} segments 를 빈틈없이, 겹치지 않게 덮는다
 */
function makeJobs(segments, size) {
  const jobs = [];
  const near = Math.max(1, Math.round(size * 0.4));
  let i = 0;
  while (i < segments.length) {
    let end = Math.min(i + size, segments.length);
    if (end < segments.length) {
      for (let d = 0; d <= near; d++) {
        const cands = d === 0 ? [i + size] : [i + size - d, i + size + d];
        const hit = cands.find((c) =>
          c > i && c <= segments.length && JOB_SENTENCE_END.test(segments[c - 1].text));
        if (hit) { end = hit; break; }
      }
    }
    jobs.push(makeJob(i, segments.slice(i, end)));
    i = end;
  }
  return jobs;
}

/** 재생 위치가 이 작업 구간 안인가. 5초 선행은 "곧 닿는다"로 본다. */
function isPlayingJob(j, t) {
  return t >= j.t0 - 5 && t <= j.t1;
}

/**
 * 다음에 번역할 작업을 고른다. 고정 순서가 아니라 "매번" 현재 재생 위치로 다시
 * 고른다 — 시킹해도 다음 요청부터 그 지점이 최우선이 된다.
 * @returns {{job: Job, playing: boolean}|null}
 */
function pickJob(pending, t) {
  let best = null, bestScore = Infinity;
  for (const j of pending) {
    const sc = isPlayingJob(j, t) ? -1     // 지금 재생 중인 작업 최우선
      : j.t0 >= t ? j.t0 - t               // 앞쪽은 가까운 순서
      : 1e6 + (t - j.t0);                  // 지나간 쪽은 맨 뒤
    if (sc < bestScore) { bestScore = sc; best = j; }
  }
  return best && { job: best, playing: bestScore === -1 };
}

/**
 * 재생 중인 작업을 "지금 보는 몇 조각"과 나머지로 쪼갠다.
 *
 * 지연은 출력 토큰이 만든다 — 조각이 적을수록 빨리 온다.
 *   [실측 VBMUMuZBxw0 재생 지점 부근 5회: N=3 2.3초 / N=4 3.1초 / N=8 4.4초 /
 *    N=12 5.9초. 입력 토큰은 608→688 로 거의 안 변한다 (문맥이 대부분이라)]
 * 그래서 배경은 큰 조각으로 효율을 취하고, 지금 보고 있는 구간만 잘게 잘라
 * 먼저 띄운다. 셋 다 시간 구간이 겹치지 않으므로 병합이 안전하다.
 *
 * @returns {{head: Job, rest: Job[]}} 쪼갤 필요가 없으면 head 가 원본이고 rest 는 빈 배열
 */
function splitJobAt(job, t, size) {
  if (job.segs.length <= size) return { head: job, rest: [] };
  let p = job.segs.findIndex((s) => s.end >= t);
  if (p < 0) p = 0;
  const head = makeJob(job.i0 + p, job.segs.slice(p, p + size));
  const rest = [];
  if (p > 0) rest.push(makeJob(job.i0, job.segs.slice(0, p)));
  if (p + size < job.segs.length) rest.push(makeJob(job.i0 + p + size, job.segs.slice(p + size)));
  return { head, rest };
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
  for (const fn of state.cleanups.splice(0)) { try { fn(); } catch {} }
  const cleanups = state.cleanups;
  const sig = state.abort.signal;             // I8: 지역 캡처 (stop() 이 state.abort 를 비운다)
  state.perf = {
    t0: performance.now(), tPlayer: 0, tSegs: 0, tFirstPaint: 0, tFirstTrans: 0,
    chunkMs: [], segsPerChunk: 0, tokens: [],
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

    const live = !!player?.videoDetails?.isLive;
    const track = live ? null : pickTrack(player);
    let cap = { segments: [], reason: "no-track" };
    let panel = { segments: [], reason: "no-panel" };
    if (track) {
      showStatus("자막 불러오는 중", true);
      cap = await fetchSegments(track)
        .catch((e) => (log("timedtext 실패", e.message), { segments: [], reason: "http-error" }));
      if (cap.reason !== "ok") {
        // 패널은 유튜브의 기본 트랙만 보여준다. 우리가 고른 것과 다르면 긁어봐야
        // 다른 자막이 온다 — 채팅 로그를 자막으로 띄우느니 실패가 낫다.
        if (panelTrack(player) !== track) {
          log(`timedtext 실패(${cap.reason}) → 패널은 다른 트랙이라 건너뜀`);
          panel = { segments: [], reason: "panel-other-track" };
        } else {
          log(`timedtext 실패(${cap.reason}) → 스크립트 패널에서 수집`);
          panel = await scrapeTranscriptPanel()
            .catch((e) => (log("패널 수집 실패", e.message), { segments: [], reason: "no-panel" }));
        }
      }
    }

    // startAsr 로 가는 유일한 관문. 조건을 여기 밖에 두면 "수집 실패인데 전사"가
    // 다시 살아난다 (test/asr-guard.test.js 가 호출부 개수까지 검사한다).
    const src = chooseSource(player, cap, panel);
    if (src.kind === "asr") { startAsr(); return; }
    if (src.kind === "fail") {
      // 여기서 전사로 넘어가지 않는다. 자막이 있는 영상이므로 사용자에게 알리고 멈춘다.
      log("자막 수집 실패", src.reason);
      showStatus(`오류: ${src.reason}`);
      state.active = false;
      syncBar();
      return;
    }
    let segments = src.segments;

    // 어느 경로로 들어왔든 여기서 한 번 시간을 정리한다. 자동생성 자막의 rolling
    // 겹침(실측 최대 9.30초)을 여기서 안 걷으면 end 가 findLine·state.loop·청크 t1·
    // 워커 응답까지 그대로 번진다.
    {
      const v = $("video");
      segments = normalizeSegments(segments, v && isFinite(v.duration) ? v.duration : null);
    }

    state.perf.tSegs = performance.now() - state.perf.t0;
    seedRawLines(segments);        // I1: 이 시점부터 화면은 비지 않는다
    // 우리 원문이 뜬 뒤에야 유튜브 native 자막을 숨긴다 (I14: 클래스 하나만 붙이고
    // 유튜브 요소는 직접 고치지 않는다). 앞에서 끄면 원문 확보를 기다리는 동안
    // 화면에 자막이 하나도 없게 된다.
    document.documentElement.classList.add("ytdual-on");

    // 긴 자막을 한 요청으로 보내면 응답까지 몇 분씩 걸려 연결이 끊긴다.
    // 작은 청크로 나눠, "지금 보고 있는 지점"부터 번역해 바로 띄우고 나머지는
    // 백그라운드로 채운다. 이웃 세그먼트는 문맥(CTX)으로 함께 보낸다.
    // 재생 지점 우선 슬라이스의 근거는 splitJobAt 주석 참조.
    const TRANSLATE_CHUNK = 12;
    const PRIORITY_SLICE = 4;     // 재생 지점을 덮는 몇 조각을 먼저 번역할지
    state.perf.segsPerChunk = TRANSLATE_CHUNK;
    const CTX_N = 8;

    const pending = new Set(makeJobs(segments, TRANSLATE_CHUNK));
    let total = pending.size;
    const playhead = () => $("video")?.currentTime || 0;

    // 시킹하면 지금 보는 곳과 무관해진 요청을 끊는다. 안 끊으면 runner 8개가
    // 옛 재생 위치 작업을 붙잡고 있어, 새 지점은 하나가 빌 때까지 기다린 뒤에야
    // 발사된다 — 실측상 그것이 시킹 지연의 절반이었다 (9.2초 → 4.8초).
    /** @type {Map<object, AbortController>} */
    const inflight = new Map();
    const onSeek = () => {
      const t = playhead();
      for (const [j, ctl] of inflight) if (!isPlayingJob(j, t)) ctl.abort();
    };
    $("video")?.addEventListener("seeked", onSeek);
    cleanups.push(() => $("video")?.removeEventListener("seeked", onSeek));

    // showStatus 없음 — 원문이 이미 떠 있는데 덮어쓰면 I1 위반
    let done = 0, failed = 0;
    const retried = new Set();     // 작업당 실패 재큐 1회 한정 (I5)
    const runner = async () => {
      for (;;) {
        if (state.gen !== myGen || !state.active) return;   // I6
        const picked = pickJob(pending, playhead());
        if (!picked) return;
        let j = picked.job;
        pending.delete(j);
        if (picked.playing) {
          const { head, rest } = splitJobAt(j, playhead(), PRIORITY_SLICE);
          for (const r of rest) { pending.add(r); total++; }
          j = head;
        }
        // 이 작업만 끊을 수 있는 손잡이. 세션 전체 중단(sig)과 함께 건다.
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        sig.addEventListener("abort", onAbort);
        inflight.set(j, ctl);
        const tReq = performance.now();
        try {
          const res = await requestTranslation(videoId, track.languageCode, j.segs, {
            before: segments.slice(Math.max(0, j.i0 - CTX_N), j.i0).map((s) => s.text),
            after: segments.slice(j.i0 + j.segs.length, j.i0 + j.segs.length + CTX_N).map((s) => s.text),
          }, ctl.signal);
          if (state.gen !== myGen || !state.active) return;   // I6
          // 두 배열은 같은 인덱스로 정렬된다 — 어긋나면 "이 지연이 이 토큰에서
          // 나왔다"는 대응이 깨진다. usage 없는 작업은 0 이 아니라 null (해당 없음).
          state.perf.chunkMs.push(Math.round(performance.now() - tReq));
          state.perf.tokens.push(res.usage?.completion_tokens ?? null);
          mergeTranslated(res.lines, j.t0, j.t1);            // I2·I4·I5·I23
          done++;
          if (!state.perf.tFirstTrans) state.perf.tFirstTrans = performance.now() - state.perf.t0;
          log(`번역 ${done}/${total} (${state.lines.length}줄)`);
        } catch (e) {
          if (sig.aborted || state.gen !== myGen) return;     // 세션 종료는 실패가 아니다
          // 시킹으로 끊긴 작업은 실패가 아니다 — 그 자리로 돌아오면 다시 번역한다
          if (ctl.signal.aborted) { pending.add(j); continue; }
          if (!retried.has(j)) { retried.add(j); pending.add(j); continue; }
          failed++;
          log(`번역 작업 실패 (${failed}번째)`, e.message);
        } finally {
          inflight.delete(j);
          sig.removeEventListener("abort", onAbort);
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
    if (failed) toast(`번역 ${failed}개 구간 실패`);
    const p = state.perf;
    log(`준비 완료: ${state.lines.length}줄`, {
      tPlayer: Math.round(p.tPlayer), tSegs: Math.round(p.tSegs),
      tFirstPaint: Math.round(p.tFirstPaint), tFirstTrans: Math.round(p.tFirstTrans),
      chunkMedian: p.chunkMs.slice().sort((a, b) => a - b)[p.chunkMs.length >> 1],
      tAllDone: Math.round(performance.now() - p.t0), jobs: total, failed,
      segsPerChunk: p.segsPerChunk,
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
  for (const fn of state.cleanups.splice(0)) { try { fn(); } catch {} }
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
  const bar = make("div", { id: "ytdual-bar" }, [
    make("button", {
      id: "ytdual-btn-toggle", title: "이중 자막 켜기/끄기 (Alt+Y)", text: "자막",
      on: { click: toggle },
    }),
    make("button", {
      id: "ytdual-btn-opts", title: "설정", text: "⚙",
      on: { click: () => browser.runtime.sendMessage({ type: "ytdual-open-options" }) },
    }),
  ]);
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
