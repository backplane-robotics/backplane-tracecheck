"""Tests for gaps explained by recorder events (dynrec PauseEvent / SubscriptionChangeEvent)."""

import copy
import io
import struct
import tempfile
import unittest
from pathlib import Path

from mcap.writer import Writer

from tracecheck import events as ev
from tracecheck.engine import analyze_bytes
from tracecheck.samples import DYNREC, FLEET_CONTRACT, _cdr_event, write_fleet_sample

CAMERA = "/camera/image/compressed"


def c07(r):
    return {f["topic"]: f for f in r["checks"][6]["findings"]}


class DecodeTests(unittest.TestCase):
    def test_pause_and_subscription_payloads(self):
        self.assertEqual(ev.decode("PauseEvent", _cdr_event(5, 0, "service:pause", "/n")), ("pause", 0, None))
        self.assertEqual(ev.decode("PauseEvent", _cdr_event(5, 1, "service:resume", "/n")), ("pause", 1, None))
        sub = _cdr_event(5, "/scan", "sensor_msgs/msg/LaserScan", 1, "service:set_topics", "/n")
        self.assertEqual(ev.decode("SubscriptionChangeEvent", sub), ("subscription", 1, "/scan"))

    def test_big_endian_payload(self):
        body = struct.pack(">iI", 1, 2) + struct.pack(">I", 6) + b"/scan\x00" + b"\x00\x00" + struct.pack(">I", 2) + b"t\x00"
        self.assertEqual(ev.decode("SubscriptionChangeEvent", b"\x00\x00\x00\x00" + body + b"\x00"),
                         ("subscription", 0, "/scan"))  # fmt: skip

    def test_malformed_or_other_payloads_are_ignored(self):
        good = _cdr_event(5, 0, "r", "/n")
        self.assertIsNone(ev.decode("PauseEvent", b"\x00\x07" + good[2:]))  # unsupported encapsulation
        self.assertIsNone(ev.decode("PauseEvent", good[:10]))  # stamp present, action missing
        self.assertIsNone(ev.decode("PauseEvent", _cdr_event(5, 7, "r", "/n")))  # unknown action
        bad = bytearray(_cdr_event(5, "/scan", "t", 1, "r", "/n"))
        bad[12 + 4 + 5] = 0x41  # topic string loses its NUL terminator
        self.assertIsNone(ev.decode("SubscriptionChangeEvent", bytes(bad)))
        self.assertIsNone(ev.decode("LowDiskEvent", good))

    def test_event_type_requires_cdr_and_known_schema(self):
        self.assertEqual(ev.event_type(DYNREC + "PauseEvent", "cdr"), "PauseEvent")
        self.assertIsNone(ev.event_type(DYNREC + "PauseEvent", "json"))
        self.assertIsNone(ev.event_type(DYNREC + "SomethingElse", "cdr"))
        self.assertIsNone(ev.event_type("other_pkg/msg/PauseEvent", "cdr"))


