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
    #ytdual-page-toast.show { opacity: 1; }
    #ytdual-page-pop {
      position: fixed; z-index: 2147483003;
      min-width: 180px; max-width: 320px;
      padding: 12px 14px; border-radius: 10px;
      background: rgba(18,18,18,.96); color: #fff;
      font: 14px/1.45 system-ui, -apple-system, "Noto Sans KR", sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.5); text-align: left;
    }
    #ytdual-page-pop .w { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
    #ytdual-page-pop .m { color: #ffe27a; font-weight: 600; }
    #ytdual-page-pop .b { color: #bbb; font-size: 12.5px; margin-top: 3px; }
    #ytdual-page-pop .a { margin-top: 10px; }
    #ytdual-page-pop .s {
      border: none; border-radius: 7px; padding: 7px 10px;
      font: 600 12.5px/1 system-ui, sans-serif; cursor: pointer;
      background: #ffe27a; color: #222;
    }`;
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

// 링크·굵게 등은 <t0>…</t0> 마커로 감싸 보내고, 번역에서 원래 요소(href 등
// 속성 유지)로 복원한다. 마커가 깨져 돌아오면 평문으로 폴백.
const INLINE_KEEP = new Set(["A", "STRONG", "B", "EM", "I", "CODE", "MARK", "SUP", "SUB"]);

function encodeBlock(el) {
  const map = [];
  let out = "";
  (function walk(node) {
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) out += n.data;
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const txt = n.textContent.trim();
        if (INLINE_KEEP.has(n.tagName) && txt) {
          out += `<t${map.length}>${txt}</t${map.length}>`;   // 중첩은 평문화
          map.push(n);
        } else walk(n);
      }
    }
  })(el);
  return { text: out.replace(/\s+/g, " ").trim(), map };
}

function stripMarkers(text) {
  return text.replace(/<\/?t\d+>/g, "");
}

function decodeTrans(text, map) {
  const frag = document.createDocumentFragment();
  const re = /<t(\d+)>(.*?)<\/t\1>/g;
  let last = 0, m;
  const seen = new Set();
  while ((m = re.exec(text))) {
    const i = Number(m[1]);
    if (!map[i] || seen.has(i)) {                       // 마커가 깨짐 → 평문 폴백
      const d = document.createDocumentFragment();
      d.append(stripMarkers(text));
      return d;
    }
    seen.add(i);
    frag.append(text.slice(last, m.index));
    const clone = map[i].cloneNode(false);              // href 등 속성 유지
    clone.removeAttribute("id");
    clone.textContent = stripMarkers(m[2]);
    frag.append(clone);
    last = m.index + m[0].length;
  }
  frag.append(stripMarkers(text.slice(last)));
  return frag;
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
    const { text, map } = encodeBlock(el);
    const plain = stripMarkers(text);
    if (plain.length < (/^H[1-6]$/.test(el.tagName) ? 3 : 15)) continue;
    if (plain.length > 2000) continue;
    if (cfg.target === "Korean" && hangulRatio(plain) > 0.5) continue;   // 이미 한국어
    out.push({ el, text, map });
  }
  return out;
}

function insertTrans(el, transText, map) {
  // 원본과 같은 태그·클래스를 물려받아 제목은 제목답게, 문단은 문단답게 보인다
  const tag = el.tagName === "LI" ? "div" : el.tagName.toLowerCase();
  const d = document.createElement(tag);
  d.className = "ytdual-page-trans" + (el.tagName === "LI" ? "" : " " + el.className);
  d.append(decodeTrans(transText, map));
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
      // 페이지 CSP(connect-src)가 직접 fetch 를 차단하는 사이트(GitHub 등)가
      // 있어 background 를 경유한다
      const r = await browser.runtime.sendMessage({
        type: "ytdual-fetch",
        path: "/api/page",
        body: { texts: part.map((b) => b.text), target: cfg.target },
      });
      if (!r || !r.ok) throw new Error(r ? r.error || `서버 ${r.status}` : "background 무응답");
      const { t } = r.data;
      if (!Array.isArray(t)) throw new Error("빈 응답");
      if (!on) return;
      part.forEach((b, j) => {
        if (t[j] && t[j].trim() && stripMarkers(t[j]).trim() !== stripMarkers(b.text))
          insertTrans(b.el, t[j].trim(), b.map);
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
  if (e.code === "Escape" && pop) { closePop(); return; }
  const el = document.activeElement;
  if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
  if (e.altKey && e.code === "KeyA") { e.preventDefault(); toggle(); }
});

// ── 단어 더블클릭 → 문맥상 뜻 팝업 ──────────────────────────────────
let pop = null;

function closePop() {
  pop?.remove();
  pop = null;
}

document.addEventListener(
  "click",
  (e) => {
    if (pop && !e.target.closest("#ytdual-page-pop")) closePop();
  },
  true
);

document.addEventListener("dblclick", async (e) => {
  if (e.target.closest("input, textarea, [contenteditable], #ytdual-page-pop")) return;
  const word = window.getSelection().toString().trim();
  if (!word || word.length > 40 || /\s/.test(word) || !/\p{L}/u.test(word)) return;

  await loadConfig();
  ensureStyle();

  // 주변 문장을 문맥으로
  const block = e.target.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, div, span");
  let sentence = block ? block.innerText.replace(/\s+/g, " ").trim() : "";
  if (sentence.length > 300) {
    const i = Math.max(0, sentence.indexOf(word) - 150);
    sentence = sentence.slice(i, i + 300);
  }

  closePop();
  // innerHTML 을 쓰지 않는 이유 — 사이트가 CSP 에 `require-trusted-types-for 'script'`
  // 를 걸어 두면(유튜브가 그렇다) 문자열 할당이 TypeError 로 죽는다.
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const save = el("button", "s", "문장과 함께 저장");
  save.addEventListener("click", () => { savePageCard(word, sentence); closePop(); });
  const actions = el("div", "a");
  actions.append(save);
  pop = document.createElement("div");
  pop.id = "ytdual-page-pop";
  pop.append(el("div", "w", word), el("div", "m", "⏳ 뜻 찾는 중…"), el("div", "b"), actions);
  document.body.appendChild(pop);
  pop.style.left = Math.max(8, Math.min(e.clientX, innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = e.clientY + 14 + "px";

  const r = await browser.runtime.sendMessage({
    type: "ytdual-fetch",
    path: "/api/word",
    body: { word, sentence, target: cfg.target },
  });
  if (!pop) return;
  pop.querySelector(".m").textContent = r && r.ok ? r.data.meaning || "—" : "사전 요청 실패";
  if (r && r.ok) pop.querySelector(".b").textContent = r.data.base || "";
});

async function savePageCard(word, sentence) {
  let { uid } = await browser.storage.local.get("uid");
  if (!uid) {
    uid = crypto.randomUUID();
    await browser.storage.local.set({ uid });
  }
  const r = await browser.runtime.sendMessage({
    type: "ytdual-fetch",
    path: "/api/cards",
    body: {
      uid,
      cards: [{
        id: `${location.hostname}-${word}-${sentence.slice(0, 24)}`,
        word,
        sentence,
        translation: "",
        videoId: "",
        title: document.title,
        start: 0,
      }],
    },
  });
  toast(r && r.ok ? `저장: ${word}` : "저장 실패");
}
