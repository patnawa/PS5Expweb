import json
import tempfile
import unittest
from pathlib import Path

from serve import ROOT, snapshot_files
from tools.build_pages import build
from tools.prepare_client import prepare
from tools.stage_diagnostics import stage
from tools.stage_stable import stage as stage_stable


class DistributionTests(unittest.TestCase):
    def test_standalone_site_excludes_exploit_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = stage(Path(temporary) / "site")
            self.assertEqual({str(p.relative_to(output)).replace('\\', '/')
                              for p in output.rglob('*') if p.is_file()},
                             {"index.html", ".nojekyll", "diagnostics/index.html", "diagnostics/host.js"})

    def test_pages_artifact_and_manifest_alias(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            build(output)
            self.assertEqual((output / "relapse/cache.appcache").read_bytes(),
                             (ROOT / "relapse/cache3.appcache3").read_bytes())
            self.assertIn(b'manifest="cache.appcache"', (output / "relapse/index.html").read_bytes())
            for entry in snapshot_files():
                if entry["path"] != "index.html":
                    self.assertEqual((output / "relapse" / entry["path"]).read_bytes(),
                                     (ROOT / "relapse" / entry["path"]).read_bytes())
            self.assertEqual({p.name for p in output.iterdir()}, {"relapse", "diagnostics", "index.html", ".nojekyll"})
            self.assertEqual((output / "diagnostics/host.js").read_bytes(),
                             (ROOT / "diagnostics/host.js").read_bytes())

    def test_client_targets_configured_pages_url(self):
        config = json.loads((ROOT / "client/config.json").read_text())
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "client"
            param = prepare(ROOT / "mPS5XPLOIT-RELAPSE.pkg", output, config)
            self.assertEqual(param["deeplinkUri"], config["url"])
            self.assertEqual(param["titleId"], config["titleId"])
            self.assertEqual(param["contentId"], config["contentId"])
            self.assertEqual((output / "eboot.bin").stat().st_size, 0)
            self.assertTrue((output / "sce_sys/icon0.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertNotIn("pubtools", param)
            with self.assertRaises(ValueError):
                prepare(ROOT / "mPS5XPLOIT-RELAPSE.pkg", output, config)

    def test_rejects_uninspected_package(self):
        config = json.loads((ROOT / "client/config.json").read_text())
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "unknown.pkg"
            package.write_bytes(b"not the inspected package")
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                prepare(package, Path(temporary) / "client", config)

    def test_staged_stable_tree_ships_second_boot_guard(self):
        # The second-boot panic happened because a fresh webview re-armed a
        # kernel that was already patched. The guard that refuses to do that
        # must ship in the Pages artifact CI deploys (tools/stage_stable.py),
        # not just in the source tree.
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            stage_stable(output)
            relapse = output / "relapse"
            exploit = (relapse / "src/relapse_exploit.js").read_bytes()
            self.assertIn(b"elfldrListening", exploit)
            self.assertIn(b"connect: 0x062", exploit)
            self.assertIn(b"refusing to re-arm", exploit)
            self.assertIn(b"alreadyJailbroken", (relapse / "src/main.js").read_bytes())
            # The cache handler must ship the safe-update logic, and the
            # manifest must list both changed scripts so consoles fetch them.
            handler = (relapse / "appcache_handler.js").read_bytes()
            self.assertIn(b"__exploitRunning", handler)
            self.assertIn(b"__exploitDone", handler)
            self.assertIn(b"__exploitRunning", (relapse / "src/site.js").read_bytes())
            manifest = (relapse / "cache.appcache").read_bytes()
            self.assertIn(b"appcache_handler.js", manifest)
            self.assertIn(b"src/site.js", manifest)


if __name__ == "__main__":
    unittest.main()
