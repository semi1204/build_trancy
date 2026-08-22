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
 *  W13 캐시 키는 mode 를 반드시 포함한다. 지문은 조각 텍스트로만 만들어지므로
 *      같은 조각의 fast 요청과 full 요청이 같은 키가 된다. 그러면 먼저 저장된
 *      fast 결과(문자열 배열)가 full 요청에 나가고, 확장은 lines 를 기대하다
 *      빈 응답으로 처리한다 — 그 구간은 영영 정확한 번역을 못 받는다.
 *  W14 fast 결과는 절대 정렬하지 않는다. t 에는 시간이 없어 정렬 기준이 없고,
 *      배치 순서가 곧 조각 순서다. lines 용 sort 를 그대로 태우면 undefined
 *      비교로 순서가 뒤섞여 번역 전체가 어긋난다.
 *  W15 fast 는 빈 조각을 허용하지 않는다. clean 필터가 하나라도 걸러내면 응답
 *      길이가 요청 길이와 달라져 인덱스가 밀린다. 조용히 밀리느니 거절한다.
 *  W16 fast 요청에는 CTX 줄을 붙이지 않는다. 번호 없는 CTX 가 섞이면 모델이
 *      그것까지 세어 t 의 길이가 밀린다 — W15 와 같은 실패로 이어진다.
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

/**
 * @typedef {"fast"|"full"} Mode  자막 번역 요청의 등급. 확장이 재생 위치와의
 *   거리로 정해 보낸다.
 *   fast = 조각별 1:1 번역. 병합·분할·원문 재출력 없음. 응답은 문자열 배열.
 *          [실측: terra + effort none, 8조각, 2.7초, reasoning 0토큰]
 *   full = 지금의 병합·분할 번역. 응답은 줄 객체 배열.
 *          [실측: terra, 12조각, 9.7초]
 *
 * 등급이 둘로 갈리는 근거는 시청 순서다. 재생 중인 구간은 지금 필요하므로 속도가,
 * 앞으로 볼 구간은 몇 분 뒤에나 닿으므로 정확도가 이긴다.
 */

/**
 * @typedef {object} SubtitleResponse  /api/subtitle 의 응답. mode 에 따라 갈린다.
 * @property {string[]}  [t]        mode=fast 일 때만. 요청한 segments 와 같은 길이·
 *                                  같은 순서의 번역 문자열. 원문·타임스탬프는 넣지
 *                                  않는다 — 확장이 이미 갖고 있고, 출력 토큰이 곧
 *                                  지연이다(W9).
 * @property {object[]}  [lines]    mode=full 일 때만. {start, end, orig, trans}.
 * @property {boolean}   cached
 * @property {boolean}   [degraded]
 * @property {Usage}     [usage]
 *
 * t 와 lines 는 절대 동시에 존재하지 않는다. 둘 다 실으면 확장이 어느 쪽을 믿을지
 * 정할 수 없고, 조각 경계와 문장 경계가 섞여 같은 시각을 두 줄이 덮게 된다.
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
// Phase 4 실측으로 조정 폐기: low=73/77s, none=70/69s, minimal=49/100s(분산만 커짐).
//   효과 4% 라 품질 위험을 감수할 이유가 없다. 지연은 REASONING 이 아니라 출력 토큰이 만든다(W9).
// 재판정 결과(W10): "none" 은 reasoning 을 끄지 못한다 — effort none 인데 N=12 에서
//   reasoning 1002토큰이 나왔다. 끄는 것은 설정이 아니라 프롬프트 단순화다(W12).
//   full 은 병합·분할이 실제로 추론을 필요로 하므로 low 를 유지한다. fast 는 아래
//   translateBatch 에서 none 을 쓴다.
//   ★ 정정: "fast 조합에서만 reasoning 이 0" 은 수동 자막에서만 참이다. 자동생성
//     자막(구두점 0, 문장 중간 절단)은 같은 프롬프트·같은 effort:none 에서도
//     reasoning 중앙값 134 가 나왔다. 조각이 어려우면 프롬프트 단순화로도 못 끈다.
//     [실측 fast N=8: 수동 reasoning 0 / 자동 134. full 은 수동 391 / 자동 620]
const REASONING = "low";     // full 등급 전용. fast 는 none (translateBatch 참조)
/* 타임아웃·재시도는 등급별로 다르다. fast 는 미리보기이기 때문이다 — 늦게 도착한
 * 미리보기는 가치가 0 이다. 그 사이 full 이 이미 왔거나 곧 온다.
 *   [실측 fast N=8: 중앙 5.7초 / p90 11.5초. degraded 1건(12건 중)은 3회를 다 쓰고
 *    36.9초 만에 빈 문자열을 냈다 — runner 슬롯 하나를 37초 묶고 결과는 쓸모없었다.
 *    그럴 바엔 일찍 포기하고 full 에 맡기는 편이 낫다]
 *   [실측 full: 중앙 16~22초 / 최대 54.9초. 재시도 없이 24/24 성공]
 * 값은 각 등급 상위 지연의 3배로 잡았다. 너무 짧으면 정상 요청을 끊고, 너무 길면
 * 멈춘 업스트림이 슬롯을 오래 점유한다. */
