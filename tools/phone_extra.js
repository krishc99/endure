// ======================= phone-only additions =======================
const native=window.RunDJNative&&window.RunDJNative.isNative?window.RunDJNative:null;
const keepAwake=on=>{try{if(native)on?native.KeepAwake.keepAwake():native.KeepAwake.allowSleep()}catch(e){}};
let src='manual',hcCad=null,hcOk=false,hcTimer=null,motionCad=null,pedCad=null;

// ---- storage: songs live in IndexedDB so they survive app restarts
let db=null,blobs={},urls={},allSongs=[];
const idb=()=>db?Promise.resolve(db):new Promise((res,rej)=>{const r=indexedDB.open('rundj',1);
  r.onupgradeneeded=()=>{r.result.createObjectStore('meta',{keyPath:'file'});r.result.createObjectStore('blob')};
  r.onsuccess=()=>res(db=r.result);r.onerror=()=>rej(r.error)});
const tx=(name,mode,fn)=>idb().then(d=>new Promise((res,rej)=>{
  const t=d.transaction(name,mode);let out;
  t.oncomplete=()=>res(out&&typeof out==='object'&&'result' in out?out.result:out);t.onerror=t.onabort=()=>rej(t.error);
  out=fn(t.objectStore(name))}));
const srcFor=s=>s.yt?'yt:'+s.yt:urls[s.file]||(urls[s.file]=URL.createObjectURL(blobs[s.file]));
const saveMeta=s=>{const {id,_hr,bad,...m}=s;return tx('meta','readwrite',st=>st.put(m))};
const post=(p,o)=>saveMeta(songs[o.id]);                      // ½ / ×2 / energy edits persist on the phone
const say=(id,t)=>{$(id).textContent=t};

async function loadLibrary(){
  const metas=await tx('meta','readonly',s=>s.getAll()),keys=await tx('blob','readonly',s=>s.getAllKeys()),vals=await tx('blob','readonly',s=>s.getAll());
  blobs={};keys.forEach((k,i)=>blobs[k]=vals[i]);
  allSongs=metas.filter(m=>m.yt||blobs[m.file]);
  const pool=$('pool').value,nYt=allSongs.filter(m=>m.yt).length;
  songs=allSongs.filter(m=>pool==='all'||(pool==='yt')===!!m.yt)
    .sort((a,b)=>(a.title||a.file).localeCompare(b.title||b.file)).map((m,i)=>({...m,id:i}));
  say('count',`${songs.length} songs`);
  say('libstatus',allSongs.length?`${allSongs.length} songs: ${allSongs.length-nYt} local, ${nYt} from YouTube Music. Playing from ${songs.length}.`
    :'No songs yet. Tap Import and select library.json plus your audio files together, or a yt_library.json on its own.');
  ver++;render();
}
async function importFiles(files){
  const isJ=f=>/\.json$/i.test(f.name),audio=new Map(files.filter(f=>!isJ(f)).map(f=>[f.name,f]));let metas=[],bad=[];
  for(const j of files.filter(isJ)){try{const d=JSON.parse(await j.text()),ms=Array.isArray(d)?d:(d.songs||[]);if(d.playlistId)ms.forEach(m=>{if(m.yt)m.pl=d.playlistId});metas=metas.concat(ms)}catch(e){bad.push(j.name)}}
  const old=new Map(allSongs.map(s=>[s.file,s])),have=new Set(old.keys()),fileOf=new Set(metas.map(m=>m.file));
  // A YouTube playlist file replaces that playlist's earlier import (songs you removed go away), keeping your ½ / ×2 / energy edits
  const pls=new Set(metas.filter(m=>m.yt&&m.pl).map(m=>m.pl));
  let added=0,nyt=0;const noAudio=[];let noMeta=0;
  await tx('meta','readwrite',s=>{
    for(const o of allSongs)if(o.yt&&pls.has(o.pl)&&!fileOf.has(o.file))s.delete(o.file);
    for(const m of metas){
      if(m.yt){const o=old.get(m.file);if(o&&o.src==='edited')Object.assign(m,{bpm:o.bpm,src:'edited',alts:[]});if(o&&o.eEdit)Object.assign(m,{energy:o.energy,eEdit:1});s.put(m);added++;nyt++}
      else if(audio.has(m.file)||have.has(m.file)){s.put(m);added++}else noAudio.push(m.file)}});
  await tx('blob','readwrite',s=>{for(const [n,f] of audio){if(fileOf.has(n)||have.has(n))s.put(f,n);else noMeta++}});
  say('impmsg',`Imported ${added} songs${nyt?` (${nyt} from YouTube Music)`:''}.`+(noAudio.length?` ${noAudio.length} library entries had no matching audio file (e.g. ${noAudio[0]}).`:'')
    +(noMeta?` ${noMeta} audio files had no analysis in library.json and were skipped.`:'')+(bad.length?` Could not read: ${bad.join(', ')}.`:''));
  await loadLibrary();
}
async function clearLibrary(){await tx('meta','readwrite',s=>s.clear());await tx('blob','readwrite',s=>s.clear());Object.values(urls).forEach(u=>URL.revokeObjectURL(u));urls={};say('impmsg','Library cleared.');await loadLibrary()}

