// Tests for the BPM voting pieces of src/analyzer.js with a fake network. Run: npm test
// The analyser pulls in Essentia's WASM, which Node can't load, so it is bundled here with a stub in its place.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), tmp = mkdtempSync(join(tmpdir(), 'rundj-test-'));
const out = join(tmp, 'analyzer.mjs');
await build({ entryPoints: [join(root, 'src/analyzer.js')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'silent',
  define: { __DEV_SOURCES__: 'true' },
  plugins: [{ name: 'stub-essentia', setup(b) { b.onResolve({ filter: /^essentia\.js/ }, () => ({ path: 'stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const EssentiaWASM = {}; export default function Essentia() {}', loader: 'js' })); } }] });
const A = await import(pathToFileURL(out).href);

const json = (status, data) => ({ status, data });
const rec = (id, title, artist, ms) => ({ id, title, length: ms, 'artist-credit': [{ name: artist }] });
const fake = routes => async (method, url) => { for (const [re, fn] of routes) if (re.test(url)) return fn(url); return json(404, null); };

test('AcousticBrainz vote: MusicBrainz match, first recording has no data (404), second does', async () => {
  A._test.resetAb(); const seen = [];
  A._test.setHttp(fake([
    [/musicbrainz\.org\/ws\/2\/recording/, u => { seen.push(u); return json(200, { recordings: [rec('aaa', 'Blinding Lights', 'The Weeknd', 200040), rec('bbb', 'Blinding Lights', 'The Weeknd', 200500)] }); }],
    [/acousticbrainz\.org\/api\/v1\/aaa\/low-level/, () => json(404, null)],
    [/acousticbrainz\.org\/api\/v1\/bbb\/low-level/, () => json(200, { rhythm: { bpm: 171.04, danceability: 1.2 } })]]));
  const v = await A.acousticbrainzVote('Blinding Lights', 'The Weeknd', 200);
  assert.equal(v.source, 'acousticbrainz'); assert.equal(v.value, 171); assert.equal(v.mbid, 'bbb'); assert.equal(v.danceability, 1.2);
  assert.match(decodeURIComponent(seen[0].replace(/\+/g, ' ')), /recording:"Blinding Lights" AND artist:"The Weeknd"/);
});

test('AcousticBrainz vote: no MusicBrainz match, wrong version, or no data -> no vote (normal)', async () => {
  A._test.resetAb();
  A._test.setHttp(fake([[/musicbrainz/, () => json(200, { recordings: [] })]]));
  assert.equal(await A.acousticbrainzVote('Nobody Song', 'Nobody', 200), null);
  A._test.resetAb();
  A._test.setHttp(fake([[/musicbrainz/, () => json(200, { recordings: [rec('x', 'Hello (Live)', 'Adele', 300000)] })]]));
  assert.equal(await A.acousticbrainzVote('Hello', 'Adele', 295), null);              // a live recording is not this song
});

test('AcousticBrainz is given up on for the session after 3 failures in a row', async () => {
  A._test.resetAb(); let calls = 0;
  A._test.setHttp(fake([[/musicbrainz/, () => { calls++; return json(503, null); }]]));
  for (let i = 0; i < 5; i++) assert.equal(await A.acousticbrainzVote('Song', 'Artist', 200), null);
  assert.equal(calls, 3); A._test.resetAb();
});

test('GetSongBPM vote: needs a key, matches title + artist, flags version words', async () => {
  assert.equal(await A.getsongbpmVote('Song', 'Artist', ''), null);
  A._test.setHttp(fake([[/getsongbpm/, () => json(200, { search: [{ title: 'Other', tempo: '90', artist: { name: 'Nobody' } }, { title: 'Song', tempo: '128', artist: { name: 'Artist' } }] })]]));
  const v = await A.getsongbpmVote('Song', 'Artist', 'k');
  assert.equal(v.value, 128); assert.equal(v.doubt, undefined);
  const r = await A.getsongbpmVote('Song (Live)', 'Artist', 'k');
  assert.match(r.doubt || '', /live/);
});

test('resolveMeta: energy fix is applied from saved votes, and re-run when energy changes', () => {
  const m = { title: 'Blinding Lights', bpm: 86, energy: 0.5, votes: [{ value: 86, source: 'preview', confidence: 1 }], src: 'itunes-preview', alts: [] };
  A.resolveMeta(m); assert.equal(m.bpm, 86); assert.equal(m.bpmFlag, 'agree');
  m.energy = 0.9; A.resolveMeta(m);
  assert.equal(m.bpm, 172); assert.equal(m.bpmFeel, 'double'); assert.equal(m.bpmFlag, 'check'); assert.equal(m.src, 'check');
  assert.deepEqual(m.alts, [{ bpm: 86, conf: 0.5 }]);
  m.energy = 0.5; A.resolveMeta(m); assert.equal(m.bpm, 86); assert.equal(m.bpmFeel, 'normal');
});

test('resolveMeta: your edits are never changed; songs without votes are left alone', () => {
  const m = { bpm: 90, src: 'edited', energy: 0.95, votes: [{ value: 86, source: 'preview', confidence: 1 }, { value: 172, source: 'acousticbrainz', confidence: 0.6 }] };
  A.resolveMeta(m); assert.equal(m.bpm, 90); assert.equal(m.src, 'edited'); assert.equal(m.bpmFlag, 'agree');
  const old = { bpm: 123, src: 'itunes-preview', energy: 0.95 };
  A.resolveMeta(old); assert.deepEqual(old, { bpm: 123, src: 'itunes-preview', energy: 0.95 });
});

test('settings thresholds change the outcome (Settings page)', () => {
  A.setBpmSettings({ energyHi: 0.95 });
  const m = { bpm: 86, energy: 0.9, votes: [{ value: 86, source: 'preview', confidence: 1 }], src: 'itunes-preview' };
  A.resolveMeta(m); assert.equal(m.bpm, 86);
  A.setBpmSettings({}); A.resolveMeta(m); assert.equal(m.bpm, 172);
});

test('rankEnergy re-resolves songs whose energy changed', () => {
  const mk = (title, bpm, loud, rate, bright) => ({ title, bpm, energy: 0.5, src: 'itunes-preview', feats: { loud, rate, bright }, votes: [{ value: bpm, source: 'preview', confidence: 1 }] });
  const quiet = mk('Quiet', 80, -30, 1, 0.01), mid = mk('Mid', 120, -20, 3, 0.05), loud = mk('Loud', 86, -8, 6, 0.2);
  const changed = A.rankEnergy([quiet, mid, loud]);
  assert.equal(changed.length, 2); assert.equal(mid.energy, 0.5);      // the middle song keeps the default 0.5
  assert.equal(loud.energy, 1);
  assert.equal(loud.bpm, 172); assert.equal(loud.bpmFeel, 'double');           // loud and "slow": double-time
  assert.equal(quiet.bpm, 80); assert.equal(mid.bpm, 120);
});