const LLM_TIMEOUT_MS = 165000;   // full 1회 상한. 실측 최대 54.9초의 3배
const FAST_TIMEOUT_MS = 36000;   // fast 1회 상한. 실측 p90 11.5초의 3배
const LLM_ATTEMPTS = 3;          // full: 실패하면 그 구간이 원문으로 남으므로 끈질기게
const FAST_ATTEMPTS = 2;         // fast: 안 되면 full 이 처리한다
// I12 (content.js): 확장 타임아웃 > 165×3 + 백오프 1.5초 ≈ 497초
// 불변식 W3: 확장이 BATCH 보다 작은 요청만 보내는 한 batches.length 는 항상 1 이고,
//   아래 CONCURRENCY runner 풀은 단일 순차 호출로 축퇴한다 — 즉 죽은 코드다.
//   실제 동시성 손잡이는 확장 쪽 runner 개수뿐이다 (I13: 8개 이하).
const BATCH = 200;           // 컨텍스트 1.05M 이라 넉넉히. 문맥이 클수록 번역 품질↑
const CONCURRENCY = 3;
const MAX_SEGMENTS = 8000;
const MAX_CARDS = 2000;

/* fast 등급. 병합·분할·원문 재출력을 전부 뺀 조각별 1:1 번역만 시킨다.
 * W12: reasoning 을 만드는 것은 요청 크기가 아니라 과제 복잡도다. 병합+분할+번역
 *   3중 과제를 번역 하나로 줄이면 reasoning 이 0 이 된다.
 *   [실측: 같은 12조각 — 이 프롬프트 reasoning 148 / SYSTEM 410, terra 조합에서 0]
 * W16: 이 프롬프트에는 CTX 줄을 붙이지 않는다. 번호 없는 줄이 섞이면 모델이
 *   그것까지 세어 t 의 길이가 밀린다. 개수 일치가 이 등급의 유일한 계약이다(W15). */
const FAST_SYSTEM = (target) => `Translate each numbered subtitle fragment into natural ${target}.
Keep the same numbering and the same number of items. Do not merge, split,
reorder, or explain. A fragment may be cut mid-sentence — translate it as the
partial phrase it is, using the surrounding fragments to resolve meaning.
Output ONLY: {"t":["...","..."]} — one translation per input, same order, same count.
No markdown fences, no commentary.`;

