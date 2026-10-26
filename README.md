# PS5Expweb local Relapse host

Live diagnostic page: **https://patnawa.github.io/PS5Expweb/diagnostics/**

[Download the diagnostic app](https://github.com/patnawa/PS5Expweb/releases/tag/diagnostics-v0.1.0).
See [app development notes](docs/diagnostic-app.md) for package details and local development.

## Host diagnostics

Run `python serve.py` and open `http://<this-PC-LAN-IP>:8080/diagnostics/`.
Choose **Run checks** to check website files with HEAD requests. No downloaded
JavaScript, console exploit, or payload is executed by this screen. Logs retain
up to 500 timestamped entries in browser storage; **Export log** downloads a text
copy where browser downloads are supported. Storage errors are shown on screen.
This checks HTTP delivery and MIME types, not console memory or kernel stability.
It is also included at `/PS5Expweb/diagnostics/` in the Pages build.

The current client configuration targets `/diagnostics/` under title ID
`LCLD13600`. Older Relapse packages still target `/relapse/`, which starts
automatically on supported consoles. See
[the freeze investigation](docs/firmware-1360-bughunt.md) for unresolved findings.

The [shortcut client](client/README.md) is configured for this GitHub Pages URL.
Download rebuilt packages from [Releases](https://github.com/patnawa/PS5Expweb/releases).
The Pages workflow on `main` runs the tests, stages `relapse-stable/` with
`tools/stage_stable.py`, and deploys the hardened host at `/relapse/` plus the
diagnostics page at `/diagnostics/`. The imported upstream snapshot in `relapse/`
stays untouched and is served only for provenance checks.

The host linked in [mour0ne's post](https://bsky.app/profile/mour0ne.bsky.social/post/3mxjfk5x2gk2h)
is already copied into `relapse/`: 56 files from the deployed site, including
the 13.60 firmware table and loader. Its advertised firmware support includes
13.60; successful operation on your console has **not** been verified.

## Run locally

Requires Python 3.9 or newer. From this folder:

```powershell
python serve.py --check
python serve.py
```

`python serve.py` serves the **hardened host** from `relapse-stable/`. It stages
the tree exactly as the Pages workflow does (into `.local/serve-build/`) and
verifies the guard markers before listening: bounded WebKit attempts, the
AppCache settle gate, the already-patched refusal, and payloads routed to the
network instead of the manifest. This is the mode to use for console runs.

Open `http://<this-PC-LAN-IP>:8080/relapse/` on the PS5, on the same network.
Use `ipconfig` to find the PC's LAN IPv4 address. Keep the server running;
Ctrl+C stops it. The page starts automatically on a supported PS5. The PC
preview is `http://127.0.0.1:8080/relapse/`; that loopback address on the PS5
would refer to the PS5 itself. If Windows prompts, allow Python on your private
network. Change the port with `python serve.py --port 8000`.

The server sends the cache manifest as `text/cache-manifest` and its root
redirects to `/relapse/`. The repository's original root `index.html` is the
older 3.xx–4.xx host and is not the 13.60 entry point.

### Control deck (server GUI)

`python serve.py` also opens a dark **control deck** window that shows the live
exploit status in stage form — PAGE LOAD → CACHE → CODE → CHAIN RUNNING →
ELF LOADER → PAYLOADS — per connected console, plus payload integrity
(size + SHA-256 prefix per ELF), build/manifest stamps and a live request
feed. The stages are inferred from the console's own request stream (the chain
fetches its files in a fixed order), so the exploit code is untouched. The
same deck is served as a web page at `http://127.0.0.1:8080/_gui/` for phones
or a second monitor. Use `python serve.py --no-gui` for the terminal-only
mode (or when the machine has no display).

### The upstream snapshot is not the console host

`relapse/` is the untouched upstream source. It still ships the stale-payload
AppCache and the stacked heap sprays that freeze the console on a second boot.
Serve it only to verify provenance, never for a real run:

```powershell
python serve.py --check --snapshot
python serve.py --snapshot
```

To serve a prebuilt Pages tree without staging it again, use
`python serve.py --staged --staged-dir build/pages-stable`.

### Clearing a stuck cache from the client

Application Cache is **per origin**, so a query string (`?v=2`) does not create a
fresh cache. A console stuck on stale code needs one of these:

1. **Console UI (works for the installed shortcut).** Delete the shortcut app's
   saved data, or reinstall the pkg. The cache lives in the app's data, so this
   is the only reliable client-side clear when the pkg opens a fixed URL.
2. **New origin (local server).** Change the port or LAN IP
   (`python serve.py --port 8000`). A different origin starts with an empty
   cache; nothing stale can be served.
3. **Reset page (host-served).** Open `/relapse/reset-cache/` while the exploit
   is idle. Its manifest is intentionally missing, so the browser deletes the
   origin's cache; then reopen `/relapse/` to re-cache from the network.
   The same URL works on Pages:
   `https://patnawa.github.io/PS5Expweb/relapse/reset-cache/`.

Never reset or navigate away while a chain is running — an armed chain loses its
webview and can panic the kernel. After a freeze: power-cycle, relaunch once,
read the red banner, then reset if the build stamp is still missing.

### First launch after an update can freeze once

A manifest bump makes every cached client re-download the cached files. The
exploit starts automatically on page load, so on an **old cached build** the
chain can arm while that download is still running — and AppCache serves the old
copy of every listed file during an update. That combination is the documented
freeze. The current build waits for the cache to settle first and aborts the run
if the update is still downloading after 20 s, but a client running the older
cached code does not have that guard.

If a launch shows "Download cache..." and then hangs:

1. Hold the power button ~15 s to force the console off, unplug power ~30 s,
   then boot. Do not relaunch the shortcut yet.
2. Delete the app's saved data (Settings → Storage → Console Storage → Saved
   Data → Delete → select the app) or delete and reinstall the pkg. This removes
   the half-finished cache update.
3. Launch once. It loads from the network, downloads the cache, waits for it to
   settle, then runs. Expect `Build: 2026-10-26n no-join` and a
   `Cache at start:` line.

If the console still will not boot or restart cleanly, use Safe Mode (hold power
~7 s until the second beep) and clear the system software cache; rebuilding the
database is the heavier fallback.

### Crash diagnostics

The hardened host arms a durable crash log before the exploit starts. If the
console freezes, relaunch the page: a red banner shows the last stage reached,
how long the run stayed alive, and the last log line. **Copy log** exports the
full record. The same lines are mirrored to `localStorage`, so they survive the
process death that kills the on-screen log.

Confirm the build stamp `Build: 2026-10-26n no-join` appears in the log. If
it is missing, the console is running a stale cache; relaunch once and, if it
persists, clear the app's cache. Payloads are served over the network, so the
console needs network access to this host when the chain reaches the payload
handoff.

### "Kernel exploit passes but the game does not load"

If the log shows the kernel chain completing (root and sandbox escape active,
`elfldr is listening on port 9021`) and the game still never starts, the failure
is in the payload handoff, not the kernel exploit. Three things to check, in
order:

1. **Did the payload actually load?** The log now ends with
   `payloads loaded: pldmgr.elf` or a hard error naming the failure. A run that
   ends silently, or ends with "kernel chain complete" and no payload line, did
   not deliver. Payload Manager installs kstuff and shadowmountplus; without it
   nothing mounts and no game launches.
2. **Was this a relaunch after a successful chain?** The second-boot guard
   refuses to re-arm an already-patched kernel — correct — but the previous
   launch may have died before the payload reached the loader. The guard now
   retries the handoff on that path when a delivery is left pending
   (`ps5expweb_payload_pending` in localStorage). If the log says
   `previous payload handoff did not finish`, the retry is running; if it ends in
   "payloads did not load on the already-jailbroken path", the loader refused
   the ELF and the console needs a power cycle.
3. **Is the payload reachable?** The ELF is 2.8 MB and is fetched over the
   network on purpose (it is deliberately not appcached). A single dropped
   request used to end the run; it now retries up to three times. If it still
   fails, the console cannot reach this host's payload URL — check the LAN
   address and that the server is still running.

Do not close the app or navigate away while a chain is running; an armed chain
loses its webview and can panic the kernel.

The payload handoff is now retried and reported: a transient network failure on
the ~2.8 MB payload manager no longer ends the run as a silent "game not load".
If the payloads do not reach the loader, the page marks the run failed and the
next launch's red banner names the payload handoff. If a previous handoff did
not finish (the webview died mid-delivery), the already-jailbroken path sends
the payloads to the running elfldr instead of doing nothing.

For first-time caching, the PS5 must reach this local server and finish its
cache download. Reopen the same URL after caching; changing host or port changes
the cache origin. The post's `127.0.0.2` DNS instruction is not a local web-server
address and is not needed to reach a LAN IP. Offline Application Cache behavior
must be confirmed on the console; desktop browsers may not support it.

## Inspection and verification

```powershell
python -m unittest discover -s tests -v
```

These checks verify Pages staging, client metadata preparation, HTTP delivery, MIME types, offline asset completeness,
path restrictions, and all 56 SHA-256 hashes without executing the exploit.
The original imported files are unchanged. Provenance is in
[`docs/sources/mour0ne-snapshot.json`](docs/sources/mour0ne-snapshot.json).
Findings and limitations are in [`docs/relapse-inspection.md`](docs/relapse-inspection.md).

Original upstream root description: ps5xploit.github.io, 3.xx–4.xx host,
IPV6 + PSFREE.
