// Run DJ on-phone analyser: playlist link → songs with BPM, energy and chorus sections → Run DJ library entries.
// Same method as tools/yt_library.py, in the app:
//   playlist  Spotify (official Web API, your free client ID/secret). YouTube Music (youtubei) and Apple Music (public
//             playlist page) are unofficial and only enabled when devSources is on (debug builds)
//   playback  every song is matched to its YouTube Music audio version ("Topic"/ATV), which the app streams
//   BPM       Apple's 30 s iTunes preview of the same version, measured with Essentia (3 estimators)
//   sections  timed lyrics from LRCLIB, matched on the recording's length (±2 s): repeated lines = choruses
//   energy    loudness / onset rate / brightness of the preview, ranked within your library
// Network calls go through Capacitor's native HTTP (no CORS limits). Everything is cached in the song entries, so a
// song that is already in your library is never analysed twice.
import { CapacitorHttp, Capacitor } from '@capacitor/core';
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// App name + contact URL, as LRCLIB asks of API clients
const LRCLIB_UA = 'RunDJ/0.2 (https://github.com/krishc99/endure)';

// devSources: unofficial sources (YouTube Music's internal youtubei API, Apple Music's public playlist page).
// ON in debug builds, OFF in release builds. Set at bundle time: `npm run bundle` (debug) / `npm run bundle:release`.
let DEV_SOURCES = typeof __DEV_SOURCES__ !== 'undefined' ? !!__DEV_SOURCES__ : true;
export const devSources = () => DEV_SOURCES;
const needDev = what => { if (!DEV_SOURCES) throw new Error(what + ' is only available in debug builds (it relies on an unofficial source).'); };

// ------------------------------------------------------------------ HTTP
let httpOverride = null;            // tests inject a fake here
async function http(method, url, { headers = {}, data, as = 'json' } = {}) {
  if (httpOverride) return httpOverride(method, url, { headers, data, as });
  if (Capacitor.isNativePlatform()) {
    const r = await CapacitorHttp.request({ method, url, headers, data, responseType: as === 'binary' ? 'arraybuffer' : as === 'json' ? 'json' : 'text', connectTimeout: 20000, readTimeout: 30000 });
    let d = r.data;
    if (as === 'binary' && typeof d === 'string') { const b = atob(d), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); d = u.buffer; }
    if (as === 'json' && typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { /* leave as text */ } }
    return { status: r.status, data: d };
  }
  const r = await fetch(url, { method, headers, body: data === undefined ? undefined : (typeof data === 'string' ? data : JSON.stringify(data)) });
  const d = as === 'binary' ? await r.arrayBuffer() : as === 'json' ? await r.json().catch(() => null) : await r.text();
  return { status: r.status, data: d };
}
const getJSON = async (url, headers) => { const r = await http('GET', url, { headers }); if (r.status >= 400) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status }); return r.data; };

