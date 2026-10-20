"""Contract checks over MCAP records. Message payloads are never decoded."""

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
from .contract import validate
from .reader import (
    META_PAIRS_LIMIT,
    META_VALUE_LIMIT,
    TEXT_LIMIT,
    Limits,
    ScanError,
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
FULL_SCAN_ONLY = "Fast mode reads only the summary section; this check needs a full scan."
INCOMPLETE = "Scan incomplete; no completeness or timing conclusion."
TRUNCATED_SKIP = ("Recording is incomplete, so this check was not evaluated on the partial data. "
                  "See the recovered summary.")  # fmt: skip

__all__ = ["Limits", "ScanError", "analyze_bytes", "analyze_file", "analyze_stream", "NAMES", "REPORT_VERSION"]


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


def _loc(a: int, b: int) -> dict:
    return {"file_offset": a} if b < 0 else {"chunk_file_offset": a, "chunk_inner_offset": b}


def _msg(cid: int, m: tuple) -> dict:
    return dict(_loc(m[1], m[2]), message_ordinal=m[0], channel_id=cid, log_time=m[3], publish_time=m[4], sequence=m[5])


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
    c = validate(contract)
    canonical = json.dumps(c, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ev_limit = limits.evidence_per_finding
    result: dict = {
        "report_version": REPORT_VERSION,
        "tool": {"name": "Backplane Tracecheck", "version": __version__, "implementation": "python",
                 "python": platform.python_version()},
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "source": {"name": Path(filename).name, "bytes": size, "sha256": None},
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
        crc = r.crc
        result.update(scan_complete=True, mcap_profile=r.profile, checksum_coverage=crc,
                      compression=r.compression, scan_stats=r.stats)  # fmt: skip
        if r.mode == "full":
            # Message bytes are CRC-protected by a verified data-section CRC, or else by per-chunk CRCs.
            # Unchunked messages are protected only by the data-section CRC.
            missing = crc["data_section"] == "absent" and (crc["chunk_absent"] > 0 or
                                                           r.stats["unchunked_messages"] > 0)  # fmt: skip
            finding(1, "warn" if r.unknown or (missing and not ignore_crc) else "pass",
                    "Bounded scan completed. Data-section, chunk and summary CRCs checked when present; attachment "
                    "CRCs unchecked. Missing CRC warns only when some message data had no CRC coverage. This is not "
                    "full MCAP conformance validation.",
                    unknown_records_skipped=r.unknown, missing_crc_policy="ignore" if ignore_crc else "warn",
                    crc_coverage_complete=not missing)  # fmt: skip
        else:
            missing = crc["summary"] == "absent"
            finding(1, "warn" if r.unknown or (missing and not ignore_crc) else "pass",
                    "Fast mode: header, footer and summary section read and summary CRC checked when present. The "
                    "data section was not scanned, so message-level corruption is not detected.",
                    unknown_records_skipped=r.unknown, missing_crc_policy="ignore" if ignore_crc else "warn")  # fmt: skip
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

    schemas, channels, metadata = r.schemas, r.channels, r.metadata

    def count_of(cid):
        if r.counts is not None:
            return r.counts.get(cid, 0)
        tr = r.tracks.get(cid)
        return tr.count if tr else 0

    result["inventory"] = [
        {"channel_id": cid, "topic": x["value"]["topic"], "message_count": count_of(cid),
         "message_encoding": x["value"]["message_encoding"], "schema_id": x["value"]["schema_id"],
         "schema": schemas.get(x["value"]["schema_id"], {}).get("value"), "location": x["location"]}
        for cid, x in channels.items()
    ]  # fmt: skip

    if "profile" in c:
        finding(3, "pass" if r.profile == c["profile"] else "fail", "MCAP Header profile equality",
                [{"file_offset": 8}], expected=c["profile"], observed=r.profile)  # fmt: skip
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
                ok = t.get("min_rate_hz", 0) <= rate <= t.get("max_rate_hz", float("inf"))
                finding(6, "pass" if ok else "fail",
                        "(N-1) / (max timestamp - min timestamp), in seconds; not instantaneous rate.",
                        [_msg(cid, lo), _msg(cid, hi)], observed_hz=rate, time_basis=basis, **ctx)  # fmt: skip
            else:
                finding(6, "skipped", "Rate bounds absent, fewer than two messages, or zero timestamp span.", **ctx)
            if "max_gap_ns" in t and n >= 2:
                sample, total = tr.sorted_gaps()
                bad = []
                for a, b, g in sample:
                    if tr.monotonic:
                        pa = dict(_loc(a[1], a[2]), message_ordinal=a[0], channel_id=cid, **{basis: a[k]})
                        pb = dict(_loc(b[1], b[2]), message_ordinal=b[0], channel_id=cid, **{basis: b[k]})
                    else:
                        pa = dict(_loc(tr.loc_a[a], tr.loc_b[a]), message_ordinal=tr.ords[a], channel_id=cid,
                                  **{basis: tr.times[a]})  # fmt: skip
                        pb = dict(_loc(tr.loc_a[b], tr.loc_b[b]), message_ordinal=tr.ords[b], channel_id=cid,
                                  **{basis: tr.times[b]})  # fmt: skip
                    bad.append({"previous": pa, "current": pb, "gap_ns": g})
                finding(7, "fail" if total else "pass",
                        "Adjacent sorted timestamps; only interior gaps. Equal-to-threshold passes.",
                        bad, total=total, time_basis=basis, **ctx)  # fmt: skip
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
    return finish(result)


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


def finish(result: dict) -> dict:
    priority = {"skipped": 0, "pass": 1, "warn": 2, "fail": 3}
    for check in result["checks"]:
        if not check["findings"]:
            check["findings"] = [{"status": "skipped", "detail": "No applicable requirement configured."}]
        check["status"] = max((f["status"] for f in check["findings"]), key=priority.get)
    result["overall"] = max((x["status"] for x in result["checks"]), key=priority.get)
    result["status_counts"] = {s: sum(x["status"] == s for x in result["checks"]) for s in priority}
    return result
