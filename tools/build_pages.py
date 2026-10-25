"""Stage only the public host, preserving the original imported snapshot."""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from serve import verify_snapshot


def build(destination):
    verify_snapshot()
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Pages output must be a new directory")
    shutil.copytree(ROOT / "relapse", destination / "relapse")
    shutil.copytree(ROOT / "diagnostics", destination / "diagnostics")
    # GitHub Pages selects MIME by extension; use the conventional AppCache suffix.
    entry = destination / "relapse/index.html"
    html = entry.read_bytes()
    original = b'manifest="cache3.appcache3"'
    assert html.count(original) == 1
    entry.write_bytes(html.replace(original, b'manifest="cache.appcache"'))
    shutil.copyfile(destination / "relapse/cache3.appcache3", destination / "relapse/cache.appcache")
    (destination / ".nojekyll").touch()
    (destination / "index.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url=relapse/">'
        '<title>PS5Expweb</title><a href="relapse/">Open Relapse for PS5</a></html>\n',
        encoding="utf-8")
    print(f"Pages artifact: {destination}")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build/pages")
