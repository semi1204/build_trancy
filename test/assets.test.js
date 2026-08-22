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
  assert.ok(
    /id\s*=\s*"ytdual-box"|\.id\s*=\s*"ytdual-box"/.test(contentJs),
    "CSS 는 #ytdual-box 를 꾸미는데 JS 가 그 id 를 만들지 않는다",
  );
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
