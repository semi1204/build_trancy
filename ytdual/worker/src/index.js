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
const REASONING = "low";     // 번역은 추론이 거의 필요 없음. none 도 가능
const BATCH = 200;           // 컨텍스트 1.05M 이라 넉넉히. 문맥이 클수록 번역 품질↑
const CONCURRENCY = 3;
const MAX_SEGMENTS = 8000;
const MAX_CARDS = 2000;

const SYSTEM = (target) => `You merge broken YouTube caption fragments into natural sentences and translate them for a language learner.

Rules:
- Merge fragments belonging to one sentence. Split run-on blocks at sentence boundaries.
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
async function translateBatch(env, batch, target) {
  const payload = batch.map((s, i) => `${i}: ${s.text}`).join("\n");

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
          start: batch[s].start,
          end: batch[e].end,
          orig,
          trans: String(ln.t ?? "").trim(),
        });
      }
      if (out.length) return { lines: out };
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

async function translateAll(env, segments, target) {
  const batches = [];
  for (let i = 0; i < segments.length; i += BATCH) {
    batches.push(segments.slice(i, i + BATCH));
  }

  const results = new Array(batches.length);
  let cursor = 0, degraded = 0;

  const runner = async () => {
    while (cursor < batches.length) {
      const my = cursor++;
      const r = await translateBatch(env, batches[my], target);
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

  const { videoId, lang = "", target = "Korean", segments } = body;
  if (!videoId || !Array.isArray(segments) || !segments.length) {
    return json({ error: "videoId 와 segments 가 필요합니다" }, 400);
  }
  if (segments.length > MAX_SEGMENTS) {
    return json({ error: `자막이 너무 깁니다 (${segments.length}줄)` }, 413);
  }

  const fingerprint = await sha1(segments.map((s) => s.text).join("\u0001"));
  const key = `sub:v2:${videoId}:${lang}:${target}:${fingerprint.slice(0, 12)}`;

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

  const { lines, degraded } = await translateAll(env, clean, target);
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
    if (p === "/api/cards" && m === "GET") return handleCardsGet(url, env);
    if (p === "/api/cards" && m === "POST") return handleCardsPost(request, env);
    if (p === "/api/cards/ack" && m === "POST") return handleCardsAck(request, env);

    return json({ error: "not found" }, 404);
  },
};
