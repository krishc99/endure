// Tests for the step tracker in tools/motion.js on simulated phone motion (test/gait_sim.mjs). Run: npm test
// These use a model of running and walking, not real recordings, so they guard against regressions; tuning for real
// phones should use recordings from the app's "Record run" button (see tools/replay_run.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { simulate, still } from './gait_sim.mjs';
const { StepTracker } = createRequire(import.meta.url)('../tools/motion.js');

function run(sim) {
  const st = new StepTracker(), steps = [], cads = [];
  st.onStep = (t, v) => steps.push([t, v]);
  for (const [t, x, y, z] of sim.samples) {
    st.push(t, x, y, z);
    if (!cads.length || t - cads[cads.length - 1][0] >= 250) cads.push([t, st.cadence(t)]);
  }
  return { steps, cads };
}
function timing(sim, res, from = 3000) {
  const L = sim.landings.filter(t => t >= from), D = res.steps.filter(s => s[0] >= from), used = new Set(), errs = [];
  for (const l of L) {
    let best = -1, bd = 1e9;
    D.forEach((d, i) => { if (!used.has(i) && Math.abs(d[0] - l) < bd) { bd = Math.abs(d[0] - l); best = i; } });
    if (best >= 0 && bd < 200) { used.add(best); errs.push(Math.abs(D[best][0] - l)); }
  }
  errs.sort((a, b) => a - b);
  return { truth: L.length, found: D.length, matched: errs.length, median: errs[errs.length >> 1] };
}
// seconds until the reading is within 3% of the new pace and then stays within 5% (natural step-to-step variation)
const settleTime = (res, from, target) => {
  const c = res.cads.filter(x => x[0] >= from), off = (x, p) => !(x[1] && Math.abs(x[1] - target) / target < p);
  for (let i = 0; i < c.length; i++) if (!off(c[i], 0.03) && !c.slice(i).some(x => off(x, 0.05))) return (c[i][0] - from) / 1000;
  return Infinity;
};

for (const carry of ['held', 'pocket', 'hand']) {
  test(`${carry}: counts each landing at running pace and times it within 40 ms`, () => {
    for (const cad of [170, 150]) {
      const sim = simulate({ cadence: cad, dur: 30, carry, seed: cad + carry.length }), r = timing(sim, run(sim));
      assert.ok(Math.abs(r.found - r.truth) <= 2, `${cad}: found ${r.found} of ${r.truth}`);
      assert.ok(r.matched >= r.truth - 2, `${cad}: matched ${r.matched} of ${r.truth}`);
      assert.ok(r.median <= 40, `${cad}: median timing error ${r.median} ms`);
    }
  });
  test(`${carry}: follows a change of pace within 3.5 s, without dropping to 0`, () => {
    for (const [a, b] of [[140, 172], [170, 150]]) {
      const res = run(simulate({ cadence: t => t < 15 ? a : b, dur: 35, carry, seed: a + b }));
      assert.ok(settleTime(res, 15000, b) <= 3.5, `${a}->${b}: settled after ${settleTime(res, 15000, b)} s`);
      assert.equal(res.cads.filter(c => c[0] > 15000 && c[1] === 0).length, 0, `${a}->${b}: read 0 while running`);
    }
  });
  test(`${carry}: slowing from a run to a walk never reads 0`, () => {
    const res = run(simulate({ cadence: t => t < 15 ? 165 : 112, dur: 35, carry, seed: 9 }));
    assert.equal(res.cads.filter(c => c[0] > 10000 && c[1] === 0).length, 0);
    assert.ok(settleTime(res, 15000, 112) <= 10, `settled after ${settleTime(res, 15000, 112)} s`);
  });
  test(`${carry}: says 0 within 5 s of stopping, with no steps counted while standing`, () => {
    const sim = simulate({ cadence: 160, dur: 30, carry, seed: 11, stopAt: 18 }), res = run(sim), last = sim.landings[sim.landings.length - 1];
    const z = res.cads.find(c => c[0] > last && c[1] === 0);
    assert.ok(z && z[0] - last <= 5000, `0 after ${z ? z[0] - last : 'never'} ms`);
    assert.equal(res.steps.filter(s => s[0] > last + 700).length, 0);
  });
}
test('a phone lying still or held still counts no steps', () => {
  for (const tremor of [0.1, 0.2]) assert.equal(run(still({ dur: 20, tremor })).steps.length, 0, `tremor ${tremor}`);
});
