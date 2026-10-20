"""Contract checks over MCAP records. Payloads are not decoded, except recognised recorder events."""

from __future__ import annotations

import hashlib
import io
import json
import os
import platform
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Callable

from . import __version__
from . import events as rec_events
from .bag import META_LIMIT, META_NAME, plan as bag_plan
from .contract import validate
from .reader import (
    META_PAIRS_LIMIT,
    META_VALUE_LIMIT,
    TEXT_LIMIT,
    BagContext,
    Limits,
    ScanError,
    ScanResult,
    ScanTruncated,
    TrackConfig,
    scan_fast,
    scan_full,
)

REPORT_VERSION = 2
NAMES = [
    "Readable bounded MCAP scan",
    "Required topics contain messages",
    "Profile, schema and encoding",
    "Required file metadata",
    "Message counts",
    "Average recorded rate",
    "Sorted timestamp gaps",
    "Record-order timestamp regressions",
    "Sequence continuity",
    "Expected interval coverage",
]
BAG_NAME = "ROS 2 bag metadata agreement"  # C11, only in reports for a bag folder
FULL_SCAN_ONLY = "Fast mode reads only the summary section; this check needs a full scan."
INCOMPLETE = "Scan incomplete; no completeness or timing conclusion."
TRUNCATED_SKIP = ("Recording is incomplete, so this check was not evaluated on the partial data. "
                  "See the recovered summary.")  # fmt: skip
BAG_MISSING_SKIP = ("A file listed in metadata.yaml is not in the folder, so this check was not evaluated on the "
                    "partial recording. See C11.")  # fmt: skip
GAP_DETAIL = "Adjacent sorted timestamps; only interior gaps. Equal-to-threshold passes."
RATE_DETAIL = "(N-1) / (max timestamp - min timestamp), in seconds; not instantaneous rate."
RATE_EVENTS_DETAIL = (RATE_DETAIL + " Judged on active_hz: time covered by recorder pause or unsubscribe events written "
                      "in the recording (excluded_ns) is left out; the events are not verified. observed_hz includes "
                      "that time.")  # fmt: skip
GAP_EVENTS_DETAIL = (GAP_DETAIL + " Gaps covered by a recorder pause or unsubscribe event written in the recording "
                     "are listed as explained and do not fail; the events are not verified.")  # fmt: skip
GAP_EVENTS_UNUSED = (GAP_DETAIL + " Recorder events in this recording were not used: they are matched on "
                     "log_time only.")  # fmt: skip
GAP_EVENTS_LIMIT = (GAP_DETAIL + " Recorder events in this recording were not used: more than "
                    f"{rec_events.EVENT_LIMIT} pause or subscription events.")  # fmt: skip
PROVENANCE_EVENTS = ("Local read-only scan; user-supplied contract; no execution. Payloads are not decoded, except "
                     "recognised recorder event messages (action and topic name only).")  # fmt: skip
FULL_DETAIL = ("Bounded scan completed. Data-section, chunk and summary CRCs checked when present; attachment CRCs "
               "unchecked. Missing CRC warns only when some message data had no CRC coverage. This is not full MCAP "
               "conformance validation.")  # fmt: skip
FAST_DETAIL = ("Fast mode: header, footer and summary section read and summary CRC checked when present. The data "
               "section was not scanned, so message-level corruption is not detected.")  # fmt: skip
BAG_BY_NAME = "The .mcap files in the folder were checked in name order; message counts could not be compared."
BAG_NO_META = ("No metadata.yaml in the folder. rosbag2 writes it when a recording is closed, so a recorder that "
               "stopped unexpectedly may leave none; it can also be left out when copying. " + BAG_BY_NAME)  # fmt: skip
COUNT_OK = "Message count matches metadata.yaml."
COUNT_BAD = ("Message count differs from metadata.yaml. Compare this copy with the original recording; the folder "
             "alone cannot show which is right.")  # fmt: skip

__all__ = ["Limits", "ScanError", "analyze_bag", "analyze_bag_files", "analyze_bytes", "analyze_file",
           "analyze_stream", "NAMES", "REPORT_VERSION"]  # fmt: skip


