// ── INVARIANTS (Session 1) ─────────────────────────────────────────────
// I1. 오버레이는 항상 최대 1개. overlayEl이 유일한 진실 — mountOverlay는
//     overlayEl이 있으면 반드시 그것을 반환하고 새로 만들지 않는다.
//     (재주입·SPA 네비게이션 후에도 유지)
// I2. YouTube의 DOM은 읽기 전용. 쓰기는 우리 overlayEl 서브트리에만 한다.
// I3. Session 1 코드는 네트워크 요청 0건, 스토리지 사용 0건.
// I4. 이 스크립트의 어떤 예외도 페이지로 전파되지 않는다 —
//     진입점 전체를 try/catch로 감싼다.
// ───────────────────────────────────────────────────────────────────────

// Session 1 state — the only data this session needs.
// Reference to our mounted overlay element; null until mounted.
// Single source of truth for invariant I1 ("at most one overlay").
let overlayEl = null;

/**
 * @returns {Element|null} YouTube 플레이어 컨테이너, 못 찾으면 null
 */
function findPlayer() {
  // TODO(phase6): YouTube 플레이어 컨테이너(#movie_player)를 DOM에서 조회해 반환. 로드 타이밍상 없으면 null.
  throw new Error("unimplemented");
}

/**
 * @param {Element} player - 오버레이를 부착할 플레이어 컨테이너
 * @returns {HTMLElement} 오버레이 요소 (이미 있으면 기존 overlayEl 반환)
 */
function mountOverlay(player) {
  // TODO(phase6): overlayEl이 이미 있으면 그대로 반환(불변식 1: 오버레이 최대 1개).
  // 없으면 div 생성, overlay.css 클래스 부여, player에 append, overlayEl에 저장.
  throw new Error("unimplemented");
}

/**
 * @param {(text: string) => void} onText - 네이티브 CC 텍스트 변경 시 호출
 * @returns {void}
 */
function observeCaptions(onText) {
  // TODO(phase6): 네이티브 자막 영역(.ytp-caption-window-container 계열)을 MutationObserver로 감시,
  // .ytp-caption-segment 텍스트를 합쳐 변경 시 onText 호출. 자막 영역이 늦게 생기므로 상위에서 관찰 시작.
  // YouTube DOM은 읽기만(불변식 2).
  throw new Error("unimplemented");
}

/**
 * @param {string} text - 표시할 자막 텍스트, 빈 문자열이면 오버레이 숨김
 * @returns {void}
 */
function render(text) {
  // TODO(phase6): overlayEl.textContent에 text 반영. 빈 문자열이면 오버레이 숨김(display:none 토글).
  throw new Error("unimplemented");
}

// TODO(phase6): 진입점 와이어링 — findPlayer 폴링/대기 → mountOverlay → observeCaptions(render).
// SPA 네비게이션(yt-navigate-finish) 후에도 오버레이 1개 유지(불변식 1).
// 전체를 try/catch로 감싸 페이지를 깨뜨리지 않음(불변식 4).
