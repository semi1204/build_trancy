/**
 * YT Dual Worker v2
 *
 *  POST /api/subtitle    자막 재분할 + 번역 (KV 캐시)
 *  POST /api/transcribe  오디오 청크 → Groq Whisper 전사 (자막 트랙 없는 영상용)
 *  POST /api/cards       폰에서 저장한 카드 쌓기
 *  GET  /api/cards       PC에서 대기 중인 카드 가져오기
 *  POST /api/cards/ack   Anki 반영 끝난 카드 비우기
 *
 * 확장이 자막을 직접 가져오므로 Worker는 유튜브에 접속하지 않습니다.
 */

const LLM_MODEL = "gpt-5.6-luna";
const DEFAULT_LLM_URL = "https://api.openai.com/v1/chat/completions";
// TODO(phase6): REASONING 을 "none"(또는 최소값)으로 낮춘다. 추론 모델의 사고 토큰이 응답
//   지연의 큰 몫을 차지한다. 다만 번역 품질이 함께 떨어질 수 있으므로 Phase 4 육안 확인에서
//   나빠지면 이 항목만 단독으로 되돌린다.
const REASONING = "low";     // 번역은 추론이 거의 필요 없음. none 도 가능
// TODO(phase6): 이 값을 Phase 4 측정 0 에서 나온 LLM 왕복 실측치의 3~4배로 다시 정한다.
//   90000 은 측정 전에 임의로 넣은 값이라 근거가 없다.
const LLM_TIMEOUT_MS = 90000;  // LLM 호출 1회의 상한. 멈춘 업스트림이 슬롯을 영구 점유하지 못하게 한다
// TODO(phase6): BATCH/CONCURRENCY 가 현재 죽은 코드임을 주석으로 명시한다. 확장이 48줄씩
//   보내므로 배치는 항상 1개이고 내부 동시성 runner 는 한 번도 2개 이상 돈 적이 없다.
//   값은 바꾸지 않는다 — 실제 동시성 손잡이는 확장의 runner 개수뿐이다.
const BATCH = 200;           // 컨텍스트 1.05M 이라 넉넉히. 문맥이 클수록 번역 품질↑
const CONCURRENCY = 3;
const MAX_SEGMENTS = 8000;
const MAX_CARDS = 2000;

