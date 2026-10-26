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
            self.assertIn(b"__appcacheSettled", handler)
            site = (relapse / "src/site.js").read_bytes()
            self.assertIn(b"__exploitRunning", site)
            self.assertIn(b"__appcacheSettled", site)
            manifest = (relapse / "cache.appcache").read_bytes()
            self.assertIn(b"appcache_handler.js", manifest)
            self.assertIn(b"src/site.js", manifest)
            # Payload ELFs must NOT be cached: AppCache serves the old copy of
            # a listed file while an update downloads, so a chain that starts
            # mid-update would run stale payloads -- the second-boot crash.
            # With them out of the manifest, fetch() always hits the network.
            self.assertNotIn(b"payloads/kstuff.elf", manifest)
            self.assertNotIn(b"payloads/pldmgr.elf", manifest)
            self.assertNotIn(b"payloads/shadowmountplus.elf", manifest)
            self.assertNotIn(b"payloads/elfldr-ps5-1360.elf", manifest)

    def test_manifest_update_stays_small_and_payload_handoff_is_reported(self):
        # "Kernel exploit passes but the game does not load" had three causes:
        # a ~6 MB manifest update that lost the race against the auto-running
        # chain, an already-jailbroken path that returned without delivering
        # payloads, and payload failures swallowed so a failed handoff reported
        # success. Each invariant below must ship in the staged Pages tree.
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            stage_stable(output)
            relapse = output / "relapse"
            manifest = (relapse / "cache.appcache").read_bytes()

            # The two loading GIFs are 5.74 MB of the old ~6.08 MB update. They
            # are decorative and served over NETWORK: *, so listing them only
            # makes the cache update too big to converge before the chain arms.
            self.assertNotIn(b"loading-astro.gif", manifest)
            self.assertNotIn(b"loading-astro3.gif", manifest)
            # A ~600 KB update is the point; keep the manifest honest.
            self.assertLess(len(manifest), 4096)

            # The build stamp and the manifest version must agree, or the
            # "check the build stamp" recovery protocol names the wrong build
            # and a cached console never converges.
            site = (relapse / "src/site.js").read_bytes()
            stamp = site.split(b'const BUILD = "', 1)[1].split(b'";', 1)[0]
            self.assertIn(b"# version " + stamp + b" #", manifest)

            # The handoff must report failures instead of returning quietly:
            # a run that delivers no payload cannot load a game.
            main = (relapse / "src/main.js").read_bytes()
            self.assertIn(b"ps5expweb_payload_pending", main)
            self.assertIn(b"payloadDeliveryPending", main)
            self.assertIn(b"payloads did not load", main)
            self.assertIn(b"elfldr did not come up", main)
            # The already-jailbroken path retries a pending handoff rather than
            # returning without sending pldmgr.elf to the running loader.
            self.assertIn(b"previous payload handoff did not finish", main)

            # A single dropped request on the multi-megabyte payload used to
            # end the run; the fetch retries before giving up.
            kexp = (relapse / "src/kexp.js").read_bytes()
            self.assertIn(b"fetchBinaryOnce", kexp)
            self.assertIn(b"const attempts = 3", kexp)


if __name__ == "__main__":
    unittest.main()
