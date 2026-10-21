"""Tests for ROS 2 bag folders: metadata.yaml parsing, file planning, and checking split files as one recording."""

import io
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from tracecheck.__main__ import main
from tracecheck.bag import BagError, MetaError, parse_info, parse_yaml, plan
from tracecheck.engine import analyze_bag, analyze_file
from tracecheck.report import render
from tracecheck.samples import FLEET_CONTRACT, write_bag_sample, write_fleet_sample


def statuses(r):
    return {x["id"]: x["status"] for x in r["checks"]}


class BagMetadataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        write_bag_sample(Path(cls.temp.name) / "b", "b")
        cls.meta = (Path(cls.temp.name) / "b" / "metadata.yaml").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_parses_humble_metadata_including_quoted_qos(self):
        info = parse_info(self.meta)
        self.assertEqual(info["storage_identifier"], "mcap")
        self.assertEqual([f["name"] for f in info["files"]], ["b_0.mcap", "b_1.mcap", "b_2.mcap"])
        self.assertEqual(info["message_count"], sum(f["message_count"] for f in info["files"]))
        self.assertEqual(info["ros_distro"], "humble")
        topic = parse_yaml(self.meta)["rosbag2_bagfile_information"]["topics_with_message_count"][0]
        self.assertTrue(topic["topic_metadata"]["offered_qos_profiles"].startswith("- history: 3\n  depth: 0\n"))

    def test_parses_jazzy_style_nested_lists(self):
        doc = parse_yaml('a:\n  - x: 1\n    y:\n      - z: "q\\u00e9"\nb: {}\n')
        self.assertEqual(doc["a"][0]["y"][0]["z"], "qé")
        self.assertEqual(doc["b"], {})

    def test_rejects_unsupported_yaml(self):
        for bad in ["a: b\n  c: d", "\ta: 1", "a: 1\na: 2", 'x: "open', "x: [1, 2]", 'x: "\\ud800"', ""]:
            with self.subTest(bad=bad), self.assertRaises(MetaError):
                parse_yaml(bad)

    def test_rejects_bad_counts(self):
        with self.assertRaises(MetaError):
            parse_info(self.meta.replace("message_count: ", "message_count: -", 1))

    def test_natural_order_and_storage_refusals(self):
        self.assertEqual([f["name"] for f in plan("b", ["b_10.mcap", "b_2.mcap", "notes.txt"], None)["files"]],
                         ["b_2.mcap", "b_10.mcap"])  # fmt: skip
        with self.assertRaises(BagError):
            plan("b", ["b_0.mcap"], self.meta.replace("storage_identifier: mcap", "storage_identifier: sqlite3"))
        with self.assertRaises(BagError):
            plan("b", ["b_0.mcap"], self.meta.replace('compression_mode: ""', "compression_mode: FILE"))
        with self.assertRaises(BagError):
            plan("b", ["notes.txt"], None)

    def test_unreadable_metadata_is_reported_not_guessed(self):
        bag = plan("b", ["b_0.mcap"], "rosbag2_bagfile_information: [1]")
        self.assertEqual(bag["metadata"], "unreadable")
        self.assertIn("metadata_error", bag)
        self.assertIsNone(bag["files"][0]["listed"])


class BagAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.bag = cls.root / "fleet-bag"
        write_bag_sample(cls.bag, "fleet-bag")
        write_fleet_sample(cls.root / "single.mcap", seconds=20)
        cls.meta = (cls.bag / "metadata.yaml").read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def copy(self, name):
        dest = self.root / name
        shutil.copytree(self.bag, dest)
        return dest

    def test_matches_the_single_file_it_was_split_from(self):
        single = analyze_file(self.root / "single.mcap", FLEET_CONTRACT)
        r = analyze_bag(self.bag, FLEET_CONTRACT)
        self.assertEqual(r["overall"], "pass")
        self.assertEqual(statuses(r)["C11"], "pass")
        self.assertEqual([(x["topic"], x["message_count"]) for x in r["inventory"]],
                         [(x["topic"], x["message_count"]) for x in single["inventory"]])  # fmt: skip
        self.assertEqual([f["observed_hz"] for f in r["checks"][5]["findings"]],
                         [f["observed_hz"] for f in single["checks"][5]["findings"]])  # fmt: skip
        self.assertEqual(r["inventory"][0]["location"]["file"], "fleet-bag_0.mcap")
        self.assertEqual([f["scan"] for f in r["bag"]["files"]], ["complete"] * 3)
        self.assertIn("ROS 2 bag folder", render(r))

    def test_fast_mode(self):
        r = analyze_bag(self.bag, FLEET_CONTRACT, fast=True)
        self.assertEqual(statuses(r)["C11"], "pass")
        self.assertEqual([f["scan"] for f in r["bag"]["files"]], ["summary only"] * 3)

    def test_missing_metadata_warns(self):
        d = self.copy("no-meta")
        (d / "metadata.yaml").unlink()
        r = analyze_bag(d, FLEET_CONTRACT)
        self.assertEqual(r["bag"]["metadata"], "absent")
        self.assertEqual(statuses(r)["C11"], "warn")

    def test_missing_listed_file_fails_and_skips_partial_checks(self):
        d = self.copy("missing")
        (d / "fleet-bag_1.mcap").unlink()
        r = analyze_bag(d, FLEET_CONTRACT)
        s = statuses(r)
        self.assertFalse(r["scan_complete"])
        self.assertEqual(s["C11"], "fail")
        self.assertEqual([s["C02"], s["C07"], s["C10"]], ["skipped"] * 3)
        self.assertEqual(r["bag"]["files"][1]["scan"], "missing")

    def test_count_mismatch_fails(self):
        d = self.copy("mismatch")
        total = parse_info(self.meta)["message_count"]
        (d / "metadata.yaml").write_bytes(
            self.meta.replace(f"message_count: {total}", f"message_count: {total + 1}").encode("utf-8"))
        r = analyze_bag(d, FLEET_CONTRACT)
        bad = [f for f in r["checks"][10]["findings"] if f["status"] == "fail"]
        self.assertEqual([(f["scope"], f["claimed"], f["observed"]) for f in bad], [("bag", total + 1, total)])

    def test_cut_off_last_file(self):
        d = self.copy("cut")
        last = d / "fleet-bag_2.mcap"
        last.write_bytes(last.read_bytes()[: last.stat().st_size * 6 // 10])
        r = analyze_bag(d, FLEET_CONTRACT)
        self.assertEqual(r["overall"], "fail")
        self.assertEqual(r["recovered"]["incomplete_file"], "fleet-bag_2.mcap")
        self.assertEqual([f["scan"] for f in r["bag"]["files"]], ["complete", "complete", "incomplete"])
        self.assertNotIn("pass", [f["status"] for f in r["checks"][10]["findings"] if "claimed" in f])

    def test_unlisted_file_warns_and_is_not_scanned(self):
        d = self.copy("stray")
        shutil.copy(self.root / "single.mcap", d / "stray.mcap")
        r = analyze_bag(d, FLEET_CONTRACT)
        self.assertEqual(r["overall"], "warn")
        stray = r["bag"]["files"][-1]
        self.assertEqual((stray["name"], stray["listed"], stray["scan"]), ("stray.mcap", False, "not listed"))


class BagCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.contract = self.root / "contract.json"
        import json

        self.contract.write_text(json.dumps(FLEET_CONTRACT), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(list(args))
        return code, out.getvalue(), err.getvalue()

    def test_check_a_folder(self):
        write_bag_sample(self.root / "bag", "bag")
        code, out, _ = self.run_cli("check", str(self.root / "bag"), "--contract", str(self.contract),
                                    "--out", str(self.root / "out"), "--quiet")  # fmt: skip
        self.assertEqual(code, 0, out)
        self.assertIn("bag: 3 of 3 files scanned, metadata.yaml present", out)
        self.assertTrue((self.root / "out" / "report.html").is_file())

    def test_sqlite_bag_is_an_input_error(self):
        write_bag_sample(self.root / "bag", "bag")
        meta = self.root / "bag" / "metadata.yaml"
        meta.write_bytes(meta.read_bytes().replace(b"storage_identifier: mcap", b"storage_identifier: sqlite3"))
        code, _, err = self.run_cli("check", str(self.root / "bag"), "--contract", str(self.contract),
                                    "--out", str(self.root / "out"), "--quiet")  # fmt: skip
        self.assertEqual(code, 2)
        self.assertIn("only MCAP bags", err)
        self.assertFalse((self.root / "out").exists())


if __name__ == "__main__":
    unittest.main()
