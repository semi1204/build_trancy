/* YT Dual — Anki 내보내기
 *
 * Worker 큐에서 카드를 받아 AnkiConnect 로 밀어넣습니다.
 * 성공한 카드만 큐에서 지우므로, 중간에 실패해도 남은 건 그대로 보존됩니다.
 */

const MODEL = "YT Dual";
const FIELDS = ["Word", "Sentence", "Translation", "Source"];

const $ = (id) => document.getElementById(id);
let cards = [];
let cfg = {};

const msg = (text, kind = "") => {
  const el = $("msg");
  el.textContent = text;
  el.className = kind;
};

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── AnkiConnect ──────────────────────────────────────────────────────
async function anki(action, params = {}) {
  const res = await fetch($("ankiUrl").value.trim(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params }),
  });
  if (!res.ok) throw new Error(`AnkiConnect ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

/** 노트 타입과 덱이 없으면 만든다 */
async function ensureSchema(deck) {
  const models = await anki("modelNames");
  if (!models.includes(MODEL)) {
    await anki("createModel", {
      modelName: MODEL,
      inOrderFields: FIELDS,
      css: `.card { font-family: system-ui, sans-serif; font-size: 20px;
                    text-align: center; color: #191919; background: #fff; }
            .word { font-weight: 700; }
            .src  { font-size: 13px; color: #888; margin-top: 14px; }`,
      cardTemplates: [{
        Name: "Recognition",
        Front: `<div class="word">{{Word}}</div><hr><div>{{Sentence}}</div>`,
        Back: `{{FrontSide}}<hr id=answer><div>{{Translation}}</div>
               <div class="src">{{Source}}</div>`,
      }],
    });
  }

  const decks = await anki("deckNames");
  if (!decks.includes(deck)) await anki("createDeck", { deck });
}

function toNote(card, deck) {
  const ts = Math.floor(card.start);
  const link = `https://youtu.be/${card.videoId}?t=${ts}`;
  const time = `${String(Math.floor(ts / 60)).padStart(2, "0")}:${String(ts % 60).padStart(2, "0")}`;

  return {
    deckName: deck,
    modelName: MODEL,
    fields: {
      Word: card.word || "",
      Sentence: card.sentence || "",
      Translation: card.translation || "",
      Source: `<a href="${esc(link)}">${esc(card.title || card.videoId)} · ${time}</a>`,
    },
    tags: ["ytdual", card.videoId].filter(Boolean),
    options: { allowDuplicate: false, duplicateScope: "deck" },
  };
}

// ── Worker 큐 ────────────────────────────────────────────────────────
async function fetchQueue() {
  const res = await fetch(`${cfg.endpoint}/api/cards?uid=${encodeURIComponent(cfg.uid)}`);
  if (!res.ok) throw new Error(`서버 ${res.status}`);
  return (await res.json()).cards || [];
}

async function ackQueue(ids) {
  await fetch(`${cfg.endpoint}/api/cards/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: cfg.uid, ids }),
  });
}

// ── 렌더 ─────────────────────────────────────────────────────────────
function render() {
  const list = $("list");
  list.textContent = "";

  if (!cards.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "대기 중인 카드가 없습니다";
    list.append(li);
    $("send").disabled = true;
    return;
  }

  $("send").disabled = false;
  for (const c of cards) {
    const ts = Math.floor(c.start);
    const time = `${String(Math.floor(ts / 60)).padStart(2, "0")}:${String(ts % 60).padStart(2, "0")}`;
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" checked data-id="${esc(c.id)}">
      <div>
        <div class="w">${esc(c.word)}</div>
        <div class="s">${esc(c.sentence)}</div>
        <div class="t">${esc(c.translation)}</div>
        <div class="meta">
          <a href="https://youtu.be/${esc(c.videoId)}?t=${ts}" target="_blank"
             rel="noreferrer">${esc(c.title || c.videoId)} · ${time}</a>
        </div>
      </div>`;
    list.append(li);
  }
}

// ── 동작 ─────────────────────────────────────────────────────────────
async function refresh() {
  msg("불러오는 중...");
  try {
    cards = await fetchQueue();
    render();
    msg(cards.length ? `${cards.length}개 대기 중` : "대기 중인 카드가 없습니다", "");
  } catch (e) {
    msg(`큐를 불러오지 못했습니다: ${e.message}`, "err");
  }
}

async function send() {
  const picked = new Set(
    [...document.querySelectorAll("#list input:checked")].map((i) => i.dataset.id)
  );
  const targets = cards.filter((c) => picked.has(c.id));
  if (!targets.length) return msg("선택된 카드가 없습니다", "err");

  const deck = $("deck").value.trim() || "YouTube";
  $("send").disabled = true;
  msg("Anki로 보내는 중...");

  try {
    await ensureSchema(deck);
    const results = await anki("addNotes", {
      notes: targets.map((c) => toNote(c, deck)),
    });

    // null 은 중복이거나 실패한 노트. 그래도 큐에서는 빼준다 (중복은 재시도해도 같음)
    const added = results.filter(Boolean).length;
    const dupes = results.length - added;

    await ackQueue(targets.map((c) => c.id));
    cards = cards.filter((c) => !picked.has(c.id));
    render();

    msg(
      `${added}개 추가${dupes ? `, ${dupes}개는 중복이라 건너뜀` : ""}`,
      "ok"
    );
  } catch (e) {
    msg(`실패: ${e.message} — Anki가 켜져 있는지, CORS 설정을 했는지 확인하세요`, "err");
  } finally {
    $("send").disabled = false;
  }
}

(async function init() {
  cfg = await browser.storage.local.get(["endpoint", "uid"]);
  cfg.endpoint = (cfg.endpoint || "").replace(/\/+$/, "");
  if (!cfg.endpoint || !cfg.uid) {
    msg("먼저 확장 설정에서 Worker 주소를 입력하세요", "err");
    return;
  }
  $("refresh").addEventListener("click", refresh);
  $("send").addEventListener("click", send);
  refresh();
})();
