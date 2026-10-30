// ======================= YouTube decks =======================
// A Deck looks like an <audio> element to the engine (src, currentTime, duration, ended, volume, play, pause,
// 'loadedmetadata'), so the engine's crossfades, entry points and swaps work unchanged.
// src 'yt:<videoId>' plays in an embedded YouTube player; anything else plays in a normal <audio>.
// iPhone/iPad: web pages can't set an <audio> element's volume, and YouTube's embedded player ignores setVolume/mute.
// So on iOS local files fade through Web Audio (a gain node per deck), and YouTube songs switch with a clean cut.
const IOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
let ACX=null;
let ytApi=null;
const ytLoad=()=>ytApi||(ytApi=new Promise((res,rej)=>{
  if(window.YT&&window.YT.Player)return res();
  window.onYouTubeIframeAPIReady=()=>res();
  const s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';
  s.onerror=()=>{ytApi=null;rej(new Error('could not load the YouTube player (offline?)'))};document.head.appendChild(s);
}));
const YT_ERR={2:'bad video id',5:'player error',100:'video removed or private',101:'embedding disabled by the owner',150:'embedding disabled by the owner',152:'player configuration error',153:'player configuration error'};
let ytTop=1;
class Deck{
  constructor(n){
    this.au=new Audio();this.n=n;this.mode='audio';this.vid=null;this.p=null;this.pReady=null;
    this._vol=1;this._start=0;this._want=false;this._ended=false;this._state=-1;this._loaded=null;this._t=0;this._tAt=0;this._last=-1;
    this.onerror=null;
  }
  _box(){   // both players share one 16:9 box; the one playing is on top
    let el=document.getElementById('ytdeck'+this.n);
    if(!el){el=document.createElement('div');el.id='ytdeck'+this.n;el.className='ytdeck';document.getElementById('ytbox').appendChild(el)}
    return el;
  }
  _player(){
    if(this.pReady)return this.pReady;
    return this.pReady=ytLoad().then(()=>new Promise(res=>{
      const holder=document.createElement('div');this._box().appendChild(holder);
      this.p=new YT.Player(holder,{width:'100%',height:'100%',
        playerVars:{playsinline:1,controls:0,disablekb:1,rel:0,fs:0,iv_load_policy:3,origin:location.origin},
        events:{onReady:()=>res(this.p),onStateChange:e=>this._onState(e.data),onError:e=>this._onError(e.data)}});
    })).catch(e=>{this.pReady=null;this._ended=true;log('⚠ '+e.message);throw e});
  }
  _onState(s){
    this._state=s;
    if(this.mode!=='yt')return;
    if(s===1&&!this._want){                    // pre-buffering: got going, now park it at the entry point
      this.p.pauseVideo();this.p.seekTo(this._start,true);
    }else if(s===0)this._ended=true;
  }
  _onError(code){
    if(this.mode!=='yt')return;
    this._ended=true;this._want=false;
    if(this.onerror)this.onerror(this,this.vid,code,YT_ERR[code]||('error '+code));
  }
  get src(){return this.mode==='yt'?'yt:'+this.vid:this.au.src}
  set src(v){
    if(typeof v==='string'&&v.startsWith('yt:')){
      this.au.pause();this.mode='yt';this.vid=v.slice(3);this._start=0;this._t=0;this._tAt=performance.now();this._last=-1;
      this._want=false;this._ended=false;
      if(this.p&&this._loaded&&this._loaded!==this.vid)this.p.pauseVideo();
    }else{
      if(this.mode==='yt'){this._want=false;if(this.p)this.p.pauseVideo()}
      this.mode='audio';this.au.src=v;
    }
  }
  set preload(v){
    this.au.preload=v;
    if(this.mode==='yt'&&v==='auto'&&!IOS)setTimeout(()=>this._prebuffer(),0);   // after the engine sets the entry point (iOS: muting doesn't work there, so no silent pre-buffering)
  }
  get preload(){return this.au.preload}
  async _prebuffer(){
    if(this.mode!=='yt'||this._want)return;
    const vid=this.vid;let p;try{p=await this._player()}catch(e){return}
    if(this.mode!=='yt'||this._want||this.vid!==vid)return;
    p.mute();this._loaded=vid;p.loadVideoById({videoId:vid,startSeconds:this._start});
  }
  addEventListener(ev,fn,opt){
    if(this.mode==='yt'&&ev==='loadedmetadata')return fn();   // the engine only uses this to set the entry point
    this.au.addEventListener(ev,fn,opt);
  }
  get currentTime(){
    if(this.mode!=='yt')return this.au.currentTime;
    if(!this.p||this._loaded!==this.vid||!this.p.getCurrentTime)return this._start;
    const t=this.p.getCurrentTime()||0,now=performance.now();
    if(t!==this._last){this._last=t;this._t=t;this._tAt=now}
    return this._state===1?this._t+Math.min(1,(now-this._tAt)/1000):this._t;   // the player reports ~4×/s; fill the gaps
  }
  set currentTime(v){
    if(this.mode!=='yt'){this.au.currentTime=v;return}
    this._start=v;this._t=v;this._tAt=performance.now();
    if(this.p&&this._loaded===this.vid)this.p.seekTo(v,true);
  }
  get duration(){
    if(this.mode!=='yt')return this.au.duration;
    return this.p&&this._loaded===this.vid&&this.p.getDuration?(this.p.getDuration()||0):0;
  }
  get ended(){return this.mode==='yt'?this._ended:this.au.ended}
  get volume(){return this.mode==='yt'||this.gain?this._vol:this.au.volume}
  set volume(v){
    this._vol=v;
    if(this.mode!=='yt'){if(this.gain)this.gain.gain.value=v;else this.au.volume=v;return}
    if(this.p&&this.p.setVolume)this.p.setVolume(Math.round(v*100));
  }
  play(){
    if(this.mode!=='yt'){
      if(this.p)try{this.p.pauseVideo()}catch(e){}
      if(IOS&&!this.gain)try{               // first play happens inside the Start tap, which iOS needs to allow audio
        ACX=ACX||new (window.AudioContext||window.webkitAudioContext)();
        const src=ACX.createMediaElementSource(this.au);this.gain=ACX.createGain();this.gain.gain.value=this._vol;
        src.connect(this.gain).connect(ACX.destination);this.au.volume=1;
      }catch(e){this.gain=null}
      if(ACX&&ACX.state==='suspended')ACX.resume().catch(()=>{});
      return this.au.play()}
    this._want=true;this._ended=false;const vid=this.vid;
    this._box().style.zIndex=++ytTop;document.getElementById('ytbox').style.display='block';
    this._player().then(p=>{
      if(!this._want||this.vid!==vid)return;
      p.setVolume(Math.round(this._vol*100));p.unMute();
      if(this._loaded===vid){if(Math.abs((p.getCurrentTime()||0)-this._start)>1.5&&this._state!==1)p.seekTo(this._start,true);p.playVideo()}
      else{this._loaded=vid;p.loadVideoById({videoId:vid,startSeconds:this._start})}
    }).catch(()=>{});
    return Promise.resolve();
  }
  pause(){
    this.au.pause();
    if(this.mode==='yt'){this._want=false;if(this.p&&this.p.pauseVideo)this.p.pauseVideo()}
  }
}