// ---- cadence source: manual slider, or steps from Health Connect
const cadence=()=>{const c=src==='hc'?hcCad:src==='motion'?motionCad:src==='ped'?pedCad:+$('bpm').value;return c==null?0:c};
const SRCS=['manual','motion','ped','hc'];
function setSrc(v){
  src=v;SRCS.forEach(k=>$('src_'+k).classList.toggle('p',k===v));
  $('bpm').disabled=v!=='manual';$('hcbox').style.display=v==='hc'?'block':'none';$('livebox').style.display=v==='motion'||v==='ped'?'block':'none';
  try{localStorage.setItem('rundj_src',v)}catch(e){}
  hcStop();motionStop();pedStop();motionCad=pedCad=null;
  if(v==='hc')hcStart();else if(v==='motion')motionStart();else if(v==='ped')pedStart();
  render();
}

// ---- live source 1: phone motion (accelerometer), instant. See motion.js.
let mDet=null,mTimer=null,mWall=0;
function onMotion(e){
  const a=e.accelerationIncludingGravity;if(!a||a.x==null||!mDet)return;
  mWall=performance.now();mDet.push(e.timeStamp||mWall,a.x,a.y,a.z);
}
async function motionStart(){
  mDet=new MotionCadence({minStd:+$('mmin').value||0.5});mWall=0;
  try{if(typeof DeviceMotionEvent!=='undefined'&&typeof DeviceMotionEvent.requestPermission==='function'){
    if(await DeviceMotionEvent.requestPermission()!=='granted'){say('livestatus','Motion permission denied.');return}}}catch(e){}
  window.addEventListener('devicemotion',onMotion);say('livestatus','Waiting for motion data…');
  mTimer=setInterval(motionTick,500);
}
function motionStop(){window.removeEventListener('devicemotion',onMotion);clearInterval(mTimer);mTimer=null;mDet=null}
function motionTick(){
  if(!mDet)return;
  mDet.minStd=+$('mmin').value||0.5;
  if(!mWall||performance.now()-mWall>2500){motionCad=null;
    say('livestatus',mWall?'The motion sensor stopped sending data.':'No motion data yet. This phone or WebView may not expose the accelerometer.');render();return}
  const c=mDet.cadence();motionCad=c;
  say('livestatus',c==null?'Collecting a few seconds of motion…':c===0?'Not moving with steps (cadence 0)':
    `${Math.round(c)} steps/min · live from phone motion · signal ${(mDet.quality||0).toFixed(2)}`);
  render();
}