// ------------------------------------------------------------------ text matching (port of yt_library.py)
const ascii = s => (s || '').normalize('NFKD').replace(/\p{Mn}/gu, '').replace(/[^\x00-\x7f]/g, '');
function norm(s) {
  s = ascii(s).toLowerCase();
  s = s.replace(/[\(\[][^\)\]]*(feat|ft\.|with |remaster|official|video|audio|lyric|version|edit|mix|live)[^\)\]]*[\)\]]/g, ' ');
  s = s.replace(/\s-\s.*(remaster|version|edit|mix|live|mono|stereo).*$/, ' ');
  s = s.replace(/\b(feat|ft)\..*$/, ' ');
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}
const firstArtist = a => norm((a || '').split(/,|&| x | and |feat\.|ft\./)[0]).replace(/^the /, '');
const baseTitle = t => norm((t || '').replace(/[\(\[][^\)\]]*[\)\]]|\s-\s.*$/g, ' ')) || norm(t);
const VTAGS = ['remix', 'acoustic', 'live', 'slowed', 'sped up', 'speed up', 'nightcore', 'unplugged', 'piano', 'orchestral', 'cover', 'reverb', 'rework', 'vip', 'bootleg', 'flip'];
const CORE = new Set(['remix', 'acoustic', 'live', 'slowed', 'sped up', 'nightcore', 'piano', 'orchestral', 'cover', 'reverb']);
const JUNK = ['karaoke', 'tribute', 'made famous', 'originally performed', 'in the style of', 'instrumental', 'lullaby', '8 bit', '8-bit', 'backing track', 'workout', 'cover version', 'piano version', 'music box', 'renditions'];
const PLAIN = new Set(['feat', 'ft', 'featuring', 'with', 'remaster', 'remastered', 'digital', 'radio', 'edit', 'single', 'album', 'explicit', 'clean', 'mono', 'stereo', 'version', 'original', 'deluxe', 'bonus', 'track', 'from', 'the', 'and', 'of', 'a', 'edition', 'mix', 'soundtrack', 'motion', 'picture', 'film', 'movie', 'topic']);
function versionTags(title) {
  const t = ascii(title).toLowerCase(), tags = new Set();
  const parts = [...t.matchAll(/[\(\[]([^\)\]]*)[\)\]]/g)].map(m => m[1]).concat([...t.matchAll(/\s-\s(.*)$/g)].map(m => m[1]));
  for (const part of parts) {
    const words = part.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    const hit = VTAGS.filter(v => new RegExp('\\b' + v + '\\b').test(part));
    if (/\bmix\b/.test(part) && !/\b(radio|album|original|single|extended)\s+mix\b/.test(part)) hit.push('remix');
    if (hit.length) {
      for (const h of hit) tags.add(['rework', 'vip', 'bootleg', 'flip'].includes(h) ? 'remix' : h.replace('speed', 'sped'));
      if (hit.includes('unplugged')) { tags.add('acoustic'); tags.add('live'); }
      if (tags.has('remix')) for (const w of words) if (!['remix', 'mix', 'edit', 'radio', 'extended', 'version', 'feat', 'ft'].includes(w) && w.length > 2) tags.add(w);
    }
  }
  return tags;
}
const artistNames = a => new Set((a || '').split(/,|&| x | and |feat\.?|ft\.?|featuring|\/|\bwith\b/i).map(x => norm(x).replace(/^the /, '')).filter(Boolean));
const wordSet = x => new Set(ascii(x).toLowerCase().match(/[a-z0-9]+/g) || []);
const sameSet = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
const inter = (a, b) => new Set([...a].filter(x => b.has(x)));

// cands: [{title, artist, dur, item}] → {item, why, extra}
export function pickVersion(cands, title, artist, dur, isVideo) {
  const wantTags = versionTags(title), wantA = firstArtist(artist), wantT = baseTitle(title);
  const names = [...wantTags].filter(t => !CORE.has(t) && t !== 'unplugged');
  const myWords = wordSet(title + ' ' + artist), myArtists = artistNames(artist), titleWords = new Set(norm(title).split(' '));
  let best = null, why = 'no track with this title and artist';
  for (const c of cands) {
    if (baseTitle(c.title) !== wantT) continue;
    const low = (c.title + ' ' + c.artist).toLowerCase();
    if (JUNK.some(j => low.includes(j) && !title.toLowerCase().includes(j))) { why = 'only karaoke/tribute/instrumental versions found'; continue; }
    const their = artistNames(c.artist);
    let ascore;
    if (their.has(wantA)) ascore = 2;
    else if (wantA && new RegExp('\\b' + wantA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(norm(c.artist)) &&
      ![...their].some(n => !myArtists.has(n) && !artistNames(c.title).has(n))) ascore = 1;
    else continue;
    const tags = versionTags(c.title);
    if (!sameSet(inter(tags, CORE), inter(wantTags, CORE)) || !names.every(n => tags.has(n))) {
      why = `found the song, but not this version (${[...inter(wantTags, CORE)].sort().join(', ') || 'original'})`; continue;
    }
    const dd = dur && c.dur ? Math.abs(c.dur - dur) : 0;
    if (dd > (isVideo ? 60 : 20)) { why = `closest version is ${Math.round(dd)}s longer/shorter`; continue; }
    const paren = [...c.title.matchAll(/[\(\[]([^\)\]]*)[\)\]]/g)].map(m => m[1]).join(' ') + ' ' + [...c.title.matchAll(/\s-\s(.*)$/g)].map(m => m[1]).join(' ');
    const allNames = [...their, ...myArtists];
    const extra = [...wordSet(paren)].filter(w => !PLAIN.has(w) && !myWords.has(w) && !/^\d+$/.test(w) && !allNames.some(n => n.split(' ').includes(w)));
    const guests = [...their].filter(n => !myArtists.has(n) && !n.split(' ').every(w => titleWords.has(w)));
    const score = ascore * 10 - extra.length * 3 - guests.length * 2 - dd / 10;
    if (!best || score > best.score) best = { score, item: c.item, dd, label: `${c.title} — ${c.artist}`, extra };
  }
  if (!best) return { item: null, why, extra: '' };
  return { item: best.item, why: `${best.label} (Δlength ${Math.round(best.dd)}s)`, extra: best.extra.length ? `“${best.label}”` : '' };
}

