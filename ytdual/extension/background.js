/* YT Dual — background
 * 페이지의 CSP(connect-src)는 content script 의 fetch 까지 차단한다
 * (GitHub 등). background 는 페이지 CSP 의 영향을 받지 않으므로,
 * Worker API 요청을 여기서 대신 보내고 content script 는 메시지만 주고받는다.
 */

const DEFAULT_ENDPOINT = "https://sub.example.workers.dev";
const ALLOWED = /^\/api\/(page|subtitle|word|cards)$/;

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "ytdual-open-options") {
    browser.runtime.openOptionsPage();
    return;
  }
  if (!msg || msg.type !== "ytdual-fetch") return;
  return (async () => {
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
  })();
});