// ---- live source 2: the phone's hardware step counter (Android TYPE_STEP_COUNTER)
const PED=native&&native.Pedometer;let pedOn=false,pedSamples=[],pedHandle=null,pedTimer=null;
// steps/min over the last winMs. The counter only reports when it changes, so no report for stopMs means "stopped".
function pedCompute(samples,now,winMs,stopMs){
  if(!samples.length)return null;
  const newest=samples[samples.length-1];if(now-newest[0]>stopMs)return 0;
  const lo=now-winMs;let base=samples[0];for(const s of samples){if(s[0]<=lo)base=s;else break}
  return (newest[1]-base[1])*60000/Math.max(Math.min(winMs,now-base[0]),4000);
}
async function pedStart(){
  if(!PED){say('livestatus','The step counter only works inside the Android app.');return}
  try{
    const av=await PED.isAvailable();if(!av.stepCounting){say('livestatus','This phone reports no hardware step counter.');return}
    let p=await PED.checkPermissions();if(p.activityRecognition!=='granted')p=await PED.requestPermissions();
    if(p.activityRecognition!=='granted'){say('livestatus','Physical activity permission not granted. Allow it in Android Settings → Apps → Run DJ → Permissions.');return}
    pedSamples=[];pedHandle=await PED.addListener('measurement',ev=>{pedSamples.push([Date.now(),ev.numberOfSteps||0]);if(pedSamples.length>400)pedSamples.shift()});
    await PED.startMeasurementUpdates();pedOn=true;say('livestatus','Waiting for the first step…');pedTimer=setInterval(pedTick,1000);
  }catch(e){say('livestatus','Step counter error: '+(e.message||e))}
}
async function pedStop(){
  clearInterval(pedTimer);pedTimer=null;
  if(pedOn&&PED){try{await PED.stopMeasurementUpdates()}catch(e){}}
  try{if(pedHandle)await pedHandle.remove()}catch(e){}pedOn=false;pedHandle=null;
}
function pedTick(){
  const now=Date.now(),c=pedCompute(pedSamples,now,(+$('pedwin').value||10)*1000,6000);pedCad=c;
  const last=pedSamples.length?Math.round((now-pedSamples[pedSamples.length-1][0])/1000):null;
  say('livestatus',c==null?'No step events yet. Walk a few steps.':c===0?`Stopped (no step events for ${last}s)`:`${Math.round(c)} steps/min · hardware step counter · last event ${last}s ago`);
  render();
}
// One source only (the one with the freshest data) so two apps writing the same steps aren't double counted.
// The window is anchored on the newest record, so a few minutes of sync lag doesn't make the cadence read low.
function computeCadence(samples,now,winMs,staleMs){
  const by={};for(const s of samples){const k=s.sourceId||s.sourceName||'?';(by[k]=by[k]||[]).push(s)}
  let best=null,newest=0;
  for(const k in by){const e=Math.max(...by[k].map(s=>Date.parse(s.endDate)));if(e>newest){newest=e;best=k}}
  if(!best)return {cad:null,age:null,src:null,n:0,steps:0};
  const age=now-newest,lo=newest-winMs;let steps=0;
  for(const s of by[best]){const a=Date.parse(s.startDate),b=Date.parse(s.endDate);if(!(b>a))continue;
    const x=Math.max(a,lo),y=Math.min(b,newest);if(y>x)steps+=s.value*(y-x)/(b-a)}
  return {cad:age>staleMs?0:steps/(winMs/60000),age,src:best,n:by[best].length,steps};
}
const H=native&&native.Health;
async function hcCheck(){if(!H)return false;try{const st=await H.checkAuthorization({read:['steps']});hcOk=(st.readAuthorized||[]).includes('steps')}catch(e){hcOk=false}return hcOk}
async function hcConnect(){
  if(!H){say('hcstatus','Health Connect only works inside the Android app.');return}
  try{
    const av=await H.isAvailable();
    if(!av.available){say('hcstatus','Health Connect is not available: '+(av.reason||'unknown')+'. On Android 13 or older, install “Health Connect” from the Play Store.');try{await H.openHealthConnectSettings()}catch(e){}return}
    const st=await H.requestAuthorization({read:['steps']});hcOk=(st.readAuthorized||[]).includes('steps');
    say('hcstatus',hcOk?'Connected. Reading steps…':'Steps permission not granted. Tap Connect again, or allow it under Health Connect → App permissions.');
    if(hcOk)hcStart();
  }catch(e){say('hcstatus','Error: '+(e.message||e))}
}
function hcStop(){clearInterval(hcTimer);hcTimer=null}
function hcStart(){hcStop();if(!hcOk){say('hcstatus','Not connected. Tap Connect.');return}hcPoll();hcTimer=setInterval(hcPoll,Math.max(3,+$('hcpoll').value||10)*1000)}
async function hcPoll(){
  if(!H||!hcOk)return;
  try{
    const now=Date.now(),win=(+$('hcwin').value||120)*1000,stale=(+$('hcstale').value||240)*1000;
    const r=await H.readSamples({dataType:'steps',startDate:new Date(now-win-stale).toISOString(),endDate:new Date(now+1000).toISOString(),limit:500,ascending:true});
    const c=computeCadence(r.samples||[],now,win,stale);hcCad=c.cad;
    say('hcstatus',c.n?`${Math.round(c.cad)} steps/min · newest record ${Math.round(c.age/1000)}s old · ${c.n} records from ${c.src}${c.cad===0?' · too old, treating as stopped':''}`
      :`No step records in the last ${Math.round((win+stale)/60000)} min. Is a step-tracking app (e.g. Google Fit) writing to Health Connect?`);
    render();
  }catch(e){say('hcstatus','Read failed: '+(e.message||e))}
}
async function hcTest(){
  if(!H){log('Health Connect test: only works inside the Android app');return}
  if(!await hcCheck()){log('Health Connect test: steps permission not granted. Tap Connect first.');return}
  try{
    const now=Date.now(),r=await H.readSamples({dataType:'steps',startDate:new Date(now-30*60000).toISOString(),endDate:new Date(now+1000).toISOString(),limit:500,ascending:true});
    const by={};for(const s of r.samples||[]){const k=s.sourceName||s.sourceId||'?';const o=by[k]=by[k]||{n:0,steps:0,end:0};o.n++;o.steps+=s.value;o.end=Math.max(o.end,Date.parse(s.endDate))}
    const ks=Object.keys(by);
    log(ks.length?`HC test (last 30 min): `+ks.map(k=>`${k}: ${by[k].n} records, ${Math.round(by[k].steps)} steps, newest ${Math.round((now-by[k].end)/1000)}s ago`).join(' | '):'HC test: no step records in the last 30 min. Open your step-tracking app and check it writes to Health Connect.');
  }catch(e){log('HC test failed: '+(e.message||e))}
}

