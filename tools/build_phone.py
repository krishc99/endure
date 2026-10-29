#!/usr/bin/env python3
"""Generate www/index.html (the phone UI) from dj_live.py's page, so the engine has ONE source of truth.
Run after changing tools/dj_live.py:   python3 tools/build_phone.py"""
import importlib.util, sys
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("dj_live", HERE / "dj_live.py")
dj = importlib.util.module_from_spec(spec); sys.modules["dj_live"] = dj; spec.loader.exec_module(dj)
P = dj.PAGE


def rep(old, new, count=1):
    global P
    n = P.count(old)
    if n < 1 or (count and n != count):
        sys.exit(f"build_phone: expected {count} match(es), found {n} for: {old[:70]!r}")
    P = P.replace(old, new)


rep("<title>Run DJ live</title>", "<title>Run DJ</title>")
rep("🏃 Run DJ live", "🏃 Run DJ")
rep("</style>", """.seg button{flex:1}button:disabled,input:disabled{opacity:.5}
</style>""")
# --- cadence card: source switch + Health Connect box
a = P.index('<section class="card">\n  <div class="lbl">Cadence')
b = P.index('<section class="card">\n  <div class="lbl">Now playing')
P = P[:a] + """<section class="card">
  <div class="lbl">Cadence source</div>
  <div class="row seg"><button id="src_manual" class="p">Manual</button><button id="src_motion">Phone motion</button><button id="src_ped">Step counter</button><button id="src_hc">Health Connect</button></div>
  <div class="row" style="margin-top:10px"><span class="big" id="bpmv">150</span><span class="small" id="cadsub">steps / BPM · manual</span></div>
  <input type="range" id="bpm" min="60" max="190" value="150">
  <div id="livebox" style="display:none;margin-top:8px"><div class="small" id="livestatus">—</div></div>
  <div id="hcbox" style="display:none;margin-top:8px">
    <div class="row" style="justify-content:flex-start"><button id="hcconnect">Connect</button><button id="hctest">Test read</button></div>
    <div class="small" id="hcstatus" style="margin-top:6px">Not connected.</div>
  </div>
  <div style="margin-top:10px"><button class="p" id="go">▶ Start</button></div>
  <div id="bgbox" style="display:none;margin-top:12px;border-top:1px solid var(--bd);padding-top:10px">
    <div class="lbl">Background mode · app closed, screen off</div>
    <div class="small">Plays through the YouTube Music app (needs Premium) and keeps reading your pace from phone motion (or the step counter) with the screen locked. Songs switch with a short volume dip instead of a crossfade.</div>
    <div class="row" style="justify-content:flex-start;margin-top:8px"><button id="bgstart" class="p">Start in background</button><button id="bgstop" style="display:none">Stop background</button><button id="bgsetup">Set up</button></div>
    <div class="small" id="bgneeds" style="margin-top:6px"></div>
    <div class="small" id="bgstatus" style="margin-top:4px"></div>
  </div>
</section>
<section class="card"><div class="lbl">Library</div>
  <div class="small" id="libstatus" style="margin:4px 0">Loading…</div>
  <div class="row" style="flex-wrap:nowrap"><input id="plink" type="url" placeholder="Paste a YouTube Music, Spotify or Apple Music playlist link" style="flex:1;min-width:0"><button id="padd" class="p">Add</button></div>
  <label class="small" style="display:flex;gap:6px;align-items:center;margin:6px 0"><input type="checkbox" id="autostart" checked> Start playing as soon as the first songs are ready</label>
  <div class="small" id="pstatus"></div>
  <div id="plists" style="margin:8px 0"></div>
  <div class="row" style="justify-content:flex-start"><button id="imp">Import songs…</button><button id="savelib">Save library file</button><button id="clearlib">Clear</button></div>
  <input type="file" id="file" multiple accept=".json,application/json,audio/*" style="display:none">
  <div class="small" id="impmsg" style="margin-top:6px"></div></section>
""" + P[b:]
rep('<label>Max wait for good exit (s)<input type="number" id="wait" value="20"></label>',
    '''<label>Max wait for good exit (s)<input type="number" id="wait" value="20"></label>
  <label>Step window (s)<input type="number" id="hcwin" value="120"></label>
  <label>Treat data as stopped after (s)<input type="number" id="hcstale" value="240"></label>
  <label>Health Connect poll (s)<input type="number" id="hcpoll" value="10"></label>
  <label>Motion sensitivity (m/s²)<input type="number" id="mmin" value="0.5" step="0.1"></label>
  <label>Step counter window (s)<input type="number" id="pedwin" value="10"></label>
  <label>iTunes store country<input type="text" id="country" value="IN" maxlength="2"></label>
  <label>Spotify client ID<input type="text" id="spid" placeholder="for Spotify links"></label>
  <label>Spotify client secret<input type="password" id="spsec"></label>''')
