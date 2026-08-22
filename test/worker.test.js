/* 워커 계약 검사 — 실제 wrangler dev + 실제 LLM 을 때린다.
 *
 * 느리고(요청당 3~17초) 비결정적이라 기본 루프에서 뺀다. 켜려면:
 *     npm run test:e2e            (YTDUAL_E2E=1 + :8787 필요)
 *
 * 번역 "내용"은 검사하지 않는다. 모델이 바뀌면 문장이 바뀌므로 내용에 걸면
 * 테스트가 모델 버전에 묶여 쓸모없어진다. 검사하는 것은 계약뿐이다 —
 * 응답 길이, t/lines 배타성, 캐시 분리, 거절 조건.
 */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.YTDUAL_WORKER ?? "http://127.0.0.1:8787";
const ENABLED = process.env.YTDUAL_E2E === "1";

async function alive() {
  try {
    const c = AbortSignal.timeout(1500);
    await fetch(`${BASE}/api/cards`, { signal: c });
    return true;
  } catch {
    return false;
  }
}

const up = ENABLED && (await alive());
const skip = !ENABLED
  ? "YTDUAL_E2E=1 이 아님 (npm run test:e2e 로 실행)"
  : !up
    ? `워커가 ${BASE} 에 없다 — npm run dev 로 띄우세요`
    : false;

/** 지문이 텍스트로 만들어지므로, 캐시 미스를 확실히 내려면 매 실행 고유 텍스트가 필요하다. */
const nonce = Math.random().toString(36).slice(2, 8);

function segs(n, tag = "") {
  return Array.from({ length: n }, (_, i) => ({
    start: i * 3,
    end: i * 3 + 2.8,
    text: `This is line ${i} about ${tag || nonce} and nothing else.`,
  }));
}

/** W11·W12 의 근거가 되는 값. 상류 형태를 그대로 통과시키므로 경로가 깊다. */
function usageOf(json) {
  const u = json.usage;
  if (!u) return "usage 없음";
  const r = u.completion_tokens_details?.reasoning_tokens ?? 0;
  return `out=${u.completion_tokens ?? "?"} reasoning=${r}`;
}

async function post(body) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/subtitle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => ({}));
  return { res, json, ms: +(performance.now() - t0).toFixed(0) };
}

test("W18 — fast 는 요청한 조각 수와 같은 길이의 t 를 준다", { skip }, async (t) => {
  const s = segs(8, `fastlen-${nonce}`);
  const { res, json, ms } = await post({ videoId: "TEST", segments: s, mode: "fast" });

  assert.equal(res.status, 200, JSON.stringify(json));
  assert.ok(Array.isArray(json.t), "t 가 배열이 아니다");
  assert.equal(json.t.length, s.length, "I18 위반 — 길이가 다르다");
  assert.equal(json.lines, undefined, "t 와 lines 가 동시에 왔다");
  assert.ok(json.t.every((x) => typeof x === "string" && x.trim()), "빈 번역이 있다");
  t.diagnostic(`fast N=8  ${ms}ms  ${usageOf(json)}`);
});

test("full 은 lines 를 주고 t 는 주지 않는다", { skip }, async (t) => {
  const s = segs(12, `fulllen-${nonce}`);
  const { res, json, ms } = await post({ videoId: "TEST", segments: s, mode: "full" });

  assert.equal(res.status, 200, JSON.stringify(json));
  assert.ok(Array.isArray(json.lines) && json.lines.length, "lines 가 비었다");
  assert.equal(json.t, undefined, "full 인데 t 가 왔다");
  for (const l of json.lines) {
    assert.equal(typeof l.start, "number");
    assert.equal(typeof l.end, "number");
    assert.ok(l.end >= l.start, `end < start: ${JSON.stringify(l)}`);
  }
  t.diagnostic(`full N=12 ${ms}ms  lines=${json.lines.length}  ${usageOf(json)}`);
});

test("W13 — 같은 조각이라도 mode 가 다르면 캐시가 분리된다", { skip }, async (t) => {
  const s = segs(6, `cachesplit-${nonce}`);

  const fast = await post({ videoId: "MODE", segments: s, mode: "fast" });
  const full = await post({ videoId: "MODE", segments: s, mode: "full" });

  assert.ok(Array.isArray(fast.json.t), "fast 응답이 오염됐다");
  assert.ok(Array.isArray(full.json.lines), "full 요청이 fast 캐시를 받았다");
  assert.equal(full.json.t, undefined);
  t.diagnostic(`fast ${fast.ms}ms / full ${full.ms}ms — 분리 확인`);
});

test("W2 — 두 번째 요청은 캐시 히트이고 결과가 같다", { skip }, async (t) => {
  const s = segs(6, `cachehit-${nonce}`);
  const a = await post({ videoId: "CACHE", segments: s, mode: "fast" });
  const b = await post({ videoId: "CACHE", segments: s, mode: "fast" });

  assert.equal(a.json.cached, false, "첫 요청이 이미 캐시됨 — nonce 가 안 먹었다");
  assert.equal(b.json.cached, true, "두 번째가 캐시 히트가 아니다");
  assert.deepEqual(b.json.t, a.json.t, "캐시 결과가 원본과 다르다");
  t.diagnostic(`미스 ${a.ms}ms → 히트 ${b.ms}ms`);
});

test("W15 — fast 는 빈 조각이 섞이면 거절한다", { skip }, async () => {
  const s = segs(4, `empty-${nonce}`);
  s[2].text = "   ";
  const { res, json } = await post({ videoId: "EMPTY", segments: s, mode: "fast" });

  assert.equal(res.status, 400, `거절하지 않았다: ${JSON.stringify(json)}`);
});

test("잘못된 요청은 400 이다", { skip }, async () => {
  const a = await post({ segments: segs(2) });
  assert.equal(a.res.status, 400, "videoId 없는데 통과했다");
  const b = await post({ videoId: "X", segments: [] });
  assert.equal(b.res.status, 400, "빈 segments 가 통과했다");
});
