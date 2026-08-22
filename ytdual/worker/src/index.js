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
 *
 * ── 불변식 ──────────────────────────────────────────────────────────
 * [실측] 은 Phase 4 에서 실제로 실행해 확인한 것.
 *
 *  W1  degraded(일부 배치 실패) 결과는 캐시하지 않는다. 캐시하면 실패가 영구화된다.
 *  W2  출력 줄의 형태나 프롬프트 의미가 바뀌면 캐시 키 버전을 반드시 올린다.
 *      안 올리면 옛 형태의 결과가 계속 서빙되어 변경이 없던 일이 된다.
 *  W3  요청 하나의 크리티컬 패스에 LLM 왕복은 1회 이하다 (확장이 BATCH 보다 작게
 *      보내는 한). 2차 패스를 되살리면 청크당 지연이 그대로 2배가 된다.
 *  W4  MAX_LINE_CHARS 는 1차 프롬프트가 실제로 생성하는 최대 줄 길이보다 커야 한다.
 *      작으면 사실상 모든 요청이 분할 경로를 타므로 W3 가 깨진다.        [실측: 관측 최장 82자]
 *  W5  모든 상류 fetch 는 유한 타임아웃을 가진다. 타임아웃이 없으면 멈춘 업스트림
 *      하나가 요청을 무기한 붙잡고 확장 쪽 runner 까지 함께 묶는다.
 *  W6  재시도 층은 하나뿐이다. 확장도 재시도하면 횟수가 곱해진다 (현재 위반).
 *  W7  실패한 배치는 원문만 남기고 반환한다. 요청 전체를 날리지 않는다.
 *  W8  LLM_MODEL 은 GPT 계열이어야 한다. Claude 계열은 이 프록시가 Claude Code
 *      세션으로 라우팅해 시스템 프롬프트를 무시하므로 쓸 수 없다.        [실측]
 *  W9  응답 지연은 출력 토큰 수에 정비례한다. 프롬프트가 더 뱉게 만드는 모든 변경은
 *      곧바로 지연이다.  지연 ≈ 0.019 × 출력토큰 (약 53 tok/s).
 *                                  [실측: 749토큰 14.6초 / 3955토큰 72.7초]
 *
 * ── 거리 기반 2단 이후 추가된 것 ────────────────────────────────────
 *  W10 reasoning: "none" 은 reasoning 을 끄지 못한다. 껐는지 여부는 설정이 아니라
 *      usage.completion_tokens_details.reasoning_tokens 로만 판단할 수 있다.
 *      [실측: effort none 인데 N=12 에서 reasoning 1002토큰 발생]
 *  W11 reasoning 토큰은 요청 크기에 비례하지 않는다. 사실상 요청당 상수라, 청크를
 *      1/4 로 줄여도 지연은 1.76배밖에 안 줄어든다.
 *      [실측: N=12 reasoning 1553 / N=48 reasoning 2090 — 4배 조각에 1.3배]
 *  W12 reasoning 을 만드는 것은 요청 크기가 아니라 프롬프트의 과제 복잡도다.
 *      병합+분할+번역 3중 과제가 원인이고, 번역만 시키면 0 이 된다.
 *      [실측: 같은 12조각 — 병합프롬프트 reasoning 410 / 번역만 148 /
 *             terra + 번역만 0 (2.7초)]
 *  W15 응답 계약은 개수 일치 하나뿐이다. 길이가 다르면 통째로 버린다. 밀린 채로
 *      받아들이면 엉뚱한 시각에 엉뚱한 번역이 붙는데, 그건 번역이 없는 것보다
 *      나쁘고 화면만 봐서는 알아챌 수 없다.
 *  W16 CONTEXT 는 번호 목록 밖의 별도 블록에 둔다. 번호 없는 줄을 목록에 섞으면
 *      모델이 그것까지 세어 길이가 밀린다 — W15 와 같은 실패로 이어진다.
 *      [실측: 섞었을 때 계약위반 3회 중 1~2회 → 분리 후 4회 중 0회]
 *  W17 LLM_MODEL 은 자막·단어팝업·페이지번역이 공유한다. 자막만 바꾸려면 자막
 *      전용 상수를 따로 두어야 한다. 지금 값을 바꾸면 세 기능이 함께 바뀐다.
 * ──────────────────────────────────────────────────────────────────── */

