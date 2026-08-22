/* 브라우저 테스트 하네스.
 *
 * 이 파일은 자막 로직을 다시 구현하지 않는다. /content.js 로 로드된 실제 확장
 * 소스의 함수를 그대로 부른다 — normalizeSegments, fastWindow, pickTrack,
 * seedRawLines, mergeTranslated, applyFast, findLine, requestTranslation.
 * (classic script 의 최상위 function 선언과 let/const 는 같은 realm 의 다음
 *  스크립트에서 이름으로 접근된다. 그래서 사본 없이 실코드를 쓸 수 있다.)
 *
 * 재구현하면 여기서 초록불인데 출하물은 빨간불인 상태가 생긴다. 그건 테스트가
 * 아니라 착시다.
 */
"use strict";

/* IIFE 로 감싸는 이유: classic script 의 최상위 let/const 는 같은 realm 의 전역
 * 렉시컬 환경을 공유한다. content.js 가 이미 `const $` 를 선언하므로, 여기서
 * 같은 이름을 최상위에 두면 SyntaxError 로 페이지가 통째로 죽는다 (실제로 죽었다).
 * 감싸면 이 파일의 이름은 지역이 되고, content.js 의 cfg·state·함수들은
 * 스코프 체인을 타고 그대로 보인다. */
