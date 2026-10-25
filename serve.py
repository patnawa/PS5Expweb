"""Serve the pinned Relapse snapshot on a local network (Python 3.9+)."""

import argparse
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
SNAPSHOT = ROOT / "relapse"
PROVENANCE = ROOT / "docs/sources/mour0ne-snapshot.json"


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


class RelapseHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".appcache3": "text/cache-manifest",
        ".js": "application/javascript",
        ".elf": "application/octet-stream",
        ".bin": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        self.allowed = {"/relapse/" + item["path"] for item in snapshot_files()}
        self.allowed.update({"/diagnostics/index.html", "/diagnostics/host.js"})
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        path = unquote(urlsplit(self.path).path)
        if path in ("/", "/index.html", "/relapse"):
            self.send_response(302)
            self.send_header("Location", "/relapse/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if path == "/relapse/":
            path += "index.html"
        if path == "/diagnostics":
            self.send_response(302)
            self.send_header("Location", "/diagnostics/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if path == "/diagnostics/":
            path += "index.html"
        target = (ROOT / path.lstrip("/")).resolve()
        public_root = ROOT / "diagnostics" if path.startswith("/diagnostics/") else SNAPSHOT
        if path not in self.allowed or not target.is_relative_to(public_root.resolve()):
            self.send_error(404, "Not a snapshot asset")
            return None
        return super().send_head()

    def end_headers(self):
        # Revalidate changes online while allowing legacy Application Cache storage.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0", help="Bind address (default: all interfaces)")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--check", action="store_true", help="Verify snapshot and exit")
    args = parser.parse_args()
    try:
        files, assets = verify_snapshot()
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Snapshot verification failed: {error}\n")
    print(f"Verified {files} file hashes and {assets} offline assets.", flush=True)
    if args.check:
        return
    with ThreadingHTTPServer((args.bind, args.port), RelapseHandler) as server:
        print(f"Local preview: http://127.0.0.1:{server.server_port}/relapse/", flush=True)
        print(f"PS5: http://<this-PC-LAN-IP>:{server.server_port}/relapse/", flush=True)
        print("The imported page starts automatically on a supported PS5. Ctrl+C stops the host.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
