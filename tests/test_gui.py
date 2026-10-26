import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from serve import ROOT, RelapseHandler, STATE
from server_gui import STAGES, collect_tree_info, dashboard_html, stage_for


class QuietHandler(RelapseHandler):
    def log_message(self, *args):
        pass


class GuiTests(unittest.TestCase):
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

    def status_json(self):
        status, headers, body = self.request("/_gui/status.json")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        return json.loads(body)

    def test_stage_mapping_matches_the_chain_file_order(self):
        self.assertEqual(stage_for("/relapse/"), 0)
        self.assertEqual(stage_for("/relapse/index.html"), 0)
        self.assertEqual(stage_for("/relapse/cache.appcache"), 1)
        self.assertEqual(stage_for("/relapse/src/site.js"), 2)
        self.assertEqual(stage_for("/relapse/offsets/13.60.js"), 2)
        self.assertEqual(stage_for("/relapse/payloads/elfldr-ps5-1360.elf?rv=x"), 4)
        self.assertEqual(stage_for("/relapse/payloads/kexp_2026_05_25.bin"), 4)
        self.assertEqual(stage_for("/relapse/payloads/pldmgr.elf?rv=x"), 5)
        self.assertIsNone(stage_for("/relapse/loading-astro.gif"))
        self.assertEqual(len(STAGES), 6)

    def test_status_json_reports_the_exploit_timeline(self):
        self.request("/relapse/")
        self.request("/relapse/src/site.js")
        self.request("/relapse/payloads/pldmgr.elf?rv=test")

        data = self.status_json()
        for key in ("build", "manifest_version", "mode", "url", "uptime_s",
                    "guards", "staged_files", "payloads", "totals", "clients",
                    "recent", "stages"):
            self.assertIn(key, data)

        self.assertGreaterEqual(data["totals"]["requests"], 3)
        self.assertTrue(data["clients"], "requests must be attributed to a console")
        client = next(c for c in data["clients"] if c["ip"] == "127.0.0.1")
        self.assertEqual(client["stage"], 5)
        self.assertTrue(client["complete"],
                        "a served pldmgr.elf means the chain completed")
        self.assertTrue(any(e["path"].startswith("/relapse/payloads/pldmgr.elf")
                            for e in client["timeline"]))

    def test_dashboard_serves_the_control_deck(self):
        status, headers, body = self.request("/_gui/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        page = body.decode()
        self.assertIn("RELAPSE", page)
        self.assertIn("Exploit status", page)
        self.assertIn("/_gui/status.json", page)
        self.assertIn("data:image/png;base64,", page)

    def test_dashboard_head_and_unknown_asset(self):
        status, _, _ = self.request("/_gui/", "HEAD")
        self.assertEqual(status, 200)
        status, _, _ = self.request("/_gui/nope")
        self.assertEqual(status, 404)

    def test_gui_polls_do_not_pollute_the_activity_feed(self):
        before = self.status_json()["totals"]["requests"]
        self.status_json()
        self.status_json()
        after = self.status_json()["totals"]["requests"]
        self.assertEqual(before, after, "/_gui/* must not count as console traffic")

    def test_collect_tree_info_reads_the_shipped_metadata(self):
        from tools.stage_stable import stage
        with tempfile.TemporaryDirectory() as temporary:
            tree = stage(Path(temporary) / "pages")
            build, version, payloads = collect_tree_info(tree)
        self.assertTrue(build and build != "-", "build stamp must parse from site.js")
        self.assertTrue(version and version != "-", "manifest version must parse")
        self.assertTrue(any(p["name"] == "pldmgr.elf" for p in payloads))
        self.assertTrue(all(p["sha256"] for p in payloads))

    def test_dashboard_template_embeds_the_brand_icon(self):
        self.assertIn("base64,", dashboard_html())


if __name__ == "__main__":
    unittest.main()