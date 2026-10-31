// P3.0 spike card (iPhone only): can the app play an Apple Music song by store ID, seek in it, and keep working with the
// screen locked? Shown at the bottom of the page above the event log. Delete this file and its build_phone.py line once P3 is done.
(function spikeAppleMusic(){
  const N=window.RunDJNative, AM=N&&N.AppleMusic;
  if(!N||!N.isNative||N.platform!=='ios'||!AM)return;
  const host=document.getElementById('log'); if(!host)return;
  const card=document.createElement('section');card.className='card';
  card.innerHTML=`<div class="lbl">Apple Music spike (P3.0 test)</div>
  <div class="small">Needs an Apple Music subscription on this iPhone. Run the steps in order and send me the report at the bottom.</div>
  <div class="row" style="justify-content:flex-start;margin-top:8px"><button id="sp_auth">1 · Authorize</button></div>
  <div class="row" style="justify-content:flex-start;margin-top:8px"><input type="text" id="sp_term" value="Skyfall Adele" style="flex:1"><button id="sp_find">2 · Find</button></div>
  <div class="row" style="justify-content:flex-start;margin-top:8px"><button id="sp_play">3 · Play, seek to 1:00 after 3 s</button></div>
  <div class="row" style="justify-content:flex-start;margin-top:8px"><button id="sp_pause">Pause</button><button id="sp_resume">Resume</button><button id="sp_stop">Stop</button></div>
  <div class="small" style="margin-top:10px">Keep the app alive with the screen locked:</div>
  <div class="row" style="justify-content:flex-start;margin-top:4px"><select id="sp_mode"><option value="off">Off</option><option value="location">Location</option><option value="audio">Silent audio</option></select><button id="sp_apply">4 · Apply</button><button id="sp_sched">5 · Locked test</button></div>
  <div class="small" id="sp_live" style="margin-top:8px;font-family:monospace;white-space:pre-wrap"></div>
  <div class="row" style="justify-content:flex-start;margin-top:8px"><button id="sp_report" class="p">Share report</button></div>
  <div class="small" id="sp_log" style="margin-top:8px;font-family:monospace;white-space:pre-wrap;max-height:260px;overflow:auto"></div>`;
  host.parentElement.parentElement.insertBefore(card,host.parentElement);
  const $s=id=>document.getElementById(id), lines=[], t0=Date.now();
  const stamp=()=>((Date.now()-t0)/1000).toFixed(1).padStart(6)+'s';
  const say=m=>{lines.push(stamp()+'  '+m);$s('sp_log').textContent=lines.slice(-60).join('\n');$s('sp_log').scrollTop=1e9};
  const j=o=>JSON.stringify(o);
  const guard=(name,f)=>async()=>{try{say(name+' …');await f()}catch(e){say(name+' FAILED: '+(e&&e.message||j(e)))}};
  let storeId='', ticks=0, lastTick=Date.now(), maxGap=0, events=0, last=null;
  setInterval(()=>{const now=Date.now();ticks++;maxGap=Math.max(maxGap,now-lastTick);lastTick=now},1000);   // JS heartbeat: gaps mean the web view was frozen
  AM.addListener('state',s=>{events++;last=s;say(`state ${s.playback} ${s.time.toFixed(1)}s "${s.title}"`)});
  async function live(){try{const s=await AM.status(),p=await AM.state();
    $s('sp_live').textContent=`music: ${p.playback} ${p.time.toFixed(1)}s of ${p.duration.toFixed(0)}s  ${p.title?'"'+p.title+'"':''}\nJS ticks ${ticks} (longest gap ${(maxGap/1000).toFixed(1)}s) · native ticks ${s.nativeBeats}\nkeep-alive ${s.mode} · location fixes ${s.locationFixes} (${s.locationAuth}) ${s.locationError}\nsilent audio ${s.audioPlaying?'playing':'no'} ${s.audioError} · modes ${s.backgroundModes.join(',')}`}catch(e){}}
  setInterval(live,1000);

  $s('sp_auth').onclick=guard('authorize',async()=>{const r=await AM.authorize();say('authorize → '+j(r))});
  $s('sp_find').onclick=guard('find',async()=>{const r=await AM.findStoreId({term:$s('sp_term').value,country:'IN'});storeId=r.storeId;say(`found ${r.storeId} · ${r.artist} – ${r.title} (${r.durationSec.toFixed(0)}s)`)});
  $s('sp_play').onclick=guard('play',async()=>{
    if(!storeId)throw new Error('press Find first');
    const r=await AM.play({storeId});say('playing → '+j(r));
    setTimeout(async()=>{try{await AM.seek({sec:60});await new Promise(k=>setTimeout(k,2500));const p=await AM.state();
      say(`SEEK ${p.time>=60&&p.time<75?'WORKED':'DID NOT WORK'}: asked 60.0s, now ${p.time.toFixed(1)}s (${p.playback})`)}catch(e){say('seek FAILED: '+(e.message||j(e)))}},3000)});
  $s('sp_pause').onclick=guard('pause',async()=>say('pause → '+(await AM.pause()).playback));
  $s('sp_resume').onclick=guard('resume',async()=>say('resume → '+(await AM.resume()).playback));
  $s('sp_stop').onclick=guard('stop',async()=>say('stop → '+(await AM.stop()).playback));
  $s('sp_apply').onclick=guard('keep-alive',async()=>{const r=await AM.keepAlive({mode:$s('sp_mode').value});say('keep-alive → '+j(r));
    if($s('sp_mode').value==='location')say('if iOS asks for location, choose "Allow While Using App"')});
  // Locked test: every 20 s our own JS timer seeks the song to a new place. Lock the phone right after pressing it, unlock after ~2 minutes.
  let sched=null;
  $s('sp_sched').onclick=guard('locked test',async()=>{
    if(sched){clearInterval(sched);sched=null;say('locked test stopped');return}
    if(!storeId)throw new Error('press Find and Play first');
    let n=0;say('locked test started: JS seeks the song every 20 s. Lock the phone now, unlock after 2 minutes.');
    sched=setInterval(async()=>{n++;const want=30+n*15;try{await AM.seek({sec:want});say(`JS timer #${n} fired (on time? see timestamps): seek to ${want}s`)}catch(e){say('JS timer seek failed: '+(e.message||j(e)))}},20000)});
  $s('sp_report').onclick=guard('share',async()=>{
    const s=await AM.status(),p=await AM.state();
    const text=`RunDJ Apple Music spike\niOS ${navigator.userAgent}\nkeep-alive: ${s.mode} · modes ${s.backgroundModes.join(',')}\nJS ticks ${ticks}, longest gap ${(maxGap/1000).toFixed(1)}s, native ticks ${s.nativeBeats}, location fixes ${s.locationFixes} (${s.locationAuth}) ${s.locationError}, silent audio ${s.audioPlaying} ${s.audioError}\nnow: ${j(p)}\nstate events ${events}\n\n`+lines.join('\n');
    try{await N.Share.share({title:'Apple Music spike report',text})}catch(e){try{await navigator.clipboard.writeText(text);say('report copied to clipboard')}catch(_){say(text)}}});
})();