/**
 * @typedef {object} Usage  상류 LLM 응답의 usage 를 그대로 통과시킨 것.
 *   우리가 만드는 형태가 아니라 상류가 주는 형태다 — 래핑하거나 이름을 바꾸지 않는다.
 * @property {number} [prompt_tokens]
 * @property {number} [completion_tokens]  가시 출력 + reasoning 의 합계
 * @property {object} [completion_tokens_details]
 * @property {number} [completion_tokens_details.reasoning_tokens]
 *
 * W9 의 "출력 토큰"이 무엇으로 이루어졌는지를 가르는 값이 reasoning_tokens 다.
 * Phase 0 산술로는 48조각 4000토큰 중 약 2250(56%)이 reasoning 으로 추정되나
 * 확인된 적이 없다. 청크 크기를 정하려면 reasoning 이 요청 크기에 비례하는지
 * 요청당 고정인지를 알아야 하고, 그 답이 이 필드에만 들어 있다.
 *
 * Phase 4 실측으로 확인됨: usage 는 전달되고 reasoning_tokens 도 채워진다.
 * 같은 측정에서 나온 것 — reasoning: "none" 은 reasoning 을 끄지 못한다(N=12 에서
 * 1002토큰 발생). 끄고 켜짐은 설정이 아니라 이 필드로만 판단할 수 있다.
 */

// 불변식 W8: GPT 계열만. Claude 계열로 바꾸면 프록시가 Claude Code 세션으로 라우팅해
//   시스템 프롬프트를 무시한다 (Phase 4 실측: 1.5초 만에 "I'm Claude Code" 응답).
// Phase 4 모델 스윕(12조각, 합성 텍스트): terra 9.7s / 5.4 13.0s /
//   codex-spark 13.1s(reasoning 1만↑) / 5.5 23.2s / luna 60s↑ / 5.4-mini 86.0s.
//   ★ 위 스윕은 합성 텍스트(test/worker.test.js 의 반복 문장)로 쟀다. 실제 자막으로
//     다시 재니 terra 는 9.7s 가 아니라 full N=12 에서 수동 22.5s / 자동 18.5s 였다.
//     모델 간 순위는 유효하되 절대값은 2배 이상 낙관적이다.
//     [scripts/bench-translation.mjs, 실제 자막 4개 fixture, 60요청]
//   W17: 이 상수는 자막·단어팝업·페이지번역이 공유한다. 세 기능이 함께 바뀐다(승인됨).
const LLM_MODEL = "gpt-5.6-terra";
const DEFAULT_LLM_URL = "https://api.openai.com/v1/chat/completions";
// W10: effort 는 reasoning 을 끄지 못한다 — "none" 인데 N=12 에서 reasoning 1002 이
//   나왔고, 실측 재확인에서도 low/none 이 7275ms vs 7257ms 로 사실상 같았다.
//   reasoning 을 줄이는 것은 설정이 아니라 프롬프트 단순화다(W12).
const REASONING = "low";
// 실측 최대 54.9초(옛 병합 프롬프트)의 3배를 1회 상한으로 둔다. 프롬프트를
//   단순화한 뒤 실측 중앙은 4~7초라 여유가 크지만, 상한은 최악을 막는 값이다.
//   너무 짧으면 정상 요청을 끊고, 너무 길면 멈춘 업스트림이 슬롯을 오래 점유한다.
const LLM_TIMEOUT_MS = 165000;
const LLM_ATTEMPTS = 3;      // 실패하면 그 구간이 원문으로 남으므로 끈질기게
// I12 (content.js): 확장 타임아웃 > 165×3 + 백오프 1.5초 ≈ 497초
// 불변식 W3: 확장이 BATCH 보다 작은 요청만 보내는 한 batches.length 는 항상 1 이고,
//   아래 CONCURRENCY runner 풀은 단일 순차 호출로 축퇴한다 — 즉 죽은 코드다.
//   실제 동시성 손잡이는 확장 쪽 runner 개수뿐이다 (I13: 8개 이하).
const BATCH = 200;           // 컨텍스트 1.05M 이라 넉넉히. 문맥이 클수록 번역 품질↑
const CONCURRENCY = 3;
const MAX_SEGMENTS = 8000;
const MAX_CARDS = 2000;

