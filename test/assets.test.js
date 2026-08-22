/* 확장 자산 정합성 — manifest·JS·CSS 가 서로 어긋나지 않는지.
 *
 * 브라우저 없이 잡을 수 있는 것과 없는 것을 가른다.
 *   잡을 수 있음: JS 가 붙이는 클래스에 CSS 규칙이 없다, manifest 가 없는 파일을
 *     가리킨다, 클래스를 붙이기만 하고 떼지 않는다.
 *   잡을 수 없음: .ytp-caption-window-container 가 지금 유튜브의 실제 클래스명인가.
 *     이건 실제 페이지에서만 확인된다 — 수동 항목으로 남는다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = (p) => fileURLToPath(new URL(`../ytdual/extension/${p}`, import.meta.url));
const read = (p) => readFileSync(dir(p), "utf8");

const manifest = JSON.parse(read("manifest.json"));
const contentJs = read("content.js");
const overlayCss = read("overlay.css");
const pageJs = read("page.js");

test("manifest 가 가리키는 파일이 모두 존재한다", () => {
  const refs = [
    ...(manifest.background?.scripts ?? []),
    ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
    manifest.options_ui?.page,
  ].filter(Boolean);

  assert.ok(refs.length > 0, "manifest 에서 참조를 못 찾았다");
  for (const r of refs) {
    assert.ok(existsSync(dir(r)), `manifest 가 없는 파일을 가리킨다: ${r}`);
  }
});

test("content.js 가 붙이는 클래스는 overlay.css 에 규칙이 있다", () => {
  const added = [...contentJs.matchAll(/classList\.add\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(added.includes("ytdual-on"), "native 자막 숨김 클래스가 사라졌다");

  for (const cls of new Set(added)) {
    assert.ok(
      overlayCss.includes(`.${cls}`),
      `JS 는 .${cls} 를 붙이는데 CSS 에 규칙이 없다 — 아무 효과도 없는 클래스다`,
    );
  }
});

test("붙인 클래스는 반드시 떼어진다 — 확장을 꺼도 유튜브 자막이 안 돌아오는 사고 방지", () => {
  const added = new Set(
    [...contentJs.matchAll(/documentElement\.classList\.add\("([^"]+)"\)/g)].map((m) => m[1]),
  );
  const removed = new Set(
    [...contentJs.matchAll(/documentElement\.classList\.remove\("([^"]+)"\)/g)].map((m) => m[1]),
  );

  for (const cls of added) {
    assert.ok(removed.has(cls), `.${cls} 를 붙이기만 하고 떼는 곳이 없다`);
  }
});

test("overlay.css 가 스타일하는 오버레이 id 를 content.js 가 실제로 만든다", () => {
  assert.ok(overlayCss.includes("#ytdual-box"), "CSS 에 #ytdual-box 가 없다");
  // id 를 붙이는 방법은 여럿이다 — 속성 대입, 객체 리터럴, setAttribute.
  assert.ok(
    /["']ytdual-box["']/.test(contentJs),
    "CSS 는 #ytdual-box 를 꾸미는데 JS 가 그 id 를 만들지 않는다",
  );
});

test("★ innerHTML 을 쓰지 않는다 — 유튜브의 Trusted Types 가 막는다", () => {
  // 유튜브는 CSP 에 `require-trusted-types-for 'script'` 를 건다. 그 상태에서
  // innerHTML 에 문자열을 넣으면 TypeError 가 나고, 오버레이도 버튼도 안 만들어져
  // 확장이 통째로 죽은 것처럼 보인다. 실제로 그렇게 죽었다.
  for (const [name, src] of [["content.js", contentJs], ["page.js", pageJs]]) {
    const hits = src
      .split("\n")
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter(({ l }) => /\.innerHTML\s*=/.test(l) && !l.startsWith("//") && !l.startsWith("*"));
    assert.deepEqual(hits, [], `${name} 이 innerHTML 에 대입한다`);
  }
});

test("CSS 가 꾸미는 오버레이 id 를 JS 가 전부 만든다", () => {
  const ids = [...overlayCss.matchAll(/#(ytdual-[\w-]+)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !new RegExp(`["']${id}["']`).test(contentJs));
  assert.deepEqual(missing, [], "CSS 는 꾸미는데 JS 가 안 만드는 id");
});

test("워커 엔드포인트가 manifest 의 host_permissions 안에 있다", () => {
  const hosts = manifest.host_permissions ?? [];
  const defaultEndpoint = contentJs.match(/endpoint:\s*"([^"]+)"/)?.[1];

  assert.ok(defaultEndpoint, "content.js 에서 기본 endpoint 를 못 찾았다");
  const origin = new URL(defaultEndpoint).origin;
  assert.ok(
    hosts.some((h) => h.startsWith(origin)),
    `기본 endpoint ${origin} 가 host_permissions 에 없다 — 요청이 CORS 로 막힌다`,
  );
});

/* ── 사설망 접근 (Local Network Access) ──────────────────────────────
 * content script 는 유튜브 페이지의 출처를 쓴다. 거기서 127.0.0.1 을 부르면
 * 브라우저가 "youtube.com 이 사설망에 접근한다"로 보고 막는다. Zen/Firefox 는
 * 권한을 묻고, 거절하면 CORS 오류로 끝난다:
 *     Cross-Origin Request Blocked: http://127.0.0.1:8787/api/subtitle
 * background 는 확장 출처로 요청하므로 그 판정을 받지 않는다. 그래서 워커 호출은
 * 전부 background 를 거쳐야 한다.
 */
