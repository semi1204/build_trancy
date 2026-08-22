/* 자막 조각 생성기와 불변식 검사기.
 *
 * 실제 자막의 성질을 흉내낸다 — 특히 "이웃 조각이 시간상 겹친다"는 것. Phase 4
 * 에서 잡힌 청크 경계 결함은 겹침이 없으면 재현되지 않는다. 겹침 없는 픽스처로
 * 검사하면 통과해버리므로 기본값으로 겹치게 만든다.
 */

/** @param {number} n 조각 수
 *  @param {object} o
 *  @param {number} o.dur   조각 길이(초)
 *  @param {number} o.gap   조각 시작 간격(초). dur 보다 작으면 겹친다.
 *  @returns {{start:number,end:number,text:string}[]} */
export function makeSegments(n, { dur = 3.4, gap = 3.0 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    start: +(i * gap).toFixed(3),
    end: +(i * gap + dur).toFixed(3),
    text: `frag ${i}`,
  }));
}

/** 조각을 청크로 나눈다. 실제 코드와 같은 방식으로 t0/t1 을 조각 경계에서 딴다. */
export function makeChunks(segments, size) {
  const chunks = [];
  for (let i = 0; i < segments.length; i += size) {
    const segs = segments.slice(i, i + size);
    chunks.push({
      i0: i,
      segs,
      t0: segs[0].start,
      t1: segs[segs.length - 1].end,
    });
  }
  return chunks;
}

/** 워커가 돌려줄 법한 full 응답을 만든다 — 여러 조각을 한 문장으로 병합한다.
 *  병합이 일어나야 인덱스 대응이 깨지고, 그게 I22 가 존재하는 이유다. */
export function fullLinesFor(chunk, per = 3) {
  const out = [];
  for (let i = 0; i < chunk.segs.length; i += per) {
    const group = chunk.segs.slice(i, i + per);
    out.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      orig: group.map((s) => s.text).join(" "),
      trans: `정확[${group.map((s) => s.text.split(" ")[1]).join(",")}]`,
    });
  }
  return out;
}

/* ── 구간 산술 ─────────────────────────────────────────────────────── */

/** 겹치거나 맞닿은 구간을 하나로 합친다. */
export function union(intervals) {
  const iv = intervals
    .map((x) => [x.start, x.end])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** 원본이 덮던 시각 중 현재 상태가 덮지 못하는 구간 = 화면이 비는 순간 (I5).
 *  @returns {[number,number][]} 비어 있으면 I5 만족 */
export function holes(original, current) {
  const cur = union(current);
  const out = [];
  for (let [a, b] of union(original)) {
    for (const [c, d] of cur) {
      if (d <= a || c >= b) continue;
      if (c > a) out.push([a, Math.min(c, b)]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (b - a > 1e-9) out.push([a, b]);
  }
  return out.filter(([a, b]) => b - a > 1e-6);
}

/** I2 — start 오름차순인가 */
export function isSorted(lines) {
  return lines.every((l, i) => i === 0 || lines[i - 1].start <= l.start);
}

/** 재현 가능한 의사난수. 실패를 재현하려면 시드가 고정이어야 한다. */
export function shuffled(arr, seed = 42) {
  const a = [...arr];
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
