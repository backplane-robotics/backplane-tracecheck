"""Tests for 0.2 features: compression safety, streaming, fast mode, CRC policy, gap tracking."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from mcap.writer import CompressionType, Writer

from tracecheck.contract import ContractError, validate
from tracecheck.engine import analyze_bag, analyze_bytes, analyze_file
from tracecheck.reader import Limits, MiB
from tracecheck.samples import CONTRACT, FLEET_CONTRACT, generate, write_fleet_sample, write_sample

ROOT = Path(__file__).resolve().parents[1]


def chunk_offsets(data):
    out, p = [], 8
    while p < len(data) - 8:
        op, n = data[p], int.from_bytes(data[p + 1 : p + 9], "little")
        if op == 6:
            out.append(p)
        if op == 2:
            break
        p += 9 + n
    return out


def statuses(r):
    return {x["id"]: x["status"] for x in r["checks"]}


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.c = copy.deepcopy(CONTRACT)
        self.t = self.c["topics"]["/demo/position"]

    def tearDown(self):
        self.temp.cleanup()

    def sample(self, name="s.mcap", **kw):
        p = self.root / name
        write_sample(p, **kw)
        return p


class CompressionTests(Base):
    def test_declared_size_above_limit_rejected_before_decompression(self):
        p = self.sample(compression=CompressionType.ZSTD)
        r = analyze_file(p, self.c, limits=Limits(max_chunk_uncompressed_bytes=16))
        self.assertFalse(r["scan_complete"])
        self.assertIn("above the 16 byte limit", r["checks"][0]["findings"][0]["detail"])

    def test_declared_size_smaller_than_real_output_rejected(self):
        for codec in [CompressionType.ZSTD, CompressionType.LZ4]:
            with self.subTest(codec=codec):
                data = bytearray(self.sample(compression=codec, crc=False).read_bytes())
                off = chunk_offsets(bytes(data))[0]
                size = int.from_bytes(data[off + 9 + 16 : off + 9 + 24], "little")
                data[off + 9 + 16 : off + 9 + 24] = (size - 1).to_bytes(8, "little")
                r = analyze_bytes(bytes(data), self.c)
                self.assertFalse(r["scan_complete"])
                self.assertIn("differs from declared", r["checks"][0]["findings"][0]["detail"])

    def test_corrupt_compressed_payload_fails_cleanly(self):
        for codec in [CompressionType.ZSTD, CompressionType.LZ4]:
            with self.subTest(codec=codec):
                data = bytearray(self.sample(compression=codec, crc=False).read_bytes())
                off = chunk_offsets(bytes(data))[0]
                n = int.from_bytes(data[off + 1 : off + 9], "little")
                for i in range(off + 60, off + 9 + n):
                    data[i] ^= 0x5A
                r = analyze_bytes(bytes(data), self.c)
                self.assertFalse(r["scan_complete"])
                self.assertEqual(r["checks"][0]["status"], "fail")

    def test_compression_counts_reported(self):
        r = analyze_file(self.sample(compression=CompressionType.LZ4), self.c)
        self.assertEqual(r["compression"], {"lz4": 1})


class CrcPolicyTests(Base):
    def test_missing_crc_warns_by_default_and_ignore_passes(self):
        p = self.sample(compression=CompressionType.ZSTD, crc=False)
        r = analyze_file(p, self.c)
        self.assertEqual(r["checks"][0]["status"], "warn")
        self.assertEqual(r["checksum_coverage"]["chunk_absent"], 1)
        self.c["missing_crc"] = "ignore"
        r = analyze_file(p, self.c)
        self.assertEqual(r["overall"], "pass")
        self.assertEqual(r["checks"][0]["findings"][0]["missing_crc_policy"], "ignore")

    def test_unknown_records_still_warn_when_crc_ignored(self):
        self.c["missing_crc"] = "ignore"
        data = self.sample(chunked=False, crc=False).read_bytes()
        off = 8 + 9 + int.from_bytes(data[9:17], "little")
        rec = bytes([0x80]) + (3).to_bytes(8, "little") + b"abc"
        r = analyze_bytes(data[:off] + rec + data[off:], self.c)
        self.assertEqual(r["checks"][0]["status"], "warn")

    def test_contract_rejects_bad_policy(self):
        with self.assertRaises(ContractError):
            validate(dict(self.c, missing_crc="maybe"))

    def test_summary_crc_verified_and_corruption_detected(self):
        p = self.sample()
        r = analyze_file(p, self.c)
        self.assertEqual(r["checksum_coverage"]["summary"], "verified")
        data = bytearray(p.read_bytes())
        summary_start = int.from_bytes(data[-8 - 20 : -8 - 12], "little")
        data[summary_start + 12] ^= 0xFF  # inside the first summary record
        for fast in (False, True):
            with self.subTest(fast=fast):
                r = analyze_bytes(bytes(data), self.c, fast=fast)
                self.assertFalse(r["scan_complete"])


class FastModeTests(Base):
    def test_fast_mode_clean(self):
        r = analyze_file(self.sample(compression=CompressionType.ZSTD), self.c, fast=True)
        self.assertEqual(r["scan_mode"], "fast")
        self.assertTrue(r["scan_complete"])
        self.assertIsNone(r["source"]["sha256"])
        s = statuses(r)
        self.assertEqual([s[f"C{i:02}"] for i in range(1, 6)], ["pass"] * 5)
        self.assertEqual([s[f"C{i:02}"] for i in range(6, 11)], ["skipped"] * 5)
        self.assertEqual(r["inventory"][0]["message_count"], 11)
        self.assertEqual(r["overall"], "pass")

    def test_fast_mode_faults_counts_and_metadata(self):
        r = analyze_file(self.sample(fault=True), self.c, fast=True)
        s = statuses(r)
        self.assertEqual((s["C04"], s["C05"]), ("fail", "fail"))

    def test_fast_mode_falls_back_without_summary(self):
        f = self.root / "nosummary.mcap"
        with f.open("wb") as fh:
            w = Writer(fh, use_statistics=False, use_summary_offsets=False, repeat_channels=False,
                       repeat_schemas=False)  # fmt: skip
            w.start()
            cid = w.register_channel("/demo/position", "json", 0)
            w.add_message(cid, 0, b"{}", 0)
            w.finish()
        r = analyze_file(f, self.c, fast=True)
        self.assertEqual(r["scan_mode"], "full")
        self.assertIn("fast_mode_fallback", r)
        self.assertIsNotNone(r["source"]["sha256"])

    def test_fast_mode_truncated_fails(self):
        data = self.sample().read_bytes()[:-12]
        self.assertFalse(analyze_bytes(data, self.c, fast=True)["scan_complete"])


class GapTrackingTests(Base):
    def test_out_of_order_gap_uses_sorted_neighbours(self):
        # Sorted: 0, 100ms, 300ms -> one 200 ms interior gap above the 100 ms limit.
        p = self.sample(times=[0, 300_000_000, 100_000_000])
        r = analyze_file(p, self.c)
        f = r["checks"][6]["findings"][0]
        self.assertEqual(f["status"], "fail")
        self.assertEqual(f["evidence_count"], 1)
        ev = f["evidence"][0]
        self.assertEqual((ev["previous"]["message_ordinal"], ev["current"]["message_ordinal"]), (3, 2))
        self.assertEqual(ev["gap_ns"], 200_000_000)

    def test_in_order_and_sorted_paths_agree(self):
        times = [0, 100, 250, 260, 600]
        a = analyze_file(self.sample("a.mcap", times=times), dict(self.c, topics={"/demo/position": {
            "clock_confirmed": True, "max_gap_ns": 100}}))  # fmt: skip
        shuffled = [0, 600, 100, 260, 250]
        b = analyze_file(self.sample("b.mcap", times=shuffled), dict(self.c, topics={"/demo/position": {
            "clock_confirmed": True, "max_gap_ns": 100}}))  # fmt: skip
        fa, fb = a["checks"][6]["findings"][0], b["checks"][6]["findings"][0]
        self.assertEqual(fa["evidence_count"], fb["evidence_count"])
        self.assertEqual([e["gap_ns"] for e in fa["evidence"]], [e["gap_ns"] for e in fb["evidence"]])

    def test_tracked_message_limit(self):
        r = analyze_file(self.sample(), self.c, limits=Limits(max_tracked_messages=3))
        self.assertFalse(r["scan_complete"])
        self.assertIn("max_tracked_messages", r["checks"][0]["findings"][0]["detail"])

    def test_untracked_topics_cost_no_timestamp_memory(self):
        c = dict(self.c, topics={"/other": {"required": False}})
        r = analyze_file(self.sample(), c, limits=Limits(max_tracked_messages=0))
        self.assertTrue(r["scan_complete"])


class StreamingTests(Base):
    def test_fleet_dropout_detected_on_scan_topic_only(self):
        p = self.root / "fleet.mcap"
        write_fleet_sample(p, seconds=12, compression=CompressionType.LZ4, dropout=("/scan", 4, 6))
        r = analyze_file(p, FLEET_CONTRACT)
        gap_fail = [f["topic"] for f in r["checks"][6]["findings"] if f["status"] == "fail"]
        self.assertEqual(gap_fail, ["/scan"])
        self.assertEqual(r["checks"][1]["status"], "pass")

    def test_file_larger_than_old_64_mib_cap(self):
        p = self.root / "big.mcap"
        write_fleet_sample(p, seconds=10, compression=CompressionType.NONE, payload_scale=12, chunk_size=4 * MiB)
        self.assertGreater(p.stat().st_size, 64 * MiB)
        seen = []
        r = analyze_file(p, FLEET_CONTRACT, progress=lambda done, total: seen.append(done))
        self.assertTrue(r["scan_complete"], r["checks"][0]["findings"][0])
        self.assertEqual(r["overall"], "pass")
        self.assertTrue(seen)
        self.assertEqual(r["source"]["bytes"], p.stat().st_size)
        fast = analyze_file(p, FLEET_CONTRACT, fast=True)
        self.assertEqual(fast["scan_mode"], "fast")
        self.assertEqual([x["message_count"] for x in fast["inventory"]], [x["message_count"] for x in r["inventory"]])

    def test_timeout_limit(self):
        p = self.root / "fleet.mcap"
        write_fleet_sample(p, seconds=10)
        r = analyze_file(p, FLEET_CONTRACT, limits=Limits(max_seconds=0))
        self.assertFalse(r["scan_complete"])
        self.assertIn("scan time exceeds", r["checks"][0]["findings"][0]["detail"])

    def test_ros2_qos_metadata_longer_than_1024_chars_accepted(self):
        f = self.root / "qos.mcap"
        with f.open("wb") as fh:
            w = Writer(fh)
            w.start(profile="ros2")
            cid = w.register_channel("/demo/position", "json", 0, {"offered_qos_profiles": "- history: 3\n" * 400})
            w.add_message(cid, 0, b"{}", 0)
            w.finish()
        r = analyze_file(f, self.c)
        self.assertTrue(r["scan_complete"], r["checks"][0]["findings"][0])


class GoldenTests(unittest.TestCase):
    """examples/expected.json is the shared truth for the Python and browser implementations."""

    def test_examples_match_expected(self):
        expected = json.loads((ROOT / "examples" / "expected.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as td:
            generate(Path(td))
            for case in expected["cases"]:
                with self.subTest(case=case["file"], fast=case.get("fast", False)):
                    contract = json.loads((Path(td) / case["contract"]).read_text(encoding="utf-8"))
                    analyze = analyze_bag if case.get("bag") else analyze_file
                    r = analyze(Path(td) / case["file"], contract, fast=case.get("fast", False))
                    self.assertEqual(r["overall"], case["overall"])
                    self.assertEqual(r["scan_complete"], case["scan_complete"])
                    self.assertEqual(statuses(r), case["checks"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