(function () {


const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const fmt = (s) => {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/* content.js 가 기대하는 것 중 이 페이지에 없는 것들.
 * <video> 는 실제로 없지만 fastWindow·findLine 은 시각만 필요하다. */
const TRANSLATE_CHUNK = 12;
const FAST_CHUNK = 8;
const CTX_N = 8;

const S = {
  fixtures: [],
  fx: null,          // 현재 fixture 메타
  raw: [],           // 원본 세그먼트
  segs: [],          // 정규화 적용 여부가 반영된 세그먼트
  chunks: [],
  runs: [],
  seq: 0,
  busy: false,
};

/* ── 부팅 ─────────────────────────────────────────────────────── */
async function boot() {
  // content.js 가 로드됐는지 — 없으면 나머지는 전부 거짓말이 된다
  const need = ["normalizeSegments", "fastWindow", "pickTrack", "seedRawLines",
                "mergeTranslated", "applyFast", "findLine", "requestTranslation"];
  const missing = need.filter((n) => typeof window[n] !== "function");
  const badge = $("#srcbadge");
  if (missing.length) {
    badge.className = "badge bad";
    badge.textContent = `content.js 미연결 (${missing.join(", ")})`;
  } else {
    badge.className = "badge ok";
    badge.textContent = `실제 content.js 함수 ${need.length}/${need.length} 연결`;
    badge.title = need.join(", ");
  }

  // 실제 cfg 를 이 서버로 돌린다 (프록시가 워커로 넘긴다)
  cfg.endpoint = location.origin;
  cfg.target = "Korean";

  health();
  setInterval(health, 15000);

  S.fixtures = await (await fetch("/api/fixtures")).json();
  const sel = $("#fixture");
  if (!S.fixtures.length) {
    sel.append(new Option("자막 fixture 없음 — npm run fixture:transcript", ""));
    return;
  }
  for (const f of S.fixtures) {
    const kind = f.subtitleKind === "manual" ? "수동" : "자동";
    sel.append(new Option(`${kind} · ${f.lang} · ${f.count}조각 · ${f.title.slice(0, 46)}`, f.id));
  }
  sel.addEventListener("change", () => loadFixture(sel.value));
  $("#normalize").addEventListener("change", () => applyNormalize());
  $("#playhead").addEventListener("input", onPlayhead);
  $("#preview").addEventListener("input", drawPreview);
  $("#run").addEventListener("click", runRace);
  $("#run-full-grid").addEventListener("click", runWholeGrid);
  $("#clear").addEventListener("click", () => { S.runs = []; drawRuns(); });

  await loadFixture(S.fixtures[0].id);
}

async function health() {
  const b = $("#health");
  try {
    const h = await (await fetch("/api/health")).json();
    b.className = `badge ${h.worker ? "ok" : "bad"}`;
    b.textContent = h.worker ? `워커 연결됨 ${h.workerUrl}` : `워커 꺼짐 — npm run dev`;
    $("#run").disabled = !h.worker;
    $("#run-full-grid").disabled = !h.worker;
  } catch {
    b.className = "badge bad";
    b.textContent = "테스트 서버 응답 없음";
  }
}

/* ── fixture ──────────────────────────────────────────────────── */
async function loadFixture(id) {
  S.fx = S.fixtures.find((f) => f.id === id);
  const d = await (await fetch(`/api/fixtures/${encodeURIComponent(id)}`)).json();
  S.raw = d.segments;
  $("#fixture-meta").textContent =
    `${S.fx.title} · ${S.fx.durationSeconds}초 · ${S.fx.subtitleKind === "manual" ? "사람이 단 자막" : "자동생성 자막"}`;
  applyNormalize();
}

/** 정규화 on/off 를 반영하고 겹침 통계를 다시 그린다 */
function applyNormalize() {
  const on = $("#normalize").checked;
  S.segs = on ? normalizeSegments(S.raw, S.fx.durationSeconds) : S.raw;

  const ov = (segs) => {
    let c = 0, m = 0;
    for (let i = 1; i < segs.length; i++) {
      const d = segs[i - 1].end - segs[i].start;
      if (d > 1e-9) { c++; m = Math.max(m, d); }
    }
    return { c, m };
  };
  const before = ov(S.raw), after = ov(S.segs);
  const durs = S.segs.map((s) => s.end - s.start).sort((a, b) => a - b);

  $("#norm-stats").replaceChildren(
    stat("조각", S.segs.length),
    stat("겹치는 쌍", `${before.c} → ${after.c}`, after.c === 0 && before.c > 0 ? "good" : after.c ? "bad" : ""),
    stat("최대 겹침", `${before.m.toFixed(2)}s → ${after.m.toFixed(2)}s`, after.m < 0.01 ? "good" : "bad"),
    stat("중앙 길이", `${durs[durs.length >> 1].toFixed(2)}s`),
  );

  S.chunks = [];
  for (let i = 0; i < S.segs.length; i += TRANSLATE_CHUNK) {
    const segs = S.segs.slice(i, i + TRANSLATE_CHUNK);
    S.chunks.push({ i0: i, segs, t0: segs[0].start, t1: segs[segs.length - 1].end });
  }

  const dur = S.segs[S.segs.length - 1].end;
  for (const id of ["#playhead", "#preview"]) {
    const r = $(id);
    r.max = dur.toFixed(2);
    if (+r.value > dur) r.value = 0;
  }
  // 원문만 깔아 둔다 — 실제 seedRawLines 를 그대로 쓴다 (I1)
  seedRawLines(S.segs);
  onPlayhead();
  drawPreview();
}

const stat = (label, value, cls = "") => {
  const n = el("div", `stat ${cls}`);
  n.append(el("span", null, `${label} `), el("b", null, String(value)));
  return n;
};

/* ── 창 비교 ──────────────────────────────────────────────────── */
/** content.js 의 nextChunk 와 같은 점수 */
function pickPlaying(t) {
  let best = null, bs = Infinity;
  for (const c of S.chunks) {
    const s0 = c.segs[0].start, e0 = c.segs[c.segs.length - 1].end;
    const sc = t >= s0 - 5 && t <= e0 ? -1 : s0 >= t ? s0 - t : 1e6 + (t - s0);
    if (sc < bs) { bs = sc; best = c; }
  }
  return best && { chunk: best, playing: bs === -1 };
}

function onPlayhead() {
  const t = +$("#playhead").value;
  $("#playhead-out").textContent = fmt(t);
  $("#preview").value = t;
  drawPreview();

  const picked = pickPlaying(t);
  if (!picked) return;
  const { chunk, playing } = picked;

  const oldWin = { from: chunk.i0, segs: chunk.segs.slice(0, FAST_CHUNK) };
  const newWin = fastWindow(S.segs, chunk, t, FAST_CHUNK);   // ← 실제 함수

  drawWindow("#win-old", "#winstat-old", oldWin, t, playing);
  drawWindow("#win-new", "#winstat-new", newWin, t, playing);
}

function drawWindow(segSel, statSel, win, t, playing) {
  const box = $(segSel);
  box.replaceChildren();
  for (const s of win.segs) {
    const cls = s.end < t ? "past" : s.start <= t ? "now" : "future";
    const n = el("div", `seg ${cls}`);
    n.append(el("span", "t", `${s.start.toFixed(1)}–${s.end.toFixed(1)}`), document.createTextNode(s.text));
    box.append(n);
  }
  const past = win.segs.filter((s) => s.end < t).length;
  const covers = win.segs.some((s) => s.end >= t);
  const horizon = win.segs.length ? win.segs[win.segs.length - 1].end - t : 0;
  const st = $(statSel);
  st.replaceChildren();
  if (!playing) { st.textContent = "이 지점은 재생 중 청크가 아님 → full 로 처리"; return; }
  st.append(
    document.createTextNode("재생 지점 덮음 "),
    el("b", covers ? "good" : "bad", covers ? "예" : "아니오"),
    document.createTextNode(" · 지나간 조각 "),
    el("b", past ? "bad" : "good", `${past}/${win.segs.length}`),
    document.createTextNode(` · 미리보기 지평 ${Math.max(0, horizon).toFixed(1)}초`),
  );
}

/* ── 실행 ─────────────────────────────────────────────────────── */
function laneStart(which, n) {
  const lane = $(`#lane-${which}`);
  lane.className = "lane running";
  $(`#lane-${which} .n`).textContent = `N=${n}`;
  $(`#meta-${which}`).textContent = "요청 중…";
  const t0 = performance.now();
  const timer = setInterval(() => {
    $(`#timer-${which}`).textContent = `${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 50);
  return { t0, stop: () => clearInterval(timer) };
}

function inspect(mode, segs, res) {
  // full 은 lines, fast 는 t. 결함 지표는 워커 수정 전후를 그대로 드러낸다.
  if (mode === "fast") {
    const empty = res.t.filter((x) => !String(x).trim()).length;
    return { empty, holes: 0, maxOrig: Math.max(...segs.map((s) => s.text.length)), lines: null };
  }
  const lines = res.lines;
  const empty = lines.filter((l) => !String(l.trans ?? "").trim()).length;
  // 구멍 = 입력 구간 중 반환 줄이 못 덮는 시간
  const uni = (iv) => {
    const a = iv.map((x) => [x.start, x.end]).filter(([p, q]) => q > p).sort((p, q) => p[0] - q[0]);
    const o = [];
    for (const [p, q] of a) {
      const last = o[o.length - 1];
      if (last && p <= last[1] + 1e-9) last[1] = Math.max(last[1], q);
      else o.push([p, q]);
    }
    return o;
  };
  const cur = uni(lines);
  let hole = 0;
  for (let [a, b] of uni(segs.map((s) => ({ start: s.start, end: s.end })))) {
    for (const [c, d] of cur) {
      if (d <= a || c >= b) continue;
      if (c > a) hole += Math.min(c, b) - a;
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (b - a > 1e-9) hole += b - a;
  }
  return { empty, holes: +hole.toFixed(2), maxOrig: Math.max(...lines.map((l) => String(l.orig).length)), lines };
}

async function fire(mode, segs, base) {
  const n = segs.length;
  const lane = laneStart(mode, n);
  // 캐시 우회 — 같은 지문이라도 videoId 가 다르면 새 키가 된다
  const vid = $("#bust").checked ? `harness-${Date.now()}-${S.seq++}` : `harness-${S.fx.id}`;
  try {
    // ★ 실제 requestTranslation 을 부른다 (타임아웃·계약 검사 포함)
    const res = await requestTranslation(vid, S.fx.lang, segs, {
      before: S.segs.slice(Math.max(0, base - CTX_N), base).map((s) => s.text),
      after: S.segs.slice(base + n, base + n + CTX_N).map((s) => s.text),
    }, null, mode);
    const ms = Math.round(performance.now() - lane.t0);
    lane.stop();
    const ins = inspect(mode, segs, res);
    $(`#timer-${mode}`).textContent = `${(ms / 1000).toFixed(1)}s`;
    $(`#lane-${mode}`).className = "lane done";
    $(`#meta-${mode}`).textContent =
      `출력 ${res.usage?.completion_tokens ?? "?"}토큰 · reasoning ${res.usage?.completion_tokens_details?.reasoning_tokens ?? "?"}` +
      (ins.empty ? ` · 빈 번역 ${ins.empty}` : "") + (ins.holes ? ` · 구멍 ${ins.holes}s` : "");
    S.runs.push({ i: S.runs.length + 1, fx: S.fx.id, mode, n, ms,
      out: res.usage?.completion_tokens ?? null,
      reason: res.usage?.completion_tokens_details?.reasoning_tokens ?? null, ...ins });
    drawRuns();
    return { res, ins };
  } catch (e) {
    lane.stop();
    $(`#timer-${mode}`).textContent = "실패";
    $(`#lane-${mode}`).className = "lane failed";
    $(`#meta-${mode}`).textContent = e.message;
    return null;
  }
}

async function runRace() {
  if (S.busy) return;
  S.busy = true;
  $("#run").disabled = true;
  try {
    const t = +$("#playhead").value;
    const picked = pickPlaying(t);
    if (!picked) return;
    const { chunk } = picked;
    const win = fastWindow(S.segs, chunk, t, FAST_CHUNK);

    // 원문만 있는 상태로 되돌리고 시작 — 실제 seedRawLines
    seedRawLines(S.segs);

    // 둘을 동시에 쏜다. 화면에서 fast 가 먼저 도착하는 것이 눈에 보인다.
    const [fastR, fullR] = await Promise.all([
      fire("fast", win.segs, win.from),
      fire("full", chunk.segs, chunk.i0),
    ]);

    // 실제 병합 경로를 그대로 태운다
    if (fastR) applyFast(win.segs, fastR.res.t);
    if (fullR) mergeTranslated(fullR.res.lines, chunk.t0, chunk.t1);
    drawLines(fullR ? fullR.ins.lines : null, win.segs, fastR?.res.t);
    drawPreview();
  } finally {
    S.busy = false;
    $("#run").disabled = false;
  }
}

/** full 격자 전체를 번역해 오버레이 미리보기를 완성한다 (동시 8, 실제 값) */
async function runWholeGrid() {
  if (S.busy) return;
  S.busy = true;
  $("#run-full-grid").disabled = true;
  seedRawLines(S.segs);
  const pending = [...S.chunks];
  let done = 0;
  const btn = $("#run-full-grid");
  const runner = async () => {
    for (;;) {
      const c = pending.shift();
      if (!c) return;
      const vid = $("#bust").checked ? `harness-${Date.now()}-${S.seq++}` : `harness-${S.fx.id}-${c.i0}`;
      try {
        const t0 = performance.now();
        const res = await requestTranslation(vid, S.fx.lang, c.segs, {
          before: S.segs.slice(Math.max(0, c.i0 - CTX_N), c.i0).map((s) => s.text),
          after: S.segs.slice(c.i0 + c.segs.length, c.i0 + c.segs.length + CTX_N).map((s) => s.text),
        }, null, "full");
        const ms = Math.round(performance.now() - t0);
        const ins = inspect("full", c.segs, res);
        mergeTranslated(res.lines, c.t0, c.t1);      // 실제 병합
        S.runs.push({ i: S.runs.length + 1, fx: S.fx.id, mode: "full", n: c.segs.length, ms,
          out: res.usage?.completion_tokens ?? null,
          reason: res.usage?.completion_tokens_details?.reasoning_tokens ?? null, ...ins });
      } catch (e) {
        console.warn("청크 실패", c.i0, e.message);
      }
      btn.textContent = `full 격자 ${++done}/${S.chunks.length}`;
      drawRuns();
      drawLines(state.lines);
      drawPreview();
    }
  };
  await Promise.all(Array.from({ length: 8 }, runner));
  btn.textContent = "full 격자 전체 번역";
  S.busy = false;
  btn.disabled = false;
}

/* ── 표·줄·미리보기 ───────────────────────────────────────────── */
function drawRuns() {
  const tb = $("#runs tbody");
  tb.replaceChildren();
  for (const r of S.runs.slice(-40)) {
    const tr = el("tr");
    const cells = [r.i, r.fx.slice(0, 11), r.mode, r.n, r.ms, r.out ?? "—", r.reason ?? "—",
                   r.empty, r.holes || 0, r.maxOrig];
    cells.forEach((v, i) => {
      const td = el("td", null, String(v));
      if (i === 7 && r.empty) td.className = "bad";
      if (i === 7 && !r.empty) td.className = "good";
      if (i === 8 && r.holes) td.className = "bad";
      tr.append(td);
    });
    tb.append(tr);
  }
  const box = $("#medians");
  box.replaceChildren();
  for (const m of ["fast", "full"]) {
    const rows = S.runs.filter((r) => r.mode === m);
    if (!rows.length) continue;
    box.append(stat(`${m} 중앙`, `${median(rows.map((r) => r.ms))}ms`, m === "fast" ? "good" : ""));
    box.append(stat(`${m} 건수`, rows.length));
  }
  const f = median(S.runs.filter((r) => r.mode === "fast").map((r) => r.ms));
  const u = median(S.runs.filter((r) => r.mode === "full").map((r) => r.ms));
  if (f && u) box.append(stat("full ÷ fast", `${(u / f).toFixed(1)}배`, "good"));
  const tot = S.runs.reduce((n, r) => n + r.empty, 0);
  box.append(stat("빈 번역 누계", tot, tot ? "bad" : "good"));
}

function drawLines(lines, fastSegs, fastT) {
  const box = $("#lines");
  box.replaceChildren();
  const src = lines || state.lines;   // 실제 state.lines
  if (!src || !src.length) return;
  $("#lines-hint").textContent =
    `${src.length}줄 · 빈 번역 ${src.filter((l) => !String(l.trans ?? "").trim()).length}개 · ` +
    `최장 ${Math.max(...src.map((l) => String(l.orig).length))}자`;
  for (const l of src) {
    const t = String(l.trans ?? "");
    const n = el("div", `ln${t.trim() ? "" : " empty"}${String(l.orig).length > 85 ? " long" : ""}`);
    n.append(
      el("div", "time", `${(+l.start).toFixed(2)} → ${(+l.end).toFixed(2)}  (${String(l.orig).length}자)`),
      el("div", "o", l.orig),
      el("div", "t", t),
    );
    box.append(n);
  }
}

function drawPreview() {
  const t = +$("#preview").value;
  $("#preview-out").textContent = fmt(t);
  const i = findLine(t);                    // ← 실제 findLine
  const line = i >= 0 ? state.lines[i] : null;
  $("#ytdual-orig").textContent = line ? line.orig : "";
  $("#ytdual-trans").textContent = line ? (line.trans || "") : "";
  $("#ytdual-box").classList.toggle("empty", !line);

  const covered = S.segs.some((s) => s.start <= t && t <= s.end);
  $("#preview-stats").replaceChildren(
    stat("줄 index", i),
    stat("등급", line ? (line.tier ?? "원문") : "—"),
    stat("이 시각 자막", covered ? (line ? "표시됨" : "비어 있음 ⚠") : "원본에도 없음",
      covered ? (line ? "good" : "bad") : ""),
  );
}

boot();
})();
