import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { loadContent } from "./harness.js";

const PAGE_REQ = "ytdual-get-page-data";
const PAGE_RES = "ytdual-page-data";
const PAGE_CANCEL = "ytdual-cancel-page-data";
const YTPAGE_JS = fileURLToPath(new URL("../ytdual/extension/ytpage.js", import.meta.url));

class TestCustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
}

function makeEventTarget(document) {
  const listeners = new Map();
  document.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  };
  document.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
  document.dispatchEvent = (event) => {
    for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
    return true;
  };
  return { listenerCount: (type) => listeners.get(type)?.size || 0 };
}

function loadPageBridge(document, { now, setTimeout }) {
  const sandbox = {
    AbortController,
    console,
    CustomEvent: TestCustomEvent,
    Date: { now },
    document,
    location: { href: "https://www.youtube.com/watch?v=M7lc1UVf-VE", search: "?v=M7lc1UVf-VE" },
    setTimeout,
    URL,
    URLSearchParams,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  new vm.Script(readFileSync(YTPAGE_JS, "utf8"), { filename: "ytpage.js" }).runInContext(sandbox);
}

test("★ 페이지 세계는 요청 ID가 붙은 응답 채널을 쓴다", async () => {
  const document = { querySelector: () => null };
  makeEventTarget(document);
  let now = 0;
  loadPageBridge(document, {
    now: () => (now += 5000),
    setTimeout: (fn) => { fn(); return 0; },
  });

  const response = new Promise((resolve) => {
    document.addEventListener(`${PAGE_RES}:request-42`, (event) => resolve(JSON.parse(event.detail)));
  });
  document.dispatchEvent(new TestCustomEvent(PAGE_REQ, { detail: "request-42" }));

  const data = await response;
  assert.equal(data.videoId, "M7lc1UVf-VE");
});

test("★ 취소된 요청은 페이지 세계의 폴링과 응답을 끝낸다", async () => {
  const document = { querySelector: () => null };
  makeEventTarget(document);
  const timers = [];
  loadPageBridge(document, {
    now: () => 0,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  });

  const requestId = "request-cancel";
  let responses = 0;
  document.addEventListener(`${PAGE_RES}:${requestId}`, () => { responses++; });
  document.dispatchEvent(new TestCustomEvent(PAGE_REQ, { detail: requestId }));
  assert.equal(timers.length, 1, "페이지 세계가 폴링을 시작하지 않았다");

  document.dispatchEvent(new TestCustomEvent(PAGE_CANCEL, { detail: requestId }));
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.length, 0, "취소 뒤에도 다음 폴링 타이머를 만들었다");
  assert.equal(responses, 0, "취소된 요청에 응답을 보냈다");
});

test("★ 페이지 세계도 겹친 요청의 ID를 완료 순서와 무관하게 보존한다", async () => {
  let marker = "";
  const document = {
    querySelector: () => ({
      getAudioTrack: () => ({
        captionTracks: marker
          ? [{ url: `https://www.youtube.com/api/timedtext?pot=x&marker=${marker}`, languageCode: "en" }]
          : [],
      }),
    }),
  };
  makeEventTarget(document);
  const timers = [];
  loadPageBridge(document, {
    now: () => 0,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
  });

  let oldData = null;
  let newData = null;
  document.addEventListener(`${PAGE_RES}:request-old`, (event) => { oldData = JSON.parse(event.detail); });
  document.addEventListener(`${PAGE_RES}:request-new`, (event) => { newData = JSON.parse(event.detail); });
  document.dispatchEvent(new TestCustomEvent(PAGE_REQ, { detail: "request-old" }));
  document.dispatchEvent(new TestCustomEvent(PAGE_REQ, { detail: "request-new" }));
  assert.equal(timers.length, 2);

  const [finishOld, finishNew] = timers;
  marker = "new";
  finishNew();
  await new Promise((resolve) => setImmediate(resolve));
  marker = "old";
  finishOld();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(newData.tracks[0].url, /marker=new/);
  assert.match(oldData.tracks[0].url, /marker=old/);
});

test("★ 이전 페이지 응답이 같은 영상의 새 요청을 가로채지 않는다", async () => {
  const y = loadContent();
  const document = y.document;
  const events = makeEventTarget(document);

  const requestIds = [];
  document.addEventListener(PAGE_REQ, (event) => requestIds.push(event.detail));

  const oldRequest = y.requestPageData();
  const newRequest = y.requestPageData();

  assert.equal(requestIds.length, 2);
  assert.ok(requestIds.every((id) => typeof id === "string" && id));
  assert.notEqual(requestIds[0], requestIds[1]);

  document.dispatchEvent({
    type: `${PAGE_RES}:${requestIds[0]}`,
    detail: JSON.stringify({ videoId: "M7lc1UVf-VE", marker: "old" }),
  });

  assert.equal((await oldRequest).marker, "old");
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestIds[0]}`), 0);
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestIds[1]}`), 1);
  let newValue = null;
  newRequest.then((value) => { newValue = value; });
  await Promise.resolve();
  assert.equal(newValue, null, "이전 응답이 새 요청까지 resolve 했다");

  document.dispatchEvent({
    type: `${PAGE_RES}:${requestIds[1]}`,
    detail: JSON.stringify({ videoId: "M7lc1UVf-VE", marker: "new" }),
  });

  assert.equal((await newRequest).marker, "new");
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestIds[1]}`), 0);
});

test("페이지 응답 타임아웃도 수집 취소와 리스너 정리를 수행한다", async () => {
  let fireTimeout = null;
  const cleared = [];
  const y = loadContent({
    setTimeout: (fn) => { fireTimeout = fn; return 77; },
    clearTimeout: (id) => { cleared.push(id); },
  });
  const document = y.document;
  const events = makeEventTarget(document);
  let requestId = "";
  let cancelledId = "";
  document.addEventListener(PAGE_REQ, (event) => { requestId = event.detail; });
  document.addEventListener(PAGE_CANCEL, (event) => { cancelledId = event.detail; });

  const pending = y.requestPageData();
  assert.equal(typeof fireTimeout, "function");
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestId}`), 1);

  fireTimeout();
  assert.equal(await pending, null);
  assert.equal(cancelledId, requestId);
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestId}`), 0);
  assert.deepEqual(cleared, [77]);
});

test("stop 신호가 대기 중인 페이지 응답 리스너를 즉시 걷는다", async () => {
  const y = loadContent();
  const document = y.document;
  const events = makeEventTarget(document);
  let requestId = "";
  let cancelledId = "";
  document.addEventListener(PAGE_REQ, (event) => { requestId = event.detail; });
  document.addEventListener(PAGE_CANCEL, (event) => { cancelledId = event.detail; });

  const ctl = new AbortController();
  const pending = y.requestPageData(ctl.signal);
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestId}`), 1);

  ctl.abort();
  assert.equal(await pending, null);
  assert.equal(cancelledId, requestId);
  assert.equal(events.listenerCount(`${PAGE_RES}:${requestId}`), 0);
});