/* 번역 프롬프트. 과제는 "번역" 하나뿐이다.
 *
 * 옛 SYSTEM 은 병합 + 자막줄 분할 + 원문 재출력 + 번역을 한 번에 시켰다. 그
 * 복잡도가 reasoning 을 만들고, reasoning 이 지연을 만들었다 — 지연은 출력
 * 토큰에 거의 비례한다(W9).
 *   [실측 N=12, 실제 자막: 옛 SYSTEM 은 자동생성 ja 에서 out 2478 / reasoning
 *    1925 / 47.1초. 이 프롬프트는 out 204 / reasoning 0 / 5.2초]
 *
 * 무엇을 한 줄로 볼지는 모델이 아니라 우리가 정한다 — groupSegments 가 조각을
 * 문장 끝·글자수·시간 간격으로 묶는다. 기계가 할 수 있는 일을 모델에게 시키면
 * 값을 두 번 치른다: 느려지고, 결과가 매번 달라진다.
 *
 * 계약은 개수 일치 하나뿐이고 기계가 검사한다(W15). 그래서 줄 수를 프롬프트에
 * 숫자로 박는다.
 *
 * W16: CONTEXT 는 번호 목록 밖의 별도 블록이다. 번호 없는 줄을 목록에 섞으면
 *   모델이 그것까지 세어 개수가 밀린다.
 *   [실측: CTX 를 목록에 섞었을 때 계약위반 3회 중 1~2회 → 분리 후 4회 중 0회] */
