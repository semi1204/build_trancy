/* YT Dual — 페이지 세계 브리지
 *
 * ★ Phase 1: 자료구조 정의뿐이다. 동작하는 코드는 아직 없다 (Phase 2 에서 붙는다).
 *   지금 이 파일은 manifest 에 등록되어 있지 않다 — 아무 데서도 로드되지 않는다.
 *
 * 왜 파일이 따로 있어야 하나
 *   content script 는 격리 세계(isolated world)에서 돈다. 거기서는 페이지가 만든
 *   객체를 볼 수 없다. document.querySelector('#movie_player') 로 엘리먼트 자체는
 *   잡히지만, 거기 달린 getAudioTrack() 같은 페이지 소유 메서드는 undefined 다.
 *   이건 노력으로 우회할 수 있는 제약이 아니라 브라우저가 세운 경계다.
 *   그래서 페이지 세계에서 도는 스크립트가 하나 필요하고, 그것이 이 파일이다.
 *   (파일을 나누는 유일한 이유가 "세계가 다르다"라는 점을 분명히 해 둔다. 층을
 *    하나 더 만들려는 게 아니다.)
 *
 * 왜 지금 필요해졌나
 *   유튜브는 pot(PoToken) 없는 timedtext 요청에 200 + 빈 본문을 준다.
 *   우리가 쓰는 ytInitialPlayerResponse 의 captionTracks[].baseUrl 은 정적 응답이라
 *   pot 이 없다. 반면 플레이어가 오디오 트랙을 초기화한 뒤 노출하는
 *     #movie_player.getAudioTrack().captionTracks[].url
 *   에는 런타임 pot 이 붙어 있다. 같은 트랙인데 URL 이 다르다.
 *
 *   [근거: asbplayer extension/src/entrypoints/youtube-page.ts 원문 확인.
 *    소스 주석 — "YouTube's player exposes caption URLs after it has initialized
 *    the audio track. These URLs can include runtime-only params such as POT that
 *    are not available in ytInitialPlayerResponse or sessionStorage."
 *    PR #978 (2026-05-02) — "Include YouTube's current web client identity on
 *    POT-gated timedtext requests to avoid empty 200 responses."]
 *
 *   ★ 이건 남의 코드에서 읽은 것이지 우리가 확인한 것이 아니다. Phase 4 의
 *     H2(pot 이 실제로 있는가) 와 H3(pot + json3 가 본문을 주는가) 가 확인한다.
 *     H3 가 실패하면 이 파일의 전제가 무너진다.
 *
 * 이 파일이 절대 하지 않는 것 (Phase 5 에서 불변식으로 고정한다)
 *   · 트랙을 고르지 않는다. 무엇이 좋은 트랙인지 판단하지 않는다.
 *   · 자막을 받아오지 않는다. 번역하지 않는다.
 *   · 오직 "페이지가 지금 알고 있는 것"을 그대로 보고한다.
 *
 *   판단을 두 세계로 나누면 node 테스트가 실물의 절반만 보게 된다. 트랙 선택은
 *   content.js 의 pickTrack 에 남는다 — vssId 규약을 거꾸로 알고 있던 결함과
 *   Twitch Chat 오선택을 잡아낸 코드이고, 지금 104개 테스트가 지키고 있다.
 *   여기서 트랙을 골라 보내면 그 테스트가 전부 헛것이 된다.
 */

/**
 * @typedef {object} RawTrack  페이지 세계에서 본 자막 트랙 하나. 가공하지 않는다.
 *
 * ★ 이 모양은 아직 확정이 아니다. playerResponse 의 captionTracks 와
 *   #movie_player.getAudioTrack().captionTracks 는 서로 다른 필드를 준다.
 *   asbplayer 가 라벨 하나를 뽑으려고 네 군데를 훑는 것이 그 증거다:
 *     track.name?.simpleText || track.name?.runs?.[0]?.text
 *       || track.displayName || track.languageName || track.languageCode
 *   displayName·languageName 은 playerResponse 에 없는 필드다. 즉 런타임 트랙은
 *   우리가 아는 모양이 아니다.
 *
 * @property {string}  url          런타임 URL. pot 이 붙어 있을 수 있다. 이 파일의 존재 이유
 * @property {string} [baseUrl]     정적 URL. 런타임 트랙에는 없을 수 있다
 * @property {string}  languageCode "en" · "ko" · "en-US"
 * @property {boolean} hasPot       url 쿼리에 pot 이 있는가. 폴링 종료 조건이자 H2 의 관측값
 *
 * 아래 넷은 pickTrack 이 판단에 쓰는 필드다. 런타임 트랙에 들어 있는지 확인되지
 * 않았다 — Phase 4 의 H4 가 확인한다. 없으면 undefined 로 오고, 그 경우 대조는
 * languageCode 로 내려간다. 이 불확실성이 "런타임 목록으로 pickTrack 을 돌리지
 * 않고 URL 조회표로만 쓴다"는 설계의 근거다.
 * @property {string} [vssId]              "." = 사람이 올린 자막, "a." = ASR (거꾸로 알기 쉬움)
 * @property {string} [kind]               "asr" 이면 자동생성
 * @property {string} [trackName]          보통 "". 값이 있으면 채팅·코멘터리 같은 부속 트랙
 * @property {string} [translatedLanguage] 있으면 자동 번역 파생 트랙 — 원문이 아니다
 */

