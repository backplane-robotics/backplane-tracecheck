"""Tests for incomplete (cut-off) recordings: specific finding plus a recovered summary."""

import copy
import tempfile
import unittest
from pathlib import Path

from mcap.writer import CompressionType

from tracecheck.engine import analyze_bytes, analyze_file
from tracecheck.samples import CONTRACT, FLEET_CONTRACT, write_fleet_sample, write_sample


def statuses(r):
    return {x["id"]: x["status"] for x in r["checks"]}


class TruncatedRecordingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        write_fleet_sample(root / "fleet.mcap", seconds=20, compression=CompressionType.ZSTD)
        cls.fleet = (root / "fleet.mcap").read_bytes()
        cls.full = analyze_bytes(cls.fleet, FLEET_CONTRACT)
        write_sample(root / "demo.mcap")
        cls.demo = (root / "demo.mcap").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_cut_inside_message_data_reports_recovered_messages(self):
        r = analyze_bytes(self.fleet[: len(self.fleet) // 2], FLEET_CONTRACT)
        self.assertFalse(r["scan_complete"])
        self.assertEqual(r["overall"], "fail")
        c01 = r["checks"][0]["findings"][0]
        self.assertTrue(c01["truncated"])
        self.assertIn("Recording is incomplete", c01["detail"])
        self.assertIn("ends inside its message data", c01["detail"])
        rec = r["recovered"]
        self.assertFalse(rec["data_section_complete"])
        total = self.full["scan_stats"]["messages"]
        self.assertGreater(rec["messages"], 0)
        self.assertLess(rec["messages"], total)
        self.assertEqual(sum(t["message_count"] for t in rec["topics"]), rec["messages"])
        self.assertEqual(rec["log_time_span_ns"], rec["log_time_last"] - rec["log_time_first"])
        self.assertLessEqual(rec["complete_bytes"], rec["file_bytes"])
        # Other checks are skipped, never evaluated on partial data.
        self.assertEqual({k for k, v in statuses(r).items() if v != "skipped"}, {"C01"})
        self.assertIn("not evaluated on the partial data", r["checks"][1]["findings"][0]["detail"])

    def test_more_bytes_never_recover_fewer_messages(self):
        counts = [analyze_bytes(self.fleet[: len(self.fleet) * p // 10], FLEET_CONTRACT)["recovered"]["messages"]
                  for p in range(2, 10)]  # fmt: skip
        self.assertEqual(counts, sorted(counts))

    def test_cut_in_footer_reports_all_data_read(self):
        r = analyze_bytes(self.demo[:-12], CONTRACT)
        rec = r["recovered"]
        self.assertTrue(rec["data_section_complete"])
        full = analyze_bytes(self.demo, CONTRACT)
        self.assertEqual(rec["messages"], full["scan_stats"]["messages"])
        self.assertIn("All message data was read", r["checks"][0]["findings"][0]["detail"])

    def test_cut_before_any_message(self):
        r = analyze_bytes(self.fleet[:40], FLEET_CONTRACT)
        rec = r["recovered"]
        self.assertEqual(rec["messages"], 0)
        self.assertIsNone(rec["log_time_first"])
        self.assertIsNone(rec["log_time_span_ns"])

    def test_fast_mode_falls_back_and_recovers(self):
        r = analyze_bytes(self.fleet[: len(self.fleet) // 2], FLEET_CONTRACT, fast=True)
        self.assertEqual(r["scan_mode"], "full")
        self.assertIn("may be incomplete", r["fast_mode_fallback"])
        self.assertIn("recovered", r)

    def test_hash_covers_whole_file(self):
        import hashlib

        data = self.fleet[: len(self.fleet) // 2]
        self.assertEqual(analyze_bytes(data, FLEET_CONTRACT)["source"]["sha256"], hashlib.sha256(data).hexdigest())

    def test_non_truncation_errors_keep_generic_finding(self):
        r = analyze_bytes(b"not an MCAP recording\x00", CONTRACT)
        self.assertNotIn("recovered", r)
        self.assertIn("bad magic", r["checks"][0]["findings"][0]["detail"])
        self.assertIn("Scan incomplete", r["checks"][1]["findings"][0]["detail"])

    def test_example_file(self):
        root = Path(__file__).resolve().parents[1] / "examples"
        r = analyze_file(root / "interrupted-zstd.mcap", copy.deepcopy(FLEET_CONTRACT))
        self.assertIn("recovered", r)
        self.assertEqual(len(r["recovered"]["topics"]), 4)


if __name__ == "__main__":
    unittest.main()
