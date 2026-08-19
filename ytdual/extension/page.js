/* YT Dual — 페이지 번역 (Alt+W)
 * 본문 블록(문단·제목·리스트) 바로 밑에 번역을 삽입한다. 다시 Alt+W 하면 제거.
 * 유튜브 자막 기능(content.js)과 독립 — 유튜브 외 모든 사이트에서 동작.
 */

const DEFAULTS = { endpoint: "https://sub.example.workers.dev", target: "Korean" };
let cfg = { ...DEFAULTS };
let on = false;
let busy = false;

const log = (...a) => console.log("[YT Dual page]", ...a);

async function loadConfig() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...stored };
  cfg.endpoint = cfg.endpoint.replace(/\/+$/, "");
}

function ensureStyle() {
  if (document.getElementById("ytdual-page-style")) return;
  const s = document.createElement("style");
  s.id = "ytdual-page-style";
  s.textContent = `
    .ytdual-page-trans {
      opacity: .78;
      font-size: .95em;
      line-height: 1.5;
      margin: .3em 0 .9em;
    }
    li > .ytdual-page-trans { margin: .15em 0 .3em; }
    #ytdual-page-toast {
      position: fixed; left: 50%; bottom: 40px;
      transform: translateX(-50%); z-index: 2147483002;
      padding: 9px 16px; border-radius: 999px;
      background: rgba(20,20,20,.9); color: #fff;
      font: 600 13px/1 system-ui, sans-serif;
      pointer-events: none; opacity: 0; transition: opacity .18s;
    }
    #ytdual-page-toast.show { opacity: 1; }`;
  document.head.appendChild(s);
}

let toastTimer = null;
function toast(msg) {
  let t = document.getElementById("ytdual-page-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "ytdual-page-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

const BLOCK_SEL = "p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, figcaption";
const SKIP_CLOSEST = "pre, code, script, style, textarea, [contenteditable=''], [contenteditable='true'], .ytdual-page-trans";

function hangulRatio(s) {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (!letters) return 0;
  return (letters.match(/\p{Script=Hangul}/gu) || []).length / letters.length;
}

function collectBlocks() {
  const out = [];
  for (const el of document.querySelectorAll(BLOCK_SEL)) {
    if (el.closest(SKIP_CLOSEST)) continue;
    if (el.dataset.ytdualDone) continue;
    // li 안의 p 처럼 하위에 또 블록이 있으면 하위 쪽만 번역한다
    if (el.querySelector("p, li, blockquote, h1, h2, h3, h4, h5, h6")) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;         // 안 보이는 요소
    const text = el.innerText.replace(/\s+/g, " ").trim();
    if (text.length < (/^H[1-6]$/.test(el.tagName) ? 3 : 15)) continue;
    if (text.length > 2000) continue;
    if (cfg.target === "Korean" && hangulRatio(text) > 0.5) continue;   // 이미 한국어
    out.push({ el, text });
  }
  return out;
}

function insertTrans(el, text) {
  const d = document.createElement("div");
  d.className = "ytdual-page-trans";
  d.textContent = text;
  el.dataset.ytdualDone = "1";
  if (el.tagName === "LI") el.appendChild(d);          // 리스트 구조를 깨지 않게 안쪽으로
  else el.insertAdjacentElement("afterend", d);
}

async function translatePage() {
  const blocks = collectBlocks();
  if (!blocks.length) { toast("번역할 문단이 없습니다"); return; }
  toast(`번역 중 (${blocks.length}블록)`);
  const BATCH = 25;
  for (let i = 0; i < blocks.length; i += BATCH) {
    if (!on) return;                                   // 도중에 꺼짐
    const part = blocks.slice(i, i + BATCH);
    try {
      const res = await fetch(`${cfg.endpoint}/api/page`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: part.map((b) => b.text), target: cfg.target }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { t } = await res.json();
      if (!on) return;
      part.forEach((b, j) => {
        if (t[j] && t[j].trim() && t[j].trim() !== b.text) insertTrans(b.el, t[j].trim());
        else b.el.dataset.ytdualDone = "1";            // 이미 대상 언어 등 — 재시도 안 함
      });
    } catch (e) {
      log("배치 실패", e.message);
      toast(`번역 실패: ${e.message}`);
      return;
    }
  }
  toast("번역 완료");
}

function clearTrans() {
  document.querySelectorAll(".ytdual-page-trans").forEach((d) => d.remove());
  document.querySelectorAll("[data-ytdual-done]").forEach((el) => delete el.dataset.ytdualDone);
}

async function toggle() {
  if (busy) return;
  busy = true;
  try {
    await loadConfig();
    ensureStyle();
    on = !on;
    if (on) await translatePage();
    else { clearTrans(); toast("번역 제거"); }
  } finally {
    busy = false;
  }
}

document.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
  if (e.altKey && e.code === "KeyW") { e.preventDefault(); toggle(); }
});
