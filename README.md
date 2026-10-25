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
The active Pages source is branch `diagnostic-site`, which contains only the
diagnostic website. The local main-branch workflow also stages only diagnostics.
The separate legacy staging tool preserves the imported Relapse source bytes.

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

Open `http://<this-PC-LAN-IP>:8080/relapse/` on the PS5, on the same network.
Use `ipconfig` to find the PC's LAN IPv4 address. Keep the server running;
Ctrl+C stops it. The imported page starts automatically on a supported PS5.
The PC preview is `http://127.0.0.1:8080/relapse/`; that loopback address on
the PS5 would refer to the PS5 itself. If Windows prompts, allow Python on
your private network. Change the port with `python serve.py --port 8000`.

The server verifies all snapshot hashes before startup, sends the cache
manifest as `text/cache-manifest`, and serves only imported Relapse assets.
Its root redirects to `/relapse/`. The repository's original root `index.html`
is the older 3.xx–4.xx host and is not the 13.60 entry point.

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
