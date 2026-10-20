"""Tests for ``tracecheck manifest`` and ``tracecheck verify``."""

import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from tracecheck import manifest as mf
from tracecheck.__main__ import main
from tracecheck.samples import write_bag_sample, write_fleet_sample


def run_cli(*args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main([str(a) for a in args])
    return code, out.getvalue(), err.getvalue()


class ManifestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        write_fleet_sample(cls.root / "fleet.mcap", seconds=10)
        write_bag_sample(cls.root / "bag", "bag", seconds=10, splits=(4, 7))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def copy(self, name):
        dest = self.root / name
        shutil.copytree(self.root / "bag", dest)
        return dest

    def test_file_manifest(self):
        m = mf.build(self.root / "fleet.mcap")
        self.assertEqual(m["recording"], {"kind": "mcap", "name": "fleet.mcap"})
        self.assertEqual(len(m["files"]), 1)
        self.assertEqual(len(m["files"][0]["sha256"]), 64)
        self.assertEqual(m["messages"], sum(t["message_count"] for t in m["topics"]))
        self.assertIn("does not show who made the recording", m["note"])
        self.assertNotIn("/", [t["topic"] for t in m["topics"]])

    def test_bag_manifest_lists_every_file(self):
        m = mf.build(self.root / "bag")
        self.assertEqual([f["name"] for f in m["files"]], ["bag_0.mcap", "bag_1.mcap", "bag_2.mcap", "metadata.yaml"])
        self.assertTrue(m["scan_complete"])

    def test_identical_copy_matches(self):
        m = mf.build(self.root / "bag")
        r = mf.verify(self.copy("same"), m)
        self.assertEqual(r["status"], "match")
        self.assertTrue(all(t["status"] == "match" for t in r["topics"]))

    def test_changed_missing_and_extra_files(self):
        m = mf.build(self.root / "bag")
        d = self.copy("changed")
        last = d / "bag_2.mcap"
        last.write_bytes(last.read_bytes()[:-100])
        (d / "bag_1.mcap").unlink()
        (d / "notes.txt").write_text("hello", encoding="utf-8")
        r = mf.verify(d, m)
        self.assertEqual(r["status"], "different")
        self.assertEqual({x["name"]: x["status"] for x in r["files"]},
                         {"bag_0.mcap": "match", "bag_1.mcap": "missing", "bag_2.mcap": "changed",
                          "metadata.yaml": "match", "notes.txt": "extra"})  # fmt: skip
        self.assertFalse(r["topics_compared"])  # a listed file is missing, so the scan is incomplete

    def test_renamed_single_file_still_matches_by_bytes(self):
        m = mf.build(self.root / "fleet.mcap")
        shutil.copy(self.root / "fleet.mcap", self.root / "renamed.mcap")
        r = mf.verify(self.root / "renamed.mcap", m)
        self.assertEqual(r["status"], "match")
        self.assertEqual(r["files"][0]["manifest_name"], "fleet.mcap")

    def test_kind_mismatch_is_an_error(self):
        with self.assertRaises(ValueError):
            mf.verify(self.root / "fleet.mcap", mf.build(self.root / "bag"))

    def test_load_rejects_bad_manifests(self):
        good = mf.build(self.root / "fleet.mcap")
        bad_cases = [
            "not json",
            json.dumps([]),
            json.dumps(dict(good, manifest_version=2)),
            json.dumps(dict(good, files=[dict(good["files"][0], sha256="XYZ")])),
            json.dumps(dict(good, files=[dict(good["files"][0], name="../x.mcap")])),
            json.dumps(dict(good, files=good["files"] * 2)),
            json.dumps(dict(good, topics=[{"topic": "/a", "message_count": -1}])),
        ]
        for i, text in enumerate(bad_cases):
            p = self.root / f"bad{i}.json"
            p.write_text(text, encoding="utf-8")
            with self.subTest(i=i), self.assertRaises(mf.ManifestError):
                mf.load(p)


class ManifestCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        write_bag_sample(self.root / "bag", "bag", seconds=10, splits=(4, 7))

    def tearDown(self):
        self.temp.cleanup()

    def test_round_trip_and_exit_codes(self):
        m = self.root / "bag" / "bag.manifest.json"  # stored inside the folder: verify must ignore it
        code, out, _ = run_cli("manifest", self.root / "bag", "--out", m, "--quiet")
        self.assertEqual(code, 0, out)
        self.assertIn("4 file(s)", out)
        code, out, _ = run_cli("verify", self.root / "bag", "--manifest", m, "--quiet", "--json", self.root / "v.json")
        self.assertEqual(code, 0, out)
        self.assertIn("MATCH", out)
        self.assertEqual(json.loads((self.root / "v.json").read_text(encoding="utf-8"))["status"], "match")
        meta = self.root / "bag" / "metadata.yaml"
        meta.write_bytes(meta.read_bytes() + b"\n")
        code, out, _ = run_cli("verify", self.root / "bag", "--manifest", m, "--quiet")
        self.assertEqual(code, 1)
        self.assertIn("CHANGED  metadata.yaml", out)

    def test_never_overwrites(self):
        m = self.root / "m.json"
        m.write_text("{}", encoding="utf-8")
        code, _, err = run_cli("manifest", self.root / "bag", "--out", m, "--quiet")
        self.assertEqual(code, 2)
        self.assertIn("already exists", err)
        self.assertEqual(m.read_text(encoding="utf-8"), "{}")

    def test_bad_manifest_is_exit_2(self):
        m = self.root / "m.json"
        m.write_text('{"manifest_version": 9}', encoding="utf-8")
        code, _, err = run_cli("verify", self.root / "bag", "--manifest", m, "--quiet")
        self.assertEqual(code, 2)
        self.assertIn("not a valid Tracecheck manifest", err)


if __name__ == "__main__":
    unittest.main()
