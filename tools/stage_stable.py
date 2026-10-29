"""Stage the stable Relapse host and diagnostics for GitHub Pages.

The original imported snapshot stays untouched in relapse/ (its hashes are
verified by the test suite). This script stages the patched relapse-stable/
tree as /relapse/ so the browser shortcut package can load the hardened
loader, plus the inert diagnostics page as /diagnostics/.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def stage(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Pages output must be a new directory")

    # Stable exploit host at /relapse/
    shutil.copytree(ROOT / "relapse-stable", destination / "relapse")

    # Launcher at /app/: a small offline-cached page the shortcut client opens,
    # with the jailbreak / clear-cache / diagnostics choices. Relative links
    # only, so the same bytes work on Pages (/PS5Expweb/app/) and on serve.py.
    shutil.copytree(ROOT / "relapse-stable" / "app", destination / "app")

    # GitHub Pages selects MIME by extension; use the conventional AppCache suffix.
    entry = destination / "relapse/index.html"
    html = entry.read_bytes()
    original = b'manifest="cache3.appcache3"'
    assert html.count(original) == 1
    entry.write_bytes(html.replace(original, b'manifest="cache.appcache"'))
    shutil.copyfile(destination / "relapse/cache3.appcache3", destination / "relapse/cache.appcache")

    # Inert diagnostics page at /diagnostics/
    (destination / "diagnostics").mkdir(parents=True)
    for name in ("index.html", "host.js"):
        shutil.copyfile(ROOT / "diagnostics" / name, destination / "diagnostics" / name)

    (destination / ".nojekyll").touch()
    (destination / "index.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url=relapse/">'
        '<title>PS5Expweb</title><a href="relapse/">Open Relapse for PS5</a></html>\n',
        encoding="utf-8")
    print(f"Pages artifact: {destination}")
    return destination


if __name__ == "__main__":
    print(stage(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build/pages"))
