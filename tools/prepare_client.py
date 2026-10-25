"""Prepare a new shortcut from this project's original package, without editing it."""
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def prepare(package, destination, config):
    data = Path(package).read_bytes()
    if hashlib.sha256(data).hexdigest() != config["originalSha256"]:
        raise ValueError("Original package SHA-256 does not match the inspected client")
    url = urlsplit(config["url"])
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise ValueError("Client URL must be an HTTP(S) URL without credentials")
    if config["contentId"].split("-")[1].split("_")[0] != config["titleId"]:
        raise ValueError("Title ID and content ID must agree")
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Client source output must be a new directory")
    with zipfile.ZipFile(package) as archive:
        xml = ET.fromstring(archive.read("common/etc/pfsimage.xml"))
    base = int(xml.find("mount-image/container-offset").text, 16)
    entries = {entry.attrib["name"]: entry.attrib for entry in xml.findall("entries/entry")}
    extracted = {}
    for name in ("param.json", "icon0.png", "pic0.png", "pic1.png"):
        item = entries[name]
        start, size = base + int(item["offset"], 16), int(item["size"], 16)
        if start < 0 or size < 1 or start + size > len(data):
            raise ValueError(f"Invalid metadata bounds: {name}")
        extracted[name] = data[start:start + size]
    param = json.loads(extracted["param.json"])
    param["deeplinkUri"] = config["url"]
    param["titleId"] = config["titleId"]
    param["contentId"] = config["contentId"]
    for language, values in param["localizedParameters"].items():
        if isinstance(values, dict) and "titleName" in values:
            values["titleName"] = config["title"]
    param.pop("pubtools", None)  # Original build timestamp is not ours.
    extracted["param.json"] = (json.dumps(param, ensure_ascii=False, indent=2) + "\n").encode()
    (destination / "sce_sys").mkdir(parents=True)
    for name, value in extracted.items():
        (destination / "sce_sys" / name).write_bytes(value)
    # The original package's supplemental file listing declares a zero-byte eboot.
    eboots = xml.findall(".//nested-image//file[@name='eboot.bin']")
    if len(eboots) != 1 or eboots[0].attrib.get("plain") != "0":
        raise ValueError("Original package does not declare the expected empty shortcut executable")
    (destination / "eboot.bin").write_bytes(b"")
    return param


if __name__ == "__main__":
    config = json.loads((ROOT / "client/config.json").read_text())
    package = ROOT / "mPS5XPLOIT-RELAPSE.pkg"
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "build/client-source"
    result = prepare(package, destination, config)
    print(f"Client source: {destination}\nDestination: {result['deeplinkUri']}")
