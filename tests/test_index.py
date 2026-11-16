"""Summary index agreement (C01) and the fast-mode fallback for a wrong metadata index."""

from pathlib import Path

from tracecheck.engine import INDEX_BAD, INDEX_OK, INDEX_STATS_ONLY, analyze_file
from tracecheck.reader import BAD_METADATA_INDEX, check_index

EX = Path(__file__).resolve().parents[1] / "examples"
DEMO = __import__("json").loads((EX / "demo-contract.json").read_text(encoding="utf-8"))


def c01(report):
    return next(c for c in report["checks"] if c["id"] == "C01")


def index_finding(report):
    return next(f for f in c01(report)["findings"] if "summary_index" in f)


def test_clean_file_indexes_agree():
    f = index_finding(analyze_file(EX / "clean.mcap", DEMO))
    assert f["status"] == "pass"
    assert f["detail"] == INDEX_OK
    assert f["summary_index"] == "present"
    assert f["summary_statistics"] == "agrees"
    assert f["index_entries_checked"] == 2


def test_bad_index_warns_with_each_wrong_entry():
    r = analyze_file(EX / "bad-index.mcap", DEMO)
    assert r["overall"] == "warn"
    assert c01(r)["status"] == "warn"
    f = index_finding(r)
    assert f["detail"] == INDEX_BAD
    problems = [(e["index"], e["problem"]) for e in f["evidence"]]
    assert problems == [
        ("attachment", "points to a Metadata record, not an Attachment record"),
        ("metadata", "does not point to the start of a Metadata record"),
    ]
    assert f["evidence_count"] == 2
    # Every record was still read: metadata comes from the record itself, so C04 passes.
    assert next(c for c in r["checks"] if c["id"] == "C04")["status"] == "pass"


def test_fast_mode_falls_back_on_a_wrong_metadata_index():
    r = analyze_file(EX / "bad-index.mcap", DEMO, fast=True)
    assert r["scan_mode"] == "full"
    assert r["fast_mode_fallback"] == BAD_METADATA_INDEX
    assert r["scan_complete"] is True
    assert index_finding(r)["status"] == "warn"


def test_indexless_file_with_rosbag2_metadata_reads_cleanly():
    r = analyze_file(EX / "indexless-rosbag2.mcap", DEMO)
    assert r["overall"] == "pass"
    f = index_finding(r)
    assert (f["status"], f["detail"], f["summary_index"], f["summary_statistics"]) == ("pass", INDEX_STATS_ONLY, "absent", "agrees")
    c04 = next(c for c in r["checks"] if c["id"] == "C04")
    assert c04["status"] == "pass"  # required metadata found by reading the records, with no index


# MCAP PR #1932: the Python SeekingReader can skip unindexed attachments and metadata, and ignore CRC options, when
# it falls back from missing indexes. Tracecheck has its own reader; these lock in that it is not affected.
def test_indexless_attachment_and_metadata_are_found_in_both_modes():
    for fast in (False, True):
        r = analyze_file(EX / "indexless-attachment.mcap", DEMO, fast=fast)
        assert r["overall"] == "pass" and r["scan_complete"] is True
        assert r["scan_mode"] == "full"  # fast mode cannot trust a summary with no metadata index
        if fast:
            assert r["fast_mode_fallback"] == "summary does not index every metadata record"
        assert r["scan_stats"]["attachments_skipped"] == 1  # the unindexed attachment was read and counted
        assert next(c for c in r["checks"] if c["id"] == "C04")["status"] == "pass"  # metadata found with no index
        f = index_finding(r)
        assert (f["summary_index"], f["summary_statistics"]) == ("absent", "agrees")


def test_indexless_bad_chunk_crc_is_still_checked_in_both_modes():
    for fast in (False, True):
        r = analyze_file(EX / "indexless-badcrc.mcap", DEMO, fast=fast)
        assert r["overall"] == "fail" and r["scan_complete"] is False
        assert c01(r)["status"] == "fail"
        assert "chunk CRC mismatch" in c01(r)["findings"][0]["detail"]
        # A corrupted recording gets no completeness or timing conclusions.
        assert all(c["status"] == "skipped" for c in r["checks"] if c["id"] != "C01")


