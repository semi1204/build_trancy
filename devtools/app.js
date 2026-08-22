/* 브라우저 하네스.
 *
 * 자막 로직을 다시 구현하지 않는다. /content.js 로 로드된 실제 확장 소스의
 * 함수를 그대로 부른다:
 *   normalizeSegments  시간 정규화
 *   makeJobs pickJob splitJobAt   작업 분할·우선순위·재생 지점 슬라이스
 *   seedRawLines mergeTranslated  state.lines 조립
 *   findLine                      화면에 뜰 줄 찾기
 *   requestTranslation            워커 호출 (타임아웃·계약 검사 포함)
 *
 * 재구현하면 여기서 초록불인데 출하물은 빨간불인 상태가 생긴다. 그건 테스트가
 * 아니라 착시다. 여기 남은 것은 "8개를 동시에 돌린다"는 루프뿐이고, 그 안의
 * 판단은 전부 위 함수들이 한다.
 *
 * IIFE 로 감싸는 이유: classic script 의 최상위 let/const 는 전역 렉시컬 환경을
 * 공유한다. content.js 가 이미 `const $` 를 선언하므로 겹치면 페이지가 통째로 죽는다.
 */
"use strict";
(function () {

const RUNNERS = 8;          // content.js 와 같은 값
const CHUNK = 12;           // TRANSLATE_CHUNK
const SLICE = 4;            // PRIORITY_SLICE
const CTX_N = 8;
const GOAL_MS = 3000;       // 게이지의 목표선

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const stat = (label, value, cls = "") => {
  const n = el("div", `stat ${cls}`);
  n.append(el("span", null, label), el("b", null, String(value)));
  return n;
};

const S = {
  fixtures: [], fx: null,
  segments: [],          // 정규화 반영된 조각
  session: null,         // { pending, inflight, stop, t0, target, done, total }
  follow: true,
  seq: 0,
};

/* ── 부팅 ───────────────────────────────────────────────────── */
async function boot() {
  const need = ["normalizeSegments", "makeJobs", "pickJob", "splitJobAt", "isPlayingJob",
                "seedRawLines", "mergeTranslated", "findLine", "requestTranslation", "pickTrack"];
  const missing = need.filter((n) => typeof window[n] !== "function");
  const b = $("#src");
  if (missing.length) {
    b.className = "badge bad";
    b.textContent = `content.js 미연결: ${missing.join(", ")}`;
  } else {
    b.className = "badge ok";
    b.textContent = `실제 content.js 함수 ${need.length}개 연결`;
    b.title = need.join(", ");
  }

  cfg.endpoint = location.origin;   // content.js 의 cfg — 프록시가 워커로 넘긴다
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
    const kind = f.subtitleKind === "manual" ? "사람" : "자동";
    sel.append(new Option(`${kind} · ${f.lang} · ${f.count}조각 · ${f.title.slice(0, 44)}`, f.id));
  }

  sel.addEventListener("change", () => loadFixture(sel.value));
  $("#normalize").addEventListener("change", applyFixture);
  $("#play").addEventListener("input", onPlay);
  $("#preview").addEventListener("input", () => { S.follow = false; syncFollow(); draw(); });
  $("#follow").addEventListener("click", () => { S.follow = !S.follow; syncFollow(); onPlay(); });
  $("#run").addEventListener("click", () => startSession(false));
  $("#seek").addEventListener("click", () => startSession(true));
  $("#stop").addEventListener("click", stopSession);

  await loadFixture(S.fixtures[0].id);
}

async function health() {
  const b = $("#worker");
  try {
    const h = await (await fetch("/api/health")).json();
    b.className = `badge ${h.worker ? "ok" : "bad"}`;
    b.textContent = h.worker ? "워커 연결됨" : "워커 꺼짐 — npm run dev";
    $("#run").disabled = !h.worker || !!S.session;
  } catch {
    b.className = "badge bad";
    b.textContent = "하네스 서버 없음";
  }
}

/* ── 자막 ───────────────────────────────────────────────────── */
async function loadFixture(id) {
  stopSession();
  S.fx = S.fixtures.find((f) => f.id === id);
  const d = await (await fetch(`/api/fixtures/${encodeURIComponent(id)}`)).json();
  S.raw = d.segments;
  $("#fixture-title").textContent =
    `${S.fx.title} · ${clock(S.fx.durationSeconds)} · ` +
    (S.fx.subtitleKind === "manual" ? "사람이 만든 자막" : "자동생성 자막");
  applyFixture();
}

function applyFixture() {
  stopSession();
  const on = $("#normalize").checked;
  S.segments = on ? normalizeSegments(S.raw, S.fx.durationSeconds) : S.raw;

  const overlaps = (a) => {
    let n = 0, max = 0;
    for (let i = 1; i < a.length; i++) {
      const d = a[i - 1].end - a[i].start;
      if (d > 1e-9) { n++; max = Math.max(max, d); }
    }
    return { n, max };
  };
  const before = overlaps(S.raw), after = overlaps(S.segments);
  const jobs = makeJobs(S.segments, CHUNK);

  $("#stats-source").replaceChildren(
    stat("조각", S.segments.length),
    stat("작업", jobs.length),
    stat("겹침", `${before.n} → ${after.n}`,
      after.n === 0 && before.n > 0 ? "good" : after.n ? "bad" : ""),
    stat("최대 겹침", `${before.max.toFixed(2)} → ${after.max.toFixed(2)}s`),
  );

  const dur = S.segments[S.segments.length - 1].end;
  for (const id of ["#play", "#preview"]) {
    const r = $(id);
    r.max = dur.toFixed(2);
    if (+r.value > dur) r.value = 0;
  }
  seedRawLines(S.segments);        // 원문만 깔아 둔다 (I1)
  onPlay();
  renderLines();
}

function onPlay() {
  const t = +$("#play").value;
  $("#play-out").textContent = clock(t);
  if (S.follow) { $("#preview").value = t; }
  draw();
}
const syncFollow = () => $("#follow").classList.toggle("on", S.follow);

/* ── 번역 세션 ──────────────────────────────────────────────── */
function stopSession() {
  const s = S.session;
  if (!s) return;
  s.stop = true;
  for (const ctl of s.inflight.values()) ctl.abort();
  S.session = null;
  $("#run").disabled = false;
  $("#seek").disabled = true;
  $("#stop").disabled = true;
}

/**
 * 확장의 runner 와 같은 구조로 돌린다. 판단(우선순위·슬라이스·병합)은 전부
 * content.js 의 실제 함수가 한다. 여기 있는 것은 동시 실행 루프뿐이다.
 * @param {boolean} isSeek 이미 도는 세션의 재생 위치만 옮기는가
 */
async function startSession(isSeek) {
  if (isSeek && S.session) { markSeek(); return; }
  stopSession();

  seedRawLines(S.segments);
  renderLines();

  const s = {
    pending: new Set(makeJobs(S.segments, CHUNK)),
    inflight: new Map(),
    stop: false,
    t0: performance.now(),
    mark: performance.now(),      // 게이지 기준 시각 (시작 또는 마지막 시킹)
    target: null,                 // 기다리는 작업의 시간 구간
    hit: null,
    done: 0, failed: 0,
  };
  s.total = s.pending.size;
  S.session = s;
  $("#run").disabled = true;
  $("#seek").disabled = false;
  $("#stop").disabled = false;
  aimAtPlayhead();
  gauge("run", "번역 요청 중");
  tick();

  const playhead = () => +$("#play").value;

  const runner = async () => {
    for (;;) {
      if (s.stop) return;
      const picked = pickJob(s.pending, playhead());     // ← 실제 함수
      if (!picked) return;
      let job = picked.job;
      s.pending.delete(job);
      if (picked.playing) {
        const { head, rest } = splitJobAt(job, playhead(), SLICE);   // ← 실제 함수
        for (const r of rest) { s.pending.add(r); s.total++; }
        job = head;
      }
      const ctl = new AbortController();
      s.inflight.set(job, ctl);
      try {
        const vid = $("#bust").checked
          ? `harness-${Date.now()}-${S.seq++}` : `harness-${S.fx.id}-${job.i0}`;
        const res = await requestTranslation(vid, S.fx.lang, job.segs, {   // ← 실제 함수
          before: S.segments.slice(Math.max(0, job.i0 - CTX_N), job.i0).map((x) => x.text),
          after: S.segments.slice(job.i0 + job.segs.length, job.i0 + job.segs.length + CTX_N).map((x) => x.text),
        }, ctl.signal);
        if (s.stop) return;
        mergeTranslated(res.lines, job.t0, job.t1);       // ← 실제 함수
        s.done++;
        if (s.hit === null && s.target && job.t0 <= s.target.t && s.target.t <= job.t1) {
          s.hit = Math.round(performance.now() - s.mark);
          gauge(s.hit <= GOAL_MS ? "ok" : "slow",
            `${job.segs.length}조각 · ${res.lines.length}줄 · ` +
            `출력 ${res.usage?.completion_tokens ?? "?"}토큰`);
        }
        renderLines(); draw(); progress();
      } catch (e) {
        if (s.stop) return;
        if (ctl.signal.aborted) { s.pending.add(job); continue; }   // 시킹으로 끊김
        s.failed++;
        progress();
      } finally {
        s.inflight.delete(job);
      }
    }
  };
  await Promise.all(Array.from({ length: RUNNERS }, runner));
  if (S.session === s && !s.stop) {
    $("#prog-note").textContent = `완료 — ${s.done}/${s.total} 작업` + (s.failed ? `, 실패 ${s.failed}` : "");
    $("#run").disabled = false;
    $("#seek").disabled = true;
    $("#stop").disabled = true;
    S.session = null;
  }
}

/** 지금 재생 위치를 "기다리는 지점"으로 삼는다 */
function aimAtPlayhead() {
  const s = S.session;
  if (!s) return;
  s.target = { t: +$("#play").value };
  s.hit = null;
}

/** 세션을 유지한 채 재생 위치만 옮긴다 — 확장의 seeked 처리와 같다 */
function markSeek() {
  const s = S.session;
  if (!s) return;
  s.mark = performance.now();
  aimAtPlayhead();
  const t = +$("#play").value;
  let cut = 0;
  for (const [job, ctl] of s.inflight) {
    if (!isPlayingJob(job, t)) { ctl.abort(); cut++; }   // ← 실제 함수
  }
  gauge("run", `시킹 — 무관해진 요청 ${cut}개 취소`);
}

function gauge(cls, note) {
  $("#gauge").className = `gauge ${cls}`;
  $("#gauge-note").textContent = note;
}

function tick() {
  const s = S.session;
  if (!s) return;
  const ms = s.hit ?? Math.round(performance.now() - s.mark);
  $("#timer").textContent = (ms / 1000).toFixed(1);
  $("#bar").style.width = `${Math.min(100, (ms / (GOAL_MS * 2)) * 100)}%`;
  if (s.hit === null && ms > GOAL_MS) $("#gauge").className = "gauge slow";
  requestAnimationFrame(tick);
}

function progress() {
  const s = S.session;
  if (!s) return;
  $("#prog").style.width = `${(100 * s.done) / s.total}%`;
  $("#prog-note").textContent = `${s.done}/${s.total} 작업` +
    (s.failed ? ` · 실패 ${s.failed}` : "") + ` · 진행 중 ${s.inflight.size}`;
}

/* ── 화면 ───────────────────────────────────────────────────── */
function draw() {
  const t = +$("#preview").value;
  $("#preview-out").textContent = clock(t);
  const i = findLine(t);                        // ← 실제 함수
  const line = i >= 0 ? state.lines[i] : null;  // ← 실제 state
  $("#ytdual-orig").textContent = line ? line.orig : "";
  $("#ytdual-trans").textContent = line ? (line.trans || "") : "";
  $("#ytdual-box").classList.toggle("empty", !line);

  const covered = S.segments.some((x) => x.start <= t && t <= x.end);
  $("#stats-preview").replaceChildren(
    stat("줄", i >= 0 ? `#${i}` : "없음"),
    stat("상태", line ? (line.translated ? "번역됨" : "원문") : "—",
      line ? (line.translated ? "good" : "warn") : ""),
    stat("이 시각", covered ? (line ? "표시됨" : "비어 있음") : "원본에도 없음",
      covered ? (line ? "good" : "bad") : ""),
  );
}

function renderLines() {
  const lines = state.lines || [];
  const t = +$("#preview").value;
  const cur = findLine(t);
  const empty = lines.filter((l) => l.translated && !String(l.trans).trim()).length;
  const doneN = lines.filter((l) => l.translated).length;
  const longest = lines.length ? Math.max(...lines.map((l) => String(l.orig).length)) : 0;

  $("#stats-lines").replaceChildren(
    stat("줄", lines.length),
    stat("번역됨", `${doneN}/${lines.length}`, doneN ? "good" : ""),
    stat("빈 번역", empty, empty ? "bad" : "good"),
    stat("최장", `${longest}자`, longest > 85 ? "warn" : ""),
  );

  // 재생 지점 주변만 그린다 — 3591줄을 전부 그리면 스크롤이 무의미하다
  const from = Math.max(0, (cur < 0 ? 0 : cur) - 4);
  const box = $("#lines");
  box.replaceChildren();
  for (let i = from; i < Math.min(lines.length, from + 40); i++) {
    const l = lines[i];
    const t2 = String(l.trans ?? "");
    const cls = i === cur ? "now"
      : !l.translated ? "raw"
        : t2.trim() ? "done" : "empty";
    const n = el("div", `ln ${cls}`);
    n.append(
      el("div", "t0", `${(+l.start).toFixed(1)} → ${(+l.end).toFixed(1)}`),
      el("div", "o", l.orig),
      el("div", "t", t2),
    );
    box.append(n);
  }
}

boot();
})();