def limits_report(limits: Limits) -> dict:
    out = asdict(limits)
    out.update(
        text_field_characters=TEXT_LIMIT,
        metadata_value_characters=META_VALUE_LIMIT,
        metadata_pairs_per_record=META_PAIRS_LIMIT,
        compression="none, zstd, lz4; output capped at declared uncompressed size",
    )
    return out


def _plan(contract: dict) -> Callable[[str], TrackConfig | None]:
    topics = contract["topics"]

    def plan(topic: str) -> TrackConfig | None:
        t = topics.get(topic)
        if t is None:
            return None
        gap = t["max_gap_ns"] if t.get("clock_confirmed") and "max_gap_ns" in t else None
        return TrackConfig(
            basis_log=t.get("time_basis", "log_time") == "log_time",
            sequence=t.get("sequence") == "increment_mod32",
            max_gap=gap,
        )

    return plan


def _loc(a: int, b: int, f: str | None = None) -> dict:
    loc = {"file_offset": a} if b < 0 else {"chunk_file_offset": a, "chunk_inner_offset": b}
    return loc if f is None else {"file": f, **loc}


def _msg(cid: int, m: tuple) -> dict:
    return dict(_loc(m[1], m[2], m[6]), message_ordinal=m[0], channel_id=cid, log_time=m[3], publish_time=m[4],
                sequence=m[5])  # fmt: skip