const SYSTEM = (target) => `You merge broken YouTube caption fragments into natural subtitle lines and translate them for a language learner.

Work in two steps:
1) MERGE: join fragments into complete sentences with proper punctuation.
   Fragments are cut mid-sentence at random points — a fragment boundary
   means nothing. Never end a line just because a fragment ended.
2) SPLIT into subtitle lines:
   - A sentence of up to ~14 words is ONE line. Never put two sentences in one line.
   - A longer sentence becomes several lines of ~5-12 words, each split at a
     clause boundary (comma, conjunction, relative clause) so every line is a
     coherent phrase. Never end a line on a dangling subject, article, or
     preposition ("... so I" is wrong; break before "so").
   - A very short interjection ("Yeah.", "[sighs]") joins the adjacent line.
   - A trailing conjunction or discourse marker ("So,", "And", "But") STARTS
     the next line — it never ends a line.

Rules:
- Lines starting with "CTX-" (preceding) or "CTX+" (following) are surrounding
  context only. Use them so the translation connects naturally across chunk
  boundaries, but NEVER output lines for them — indices cover only the
  numbered fragments.
- Use the surrounding context: resolve pronouns and dropped subjects so each line reads naturally on its own.
- Never invent, omit, summarize, or reorder content.
- "s" = index of the FIRST source fragment a line covers, "e" = index of the LAST.
- Indices must be non-decreasing and must cover every fragment exactly once.
- "o" = cleaned original text with proper punctuation and capitalization.
- "t" = natural translation into ${target}. Translate meaning, not word-for-word. Keep proper nouns and technical terms.
- Output ONLY: {"lines":[{"s":0,"e":1,"o":"...","t":"..."}]}
No markdown fences, no commentary.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",   // Chrome PNA: https 페이지 → localhost dev worker
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

async function sha1(str) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 번역 ─────────────────────────────────────────────────────────────
async function translateBatch(env, batch, target, ctxB = [], ctxA = []) {
  const payload =
    ctxB.map((t) => `CTX-: ${t}`).join("\n") +
    (ctxB.length ? "\n" : "") +
    batch.map((s, i) => `${i}: ${s.text}`).join("\n") +
    (ctxA.length ? "\n" + ctxA.map((t) => `CTX+: ${t}`).join("\n") : "");

  // TODO(phase6): 아래 fetch 에 AbortController + LLM_TIMEOUT_MS 를 건다. 지금은 타임아웃이
  //   없어 업스트림이 멈추면 요청이 무기한 매달리고, 확장 쪽 runner 도 함께 묶인다 (불변식 10).
  //   타임아웃 만료는 기존 catch 로 떨어져 재시도 경로를 그대로 탄다.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(env.LLM_URL || DEFAULT_LLM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          reasoning: { effort: REASONING },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM(target) },
            { role: "user", content: payload },
          ],
        }),
      });

      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`llm ${res.status}`);

      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      const out = [];

      for (const ln of parsed.lines || []) {
        const s = Math.max(0, Math.min(Number(ln.s) | 0, batch.length - 1));
        const e = Math.max(s, Math.min(Number(ln.e) | 0, batch.length - 1));
        const orig = String(ln.o ?? "").trim();
        if (!orig) continue;
        out.push({
          s,
          e,
          start: batch[s].start,
          end: batch[e].end,
          orig,
          trans: String(ln.t ?? "").trim(),
        });
      }
      // 같은 fragment 구간을 여러 줄로 쪼갠 경우 시간도 글자수 비례로 나눈다
      // (안 나누면 start 가 같아져 앞줄이 표시되지 않는다)
      let i = 0;
      while (i < out.length) {
        let j = i;
        while (j + 1 < out.length && out[j + 1].s === out[i].s && out[j + 1].e === out[i].e) j++;
        if (j > i) {
          const t0 = out[i].start, t1 = out[i].end;
          const total = out.slice(i, j + 1).reduce((n, l) => n + l.orig.length, 0) || 1;
          let acc = 0;
          for (let k = i; k <= j; k++) {
            out[k].start = t0 + ((t1 - t0) * acc) / total;
            acc += out[k].orig.length;
            out[k].end = t0 + ((t1 - t0) * acc) / total;
          }
        }
        i = j + 1;
      }
      if (out.length) return { lines: out.map(({ s, e, ...rest }) => rest) };
    } catch {
      if (attempt === 2) break;
      await sleep(500 * 2 ** attempt);
    }
  }

  // 포기 - 원문만 살려 진행. 전체가 날아가지 않게.
  return {
    lines: batch.map((s) => ({ start: s.start, end: s.end, orig: s.text, trans: "" })),
    degraded: true,
  };
}

// ── 긴 줄 강제 분할 (LLM 이 제한을 어겨도 자막은 짧게 유지) ──────────
// TODO(phase6): 70 은 1차 프롬프트가 요구하는 "5~12 단어"(영어로 대략 60~75자)와 충돌해서
//   거의 모든 청크가 2차 분할 경로를 타게 만든다. 85 정도로 올려 2차 패스 자체가 드물게
//   발동하도록 한다. Phase 4 측정 4 에서 줄 길이 육안 확인 후 확정.
const MAX_LINE_CHARS = 70;

/** 절 경계(쉼표·마침표류)로 쪼개고, 그래도 긴 조각은 단어 경계에서 자른다 */
function clausePieces(s) {
  return s
    .split(/(?<=[,;:.!?…。、])\s*/)
    .flatMap((p) => {
      const out = [];
      let t = p.trim();
      while (t.length > MAX_LINE_CHARS) {
        let cut = t.lastIndexOf(" ", MAX_LINE_CHARS);
        if (cut < 20) cut = MAX_LINE_CHARS;
        out.push(t.slice(0, cut).trim());
        t = t.slice(cut).trim();
      }
      if (t) out.push(t);
      return out;
    })
    .filter(Boolean);
}

/** 원문용: 하드 캡을 넘지 않게 앞에서부터 채워 묶는다 */
function packByCap(pieces) {
  const groups = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && (cur.length + 1 + p.length) > MAX_LINE_CHARS) { groups.push(cur); cur = p; }
    else cur = cur ? cur + " " + p : p;
  }
  if (cur) groups.push(cur);
  return groups;
}

/** 번역용: 정확히 k 그룹으로, 글자수 균형을 맞춰 묶는다 */
function packToK(pieces, k) {
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const groups = [];
  let cur = "", done = 0;
  for (let i = 0; i < pieces.length; i++) {
    cur = cur ? cur + " " + pieces[i] : pieces[i];
    done += pieces[i].length;
    const groupsLeft = k - groups.length - 1;
    const piecesLeft = pieces.length - i - 1;
    if (groupsLeft > 0 && piecesLeft >= groupsLeft) {
      const target = (total * (groups.length + 1)) / k;
      const nextLen = i + 1 < pieces.length ? pieces[i + 1].length : 0;
      if (done >= target || done + nextLen / 2 > target) { groups.push(cur); cur = ""; }
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

function splitLine(line) {
  if (line.orig.length <= MAX_LINE_CHARS) return [line];
  const oParts = packByCap(clausePieces(line.orig));
  const n = oParts.length;
  if (n < 2) return [line];
  const tParts = line.trans ? packToK(clausePieces(line.trans), n) : [];
  const dur = line.end - line.start;
  const total = oParts.reduce((s, p) => s + p.length, 0) || 1;
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const start = line.start + (dur * acc) / total;
    acc += oParts[i].length;
    out.push({ start, end: line.start + (dur * acc) / total, orig: oParts[i], trans: tParts[i] || "" });
  }
  return out;
}

/** 긴 줄 분할 2차 패스: 원문·번역을 의미 정렬 상태로 함께 k 등분시킨다.
 *  (기계 분할은 두 언어의 절 경계가 어긋나 번역이 반토막 나므로 폴백으로만 쓴다) */
const SPLIT_SYSTEM = `You split subtitle line pairs into shorter aligned pairs.
For each input item, split the original "o" into "k" consecutive shorter lines
at natural clause boundaries, and split the translation "t" into the same
number of parts so each part translates its corresponding original part.
- Do not add, drop, reorder, or reword anything.
- A trailing conjunction or discourse marker ("So,", "And") belongs with the FOLLOWING line.
- Every part must be non-empty; parts joined in order must reproduce the full text.
Output ONLY: {"items":[{"parts":[{"o":"...","t":"..."}]}]} — items in input order.
No markdown fences, no commentary.`;

// TODO(phase6): enforceShortLines 에서 이 함수 호출을 걷어내면 llmSplitLines 와 SPLIT_SYSTEM
//   의 호출자가 0이 된다. 삭제할지 남길지는 Phase 4 측정 4(품질 회귀)를 보고 사용자가 정한다.
//   품질 회귀가 크면 크리티컬 패스 밖(ctx.waitUntil 로 캐시만 개선)으로 옮기는 안이 남아 있다.
async function llmSplitLines(env, items) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.LLM_URL || DEFAULT_LLM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          reasoning: { effort: REASONING },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SPLIT_SYSTEM },
            { role: "user", content: JSON.stringify(items) },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`llm ${res.status}`);
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      if (Array.isArray(parsed.items)) return parsed.items;
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
  return null;
}

async function enforceShortLines(env, lines) {
  const idx = lines.map((l, i) => (l.orig.length > MAX_LINE_CHARS ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return lines;

  const items = idx.map((i) => ({
    o: lines[i].orig,
    t: lines[i].trans,
    k: Math.min(6, Math.ceil(lines[i].orig.length / 55)),
  }));
  // 한 번에 너무 많이 보내지 않는다
  // TODO(phase6): 이 LLM 2차 패스를 크리티컬 패스에서 제거하고 splitLine() 기계 분할만 쓴다.
  //   지금은 70자 초과 줄이 하나만 있어도 LLM 왕복이 1회 더 붙어 청크당 지연이 사실상 2배가
  //   된다 — "첫 자막까지 오래 걸린다"의 두 번째 원인이다 (불변식 9: 청크당 왕복 1회 이하).
  //   대가는 원문·번역의 줄바꿈 위치가 어긋나는 품질 회귀이며, Phase 4 측정 4 로 크기를 잰다.
  const results = [];
  for (let i = 0; i < items.length; i += 30) {
    const part = env.OPENAI_API_KEY ? await llmSplitLines(env, items.slice(i, i + 30)) : null;
    results.push(...(part || items.slice(i, i + 30).map(() => null)));
  }

  const out = [];
  lines.forEach((l, i) => {
    const pos = idx.indexOf(i);
    if (pos === -1) { out.push(l); return; }
    let pieces =
      results[pos] && Array.isArray(results[pos].parts) && results[pos].parts.length >= 2
        ? results[pos].parts
            .map((p) => ({ orig: String(p.o ?? "").trim(), trans: String(p.t ?? "").trim() }))
            .filter((p) => p.orig)
        : null;
    if (pieces && pieces.some((p) => p.orig.length > MAX_LINE_CHARS + 15)) pieces = null;
    if (!pieces) { out.push(...splitLine(l)); return; }   // 기계 분할 폴백
    const dur = l.end - l.start;
    const total = pieces.reduce((n, p) => n + p.orig.length, 0) || 1;
    let acc = 0;
    for (const p of pieces) {
      const start = l.start + (dur * acc) / total;
      acc += p.orig.length;
      out.push({ start, end: l.start + (dur * acc) / total, orig: p.orig, trans: p.trans });
    }
  });
  return out;
}

async function translateAll(env, segments, target, ctxB = [], ctxA = []) {
  const batches = [];
  for (let i = 0; i < segments.length; i += BATCH) {
    batches.push(segments.slice(i, i + BATCH));
  }

  const results = new Array(batches.length);
  let cursor = 0, degraded = 0;

  const runner = async () => {
    while (cursor < batches.length) {
      const my = cursor++;
      // 요청 문맥은 첫/마지막 배치에만 붙인다 (중간 배치는 이웃 배치가 곧 문맥)
      const r = await translateBatch(
        env, batches[my], target,
        my === 0 ? ctxB : [],
        my === batches.length - 1 ? ctxA : []
      );
      if (r.degraded) degraded++;
      results[my] = r.lines;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runner)
  );

  return { lines: results.flat().sort((a, b) => a.start - b.start), degraded };
}

async function handleSubtitle(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }

  const { videoId, lang = "", target = "Korean", segments, ctxBefore, ctxAfter } = body;
  if (!videoId || !Array.isArray(segments) || !segments.length) {
    return json({ error: "videoId 와 segments 가 필요합니다" }, 400);
  }
  if (segments.length > MAX_SEGMENTS) {
    return json({ error: `자막이 너무 깁니다 (${segments.length}줄)` }, 413);
  }

  const ctxB = (Array.isArray(ctxBefore) ? ctxBefore : []).map((t) => String(t).slice(0, 400)).slice(-12);
  const ctxA = (Array.isArray(ctxAfter) ? ctxAfter : []).map((t) => String(t).slice(0, 400)).slice(0, 12);

  const fingerprint = await sha1(
    [...ctxB, "\u0002", ...segments.map((s) => s.text), "\u0002", ...ctxA].join("\u0001")
  );
  // TODO(phase6): 캐시 키를 v5 → v6 으로 올린다. MAX_LINE_CHARS 조정과 2차 분할 제거로
  //   출력 줄 형태가 바뀌는데, 키를 그대로 두면 옛 형태의 캐시가 계속 서빙된다 (불변식 6).
  const key = `sub:v5:${videoId}:${lang}:${target}:${fingerprint.slice(0, 12)}`;  // v5: 문맥 연결 번역

  const hit = env.SUBS && (await env.SUBS.get(key, "json"));
  if (hit) return json({ lines: hit, cached: true });

  if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY 미설정" }, 500);

  const clean = segments
    .filter((s) => typeof s.text === "string" && s.text.trim())
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || Number(s.start) || 0,
      text: s.text.trim().slice(0, 400),
    }));

  let { lines, degraded } = await translateAll(env, clean, target, ctxB, ctxA);
  lines = await enforceShortLines(env, lines);   // 캐시에도 분할된 형태로 저장된다
  if (!lines.length) return json({ error: "번역 실패" }, 502);

  // 일부라도 실패했으면 캐시하지 않는다 (다음에 온전히 재시도)
  if (env.SUBS && !degraded) ctx.waitUntil(env.SUBS.put(key, JSON.stringify(lines)));

  return json({ lines, cached: false, degraded: degraded > 0 });
}

// ── 전사 (자막 트랙 없는 영상 → Groq Whisper) ────────────────────────
const ASR_MODEL = "whisper-large-v3";
const ASR_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

async function handleTranscribe(request, env) {
  if (!env.GROQ_API_KEY) return json({ error: "GROQ_API_KEY 미설정" }, 500);

  let form;
  try { form = await request.formData(); } catch { return json({ error: "multipart form 필요" }, 400); }

  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "file 필드 필요" }, 400);
  if (file.size > MAX_AUDIO_BYTES) return json({ error: `오디오가 너무 큽니다 (${file.size}B)` }, 413);

  const out = new FormData();
  out.append("file", file, file.name || "chunk.webm");
  out.append("model", ASR_MODEL);
  out.append("response_format", "verbose_json");
  const lang = form.get("language");
  if (lang && typeof lang === "string" && /^[a-z]{2}$/.test(lang)) out.append("language", lang);

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(ASR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: out,
    });
    if (res.status === 429 || res.status >= 500) { await sleep(500 * 2 ** attempt); continue; }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ error: `groq ${res.status} ${detail.slice(0, 200)}` }, 502);
    }
    const data = await res.json();
    const segments = (data.segments || [])
      .map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text || "").trim(),
      }))
      .filter((s) => s.text);
    return json({ segments });
  }
  return json({ error: "groq 재시도 초과" }, 502);
}

// ── 단어 사전 (자막 단어 클릭 → 문맥상 뜻) ──────────────────────────
const WORD_SYSTEM = (target) => `You are a dictionary for a language learner. Given a word and the sentence it appears in, explain it in ${target}.
- "meaning": what the word means IN THIS SENTENCE, in ${target}, one short phrase.
- "base": dictionary form with part of speech and 1-2 core senses, one short line in ${target}.
Output ONLY: {"meaning":"...","base":"..."}
No markdown fences, no commentary.`;

async function handleWord(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { word, sentence = "", target = "Korean" } = body;
  if (!word || typeof word !== "string") return json({ error: "word 필요" }, 400);

  const fp = await sha1(`${word}${sentence}${target}`);
  const key = `word:v1:${fp.slice(0, 16)}`;
  const hit = env.SUBS && (await env.SUBS.get(key, "json"));
  if (hit) return json({ ...hit, cached: true });
  if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY 미설정" }, 500);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.LLM_URL || DEFAULT_LLM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          reasoning: { effort: REASONING },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: WORD_SYSTEM(target) },
            { role: "user", content: JSON.stringify({ word: word.slice(0, 60), sentence: sentence.slice(0, 400) }) },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`llm ${res.status}`);
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      const out = {
        meaning: String(parsed.meaning ?? "").trim(),
        base: String(parsed.base ?? "").trim(),
      };
      if (out.meaning) {
        if (env.SUBS) ctx.waitUntil(env.SUBS.put(key, JSON.stringify(out)));
        return json({ ...out, cached: false });
      }
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
  return json({ error: "사전 실패" }, 502);
}

// ── 페이지 번역 (문단 밑에 번역 삽입) ───────────────────────────────
const PAGE_SYSTEM = (target) => `Translate each numbered text into ${target}, as a professional translator would for a published ${target} edition of this web page.
- Translate meaning, not words: rephrase into what a native ${target} writer
  would naturally say. Never leave stiff, word-for-word phrasing.
