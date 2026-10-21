"""Integrity manifests: record the exact bytes of a recording, then check a copy against them.

``tracecheck manifest`` writes, for an .mcap file or a ROS 2 bag folder, each file's size and
SHA-256 plus the message count per topic. ``tracecheck verify`` reads a copy (after upload, sync or
archive) and reports which files are identical, changed, missing or extra.

A SHA-256 identifies bytes. A matching hash shows the copy has the same bytes as the files the
manifest was written from; it does not show who made the recording, when, or that its contents are
true. The manifest itself is not signed, so anyone who can edit the files can edit it too.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from . import __version__
from .engine import analyze_bag, analyze_file

MANIFEST_VERSION = 1
MANIFEST_LIMIT = 16 << 20  # bytes
_HEX = set("0123456789abcdef")
NOTE = ("Each SHA-256 identifies the exact bytes of a file when this manifest was written. A match shows a copy has "
        "the same bytes; it does not show who made the recording, when, or that its contents are true. This manifest "
        "is not signed.")  # fmt: skip
# Counting messages needs a contract; this one asks for nothing, so only the scan and inventory matter.
_COUNT_ONLY = {"version": 1, "name": "manifest message counts", "topics": {"/": {"required": False}}}


class ManifestError(ValueError):
    """The manifest file is not a valid Tracecheck manifest."""


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _topics(report: dict) -> list | None:
    if not report.get("scan_complete"):
        return None
    counts: dict[str, int] = {}
    for ch in report["inventory"]:
        counts[ch["topic"]] = counts.get(ch["topic"], 0) + ch["message_count"]
    return [{"topic": t, "message_count": n} for t, n in sorted(counts.items())]


def describe(path: str | Path, progress=None, skip: Path | None = None) -> dict:
    """Scan a recording once and return its files (name, bytes, sha256) and per-topic counts.

    ``skip`` is a file to leave out of a bag folder's list (the manifest itself, if stored there).
    """
    p = Path(path)
    skip = skip.resolve() if skip is not None else None
    if p.is_dir():
        report = analyze_bag(p, _COUNT_ONLY, progress=progress)
        known = {f["name"]: f["sha256"] for f in report["bag"]["files"] if f["scan"] == "complete"}
        files = []
        for child in sorted(p.iterdir(), key=lambda c: c.name):
            if child.is_file() and child.resolve() != skip:
                sha = known.get(child.name) or _sha256_file(child)
                files.append({"name": child.name, "bytes": child.stat().st_size, "sha256": sha})
        kind = "ros2_bag"
    elif p.is_file():
        report = analyze_file(p, _COUNT_ONLY, progress=progress)
        sha = report["source"]["sha256"] if report.get("scan_complete") else None
        files = [{"name": p.name, "bytes": p.stat().st_size, "sha256": sha or _sha256_file(p)}]
        kind = "mcap"
    else:
        raise ValueError("recording must be a regular file or a ROS 2 bag folder")
    topics = _topics(report)
    return {
        "kind": kind,
        "name": p.resolve().name,
        "files": files,
        "scan_complete": bool(report.get("scan_complete")),
        "messages": sum(t["message_count"] for t in topics) if topics is not None else None,
        "topics": topics,
    }


def build(path: str | Path, progress=None) -> dict:
    d = describe(path, progress)
    return {
        "manifest_version": MANIFEST_VERSION,
        "tool": {"name": "Backplane Tracecheck", "version": __version__},
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "recording": {"kind": d["kind"], "name": d["name"]},
        "files": d["files"],
        "scan_complete": d["scan_complete"],
        "messages": d["messages"],
        "topics": d["topics"],
        "note": NOTE,
    }


def _need(cond: bool, what: str) -> None:
    if not cond:
        raise ManifestError(f"not a valid Tracecheck manifest: {what}")


def _count(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and 0 <= v < 1 << 64


def load(path: str | Path) -> dict:
    """Read and validate a manifest file. Raises ManifestError."""
    p = Path(path)
    if p.stat().st_size > MANIFEST_LIMIT:
        raise ManifestError(f"manifest exceeds {MANIFEST_LIMIT >> 20} MiB")
    try:
        m = json.loads(p.read_text(encoding="utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ManifestError(f"manifest is not JSON ({e})") from None
    _need(isinstance(m, dict), "top level is not an object")
    _need(m.get("manifest_version") == MANIFEST_VERSION, f"manifest_version must be {MANIFEST_VERSION}")
    rec = m.get("recording")
    _need(isinstance(rec, dict) and rec.get("kind") in ("mcap", "ros2_bag"), "recording.kind")
    files = m.get("files")
    _need(isinstance(files, list) and files, "files")
    names = set()
    for f in files:
        _need(isinstance(f, dict) and isinstance(f.get("name"), str) and f["name"]
              and "/" not in f["name"] and "\\" not in f["name"], "file name")  # fmt: skip
        _need(f["name"] not in names, "a file is listed twice")
        names.add(f["name"])
        _need(_count(f.get("bytes")), "file bytes")
        sha = f.get("sha256")
        _need(isinstance(sha, str) and len(sha) == 64 and set(sha) <= _HEX, "file sha256")
    _need(rec["kind"] == "ros2_bag" or len(files) == 1, "an mcap manifest lists exactly one file")
    topics = m.get("topics")
    if topics is not None:
        _need(isinstance(topics, list), "topics")
        for t in topics:
            _need(isinstance(t, dict) and isinstance(t.get("topic"), str) and _count(t.get("message_count")),
                  "topic entry")  # fmt: skip
    return m


def verify(path: str | Path, manifest: dict, progress=None, manifest_path: Path | None = None) -> dict:
    """Compare a recording with a loaded manifest. Returns a result with ``status`` match or different."""
    p = Path(path)
    kind = manifest["recording"]["kind"]
    if (kind == "ros2_bag") != p.is_dir():
        want = "a ROS 2 bag folder" if kind == "ros2_bag" else "an .mcap file"
        raise ValueError(f"the manifest describes {want}; got {'a folder' if p.is_dir() else 'a file'}")
    d = describe(p, progress, manifest_path)
    rows = []
    if kind == "mcap":
        want, got = manifest["files"][0], d["files"][0]
        same = (want["bytes"], want["sha256"]) == (got["bytes"], got["sha256"])
        row = {"name": got["name"], "status": "match" if same else "changed", "bytes": got["bytes"],
               "expected_bytes": want["bytes"], "sha256": got["sha256"], "expected_sha256": want["sha256"]}  # fmt: skip
        if want["name"] != got["name"]:
            row["manifest_name"] = want["name"]
        rows.append(row)
    else:
        have = {f["name"]: f for f in d["files"]}
        for want in manifest["files"]:
            got = have.pop(want["name"], None)
            if got is None:
                rows.append({"name": want["name"], "status": "missing", "expected_bytes": want["bytes"],
                             "expected_sha256": want["sha256"]})  # fmt: skip
                continue
            same = (want["bytes"], want["sha256"]) == (got["bytes"], got["sha256"])
            rows.append({"name": want["name"], "status": "match" if same else "changed", "bytes": got["bytes"],
                         "expected_bytes": want["bytes"], "sha256": got["sha256"],
                         "expected_sha256": want["sha256"]})  # fmt: skip
        for got in have.values():
            rows.append({"name": got["name"], "status": "extra", "bytes": got["bytes"], "sha256": got["sha256"]})
    topics = None
    if manifest.get("topics") is not None and d["topics"] is not None:
        want_t = {t["topic"]: t["message_count"] for t in manifest["topics"]}
        got_t = {t["topic"]: t["message_count"] for t in d["topics"]}
        topics = [{"topic": t, "expected": want_t.get(t), "observed": got_t.get(t),
                   "status": "match" if want_t.get(t) == got_t.get(t) else "different"}
                  for t in sorted(set(want_t) | set(got_t))]  # fmt: skip
    status = "match" if all(r["status"] == "match" for r in rows) else "different"
    return {
        "verify_version": 1,
        "tool": {"name": "Backplane Tracecheck", "version": __version__},
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "recording": {"kind": kind, "name": d["name"]},
        "manifest": {"created_utc": manifest.get("created_utc"), "name": manifest["recording"].get("name")},
        "status": status,
        "files": rows,
        "topics": topics,
        "topics_compared": topics is not None,
        "note": NOTE,
    }
