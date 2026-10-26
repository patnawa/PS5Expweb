"""Serve the PS5 exploit host on a local network (Python 3.9+).

Default mode serves the hardened host from ``relapse-stable/`` -- the tree that
carries the crash fixes (bounded WebKit attempts, verified kernel teardown, the
already-patched guard and the AppCache settle gate). It is staged exactly like
the GitHub Pages artifact, so a console that loads this server runs the same
bytes the live site ships.

``--snapshot`` serves the untouched upstream snapshot in ``relapse/`` instead.
That mode exists for provenance checks: its 56 files are pinned by SHA-256 in
``docs/sources/mour0ne-snapshot.json`` and must never be edited in place.

Serving the upstream snapshot by default was the trap this script now avoids:
``python serve.py`` used to hand the console the unpatched Relapse source, whose
stale-payload AppCache path and stacked heap sprays are the documented causes of
the second-boot console freeze. The README tells users to run ``python serve.py``;
that command must serve the fixed host.
"""

import argparse
import hashlib
import json
import shutil
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import server_gui

ROOT = Path(__file__).resolve().parent
SNAPSHOT = ROOT / "relapse"
STABLE = ROOT / "relapse-stable"
PROVENANCE = ROOT / "docs/sources/mour0ne-snapshot.json"
DEFAULT_BUILD_DIR = ROOT / ".local/serve-build"

# Live status shared by the request handler, the web dashboard and the GUI.
STATE = server_gui.GuiState()


def snapshot_files():
    return json.loads(PROVENANCE.read_text(encoding="utf-8"))["files"]


def verify_snapshot():
    """Check exact bytes and offline-manifest coverage without executing JS."""
    files = snapshot_files()
    recorded = set()
    for entry in files:
        name = entry["path"]
        path = (SNAPSHOT / name).resolve()
        if not path.is_relative_to(SNAPSHOT.resolve()):
            raise ValueError(f"Snapshot path escapes its directory: {name}")
        data = path.read_bytes()
        if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError(f"Snapshot integrity mismatch: {name}")
        recorded.add(name)

    lines = (SNAPSHOT / "cache3.appcache3").read_text(encoding="utf-8-sig").splitlines()
    if not lines or lines[0] != "CACHE MANIFEST":
        raise ValueError("Invalid cache manifest header")
    section = "CACHE:"
    assets = []
    for line in lines[1:]:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line in ("CACHE:", "NETWORK:", "FALLBACK:", "SETTINGS:"):
            section = line
        elif section == "CACHE:":
            if line not in recorded:
                raise ValueError(f"Unverified cache asset: {line}")
            assets.append(line)
    for required in ("index.html", "src/firmware.js", "offsets/13.60.js",
                     "payloads/elfldr-ps5-1360.elf"):
        if required not in assets:
            raise ValueError(f"Required 13.60 asset missing from cache: {required}")
    return len(files), len(assets)


def verify_staged_tree(tree):
    """Check the invariants that make the hardened host safe to run.

    These are structural checks, not version strings: the build stamp and the
    manifest version line change with every fix. The point is to refuse to serve
    a tree that lost the second-boot guard or re-listed payloads in the manifest,
    because either one reintroduces the console freeze.
    """
    tree = Path(tree).resolve()
    relapse = tree / "relapse"
    entry = relapse / "index.html"
    if not entry.is_file():
        raise ValueError(f"Staged tree missing entry point: {entry}")
    html = entry.read_bytes()
    if b'manifest="cache.appcache"' not in html:
        raise ValueError("Staged index.html does not reference cache.appcache")
    if b'manifest="cache3.appcache3"' in html:
        raise ValueError("Staged index.html still references the source manifest name")

    manifest = relapse / "cache.appcache"
    if not manifest.is_file():
        raise ValueError("Staged cache.appcache is missing")
    manifest_bytes = manifest.read_bytes()
    if manifest_bytes != (STABLE / "cache3.appcache3").read_bytes():
        raise ValueError("Staged manifest drifted from relapse-stable/cache3.appcache3")
    text = manifest_bytes.decode("utf-8-sig")
    if not text.startswith("CACHE MANIFEST"):
        raise ValueError("Invalid staged cache manifest header")
    if "NETWORK:" not in text or "*" not in text:
        raise ValueError("Staged manifest does not route network assets")
    for cached in ("payloads/kstuff.elf", "payloads/pldmgr.elf",
                   "payloads/shadowmountplus.elf", "payloads/elfldr-ps5-1360.elf"):
        if cached in text:
            raise ValueError(f"Staged manifest still caches payload {cached}")

    markers = {
        "appcache_handler.js": [b"__appcacheSettled", b"__exploitRunning", b"__exploitDone"],
        "src/site.js": [b"__appcacheSettled", b"__exploitRunning", b"BUILD ="],
        "src/webkit.js": [b"MAX_ATTEMPTS = 4"],
        "src/relapse_exploit.js": [b"refusing to re-arm", b"alreadyJailbroken"],
        "src/main.js": [b"alreadyJailbroken"],
    }
    for name, needles in markers.items():
        data = (relapse / name).read_bytes()
        for needle in needles:
            if needle not in data:
                raise ValueError(f"{name} is missing required marker {needle.decode()}")

    for payload in ("payloads/kstuff.elf", "payloads/pldmgr.elf"):
        if not (relapse / payload).is_file():
            raise ValueError(f"Staged payload missing: {payload}")

    if not (tree / "diagnostics/index.html").is_file():
        raise ValueError("Staged diagnostics page is missing")
    return len(markers), sum(1 for p in relapse.rglob("*") if p.is_file())


class RelapseHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        # Pages serves the staged manifest as "cache.appcache" (stage_stable.py
        # renames it). Without this entry a local preview sends octet-stream and
        # the console refuses the manifest, so local tests fail for a reason that
        # does not exist in production.
        ".appcache": "text/cache-manifest",
        ".appcache3": "text/cache-manifest",
        ".js": "application/javascript",
        ".elf": "application/octet-stream",
        ".bin": "application/octet-stream",
    }

    # Set by main() before the server starts. SimpleHTTPRequestHandler is built
    # by the server with a fixed signature, so the mode travels as a class
    # attribute rather than a constructor keyword.
    staged = False
    staged_root = None

    def __init__(self, *args, **kwargs):
        if type(self).staged:
            # Serve exactly what the Pages workflow uploads: stage_stable.py
            # rewrites index.html to reference cache.appcache and adds the alias.
            # Containment under the generated tree is the only rule, because
            # those bytes are not in the provenance-checked snapshot manifest.
            base = type(self).staged_root or (ROOT / "build/pages-stable")
            self.base = base.resolve()
            self.allowed = None
        else:
            # The pinned snapshot stays behind an explicit allowlist.
            self.base = ROOT
            self.allowed = {"/relapse/" + item["path"] for item in snapshot_files()}
            self.allowed.update({"/diagnostics/index.html", "/diagnostics/host.js"})
        super().__init__(*args, directory=str(self.base), **kwargs)

    def log_request(self, code="-", size="-"):
        # Every request feeds the control deck (server GUI / web dashboard);
        # the console's file stream IS the exploit stage timeline.
        try:
            STATE.record(self.command, self.path, code, size,
                         self.address_string())
        except Exception:
            pass
        super().log_request(code, size)

    def serve_gui_asset(self, path):
        """Read-only control deck endpoints, served in every mode."""
        if path in ("/_gui", "/_gui/", "/_gui/index.html"):
            body = server_gui.dashboard_html().encode()
            content_type = "text/html; charset=utf-8"
        elif path == "/_gui/status.json":
            body = json.dumps(STATE.snapshot()).encode()
            content_type = "application/json"
        elif path == "/_gui/icon.png":
            icon = server_gui.ARTWORK / "mark-256.png"
            if not icon.is_file():
                self.send_error(404, "Artwork not generated")
                return None
            body = icon.read_bytes()
            content_type = "image/png"
        else:
            self.send_error(404, "Unknown control deck asset")
            return None
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return None

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None

    def send_head(self):
        path = unquote(urlsplit(self.path).path)

        # The control deck is server-side UI, not part of either served tree.
        if path.startswith("/_gui/"):
            return self.serve_gui_asset(path)

        if type(self).staged:
            # Staged mode serves the generated Pages tree as-is. Its root already
            # ships a redirect page, so only the no-trailing-slash variants are
            # rewritten here. Containment under the tree is the only rule: there
            # are no pinned hashes to match against.
            if path == "/relapse":
                return self.redirect("/relapse/")
            if path == "/relapse/":
                path += "index.html"
            if path == "/diagnostics":
                return self.redirect("/diagnostics/")
            if path == "/diagnostics/":
                path += "index.html"
            target = (self.base / path.lstrip("/")).resolve()
            if not target.is_relative_to(self.base):
                self.send_error(404, "Not a staged artifact")
                return None
            return super().send_head()

        # Snapshot mode keeps the original redirect contract and strict allowlist.
        if path in ("/", "/index.html", "/relapse"):
            return self.redirect("/relapse/")
        if path == "/relapse/":
            path += "index.html"
        if path == "/diagnostics":
            return self.redirect("/diagnostics/")
        if path == "/diagnostics/":
            path += "index.html"
        target = (self.base / path.lstrip("/")).resolve()
        public_root = ROOT / "diagnostics" if path.startswith("/diagnostics/") else SNAPSHOT
        if path not in self.allowed or not target.is_relative_to(public_root.resolve()):
            self.send_error(404, "Not a snapshot asset")
            return None
        return super().send_head()

    def end_headers(self):
        # Revalidate changes online while allowing legacy Application Cache storage.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def stage_fresh(destination):
    """Stage relapse-stable/ plus diagnostics into a fresh directory."""
    destination = Path(destination).resolve()
    if destination.exists():
        shutil.rmtree(destination)
    from tools.stage_stable import stage

    return stage(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0", help="Bind address (default: all interfaces)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument(
        "--snapshot",
        action="store_true",
        help="Serve the untouched upstream snapshot in relapse/ instead of the "
             "hardened host (provenance checks only; this is the unpatched source)",
    )
    parser.add_argument(
        "--staged",
        action="store_true",
        help="Serve a prebuilt Pages tree from --staged-dir without staging it again",
    )
    parser.add_argument(
        "--staged-dir",
        default="build/pages-stable",
        help="Prebuilt Pages tree for --staged (default: build/pages-stable)",
    )
    parser.add_argument(
        "--build-dir",
        default=str(DEFAULT_BUILD_DIR),
        help="Where default mode stages the hardened host (default: .local/serve-build)",
    )
    parser.add_argument("--check", action="store_true", help="Verify the selected tree and exit")
    parser.add_argument(
        "--no-gui",
        action="store_true",
        help="Run without the desktop control-deck window (terminal only)",
    )
    args = parser.parse_args()

    if args.snapshot:
        try:
            files, assets = verify_snapshot()
        except (OSError, ValueError, KeyError) as error:
            parser.exit(1, f"Snapshot verification failed: {error}\n")
        print(f"Verified upstream snapshot: {files} file hashes and {assets} offline assets.", flush=True)
        print("WARNING: the snapshot is the unpatched upstream host and still has the", flush=True)
        print("documented second-boot freeze paths. Use the default mode for console runs.", flush=True)
        guards, staged_files, info_tree = files, assets, ROOT
        if args.check:
            return
        RelapseHandler.staged = False
        RelapseHandler.staged_root = None
        mode = "upstream snapshot (unpatched)"
    else:
        if args.staged:
            tree = (ROOT / args.staged_dir).resolve()
            if not (tree / "relapse/index.html").is_file():
                parser.exit(1, f"Staged tree missing: {tree}\nRun: python tools/stage_stable.py {args.staged_dir}\n")
        else:
            tree = Path(args.build_dir).resolve()
            try:
                stage_fresh(tree)
            except Exception as error:
                parser.exit(1, f"Staging the hardened host failed: {error}\n")
        try:
            markers, entries = verify_staged_tree(tree)
        except (OSError, ValueError, KeyError) as error:
            parser.exit(1, f"Hardened tree verification failed: {error}\n")
        print(f"Verified hardened host: {markers} guard markers across {entries} staged files.", flush=True)
        guards, staged_files, info_tree = markers, entries, tree
        if args.check:
            return
        RelapseHandler.staged = True
        RelapseHandler.staged_root = tree
        mode = f"hardened host from relapse-stable ({tree})"

    build, manifest_version, payloads = server_gui.collect_tree_info(info_tree)
    with ThreadingHTTPServer((args.bind, args.port), RelapseHandler) as server:
        host = args.bind if args.bind != "0.0.0.0" else "127.0.0.1"
        console_url = f"http://{host}:{server.server_port}/relapse/"
        dashboard_url = f"http://{host}:{server.server_port}/_gui/"
        STATE.set_server(
            mode=mode,
            url=f"http://<this-PC-LAN-IP>:{server.server_port}/relapse/",
            bind=args.bind,
            port=server.server_port,
            build=build,
            manifest_version=manifest_version,
            guards=guards,
            staged_files=staged_files,
            payloads=payloads,
        )
        print(f"Serving {mode}", flush=True)
        print(f"Local preview: {console_url}", flush=True)
        print(f"PS5: http://<this-PC-LAN-IP>:{server.server_port}/relapse/", flush=True)
        print(f"Control deck: {dashboard_url}", flush=True)
        print("The page starts automatically on a supported PS5. Ctrl+C stops the host.", flush=True)

        gui = not args.no_gui
        if gui:
            try:
                import tkinter  # noqa: F401
            except ImportError:
                print("tkinter is unavailable - running with the terminal UI only.", flush=True)
                gui = False

        if gui:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            server_gui.run_gui(STATE, {"console": console_url, "dashboard": dashboard_url})
            server.shutdown()
            server.server_close()
        else:
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