const backgroundJs = read("background.js");

test("★ content.js 는 워커를 직접 부르지 않는다 — background 를 거친다", () => {
  const direct = contentJs
    .split("\n")
    .map((l, i) => ({ l: l.trim(), n: i + 1 }))
    .filter(({ l }) => /fetch\(`\$\{cfg\.endpoint\}/.test(l));
  // 예외 둘: apiPost 자신(확장 밖에서 도는 하네스용)과 오디오 전사(Blob 은
  // runtime.sendMessage 로 못 보낸다 — Chrome 은 JSON 직렬화를 쓴다).
  const allowed = /api\/transcribe|\$\{path\}/;
  const bad = direct.filter(({ l }) => !allowed.test(l));
  assert.deepEqual(bad.map((x) => `${x.n}: ${x.l.slice(0, 60)}`), [],
    "background 를 거치지 않는 워커 호출이 있다");
});

test("background 가 content.js 가 쓰는 모든 경로를 허용한다", () => {
  const m = backgroundJs.match(/const ALLOWED = (\/[^;]+\/)/);
  assert.ok(m, "background.js 에서 ALLOWED 를 못 찾았다");
  const allowed = new RegExp(m[1].slice(1, -1));
  const paths = [...contentJs.matchAll(/apiPost\(\s*"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(paths.length >= 3, `apiPost 호출을 ${paths.length}개만 찾았다`);
  for (const p of [...new Set(paths)]) {
    assert.ok(allowed.test(p), `background 가 ${p} 를 막는다`);
  }
});

test("확장 안팎을 구분해 전송 경로를 고른다", () => {
  // 하네스(devtools)는 확장이 아니므로 직접 fetch 해야 한다. runtime.id 로 가른다.
  assert.match(contentJs, /browser\?\.runtime\?\.id/,
    "확장 여부 판별이 없다 — 하네스에서 background 를 부르려다 죽는다");
});

test("기본 endpoint 가 content.js 와 background.js 에서 같다", () => {
  const pick = (src) => src.match(/endpoint[:\s=]+"([^"]+)"/)?.[1]
    ?? src.match(/DEFAULT_ENDPOINT = "([^"]+)"/)?.[1];
  assert.equal(pick(contentJs), pick(backgroundJs),
    "두 파일의 기본 endpoint 가 다르면 설정 전에는 서로 다른 곳을 부른다");
});
