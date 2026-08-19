// Session 1 state — the only data this session needs.
// Reference to our mounted overlay element; null until mounted.
// Single source of truth for the "at most one overlay" invariant.
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
  throw new Error("unimplemented");
}

/**
 * @param {string} text - 표시할 자막 텍스트, 빈 문자열이면 오버레이 숨김
 * @returns {void}
 */
function render(text) {
  throw new Error("unimplemented");
}
