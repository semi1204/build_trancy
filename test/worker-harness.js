/* 워커 하네스 — 실제 ytdual/worker/src/index.js 를 그대로 읽어 격리 실행한다.
 *
 * test/harness.js 와 같은 이유·같은 방식이다. 소스를 한 글자도 건드리지 않고,
 * 가짜 전역을 채운 vm 컨텍스트에서 실행한 뒤 에필로그로 내부 함수를 끄집어낸다.
 * 사본을 만들어 테스트하면 "테스트가 통과하는 사본"과 "실제로 배포되는 코드"가
 * 갈라진다 — 그 순간 테스트는 아무것도 보증하지 않는다.
 *
 * index.js 는 ESM(`export default {`) 이라 vm.Script 로 바로 못 돌린다.
 * export 키워드만 떼어내고 나머지는 원본 그대로 실행한다. 이 치환이 실패하면
 * (파일 구조가 바뀌면) 즉시 던진다 — 조용히 낡은 코드를 테스트하지 않게.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const WORKER_JS = fileURLToPath(
  new URL("../ytdual/worker/src/index.js", import.meta.url),
);

const EPILOGUE = `
;globalThis.__ytdualWorker__ = {
  clausePieces,
  packByCap,
  packToK,
  splitLine,
  splitTransToK,
  groupSegments,
  splitBySentence,
  buildPayload,
  enforceShortLines,
  translateAll,
  MAX_LINE_CHARS,
  BATCH,
  SYSTEM,
  LLM_MODEL,
  REASONING,
};
`;

function makeSandbox() {
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Response: globalThis.Response,
    Request: globalThis.Request,
    Headers: globalThis.Headers,
    FormData: globalThis.FormData,
    URL,
    setTimeout,
    clearTimeout,
    // 네트워크는 막는다. 분할 경로가 LLM 을 부르면 그 자리에서 죽어야 한다
    // (W3: enforceShortLines 는 크리티컬 패스에서 LLM 을 부르지 않는다).
    fetch: () => Promise.reject(new Error("테스트에서 네트워크 금지")),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

/** index.js 를 새 컨텍스트에서 실행하고 내부 함수를 반환한다. */
export function loadWorker() {
  const raw = readFileSync(WORKER_JS, "utf8");
  if (!raw.includes("export default {")) {
    throw new Error("index.js 에 `export default {` 가 없다 — 하네스를 갱신하세요");
  }
  const src = raw.replace("export default {", "const __workerDefault = {");

  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  new vm.Script(src + EPILOGUE, { filename: "worker/index.js" }).runInContext(sandbox);

  const api = sandbox.__ytdualWorker__;
  if (!api) throw new Error("에필로그가 붙지 않았다 — index.js 구조가 바뀌었나?");
  return api;
}
