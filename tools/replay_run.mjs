#!/usr/bin/env node
// Replays a recording from the app's "Record run" button through the current step detector (tools/motion.js), to
// compare what it finds now with what the app found during the run, and to tune it on real phones and real running.
//   node tools/replay_run.mjs rundj_run_pocket_202611271830.json [--min-amp 0.5] [--csv out.csv]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { StepTracker } = createRequire(import.meta.url)('./motion.js');

const args = process.argv.slice(2), file = args.find(a => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!file) { console.error('usage: node tools/replay_run.mjs RECORDING.json [--min-amp 0.5] [--csv out.csv]'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
if (r.kind !== 'motion-recording') { console.error('not a Run DJ motion recording'); process.exit(1); }

const st = new StepTracker({ minAmp: +opt('--min-amp', r.settings && r.settings.mmin || 0.5) }), steps = [], cads = [];
st.onStep = (t, v) => steps.push([t, v]);
for (const [t, x, y, z] of r.m) {
  st.push(t, x, y, z);
  if (!cads.length || t - cads[cads.length - 1][0] >= 1000) cads.push([t, st.cadence(t)]);
}
const dur = r.m.length ? r.m[r.m.length - 1][0] / 1000 : 0, rate = r.m.length / Math.max(1, dur);
const gaps = []; for (let i = 1; i < r.m.length; i++) gaps.push(r.m[i][0] - r.m[i - 1][0]);
gaps.sort((a, b) => a - b);
console.log(`${file}: carried ${r.carry}, ${(dur / 60).toFixed(1)} min, ${r.m.length} samples (${rate.toFixed(0)} Hz, gaps median ${Math.round(gaps[gaps.length >> 1])} ms, worst ${Math.round(gaps[gaps.length - 1])} ms)`);
console.log(`  ${r.ua || ''}`);
console.log(`  steps: app counted ${r.steps.length} during the run, detector now finds ${steps.length} (${steps.filter(s => s[1]).length} filled in)`);
// minute-by-minute cadence: what the app showed vs what the detector says now
for (let m = 0; m * 60 < dur; m++) {
  const inMin = a => a.filter(c => c[0] >= m * 60000 && c[0] < (m + 1) * 60000 && c[1]).map(c => c[1]);
  const avg = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : '—';
  const n = steps.filter(s => s[0] >= m * 60000 && s[0] < (m + 1) * 60000).length;
  console.log(`  minute ${m + 1}: ${n} steps, cadence now ${avg(inMin(cads))}, in the app ${avg(inMin(r.cad))}`);
}
if (r.marks && r.marks.length) console.log(`  marks at ${r.marks.map(t => (t / 1000).toFixed(0) + 's').join(', ')}`);
const csv = opt('--csv');
if (csv) {
  fs.writeFileSync(csv, 't_ms,ax,ay,az,step_app,step_now\n' + r.m.map(([t, x, y, z]) =>
    `${t},${x},${y},${z},${r.steps.some(s => Math.abs(s[0] - t) < 8) ? 1 : ''},${steps.some(s => Math.abs(s[0] - t) < 8) ? 1 : ''}`).join('\n'));
  console.log(`  wrote ${csv}`);
}