rep('<script>\nconst $=', '<script src="bridge.js"></script>\n<script>\nconst $=')
# --- audio comes from blobs stored on the phone; cadence from the chosen source
rep("n.src='/song/'+x.s.id;", "n.src=srcFor(x.s);", 2)
rep("+$('bpm').value", "cadence()", 2)
rep("$('bpmv').textContent=b;", "$('bpmv').textContent=Math.round(b);$('cadsub').textContent=src==='hc'?'steps / min · Health Connect':'steps / BPM · manual';")
rep("const post=(p,o)=>fetch(p,{method:'POST',body:JSON.stringify(o)});", "")
rep("setInterval(draw,100);\nfetch('/api/songs').then(r=>r.json()).then(d=>{songs=d;$('count').textContent=`${d.length} songs loaded`;render()});",
    "setInterval(draw,100);\n" + (HERE / "motion.js").read_text() + (HERE / "phone_extra.js").read_text() + "\ninitApp();")
rep("plan=null;disarm();$('go').textContent='▶ Start';", "plan=null;disarm();keepAwake(false);$('go').textContent='▶ Start';")
rep("$('go').textContent='⏹ Stop';log('— started —');", "$('go').textContent='⏹ Stop';keepAwake(true);log('— started —');")
rep("t.energy=Math.min(1,Math.max(0,+v||0));", "t.energy=Math.min(1,Math.max(0,+v||0));t.eEdit=1;")
rep("button,input[type=number]{", "button,input[type=number],input[type=text],input[type=url],input[type=password]{")
rep(".set input[type=number]{width:100%}", ".set input[type=number],.set input[type=text],.set input[type=password]{width:100%}")
# --- YouTube Music songs: both decks can play an embedded YouTube player as well as local audio (see ytdeck.js)
rep("const AU=[new Audio(),new Audio()];", (HERE / "ytdeck.js").read_text() + "const AU=[new Deck(0),new Deck(1)];")
rep("</style>", """#ytbox{display:none;position:relative;width:100%;aspect-ratio:16/9;margin-top:10px;border-radius:8px;overflow:hidden;background:#000}
.ytdeck{position:absolute;inset:0}.ytdeck iframe{width:100%;height:100%;border:0}
</style>""")
rep('<div class="np" id="np">Press Start</div><div class="small" id="sub"></div>',
    '<div class="np" id="np">Press Start</div><div class="small" id="sub"></div><div id="ytbox"></div>'
    '<div class="row" style="margin-top:8px;justify-content:flex-start"><button id="tap">Tap the beat</button>'
    '<span class="small" id="tapv">Wrong BPM? Tap along 8+ times, then save.</span><button id="tapsave" class="p" style="display:none">Save</button></div>')
rep("function match(s,c){\n  const st=S();", "function match(s,c){\n  if(s.bad)return null;\n  const st=S();")
rep("$('fill').style.width=", "$('ytbox').style.display=cur&&cur.yt?'block':'none';\n  $('fill').style.width=")
rep('<div class="row" style="justify-content:flex-start"><button id="imp">Import songs…</button>',
    """<label class="small" style="display:flex;gap:6px;align-items:center;margin-bottom:8px">Play from
    <select id="pool"><option value="all">All songs</option><option value="yt">YouTube Music only</option><option value="local">Local files only</option></select></label>
  <div class="row" style="justify-content:flex-start"><button id="imp">Import songs…</button>""")
rep('<div class="small" id="impmsg" style="margin-top:6px"></div></section>',
    '<div class="small" id="impmsg" style="margin-top:6px"></div>'
    '<div class="small" style="margin-top:6px">BPM data from <a href="https://www.deezer.com" target="_blank" rel="noopener">Deezer</a>, Apple iTunes previews and <a href="https://getsongbpm.com" target="_blank" rel="noopener">GetSongBPM</a></div></section>')
out = HERE.parent / "www" / "index.html"
out.write_text(P)
print(f"wrote {out} ({len(P)//1024} KB)")
