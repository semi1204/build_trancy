/* 로컬에 캡처해 둔 실제 유튜브 자막 스크립트를 테스트에 물려준다.
 *
 * .local/ 은 gitignore 대상이라 없을 수 있다. 없으면 빈 배열을 주고, 호출하는
 * 테스트는 { skip } 으로 넘어간다 — 합성 데이터로 조용히 대체하지 않는다.
 * 대체하면 "실제 자막에서 통과했다"는 보증이 사라지는데 테스트는 계속 초록색이라
 * 그 사실을 아무도 모르게 된다.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL("../.local/youtube-transcripts", import.meta.url));

/**
 * @typedef {object} RealFixture
 * @property {string} id            영상 id (= 디렉터리 이름)
 * @property {string} lang          자막 언어
 * @property {"manual"|"automatic"} subtitleKind
 * @property {string} title
 * @property {number} durationSeconds
 * @property {{start:number,end:number,text:string}[]} segments  transcript.json 의 원본
 * @property {object} captions      captions.<lang>.json3 원본
 */

/** @returns {RealFixture[]} start 기준 정렬된 실제 자막들. 없으면 [] */
export function loadRealFixtures() {
  if (!existsSync(DIR)) return [];
  const out = [];
  for (const id of readdirSync(DIR).sort()) {
    const dir = join(DIR, id);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const transcript = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8"));
    const capPath = join(dir, manifest.files.captions.path);
    out.push({
      id,
      lang: manifest.capture.language,
      subtitleKind: manifest.capture.subtitleKind,
      title: manifest.source.title,
      durationSeconds: manifest.source.durationSeconds,
      segments: transcript.segments,
      captions: JSON.parse(readFileSync(capPath, "utf8")),
    });
  }
  return out;
}

/** fixture 가 없을 때 테스트에 넘길 skip 사유. 있으면 false. */
export function skipReason(fixtures) {
  return fixtures.length
    ? false
    : ".local/youtube-transcripts 없음 (npm run fixture:transcript 로 수집)";
}

/** content.js 의 청크 격자와 같은 방식으로 나눈다 (TRANSLATE_CHUNK 기본 12). */
export function makeChunks(segments, size = 12) {
  const chunks = [];
  for (let i = 0; i < segments.length; i += size) {
    const segs = segments.slice(i, i + size);
    chunks.push({ i0: i, segs, t0: segs[0].start, t1: segs[segs.length - 1].end });
  }
  return chunks;
}

/** content.js 의 nextChunk 와 같은 점수로 "지금 재생 중인 청크"를 고른다.
 *  @returns {{chunk: object, playing: boolean}|null} */
export function pickPlaying(chunks, t) {
  let best = null, bestScore = Infinity;
  for (const c of chunks) {
    const s0 = c.segs[0].start, e0 = c.segs[c.segs.length - 1].end;
    const sc = t >= s0 - 5 && t <= e0 ? -1
      : s0 >= t ? s0 - t
        : 1e6 + (t - s0);
    if (sc < bestScore) { bestScore = sc; best = c; }
  }
  return best && { chunk: best, playing: bestScore === -1 };
}
