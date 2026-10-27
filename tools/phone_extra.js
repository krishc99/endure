// ======================= phone-only additions =======================
const native=window.RunDJNative&&window.RunDJNative.isNative?window.RunDJNative:null;
const keepAwake=on=>{try{if(native)on?native.KeepAwake.keepAwake():native.KeepAwake.allowSleep()}catch(e){}};
let src='manual',hcCad=null,hcOk=false,hcTimer=null;

// ---- storage: songs live in IndexedDB so they survive app restarts
let db=null,blobs={},urls={};
const idb=()=>db?Promise.resolve(db):new Promise((res,rej)=>{const r=indexedDB.open('rundj',1);
  r.onupgradeneeded=()=>{r.result.createObjectStore('meta',{keyPath:'file'});r.result.createObjectStore('blob')};
  r.onsuccess=()=>res(db=r.result);r.onerror=()=>rej(r.error)});
const tx=(name,mode,fn)=>idb().then(d=>new Promise((res,rej)=>{
  const t=d.transaction(name,mode);let out;
  t.oncomplete=()=>res(out&&typeof out==='object'&&'result' in out?out.result:out);t.onerror=t.onabort=()=>rej(t.error);
  out=fn(t.objectStore(name))}));
const srcFor=s=>urls[s.file]||(urls[s.file]=URL.createObjectURL(blobs[s.file]));
const saveMeta=s=>{const {id,_hr,...m}=s;return tx('meta','readwrite',st=>st.put(m))};
const post=(p,o)=>saveMeta(songs[o.id]);                      // ½ / ×2 / energy edits persist on the phone
const say=(id,t)=>{$(id).textContent=t};

async function loadLibrary(){
  const metas=await tx('meta','readonly',s=>s.getAll()),keys=await tx('blob','readonly',s=>s.getAllKeys()),vals=await tx('blob','readonly',s=>s.getAll());
  blobs={};keys.forEach((k,i)=>blobs[k]=vals[i]);
  songs=metas.filter(m=>blobs[m.file]).sort((a,b)=>a.file.localeCompare(b.file)).map((m,i)=>({...m,id:i}));
  say('count',`${songs.length} songs`);
  say('libstatus',songs.length?`${songs.length} songs ready.`:'No songs yet. Tap Import and select library.json plus your audio files together.');
  ver++;render();
}
async function importFiles(files){
  const isJ=f=>/\.json$/i.test(f.name),audio=new Map(files.filter(f=>!isJ(f)).map(f=>[f.name,f]));let metas=[],bad=[];
  for(const j of files.filter(isJ)){try{const d=JSON.parse(await j.text());metas=metas.concat(Array.isArray(d)?d:(d.songs||[]))}catch(e){bad.push(j.name)}}
  const have=new Set(songs.map(s=>s.file)),fileOf=new Set(metas.map(m=>m.file));
  let added=0;const noAudio=[];let noMeta=0;
  await tx('meta','readwrite',s=>{for(const m of metas){if(audio.has(m.file)||have.has(m.file)){s.put(m);added++}else noAudio.push(m.file)}});
  await tx('blob','readwrite',s=>{for(const [n,f] of audio){if(fileOf.has(n)||have.has(n))s.put(f,n);else noMeta++}});
  say('impmsg',`Imported ${added} songs.`+(noAudio.length?` ${noAudio.length} library entries had no matching audio file (e.g. ${noAudio[0]}).`:'')
    +(noMeta?` ${noMeta} audio files had no analysis in library.json and were skipped.`:'')+(bad.length?` Could not read: ${bad.join(', ')}.`:''));
  await loadLibrary();
}
async function clearLibrary(){await tx('meta','readwrite',s=>s.clear());await tx('blob','readwrite',s=>s.clear());Object.values(urls).forEach(u=>URL.revokeObjectURL(u));urls={};say('impmsg','Library cleared.');await loadLibrary()}

// ---- cadence source: manual slider, or steps from Health Connect
const cadence=()=>src==='hc'?(hcCad==null?0:hcCad):+$('bpm').value;
function setSrc(v){
  src=v;$('src_manual').classList.toggle('p',v==='manual');$('src_hc').classList.toggle('p',v==='hc');
  $('bpm').disabled=v==='hc';$('hcbox').style.display=v==='hc'?'block':'none';
  try{localStorage.setItem('rundj_src',v)}catch(e){}
  v==='hc'?hcStart():hcStop();render();
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
const SAVED=['bpm','tol','min','mar','spread','xf','ew','htpen','conf','wait','swap','hcwin','hcstale','hcpoll','rotate','half','alt'];
function saveSettings(){try{const o={};SAVED.forEach(id=>{const e=$(id);o[id]=e.type==='checkbox'?e.checked:e.value});localStorage.setItem('rundj_settings',JSON.stringify(o))}catch(e){}}
function loadSettings(){try{const o=JSON.parse(localStorage.getItem('rundj_settings')||'{}');SAVED.forEach(id=>{if(id in o){const e=$(id);e.type==='checkbox'?e.checked=o[id]:e.value=o[id]}})}catch(e){}}

$('src_manual').onclick=()=>setSrc('manual');$('src_hc').onclick=()=>setSrc('hc');
$('hcconnect').onclick=hcConnect;$('hctest').onclick=hcTest;
$('imp').onclick=()=>$('file').click();$('file').onchange=async e=>{const f=[...e.target.files];e.target.value='';await importFiles(f)};
$('clearlib').onclick=()=>{if(confirm('Remove all imported songs from this phone?'))clearLibrary()};
SAVED.forEach(id=>{$(id).addEventListener('change',saveSettings);$(id).addEventListener('input',saveSettings)});
async function initApp(){
  loadSettings();render();
  await loadLibrary();
  const want=(()=>{try{return localStorage.getItem('rundj_src')}catch(e){return null}})();
  if(want==='hc'){await hcCheck();setSrc('hc')}else setSrc('manual');
}
