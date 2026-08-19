// ── INVARIANTS (Session 1) ─────────────────────────────────────────────
// I1. 오버레이는 항상 최대 1개. overlayEl이 유일한 진실 — mountOverlay는
//     overlayEl이 살아 있으면(isConnected) 반드시 그것을 반환하고 새로
//     만들지 않는다. (재주입·SPA 네비게이션 후에도 유지)
// I2. YouTube의 DOM은 읽기 전용. 쓰기는 우리 overlayEl 서브트리에만 한다.
// I3. Session 1 코드는 네트워크 요청 0건, 스토리지 사용 0건.
// I4. 이 스크립트의 어떤 예외도 페이지로 전파되지 않는다 —
//     진입점 전체를 try/catch로 감싼다.
// I5. MutationObserver는 문서당 정확히 1개, 안정 루트(document.body)에
//     부착한다. 플레이어 노드는 SPA 네비게이션 시 재생성되므로 거기에
//     붙인 옵저버는 죽는다. (Phase 4 실측, T6)
// ───────────────────────────────────────────────────────────────────────

// Session 1 state — the only data this session needs.
// Reference to our mounted overlay element; null until mounted.
// Single source of truth for invariant I1 ("at most one overlay").
let overlayEl = null;

/**
 * @returns {Element|null} YouTube 플레이어 컨테이너, 못 찾으면 null
 */
function findPlayer() {
  return document.getElementById("movie_player");
}

/**
 * @param {Element} player - 오버레이를 부착할 플레이어 컨테이너
 * @returns {HTMLElement} 오버레이 요소 (이미 있으면 기존 overlayEl 반환)
 */
function mountOverlay(player) {
  if (overlayEl && overlayEl.isConnected) return overlayEl; // I1
  overlayEl = document.createElement("div");
  overlayEl.className = "trancy-overlay";
  overlayEl.style.display = "none";
  player.appendChild(overlayEl);
  return overlayEl;
}

/**
 * @param {(text: string) => void} onText - 네이티브 CC 텍스트 변경 시 호출
 * @returns {void}
 */
function observeCaptions(onText) {
  let lastText = "";
  const observer = new MutationObserver(() => {
    const segs = document.querySelectorAll(".ytp-caption-segment"); // I2: 읽기만
    const text = Array.from(segs).map((s) => s.textContent).join(" ").trim();
    if (text !== lastText) {
      lastText = text;
      onText(text);
    }
  });
  // I5: 안정 루트(body)에 부착 — 플레이어 노드는 SPA 네비게이션 시 재생성됨
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
}

/**
 * @param {string} text - 표시할 자막 텍스트, 빈 문자열이면 오버레이 숨김
 * @returns {void}
 */
function render(text) {
  if (!overlayEl) return;
  overlayEl.textContent = text;
  overlayEl.style.display = text ? "" : "none";
}

// 진입점 — findPlayer 폴링 → mountOverlay → observeCaptions(render).
// SPA 네비게이션 후에도 mountOverlay 멱등성으로 오버레이 1개 유지(I1).
(function main() {
  try {
    let observing = false;
    function setup() {
      const player = findPlayer();
      if (!player) return false;
      mountOverlay(player);
      if (!observing) {
        observeCaptions(render); // I5: 문서당 1개
        observing = true;
      }
      return true;
    }
    const poll = setInterval(() => {
      if (setup()) clearInterval(poll);
    }, 500);
    window.addEventListener("yt-navigate-finish", () => {
      try {
        setup();
      } catch (e) {
        /* I4 */
      }
    });
  } catch (e) {
    /* I4: never propagate to the page */
  }
})();
