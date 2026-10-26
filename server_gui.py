"""Server GUI for the PS5Expweb host: live exploit status, professional dark UI.

Three pieces share one state model:

    GuiState        thread-safe request tracker + exploit-stage inference
    dashboard_html  web control deck served at /_gui/ (any browser)
    run_gui         desktop tkinter window (same data, offline-friendly)

Exploit status is inferred from the console's request stream without touching
the exploit code. The chain fetches its files in a known order, so the requests
IS the stage timeline:

    index.html                      -> PAGE LOAD
    cache.appcache                  -> CACHE CHECK
    src/*.js, offsets/*.js          -> CODE LOAD
    (gap while the chain runs)      -> CHAIN RUNNING
    payloads/elfldr*, payloads/kexp -> ELF LOADER   (post-escalation)
    payloads/pldmgr.elf             -> PAYLOADS     (only fetched after
                                                     a successful run)
"""

import base64
import hashlib
import html
import json
import re
import threading
import time
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARTWORK = ROOT / "client" / "artwork"

STAGES = ["PAGE LOAD", "CACHE", "CODE", "CHAIN RUNNING", "ELF LOADER", "PAYLOADS"]

# path -> stage index; None means "does not move the tracker"
def stage_for(path):
    path = path.split("?")[0].rstrip("/") or "/"
    if path in ("/relapse", "/relapse/index.html", "/index.html", "/"):
        return 0
    if path.endswith(("cache.appcache", "cache3.appcache3")):
        return 1
    if "/payloads/" in path:
        name = path.rsplit("/", 1)[-1].lower()
        if name.startswith(("elfldr", "kexp")):
            return 4
        return 5
    if path.startswith(("/relapse/src/", "/relapse/offsets/")) or path.endswith((".js", ".mjs")):
        return 2
    return None


class GuiState:
    def __init__(self):
        self.lock = threading.Lock()
        self.started = time.time()
        self.mode = "-"
        self.url = ""
        self.bind = ""
        self.port = 0
        self.build = "-"
        self.manifest_version = "-"
        self.guards = 0
        self.staged_files = 0
        self.payloads = []
        self.requests = 0
        self.bytes = 0
        self.recent = deque(maxlen=200)
        self.clients = {}

    def set_server(self, *, mode, url, bind, port, build, manifest_version,
                   guards, staged_files, payloads):
        with self.lock:
            self.mode = mode
            self.url = url
            self.bind = bind
            self.port = port
            self.build = build
            self.manifest_version = manifest_version
            self.guards = guards
            self.staged_files = staged_files
            self.payloads = payloads

    def record(self, method, path, status, size, ip):
        if path.startswith("/_gui/"):
            return  # the dashboard polls itself; keep it out of the feed
        try:
            size = int(size)
        except (TypeError, ValueError):
            size = 0
        now = time.time()
        with self.lock:
            self.requests += 1
            self.bytes += max(0, size)
            entry = {"t": now, "ip": ip, "method": method, "path": path,
                     "status": str(status), "size": size}
            self.recent.append(entry)
            client = self.clients.setdefault(ip, {
                "ip": ip, "first": now, "last": now, "stage": 0,
                "complete": False, "count": 0, "timeline": deque(maxlen=60),
            })
            client["last"] = now
            client["count"] += 1
            client["timeline"].append(entry)
            clean = path.split("?")[0]
            if clean.endswith((".elf", ".bin")) and "/payloads/" in clean:
                name = clean.rsplit("/", 1)[-1].lower()
                if name.startswith("pldmgr"):
                    client["complete"] = True
            index = stage_for(path)
            if index is not None and index > client["stage"]:
                client["stage"] = index

    def snapshot(self):
        now = time.time()
        with self.lock:
            clients = []
            for client in self.clients.values():
                stage = client["stage"]
                # A quiet console that loaded the code is mid-chain: the kernel
                # stages make no requests until the ELF loader fetch.
                if stage == 2 and now - client["last"] > 3:
                    live = 3
                else:
                    live = stage
                clients.append({
                    "ip": client["ip"],
                    "first": client["first"],
                    "last": client["last"],
                    "stage": stage,
                    "live_stage": live,
                    "complete": client["complete"],
                    "requests": client["count"],
                    "timeline": list(client["timeline"])[-12:],
                })
            clients.sort(key=lambda c: c["last"], reverse=True)
            return {
                "build": self.build,
                "manifest_version": self.manifest_version,
                "mode": self.mode,
                "url": self.url,
                "bind": self.bind,
                "port": self.port,
                "uptime_s": int(now - self.started),
                "guards": self.guards,
                "staged_files": self.staged_files,
                "payloads": self.payloads,
                "totals": {"requests": self.requests, "bytes": self.bytes},
                "clients": clients,
                "recent": list(self.recent)[-60:],
                "stages": STAGES,
            }