/**
 * @typedef {"ok"|"no-player"|"no-tracks"|"no-pot"|"timeout"|"video-changed"} PageDataReason
 *
 * 왜 빈 배열 하나로는 안 되나 — "이 영상엔 자막이 없다"와 "플레이어가 아직 준비되지
 *   않았다"가 같은 값이 되면 content.js 가 다음 수를 고를 수 없다. 우리는 이미 똑같은
 *   실수를 한 적이 있다: 수집 실패와 자막 없음을 구분하지 않아 유료 전사가 오발동했다
 *   (content.js 의 FetchResult 주석 참조). 그래서 여기서도 처음부터 이유를 나눈다.
 *
 *   ok             pot 붙은 런타임 트랙을 얻었다
 *   no-player      #movie_player 가 없다. watch 페이지가 아니거나 아직 안 떴다
 *   no-tracks      플레이어는 있는데 captionTracks 가 비었다 — 진짜 자막 없음일 수 있다
 *   no-pot         트랙은 있는데 pot 붙은 url 이 하나도 없다. 정적 경로로 강등한다
 *   timeout        제한 시간 안에 준비되지 않았다
 *   video-changed  뽑는 도중 videoId 가 바뀌었다. 이 응답은 통째로 버려야 한다
 *
 * ★ no-tracks 를 "자막 없음"으로 곧장 믿으면 안 된다. 전사(유료)로 가는 판단은
 *   여전히 content.js 의 chooseSource 가 playerResponse 를 보고 내린다.
 */

/**
 * @typedef {object} PageData  페이지 세계 → content script 로 건너가는 유일한 자료
 *
 * player 를 함께 싣는 이유 — 페이지 세계에서는 window.ytInitialPlayerResponse 를
 *   그냥 읽을 수 있다. 지금 content.js 는 같은 것을 얻으려고 watch 페이지 HTML 을
 *   통째로 다시 내려받는다(fetchPlayerResponse). 브리지가 서면 그 왕복이 사라진다.
 *   즉 이 필드는 덤이 아니라 pot 과 함께 얻는 두 번째 이득이다.
 *
 * @property {string}         videoId  뽑을 당시의 videoId. 받는 쪽이 대조해서 버릴 수 있게
 * @property {string}         title    videoDetails.title. 없으면 ""
 * @property {RawTrack[]}     tracks   런타임 트랙. 못 얻었으면 빈 배열
 * @property {object|null}    player   window.ytInitialPlayerResponse. 못 읽었으면 null
 * @property {PageDataReason} reason
 */

/* 두 세계를 잇는 채널 이름.
 *
 * CustomEvent 를 쓰는 이유 — window.postMessage 와 달리 같은 문서 안에서만 오간다.
 *   다른 프레임이나 사이트가 끼어들 수 없다. asbplayer 도 같은 선택을 했다
 *   ('asbplayer-get-synced-data' / 'asbplayer-synced-data').
 *
 * ★ 이 두 문자열은 content.js 에도 같은 값으로 있어야 한다. 세계가 다르면 import 가
 *   불가능하므로 중복이 불가피하다 — 이 저장소에서 값이 두 곳에 사는 몇 안 되는
 *   자리다. 한쪽만 고치면 브리지는 오류 없이 조용히 죽고, 증상은 "가끔 자막이 안 뜬다"
 *   로만 보인다. Phase 2 에서 두 값이 같은지 정적 검사로 고정한다.
 */
const YTDUAL_PAGE_REQ = "ytdual-get-page-data";
const YTDUAL_PAGE_RES = "ytdual-page-data";

/* ── Phase 2: 시그니처만. 본문은 Phase 6 에서 채운다 ───────────────── */

/** 지금 보고 있는 영상의 id. 페이지 세계에도 location 은 그대로 있다.
 *  @returns {string|undefined} watch 페이지가 아니면 undefined */
function inferVideoId() {
  // TODO(phase6): location.search 의 v 파라미터. watch 페이지만 다루므로
  //   shorts/embed 경로는 보지 않는다 (필요해지면 그때).
  throw new Error("not implemented");
}

/** window.ytInitialPlayerResponse 를 읽되, 지금 이 영상의 것일 때만 준다.
 *
 *  ★ 이 전역은 SPA 이동 뒤에도 갱신되지 않을 수 있다 — 처음 연 영상의 데이터가
 *    그대로 남는다. 검사 없이 쓰면 다른 영상의 트랙 목록으로 자막을 고르게 된다.
 *    지금의 fetchPlayerResponse 는 watch 페이지를 매번 새로 받으므로 이 문제가
 *    없다. 즉 이 함수가 버는 것은 "네트워크 왕복 한 번"이고, 그 대가가 이 검사다.
 *    검사를 빼면 왕복을 아끼려다 엉뚱한 자막을 띄운다.
 *
 *  @param {string} videoId  대조 기준. 어긋나면 null 을 준다
 *  @returns {object|null} */