/* full 등급. 과제는 "번역" 하나뿐이다.
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
const MIN_GROUP_CHARS = 15;  // 이보다 짧은 묶음은 이웃에 붙인다 (토막 번역 방지)
const GROUP_MAX_GAP = 1.2;   // 이보다 벌어지면 화면 전환·침묵으로 본다
const GROUP_MAX_SECS = 8;    // 한 줄이 이보다 오래 머무르면 읽는 리듬이 깨진다
const SENTENCE_END = /[.!?…。？！]["'”’)\]]?$/;
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
    // 아주 짧은 조각은 혼자 두지 않는다. "Bien," 한 줄이 "그런데 이" 같은 토막
    // 번역을 낳는다. 옛 SYSTEM 도 같은 규칙을 문장으로 갖고 있었다
    // ("A very short interjection joins the adjacent line").
    // [실측 13 fixture: 15자 미만 묶음이 66/1894 = 3.5%]
    const tiny = cur.text.length < MIN_GROUP_CHARS;
    const cap = tiny ? MAX_LINE_CHARS + 15 : MAX_LINE_CHARS;
    const breakHere =
      (SENTENCE_END.test(cur.text) && !tiny) ||    // 앞이 문장으로 끝났다
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
 * 목표 계약 (Phase 6 에서 구현).
 * @param {Mode} mode  fast 면 FAST_SYSTEM 으로 조각별 번역, full 이면 지금의 SYSTEM.
 *   프롬프트와 응답 파싱만 갈린다. fetch·재시도·타임아웃 경로는 공유한다 — 등급별로
 *   함수를 나누면 그 40줄이 복제되고 재시도 정책이 두 벌로 갈라진다.
 * @returns {Promise<{lines?: object[], t?: string[], degraded?: boolean, usage?: Usage}>}
 *   mode=full 이면 lines, mode=fast 면 t. 둘은 동시에 반환하지 않는다.
 *   usage 는 상류 응답의 것을 그대로 통과시킨다. 상류가 안 주면 필드 자체가 없다
 *   (0 으로 채우지 않는다 — "측정 안 됨"과 "0 토큰"은 다른 사실이다).
 */
async function translateBatch(env, batch, target, ctxB = [], ctxA = [], mode = "full") {
  const fast = mode === "fast";
  // full 은 조각을 먼저 묶는다 — 묶은 단위가 곧 화면의 한 줄이고, 모델의 과제는
  // 그것을 번역하는 것뿐이다. fast 는 미리보기라 조각 그대로 1:1 이다.
  const units = fast ? batch : groupSegments(batch);
  const payload = fast
    // W16: fast 에는 CTX 를 붙이지 않는다. 번호 없는 줄이 개수를 밀리게 한다.
    ? batch.map((s, i) => `${i}: ${s.text}`).join("\n")
    : buildPayload(units, ctxB, ctxA);

  let lastUsage;

  // 불변식 10: 이 fetch 는 유한 타임아웃을 가진다. 없으면 멈춘 업스트림 하나가
  //   무기한 매달리고, 확장 쪽 runner 슬롯도 함께 묶인다.
  //   타임아웃 만료는 아래 catch 로 떨어져 기존 재시도 경로를 그대로 탄다.
  const attempts = fast ? FAST_ATTEMPTS : LLM_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), fast ? FAST_TIMEOUT_MS : LLM_TIMEOUT_MS);
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
          reasoning: { effort: fast ? "none" : REASONING },
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: fast ? FAST_SYSTEM(target) : SYSTEM(target, units.length) },
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

      // W15/I18: fast 의 검사는 길이 하나뿐이다. 밀리면 엉뚱한 시각에 엉뚱한 번역이
      // 붙는데, 그건 번역이 없는 것보다 나쁘고 화면만 봐서는 알아챌 수 없다.
      if (fast) {
        const t = parsed.t;
        if (!Array.isArray(t) || t.length !== batch.length) {
          throw new Error(`fast 길이 불일치 ${t?.length}/${batch.length}`);
        }
        return {
          t: t.map((x) => String(x ?? "").trim()),
          ...(lastUsage ? { usage: lastUsage } : {}),
        };
      }

      // full 도 계약은 개수 하나뿐이다. 묶음이 곧 줄이므로 인덱스가 밀릴 여지가
      // 없고, 커버리지는 groupSegments 가 전 조각을 분할하므로 구조적으로 보장된다
      // (옛 s/e 방식은 모델이 조각을 빠뜨려 화면이 비는 사고가 실제로 났다 — W20).
      const t = parsed.t;
      if (!Array.isArray(t) || t.length !== units.length) {
        throw new Error(`full 길이 불일치 ${t?.length}/${units.length}`);
      }
      return {
        lines: units.map((u, i) => ({
          start: u.start, end: u.end, orig: u.text, trans: String(t[i] ?? "").trim(),
        })),
        ...(lastUsage ? { usage: lastUsage } : {}),
      };
    } catch {
      if (attempt === attempts - 1) break;
      await sleep(500 * 2 ** attempt);
    } finally {
      // finally 여야 한다 — 위 429/5xx 분기가 continue 로 빠져나가므로
      // try 끝에서 지우면 그 경로에서 타이머가 남는다.
      clearTimeout(timer);
    }
  }

  // 포기 - 원문만 살려 진행. 전체가 날아가지 않게.
  // fast 는 원문을 돌려줄 자리가 없으므로 길이만 맞춘 빈 문자열을 준다. 확장은 빈
  // 문자열을 "번역 없음"으로 보고 등급을 올리지 않아 원문이 그대로 남는다 (I5).
  // usage 는 있으면 싣는다 — 응답은 했는데 파싱만 실패한 시도의 토큰도 실제 소모다.
  // 아무 응답도 못 받았으면 필드를 생략한다(0 으로 채우면 "측정 안 됨"과 뭉개진다).
  if (fast) {
    return { t: batch.map(() => ""), degraded: true, ...(lastUsage ? { usage: lastUsage } : {}) };
  }
  // full 포기: 묶은 단위의 원문만 낸다. 번역은 비지만 화면은 비지 않는다 (I5).
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
 *    번역되지 않는다. mergeTranslated 가 tier:"full" 을 찍으므로 applyFast 가
 *    I21 로 건너뛰고, 분할된 형태 그대로 KV 에 저장되어 새로고침해도 같다.
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