// ------------------------------------------------------------------ links
export function parseLink(s) {
  s = (s || '').trim();
  let m;
  if ((m = s.match(/[?&]list=([A-Za-z0-9_-]+)/)) && /youtube\.com|youtu\.be/.test(s)) return { source: 'youtube', id: m[1] };
  if ((m = s.match(/music\.youtube\.com\/browse\/VL([A-Za-z0-9_-]+)/))) return { source: 'youtube', id: m[1] };
  if ((m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]+)/)) || (m = s.match(/^spotify:playlist:([A-Za-z0-9]+)$/))) return { source: 'spotify', id: m[1] };
  if ((m = s.match(/music\.apple\.com\/([a-z]{2})\/playlist\/[^/]*\/(pl\.[A-Za-z0-9-]+)/))) return { source: 'apple', id: m[2], country: m[1], url: s.split('?')[0] };
  if (/^(PL|OLAK|RD|VL)[A-Za-z0-9_-]{10,}$/.test(s)) return { source: 'youtube', id: s.replace(/^VL/, '') };
  return null;
}

// ------------------------------------------------------------------ YouTube Music (the API music.youtube.com itself uses)
let visitor = null;
async function ytmVisitor() {
  needDev('YouTube Music');
  if (visitor !== null) return visitor;
  try {
    const r = await http('GET', 'https://music.youtube.com/', { headers: { 'User-Agent': UA }, as: 'text' });
    const m = String(r.data || '').match(/"VISITOR_DATA":"([^"]+)"/);
    visitor = m ? m[1] : '';
  } catch (e) { visitor = ''; }
  return visitor;
}
async function ytm(endpoint, body, client) {
  needDev('YouTube Music');
  const d = new Date(), ver = '1.' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + '.01.00';
  const vid = await ytmVisitor();
  const headers = { 'Content-Type': 'application/json', 'User-Agent': UA, Origin: 'https://music.youtube.com', 'X-Goog-Visitor-Id': vid };
  const data = { context: { client: client || { clientName: 'WEB_REMIX', clientVersion: ver, hl: 'en' }, user: {} }, ...body };
  for (let attempt = 0; ; attempt++) {
    const r = await http('POST', `https://music.youtube.com/youtubei/v1/${endpoint}?alt=json&prettyPrint=false`, { headers, data });
    if (r.status < 400 && r.data && typeof r.data === 'object') return r.data;
    if (attempt >= 2) throw new Error(`YouTube Music ${endpoint}: HTTP ${r.status}`);
    await sleep(1500 * (attempt + 1));
  }
}
function* walk(o, key) {        // every object under key `key`, depth first
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) yield* walk(x, key); return; }
  for (const k in o) { if (k === key) yield o[k]; yield* walk(o[k], key); }
}
const runsText = c => (c && c.text && (c.text.runs ? c.text.runs.map(r => r.text).join('') : c.text.simpleText)) || '';
const DUR = /^(\d+:)?\d{1,2}:\d{2}$/;
const secs = t => (t || '').split(':').reduce((a, v) => a * 60 + (+v || 0), 0);
function ytmItem(it) {       // musicResponsiveListItemRenderer → {videoId,title,artist,dur,type,available}
  const flex = (it.flexColumns || []).map(c => c.musicResponsiveListItemFlexColumnRenderer || {});
  const play = it.overlay && it.overlay.musicItemThumbnailOverlayRenderer && it.overlay.musicItemThumbnailOverlayRenderer.content &&
    it.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
  const we = play && play.playNavigationEndpoint && play.playNavigationEndpoint.watchEndpoint;
  let videoId = (we && we.videoId) || (it.playlistItemData && it.playlistItemData.videoId) || null;
  const type = (we && we.watchEndpointMusicSupportedConfigs && we.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig &&
    we.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType) || '';
  let title = '', artists = [], dur = 0, artistFallback = '';
  flex.forEach((c, ci) => {
    const runs = (c.text && c.text.runs) || [];
    for (const r of runs) {
      const ne = r.navigationEndpoint || {};
      const pt = ne.browseEndpoint && ne.browseEndpoint.browseEndpointContextSupportedConfigs &&
        ne.browseEndpoint.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType;
      if (ne.watchEndpoint && !title) { title = r.text; if (!videoId) videoId = ne.watchEndpoint.videoId; }
      else if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_UNKNOWN') artists.push(r.text);
      else if (DUR.test(r.text.trim())) dur = secs(r.text.trim());
    }
    if (ci === 0 && !title && runs[0]) title = runs[0].text;
    if (ci === 1 && runs[0] && !runs[0].navigationEndpoint && !DUR.test(runs[0].text)) artistFallback = runs[0].text;   // non-clickable artist
  });
  for (const c of it.fixedColumns || []) { const t = runsText(c.musicResponsiveListItemFixedColumnRenderer).trim(); if (DUR.test(t)) dur = secs(t); }
  const artist = artists.length ? artists.join(', ') : artistFallback;
  const available = it.musicItemRendererDisplayPolicy !== 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT';
  return videoId && title && title !== 'Song deleted' ? { videoId, title, artist, dur, type, available } : null;
}
async function ytmPlaylist(id, progress) {
  const first = await ytm('browse', { browseId: 'VL' + id });
  let name = '';
  for (const h of walk(first, 'musicResponsiveHeaderRenderer')) { name = runsText({ text: h.title }); break; }
  if (!name) for (const h of walk(first, 'musicDetailHeaderRenderer')) { name = runsText({ text: h.title }); break; }
  const shelf = [...walk(first, 'musicPlaylistShelfRenderer')][0];
  if (!shelf) throw new Error('YouTube Music returned no track list. Is the playlist public or unlisted?');
  const tracks = [], seen = new Set();
  const take = o => { for (const it of walk(o, 'musicResponsiveListItemRenderer')) { const t = ytmItem(it); if (t && !seen.has(t.videoId)) { seen.add(t.videoId); tracks.push(t); } } };
  const token = o => { for (const c of walk(o, 'continuationCommand')) if (c.token) return c.token; for (const c of walk(o, 'nextContinuationData')) if (c.continuation) return c.continuation; return null; };
  take(shelf);
  let next = token(shelf);
  for (let n = 0; next && n < 100; n++) {
    progress && progress(`Reading playlist… ${tracks.length} songs`);
    const r = await ytm('browse', { continuation: next });
    const before = tracks.length;
    take(r.onResponseReceivedActions || r.continuationContents || r);
    next = token(r.onResponseReceivedActions || r.continuationContents || r);
    if (tracks.length === before) break;
  }
  return { name: name || 'YouTube Music playlist', tracks };
}
async function ytmSearchSongs(q) {
  const r = await ytm('search', { query: q, params: 'EgWKAQIIAWoMEA4QChADEAQQCRAF' });      // filter: songs
  const out = [];
  for (const it of walk(r, 'musicResponsiveListItemRenderer')) { const t = ytmItem(it); if (t) out.push(t); }
  return out;
}

