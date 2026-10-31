// BPM voting: several sources each cast a vote for a song's tempo; this picks one, decides whether the song feels
// half/normal/double that tempo, and says whether the sources agree (flag 'agree') or the song needs a listen ('check').
// Pure functions, no I/O, no dependencies: unit tested in test/bpm.test.mjs and mirrored in tools/bpm_resolve.py.
//
// vote = { value: BPM, source, confidence: 0..1, doubt?: 'why this vote itself is shaky' }
// Priority (highest first): your own edit > your local-file analysis of the same recording > the iTunes preview measured
// with Essentia > AcousticBrainz > GetSongBPM. The highest-priority vote is the tempo; the others only decide the flag.

export const PRIORITY = ['override', 'local', 'preview', 'acousticbrainz', 'getsongbpm'];
export const LABEL = { override: 'edited', local: 'detected', preview: 'itunes-preview', acousticbrainz: 'acousticbrainz', getsongbpm: 'getsongbpm' };

// Settings (Settings page in the app): a high-energy song detected slow is probably half-time, and a low-energy song
// detected fast is probably double-time.
export const DEFAULTS = { energyHi: 0.7, bpmLow: 100, energyLo: 0.3, bpmHigh: 150, tol: 0.04, minBpm: 50, maxBpm: 220 };

// How b relates to a: 'same', 'double' (b is 2×a), 'half' (b is a/2) or null.
export function relation(a, b, tol = DEFAULTS.tol) {
  for (const [k, m] of [['same', 1], ['double', 2], ['half', 0.5]]) if (Math.abs(b - a * m) / (a * m) <= tol) return k;
  return null;
}

const round1 = x => Math.round(x * 10) / 10;
const valid = v => v && Number.isFinite(+v.value) && +v.value >= 40 && +v.value <= 250 && PRIORITY.includes(v.source);

export function sortVotes(votes) {
  return (votes || []).filter(valid).map(v => ({ ...v, value: +v.value, confidence: v.confidence == null ? 0.5 : Math.min(1, Math.max(0, +v.confidence)) }))
    .sort((a, b) => PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source) || b.confidence - a.confidence);
}

// -> { bpm, detected, source, bpmFeel: 'normal'|'half'|'double', flag: 'agree'|'check', why, votes } or null without votes
export function resolveBpm(votes, { energy, settings } = {}) {
  const S = { ...DEFAULTS, ...(settings || {}) }, vs = sortVotes(votes);
  if (!vs.length) return null;
  const top = vs[0];
  if (top.source === 'override') return { bpm: top.value, detected: top.value, source: 'override', bpmFeel: 'normal', flag: 'agree', why: 'set by you', votes: vs };

  let bpm = top.value, feel = 'normal';
  const why = [];
  let fixed = false;
  if (Number.isFinite(energy)) {
    if (energy >= S.energyHi && bpm < S.bpmLow && bpm * 2 <= S.maxBpm) { bpm = round1(bpm * 2); feel = 'double'; fixed = true; }
    else if (energy <= S.energyLo && bpm > S.bpmHigh && bpm / 2 >= S.minBpm) { bpm = round1(bpm / 2); feel = 'half'; fixed = true; }
  }
  const others = vs.slice(1);
  const conflicts = others.filter(o => relation(bpm, o.value, S.tol) !== 'same');
  const backers = others.filter(o => relation(bpm, o.value, S.tol) === 'same');
  let check = false;
  if (fixed) {
    const note = `high/low energy suggests ${feel}-time (${round1(top.value)} → ${bpm})`;
    if (backers.length) why.push(`${note}, backed by ${backers.map(b => b.source).join(' + ')}`);
    else { check = true; why.push(`${note}: energy is the only evidence`); }
  }
  if (conflicts.length) {
    check = true;
    why.push('disagrees: ' + conflicts.map(o => `${o.source} ${round1(o.value)}${relation(bpm, o.value, S.tol) ? ' (' + relation(bpm, o.value, S.tol) + ' time)' : ''}`).join(', '));
  }
  if (top.doubt) { check = true; why.push(top.doubt); }
  if (!why.length) why.push(others.length ? `${vs.length} sources agree` : `only ${top.source} had a tempo`);
  return { bpm, detected: top.value, source: top.source, bpmFeel: feel, flag: check ? 'check' : 'agree', why: why.join('; '), votes: vs };
}

// One line for the song list: "preview 86 (1.0) · acousticbrainz 172 (0.6) → 172 double · check"
export function votesText(votes, res) {
  const vs = sortVotes(votes);
  return vs.map(v => `${v.source} ${round1(v.value)} (${v.confidence.toFixed(1)})`).join(' · ') +
    (res ? ` → ${round1(res.bpm)}${res.bpmFeel !== 'normal' ? ' ' + res.bpmFeel + '-time' : ''} · ${res.flag}` : '');
}
