"""HTTP integration checks; never execute the console exploit."""

import hashlib
import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from serve import ROOT, RelapseHandler, snapshot_files, verify_snapshot


class QuietHandler(RelapseHandler):
    def log_message(self, *args):
        pass


class HostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            conn.request(method, path)
            response = conn.getresponse()
            return response.status, response.headers, response.read()
        finally:
            conn.close()

    def test_snapshot_integrity(self):
        self.assertEqual(verify_snapshot(), (56, 55))

    def test_entry_redirects_to_relapse(self):
        for path in ("/", "/index.html", "/relapse"):
            status, headers, body = self.request(path)
            self.assertEqual(status, 302)
            self.assertEqual(headers["Location"], "/relapse/")
        status, _, body = self.request("/relapse/")
        self.assertEqual(status, 200)
        self.assertIn(b'manifest="cache3.appcache3"', body)

    def test_every_asset_serves_exact_bytes_and_mime(self):
        for item in snapshot_files():
            with self.subTest(path=item["path"]):
                status, headers, body = self.request("/relapse/" + item["path"])
                self.assertEqual(status, 200)
                self.assertEqual(hashlib.sha256(body).hexdigest(), item["sha256"])
                self.assertEqual(int(headers["Content-Length"]), item["bytes"])
                if item["path"].endswith(".js"):
                    self.assertEqual(headers["Content-Type"], "application/javascript")
                if item["path"].endswith(".appcache3"):
                    self.assertEqual(headers["Content-Type"], "text/cache-manifest")
                    self.assertNotIn("no-store", headers["Cache-Control"])

    def test_head_query_and_private_paths(self):
        status, _, body = self.request("/relapse/src/firmware.js?check=1", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        for path in ("/.git/config", "/serve.py", "/relapse/../README.md",
                     "/relapse/%2e%2e/README.md", "/relapse/src/", "/relapse/missing.js"):
            self.assertEqual(self.request(path)[0], 404, path)

    def test_diagnostics_delivery_and_restrictions(self):
        status, headers, _ = self.request("/diagnostics")
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/diagnostics/")
        status, _, body = self.request("/diagnostics/")
        self.assertEqual(status, 200)
        self.assertIn(b'./host.js', body)
        self.assertNotIn(b'type="module"', body)
        self.assertEqual(self.request("/diagnostics/host.js")[0], 200)
        for path in ("/diagnostics/missing", "/diagnostics/../README.md", "/diagnostics/%2e%2e/serve.py"):
            self.assertEqual(self.request(path)[0], 404)


class QuietStagedHandler(RelapseHandler):
    """Staged-mode handler with request logging suppressed."""

    staged = True
    staged_root = None

    def log_message(self, *args):
        pass


class StagedHostTests(unittest.TestCase):
    """Verify --staged serves the generated Pages tree, not the pinned snapshot."""

    @classmethod
    def setUpClass(cls):
        import tempfile

        from tools.stage_stable import stage

        cls.tmp = Path(tempfile.mkdtemp(prefix="staged-host-"))
        cls.tree = stage(cls.tmp / "pages")
        QuietStagedHandler.staged_root = cls.tree.resolve()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietStagedHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        QuietStagedHandler.staged = False
        QuietStagedHandler.staged_root = None
        import shutil

        shutil.rmtree(cls.tmp, ignore_errors=True)

    def request(self, path, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        try:
            conn.request(method, path)
            response = conn.getresponse()
            return response.status, response.headers, response.read()
        finally:
            conn.close()

    def test_root_serves_generated_redirect_page(self):
        # The staged tree's own index.html is a meta-refresh to relapse/, so the
        # server must serve that file rather than short-circuit with a 302.
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertIn(b"relapse/", body)

    def test_relapse_serves_staged_manifest_name(self):
        status, _, body = self.request("/relapse/")
        self.assertEqual(status, 200)
        # stage_stable.py rewrites the manifest attribute to cache.appcache.
        self.assertIn(b'manifest="cache.appcache"', body)
        self.assertNotIn(b'manifest="cache3.appcache3"', body)

    def test_staged_manifest_and_payload_are_served(self):
        status, headers, body = self.request("/relapse/cache.appcache")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/cache-manifest")
        # The manifest must be served byte-identical to the source manifest:
        # any drift here and consoles would cache a tree the site no longer
        # ships. Its version line changes with every fix, so assert on the
        # structure, not on a specific version tag.
        self.assertEqual(body, (ROOT / "relapse-stable/cache3.appcache3").read_bytes())
        self.assertTrue(body.startswith(b"CACHE MANIFEST"))

        status, headers, _ = self.request("/relapse/payloads/pldmgr.elf", "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/octet-stream")

    def test_staged_mode_still_blocks_escapes(self):
        for path in ("/../serve.py", "/relapse/../../serve.py",
                     "/relapse/%2e%2e/%2e%2e/serve.py", "/relapse/missing.js"):
            self.assertEqual(self.request(path)[0], 404, path)


if __name__ == "__main__":
    unittest.main()