- Keep the register consistent: documentation in plain declarative style,
  casual writing in a casual voice.
- Keep proper nouns, code, commands, and technical identifiers untranslated.
- If a text is already in ${target}, return it unchanged.
- Texts may contain inline markers like <t0>…</t0> (links, bold, code spans).
  Keep each marker pair, with the SAME number, around the corresponding
  translated words. Never drop, add, nest, or renumber markers.
Output ONLY: {"t":["...","..."]} — one translation per input, same order, same count.
No markdown fences, no commentary.`;

async function handlePage(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }
  const { texts, target = "Korean" } = body;
  if (!Array.isArray(texts) || !texts.length) return json({ error: "texts 필요" }, 400);
  if (texts.length > 200) return json({ error: `texts 너무 많음 (${texts.length})` }, 413);
  const clean = texts.map((t) => String(t).slice(0, 2000));

  const fp = await sha1(clean.join("") + "" + target);
  const key = `page:v2:${fp.slice(0, 16)}`;
  const hit = env.SUBS && (await env.SUBS.get(key, "json"));
  if (hit) return json({ t: hit, cached: true });
  if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY 미설정" }, 500);

  const payload = clean.map((t, i) => `${i}: ${t}`).join("\n");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(env.LLM_URL || DEFAULT_LLM_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          reasoning: { effort: "medium" },   // 페이지 번역은 실시간성이 덜해 품질 우선
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: PAGE_SYSTEM(target) },
            { role: "user", content: payload },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`llm ${res.status}`);
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      const t = Array.isArray(parsed.t) ? parsed.t.map((x) => String(x ?? "")) : null;
      if (t && t.length === clean.length) {
        if (env.SUBS) ctx.waitUntil(env.SUBS.put(key, JSON.stringify(t)));
        return json({ t, cached: false });
      }
    } catch {
      await sleep(500 * 2 ** attempt);
    }
  }
  return json({ error: "번역 실패" }, 502);
}

// ── 카드 큐 (폰에서 저장 → PC 에서 Anki 로) ──────────────────────────
const cardsKey = (uid) => `cards:${uid}`;

async function handleCardsGet(url, env) {
  const uid = url.searchParams.get("uid");
  if (!uid) return json({ error: "uid 필요" }, 400);
  const list = (env.SUBS && (await env.SUBS.get(cardsKey(uid), "json"))) || [];
  return json({ cards: list });
}

async function handleCardsPost(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }

  const { uid, cards } = body;
  if (!uid || !Array.isArray(cards) || !cards.length) {
    return json({ error: "uid 와 cards 필요" }, 400);
  }
  if (!env.SUBS) return json({ error: "KV 미설정" }, 500);

  const existing = (await env.SUBS.get(cardsKey(uid), "json")) || [];
  const seen = new Set(existing.map((c) => c.id));
  let added = 0;

  for (const c of cards) {
    const id = String(c.id || "").slice(0, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    existing.push({
      id,
      word: String(c.word || "").slice(0, 120),
      sentence: String(c.sentence || "").slice(0, 600),
      translation: String(c.translation || "").slice(0, 600),
      videoId: String(c.videoId || "").slice(0, 20),
      title: String(c.title || "").slice(0, 200),
      start: Number(c.start) || 0,
      savedAt: Date.now(),
    });
    added++;
  }

  const trimmed = existing.slice(-MAX_CARDS);
  await env.SUBS.put(cardsKey(uid), JSON.stringify(trimmed));
  return json({ ok: true, added, total: trimmed.length });
}

async function handleCardsAck(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }

  const { uid, ids } = body;
  if (!uid) return json({ error: "uid 필요" }, 400);
  if (!env.SUBS) return json({ error: "KV 미설정" }, 500);

  if (!Array.isArray(ids)) {
    await env.SUBS.delete(cardsKey(uid));
    return json({ ok: true, remaining: 0 });
  }

  const done = new Set(ids);
  const list = (await env.SUBS.get(cardsKey(uid), "json")) || [];
  const rest = list.filter((c) => !done.has(c.id));
  await env.SUBS.put(cardsKey(uid), JSON.stringify(rest));
  return json({ ok: true, remaining: rest.length });
}

// ── 라우팅 ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;

    if (p === "/") return new Response("YT Dual worker v2 ok", { headers: CORS });
    if (p === "/api/subtitle" && m === "POST") return handleSubtitle(request, env, ctx);
    if (p === "/api/transcribe" && m === "POST") return handleTranscribe(request, env);
    if (p === "/api/word" && m === "POST") return handleWord(request, env, ctx);
    if (p === "/api/page" && m === "POST") return handlePage(request, env, ctx);
    if (p === "/api/cards" && m === "GET") return handleCardsGet(url, env);
    if (p === "/api/cards" && m === "POST") return handleCardsPost(request, env);
    if (p === "/api/cards/ack" && m === "POST") return handleCardsAck(request, env);

    return json({ error: "not found" }, 404);
  },
};