# MCAP PR #1931: neighbouring chunks that share a boundary timestamp were reported as overlapping. Equal timestamps
# are contact, not time going backwards; Tracecheck must not warn.
def test_chunks_sharing_a_boundary_timestamp_pass():
    import struct

    data = (EX / "shared-boundary.mcap").read_bytes()
    pos, ranges = 8, []
    while data[pos] != 0x02:  # walk records up to the Footer, collecting chunk start/end times
        length = struct.unpack_from("<Q", data, pos + 1)[0]
        if data[pos] == 0x06:
            ranges.append(struct.unpack_from("<QQ", data, pos + 9))
        pos += 9 + length
    assert any(ranges[i][1] == ranges[i + 1][0] for i in range(len(ranges) - 1))  # fixture has shared boundaries
    r = analyze_file(EX / "shared-boundary.mcap", DEMO)
    assert r["overall"] == "pass"
    c08 = next(c for c in r["checks"] if c["id"] == "C08")
    assert c08["status"] == "pass"
    assert all(f.get("evidence_count", 0) == 0 for f in c08["findings"])


def _observed(**kw):
    base = {"message_count": 3, "schema_count": 1, "channel_count": 1, "attachment_count": 0, "metadata_count": 0,
            "chunk_count": 1, "message_start_time": 10, "message_end_time": 30, "channel_message_counts": {1: 3}}
    return {**base, **kw}


def test_check_index_reports_statistics_that_differ_in_a_fixed_order():
    stats = {**_observed(), "message_count": 4, "message_end_time": 31, "channel_message_counts": {1: 3, 2: 1}}
    ix = check_index({100: ("chunk", 50, "x")}, {"chunk": [(100, 50, "x")], "attachment": [], "metadata": []}, stats,
                     _observed())
    assert ix["statistics"] == "differs"
    assert [(i["field"], i.get("channel_id")) for i in ix["issues"]] == [
        ("message_count", None), ("message_end_time", None), ("channel_message_counts", 2)]


def test_check_index_flags_wrong_length_details_and_partial_index():
    targets = {100: ("chunk", 50, "zstd|40|90|0|9"), 200: ("chunk", 60, "zstd|50|99|10|19")}
    entries = {"chunk": [(100, 51, "zstd|40|90|0|9")], "attachment": [], "metadata": []}
    ix = check_index(targets, entries, None, _observed())
    assert [i["problem"] for i in ix["issues"]] == [
        "gives a length of 51 bytes; the Chunk record there is 50 bytes", "indexes 1 of the 2 Chunk records"]
    assert ix["statistics"] == "absent"
    entries = {"chunk": [(100, 50, "lz4|40|90|0|9"), (200, 60, "zstd|50|99|10|19")], "attachment": [], "metadata": []}
    assert [i["problem"] for i in check_index(targets, entries, None, _observed())["issues"]] == [
        "describes the Chunk record differently from the record itself"]


def test_check_index_stops_at_its_limit():
    ix = check_index(None, {"chunk": [], "attachment": [], "metadata": []}, None, _observed())
    assert ix["limit_reached"] is True and ix["issues"] == []


def test_c08_reports_the_largest_backwards_jump():
    r = analyze_file(EX / "faults.mcap", DEMO)
    f = next(c for c in r["checks"] if c["id"] == "C08")["findings"][0]
    assert f["status"] == "fail"
    assert f["largest_regression_ns"] == 100_000_000  # 800 ms followed by 700 ms
    assert (f["largest_regression"]["previous"]["log_time"], f["largest_regression"]["current"]["log_time"]) == (800_000_000, 700_000_000)
    clean = next(c for c in analyze_file(EX / "clean.mcap", DEMO)["checks"] if c["id"] == "C08")["findings"][0]
    assert clean["status"] == "pass" and "largest_regression_ns" not in clean
