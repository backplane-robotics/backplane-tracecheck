"""Regenerate examples/expected.json (the golden results shared by Python and browser tests).

Run after intentional behaviour changes, then review the diff:  python tools/make_golden.py
"""

import json
import tempfile
from pathlib import Path

from tracecheck.engine import analyze_file
from tracecheck.samples import generate

ROOT = Path(__file__).resolve().parents[1]
DEMO = ["clean", "clean-zstd", "clean-lz4", "faults", "unchunked", "no-crc", "unsupported-codec", "malformed",
        "truncated"]  # fmt: skip
CASES = [(f"{n}.mcap", "demo-contract.json", False) for n in DEMO] + [
    ("clean-zstd.mcap", "demo-contract.json", True),
    ("faults.mcap", "demo-contract.json", True),
    ("fleet-zstd.mcap", "fleet-contract.json", False),
    ("fleet-zstd.mcap", "fleet-contract.json", True),
    ("fleet-dropout-lz4.mcap", "fleet-contract.json", False),
    ("interrupted-zstd.mcap", "fleet-contract.json", False),
    ("interrupted-zstd.mcap", "fleet-contract.json", True),
    ("fleet-paused-zstd.mcap", "fleet-contract.json", False),
    ("fleet-paused-zstd.mcap", "fleet-contract.json", True),
]


def main():
    cases = []
    with tempfile.TemporaryDirectory() as td:
        generate(Path(td))
        for name, contract, fast in CASES:
            c = json.loads((Path(td) / contract).read_text(encoding="utf-8"))
            r = analyze_file(Path(td) / name, c, fast=fast)
            case = {"file": name, "contract": contract}
            if fast:
                case["fast"] = True
            case.update(overall=r["overall"], scan_complete=r["scan_complete"],
                        checks={x["id"]: x["status"] for x in r["checks"]})  # fmt: skip
            cases.append(case)
    out = {"description": "Expected results for examples/. Shared by tests/test_streaming.py and web tests.",
           "cases": cases}  # fmt: skip
    (ROOT / "examples" / "expected.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    for c in cases:
        print(f"{c['file']:<26} fast={c.get('fast', False)!s:<5} {c['overall']:<5} "
              + " ".join(f"{k}={v[0].upper()}" for k, v in c["checks"].items()))


if __name__ == "__main__":
    main()
