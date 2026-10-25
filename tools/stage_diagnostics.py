"""Stage the standalone diagnostic site without console exploit assets."""
import sys
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]


def stage(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Diagnostic output must be a new directory")
    (destination / "diagnostics").mkdir(parents=True)
    for name in ("index.html", "host.js"):
        shutil.copyfile(ROOT / "diagnostics" / name, destination / "diagnostics" / name)
    (destination / ".nojekyll").touch()
    (destination / "index.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url=diagnostics/">'
        '<title>PS5Expweb diagnostics</title>'
        '<a href="diagnostics/">Open host diagnostics</a></html>\n', encoding="utf-8")
    return destination


if __name__ == "__main__":
    print(stage(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build/diagnostic-site"))
