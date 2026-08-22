/* YT Dual — background
 *
 * 페이지의 CSP(connect-src)는 content script 의 fetch 까지 차단한다(GitHub 등).
 * background 는 페이지 CSP 의 영향을 받지 않으므로, Worker API 요청을 여기서
 * 대신 보내고 content script 는 메시지만 주고받는다.
 *
 * 유튜브에서는 이 경로를 타지 않는다 — content.js 가 직접 fetch 한다.
 * 여기를 쓰는 것은 임의 페이지에서 도는 page.js(단어 팝업·페이지 번역)다.
 */

// Chrome 은 `chrome`, Firefox 계열(Zen 포함)은 `browser` 를 준다.
// background 는 content_scripts 배열을 안 거치므로 여기서 직접 맞춘다.
globalThis.browser ??= globalThis.chrome;

const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const ALLOWED = /^\/api\/(page|subtitle|word|cards)$/;

async function proxy(msg) {
  if (!ALLOWED.test(msg.path)) return { ok: false, status: 0, error: "bad path" };
  const { endpoint = DEFAULT_ENDPOINT } = await browser.storage.local.get("endpoint");
  const url = endpoint.replace(/\/+$/, "") + msg.path;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg.body),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/* sendResponse + `return true` 로 답한다. Firefox 는 리스너가 돌려준 Promise 도
 * 받아주지만 Chrome 은 안 받는다. 이 방식은 양쪽 다 지원한다. */
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "ytdual-open-options") {
    browser.runtime.openOptionsPage();
    return;                       // 응답이 필요 없는 메시지
  }
  if (msg.type !== "ytdual-fetch") return;
  proxy(msg).then(sendResponse);
  return true;                    // 응답이 비동기임을 알린다
});
