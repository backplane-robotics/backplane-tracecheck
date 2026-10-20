# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Incomplete recordings.** A file that ends before its MCAP footer (for example, a recorder that stopped mid-write, or a file cut off while copying) now gets a specific C01 finding and a `recovered` report section: readable bytes, complete messages, log-time span, per-topic counts, and whether all message data was read. The other checks stay skipped; they are not evaluated on partial data. Shown in the CLI summary, the web app and the HTML report.
- `interrupted-zstd.mcap` synthetic example and web demo.
- **Gaps explained by recorder events.** When a recording contains rosbag2_dynamic_recorder (dynrec) `PauseEvent` or `SubscriptionChangeEvent` messages, C07 lists gaps covered by a recorded pause or topic unsubscribe as *explained* (with `explained_gap_count` and `explained_gaps`); they don't fail. Unexplained gaps still fail. The events are the recorder's own account and are not verified. Only their action and topic name are read; all other payloads stay opaque. Applies to the `log_time` basis only. A new top-level `recorder_events` section summarises the events found.
- `fleet-paused-zstd.mcap` synthetic example and "Paused recording (dynrec)" web demo.
- FCC Covered List robot tracker page on the website (`/tools/covered-list-robots/`).
- **ROS 2 bag folders.** `tracecheck check <folder>` and the web app (*Choose a bag folder*, or drop a folder) check a rosbag2 folder (`metadata.yaml` plus split `.mcap` files) as one recording. Channels are matched across files, so gaps, regressions and sequence breaks across file boundaries count. New check **C11 ROS 2 bag metadata agreement** compares the folder and the per-file, per-topic and total message counts with `metadata.yaml`; a listed file that is missing fails, and an unlisted `.mcap` warns and is not checked. A new `bag` report section lists each file with its size, SHA-256 and scan state; finding locations include a `file` key; `recovered` names the `incomplete_file`. Non-MCAP storage and rosbag2 file compression are refused (exit 2).
- `fleet-bag/` and `fleet-bag-interrupted/` synthetic examples and web demos.

### Changed
- Fast mode falls back to a full scan when the file doesn't end with the MCAP magic bytes, so incomplete files get the recovered summary.
- Web demo list: the interrupted fleet recording replaces the small truncated demo; the dropout demo is correctly described as a lidar (`/scan`) outage.
- Tracecheck page and landing page Pro note: "folder-based processing" now reads "checking many recordings at once", since checking one bag folder is free.
- **C06 average rate leaves out recorded pauses.** When a recording contains dynrec pause or unsubscribe events, the rate bounds are applied to `active_hz`, which leaves out the time those events cover. The finding also reports `observed_hz` (whole span, as before), `excluded_ns` and `excluded_by`. Recordings without such events are unchanged.

## [0.2.0] - 2026-10-14

### Added
- **Compressed chunks.** zstd and lz4 chunks are decoded, with output strictly capped at the declared uncompressed size, so decompression bombs fail safely.
- **Streaming reader** (`tracecheck.reader`): a self-contained, bounded MCAP parser. SHA-256 and CRCs are computed in a single pass, and memory is bounded by explicit limits. The 64 MiB file-size cap is gone.
- **Fast mode** (`--fast`): reads only the summary section for an instant inventory, counts, schemas and metadata check. It falls back to a full scan when the summary is missing or incomplete.
- **`missing_crc` contract key** (`"warn"` or `"ignore"`) and the `--ignore-missing-crc` flag.
- Summary-section CRC verification.
- CLI flags: `--fail-on`, `--timeout`, `--max-chunk-mib`, `--max-record-mib`, `--max-tracked-messages`, `--quiet`, `--version`, and `samples --dest`.
- Report fields (`report_version` 2): `scan_mode`, `fast_mode_fallback`, `compression`, `scan_stats`, `checksum_coverage`.
- More synthetic examples: zstd, lz4, unchunked, no-CRC, unsupported-codec, malformed and truncated files, plus a 4-topic mobile-robot recording with and without a sensor dropout. `examples/expected.json` holds the golden results shared by the Python and browser test suites.
- **Web app** (`web/`): a browser-only static site for backplanerobotics.com with the Tracecheck app.
  - A JavaScript port of the engine running in a Web Worker. Files never leave the browser.
  - Handles multi-GB files and zstd/lz4 chunks.
  - Demo recordings, a contract editor, and JSON/HTML report downloads.
  - Reports are byte-identical to the Python CLI's, apart from timestamps and tool fields.
  - A strict Content-Security-Policy.

### Changed
- Renamed the project from "Recording Health Checker" to **Backplane Tracecheck**.
  - The Python package `rhc` is now `tracecheck`.
  - The PyPI distribution is `backplane-tracecheck`.
  - The CLI command is `tracecheck`.
- `tracecheck check` runs in-process, with no subprocess and no size cap. The local `serve` UI keeps its 64 MiB upload limit.
- **Missing-CRC rule.** C01 now warns only when some message data has no CRC coverage. Default ROS 2 files, which have chunk CRCs but no data-section CRC, now pass.
- Packaged with `pyproject.toml` (hatchling), replacing `requirements*.txt` and the Windows `.cmd` launchers.
- Relicensed as Apache-2.0 open source.

### Fixed
- The local server no longer returns stderr text or the user's home path in error responses.
- The local server now requires a matching `Origin` header on POST requests.

### Removed
- MVP governance, evidence, QA and marketing files were moved out of the repository into a local archive.

## [0.1.0] - 2026-10-13

### Added
- Initial MVP: CLI and local browser UI, 10 contract checks, JSON and HTML reports, and synthetic examples.
