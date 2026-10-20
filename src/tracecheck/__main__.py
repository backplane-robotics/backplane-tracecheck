"""Command-line interface: ``tracecheck check | manifest | verify | validate-contract | samples | serve``."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .contract import ContractError, loads
from .engine import analyze_bag, analyze_file
from .reader import MiB, Limits
from .report import render

EXIT_PASS, EXIT_FINDINGS, EXIT_ERROR = 0, 1, 2


def _load_contract(path: Path) -> dict:
    if path.stat().st_size > 65536:
        raise ContractError("contract exceeds 64 KiB")
    return loads(path.read_text(encoding="utf-8-sig"))


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tracecheck",
        description="Backplane Tracecheck: check MCAP robot recordings against a recording contract. "
        "Exit 0 pass, 1 findings/warnings, 2 input/config/operational error.",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check", help="check a recording (an .mcap file or a ROS 2 bag folder) and write JSON + "
                                          "HTML reports")  # fmt: skip
    check.add_argument("recording", type=Path, help="an .mcap file, or a ROS 2 bag folder (metadata.yaml + .mcap files)")
    check.add_argument("--contract", type=Path, required=True)
    check.add_argument("--out", type=Path, required=True, help="new output directory; existing files are never overwritten")
    check.add_argument("--fast", action="store_true",
                       help="read only the summary section (inventory, counts, schemas, metadata); timing checks skip")
    check.add_argument("--ignore-missing-crc", action="store_true",
                       help="do not warn when CRCs are absent (same as contract \"missing_crc\": \"ignore\")")
    check.add_argument("--fail-on", choices=["warn", "fail"], default="warn",
                       help="lowest overall status that gives exit code 1 (default: warn)")
    check.add_argument("--timeout", type=float, default=None, metavar="SECONDS", help="stop the scan after SECONDS")
    check.add_argument("--max-chunk-mib", type=int, default=Limits.max_chunk_uncompressed_bytes // MiB,
                       help="largest allowed uncompressed chunk (default: %(default)s)")
    check.add_argument("--max-record-mib", type=int, default=Limits.max_record_bytes // MiB,
                       help="largest allowed record that must be read into memory (default: %(default)s)")
    check.add_argument("--max-tracked-messages", type=int, default=Limits.max_tracked_messages,
                       help="timestamps kept in memory for sorted-gap checks (default: %(default)s)")
    check.add_argument("--quiet", action="store_true", help="no progress output")

    v = sub.add_parser("validate-contract", help="validate a contract file")
    v.add_argument("contract", type=Path)

    mf = sub.add_parser("manifest", help="write a manifest of a recording: SHA-256 and size per file, message count "
                                         "per topic")  # fmt: skip
    mf.add_argument("recording", type=Path, help="an .mcap file or a ROS 2 bag folder")
    mf.add_argument("--out", type=Path, required=True, help="new manifest file (.json); never overwritten")
    mf.add_argument("--quiet", action="store_true", help="no progress output")

    vf = sub.add_parser("verify", help="check a copy of a recording against a manifest")
    vf.add_argument("recording", type=Path, help="the copy: an .mcap file or a ROS 2 bag folder")
    vf.add_argument("--manifest", type=Path, required=True)
    vf.add_argument("--json", type=Path, help="also write the result as JSON to this new file")
    vf.add_argument("--quiet", action="store_true", help="no progress output")

    s = sub.add_parser("serve", help="local browser UI on 127.0.0.1 (files up to 64 MiB)")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--open", action="store_true")

    sm = sub.add_parser("samples", help="write synthetic example recordings and the demo contract")
    sm.add_argument("--dest", type=Path, default=Path("examples"))

    w = sub.add_parser("_worker")  # internal: used by the local server
    w.add_argument("recording", type=Path)
    w.add_argument("contract", type=Path)
    w.add_argument("--name")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "serve":
            from .server import serve

            serve(args.port, args.open)
            return EXIT_PASS
        if args.command == "samples":
            from .samples import generate

            generate(args.dest)
            print(f"Synthetic examples ready in {args.dest}/")
            return EXIT_PASS
        if args.command in ("manifest", "verify"):
            return _manifest_command(args)
        contract = _load_contract(args.contract)
        if args.command == "validate-contract":
            print("Contract valid:", contract["name"])
            return EXIT_PASS
        is_bag = args.command == "check" and args.recording.is_dir()
        if not is_bag and not args.recording.is_file():
            raise ValueError("recording must be a regular file or a ROS 2 bag folder")
        if args.command == "_worker":
            from .server import UPLOAD_LIMIT

            r = analyze_file(args.recording, contract, args.name or args.recording.name,
                             limits=Limits(max_seconds=30, max_record_bytes=8 * MiB,
                                           max_chunk_uncompressed_bytes=UPLOAD_LIMIT))  # fmt: skip
            print(json.dumps(r, ensure_ascii=True))
            return EXIT_PASS

        if args.out.exists():
            raise ValueError("output directory already exists; choose a new --out path")
        if args.ignore_missing_crc:
            contract = dict(contract, missing_crc="ignore")
        limits = Limits(
            max_seconds=args.timeout,
            max_chunk_uncompressed_bytes=args.max_chunk_mib * MiB,
            max_record_bytes=args.max_record_mib * MiB,
            max_tracked_messages=args.max_tracked_messages,
        )
        progress = None
        if not args.quiet and sys.stderr.isatty() and not args.fast:
            def progress(done: int, total: int) -> None:
                print(f"\r  scanned {done / MiB:,.0f} / {total / MiB:,.0f} MiB ({100 * done / max(total, 1):.0f}%)",
                      end="", file=sys.stderr, flush=True)  # fmt: skip
        analyze = analyze_bag if is_bag else analyze_file
        r = analyze(args.recording, contract, fast=args.fast, limits=limits, progress=progress)
        if progress is not None:
            print(file=sys.stderr)
        args.out.mkdir(parents=True, exist_ok=False)
        (args.out / "report.json").write_text(json.dumps(r, indent=2, ensure_ascii=False), encoding="utf-8")
        (args.out / "report.html").write_text(render(r), encoding="utf-8")
        note = f" | fast mode fell back to full scan: {r['fast_mode_fallback']}" if "fast_mode_fallback" in r else ""
        if "bag" in r:
            bag = r["bag"]
            scanned = sum(1 for f in bag["files"] if f["scan"] in ("complete", "summary only"))
            note += f" | bag: {scanned} of {len(bag['files'])} files scanned, metadata.yaml {bag['metadata']}"
        if "recovered" in r:
            rec = r["recovered"]
            span = "" if rec["log_time_span_ns"] is None else f" over {rec['log_time_span_ns'] / 1e9:.3f} s"
            note += f" | recording incomplete: {rec['messages']} messages recovered{span}"
        print(f"{r['overall'].upper()} | mode={r['scan_mode']} | scan_complete={r['scan_complete']} | "
              f"{r['status_counts']} | reports: {args.out}{note}")  # fmt: skip
        failing = {"warn": ("skipped", "warn", "fail"), "fail": ("fail",)}[args.fail_on]
        return EXIT_FINDINGS if r["overall"] in failing else EXIT_PASS
    except (OSError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return EXIT_ERROR


def _progress(quiet: bool):
    if quiet or not sys.stderr.isatty():
        return None

    def progress(done: int, total: int) -> None:
        print(f"\r  scanned {done / MiB:,.0f} / {total / MiB:,.0f} MiB ({100 * done / max(total, 1):.0f}%)",
              end="", file=sys.stderr, flush=True)  # fmt: skip

    return progress


def _manifest_command(args) -> int:
    from . import manifest as mf

    progress = _progress(args.quiet)
    if args.command == "manifest":
        if args.out.exists():
            raise ValueError("manifest file already exists; choose a new --out path")
        m = mf.build(args.recording, progress)
        if progress is not None:
            print(file=sys.stderr)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("x", encoding="utf-8") as f:
            f.write(json.dumps(m, indent=2, ensure_ascii=False))
        counts = "message counts recorded" if m["topics"] is not None else "no message counts: the scan was incomplete"
        print(f"Manifest written: {args.out} | {len(m['files'])} file(s) | {counts}")
        return EXIT_PASS
    if args.json is not None and args.json.exists():
        raise ValueError("--json file already exists; choose a new path")
    r = mf.verify(args.recording, mf.load(args.manifest), progress, args.manifest)
    if progress is not None:
        print(file=sys.stderr)
    for row in r["files"]:
        print(f"  {row['status'].upper():8} {row['name']}")
    if r["topics"] is not None:
        diff = [t for t in r["topics"] if t["status"] != "match"]
        print(f"  topics: {len(r['topics']) - len(diff)} of {len(r['topics'])} message counts match")
        for t in diff:
            print(f"    {t['topic']}: expected {t['expected']}, found {t['observed']}")
    else:
        print("  topics: message counts not compared (missing from the manifest, or the scan was incomplete)")
    if r["status"] == "match":
        print("MATCH | every file has the same bytes (SHA-256) as when the manifest was written")
    else:
        print("DIFFERENT | some files are changed, missing or extra; see above")
    if args.json is not None:
        with args.json.open("x", encoding="utf-8") as f:
            f.write(json.dumps(r, indent=2, ensure_ascii=False))
    return EXIT_PASS if r["status"] == "match" else EXIT_FINDINGS


if __name__ == "__main__":
    sys.exit(main())
