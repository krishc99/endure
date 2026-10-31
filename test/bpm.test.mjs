// Unit tests for the BPM resolver (src/bpm.js). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBpm, relation, votesText } from '../src/bpm.js';

const V = (source, value, confidence = 1, doubt) => ({ source, value, confidence, ...(doubt ? { doubt } : {}) });

test('relation: same / double / half within 4%', () => {
  assert.equal(relation(120, 123), 'same');
  assert.equal(relation(86, 172), 'double');
  assert.equal(relation(172, 86), 'half');
  assert.equal(relation(120, 150), null);
});

test('fixture Blinding Lights: detected 86, feels fast -> 172 double-time', () => {
  const r = resolveBpm([V('preview', 86)], { energy: 0.9 });
  assert.equal(r.bpm, 172); assert.equal(r.bpmFeel, 'double'); assert.equal(r.detected, 86);
  assert.equal(r.flag, 'check');                                  // energy alone is only a guess
  assert.match(r.why, /energy is the only evidence/);
});

test('Blinding Lights with AcousticBrainz also at ~171: backed, so agree', () => {
  const r = resolveBpm([V('preview', 86), V('acousticbrainz', 171, 0.6)], { energy: 0.9 });
  assert.equal(r.bpm, 172); assert.equal(r.bpmFeel, 'double'); assert.equal(r.flag, 'agree');
});

test('fixture Lose Yourself: detected 172, feels slow -> 86 half-time', () => {
  const r = resolveBpm([V('preview', 172)], { energy: 0.15 });
  assert.equal(r.bpm, 86); assert.equal(r.bpmFeel, 'half'); assert.equal(r.flag, 'check');
  const r2 = resolveBpm([V('preview', 172), V('getsongbpm', 86, 0.5)], { energy: 0.15 });
  assert.equal(r2.bpm, 86); assert.equal(r2.flag, 'agree');
});

test('user override always wins and is never energy-adjusted', () => {
  const r = resolveBpm([V('preview', 86), V('acousticbrainz', 172), V('override', 90)], { energy: 0.95 });
  assert.equal(r.bpm, 90); assert.equal(r.source, 'override'); assert.equal(r.bpmFeel, 'normal'); assert.equal(r.flag, 'agree');
  const r2 = resolveBpm([V('override', 172)], { energy: 0.05 });
  assert.equal(r2.bpm, 172);
});

test('priority: local > preview > acousticbrainz > getsongbpm', () => {
  assert.equal(resolveBpm([V('getsongbpm', 100), V('acousticbrainz', 101), V('preview', 102), V('local', 103)]).source, 'local');
  assert.equal(resolveBpm([V('getsongbpm', 100), V('acousticbrainz', 101), V('preview', 102)]).source, 'preview');
  assert.equal(resolveBpm([V('getsongbpm', 100), V('acousticbrainz', 101)]).source, 'acousticbrainz');
});

test('sources that agree -> agree; a conflicting source -> check', () => {
  assert.equal(resolveBpm([V('preview', 128), V('acousticbrainz', 127)]).flag, 'agree');
  const c = resolveBpm([V('preview', 128), V('acousticbrainz', 110)]);
  assert.equal(c.flag, 'check'); assert.equal(c.bpm, 128); assert.match(c.why, /acousticbrainz 110/);
});

test('an octave-related vote is a conflict without an energy reason to choose', () => {
  const r = resolveBpm([V('preview', 90), V('acousticbrainz', 180)], { energy: 0.5 });
  assert.equal(r.bpm, 90); assert.equal(r.flag, 'check'); assert.match(r.why, /double time/);
});

test('a vote carrying its own doubt keeps the song on check', () => {
  const r = resolveBpm([V('preview', 120, 0.33, 'estimators disagree')]);
  assert.equal(r.flag, 'check'); assert.match(r.why, /estimators disagree/);
});

test('no change when energy is middling or the tempo is already in range', () => {
  assert.equal(resolveBpm([V('preview', 120)], { energy: 0.95 }).bpm, 120);
  assert.equal(resolveBpm([V('preview', 90)], { energy: 0.5 }).bpm, 90);
  assert.equal(resolveBpm([V('preview', 120)], { energy: 0.05 }).bpm, 120);
  assert.equal(resolveBpm([V('preview', 90)]).bpm, 90);          // energy unknown: untouched
});

test('limits: never doubles past 220 or halves below 50; thresholds come from settings', () => {
  assert.equal(resolveBpm([V('preview', 115)], { energy: 0.9, settings: { bpmLow: 120 } }).bpm, 115);          // 230 > 220
  assert.equal(resolveBpm([V('preview', 95)], { energy: 0.9, settings: { bpmLow: 90 } }).bpm, 95);       // 95 is not below 90
  assert.equal(resolveBpm([V('preview', 95)], { energy: 0.9, settings: { bpmLow: 100, energyHi: 0.95 } }).bpm, 95);
  assert.equal(resolveBpm([V('preview', 95)], { energy: 0.96, settings: { bpmLow: 100, energyHi: 0.95 } }).bpm, 190);
  assert.equal(resolveBpm([V('preview', 98)], { energy: 0.9 }).bpm, 196);
  assert.equal(resolveBpm([V('preview', 105)], { energy: 0.9, settings: { bpmLow: 120 } }).bpm, 210);
  assert.equal(resolveBpm([V('preview', 112)], { energy: 0.9, settings: { bpmLow: 120 } }).bpm, 112);     // 224 > 220
});

test('invalid votes are ignored; no usable votes -> null', () => {
  assert.equal(resolveBpm([]), null);
  assert.equal(resolveBpm([V('preview', 5), V('preview', NaN), { source: 'nope', value: 100 }]), null);
  assert.equal(resolveBpm([V('preview', 5), V('acousticbrainz', 120)]).source, 'acousticbrainz');
});

test('votesText is readable', () => {
  const votes = [V('preview', 86), V('acousticbrainz', 172, 0.6)];
  const t = votesText(votes, resolveBpm(votes, { energy: 0.9 }));
  assert.match(t, /preview 86 \(1\.0\)/); assert.match(t, /acousticbrainz 172 \(0\.6\)/); assert.match(t, /172 double-time · agree/);
});
