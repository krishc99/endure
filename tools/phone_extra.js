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
const clean=s=>{const {id,_hr,bad,...m}=s;if(m.pl&&!m.pls){m.pls=[m.pl]}delete m.pl;return m};
const saveMeta=s=>{const m=clean(s);return tx('meta','readwrite',st=>st.put(m)).then(()=>{const o=allSongs.find(x=>x.file===m.file);if(o)Object.assign(o,m);fileSoon()})};
const post=(p,o)=>saveMeta(songs[o.id]);                      // ½ / ×2 / energy / tap edits persist on the phone
const say=(id,t)=>{$(id).textContent=t};
const esc=t=>String(t==null?'':t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---- playlists you added (YouTube Music / Spotify / Apple Music links, or yt_library.json files)
let playlists=[];
const loadPlaylists=()=>{try{playlists=JSON.parse(localStorage.getItem('rundj_playlists')||'[]')}catch(e){playlists=[]}};
const savePlaylists=()=>{try{localStorage.setItem('rundj_playlists',JSON.stringify(playlists))}catch(e){}};
function upsertPlaylist(p){const o=playlists.find(x=>x.id===p.id);if(o)Object.assign(o,p);else playlists.push({added:Date.now(),...p});savePlaylists();return playlists.find(x=>x.id===p.id)}
const inPool=(m,pool)=>pool==='all'||(pool==='yt'?!!m.yt:pool==='local'?!m.yt:pool.startsWith('pl:')?(m.pls||[]).includes(pool.slice(3)):true);
function renderPlaylists(){
  const sel=$('pool'),cur0=sel.value;
  sel.innerHTML='<option value="all">All songs</option><option value="yt">YouTube Music only</option><option value="local">Local files only</option>'+
    playlists.map(p=>`<option value="pl:${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value=[...sel.options].some(o=>o.value===cur0)?cur0:'all';
  $('plists').innerHTML=playlists.map((p,i)=>{const n=allSongs.filter(m=>(m.pls||[]).includes(p.id)).length;
    return `<div class="row" style="padding:4px 0;border-top:1px solid var(--bd)"><span><b>${esc(p.name)}</b> <span class="small">${esc(p.source)} · ${n} songs${p.skipped?` · ${p.skipped} skipped`:''}</span></span>
    <span>${p.link?`<button class="s" onclick="refreshPlaylist(${i})">Refresh</button>`:''}<button class="s" onclick="removePlaylist(${i})">Remove</button></span></div>`}).join('');
}

async function loadLibrary(){
  const metas=await tx('meta','readonly',s=>s.getAll()),keys=await tx('blob','readonly',s=>s.getAllKeys()),vals=await tx('blob','readonly',s=>s.getAll());
  blobs={};keys.forEach((k,i)=>blobs[k]=vals[i]);
  allSongs=metas.filter(m=>m.yt||blobs[m.file]).map(m=>{if(m.pl&&!m.pls)m.pls=[m.pl];return m});
  renderPlaylists();
  const pool=$('pool').value,nYt=allSongs.filter(m=>m.yt).length;
  songs=allSongs.filter(m=>inPool(m,pool)).sort((a,b)=>(a.title||a.file).localeCompare(b.title||b.file)).map((m,i)=>({...m,id:i}));
  say('count',`${songs.length} songs`);
  say('libstatus',allSongs.length?`${allSongs.length} songs: ${allSongs.length-nYt} local, ${nYt} from YouTube Music. Playing from ${songs.length}.`
    :'No songs yet. Paste a playlist link above, or Import library.json plus your audio files.');
  ver++;render();
}
// a song that just finished analysing joins the library (and the running mix) without reloading everything
function addLive(m){
  const i=allSongs.findIndex(x=>x.file===m.file);if(i>=0)allSongs[i]=m;else allSongs.push(m);
  const j=songs.findIndex(x=>x.file===m.file);
  if(j>=0)Object.assign(songs[j],m,{id:songs[j].id});else if(inPool(m,$('pool').value))songs.push({...m,id:songs.length});
  say('count',`${songs.length} songs`);ver++;
}

// ---- the library file: everything (playlists + every song's analysis) in one JSON on the phone
const LIBFILE='RunDJ/rundj_library.json';
let fileT=null;
const fileSoon=()=>{clearTimeout(fileT);fileT=setTimeout(saveLibraryFile,4000)};
async function libraryJSON(){const metas=await tx('meta','readonly',s=>s.getAll());
  return JSON.stringify({version:2,app:'Run DJ',saved:new Date().toISOString(),playlists,songs:metas.map(clean)})}
async function saveLibraryFile(manual){
  const FS=native&&native.Filesystem;
  if(!FS){if(manual)say('impmsg','The library file is saved inside the Android app only.');return}
  const data=await libraryJSON();
  for(const dir of ['Documents','Data'])try{
    await FS.writeFile({path:LIBFILE,data,directory:native.Directory[dir],encoding:native.Encoding.UTF8,recursive:true});
    if(manual)say('impmsg',dir==='Documents'?`Saved to Documents/${LIBFILE.split('/')[0]}/ on this phone (open it in Files).`:'Saved in the app\'s own storage (Documents was not allowed).');
    return dir;
  }catch(e){if(dir==='Data'&&manual)say('impmsg','Could not save the library file: '+(e.message||e))}
}
async function restoreLibraryFile(){
  const FS=native&&native.Filesystem;if(!FS)return false;
  for(const dir of ['Documents','Data'])try{
    const r=await FS.readFile({path:LIBFILE,directory:native.Directory[dir],encoding:native.Encoding.UTF8});
    const metas=await importJSON(JSON.parse(r.data));await storeMetas(metas,new Set());say('impmsg','Library restored from the saved library file.');return true;
  }catch(e){}
  return false;
}

async function importJSON(d){        // library.json (local songs), yt_library.json (one playlist) or rundj_library.json (everything)
  const metas=Array.isArray(d)?d:(d.songs||[]);
  if(d.playlistId){const id='youtube:'+d.playlistId;upsertPlaylist({id,name:d.playlist||'YouTube Music playlist',source:'youtube',link:'https://music.youtube.com/playlist?list='+d.playlistId});
    metas.forEach(m=>{if(m.yt)m.pls=[id]})}
  for(const p of d.playlists||[])upsertPlaylist(p);
  return metas;
}
async function importFiles(files){
  const isJ=f=>/\.json$/i.test(f.name),audio=new Map(files.filter(f=>!isJ(f)).map(f=>[f.name,f]));let metas=[],bad=[],replace=new Set();
  for(const j of files.filter(isJ)){try{const d=JSON.parse(await j.text());const ms=await importJSON(d);if(d.playlistId)replace.add('youtube:'+d.playlistId);metas=metas.concat(ms)}catch(e){bad.push(j.name)}}
  await storeMetas(metas,replace,audio,bad);
}
async function storeMetas(metas,replace,audio=new Map(),bad=[]){
  const old=new Map(allSongs.map(s=>[s.file,s])),have=new Set(old.keys()),fileOf=new Set(metas.map(m=>m.file));
  let added=0,nyt=0;const noAudio=[];let noMeta=0;
  await tx('meta','readwrite',s=>{
    // a re-imported playlist replaces its earlier version: songs you removed from it leave it
    for(const o of allSongs)if(o.yt&&!fileOf.has(o.file)&&(o.pls||[]).some(p=>replace.has(p))){
      o.pls=o.pls.filter(p=>!replace.has(p));if(o.pls.length)s.put(clean(o));else s.delete(o.file)}
    for(const m0 of metas){const m=clean(m0);
      if(m.yt){const o=old.get(m.file);
        if(o){if(o.src==='edited')Object.assign(m,{bpm:o.bpm,src:'edited',alts:[]});if(o.eEdit)Object.assign(m,{energy:o.energy,eEdit:1});
          m.pls=[...new Set([...(o.pls||[]),...(m.pls||[])])]}
        s.put(m);added++;nyt++}
      else if(audio.has(m.file)||have.has(m.file)){s.put(m);added++}else noAudio.push(m.file)}});
  await tx('blob','readwrite',s=>{for(const [n,f] of audio){if(fileOf.has(n)||have.has(n))s.put(f,n);else noMeta++}});
  say('impmsg',`Imported ${added} songs${nyt?` (${nyt} from YouTube Music)`:''}.`+(noAudio.length?` ${noAudio.length} library entries had no matching audio file (e.g. ${noAudio[0]}).`:'')
    +(noMeta?` ${noMeta} audio files had no analysis in library.json and were skipped.`:'')+(bad.length?` Could not read: ${bad.join(', ')}.`:''));
  await loadLibrary();fileSoon();
}
async function clearLibrary(){await tx('meta','readwrite',s=>s.clear());await tx('blob','readwrite',s=>s.clear());Object.values(urls).forEach(u=>URL.revokeObjectURL(u));urls={};
  playlists=[];savePlaylists();say('impmsg','Library cleared.');await loadLibrary();saveLibraryFile()}

// ---- add a playlist from a link: analyse every song on the phone, save as it goes, start playing early
let analysing=false,cancelReq=false;
async function addPlaylist(link){
  const A=window.RunDJAnalyzer;
  if(analysing){cancelReq=true;say('pstatus','Stopping after this song…');return}
  if(!A){say('pstatus','The analyser is missing from this build.');return}
  const p=A.parseLink(link);if(!p){say('pstatus',"That isn't a YouTube Music, Spotify or Apple Music playlist link.");return}
  if(!native)say('pstatus','Note: outside the Android app most sites block these requests.');
  analysing=true;cancelReq=false;$('padd').textContent='Stop';
  const known=new Map();for(const m of allSongs)if(m.yt&&m.bpm){known.set(m.yt,m);known.set(A.songKey(m.title,m.artist),m)}
  let plId=null,ready=0;const seen=new Set();
  try{
    const res=await A.analyzePlaylist(link,{country:($('country').value||'IN').toUpperCase(),spotify:{id:$('spid').value.trim(),secret:$('spsec').value.trim()},known,cancelled:()=>cancelReq},{
      progress:t=>say('pstatus',t),
      playlist:info=>{plId=info.id;upsertPlaylist({id:info.id,name:info.name,source:info.source,link});renderPlaylists();log(`➕ ${info.name}: ${info.total} songs to check`)},
      song:async(meta,id)=>{
        const o=allSongs.find(x=>x.file===meta.file)||{};
        const m=clean({...o,...meta,pls:[...new Set([...(o.pls||[]),...(meta.pls||[]),id])]});
        if(o.src==='edited')Object.assign(m,{bpm:o.bpm,src:'edited',alts:[]});
        if(o.eEdit)Object.assign(m,{energy:o.energy,eEdit:1});
        await tx('meta','readwrite',s=>s.put(m));seen.add(m.file);addLive(m);ready++;
        if(ready%10===0){const ch=A.rankEnergy(allSongs);if(ch.length)await tx('meta','readwrite',s=>ch.forEach(x=>s.put(clean(x))));ch.forEach(addLive)}
        if(ready===3&&$('autostart').checked&&!timer){log('▶ first songs are ready, starting');$('go').click()}
        render();
      }});
    if(!cancelReq&&plId){     // songs no longer in this playlist leave it
      const gone=allSongs.filter(m=>(m.pls||[]).includes(plId)&&!seen.has(m.file));
      if(gone.length)await tx('meta','readwrite',s=>gone.forEach(m=>{m.pls=m.pls.filter(x=>x!==plId);if(m.pls.length||!m.yt)s.put(clean(m));else s.delete(m.file)}));
    }
    const ch=A.rankEnergy(allSongs);if(ch.length)await tx('meta','readwrite',s=>ch.forEach(x=>s.put(clean(x))));
    upsertPlaylist({id:res.id,name:res.name,skipped:res.skipped.length,skippedList:res.skipped.slice(0,50)});
    const chk=allSongs.filter(m=>(m.pls||[]).includes(res.id)&&m.src==='check').length;
    say('pstatus',`${res.name}: ${res.added} analysed, ${res.reused} already known, ${res.skipped.length} skipped${chk?`, ${chk} marked "check" (tap the beat while they play)`:''}${cancelReq?' (stopped early)':''}.`);
    res.skipped.slice(0,20).forEach(([t,why])=>log(`⤼ skipped ${t}: ${why}`));
    await loadLibrary();await saveLibraryFile();
  }catch(e){say('pstatus','Could not add the playlist: '+(e.message||e))}
  finally{analysing=false;cancelReq=false;$('padd').textContent='Add'}
}
async function refreshPlaylist(i){const p=playlists[i];if(p&&p.link){$('plink').value=p.link;await addPlaylist(p.link)}}
async function removePlaylist(i){
  const p=playlists[i];if(!p||!confirm(`Remove “${p.name}”? Songs that are only in this playlist are removed too.`))return;
  const mine=allSongs.filter(m=>(m.pls||[]).includes(p.id));
  await tx('meta','readwrite',s=>mine.forEach(m=>{m.pls=m.pls.filter(x=>x!==p.id);if(m.pls.length||!m.yt)s.put(clean(m));else s.delete(m.file)}));
  playlists.splice(i,1);savePlaylists();await loadLibrary();fileSoon();
}

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
const SAVED=['country','spid','spsec','autostart','bpm','tol','min','mar','spread','xf','ew','htpen','conf','wait','swap','hcwin','hcstale','hcpoll','mmin','pedwin','rotate','hold','push','pushmax','half','alt'];
function saveSettings(){try{const o={};SAVED.forEach(id=>{const e=$(id);o[id]=e.type==='checkbox'?e.checked:e.value});localStorage.setItem('rundj_settings',JSON.stringify(o))}catch(e){}}
function loadSettings(){try{const o=JSON.parse(localStorage.getItem('rundj_settings')||'{}');SAVED.forEach(id=>{if(id in o){const e=$(id);e.type==='checkbox'?e.checked=o[id]:e.value=o[id]}})}catch(e){}}

SRCS.forEach(k=>$('src_'+k).onclick=()=>setSrc(k));
$('hcconnect').onclick=hcConnect;$('hctest').onclick=hcTest;
$('imp').onclick=()=>$('file').click();
$('padd').onclick=()=>addPlaylist($('plink').value);
$('plink').addEventListener('keydown',e=>{if(e.key==='Enter')addPlaylist($('plink').value)});
$('savelib').onclick=()=>saveLibraryFile(true);
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
// ---- background mode (Android): a native service reads your pace and drives the YouTube Music app
const BG=native&&native.Background;let bgOn=false,bgState=null;
async function bgRefresh(){
  if(!BG){return}
  let s;try{s=await BG.status()}catch(e){return}      // plugin missing in this build
  $('bgbox').style.display='block';bgState=s;bgOn=!!s.running;
  const need=[];
  if(!s.youtubeMusic)need.push('install the YouTube Music app');
  if(!s.activity)need.push('allow Physical activity');
  if(!s.notifications)need.push('allow notifications');
  if(!s.notificationAccess)need.push('turn on Notification access for Run DJ (lets it control YouTube Music)');
  if(!s.overlay)need.push('allow "Display over other apps" (lets songs change while the screen is locked)');
  say('bgneeds',need.length?'To do: '+need.join(' · ')+'. Tap Set up.':'Ready. Tip: set Run DJ\'s battery use to "Unrestricted" so Android doesn\'t stop it.');
  $('bgstart').style.display=bgOn?'none':'inline-block';$('bgstop').style.display=bgOn?'inline-block':'none';
  $('go').disabled=bgOn;
}
async function bgSetup(){
  const s=bgState||await BG.status();
  if(!s.activity||!s.notifications){await BG.askPermissions();return bgRefresh()}
  if(!s.notificationAccess){say('bgneeds','Find Run DJ in the list, switch it on, then come back here.');return BG.openNotificationAccess()}
  if(!s.overlay){say('bgneeds','Switch on "Allow display over other apps" for Run DJ, then come back.');return BG.openOverlaySettings()}
  say('bgneeds','Optional: find Run DJ under "All apps" and choose "Don\'t optimize" / Unrestricted.');return BG.openBatterySettings();
}
async function bgStart(){
  await bgRefresh();
  const s=bgState;
  if(!s.youtubeMusic||!s.notificationAccess||!s.activity){say('bgstatus','Finish the set-up first (tap Set up).');return}
  const list=songs.filter(x=>x.yt&&x.bpm&&!x.bad).map(x=>({yt:x.yt,title:x.title,artist:x.artist,dur:x.dur,bpm:x.bpm,energy:x.energy,alts:x.alts||[],bars:x.bars||null,first_bar:x.first_bar==null?null:x.first_bar,src:x.src}));
  if(!list.length){say('bgstatus','No YouTube Music songs in "Play from". Add a playlist first.');return}
  const st=S();
  if(timer)$('go').click();                       // the in-app player stops: YouTube Music plays from now on
  try{
    await BG.start({library:JSON.stringify({songs:list,settings:{...st,minStd:+$('mmin').value||0.5,source:src==='ped'?'ped':'motion',dip:true}})});
    log(`🌙 background mode: ${list.length} songs through YouTube Music, pace from ${src==='ped'?'the step counter':'phone motion'}. You can close the app now.`);
  }catch(e){say('bgstatus','Could not start: '+(e.message||e))}
  bgRefresh();
}
if(BG){
  BG.addListener('state',o=>{
    if(o.logLine){log('🌙 '+o.logLine);return}
    if(o.running===false){say('bgstatus','Background mode stopped.');bgRefresh();return}
    say('bgstatus',`${o.cadence<0?'reading pace…':Math.round(o.cadence)+' steps/min'} · ${o.song||'—'}${o.status?' · '+o.status:''}`);
    if(!bgOn)bgRefresh();
  });
  $('bgstart').onclick=bgStart;$('bgstop').onclick=async()=>{await BG.stop();setTimeout(bgRefresh,500)};$('bgsetup').onclick=bgSetup;
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)bgRefresh()});
}
async function initApp(){
  loadSettings();loadPlaylists();renderPlaylists();try{const p=localStorage.getItem('rundj_pool');if(p)$('pool').value=p}catch(e){}render();
  await loadLibrary();
  if(!allSongs.length)await restoreLibraryFile();     // e.g. after reinstalling the app
  const want=(()=>{try{return localStorage.getItem('rundj_src')}catch(e){return null}})();
  if(want==='hc')await hcCheck();
  setSrc(SRCS.includes(want)?want:'manual');
  bgRefresh();
}
