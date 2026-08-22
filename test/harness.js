/* 테스트 하네스 — 실제 content.js 를 그대로 읽어 격리 실행한다.
 *
 * 왜 vm 인가:
 *   content.js 는 최상위 자기실행 스크립트다. export 가 없고 끝에서 init() 이
 *   즉시 돌면서 browser/window/setInterval 을 만진다. require 하면 그 자리에서
 *   죽는다. 그렇다고 프로덕션 코드에 module.exports 를 심으면 테스트를 위해
 *   출하 코드를 바꾸는 것이라, 테스트가 검증하는 대상이 실제 출하물과 달라진다.
 *
 *   그래서 소스는 한 글자도 건드리지 않고, 가짜 전역을 채운 vm 컨텍스트에서
 *   실행한 뒤 에필로그로 내부 함수를 끄집어낸다. 에필로그는 원본과 같은 스코프에
 *   붙으므로 const/let 으로 선언된 state 까지 접근할 수 있다 (vm 에서 const 는
 *   globalThis 프로퍼티가 되지 않기 때문에 이 우회가 필요하다).
 *
 * 이 하네스가 검증하는 것은 "파일에 실제로 들어 있는 코드"다. 복사본이 아니다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CONTENT_JS = fileURLToPath(
  new URL("../ytdual/extension/content.js", import.meta.url),
);

/** 내부 식별자를 밖으로 빼는 에필로그. 원본 스코프에 이어 붙는다.
 *  getter/setter 로 노출하는 이유: state 는 재대입되므로(mergeTranslated 가
 *  state.lines 를 통째로 갈아끼운다) 값 복사로는 최신 상태를 못 본다. */
const EPILOGUE = `
;globalThis.__ytdual__ = {
  get state() { return state; },
  set state(v) { state = v; },
  get cfg() { return cfg; },
  set cfg(v) { cfg = v; },
  mergeTranslated,
  applyFast,
  seedRawLines,
  fastWindow,
  findLine,
  sliceBalancedJSON,
  parseJson3Segments,
  normalizeSegments,
  chooseSource,
  pickTrack,
  parseTimestamp,
};
`;

/** DOM 을 흉내내지 않는다. 최소한만 준다 — 부족하면 그 자리에서 죽어야
 *  "테스트가 무엇을 건드리는지" 가 드러난다. 자동 스텁(Proxy)을 쓰면 오류가
 *  조용히 삼켜져서 통과한 이유를 신뢰할 수 없다. */
function makeSandbox() {
  const noop = () => {};
  const el = {
    classList: { add: noop, remove: noop, contains: () => false },
    style: {},
    remove: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    append: noop,
    appendChild: noop,
  };
  const sandbox = {
    console,
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
    fetch: () => Promise.reject(new Error("테스트에서 네트워크 금지")),
    document: {
      documentElement: el,
      body: el,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ ...el, dataset: {}, textContent: "" }),
      createDocumentFragment: () => ({ append: noop }),
      addEventListener: noop,
    },
    location: { href: "https://www.youtube.com/", search: "" },
    navigator: { userAgent: "node" },
    // 확장 API — init() 이 즉시 부른다
    browser: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: noop },
      },
      runtime: { sendMessage: async () => ({}), onMessage: { addListener: noop } },
    },
  };
  // init() 이 끝에서 window 에 리스너를 단다. 이건 테스트가 끝난 뒤 비동기로
  // 도달하므로, 빠뜨리면 unhandledRejection 이 되어 스위트 전체가 실패한다.
  sandbox.addEventListener = noop;
  sandbox.removeEventListener = noop;
  sandbox.innerWidth = 1280;
  sandbox.innerHeight = 720;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

/** content.js 를 새 컨텍스트에서 실행하고 내부를 반환한다.
 *  테스트마다 새로 부를 것 — 모듈 수준 state 가 공유되면 안 된다. */
export function loadContent() {
  const src = readFileSync(CONTENT_JS, "utf8");
  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  new vm.Script(src + EPILOGUE, { filename: "content.js" }).runInContext(sandbox);
  const api = sandbox.__ytdual__;
  if (!api) throw new Error("에필로그가 붙지 않았다 — content.js 구조가 바뀌었나?");
  return api;
}