def collect_tree_info(tree):
    """Build stamp, manifest version and payload inventory for the GUI."""
    tree = Path(tree)
    relapse = tree / "relapse"
    build = "-"
    site = relapse / "src" / "site.js"
    if site.is_file():
        match = re.search(r'BUILD = "([^"]+)"', site.read_text(encoding="utf-8"))
        if match:
            build = match.group(1)
    version = "-"
    for name in ("cache.appcache", "cache3.appcache3"):
        manifest = relapse / name
        if manifest.is_file():
            match = re.search(r"^# version (.+) #$", manifest.read_text(encoding="utf-8-sig"),
                              re.MULTILINE)
            if match:
                version = match.group(1)
            break
    payloads = []
    payload_dir = relapse / "payloads"
    if payload_dir.is_dir():
        for entry in sorted(payload_dir.glob("*")):
            if entry.is_file():
                data = entry.read_bytes()
                payloads.append({
                    "name": entry.name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest()[:16],
                })
    return build, version, payloads


def _icon_b64():
    icon = ARTWORK / "mark-256.png"
    if icon.is_file():
        return base64.b64encode(icon.read_bytes()).decode()
    return ""


def dashboard_html():
    return DASHBOARD_TEMPLATE.replace("__ICON__", _icon_b64())


DASHBOARD_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relapse Host - Control Deck</title>
<link rel="icon" href="data:image/png;base64,__ICON__">
<style>
  :root {
    --bg: #0b0e17; --card: #111a2b; --edge: #1e2c44; --ink: #eaf2ff;
    --muted: #8fa3bf; --cyan: #22d3ee; --violet: #7c5cff; --ok: #34d399;
    --warn: #fbbf24; --bad: #f87171;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: radial-gradient(1200px 600px at 15% -10%, #10263f 0%, var(--bg) 55%),
                radial-gradient(1000px 700px at 110% 110%, #241a4d 0%, var(--bg) 60%);
    color: var(--ink); font: 15px/1.5 "Segoe UI", system-ui, sans-serif;
    min-height: 100vh; padding: 28px clamp(16px, 4vw, 56px);
  }
  header { display: flex; align-items: center; gap: 18px; margin-bottom: 26px; }
  header img { width: 58px; height: 58px; border-radius: 14px; }
  h1 { font-size: 26px; letter-spacing: 2px; font-weight: 650; }
  h1 span { color: var(--cyan); }
  .sub { color: var(--muted); font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; }
  .pill { display: inline-block; padding: 4px 14px; border-radius: 999px; font-size: 12px;
          letter-spacing: 1px; border: 1px solid var(--edge); color: var(--muted); }
  .pill.cyan { color: var(--cyan); border-color: #164e63; background: #0c2230; }
  .grid { display: grid; gap: 16px; }
  .cards { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--edge); border-radius: 16px;
          padding: 16px 18px; }
  .card .k { color: var(--muted); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; }
  .card .v { font-size: 22px; font-weight: 650; margin-top: 6px; word-break: break-all; }
  .card .v.small { font-size: 15px; }
  main { display: grid; gap: 16px; margin-top: 16px;
         grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
  h2 { font-size: 13px; letter-spacing: 2.5px; color: var(--muted);
       text-transform: uppercase; margin-bottom: 12px; }
  .tracker { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
  .step { padding: 6px 13px; border-radius: 999px; font-size: 11.5px; letter-spacing: 1px;
          border: 1px solid var(--edge); color: #5c708c; background: #0e1626; }
  .step.done { color: var(--ok); border-color: #14532d; }
  .step.live { color: #06222c; background: var(--cyan); border-color: var(--cyan); font-weight: 650; }
  .client { padding: 14px 0; border-top: 1px solid var(--edge); }
  .client:first-of-type { border-top: 0; }
  .client .ip { font: 600 15px Consolas, monospace; }
  .badge { float: right; }
  .done-badge { color: var(--ok); border-color: #14532d; background: #052e22; }
  .run-badge { color: var(--cyan); border-color: #164e63; background: #0c2230; }
  table { width: 100%; border-collapse: collapse; font: 12.5px Consolas, monospace; }
  td { padding: 5px 8px; border-top: 1px solid #16233a; color: var(--muted); white-space: nowrap; }
  td.path { color: var(--ink); max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  td.st-2xx { color: var(--ok); } td.st-3xx { color: var(--warn); } td.st-4xx { color: var(--bad); }
  .payload td { color: var(--ink); }
  footer { margin-top: 26px; color: #44587a; font-size: 12px; letter-spacing: 1px; }
</style>
</head>
<body>
<header>
  <img src="data:image/png;base64,__ICON__" alt="">
  <div>
    <h1>RELAPSE <span>HOST</span></h1>
    <div class="sub">PS5 Exploit Control Deck</div>
  </div>
  <div style="margin-left:auto; text-align:right">
    <div class="pill cyan" id="mode">-</div><br>
    <div class="pill" id="url" style="margin-top:8px">-</div>
  </div>
</header>

<section class="grid cards">
  <div class="card"><div class="k">Build</div><div class="v small" id="build">-</div></div>
  <div class="card"><div class="k">Manifest</div><div class="v small" id="manifest">-</div></div>
  <div class="card"><div class="k">Consoles</div><div class="v" id="clients">0</div></div>
  <div class="card"><div class="k">Requests</div><div class="v" id="requests">0</div></div>
  <div class="card"><div class="k">Served</div><div class="v" id="bytes">0 B</div></div>
  <div class="card"><div class="k">Uptime</div><div class="v" id="uptime">0s</div></div>
</section>

<main>
  <section class="card">
    <h2>Exploit status</h2>
    <div id="consoles"><div class="sub">No console has connected yet.</div></div>
    <h2 style="margin-top:22px">Payload integrity</h2>
    <table class="payload"><tbody id="payloads"></tbody></table>
  </section>

  <section class="card">
    <h2>Live activity</h2>
    <table><tbody id="feed"></tbody></table>
  </section>
</main>

<footer id="guards">- guard markers verified</footer>

<script>
const fmtBytes = n => n > 1048576 ? (n/1048576).toFixed(1)+" MiB"
                    : n > 1024 ? (n/1024).toFixed(1)+" KiB" : n + " B";
const fmtAgo = t => { const s = Math.max(0, (Date.now()/1000) - t);
  return s < 60 ? Math.round(s) + "s ago" : Math.round(s/60) + "m ago"; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function render(data) {
  document.getElementById("mode").textContent = data.mode;
  document.getElementById("url").textContent = data.url;
  document.getElementById("build").textContent = data.build;
  document.getElementById("manifest").textContent = data.manifest_version;
  document.getElementById("clients").textContent = data.clients.length;
  document.getElementById("requests").textContent = data.totals.requests;
  document.getElementById("bytes").textContent = fmtBytes(data.totals.bytes);
  document.getElementById("uptime").textContent =
    Math.floor(data.uptime_s/60) + "m " + (data.uptime_s%60) + "s";
  document.getElementById("guards").textContent =
    data.guards + " guard markers across " + data.staged_files + " staged files";

  document.getElementById("consoles").innerHTML = data.clients.length
    ? data.clients.map(c => {
        const steps = data.stages.map((s, i) => {
          const cls = c.complete || i < c.live_stage ? "done" : i === c.live_stage ? "live" : "";
          return '<span class="step ' + cls + '">' + s + "</span>";
        }).join("");
        const badge = c.complete
          ? '<span class="pill badge done-badge">CHAIN COMPLETE</span>'
          : '<span class="pill badge run-badge">' + data.stages[c.live_stage] + "</span>";
        return '<div class="client">' + badge +
          '<div class="ip">' + esc(c.ip) + "</div>" +
          '<div class="sub">' + c.requests + " requests, last " + fmtAgo(c.last) + "</div>" +
          '<div class="tracker">' + steps + "</div></div>";
      }).join("")
    : '<div class="sub">No console has connected yet.</div>';

  document.getElementById("payloads").innerHTML = data.payloads.map(p =>
    "<tr><td>" + esc(p.name) + "</td><td>" + fmtBytes(p.bytes) +
    "</td><td>" + p.sha256 + "...</td></tr>").join("");

  document.getElementById("feed").innerHTML = data.recent.slice().reverse().slice(0, 40).map(r => {
    const cls = "st-" + String(r.status)[0] + "xx";
    return "<tr><td>" + fmtAgo(r.t) + '</td><td class="' + cls + '">' + r.status +
      '</td><td class="path" title="' + esc(r.path) + '">' + esc(r.path) +
      "</td><td>" + fmtBytes(r.size) + "</td></tr>";
  }).join("");
}

async function tick() {
  try { render(await (await fetch("/_gui/status.json")).json()); } catch (e) {}
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------
# Desktop window
# --------------------------------------------------------------------------

def run_gui(state, open_urls):
    """Dark tkinter control deck. Returns when the window closes.

    ``open_urls`` is {"console": ..., "dashboard": ...}. Falls back to the
    terminal loop is handled by the caller; this function assumes tkinter.
    """
    import tkinter as tk
    from tkinter import font as tkfont

    BG, CARD, EDGE = "#0b0e17", "#111a2b", "#1e2c44"
    INK, MUTED, CYAN, VIOLET = "#eaf2ff", "#8fa3bf", "#22d3ee", "#7c5cff"
    OK, WARN, BAD = "#34d399", "#fbbf24", "#f87171"

    root = tk.Tk()
    root.title("Relapse Host - Control Deck")
    root.geometry("1080x720")
    root.configure(bg=BG)
    root.minsize(920, 620)

    icon = ARTWORK / "mark-256.png"
    if icon.is_file():
        try:
            photo = tk.PhotoImage(file=str(icon))
            root.iconphoto(True, photo)
            root._icon = photo
        except tk.TclError:
            pass

    mono = tkfont.Font(family="Consolas", size=10)
    head = tkfont.Font(family="Segoe UI", size=17, weight="bold")
    label = tkfont.Font(family="Segoe UI", size=9)
    value = tkfont.Font(family="Segoe UI Semibold", size=13)

    def card(parent, title):
        frame = tk.Frame(parent, bg=CARD, highlightbackground=EDGE,
                         highlightthickness=1)
        tk.Label(frame, text=title, bg=CARD, fg=MUTED, font=label,
                 anchor="w").pack(fill="x", padx=14, pady=(10, 0))
        body = tk.Label(frame, text="-", bg=CARD, fg=INK, font=value, anchor="w")
        body.pack(fill="x", padx=14, pady=(2, 12))
        return frame, body

    header = tk.Frame(root, bg=BG)
    header.pack(fill="x", padx=24, pady=(20, 10))
    if icon.is_file():
        try:
            mark = tk.PhotoImage(file=str(icon)).subsample(5, 5)
            tk.Label(header, image=mark, bg=BG).pack(side="left")
            header._mark = mark
        except tk.TclError:
            pass
    tk.Label(header, text="RELAPSE HOST", bg=BG, fg=INK,
             font=head).pack(side="left", padx=(14, 0))
    tk.Label(header, text="PS5 EXPLOIT CONTROL DECK", bg=BG, fg=MUTED,
             font=label).pack(side="left", padx=(14, 0), anchor="s", pady=(0, 4))

    url_box = tk.Frame(header, bg=BG)
    url_box.pack(side="right")
    tk.Label(url_box, text="CONSOLE URL", bg=BG, fg=MUTED, font=label,
             anchor="e").pack(fill="x")
    url_var = tk.StringVar(value="-")
    tk.Entry(url_box, textvariable=url_var, bg=CARD, fg=CYAN, insertbackground=INK,
             relief="flat", font=mono, width=44, justify="center"
             ).pack(ipady=6)

    cards = tk.Frame(root, bg=BG)
    cards.pack(fill="x", padx=24, pady=6)
    stat = {}
    for key, title in [("mode", "MODE"), ("build", "BUILD"), ("manifest", "MANIFEST"),
                       ("clients", "CONSOLES"), ("requests", "REQUESTS"), ("bytes", "SERVED")]:
        frame, body = card(cards, title)
        frame.pack(side="left", expand=True, fill="both", padx=(0, 10))
        stat[key] = body

    stage_frame = tk.Frame(root, bg=CARD, highlightbackground=EDGE, highlightthickness=1)
    stage_frame.pack(fill="both", padx=24, pady=(6, 6))
    tk.Label(stage_frame, text="EXPLOIT STATUS", bg=CARD, fg=MUTED, font=label,
             anchor="w").pack(fill="x", padx=14, pady=(10, 4))
    stage_body = tk.Frame(stage_frame, bg=CARD)
    stage_body.pack(fill="both", expand=True, padx=14, pady=(0, 12))

    log_frame = tk.Frame(root, bg=CARD, highlightbackground=EDGE, highlightthickness=1)
    log_frame.pack(fill="both", expand=True, padx=24, pady=(6, 6))
    tk.Label(log_frame, text="LIVE ACTIVITY", bg=CARD, fg=MUTED, font=label,
             anchor="w").pack(fill="x", padx=14, pady=(10, 4))
    log = tk.Listbox(log_frame, bg=CARD, fg=MUTED, font=mono, relief="flat",
                     highlightthickness=0, selectbackground=VIOLET)
    log.pack(fill="both", expand=True, padx=2, pady=(0, 8))

    buttons = tk.Frame(root, bg=BG)
    buttons.pack(fill="x", padx=24, pady=(2, 16))

    def styled_button(text, command, primary=False):
        return tk.Button(buttons, text=text, command=command, relief="flat",
                         bg=CYAN if primary else CARD,
                         fg="#06222c" if primary else INK,
                         activebackground=VIOLET, activeforeground=INK,
                         font=label, padx=16, pady=7, cursor="hand2")

    import webbrowser

    styled_button("OPEN CONSOLE PAGE",
                  lambda: webbrowser.open(open_urls["console"]), primary=True
                  ).pack(side="left")
    styled_button("OPEN WEB DASHBOARD",
                  lambda: webbrowser.open(open_urls["dashboard"])).pack(side="left", padx=10)

    def copy_url():
        root.clipboard_clear()
        root.clipboard_append(open_urls["console"])

    styled_button("COPY URL", copy_url).pack(side="left")
    styled_button("QUIT", root.destroy).pack(side="right")

    def refresh():
        snap = state.snapshot()
        stat["mode"].config(text=snap["mode"])
        stat["build"].config(text=snap["build"])
        stat["manifest"].config(text=snap["manifest_version"])
        stat["clients"].config(text=str(len(snap["clients"])))
        stat["requests"].config(text=str(snap["totals"]["requests"]))
        stat["bytes"].config(text=(f"{snap['totals']['bytes']/1048576:.1f} MiB"
                                   if snap["totals"]["bytes"] > 1048576
                                   else f"{snap['totals']['bytes']/1024:.1f} KiB"))
        url_var.set(snap["url"] or "-")

        for child in stage_body.winfo_children():
            child.destroy()
        if not snap["clients"]:
            tk.Label(stage_body, text="No console has connected yet.", bg=CARD,
                     fg=MUTED, font=label).pack(anchor="w")
        for client in snap["clients"][:4]:
            row = tk.Frame(stage_body, bg=CARD)
            row.pack(fill="x", pady=4)
            state_text = "CHAIN COMPLETE" if client["complete"] else snap["stages"][client["live_stage"]]
            tk.Label(row, text=client["ip"], bg=CARD, fg=INK, font=mono,
                     width=16, anchor="w").pack(side="left")
            tk.Label(row, text=state_text, bg=CARD,
                     fg=OK if client["complete"] else CYAN, font=label,
                     width=18, anchor="w").pack(side="left", padx=(0, 12))
            for index, name in enumerate(snap["stages"]):
                done = client["complete"] or index < client["live_stage"]
                live = not client["complete"] and index == client["live_stage"]
                tk.Label(row, text=name, bg=CYAN if live else ("#0e1626" if not done else "#052e22"),
                         fg=("#06222c" if live else (OK if done else "#5c708c")),
                         font=label, padx=8, pady=2).pack(side="left", padx=3)

        log.delete(0, "end")
        for entry in list(snap["recent"])[-80:]:
            stamp = time.strftime("%H:%M:%S", time.localtime(entry["t"]))
            log.insert("end", f"{stamp}  {entry['status']:>3}  {entry['method']:<4} "
                              f"{entry['path'][:70]}  {entry['size']}B")
        log.yview_moveto(1.0)
        root.after(1000, refresh)

    refresh()
    root.mainloop()