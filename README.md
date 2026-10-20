# Backplane Tracecheck

**Check robot recordings against an explicit recording contract.**

Tracecheck reads an [MCAP](https://mcap.dev) recording (the default ROS 2 bag format) and checks it against a small JSON *recording contract*: which topics must be present, their schemas and encodings, message counts, rates, timestamp gaps, regressions, sequence continuity and time coverage. It produces a JSON report and a readable HTML report. Findings include relevant file locations where available; missing items are reported as gaps.

- Free and open source (Apache-2.0).
- Read-only. Message payloads are never executed, and are not decoded, with one narrow exception: from recognised recorder event messages (rosbag2_dynamic_recorder pause and topic events) only the action and topic name are read.
- Gaps covered by a pause or topic change that the recorder wrote into the recording are listed as explained instead of failing. The events are the recorder's own account; Tracecheck does not verify them.
- Checks a ROS 2 bag folder (`metadata.yaml` plus split `.mcap` files) as one recording: gaps and sequence breaks across file boundaries count, and the counts in `metadata.yaml` are compared with what the files contain (C11).
- No robot, ROS install, account or cloud service needed.
- Streams large recordings, subject to processing limits and available device resources (see the limit options below). zstd and lz4 chunks are decoded with bounded output.
- Runs as a Python CLI or in your browser at **[backplanerobotics.com/tracecheck](https://backplanerobotics.com/tracecheck/)**, where recording files are processed on your device and not uploaded.

Built by [Backplane Robotics](https://backplanerobotics.com).

## Install

```bash
pip install backplane-tracecheck
```

Requires Python 3.11+.

## Quick start

```bash
# Write the synthetic demo recordings and contract to ./examples
tracecheck samples

tracecheck validate-contract examples/demo-contract.json
tracecheck check examples/clean.mcap  --contract examples/demo-contract.json --out reports/clean
tracecheck check examples/faults.mcap --contract examples/demo-contract.json --out reports/faults

# A ROS 2 bag folder (metadata.yaml + split .mcap files), checked as one recording
tracecheck check examples/fleet-bag --contract examples/fleet-contract.json --out reports/fleet-bag

# Optional local browser UI (binds to 127.0.0.1 only)
tracecheck serve --open
```

`--out` must be a new directory. Existing reports are never overwritten.

**Useful options**

| Option | Effect |
|---|---|
| `--fast` | Read only the summary section: inventory, counts, schemas and metadata in milliseconds. Timing checks (C06–C10) skip. Falls back to a full scan if the file has no usable summary (for a bag folder, if any file has none, the whole folder is scanned in full). |
| `--ignore-missing-crc` | Don't warn when the writer stored no CRCs (same as `"missing_crc": "ignore"` in the contract). Corrupt CRCs still fail. |
| `--fail-on fail` | Exit 0 on warnings, exit 1 only on failures (the default `warn` also exits 1 on warnings). |
| `--timeout SECONDS` | Stop a scan that takes too long. |
| `--max-chunk-mib`, `--max-record-mib`, `--max-tracked-messages` | Raise or lower the memory safety limits (defaults: 256, 256, 20,000,000). |

**Exit codes**
- `0`: overall pass.
- `1`: contract failures, warnings or an incomplete scan (all recorded in the report).
- `2`: configuration, input or operational error, including a bag folder that can't be checked (for example, sqlite3 storage or rosbag2 file compression). No report is written.

## Check a copy after transfer

Write a manifest where the recording was made, then check the copy after upload, sync or archiving:

```bash
tracecheck manifest examples/fleet-bag --out fleet-bag.manifest.json
# ...copy the folder and the manifest somewhere else...
tracecheck verify /mnt/archive/fleet-bag --manifest fleet-bag.manifest.json
```

The manifest is JSON. It holds each file's size and SHA-256 (for a bag folder, every file in the folder, including `metadata.yaml`), plus the message count per topic. `verify` reports each file as `MATCH`, `CHANGED`, `MISSING` or `EXTRA`, and compares the topic counts. Exit `0` means every file matches, `1` means something differs, `2` means an error such as an invalid manifest. `--json FILE` also writes the result as JSON. Output files are never overwritten.

A matching SHA-256 shows that the copy has the same bytes as the files the manifest was written from. It does not show who made the recording, when, or that its contents are true. The manifest is not signed, so keep it somewhere the copy's handlers can't change it.

## In the browser

[backplanerobotics.com/tracecheck](https://backplanerobotics.com/tracecheck/) runs the same checks in a Web Worker, using a JavaScript port of the engine in [`web/src/engine/`](https://github.com/backplane-robotics/backplane-tracecheck/tree/main/web/src/engine).
- The recording file is read locally in slices and not uploaded.
- The site's Content-Security-Policy only allows connections back to the site itself.
- An optional **Send feedback** form posts only the fields shown in it to `/api/feedback`. It never attaches recordings, reports, contracts or filenames. See [docs/FEEDBACK.md](https://github.com/backplane-robotics/backplane-tracecheck/blob/main/docs/FEEDBACK.md).
- For the same inputs, the browser and CLI produce identical JSON reports, apart from timestamps and tool fields. The web test suite checks this.

## A minimal contract

```json
{
  "version": 1,
  "name": "My recording requirements",
  "topics": {
    "/my/topic": { "required": true, "min_count": 1 }
  }
}
```

Start minimal, then read the report's channel inventory to see the actual schema names, encodings and fingerprints. Add only the requirements you can justify. See [docs/CONTRACT_REFERENCE.md](https://github.com/backplane-robotics/backplane-tracecheck/blob/main/docs/CONTRACT_REFERENCE.md) for every key.

## The checks

| ID | Check |
|---|---|
| C01 | Readable bounded MCAP scan (with CRC verification where present) |
| C02 | Required topics contain messages |
| C03 | Profile, schema and encoding |
| C04 | Required file metadata |
| C05 | Message counts |
| C06 | Average recorded rate |
| C07 | Sorted timestamp gaps |
| C08 | Record-order timestamp regressions |
| C09 | Sequence continuity |
| C10 | Expected interval coverage |
| C11 | ROS 2 bag metadata agreement (bag folders only) |

**Statuses**
- **PASS:** the configured requirement was met.
- **WARN:** a scoped limitation, for example message data with no CRC coverage. Default ROS 2 files with chunk CRCs pass.
- **FAIL:** an unmet requirement or a failed scan. It does not mean the robot is unsafe.
- **SKIPPED:** no conclusion was reached.

Tracecheck does not certify safety, establish legal or regulatory compliance, determine causality or measure transport latency. File hashes in reports identify the exact bytes checked; they do not establish authenticity.

## Development

```bash
python -m venv .venv
.venv/Scripts/activate        # Windows; use `source .venv/bin/activate` elsewhere
pip install -e ".[dev]"
python -m pytest
```

After an intentional behaviour change, regenerate the golden results shared by both test suites and review the diff:

```bash
tracecheck samples && python tools/make_golden.py
```

**Website** (Node 20+):

```bash
cd web
npm install
npm test          # engine parity tests against examples/ and the Python engine
npm run dev       # local dev server
npm run build     # static site in web/dist (deployed by Cloudflare Workers, see wrangler.jsonc)
```

## Repository layout

| Path | Contents |
|---|---|
| `src/tracecheck/` | Python package and CLI |
| `tests/` | Engine, streaming, contract, CLI and local-server tests |
| `examples/` | Synthetic MCAP recordings, contracts and golden results (invented data) |
| `docs/` | Contract reference and third-party notices |
| `tools/` | Maintenance scripts (golden-result generator) |
| `web/` | Browser-only website and Tracecheck web app for backplanerobotics.com |

## License

Apache-2.0. See [LICENSE](https://github.com/backplane-robotics/backplane-tracecheck/blob/main/LICENSE) and [NOTICE](https://github.com/backplane-robotics/backplane-tracecheck/blob/main/NOTICE). Copyright 2026 Backplane Robotics LLC.
