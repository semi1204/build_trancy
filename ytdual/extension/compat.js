/* 브라우저 확장 API 이름을 하나로 맞춘다.
 *
 * Firefox 계열(Zen 포함)은 `browser`, Chrome 계열은 `chrome` 을 준다. 나머지
 * 코드가 전부 `browser` 를 쓰므로 Chrome 에서만 별칭을 붙인다.
 *
 * 이 파일은 다른 스크립트보다 먼저 실행되어야 한다 — manifest 의 content_scripts
 * js 배열 첫 자리와 각 html 의 첫 <script> 가 그 자리다.
 *
 * Chrome MV3 는 storage·runtime API 가 이미 Promise 를 돌려주므로 얇은 별칭으로
 * 충분하다. 예외는 runtime.onMessage 의 응답 방식 하나뿐인데, 그건 background.js
 * 가 양쪽이 다 지원하는 sendResponse 방식을 쓰는 것으로 해결한다.
 */
globalThis.browser ??= globalThis.chrome;