/* 불변식 W3 이 걸리는 지점. 여기서 LLM 을 부르면 요청당 왕복이 2회가 되어 청크 지연이
 * 그대로 2배가 된다 (Phase 4 실측 기준 +70~100초). 기계 분할(splitLine)만 쓴다. */
async function enforceShortLines(env, lines) {
  const idx = lines.map((l, i) => (l.orig.length > MAX_LINE_CHARS ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return lines;

  const items = idx.map((i) => ({
    o: lines[i].orig,
    t: lines[i].trans,
    k: Math.min(6, Math.ceil(lines[i].orig.length / 55)),
  }));
  // 한 번에 너무 많이 보내지 않는다
  // W3: LLM 2차 패스를 크리티컬 패스에서 뺐다. 전부 기계 분할(splitLine)로 간다.
  const results = items.map(() => null);

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

/**
 * 목표 계약 (Phase 6 에서 구현).
 * @param {Mode} mode  translateBatch 로 그대로 넘긴다.
 * @returns {Promise<{lines?: object[], t?: string[], degraded: number, usage?: Usage}>}
 *   usage 는 배치별 값의 합이다. W3 대로 확장이 BATCH 보다 작게 보내는 한
 *   배치는 항상 1개라 합산은 그대로 통과와 같다. 배치가 여럿일 때 합이 옳은
 *   이유는 이 값이 "요청 하나가 쓴 토큰"을 뜻하기 때문이다.
 *   ★ mode=fast 에서 배치가 2개 이상이면 t 를 순서대로 이어붙여야 한다. lines 처럼
 *     start 로 정렬할 수 없다 — t 에는 시간이 없고 순서가 곧 의미다.
 */
async function translateAll(env, segments, target, ctxB = [], ctxA = [], mode = "full") {
  const batches = [];
  for (let i = 0; i < segments.length; i += BATCH) {
    batches.push(segments.slice(i, i + BATCH));
  }

  const fast = mode === "fast";
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
        mode
      );
      if (r.usage) usages.push(r.usage);      // 합이 "이 요청이 쓴 토큰"이다
      if (r.degraded) degraded++;
      results[my] = fast ? r.t : r.lines;
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
  // W14: fast 는 이어붙이기만 한다. t 에는 시간이 없어 정렬 기준이 없고 배치 순서가
  //   곧 조각 순서다. lines 용 sort 를 태우면 undefined 비교로 순서가 뒤섞인다.
  const merged = fast
    ? { t: results.flat() }
    : { lines: results.flat().sort((a, b) => a.start - b.start) };
  return { ...merged, degraded, ...(usage ? { usage } : {}) };
}

/**
 * 목표 계약 (Phase 6 에서 구현).
 * 요청 본문에 mode 가 추가된다: { videoId, lang, target, segments, ctxBefore, ctxAfter, mode }
 *   mode 가 없으면 "full" 로 본다 — 옛 확장이 붙어도 지금 동작이 유지된다.
 * 응답은 SubtitleResponse. mode=fast 면 t, full 이면 lines. usage 도 추가된다.
 *   캐시 히트에는 usage 가 없다 — LLM 을 안 불렀으므로 0 이 아니라 "해당 없음"이다.
 * ★ 캐시 키에 mode 가 반드시 들어가야 한다. 안 넣으면 같은 지문에 fast 결과가
 *   저장되어 full 요청이 조각별 번역을 돌려받는다 (W13).
 */
async function handleSubtitle(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid json" }, 400); }

  const { videoId, lang = "", target = "Korean", segments, ctxBefore, ctxAfter } = body;
  // 값이 없거나 모르는 값이면 full. 옛 확장이 붙어도 지금 동작이 유지된다.
  const mode = body.mode === "fast" ? "fast" : "full";
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
  // v9 (W2): full 이 "묶은 단위 1:1 번역"으로 바뀌어 줄의 경계와 원문 문자열이
  //   달라졌다. v8 캐시는 모델이 병합·정리한 원문을 담고 있어 섞이면 안 된다.
  // v8 (W19): splitLine 이 번역 꼬리를 잃던 것을 고쳤을 때.
  // v7: LLM_MODEL 을 luna → terra 로 바꿨을 때.
  // mode (W13): 안 넣으면 같은 조각의 fast 요청과 full 요청이 같은 키가 된다. 먼저
  //   저장된 fast 결과(문자열 배열)가 full 요청에 나가고, 확장은 lines 를 기대하다
  //   빈 응답으로 처리한다 — 그 구간은 영영 정확한 번역을 못 받는다.
  const key = `sub:v9:${mode}:${videoId}:${lang}:${target}:${fingerprint.slice(0, 12)}`;

  // 불변식 W2: 위 키의 버전(sub:vN)은 출력 줄 형태가 바뀔 때마다 올려야 한다.
  //   Phase 4 실측 — 캐시 히트는 0.0초(미스 대비 약 2만배)라 이 경로가 사실상 전부다.
  //   버전을 안 올리면 옛 형태가 계속 나가고 변경이 없던 일이 된다.
  const hit = env.SUBS && (await env.SUBS.get(key, "json"));
  if (hit) return json(mode === "fast" ? { t: hit, cached: true } : { lines: hit, cached: true });

  if (!env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY 미설정" }, 500);

  const clean = segments
    .filter((s) => typeof s.text === "string" && s.text.trim())
    .map((s) => ({
      start: Number(s.start) || 0,
      end: Number(s.end) || Number(s.start) || 0,
      text: s.text.trim().slice(0, 400),
    }));

  // W15: clean 이 하나라도 걸러내면 fast 응답 길이가 요청 길이와 달라져 인덱스가
  //   밀린다. 조용히 밀리느니 거절한다.
  if (mode === "fast" && clean.length !== segments.length) {
    return json({ error: "fast 는 빈 조각을 허용하지 않습니다" }, 400);
  }

  let { lines, t, degraded, usage } = await translateAll(env, clean, target, ctxB, ctxA, mode);

  // fast 결과는 문자열 배열이라 enforceShortLines 에 넣으면 l.orig 가 없어 터진다.
  // 조각별 번역은 이미 짧아 분할할 이유도 없다.
  if (mode === "fast") {
    if (!t?.length) return json({ error: "번역 실패" }, 502);
    if (env.SUBS && !degraded) ctx.waitUntil(env.SUBS.put(key, JSON.stringify(t)));
    return json({ t, cached: false, degraded: degraded > 0, ...(usage ? { usage } : {}) });
  }

  lines = await enforceShortLines(env, lines);   // 캐시에도 분할된 형태로 저장된다
  if (!lines.length) return json({ error: "번역 실패" }, 502);

  // 일부라도 실패했으면 캐시하지 않는다 (다음에 온전히 재시도)
  if (env.SUBS && !degraded) ctx.waitUntil(env.SUBS.put(key, JSON.stringify(lines)));

  // 캐시 히트 return 에는 usage 가 없다 — LLM 을 안 불렀으므로 0 이 아니라 "해당 없음"이다.
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