// ------------------------------------------------------------------ Spotify (official Web API, client-credentials)
async function spotifyPlaylist(id, creds) {
  if (!creds || !creds.id || !creds.secret) throw new Error('Spotify needs your free client ID and secret: create an app at developer.spotify.com, then paste them in Settings.');
  const tok = await http('POST', 'https://accounts.spotify.com/api/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(creds.id + ':' + creds.secret) },
    data: 'grant_type=client_credentials', as: 'json' });
  if (tok.status >= 400 || !tok.data || !tok.data.access_token) throw new Error('Spotify rejected the client ID/secret (HTTP ' + tok.status + ').');
  const H = { Authorization: 'Bearer ' + tok.data.access_token };
  const meta = await getJSON(`https://api.spotify.com/v1/playlists/${id}?fields=name`, H).catch(e => { throw new Error(e.status === 404 ? 'Spotify: playlist not found (only public playlists you or other users made can be read; Spotify-made mixes are blocked for new apps).' : 'Spotify: ' + e.message); });
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(name,duration_ms,artists(name),is_local))`;
  while (url) {
    const d = await getJSON(url, H);
    for (const x of d.items || []) { const t = x.track; if (t && t.name && !t.is_local) tracks.push({ title: t.name, artist: (t.artists || []).map(a => a.name).join(', '), dur: (t.duration_ms || 0) / 1000 }); }
    url = d.next;
  }
  return { name: meta.name || 'Spotify playlist', tracks };
}

// ------------------------------------------------------------------ Apple Music (public playlist page; unofficial)
async function applePlaylist(p) {
  needDev('Apple Music playlist import');
  const r = await http('GET', p.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, as: 'text' });
  const html = String(r.data || '');
  if (r.status >= 400 || !html) throw new Error('Apple Music: could not open the playlist page (HTTP ' + r.status + ').');
  const name = ((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || 'Apple Music playlist').replace(/&amp;/g, '&').replace(/ on Apple Music$/, '');
  const tracks = [], seen = new Set();
  const add = (title, artist, dur) => { const k = norm(title) + '|' + firstArtist(artist); if (title && !seen.has(k)) { seen.add(k); tracks.push({ title, artist: artist || '', dur }); } };
  const ssd = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
  if (ssd) {
    try {
      const walkAll = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walkAll);
        if (typeof o.title === 'string' && typeof o.artistName === 'string' && typeof o.duration === 'number') add(o.title, o.artistName, o.duration / 1000);
        for (const k in o) walkAll(o[k]); };
      walkAll(JSON.parse(ssd[1]));
    } catch (e) { /* fall through to JSON-LD */ }
  }
  if (!tracks.length) {
    const ld = html.match(/<script[^>]*name="schema:music-playlist"[^>]*>([\s\S]*?)<\/script>/);
    if (ld) try {
      const j = JSON.parse(ld[1]);
      for (const t of j.track || []) { const d = (t.duration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; add(t.name, (t.byArtist && (t.byArtist.name || (t.byArtist[0] || {}).name)) || '', (+d[1] || 0) * 3600 + (+d[2] || 0) * 60 + (+d[3] || 0)); }
    } catch (e) { /* nothing */ }
  }
  if (!tracks.length) throw new Error('Apple Music: no songs found on the playlist page (Apple may have changed it).');
  return { name, tracks };
}

// ------------------------------------------------------------------ iTunes preview → BPM + energy features
let lastItunes = 0;
async function itunesSearch(term, country) {
  const wait = 3100 - (Date.now() - lastItunes);          // Apple allows ~20 searches a minute
  if (wait > 0) await sleep(wait);
  lastItunes = Date.now();
  const d = await getJSON('https://itunes.apple.com/search?' + new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25', country }));
  return (d && d.results) || [];
}
let ess = null;
async function essentia() {
  if (ess) return ess;
  if (EssentiaWASM && !EssentiaWASM.calledRun && EssentiaWASM.onRuntimeInitialized !== undefined)
    await new Promise(r => { const prev = EssentiaWASM.onRuntimeInitialized; EssentiaWASM.onRuntimeInitialized = () => { prev && prev(); r(); }; setTimeout(r, 8000); });
  ess = new Essentia(EssentiaWASM);
  return ess;
}
const related = (a, b, tol = 0.04) => { for (const [k, m] of [['same', 1], ['double', 2], ['half', 0.5]]) if (Math.abs(b - a * m) / (a * m) <= tol) return k; return null; };
export async function measurePreview(buf) {
  const ctx = new OfflineAudioContext(1, 44100 * 40, 44100);
  const ab = await ctx.decodeAudioData(buf.slice(0));
  const n = ab.length, y = new Float32Array(n);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) y[i] += d[i] / ab.numberOfChannels; }
  const e = await essentia(), v = e.arrayToVector(y);
  const ests = [];
  try { const r = e.RhythmExtractor2013(v, 208, 'multifeature', 40); ests.push(['essentia', r.bpm, r.confidence]); } catch (x) { }
  try { const r = e.RhythmExtractor2013(v, 208, 'degara', 40); ests.push(['degara', r.bpm]); } catch (x) { }
  try { const r = e.PercivalBpmEstimator(v, 1024, 2048, 128, 128, 210, 50, 44100); ests.push(['percival', r.bpm]); } catch (x) { }
  let rate = 0, zcr = 0;
  try { rate = e.OnsetRate(v).onsetRate; } catch (x) { }
  try { zcr = e.ZeroCrossingRate(v).zeroCrossingRate; } catch (x) { }
  let s2 = 0; for (let i = 0; i < n; i++) s2 += y[i] * y[i];
  try { v.delete && v.delete(); } catch (x) { }
  const feats = { loud: 20 * Math.log10(Math.sqrt(s2 / Math.max(1, n)) + 1e-9), rate, bright: zcr };
  const E = ests.filter(x => x[1] >= 40 && x[1] <= 250).map(x => [x[0], Math.round(x[1] * 10) / 10]);
  if (!E.length) return null;
  const groups = E.map(f => E.filter(x => related(x[1], f[1]) || related(f[1], x[1])));
  const g = groups.reduce((a, b) => b.length > a.length ? b : a);
  const rep = g.find(x => x[0] === 'essentia') || g[0];
  const alt = E.find(x => !g.includes(x) && [2 / 3, 1.5, 4 / 3, 0.75].some(r => Math.abs(x[1] / rep[1] - r) / r < 0.04)) || null;
  return { bpm: rep[1], agree: g.length, n: E.length, alt, feats, ests: E.map(x => `${x[0]} ${Math.round(x[1])}`).join(', ') };
}
async function itunesBpm(title, artist, dur, isVideo, country) {
  const rawT = title.replace(/[\(\[][^\)\]]*[\)\]]|\s-\s.*$/g, ' ').trim().replace(/^\.+/, '') || title;
  const res = await itunesSearch(`${rawT} ${artist.split(/,|&/)[0].trim()}`, country);
  const cands = res.filter(r => r.previewUrl).map(r => ({ title: r.trackName || '', artist: r.artistName || '', dur: (r.trackTimeMillis || 0) / 1000, item: r }));
  const pv = pickVersion(cands, title, artist, dur, isVideo);
  if (!pv.item) return { bpm: null, why: 'iTunes: ' + pv.why };
  const a = await http('GET', pv.item.previewUrl, { as: 'binary' });
  if (a.status >= 400) return { bpm: null, why: 'iTunes preview download failed' };
  let m = null;
  try { m = await measurePreview(a.data); } catch (e) { return { bpm: null, why: 'preview could not be decoded: ' + e.message }; }
  if (!m) return { bpm: null, why: 'preview tempo could not be measured' };
  const out = { bpm: m.bpm, src: 'itunes-preview', alts: [], feats: m.feats, match: pv.why, flag: `${m.agree} of ${m.n} estimators agree (${m.ests})` };
  if (m.agree < 2) Object.assign(out, { src: 'check', flag: `estimators disagree (${m.ests}): tap the beat to fix` });
  else if (m.alt) Object.assign(out, { src: 'check', flag: `could also be ${Math.round(m.alt[1])} (triplet/swing feel?) (${m.ests}): tap the beat to fix` });
  if (m.bpm < 110 && m.bpm * 2 <= 220) out.alts = [{ bpm: Math.round(m.bpm * 20) / 10, conf: 0.5 }];
  if (pv.extra) Object.assign(out, { src: 'check', flag: `matched ${pv.extra}, which may be a different version` });
  return out;
}

// ------------------------------------------------------------------ timed lyrics (LRCLIB) → per-bar structure
async function lrclib(title, artist, dur) {
  if (!dur) return null;
  const rawT = title.replace(/[\(\[][^\)\]]*[\)\]]|\s-\s.*$/g, ' ').trim() || title;
  const res = await getJSON('https://lrclib.net/api/search?' + new URLSearchParams({ track_name: rawT, artist_name: artist.split(/,|&/)[0].trim() }), { 'User-Agent': LRCLIB_UA }).catch(() => null);
  let best = null;
  for (const r of Array.isArray(res) ? res : []) {
    if (!r.syncedLyrics || Math.abs((r.duration || 0) - dur) > 2 || baseTitle(r.trackName) !== baseTitle(title)) continue;
    if (!best || Math.abs(r.duration - dur) < Math.abs(best.duration - dur)) best = r;
  }
  if (!best) return null;
  const pts = [];
  for (const ln of best.syncedLyrics.split('\n')) { const m = ln.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/); if (m) pts.push([+m[1] * 60 + +m[2], m[3]]); }
  return pts.map((p, i) => [p[0], i + 1 < pts.length ? pts[i + 1][0] : p[0] + 4, p[1]]).filter(x => x[2].trim());
}
export function structureFromLyrics(lines, bpm, dur) {
  const key = t => ascii(t).toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
  const L = lines.map(([a, b, t]) => [a, b, key(t)]).filter(x => x[2] && !['music', 'instrumental'].includes(x[2]));
  if (L.length < 8 || !bpm || !dur) return null;
  let bar = 240 / bpm; while (bar < 1.6) bar *= 2;
  const cnt = {}; for (const x of L) cnt[x[2]] = (cnt[x[2]] || 0) + 1;
  const rep = L.map(x => cnt[x[2]] >= 2 && x[2].split(' ').length >= 2);
  const runs = [];
  for (let i = 0; i < L.length;) {
    if (!rep[i]) { i++; continue; }
    let j = i, miss = 0;
    while (j + 1 < L.length && L[j + 1][0] - L[j][1] < 2 * bar && (rep[j + 1] || (miss === 0 && j + 2 < L.length && rep[j + 2]))) { if (!rep[j + 1]) miss++; j++; }
    if (j - i + 1 >= 3 && L[j][1] - L[i][0] >= 2 * bar) runs.push([L[i][0] - 0.25 * bar, L[j][1]]);
    i = j + 1;
  }
  if (!runs.length) return null;
  const anchor = runs[0][0], grid = [];
  for (let k = -Math.floor(anchor / bar); anchor + k * bar < dur - 0.5; k++) if (anchor + k * bar >= 0) grid.push([anchor + k * bar, k]);
  if (grid.length < 16) return null;
  const firstLine = L[0][0], lastLine = L[L.length - 1][1];
  const starts = L.filter((x, i) => i === 0 || x[0] - L[i - 1][1] > 1.5 * bar).map(x => x[0]);
  const inCh = t => runs.some(([a, b]) => a - 0.1 <= t && t < b);
  const sung = (a, b) => L.some(([x, y]) => x < b && y > a);
  const bars = grid.map(([t, k], n) => {
    const e = inCh(t) ? 0.9 : t + bar <= firstLine ? 0.35 : t >= lastLine + bar ? 0.3 : !sung(t, t + 2 * bar) ? 0.55 : 0.6;
    let ex = 0;
    if (n && inCh(grid[n - 1][0]) && !inCh(t)) ex = 1;
    else if (starts.some(s => t - 0.5 * bar <= s && s < t + 0.5 * bar)) ex = 0.6;
    const ph = ((k % 8) + 8) % 8 === 0 ? 1 : 0;
    return [Math.round(t * 100) / 100, Math.round(Math.min(1, ex + 0.25 * ph) * 100) / 100, ph, e];
  });
  const wave = Array.from({ length: 240 }, (_, i) => Math.round(100 * bars[Math.min(bars.length - 1, Math.max(0, Math.floor(i / 240 * dur / bar)))][3]));
  return { bars, wave, first_bar: bars[0][0], choruses: runs.length, lastChorusEnd: runs[runs.length - 1][1] };
}

// ------------------------------------------------------------------ YouTube Music's own timed lyrics (as ytmusicapi does it)
async function ytmTimedLyrics(videoId) {
  const nx = await ytm('next', { videoId, enablePersistentPlaylistPanel: true, isAudioOnly: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' });
  let bid = null;
  for (const be of walk(nx, 'browseEndpoint')) {
    const pt = be.browseEndpointContextSupportedConfigs && be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig &&
      be.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType;
    if (pt === 'MUSIC_PAGE_TYPE_TRACK_LYRICS' && be.browseId) { bid = be.browseId; break; }
  }
  if (!bid) return null;
  const r = await ytm('browse', { browseId: bid }, { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50', hl: 'en' });
  for (const arr of walk(r, 'timedLyricsData')) {
    if (!Array.isArray(arr) || !arr.length || !arr.every(x => x.cueRange)) continue;
    return arr.map(x => [+x.cueRange.startTimeMilliseconds / 1000, +x.cueRange.endTimeMilliseconds / 1000, x.lyricLine || '']).filter(x => x[2].trim());
  }
  return null;
}

// ------------------------------------------------------------------ YouTube embeddability
async function embeddable(videoId) {
  try {
    const r = await http('GET', 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId));
    return r.status === 401 || r.status === 403 || r.status === 404 ? false : r.status < 400 ? true : null;
  } catch (e) { return null; }
}

async function addSections(meta, isAudio) {
  const vid = meta.yt, dur = meta.dur, bpm = meta.bpm;
  // LRCLIB (public synced-lyrics database) is the primary source. YouTube Music's own timed lyrics are a dev-only extra.
  let lines = await lrclib(meta.title, meta.artist, dur).catch(() => null);
  if (!lines && DEV_SOURCES && isAudio && vid) lines = await ytmTimedLyrics(vid).catch(() => null);
  const st = lines ? structureFromLyrics(lines, bpm, dur) : null;
  if (st) return Object.assign(meta, { bars: st.bars, wave: st.wave, first_bar: st.first_bar, sections: `${st.choruses} choruses (lyrics)` });
  meta.sections = 'no section data: enters about a quarter in';
  return meta;
}

// ------------------------------------------------------------------ the whole thing
// opts: {country, spotify:{id,secret}, known: Map(videoId|'t:'+title|artist → existing meta), cancelled: () => bool}
// cb:   {progress(text), song(meta), skipped(title, why)}
export async function analyzePlaylist(link, opts, cb) {
  const p = typeof link === 'string' ? parseLink(link) : link;
  if (!p) throw new Error("That doesn't look like a YouTube Music, Spotify or Apple Music playlist link.");
  if (!DEV_SOURCES && p.source !== 'spotify') throw new Error((p.source === 'youtube' ? 'YouTube Music' : 'Apple Music') + ' playlist import is only available in debug builds for now.');
  const country = opts.country || 'IN';
  cb.progress && cb.progress('Reading the playlist…');
  const pl = p.source === 'youtube' ? await ytmPlaylist(p.id, cb.progress) : p.source === 'spotify' ? await spotifyPlaylist(p.id, opts.spotify) : await applePlaylist(p);
  const plId = p.source + ':' + p.id;
  const out = { id: plId, source: p.source, link: typeof link === 'string' ? link : '', name: pl.name, total: pl.tracks.length, added: 0, reused: 0, skipped: [] };
  cb.playlist && cb.playlist(out);
  for (let i = 0; i < pl.tracks.length; i++) {
    if (opts.cancelled && opts.cancelled()) break;
    const t = pl.tracks[i];
    const label = `${t.title} — ${t.artist}`;
    cb.progress && cb.progress(`${i + 1}/${pl.tracks.length} · ${label}`);
    try {
      // 1. the YouTube audio version to play
      let vid = t.videoId || null, dur = t.dur || 0, type = t.type || '';
      const known = opts.known && (opts.known.get(vid) || opts.known.get(songKey(t.title, t.artist)));
      if (known) { out.reused++; const k = { ...known }; if (!k.bars && k.yt && !k.sectionsTried) { await addSections(k, true); k.sectionsTried = 1; } cb.song(k, plId); continue; }
      if (t.available === false) { out.skipped.push([label, 'unavailable']); continue; }
      if (!vid || !/ATV/.test(type)) {
        const res = await ytmSearchSongs(`${t.title} ${t.artist.split(/,|&/)[0]}`).catch(() => []);
        const pv = pickVersion(res.map(r => ({ title: r.title, artist: r.artist, dur: r.dur, item: r })), t.title, t.artist, dur, /OMV|UGC/.test(type));
        if (pv.item) { vid = pv.item.videoId; dur = pv.item.dur || dur; type = pv.item.type || 'MUSIC_VIDEO_TYPE_ATV'; if (/OMV|UGC/.test(t.type || '')) t.title = pv.item.title; }
        else if (!vid) { out.skipped.push([label, 'not found on YouTube Music: ' + pv.why]); continue; }
        await sleep(300);
      }
      if (opts.known && opts.known.get(vid)) { out.reused++; const k = { ...opts.known.get(vid) }; if (!k.bars && !k.sectionsTried) { await addSections(k, true); k.sectionsTried = 1; } cb.song(k, plId); continue; }
      if (await embeddable(vid) === false) { out.skipped.push([label, "the owner doesn't allow it to play inside apps"]); continue; }
      // 2. BPM + energy features from the iTunes preview of the same version
      const b = await itunesBpm(t.title, t.artist, dur, /OMV|UGC/.test(type), country);
      if (!b.bpm) { out.skipped.push([label, b.why]); continue; }
      const meta = { file: 'yt:' + vid, yt: vid, title: t.title, artist: t.artist, dur, bpm: b.bpm, src: b.src, alts: b.alts, energy: 0.5,
        feats: b.feats, flag: b.flag, match: b.match, bars: null, wave: null, first_bar: null };
      // 3. sections: LRCLIB's timed lyrics, else the plain fallback (enters about a quarter in)
      await addSections(meta, /ATV/.test(type));
      out.added++;
      cb.song(meta, plId);
    } catch (e) {
      out.skipped.push([label, e.message || String(e)]);
    }
  }
  return out;
}

// Energy = mean percentile rank of loudness, onset rate and brightness among all analysed songs (as dj_live.py does)
export function rankEnergy(metas) {
  const fs = metas.filter(m => m.feats && !m.eEdit);
  if (fs.length < 2) return [];
  const rank = k => { const idx = fs.map((m, i) => i).sort((a, b) => fs[a].feats[k] - fs[b].feats[k]), r = new Array(fs.length); idx.forEach((i, pos) => r[i] = pos / (fs.length - 1)); return r; };
  const L = rank('loud'), R = rank('rate'), B = rank('bright'), changed = [];
  fs.forEach((m, i) => { const e = Math.round((L[i] + R[i] + B[i]) / 3 * 100) / 100; if (e !== m.energy) { m.energy = e; changed.push(m); } });
  return changed;
}

export const songKey = (title, artist) => 't:' + norm(title) + '|' + firstArtist(artist);

export const _test = { setHttp: f => { httpOverride = f; }, setDevSources: v => { DEV_SOURCES = !!v; }, ytmTimedLyrics, norm, versionTags, ytmItem, ytmPlaylist, ytmSearchSongs, applePlaylist, spotifyPlaylist, lrclib };
