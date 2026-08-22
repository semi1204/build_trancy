/* 워커 계약 검사 — 실제 wrangler dev + 실제 LLM 을 때린다.
 *
 * 느리고(요청당 3~17초) 비결정적이라 기본 루프에서 뺀다. 켜려면:
 *     npm run test:e2e            (YTDUAL_E2E=1 + :8787 필요)
 *
 * 번역 "내용"은 검사하지 않는다. 모델이 바뀌면 문장이 바뀌므로 내용에 걸면
 * 테스트가 모델 버전에 묶여 쓸모없어진다. 검사하는 것은 계약뿐이다 —
 * 구간 커버리지, 빈 번역 없음, 캐시, 거절 조건.
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

test("응답은 lines 이고 시간이 유효하다", { skip }, async (t) => {
  const s = segs(12, `lines-${nonce}`);
  const { res, json, ms } = await post({ videoId: "TEST", segments: s });

  assert.equal(res.status, 200, JSON.stringify(json));
  assert.ok(Array.isArray(json.lines) && json.lines.length, "lines 가 비었다");
  assert.equal(json.t, undefined, "t 는 더 이상 존재하지 않는다");
  for (const l of json.lines) {
    assert.equal(typeof l.start, "number");
    assert.equal(typeof l.end, "number");
    assert.ok(l.end >= l.start, `end < start: ${JSON.stringify(l)}`);
    assert.ok(String(l.orig).trim(), "원문이 빈 줄이 있다");
  }
  t.diagnostic(`N=12 ${ms}ms  lines=${json.lines.length}  ${usageOf(json)}`);
});

test("★ 응답이 요청 구간을 빠짐없이 덮는다 (mergeTranslated I5 의 전제)", { skip }, async (t) => {
  const s = segs(12, `cover-${nonce}`);
  const { json } = await post({ videoId: "COVER", segments: s });

  assert.ok(Array.isArray(json.lines), JSON.stringify(json));
  assert.equal(json.lines[0].start, s[0].start, "시작이 밀렸다");
  assert.equal(json.lines.at(-1).end, s.at(-1).end, "끝이 밀렸다");
  // 묶음은 연속이어야 한다 — 사이가 벌어지면 그 시각에 화면이 빈다
  for (let i = 1; i < json.lines.length; i++) {
    assert.ok(json.lines[i].start <= json.lines[i - 1].end + 1e-6,
      `${i}번 줄 앞에 구멍: ${json.lines[i - 1].end} → ${json.lines[i].start}`);
  }
  t.diagnostic(`${s.length}조각 → ${json.lines.length}줄`);
});

test("★ 번역이 빈 줄이 없다 (W19 — 빈 줄은 영영 안 채워진다)", { skip }, async (t) => {
  const s = segs(12, `empty-${nonce}`);
  const { json } = await post({ videoId: "EMPTY2", segments: s });

  const empty = (json.lines || []).filter((l) => !String(l.trans ?? "").trim());
  assert.equal(empty.length, 0,
    `빈 번역 ${empty.length}개: ${empty.map((l) => l.orig.slice(0, 40)).join(" | ")}`);
  t.diagnostic(`${json.lines.length}줄 전부 번역됨`);
});

test("W2 — 두 번째 요청은 캐시 히트이고 결과가 같다", { skip }, async (t) => {
  const s = segs(6, `cachehit-${nonce}`);
  const a = await post({ videoId: "CACHE", segments: s });
  const b = await post({ videoId: "CACHE", segments: s });

  assert.equal(a.json.cached, false, "첫 요청이 이미 캐시됨 — nonce 가 안 먹었다");
  assert.equal(b.json.cached, true, "두 번째가 캐시 히트가 아니다");
  assert.deepEqual(b.json.lines, a.json.lines, "캐시 결과가 원본과 다르다");
  t.diagnostic(`미스 ${a.ms}ms → 히트 ${b.ms}ms`);
});

test("잘못된 요청은 400 이다", { skip }, async () => {
  const a = await post({ segments: segs(2) });
  assert.equal(a.res.status, 400, "videoId 없는데 통과했다");
  const b = await post({ videoId: "X", segments: [] });
  assert.equal(b.res.status, 400, "빈 segments 가 통과했다");
});
