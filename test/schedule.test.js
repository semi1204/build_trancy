/* 번역 작업 스케줄링 — 무엇을 먼저 번역하고, 어떻게 쪼개는가.
 *
 * 이 셋이 체감 지연을 결정한다:
 *   pickJob      재생 위치에서 가까운 것부터. 시킹하면 다음 요청부터 그쪽이 최우선
 *   splitJobAt   재생 중 작업은 "지금 보는 몇 조각"을 먼저 — 지연은 출력 토큰이 만든다
 *   makeJobs     구간이 겹치지 않게 자른다. 겹치면 mergeTranslated 가 서로를 침범한다
 *
 * [실측 VBMUMuZBxw0(3591조각): 콜드 3529→1995ms, 시킹 6148→2057ms]
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadContent } from "./harness.js";
import { loadRealFixtures, skipReason } from "./real-fixtures.js";

const y = loadContent();
const FIXTURES = loadRealFixtures();
const skip = skipReason(FIXTURES);
const CHUNK = 12, SLICE = 4;

const segs = (n, gap = 3) => Array.from({ length: n }, (_, i) => ({
  start: i * gap, end: i * gap + gap, text: `f${i}`,
}));

test("작업은 segments 를 빠짐없이, 겹치지 않게 나눈다", () => {
  const s = segs(30);
  const jobs = y.makeJobs(s, CHUNK);
  assert.equal(jobs.length, 3);
  const seen = new Set();
  for (const j of jobs) {
    for (let i = j.i0; i < j.i0 + j.segs.length; i++) {
      assert.equal(seen.has(i), false, `조각 ${i} 가 두 작업에 들어갔다`);
      seen.add(i);
    }
    assert.equal(j.t0, s[j.i0].start);
    assert.equal(j.t1, s[j.i0 + j.segs.length - 1].end);
  }
  assert.equal(seen.size, s.length);
});

test("★ 재생 중인 작업이 최우선", () => {
  const s = segs(60);
  const jobs = y.makeJobs(s, CHUNK);
  // 세 번째 작업 한가운데를 보고 있다
  const t = jobs[2].t0 + 5;
  const p = y.pickJob(new Set(jobs), t);
  assert.equal(p.job, jobs[2]);
  assert.equal(p.playing, true);
});

test("재생 중인 것이 없으면 앞쪽에서 가까운 순서", () => {
  const s = segs(60);
  const jobs = y.makeJobs(s, CHUNK);
  const pending = new Set(jobs);
  pending.delete(jobs[2]);                    // 재생 중인 것을 이미 가져갔다
  const p = y.pickJob(pending, jobs[2].t0 + 5);
  assert.equal(p.job, jobs[3], "앞쪽 가까운 것을 골라야 한다");
  assert.equal(p.playing, false);
});

test("지나간 구간은 맨 뒤로 밀린다", () => {
  const s = segs(60);
  const jobs = y.makeJobs(s, CHUNK);
  // 마지막 작업을 보고 있다. 남은 것은 첫 작업(지나감)과 그 다음(지나감)뿐
  const p = y.pickJob(new Set([jobs[0], jobs[1]]), jobs[4].t0 + 1);
  assert.equal(p.job, jobs[1], "덜 지나간 쪽을 먼저 골라야 한다");
});

test("★ 시킹하면 다음 선택이 즉시 그쪽으로 바뀐다", () => {
  const s = segs(120);
  const jobs = y.makeJobs(s, CHUNK);
  const pending = new Set(jobs);
  assert.equal(y.pickJob(pending, jobs[1].t0 + 1).job, jobs[1]);
  assert.equal(y.pickJob(pending, jobs[7].t0 + 1).job, jobs[7], "시킹 후 그 지점이 최우선이 아니다");
});

test("빈 목록이면 null", () => {
  assert.equal(y.pickJob(new Set(), 0), null);
});

test("★ 재생 중 작업은 재생 지점부터 잘린다 — 지나간 조각을 번역하지 않는다", () => {
  const s = segs(12);
  const job = y.makeJobs(s, CHUNK)[0];
  const t = s[7].start + 1;                   // 8번째 조각을 보고 있다
  const { head, rest } = y.splitJobAt(job, t, SLICE);

  assert.equal(head.segs.length, SLICE);
  assert.equal(head.segs[0], s[7], "재생 지점 조각부터 시작해야 한다");
  for (const x of head.segs) assert.ok(x.end >= t, "이미 지나간 조각이 들어갔다");
});

test("★ 쪼갠 조각들은 시간이 겹치지 않고 원본을 빠짐없이 덮는다", () => {
  const s = segs(12);
  const job = y.makeJobs(s, CHUNK)[0];
  for (let k = 0; k < s.length; k++) {
    const { head, rest } = y.splitJobAt(job, s[k].start + 0.5, SLICE);
    const all = [head, ...rest].sort((a, b) => a.i0 - b.i0);
    let expect = job.i0;
    for (const j of all) {
      assert.equal(j.i0, expect, `구간이 끊기거나 겹쳤다 (재생 ${k})`);
      expect += j.segs.length;
    }
    assert.equal(expect, job.i0 + job.segs.length, `조각이 빠졌다 (재생 ${k})`);
    // 시간 구간도 겹치지 않아야 한다 — 겹치면 mergeTranslated 가 서로를 지운다
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i - 1].t1 <= all[i].t0 + 1e-9, `시간 구간이 겹쳤다 (재생 ${k})`);
    }
  }
});

test("작업이 이미 슬라이스보다 작으면 쪼개지 않는다", () => {
  const s = segs(3);
  const job = y.makeJobs(s, CHUNK)[0];
  const { head, rest } = y.splitJobAt(job, 0, SLICE);
  assert.equal(head, job);
  assert.equal(rest.length, 0);
});

test("재생 지점이 작업 시작 전이면 머리부터 자른다", () => {
  const s = segs(12);
  const job = y.makeJobs(s, CHUNK)[0];
  const { head } = y.splitJobAt(job, -100, SLICE);
  assert.equal(head.segs[0], s[0]);
});

test("★ 실제 자막에서도 쪼갠 구간이 겹치지 않는다", { skip }, () => {
  for (const fx of FIXTURES) {
    const s = y.normalizeSegments(fx.segments, fx.durationSeconds);
    const jobs = y.makeJobs(s, CHUNK);
    // 앞·중간·뒤 세 작업만 표본으로 (전수는 느리다)
    for (const j of [jobs[0], jobs[jobs.length >> 1], jobs[jobs.length - 1]]) {
      if (!j) continue;
      for (const seg of j.segs) {
        const { head, rest } = y.splitJobAt(j, seg.start + 0.01, SLICE);
        const all = [head, ...rest].sort((a, b) => a.t0 - b.t0);
        for (let i = 1; i < all.length; i++) {
          assert.ok(all[i - 1].t1 <= all[i].t0 + 1e-9,
            `${fx.id}: 시간 구간이 겹쳤다 ${all[i - 1].t1} > ${all[i].t0}`);
        }
        const covered = all.reduce((n, x) => n + x.segs.length, 0);
        assert.equal(covered, j.segs.length, `${fx.id}: 조각이 빠졌다`);
      }
    }
  }
});