// ---- remember settings between launches
const SAVED=['bpm','tol','min','mar','spread','xf','ew','htpen','conf','wait','swap','hcwin','hcstale','hcpoll','mmin','pedwin','rotate','half','alt'];
function saveSettings(){try{const o={};SAVED.forEach(id=>{const e=$(id);o[id]=e.type==='checkbox'?e.checked:e.value});localStorage.setItem('rundj_settings',JSON.stringify(o))}catch(e){}}
function loadSettings(){try{const o=JSON.parse(localStorage.getItem('rundj_settings')||'{}');SAVED.forEach(id=>{if(id in o){const e=$(id);e.type==='checkbox'?e.checked=o[id]:e.value=o[id]}})}catch(e){}}

SRCS.forEach(k=>$('src_'+k).onclick=()=>setSrc(k));
$('hcconnect').onclick=hcConnect;$('hctest').onclick=hcTest;
$('imp').onclick=()=>$('file').click();
$('pool').onchange=()=>{try{localStorage.setItem('rundj_pool',$('pool').value)}catch(e){};loadLibrary()};
// A YouTube song that can't play (removed, embedding off, no network): skip it for this session and move on
AU.forEach(d=>d.onerror=(deck,vid,code,why)=>{
  const s=songs.find(x=>x.yt===vid);if(s){s.bad=true;ver++}
  log(`⚠ YouTube can't play ${s?name(s):vid}: ${why}. Skipping it.`);
  if(deck!==AU[ai]&&plan&&plan.x.s.yt===vid){plan=null;keep=null;pend=null;prepId=null;disarm()}
  render();
});$('file').onchange=async e=>{const f=[...e.target.files];e.target.value='';await importFiles(f)};
$('clearlib').onclick=()=>{if(confirm('Remove all imported songs from this phone?'))clearLibrary()};
SAVED.forEach(id=>{$(id).addEventListener('change',saveSettings);$(id).addEventListener('input',saveSettings)});
// ---- tap tempo: fix the playing song's BPM by ear. Saved on the phone and kept when you re-import the playlist.
let taps=[],tapBpm=null;
$('tap').onclick=()=>{
  const now=performance.now();if(taps.length&&now-taps[taps.length-1]>2000)taps=[];
  taps.push(now);if(taps.length>16)taps.shift();
  if(taps.length<4){say('tapv',`keep tapping… (${taps.length})`);$('tapsave').style.display='none';return}
  const d=taps.slice(1).map((t,i)=>t-taps[i]).sort((a,b)=>a-b),med=d[Math.floor(d.length/2)];
  tapBpm=Math.round(600000/med)/10;
  say('tapv',cur?`${tapBpm} BPM (${taps.length} taps) · now ${cur.bpm}`:`${tapBpm} BPM (${taps.length} taps)`);
  $('tapsave').style.display=cur&&taps.length>=8?'inline-block':'none';
};
$('tapsave').onclick=async()=>{
  if(!cur||!tapBpm)return;
  log(`✎ ${name(cur)}: BPM ${cur.bpm} → ${tapBpm} (tapped)`);
  cur.bpm=tapBpm;cur.src='edited';cur.alts=[];ver++;taps=[];$('tapsave').style.display='none';
  say('tapv','Saved.');await post('/api/bpm',{id:cur.id,bpm:cur.bpm});render();
};
async function initApp(){
  loadSettings();try{const p=localStorage.getItem('rundj_pool');if(p)$('pool').value=p}catch(e){}render();
  await loadLibrary();
  const want=(()=>{try{return localStorage.getItem('rundj_src')}catch(e){return null}})();
  if(want==='hc')await hcCheck();
  setSrc(SRCS.includes(want)?want:'manual');
}