def _start(contract: dict, name: str, size: int, fast: bool, limits: Limits) -> tuple[dict, dict, Callable]:
    """Validate the contract and create the report skeleton and its ``finding`` helper."""
    c = validate(contract)
    canonical = json.dumps(c, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ev_limit = limits.evidence_per_finding
    result: dict = {
        "report_version": REPORT_VERSION,
        "tool": {"name": "Backplane Tracecheck", "version": __version__, "implementation": "python",
                 "python": platform.python_version()},
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "source": {"name": name, "bytes": size, "sha256": None},
        "scan_mode": "fast" if fast else "full",
        "contract": c,
        "contract_sha256": hashlib.sha256(canonical).hexdigest(),
        "limits": limits_report(limits),
        "provenance": "Local read-only scan; user-supplied contract; no payload decoding or execution.",
        "interpretation": "Contract observations only. No safety certification, regulatory compliance, causality, "
                          "or original-recording truthfulness is established. Clock differences are not transport "
                          "latency.",
        "checks": [{"id": f"C{i + 1:02}", "name": n, "status": "skipped", "findings": []} for i, n in enumerate(NAMES)],
    }  # fmt: skip

    def finding(i, status, detail, evidence=None, total=None, **extra):
        row = dict(status=status, detail=detail, **extra)
        if evidence is not None:
            count = len(evidence) if total is None else total
            row["evidence_count"] = count
            row["evidence"] = evidence[:ev_limit]
            row["evidence_omitted"] = max(0, count - len(row["evidence"]))
        result["checks"][i - 1]["findings"].append(row)

    return c, result, finding


def _crc_missing(r: ScanResult) -> bool:
    """True when some message data had no CRC coverage (full), or the summary has no CRC (fast)."""
    crc = r.crc
    if r.mode == "full":
        # Message bytes are CRC-protected by a verified data-section CRC, or else by per-chunk CRCs.
        # Unchunked messages are protected only by the data-section CRC.
        return crc["data_section"] == "absent" and (crc["chunk_absent"] > 0 or r.stats["unchunked_messages"] > 0)
    return crc["summary"] == "absent"


def _scanned(result: dict, r: ScanResult, missing: bool, ignore_crc: bool, finding: Callable, **extra) -> None:
    """Record a completed scan and its C01 finding."""
    result.update(scan_complete=True, mcap_profile=r.profile, checksum_coverage=r.crc,
                  compression=r.compression, scan_stats=r.stats)  # fmt: skip
    if r.recorder_events is not None:
        result["recorder_events"] = r.recorder_events
        result["provenance"] = PROVENANCE_EVENTS
    status = "warn" if r.unknown or (missing and not ignore_crc) else "pass"
    policy = "ignore" if ignore_crc else "warn"
    if r.mode == "full":
        finding(1, status, FULL_DETAIL, unknown_records_skipped=r.unknown, missing_crc_policy=policy,
                crc_coverage_complete=not missing, **extra)  # fmt: skip
    else:
        finding(1, status, FAST_DETAIL, unknown_records_skipped=r.unknown, missing_crc_policy=policy, **extra)


def analyze_stream(
    f: BinaryIO,
    size: int,
    contract: dict,
    filename: str = "recording.mcap",
    *,
    fast: bool = False,
    limits: Limits | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> dict:
    """Check a seekable binary stream of ``size`` bytes against ``contract``."""
    limits = limits or Limits()
    c, result, finding = _start(contract, Path(filename).name, size, fast, limits)
    ignore_crc = c.get("missing_crc", "warn") == "ignore"
    try:
        r = None
        if fast:
            r = scan_fast(f, size, limits)
            if r.fast_fallback:
                result["scan_mode"] = "full"
                result["fast_mode_fallback"] = r.fast_fallback
                f.seek(0)
                r = None
        if r is None:
            r = scan_full(f, size, _plan(c), limits, progress)
        result["source"]["sha256"] = r.sha256
        _scanned(result, r, _crc_missing(r), ignore_crc, finding)
    except Exception as e:
        partial = getattr(e, "result", None)
        if partial is not None:
            result["source"]["sha256"] = partial.sha256
        result["scan_complete"] = False
        if isinstance(e, ScanTruncated) and partial is not None and partial.mode == "full":
            _report_truncated(result, partial, str(e), finding)
            for i in range(2, 11):
                finding(i, "skipped", TRUNCATED_SKIP)
            return finish(result)
        finding(1, "fail", f"{type(e).__name__}: {str(e)[:300]}")
        for i in range(2, 11):
            finding(i, "skipped", INCOMPLETE)
        return finish(result)
    _inventory(result, r)
    _evaluate(result, c, r, finding)
    return finish(result)


def _count_of(r: ScanResult, cid: int) -> int:
    if r.counts is not None:
        return r.counts.get(cid, 0)
    tr = r.tracks.get(cid)
    return tr.count if tr else 0


def _inventory(result: dict, r: ScanResult) -> None:
    schemas = r.schemas
    result["inventory"] = [
        {"channel_id": cid, "topic": x["value"]["topic"], "message_count": _count_of(r, cid),
         "message_encoding": x["value"]["message_encoding"], "schema_id": x["value"]["schema_id"],
         "schema": schemas.get(x["value"]["schema_id"], {}).get("value"), "location": x["location"]}
        for cid, x in r.channels.items()
    ]  # fmt: skip


def _evaluate(result: dict, c: dict, r: ScanResult, finding: Callable, first_file: str | None = None) -> None:
    """Checks C02-C10 on a completed scan. ``first_file`` names the bag file whose Header is cited."""
    schemas, channels, metadata = r.schemas, r.channels, r.metadata
    info = r.recorder_events
    wins = rec_events.windows(r.events) if info is not None and not info["limit_reached"] else None

    def count_of(cid):
        return _count_of(r, cid)

    if "profile" in c:
        finding(3, "pass" if r.profile == c["profile"] else "fail", "MCAP Header profile equality",
                [_loc(8, -1, first_file)], expected=c["profile"], observed=r.profile)  # fmt: skip
    for name, fields in c.get("metadata", {}).items():
        found = [m for m in metadata if m["name"] == name]
        for key, expected in fields.items():
            matches = [m for m in found if key in m["fields"] and
                       (m["fields"][key] == expected if expected is not None else bool(m["fields"][key]))]  # fmt: skip
            ok = bool(found) and len(matches) == len(found)
            finding(4, "pass" if ok else "fail",
                    f"Metadata {name}.{key}: every matching record must satisfy the contract; null means nonempty.",
                    [m["location"] for m in found], expected=expected)  # fmt: skip

    for topic, t in c["topics"].items():
        ids = [cid for cid, ch in channels.items() if ch["value"]["topic"] == topic]
        active = [cid for cid in ids if count_of(cid)]
        if t.get("required", True):
            finding(2, "pass" if active else "fail", "Required topic needs at least one message.",
                    [channels[cid]["location"] for cid in ids], topic=topic)  # fmt: skip
        if not ids:
            for i in [3, 5, 6, 7, 8, 9, 10]:
                finding(i, "skipped", "Topic absent; see required-topic check.", topic=topic)
        for cid in ids:
            ch = channels[cid]["value"]
            ctx = {"topic": topic, "channel_id": cid}
            sch = schemas.get(ch["schema_id"], {}).get("value", {})
            for key, actual in [("message_encoding", ch["message_encoding"]), ("schema_name", sch.get("name")),
                                ("schema_encoding", sch.get("encoding")), ("schema_sha256", sch.get("sha256"))]:
                if key in t:
                    finding(3, "pass" if actual == t[key] else "fail", key + " equality (schema payload not validated)",
                            [channels[cid]["location"]], expected=t[key], observed=actual, **ctx)  # fmt: skip
            n = count_of(cid)
            tr = r.tracks.get(cid)
            if "min_count" in t or "max_count" in t:
                ok = t.get("min_count", 0) <= n <= t.get("max_count", float("inf"))
                if tr is not None:
                    ev = [_msg(cid, tr.first), _msg(cid, tr.last)] if n else []
                else:
                    ev = [channels[cid]["location"]]
                finding(5, "pass" if ok else "fail", "Per-channel message count", ev,
                        observed=n, minimum=t.get("min_count"), maximum=t.get("max_count"), **ctx)  # fmt: skip
            if tr is None:  # fast mode
                for i in [6, 7, 8, 9, 10]:
                    finding(i, "skipped", FULL_SCAN_ONLY, **ctx)
                continue
            if t.get("sequence") == "increment_mod32" and n >= 2:
                bad = [{"previous": _msg(cid, a), "current": _msg(cid, b)} for a, b in tr.seq_bad]
                finding(9, "fail" if tr.seq_bad_n else "pass",
                        "Physical-order unit increment modulo 2^32; one sequence source per channel is a contract "
                        "assumption.", bad, total=tr.seq_bad_n, **ctx)  # fmt: skip
            else:
                finding(9, "skipped", "Sequence disabled or fewer than two messages.", **ctx)
            basis = t.get("time_basis", "log_time")
            k = 3 if basis == "log_time" else 4
            if not t.get("clock_confirmed") or not n:
                for i in [6, 7, 8, 10]:
                    finding(i, "skipped", "Needs clock_confirmed=true and messages; clock domain/epoch must be known "
                                          "by the user.", **ctx)  # fmt: skip
                continue
            lo, hi = tr.lo, tr.hi
            if ("min_rate_hz" in t or "max_rate_hz" in t) and n >= 2 and hi[k] > lo[k]:
                rate = (n - 1) * 1e9 / (hi[k] - lo[k])
                gone, why = (0, [])
                if wins is not None and basis == "log_time":
                    gone, why = rec_events.covered(wins, topic, lo[k], hi[k])
                extra = {}
                judged = rate
                if gone and hi[k] - lo[k] > gone:
                    judged = (n - 1) * 1e9 / (hi[k] - lo[k] - gone)
                    extra = {"active_hz": judged, "excluded_ns": gone, "excluded_by": why}
                ok = t.get("min_rate_hz", 0) <= judged <= t.get("max_rate_hz", float("inf"))
                finding(6, "pass" if ok else "fail", RATE_EVENTS_DETAIL if extra else RATE_DETAIL,
                        [_msg(cid, lo), _msg(cid, hi)], observed_hz=rate, time_basis=basis, **ctx, **extra)  # fmt: skip
            else:
                finding(6, "skipped", "Rate bounds absent, fewer than two messages, or zero timestamp span.", **ctx)
            if "max_gap_ns" in t and n >= 2:
                explain = None
                if wins is not None and basis == "log_time":
                    explain = rec_events.explainer(wins, topic, t["max_gap_ns"])
                sample, total, xs, xtotal = tr.sorted_gaps(explain)

                def point(a):
                    f = tr.files[a] if tr.files is not None else None
                    return dict(_loc(tr.loc_a[a], tr.loc_b[a], f), message_ordinal=tr.ords[a], channel_id=cid,
                                **{basis: tr.times[a]})  # fmt: skip

                bad = []
                for a, b, g in sample:
                    if tr.monotonic and explain is None:
                        pa = dict(_loc(a[1], a[2], a[6]), message_ordinal=a[0], channel_id=cid, **{basis: a[k]})
                        pb = dict(_loc(b[1], b[2], b[6]), message_ordinal=b[0], channel_id=cid, **{basis: b[k]})
                    else:
                        pa, pb = point(a), point(b)
                    bad.append({"previous": pa, "current": pb, "gap_ns": g})
                if info is None:
                    finding(7, "fail" if total else "pass", GAP_DETAIL, bad, total=total, time_basis=basis, **ctx)
                elif wins is None or basis != "log_time":
                    finding(7, "fail" if total else "pass", GAP_EVENTS_LIMIT if wins is None else GAP_EVENTS_UNUSED,
                            bad, total=total, time_basis=basis, **ctx)  # fmt: skip
                else:
                    explained = [{"previous": point(a), "current": point(b), "gap_ns": g, "explained_by": why}
                                 for a, b, g, why in xs]  # fmt: skip
                    finding(7, "fail" if total else "pass", GAP_EVENTS_DETAIL, bad, total=total, time_basis=basis,
                            **ctx, explained_gap_count=xtotal, explained_gaps=explained)  # fmt: skip
            else:
                finding(7, "skipped", "Gap threshold absent or fewer than two messages.", **ctx)
            if t.get("check_regression") and n >= 2:
                bad = [{"previous": _msg(cid, a), "current": _msg(cid, b)} for a, b in tr.reg_bad]
                finding(8, "fail" if tr.reg_bad_n else "pass",
                        "Strictly decreasing timestamps in physical record order; equal values allowed.",
                        bad, total=tr.reg_bad_n, time_basis=basis, **ctx)  # fmt: skip
            else:
                finding(8, "skipped", "Regression check disabled or fewer than two messages.", **ctx)
            if "interval_ns" in t:
                start, end = t["interval_ns"]
                tol = t.get("boundary_tolerance_ns", 0)
                first, last = lo[k], hi[k]
                ok = start <= first <= start + tol and end - tol <= last <= end
                finding(10, "pass" if ok else "fail",
                        "All timestamps inside inclusive expected interval, with first/last within endpoint "
                        "tolerance; interior continuity is C07.",
                        [_msg(cid, lo), _msg(cid, hi)], expected_interval_ns=[start, end],
                        boundary_tolerance_ns=tol, time_basis=basis, **ctx)  # fmt: skip
            else:
                finding(10, "skipped", "No expected interval configured.", **ctx)


def _report_truncated(result: dict, r, reason: str, finding: Callable) -> None:
    """Describe a file that ends before its MCAP structure is complete, and what was readable.

    Only complete records count: a chunk cut off part-way contributes no messages.
    """
    lo_hi = r.log_time_range
    messages = r.stats.get("messages", 0)
    result["recovered"] = {
        "complete_bytes": r.complete_bytes,
        "file_bytes": r.size,
        "data_section_complete": r.data_end_seen,
        "messages": messages,
        "log_time_first": lo_hi[0] if lo_hi else None,
        "log_time_last": lo_hi[1] if lo_hi else None,
        "log_time_span_ns": lo_hi[1] - lo_hi[0] if lo_hi else None,
        "topics": [{"channel_id": cid, "topic": ch["value"]["topic"],
                    "message_count": r.tracks[cid].count if cid in r.tracks else 0}
                   for cid, ch in r.channels.items()],
    }  # fmt: skip
    if r.data_end_seen:
        where = "All message data was read; the file ends in its summary or footer."
    else:
        where = "The file ends inside its message data, so later messages, if any, are missing."
    finding(1, "fail",
            f"Recording is incomplete: the file ends before its MCAP footer ({reason[:120]}). {where} "
            f"{messages} complete messages were readable in the first {r.complete_bytes} of {r.size} bytes. "
            "A recording that stopped unexpectedly, or a file cut off while copying, looks like this; the file "
            "alone cannot show which.",
            truncated=True)  # fmt: skip


def analyze_file(path: str | os.PathLike, contract: dict, filename: str | None = None, **kwargs) -> dict:
    """Check a recording on disk. The file is opened read-only and streamed."""
    p = Path(path)
    with p.open("rb") as f:
        size = os.fstat(f.fileno()).st_size
        return analyze_stream(f, size, contract, filename or p.name, **kwargs)


def analyze_bytes(data: bytes, contract: dict, filename: str = "recording.mcap", **kwargs) -> dict:
    """Check an in-memory recording."""
    return analyze_stream(io.BytesIO(data), len(data), contract, filename, **kwargs)


# --------------------------------------------------------------------------- ROS 2 bag folders


def analyze_bag(path: str | os.PathLike, contract: dict, **kwargs) -> dict:
    """Check a ROS 2 bag folder (``metadata.yaml`` plus split ``.mcap`` files) as one recording.

    Only the folder's own files are read; subfolders are ignored. Raises ``bag.BagError`` (a
    ValueError) when the folder can't be checked as an MCAP bag.
    """
    folder = Path(path)
    if not folder.is_dir():
        raise ValueError("bag path must be a folder")
    sizes = {p.name: p.stat().st_size for p in sorted(folder.iterdir()) if p.is_file()}
    return analyze_bag_files(folder.resolve().name, sizes, lambda name: (folder / name).open("rb"), contract,
                             **kwargs)  # fmt: skip


def analyze_bag_files(
    folder: str,
    sizes: dict[str, int],
    open_file: Callable[[str], BinaryIO],
    contract: dict,
    *,
    fast: bool = False,
    limits: Limits | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> dict:
    """Check the files of one bag folder. ``sizes`` maps each plain file name to its size."""
    limits = limits or Limits()
    meta_text = meta_sha = meta_error = None
    if META_NAME in sizes:
        if sizes[META_NAME] > META_LIMIT:
            meta_error = f"larger than {META_LIMIT >> 20} MiB"
        else:
            with open_file(META_NAME) as fh:
                data = fh.read(META_LIMIT + 1)
            meta_sha = hashlib.sha256(data).hexdigest()
            try:
                meta_text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                meta_error = "not UTF-8 text"
    bag = bag_plan(folder, list(sizes), meta_text, meta_sha, meta_error)
    todo = [f for f in bag["files"] if f["present"] and f["listed"] is not False]
    for f in bag["files"]:
        scan = "missing" if not f["present"] else "not listed" if f["listed"] is False else "not scanned"
        f.update(bytes=sizes[f["name"]] if f["present"] else None, sha256=None, scan=scan, messages=None)
    total = sum(f["bytes"] for f in todo)
    c, result, finding = _start(contract, folder, total, fast, limits)
    result["checks"].append({"id": "C11", "name": BAG_NAME, "status": "skipped", "findings": []})
    ignore_crc = c.get("missing_crc", "warn") == "ignore"
    ctx = BagContext([f["name"] for f in todo], limits)
    results: list[ScanResult] = []
    current = None
    try:
        if fast:
            got = []
            for f in todo:
                current = f
                with open_file(f["name"]) as fh:
                    r = scan_fast(fh, f["bytes"], limits)
                if r.fast_fallback:
                    result["scan_mode"] = "full"
                    result["fast_mode_fallback"] = f"{f['name']}: {r.fast_fallback}"
                    break
                got.append(r)
            else:
                results = got
                for f, r in zip(todo, results):
                    f.update(scan="summary only", messages=r.stats["messages"])
        if not results:
            plan_fn = _plan(c)
            offset = 0
            for i, f in enumerate(todo):
                current = f
                ctx.start_file(i)
                prog = None if progress is None else (lambda d, _t, o=offset: progress(o + d, total))
                with open_file(f["name"]) as fh:
                    r = scan_full(fh, f["bytes"], plan_fn, limits, prog, ctx)
                f.update(sha256=r.sha256, scan="complete", messages=r.stats["messages"])
                results.append(r)
                offset += f["bytes"]
        current = None
        merged = _merge(results, ctx)
    except Exception as e:
        partial = getattr(e, "result", None)
        result["scan_complete"] = False
        truncated = isinstance(e, ScanTruncated) and partial is not None and partial.mode == "full"
        if current is not None:
            current["scan"] = "incomplete" if truncated else "error"
            if partial is not None:
                current.update(sha256=partial.sha256, messages=partial.stats.get("messages"))
        if truncated:
            _report_truncated_bag(result, ctx, results, partial, current, len(todo), str(e), finding)
        else:
            where = current["name"] if current is not None else folder
            finding(1, "fail", f"{where}: {type(e).__name__}: {str(e)[:300]}", file=where)
        for i in range(2, 11):
            finding(i, "skipped", TRUNCATED_SKIP if truncated else INCOMPLETE)
        _bag_check(bag, None, finding)
        result["bag"] = bag
        return finish(result)
    _scanned(result, merged, any(_crc_missing(x) for x in results), ignore_crc, finding, files_scanned=len(results))
    _inventory(result, merged)
    if any(f["scan"] == "missing" for f in bag["files"]):
        result["scan_complete"] = False
        for i in range(2, 11):
            finding(i, "skipped", BAG_MISSING_SKIP)
    else:
        _evaluate(result, c, merged, finding, todo[0]["name"])
    _bag_check(bag, merged, finding)
    result["bag"] = bag
    return finish(result)


def _merge(results: list[ScanResult], ctx: BagContext) -> ScanResult:
    """Combine per-file scan results into one, using the logical channels in ``ctx``."""
    first = results[0]
    m = ScanResult(mode=first.mode, size=sum(x.size for x in results))
    m.profile = first.profile if all(x.profile == first.profile for x in results) else None
    m.crc = {}
    for k, v in first.crc.items():
        vals = [x.crc[k] for x in results]
        if all(isinstance(x, int) for x in vals):
            m.crc[k] = sum(vals)
        else:
            m.crc[k] = v if all(x == v for x in vals) else "mixed"
    for x in results:
        for k, v in x.compression.items():
            m.compression[k] = m.compression.get(k, 0) + v
    m.unknown = sum(x.unknown for x in results)
    for k in first.stats:
        vals = [x.stats.get(k) for x in results]
        if any(v is None for v in vals):
            m.stats[k] = None
        else:
            m.stats[k] = round(sum(vals), 3) if k == "seconds" else sum(vals)
    m.metadata = [dict(md, location={"file": name, **md["location"]})
                  for name, x in zip(ctx.names, results) for md in x.metadata]  # fmt: skip
    if first.mode == "fast":
        counts: dict[int, int] = {}
        for i, x in enumerate(results):
            ctx.start_file(i)
            for cid in x.channels:
                lid = ctx.channel(cid, x)
                counts[lid] = counts.get(lid, 0) + x.counts.get(cid, 0)
        m.counts = counts
    m.schemas, m.channels, m.tracks = ctx.schemas, ctx.channels, ctx.tracks
    infos = [x.recorder_events for x in results if x.recorder_events is not None]
    if infos:
        events = [e for x in results for e in x.events]
        kinds: dict[str, int] = {}
        for info in infos:
            for k, v in info["message_counts"].items():
                kinds[k] = kinds.get(k, 0) + v
        limit = any(info["limit_reached"] for info in infos) or len(events) > rec_events.EVENT_LIMIT
        m.events = events[: rec_events.EVENT_LIMIT]
        m.recorder_events = {"recorder": infos[0]["recorder"], "message_counts": kinds, "decoded": len(m.events),
                             "undecodable": sum(info["undecodable"] for info in infos), "limit_reached": limit,
                             "note": infos[0]["note"]}  # fmt: skip
    return m


def _report_truncated_bag(result: dict, ctx: BagContext, results: list, r, f: dict, n_files: int, reason: str,
                          finding: Callable) -> None:  # fmt: skip
    """Like _report_truncated, for a bag whose file ``f`` is cut off. Later files are not scanned."""
    ranges = [x.log_time_range for x in results + [r] if x.log_time_range]
    lo = min(a for a, _ in ranges) if ranges else None
    hi = max(b for _, b in ranges) if ranges else None
    messages = ctx.base + r.stats.get("messages", 0)
    complete = sum(x.size for x in results) + r.complete_bytes
    total = result["source"]["bytes"]
    result["recovered"] = {
        "incomplete_file": f["name"],
        "complete_bytes": complete,
        "file_bytes": total,
        "data_section_complete": r.data_end_seen,
        "messages": messages,
        "log_time_first": lo,
        "log_time_last": hi,
        "log_time_span_ns": hi - lo if ranges else None,
        "topics": [{"channel_id": lid, "topic": ch["value"]["topic"],
                    "message_count": ctx.tracks[lid].count if lid in ctx.tracks else 0}
                   for lid, ch in ctx.channels.items()],
    }  # fmt: skip
    if r.data_end_seen:
        where = "All message data in that file was read; it ends in its summary or footer."
    else:
        where = "It ends inside its message data, so later messages, if any, are missing."
    later = n_files - len(results) - 1
    after = f" {later} later file(s) in the bag were not scanned." if later else ""
    finding(1, "fail",
            f"Recording is incomplete: {f['name']} ends before its MCAP footer ({reason[:120]}). {where} "
            f"{messages} complete messages were readable in the first {complete} of {total} bytes of the bag.{after} "
            "A recording that stopped unexpectedly, or a file cut off while copying, looks like this; the files "
            "alone cannot show which.",
            truncated=True, file=f["name"])  # fmt: skip


def _bag_check(bag: dict, r: ScanResult | None, finding: Callable) -> None:
    """C11: compare the folder and the scan with metadata.yaml. ``r`` is None when the scan is incomplete."""
    meta = bag["metadata"]
    files = bag["files"]
    if meta == "present":
        finding(11, "pass", "metadata.yaml was read.", metadata="present", ros_distro=bag["ros_distro"],
                files_listed=sum(1 for f in files if f["listed"]))  # fmt: skip
    elif meta == "absent":
        finding(11, "warn", BAG_NO_META, metadata="absent")
    else:
        finding(11, "warn", f"metadata.yaml could not be read ({bag['metadata_error']}). {BAG_BY_NAME}",
                metadata="unreadable")  # fmt: skip
    for f in files:
        if f["scan"] == "missing":
            finding(11, "fail", "This file is listed in metadata.yaml but is not in the folder, so the recording is "
                                "incomplete.", file=f["name"])  # fmt: skip
        elif f["scan"] == "not listed":
            finding(11, "warn", "This .mcap file is in the folder but not listed in metadata.yaml, so it was not "
                                "checked.", file=f["name"])  # fmt: skip
    if meta != "present":
        return
    if r is None:
        finding(11, "skipped", "Scan incomplete; message counts were not compared with metadata.yaml.")
        return

    def compare(claimed, observed, **where):
        ok = claimed == observed
        finding(11, "pass" if ok else "fail", COUNT_OK if ok else COUNT_BAD, **where, claimed=claimed,
                observed=observed)  # fmt: skip

    for f in files:
        if f["messages"] is not None and f["messages_claimed"] is not None:
            compare(f["messages_claimed"], f["messages"], file=f["name"])
    if any(f["scan"] == "missing" for f in files):
        finding(11, "skipped", "A listed file is missing, so topic and total message counts were not compared.")
        return
    observed: dict[str, int] = {}
    for cid, ch in r.channels.items():
        topic = ch["value"]["topic"]
        observed[topic] = observed.get(topic, 0) + _count_of(r, cid)
    listed = set()
    for t in bag["topics_claimed"]:
        listed.add(t["name"])
        if t["message_count"] is not None:
            compare(t["message_count"], observed.get(t["name"], 0), topic=t["name"])
    for topic, n in observed.items():
        if n and topic not in listed:
            finding(11, "warn", "This topic has messages but is not listed in metadata.yaml.", topic=topic,
                    observed=n)  # fmt: skip
    if bag["message_count_claimed"] is not None:
        compare(bag["message_count_claimed"], r.stats["messages"], scope="bag")


def finish(result: dict) -> dict:
    priority = {"skipped": 0, "pass": 1, "warn": 2, "fail": 3}
    for check in result["checks"]:
        if not check["findings"]:
            check["findings"] = [{"status": "skipped", "detail": "No applicable requirement configured."}]
        check["status"] = max((f["status"] for f in check["findings"]), key=priority.get)
    result["overall"] = max((x["status"] for x in result["checks"]), key=priority.get)
    result["status_counts"] = {s: sum(x["status"] == s for x in result["checks"]) for s in priority}
    return result