class WindowTests(unittest.TestCase):
    def test_pause_covers_gap_within_threshold(self):
        wins = ev.windows([(100, 1, "pause", 0, None), (200, 2, "pause", 1, None)])
        explain = ev.explainer(wins, "/imu", 10)
        self.assertEqual(explain(95, 205), ["recorder_paused"])
        self.assertIsNone(explain(80, 205))  # 20 ns before the pause is unexplained
        self.assertIsNone(explain(300, 400))  # no overlap

    def test_topic_window_only_explains_its_topic(self):
        wins = ev.windows([(100, 1, "subscription", 1, "/cam"), (200, 2, "subscription", 0, "/cam")])
        self.assertEqual(ev.explainer(wins, "/cam", 10)(95, 205), ["topic_unsubscribed"])
        self.assertIsNone(ev.explainer(wins, "/imu", 10))

    def test_open_windows_and_unpaired_events(self):
        wins = ev.windows([(50, 1, "pause", 1, None), (100, 2, "pause", 0, None)])  # resume without pause ignored
        self.assertEqual(wins[0], [(100, None)])
        self.assertEqual(ev.explainer(wins, "/x", 0)(100, 900), ["recorder_paused"])
        wins = ev.windows([(10, 1, "subscription", 0, "/a")])  # startup subscribe opens nothing
        self.assertEqual(wins, ([], {}))

    def test_adjacent_windows_combine(self):
        wins = ev.windows([(100, 1, "pause", 0, None), (150, 2, "pause", 1, None),
                           (150, 3, "subscription", 1, "/a"), (220, 4, "subscription", 0, "/a")])  # fmt: skip
        self.assertEqual(ev.explainer(wins, "/a", 5)(98, 222), ["recorder_paused", "topic_unsubscribed"])


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        write_fleet_sample(root / "paused.mcap", seconds=30, pauses=[(8, 9)], unsubscribed=[(CAMERA, 20, 20.8)])
        write_fleet_sample(root / "mixed.mcap", seconds=30, pauses=[(8, 9)], dropout=("/scan", 15, 16))
        write_fleet_sample(root / "plain.mcap", seconds=5)
        cls.paused = (root / "paused.mcap").read_bytes()
        cls.mixed = (root / "mixed.mcap").read_bytes()
        cls.plain = (root / "plain.mcap").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_gaps_covered_by_events_pass_and_are_listed(self):
        r = analyze_bytes(self.paused, FLEET_CONTRACT)
        self.assertEqual(r["overall"], "pass")
        info = r["recorder_events"]
        self.assertEqual(info["message_counts"], {"SubscriptionChangeEvent": 6, "PauseEvent": 2})
        self.assertEqual((info["decoded"], info["undecodable"], info["limit_reached"]), (8, 0, False))
        f = c07(r)
        self.assertEqual(f["/imu"]["explained_gap_count"], 1)
        self.assertEqual(f["/imu"]["explained_gaps"][0]["explained_by"], ["recorder_paused"])
        self.assertEqual([g["explained_by"] for g in f[CAMERA]["explained_gaps"]],
                         [["recorder_paused"], ["topic_unsubscribed"]])  # fmt: skip
        self.assertTrue(all(x["evidence_count"] == 0 for x in f.values()))
        self.assertIn("not verified", f["/imu"]["detail"])
        self.assertNotIn("intentional", f["/imu"]["detail"].lower())

    def test_unexplained_gap_still_fails(self):
        f = c07(analyze_bytes(self.mixed, FLEET_CONTRACT))
        self.assertEqual(f["/scan"]["status"], "fail")
        self.assertEqual((f["/scan"]["evidence_count"], f["/scan"]["explained_gap_count"]), (1, 1))
        self.assertEqual(f["/imu"]["status"], "pass")

    def test_without_events_the_gap_fails(self):
        # Same pause, but the recorder's events stripped: the gap is unexplained.
        stripped = copy.deepcopy(FLEET_CONTRACT)
        r = analyze_bytes(_without_event_channels(self.paused), stripped)
        self.assertNotIn("recorder_events", r)
        self.assertEqual(r["checks"][6]["status"], "fail")
        self.assertNotIn("explained_gap_count", r["checks"][6]["findings"][0])

    def test_publish_time_basis_does_not_use_events(self):
        c = copy.deepcopy(FLEET_CONTRACT)
        c["topics"]["/imu"]["time_basis"] = "publish_time"
        f = c07(analyze_bytes(self.paused, c))
        self.assertEqual(f["/imu"]["status"], "fail")
        self.assertIn("matched on log_time only", f["/imu"]["detail"])
        self.assertNotIn("explained_gap_count", f["/imu"])

    def test_recordings_without_events_are_unchanged(self):
        r = analyze_bytes(self.plain, FLEET_CONTRACT)
        self.assertNotIn("recorder_events", r)
        self.assertIn("no payload decoding", r["provenance"])
        self.assertTrue(all("explained_gaps" not in f for f in r["checks"][6]["findings"]))

    def test_fast_mode_reads_no_events(self):
        r = analyze_bytes(self.paused, FLEET_CONTRACT, fast=True)
        self.assertNotIn("recorder_events", r)

    def test_undecodable_event_is_counted_not_used(self):
        r = analyze_bytes(_with_junk_pause(), _tiny_contract())
        self.assertEqual(r["recorder_events"]["undecodable"], 1)
        self.assertEqual(r["checks"][6]["status"], "fail")
        self.assertEqual(r["checks"][6]["findings"][0]["explained_gap_count"], 0)


def _tiny_contract():
    return {"version": 1, "name": "t", "topics": {"/a": {"clock_confirmed": True, "max_gap_ns": 10}}}


def _with_junk_pause():
    f = io.BytesIO()
    w = Writer(f)
    w.start(profile="ros2", library="test")
    sid = w.register_schema("x/msg/A", "ros2msg", b"")
    a = w.register_channel("/a", "cdr", sid)
    psid = w.register_schema(DYNREC + "PauseEvent", "ros2msg", b"")
    p = w.register_channel("/rec/events/pause", "cdr", psid)
    w.add_message(a, 0, b"x", 0)
    w.add_message(p, 5, b"\x00\x01\x00\x00junk", 5)
    w.add_message(a, 100, b"x", 100)
    w.finish()
    return f.getvalue()


def _without_event_channels(data):
    """Rewrite a recording, dropping recorder event channels (re-read with the mcap library)."""
    from mcap.reader import make_reader

    out = io.BytesIO()
    w = Writer(out)
    w.start(profile="ros2", library="test")
    ids: dict = {}
    for schema, channel, message in make_reader(io.BytesIO(data)).iter_messages(log_time_order=False):
        if schema.name.startswith(DYNREC):
            continue
        if channel.id not in ids:
            sid = w.register_schema(schema.name, schema.encoding, schema.data)
            ids[channel.id] = w.register_channel(channel.topic, channel.message_encoding, sid, channel.metadata)
        w.add_message(ids[channel.id], message.log_time, message.data, message.publish_time, message.sequence)
    w.add_metadata("session", {"robot_id": "demo-amr-01", "software_version": "demo-2.3.1"})
    w.finish()
    return out.getvalue()


if __name__ == "__main__":
    unittest.main()
