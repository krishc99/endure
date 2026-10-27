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
  <div class="row seg"><button id="src_manual" class="p">Manual</button><button id="src_hc">Health Connect</button></div>
  <div class="row" style="margin-top:10px"><span class="big" id="bpmv">150</span><span class="small" id="cadsub">steps / BPM · manual</span></div>
  <input type="range" id="bpm" min="60" max="190" value="150">
  <div id="hcbox" style="display:none;margin-top:8px">
    <div class="row" style="justify-content:flex-start"><button id="hcconnect">Connect</button><button id="hctest">Test read</button></div>
    <div class="small" id="hcstatus" style="margin-top:6px">Not connected.</div>
  </div>
  <div style="margin-top:10px"><button class="p" id="go">▶ Start</button></div>
</section>
<section class="card"><div class="lbl">Library</div>
  <div class="small" id="libstatus" style="margin:4px 0">Loading…</div>
  <div class="row" style="justify-content:flex-start"><button id="imp">Import songs…</button><button id="clearlib">Clear</button></div>
  <input type="file" id="file" multiple accept=".json,application/json,audio/*" style="display:none">
  <div class="small" id="impmsg" style="margin-top:6px"></div></section>
""" + P[b:]
rep('<label>Max wait for good exit (s)<input type="number" id="wait" value="20"></label>',
    '''<label>Max wait for good exit (s)<input type="number" id="wait" value="20"></label>
  <label>Step window (s)<input type="number" id="hcwin" value="120"></label>
  <label>Treat data as stopped after (s)<input type="number" id="hcstale" value="240"></label>
  <label>Health Connect poll (s)<input type="number" id="hcpoll" value="10"></label>''')
rep('<script>\nconst $=', '<script src="bridge.js"></script>\n<script>\nconst $=')
# --- audio comes from blobs stored on the phone; cadence from the chosen source
rep("n.src='/song/'+x.s.id;", "n.src=srcFor(x.s);", 2)
rep("+$('bpm').value", "cadence()", 2)
rep("$('bpmv').textContent=b;", "$('bpmv').textContent=Math.round(b);$('cadsub').textContent=src==='hc'?'steps / min · Health Connect':'steps / BPM · manual';")
rep("const post=(p,o)=>fetch(p,{method:'POST',body:JSON.stringify(o)});", "")
rep("setInterval(draw,100);\nfetch('/api/songs').then(r=>r.json()).then(d=>{songs=d;$('count').textContent=`${d.length} songs loaded`;render()});",
    "setInterval(draw,100);\n" + (HERE / "phone_extra.js").read_text() + "\ninitApp();")
rep("plan=null;disarm();$('go').textContent='▶ Start';", "plan=null;disarm();keepAwake(false);$('go').textContent='▶ Start';")
rep("$('go').textContent='⏹ Stop';log('— started —');", "$('go').textContent='⏹ Stop';keepAwake(true);log('— started —');")
out = HERE.parent / "www" / "index.html"
out.write_text(P)
print(f"wrote {out} ({len(P)//1024} KB)")