const SYSTEM = (target, n) => `Translate subtitle lines into natural ${target}.

You will get ${n} numbered lines to translate, and optionally CONTEXT blocks.
CONTEXT is background only — never translate or count it.

- Translate meaning, not word-for-word. Keep proper nouns and technical terms.
- Use the context so pronouns and dropped subjects read naturally.
- A line may be cut mid-sentence. Translate it as the partial phrase it is;
  do not complete it, do not borrow words from the next line.
- Do not merge, split, reorder, add, or omit anything.

Output ONLY: {"t":[...]} with exactly ${n} strings, in the same order.
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

/* ── 조각 묶기 ───────────────────────────────────────────────────────
 * 유튜브 자막 조각은 문장 중간에서 끊긴다. 그걸 그대로 한 줄씩 번역하면 뜻이
 * 안 통하고, 모델에게 병합까지 시키면 느려진다(위 SYSTEM 주석). 그래서 기계가
 * 묶는다 — 규칙이 넷뿐이라 결정적이고, LLM 없이 테스트할 수 있다.
 *
 * 묶은 단위가 곧 화면의 한 줄이다. 그래서 한도를 MAX_LINE_CHARS 에 맞춘다.
 * 이 한도 안에서 만들어지므로 splitLine 이 거의 걸리지 않는다 — 걸리면 원문과
 * 번역의 절 경계가 어긋나므로(W19) 안 걸리는 편이 낫다. */
const MIN_GROUP_CHARS = 15;  // 이보다 짧은 "미완결" 조각은 이웃에 붙인다
const GROUP_MAX_GAP = 1.2;   // 이보다 벌어지면 화면 전환·침묵으로 본다
const GROUP_MAX_SECS = 8;    // 한 줄이 이보다 오래 머무르면 읽는 리듬이 깨진다
const SENTENCE_END = /[.!?…。？！]["'”’)\]]?$/;
// [MUSIC PLAYING], [음악], (笑) 같은 지문은 그 자체로 완결된 한 줄이다. 문장부호로
// 끝나지 않아 SENTENCE_END 에 안 걸리므로 따로 본다. 안 그러면 다음 대사에 붙어
// "[MUSIC PLAYING] [APPLAUSE] SUNDAR PICHAI: Hello, everyone." 같은 줄이 나온다.
const CUE_ONLY = /^[[(（【][^\]）】]*[\])）】]$/;
// 일본어·중국어는 띄어쓰기가 없다. 조각을 공백으로 이으면 없던 공백이 생겨
// 단어가 갈라진다 ("お話を聞いてみ" + "たいと思い" → "…みたいと" 사이에 공백).
// 한글(\uac00-\ud7af)은 띄어쓰기를 쓰므로 제외한다.
// [실측 13 fixture: CJK 경계에서 이어붙이는 지점 10곳]
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const joinText = (a, b) =>
  CJK.test(a.slice(-1)) || CJK.test(b[0] ?? "") ? a + b : `${a} ${b}`;

/**
 * @param {{start:number,end:number,text:string}[]} segs  start 오름차순
 * @returns {{start:number,end:number,text:string,from:number,to:number}[]}
 *   from/to 는 segs 에서의 인덱스 범위(양끝 포함). 모든 조각이 정확히 한 묶음에
 *   들어간다 — 이 성질이 응답 커버리지를 보장한다(구멍이 원천적으로 안 생긴다).
 */
function groupSegments(segs) {
  const out = [];
  let cur = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!cur) { cur = { start: s.start, end: s.end, text: s.text, from: i, to: i }; continue; }
    const joined = joinText(cur.text, s.text);
    // 완결된 줄은 짧아도 혼자 둔다. "Good morning." 은 토막이 아니라 문장이고,
    // 사람이 일부러 한 줄로 끊은 것이다. 붙이면 한 줄에 문장이 둘 이상 들어간다.
    //   [실측: 흡수 규칙에 문장 예외가 없던 동안 사람 자막에서
    //    "[MUSIC PLAYING] [APPLAUSE AND CHEERING] SUNDAR PICHAI: Hello, everyone." 처럼
    //    별개 이벤트 셋이 한 줄로 뭉쳤다]
    // 지문은 앞에서도 뒤에서도 끊는다. 뒤만 보면 "…없이 [clears throat]" 처럼
    // 앞 조각에 먼저 흡수돼 버려 CUE_ONLY 가 걸릴 기회조차 없다.
    const complete = SENTENCE_END.test(cur.text) || CUE_ONLY.test(cur.text) || CUE_ONLY.test(s.text);
    // 미완결인데 아주 짧은 조각만 이웃에 붙인다. "Bien," 한 줄은 "그런데 이" 같은
    // 토막 번역을 낳는다 — 그건 문장이 아니라 잘린 조각이다.
    // [실측 13 fixture: 15자 미만 묶음이 66/1894 = 3.5%]
    const tiny = !complete && cur.text.length < MIN_GROUP_CHARS;
    const cap = tiny ? MAX_LINE_CHARS + 15 : MAX_LINE_CHARS;
    const breakHere =
      complete ||                                  // 앞이 문장이나 지문으로 끝났다
      joined.length > cap ||                       // 자막 한 줄로 읽기엔 길다
      s.start - cur.end > GROUP_MAX_GAP ||         // 침묵이 있었다
      s.end - cur.start > GROUP_MAX_SECS;          // 너무 오래 붙잡는다
    if (breakHere) { out.push(cur); cur = { start: s.start, end: s.end, text: s.text, from: i, to: i }; }
    else { cur.text = joined; cur.end = s.end; cur.to = i; }
  }
  if (cur) out.push(cur);
  return out;
}

/** 번역할 줄과 문맥을 프롬프트 본문으로 만든다.
 *  CONTEXT 를 번호 목록 밖에 두는 것이 핵심이다 (W16). */
function buildPayload(lines, ctxB, ctxA) {
  const parts = [];
  if (ctxB.length) parts.push(`CONTEXT BEFORE:\n${ctxB.join("\n")}`);
  if (ctxA.length) parts.push(`CONTEXT AFTER:\n${ctxA.join("\n")}`);
  parts.push(`TRANSLATE THESE ${lines.length} LINES:\n${lines.map((l, i) => `${i}: ${l.text}`).join("\n")}`);
  return parts.join("\n\n");
}

// ── 번역 ─────────────────────────────────────────────────────────────
/**
 * 조각 묶음 하나를 번역한다.
 * @returns {Promise<{lines: object[], degraded?: boolean, usage?: Usage}>}
 *   usage 는 상류 응답의 것을 그대로 통과시킨다. 상류가 안 주면 필드 자체가 없다
 *   (0 으로 채우지 않는다 — "측정 안 됨"과 "0 토큰"은 다른 사실이다).
 */
async function translateBatch(env, batch, target, ctxB = [], ctxA = []) {
  // 조각을 먼저 묶는다 — 묶은 단위가 곧 화면의 한 줄이고, 모델의 과제는 그것을
  // 번역하는 것뿐이다. 무엇을 한 줄로 볼지는 기계가 정한다 (groupSegments).
  const units = groupSegments(batch);
  const payload = buildPayload(units, ctxB, ctxA);

  let lastUsage;

  // 불변식 10: 이 fetch 는 유한 타임아웃을 가진다. 없으면 멈춘 업스트림 하나가
  //   무기한 매달리고, 확장 쪽 runner 슬롯도 함께 묶인다.
  //   타임아웃 만료는 아래 catch 로 떨어져 기존 재시도 경로를 그대로 탄다.
  for (let attempt = 0; attempt < LLM_ATTEMPTS; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
    try {
      const res = await fetch(env.LLM_URL || DEFAULT_LLM_URL, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          reasoning: { effort: REASONING },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM(target, units.length) },
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
      // reasoning_tokens 는 중첩이다. 평평한 자리를 읽으면 조용히 undefined 가 되어
      // 측정이 되는 것처럼 보이면서 전부 0 이 된다 (Usage typedef 참조).
      if (data.usage) lastUsage = data.usage;
      const parsed = JSON.parse(data.choices[0].message.content);

      // 계약은 개수 하나뿐이다(W15). 묶음이 곧 줄이므로 인덱스가 밀릴 여지가 없고,
      // 커버리지는 groupSegments 가 전 조각을 분할하므로 구조적으로 보장된다.
      // 밀린 채로 받아들이면 엉뚱한 시각에 엉뚱한 번역이 붙는데, 그건 번역이
      // 없는 것보다 나쁘고 화면만 봐서는 알아챌 수 없다.
      const t = parsed.t;
      if (!Array.isArray(t) || t.length !== units.length) {
        throw new Error(`길이 불일치 ${t?.length}/${units.length}`);
      }
      return {
        lines: units.map((u, i) => ({
          start: u.start, end: u.end, orig: u.text, trans: String(t[i] ?? "").trim(),
        })),
        ...(lastUsage ? { usage: lastUsage } : {}),
      };
    } catch {
      if (attempt === LLM_ATTEMPTS - 1) break;
      await sleep(500 * 2 ** attempt);
    } finally {
      // finally 여야 한다 — 위 429/5xx 분기가 continue 로 빠져나가므로
      // try 끝에서 지우면 그 경로에서 타이머가 남는다.
      clearTimeout(timer);
    }
  }

  // 포기 — 원문만 살려 진행한다. 번역은 비지만 화면은 비지 않는다 (I5).
  // usage 는 있으면 싣는다 — 응답은 했는데 파싱만 실패한 시도의 토큰도 실제 소모다.
  // 아무 응답도 못 받았으면 필드를 생략한다(0 으로 채우면 "측정 안 됨"과 뭉개진다).
  return {
    lines: units.map((u) => ({ start: u.start, end: u.end, orig: u.text, trans: "" })),
    degraded: true,
    ...(lastUsage ? { usage: lastUsage } : {}),
  };
}

// ── 긴 줄 강제 분할 (LLM 이 제한을 어겨도 자막은 짧게 유지) ──────────
// 불변식 W4: 이 값이 1차 프롬프트가 실제로 만드는 최대 줄 길이보다 작으면 거의 모든
//   요청이 분할 경로를 타서 W3(왕복 1회 이하)가 깨진다. Phase 4 관측 최장 82자.
const MAX_LINE_CHARS = 85;   // Phase 4 관측 최장 82자 → 85 면 분할 경로가 거의 안 걸린다 (W4)

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

/** 번역을 정확히 k 조각으로 나눈다. 모든 조각은 비어 있지 않다.
 *
 *  불변식 W19: 번역이 있는 줄을 분할했는데 조각 하나가 비면, 그 자리는 영영
 *    번역되지 않는다. 분할된 형태 그대로 KV 에 저장되어 새로고침해도 같기 때문이다.
 *    따라서 이 함수는 k 개를 다 채우거나, 아예 실패([])를 알려야 한다.
 *    중간은 없다 — 조용히 빈칸을 만드는 것이 이 버그의 정체였다.
 *
 *  packToK 만으로는 부족한 이유: packToK 는 pieces.length < k 면 k 개를 만들지
 *    못한다. 한국어 번역은 영어·스페인어 원문보다 절 구분 문장부호가 훨씬 적어
 *    (원문 3절 → 번역 1절) 이 상황이 상시 발생한다.
 *    [실측: 실제 자막 4개 fixture, 24요청 209줄 중 27줄(12.6~13.1%)이 빈 번역.
 *     사슬 밖 단독 빈 줄은 0 — 즉 LLM 이 아니라 이 경로가 원인이었다]
 *
 *  @returns {string[]} 길이 k, 전부 비어 있지 않음. 나눌 수 없으면 [] */
function splitTransToK(text, k) {
  const t = String(text).trim();
  if (k < 2) return t ? [t] : [];

  // 1차: 절 경계. 두 언어의 의미가 맞물리므로 가능하면 이쪽을 쓴다.
  const byClause = packToK(clausePieces(t), k);
  if (byClause.length === k && byClause.every((p) => p.trim())) return byClause;

  // 2차: 글자수 비례. 경계가 어색해질 수 있지만 번역이 통째로 사라지는 것보다 낫다.
  //   공백을 우선 찾고, 없으면(일본어·중국어처럼 띄어쓰기가 없는 언어) 글자로 자른다.
  const out = [];
  let rest = t;
  for (let i = 0; i < k - 1; i++) {
    const want = Math.round(rest.length / (k - i));
    if (want < 1 || rest.length - want < k - i - 1) return [];   // 남은 글자가 조각 수보다 적다
    let cut = rest.lastIndexOf(" ", want);
    if (cut < want / 2) {
      const fwd = rest.indexOf(" ", want);
      cut = fwd > 0 && fwd < want * 1.5 ? fwd : want;
    }
    const head = rest.slice(0, cut).trim();
    const tail = rest.slice(cut).trim();
    if (!head || !tail) return [];
    out.push(head);
    rest = tail;
  }
  out.push(rest);
  return out.length === k && out.every((p) => p.trim()) ? out : [];
}

/** 원문 조각들에 시간을 글자수 비례로 나눠 붙인다. tParts 가 비면 번역 없이 낸다. */
function emitParts(line, oParts, tParts) {
  const dur = line.end - line.start;
  const total = oParts.reduce((s, p) => s + p.length, 0) || 1;
  const out = [];
  let acc = 0;
  for (let i = 0; i < oParts.length; i++) {
    const start = line.start + (dur * acc) / total;
    acc += oParts[i].length;
    out.push({ start, end: line.start + (dur * acc) / total, orig: oParts[i], trans: tParts[i] || "" });
  }
  return out;
}

/* 분할 전략은 2단이다. 원문과 번역의 절 구조가 다르기 때문이다.
 *   [실측 14케이스] 번역의 절 개수가 9/14 에서 1개였다 (원문은 2~4절).
 *   한국어는 영어·스페인어 한 문장을 쉼표 없이 옮기는 경우가 많다.
 *
 * 1차 — 의미 정렬: 원문을 "번역의 절 개수"만큼만 나눈다. 두 언어의 조각이 서로
 *   대응하므로 학습자가 원문↔번역을 짝지어 읽을 수 있다. 대신 조각이 85자를
 *   넘을 수 있다 (실측 최장 114자). 대응이 맞는 편이 짧은 것보다 중요하다.
 * 2차 — 글자수 비례: 번역이 1절뿐이라 정렬이 불가능할 때. 줄은 85자 이하로
 *   유지되지만 원문↔번역 경계가 어긋난다. 그래도 번역이 사라지는 것보다 낫다.
 *
 * 1차만 쓰면 정렬 불가 케이스에서 176자짜리 줄이 나오고, 2차만 쓰면 정렬 가능한
 * 5/14 케이스까지 어긋난다. 그래서 둘 다 있다. */
function splitLine(line) {
  if (line.orig.length <= MAX_LINE_CHARS) return [line];
  const oPieces = clausePieces(line.orig);
  const capParts = packByCap(oPieces);
  const n = capParts.length;
  if (n < 2) return [line];
  if (!line.trans) return emitParts(line, capParts, []);

  // 1차: 절 개수를 맞춰 의미가 대응하게
  const tPieces = clausePieces(line.trans);
  const k = Math.min(n, tPieces.length);
  if (k >= 2) {
    const o = packToK(oPieces, k), t = packToK(tPieces, k);
    if (o.length === k && t.length === k &&
        o.every((x) => x.trim()) && t.every((x) => x.trim())) {
      return emitParts(line, o, t);
    }
  }

  // 2차: 글자수 비례
  const tParts = splitTransToK(line.trans, n);
  // W19: 그래도 n 조각이 안 나오면 분할 자체를 포기한다. 긴 한 줄이 번역이
  //   사라진 줄보다 언제나 낫다 — 길면 읽기 불편할 뿐이지만, 비면 못 읽는다.
  if (tParts.length !== n) return [line];
  return emitParts(line, capParts, tParts);
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

/** 표시 한도를 넘는 줄만 기계 분할한다.
 *
 *  불변식 W3: 여기서 LLM 을 부르지 않는다. 부르면 요청당 왕복이 2회가 되어 지연이
 *    그대로 2배가 된다. 의미 정렬이 필요한 분할은 splitLine 이 절 경계로 처리한다.
 *
 *  groupSegments 가 이미 MAX_LINE_CHARS 안에서 묶으므로 이 경로는 거의 안 걸린다 —
 *  걸리는 것은 원조각 하나가 이미 한도를 넘는 경우다.
 *  [실측 13 fixture: 묶음 1867개 중 한도 초과 141개, 그중 128개가 원조각 단독] */
async function enforceShortLines(env, lines) {
  if (!lines.some((l) => l.orig.length > MAX_LINE_CHARS)) return lines;
  return lines.flatMap(splitLine);
}

/**
 * 요청 하나를 배치로 나눠 번역하고 합친다.
 * @returns {Promise<{lines: object[], degraded: number, usage?: Usage}>}
 *   usage 는 배치별 값의 합이다. W3 대로 확장이 BATCH 보다 작게 보내는 한
 *   배치는 항상 1개라 합산은 그대로 통과와 같다. 배치가 여럿일 때 합이 옳은
 *   이유는 이 값이 "요청 하나가 쓴 토큰"을 뜻하기 때문이다.
 */
async function translateAll(env, segments, target, ctxB = [], ctxA = []) {
  const batches = [];
  for (let i = 0; i < segments.length; i += BATCH) {
    batches.push(segments.slice(i, i + BATCH));
  }

  const results = new Array(batches.length);
  const usages = [];
  let cursor = 0, degraded = 0;

  const runner = async () => {
    while (cursor < batches.length) {
      const my = cursor++;
      // 요청 문맥은 첫/마지막 배치에만 붙인다 (중간 배치는 이웃 배치가 곧 문맥)
      const r = await translateBatch(
        env, batches[my], target,
        my === 0 ? ctxB : [],
        my === batches.length - 1 ? ctxA : [],
      );
      if (r.usage) usages.push(r.usage);      // 합이 "이 요청이 쓴 토큰"이다
      if (r.degraded) degraded++;
      results[my] = r.lines;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, runner)
  );

  const usage = usages.length
    ? {
        prompt_tokens: usages.reduce((n, u) => n + (u.prompt_tokens || 0), 0),
        completion_tokens: usages.reduce((n, u) => n + (u.completion_tokens || 0), 0),
        completion_tokens_details: {
          reasoning_tokens: usages.reduce(
            (n, u) => n + (u.completion_tokens_details?.reasoning_tokens || 0), 0),
        },
      }
    : undefined;
  return {
    lines: results.flat().sort((a, b) => a.start - b.start),
    degraded,
    ...(usage ? { usage } : {}),
  };
}

/**
 * POST /api/subtitle — { videoId, lang, target, segments, ctxBefore, ctxAfter }
 * 응답 { lines, cached, degraded, usage? }.
 *   캐시 히트에는 usage 가 없다 — LLM 을 안 불렀으므로 0 이 아니라 "해당 없음"이다.
 */
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
  // 불변식 W2: 이 키의 버전(sub:vN)은 출력 줄 형태가 바뀔 때마다 올려야 한다.
  //   캐시 히트는 0.0초(미스 대비 약 2만배)라 이 경로가 사실상 전부다. 버전을 안
  //   올리면 옛 형태가 계속 나가고 변경이 없던 일이 된다.
  // v10: fast 등급을 걷어내 키에서 mode 를 뺐다.
  // v9: full 이 "묶은 단위 1:1 번역"이 되어 줄 경계와 원문 문자열이 바뀌었을 때.
  // v8: splitLine 이 번역 꼬리를 잃던 것을 고쳤을 때.
  // v7: LLM_MODEL 을 luna → terra 로 바꿨을 때.
  const key = `sub:v10:${videoId}:${lang}:${target}:${fingerprint.slice(0, 12)}`;

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
  if (!clean.length) return json({ error: "빈 자막입니다" }, 400);

  let { lines, degraded, usage } = await translateAll(env, clean, target, ctxB, ctxA);
  lines = await enforceShortLines(env, lines);   // 캐시에도 분할된 형태로 저장된다
  if (!lines.length) return json({ error: "번역 실패" }, 502);

  // 일부라도 실패했으면 캐시하지 않는다 (다음에 온전히 재시도)
  if (env.SUBS && !degraded) ctx.waitUntil(env.SUBS.put(key, JSON.stringify(lines)));

  return json({ lines, cached: false, degraded: degraded > 0, ...(usage ? { usage } : {}) });
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