function readPlayerResponse(videoId) {
  // TODO(phase6): window.ytInitialPlayerResponse 를 읽고
  //   videoDetails.videoId === videoId 일 때만 돌려준다. 어긋나면 null (I28).
  throw new Error("not implemented");
}

/** 플레이어가 초기화될 때까지 기다렸다가 런타임 자막 트랙을 읽는다.
 *
 *  #movie_player.getAudioTrack() 은 페이지 소유 메서드라 격리 세계에서 부를 수
 *  없다 — 이 파일이 존재하는 유일한 이유다.
 *
 *  왜 기다려야 하나 — 트랙은 플레이어가 오디오 트랙을 초기화한 뒤에야 나타나고,
 *    pot 은 그보다 더 늦게 붙는다. 그래서 종료 조건은 "트랙이 있다"가 아니라
 *    "pot 붙은 트랙이 있다"여야 한다. 전자로 잡으면 pot 없는 URL 을 집어 와서
 *    지금과 똑같이 빈 본문을 받는다.
 *
 *  폴링 헬퍼를 따로 만들지 않는다 — 부르는 곳이 여기 하나뿐이다.
 *
 *  @param {string} videoId  뽑는 도중 영상이 바뀌었는지 볼 기준
 *  @returns {Promise<{tracks: RawTrack[], reason: PageDataReason}>}
 *
 *  ★ 계획에는 반환을 RawTrack[]|null 로 적었으나 그러면 이유가 사라진다.
 *    no-tracks(진짜 자막 없는 영상)와 timeout(아직 준비 안 됨)은 받는 쪽이 전혀
 *    다르게 다뤄야 한다 — 전자는 전사 후보, 후자는 단순 강등이다. 둘을 null 로
 *    뭉치면 FetchResult 에서 이미 저질렀던 실수(수집 실패와 자막 없음을 같은 값으로
 *    만들어 유료 전사가 오발동)를 새 자리에서 반복하게 된다. */
async function runtimeTracks(videoId) {
  // TODO(phase6): #movie_player 를 찾아 getAudioTrack().captionTracks 를 읽는다.
  //   pot 붙은 url 이 하나라도 나올 때까지 짧은 간격으로 다시 보고, 상한을 넘기면
  //   timeout 으로 보고한다 (I26). 이유 구분은 no-player / no-tracks / no-pot /
  //   timeout / video-changed 다 — 하나로 뭉치지 않는다.
  //   ★ 트랙을 고르지 않는다. 정렬도 하지 않는다. 본 대로 보고한다 (I29).
  throw new Error("not implemented");
}

/** 페이지가 지금 알고 있는 것을 한 덩어리로 모은다. 판단은 하지 않는다.
 *
 *  마지막에 videoId 를 다시 확인해야 한다 — 모으는 사이에 SPA 이동이 일어나면
 *  이 결과는 다른 영상의 것이다. (asbplayer 도 같은 자리에서 같은 검사를 한다.)
 *
 *  @returns {Promise<PageData>} 실패해도 예외를 던지지 않는다. reason 에 담아 보낸다 */
async function collectPageData() {
  // TODO(phase6): inferVideoId → runtimeTracks → readPlayerResponse 를 모아
  //   PageData 하나로 만든다. 마지막에 inferVideoId() 를 다시 불러 처음 값과
  //   다르면 reason 을 video-changed 로 바꾼다 (I28).
  throw new Error("not implemented");
}

/** 요청 이벤트를 듣고 collectPageData 결과를 돌려보낸다.
 *
 *  Phase 6 에서 이 파일 맨 아래가 이 함수를 한 번 호출한다. 지금은 아무도 부르지
 *  않고, manifest 에도 이 파일이 없다 — 즉 현재 확장 동작에 영향이 0 이다.
 *
 *  ★ asbplayer 는 여기에 500ms setInterval 을 두어 Shorts 의 영상 전환을 따라간다.
 *    우리는 watch 페이지만 다루고 SPA 이동은 content.js 의 watchNavigation 이 이미
 *    잡는다. 필요해지기 전에는 만들지 않는다.
 *
 *  @returns {void} */
function installBridge() {
  // TODO(phase6): YTDUAL_PAGE_REQ 리스너를 달고, collectPageData() 결과를
  //   YTDUAL_PAGE_RES CustomEvent 의 detail 로 dispatch 한다. 예외가 나도
  //   반드시 응답한다 — 응답이 없으면 content.js 는 타임아웃까지 기다린다.
  // TODO(phase6): 이 파일 맨 아래에서 installBridge() 를 한 번 호출한다.
  //   그 호출이 이 파일의 유일한 top-level 실행이다.
  throw new Error("not implemented");
}
