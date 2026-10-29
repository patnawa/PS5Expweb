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

    def test_teardown_drains_aio_requests_before_closing_descriptors(self):
        # "The kernel exploit passes but the console freezes when a game is
        # launched or the console is restarted" is a kernel-AIO leak. Y2JB's
        # cleanup() (ps5-y2jb-autoloader src/lapse.js) closes its descriptors
        # and then calls aio_multi_wait + aio_multi_delete so nothing is left
        # in p_aioinfo for the kernel's close path to walk. Ours zeroed the
        # group waiters and left every submitted request in the table, so the
        # close path walked a defused group with live requests and hung.
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            stage_stable(output)
            exploit = (output / "relapse/src/relapse_exploit.js").read_bytes()

            # aio_multi_delete (0x296) must be reachable: it is the only call
            # that removes a request from the process AIO table.
            self.assertIn(b"aioMultiDelete: 0x296", exploit)
            # The drain must exist and be wired into the teardown status.
            self.assertIn(b"drainAioRequests()", exploit)
            self.assertIn(b"aio: await this.drainAioRequests()", exploit)
            # Ordering is the fix: descriptors close first so pending reads
            # complete with an error before the delete runs. Reversing these
            # two lines reintroduces the hang.
            scratch_at = exploit.index(b"scratch: await this.closeScratchDescriptors()")
            aio_at = exploit.index(b"aio: await this.drainAioRequests()")
            self.assertLess(
                scratch_at,
                aio_at,
                "closeScratchDescriptors() must run before drainAioRequests()",
            )
            # A drain that fails must make the teardown INCOMPLETE, not report
            # "closing the app is safe".
            self.assertIn(b'const critical = ["escalation", "pipes", "aio", "workers", "scratch"]', exploit)

    def test_failcheck_marker_blocks_a_second_run_in_the_same_boot(self):
        # Y2JB writes /<nid>/common_temp/lapse.fail at the start of a run and
        # refuses to run while it exists: "Restart your PS5 to run Lapse again"
        # (src/lapse.js:1724). A run that arms the kernel and dies mid-chain
        # leaves AIO groups and pipes dirty; re-arming over that dirt panics.
        # The uid and elfldr guards only catch the case where escalation
        # finished, so a run that died before escalating slips past both.
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            stage_stable(output)
            exploit = (output / "relapse/src/relapse_exploit.js").read_bytes()
            main = (output / "relapse/src/main.js").read_bytes()

            # randomized_path (0x25a) is how Y2JB derives the app's sandbox
            # directory for the marker. Without it there is no path to write.
            self.assertIn(b"randomizedPath: 0x25a", exploit)
            # The marker must be checked and written.
            self.assertIn(b"failedInThisBoot()", exploit)
            self.assertIn(b"markRunStarted()", exploit)
            self.assertIn(b"common_temp/lapse.fail", exploit)
            # Ordering: the marker check must run before the chain arms.
            guard_at = exploit.index(b"await this.failedInThisBoot()")
            arm_at = exploit.index(b'cstage("kexploit:leak-kbase")')
            self.assertLess(
                guard_at,
                arm_at,
                "the failcheck guard must run before the chain arms",
            )
            # A guard that fires before arming must not trigger rescue(): kbase
            # is still null there, so restoreOids() would call kaddr() on null
            # and report a false POWER-CYCLE failure.
            self.assertIn(b"this.teardownClean = true;", exploit)
            # The marker must NEVER be deleted (2026-10-29a). Deleting it after
            # a clean teardown re-opened the same-boot re-arm: restoreOids()
            # leaves the OID kinds/arg1 steering hijacked until reboot by
            # design, so a clean kernel is not a re-arm-safe kernel, and the
            # re-arm is the "one success, then crash" alternation. Y2JB never
            # deletes it either; the reboot clears it with common_temp.
            self.assertNotIn(b"deleteMarker", exploit)
            self.assertNotIn(b"SYS.unlink", exploit)
            # main.js must name the reboot instruction instead of the generic
            # "kernel exploit did not finish".
            self.assertIn(b"failedInThisBoot", main)
            self.assertIn(
                b"the kernel was already patched in this boot - restart the console, then launch again",
                main,
            )


    def test_chain_refuses_to_arm_when_the_build_cannot_be_verified(self):
        # The 2026-10-26n console crash: the cached build failed its network
        # checks ("AppCache check failed; continuing"), armed the stale chain
        # anyway, and the WebKit exploit crashed the console before any payload
        # could load. The freshness guard must stop the chain before arming
        # whenever the host manifest cannot confirm the running build.
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            stage_stable(output)
            site = (output / "relapse/src/site.js").read_bytes()

            self.assertIn(b"verifyBuildFreshness", site)
            # The guard must run before the chain is marked live, so a refusal
            # leaves the same safe state as the stale-abort path.
            guard_at = site.index(b"const freshness = await verifyBuildFreshness()")
            arm_at = site.index(b"window.__exploitRunning = true")
            self.assertLess(
                guard_at,
                arm_at,
                "the freshness guard must run before the chain is marked live",
            )
            # All three unverifiable outcomes refuse, each with instructions:
            # dead network, unparsable manifest, and a version mismatch.
            self.assertIn(b"Network unreachable after 3 tries", site)
            self.assertIn(b"no readable version line", site)
            self.assertIn(b"the cache update did not land", site)
            # The fetch must go to the network (cache-busting query), and the
            # comparison must be against the running build.
            self.assertIn(b'"fresh=" + Date.now()', site)
            self.assertIn(b"hostVersion !== BUILD", site)
            # The refusal return must be recognized by the run() consumer and
            # leave nothing armed.
            self.assertIn(b'return "freshness-abort"', site)
            self.assertIn(b'result === "freshness-abort"', site)


    def test_staged_tree_ships_the_launcher(self):
        # The shortcut client opens /app/: a small offline-cached launcher with
        # the jailbreak, clear-cache and diagnostics choices. The staged tree
        # must ship it; its cache manifest must be self-contained; and the
        # links must be relative so the same bytes work on Pages (project-site
        # subpath) and on serve.py (root path).
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "pages"
            stage_stable(output)
            app = output / "app"
            self.assertTrue((app / "index.html").is_file())
            self.assertTrue((app / "launcher.appcache").is_file())
            html = (app / "index.html").read_bytes()
            manifest = (app / "launcher.appcache").read_bytes()
            self.assertIn(b'manifest="launcher.appcache"', html)
            self.assertIn(b"index.html", manifest)  # caches itself: opens offline
            self.assertNotIn(b"relapse", manifest)  # self-contained: own cache group
            self.assertIn(b'href="../relapse/"', html)
            self.assertIn(b'href="../relapse/reset-cache/"', html)
            self.assertIn(b'href="../diagnostics/"', html)
            # Absolute /relapse/ links would break under the Pages subpath.
            self.assertNotIn(b'href="/relapse/', html)


if __name__ == "__main__":
    unittest.main()
