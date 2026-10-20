# Contract reference · version 1

Contracts are UTF-8 JSON objects up to 64 KiB. Keys are case-sensitive; duplicate and unknown keys are rejected. All time values are integer **nanoseconds**, not seconds or formatted dates. Numbers must be finite, nonnegative and no greater than 2^64−1. Booleans do not count as numbers. Names/keys must be 1–256 characters, except the optional profile may be empty.

## Top-level keys

| Key | Meaning |
|---|---|
| `version` | Required integer `1`. |
| `name` | Required human-readable contract name. |
| `profile` | Optional exact MCAP Header profile string; empty is valid. |
| `missing_crc` | Optional `"warn"` (default) or `"ignore"`. Controls whether C01 warns when some message data has no CRC coverage (see *Scan and checksums* below). Corrupt CRCs always fail, whatever this setting. The CLI flag `--ignore-missing-crc` and the web app toggle set it to `"ignore"`. |
| `metadata` | Optional object: metadata-record name → required key → exact string or `null` for present/nonempty. Multiple records with the same name must all satisfy each requested key. No payload fields or Channel metadata are searched. |
| `topics` | Required object with 1–50 exact topic names, each mapping to the options below. No glob or regex matching. |

## Topic options

| Key | Type / behavior |
|---|---|
| `required` | Boolean, default true: at least one Message on any channel with this topic. Channel registration alone is insufficient. |
| `message_encoding` | Optional exact Channel encoding, e.g. `json` or `cdr`. Does not decode or validate payloads. |
| `schema_name`, `schema_encoding` | Optional exact Schema identity fields. A legal schema-id-zero channel fails these expectations if specified. |
| `schema_sha256` | Optional 64 lowercase hex characters; exact Schema byte fingerprint. Whitespace/schema serialization changes affect it. |
| `min_count`, `max_count` | Optional inclusive integer bounds, applied independently to every matching channel. |
| `time_basis` | `log_time` (default) or `publish_time`. These are MCAP Message fields, not decoded ROS header stamps. |
| `clock_confirmed` | Boolean, default false. All four timing checks skip unless true. User asserts the clock is interpretable for this requirement. |
| `min_rate_hz`, `max_rate_hz` | Optional inclusive bounds for observed average `(N−1)/(last−first)` after sorting. Not windowed rate or proof of session completeness. Use interval/gap checks too. |
| `max_gap_ns` | Optional inclusive upper limit between adjacent **sorted** timestamps. Does not include leading/trailing gaps. On the `log_time` basis, a gap covered by a rosbag2_dynamic_recorder pause or unsubscribe event in the recording is listed under `explained_gaps` and does not fail, provided no uncovered part of the gap exceeds the limit. |
| `check_regression` | Boolean, default false. Strict decreases in **physical record order** fail; equal timestamps pass. |
| `sequence` | `disabled` (default) or `increment_mod32`. The latter asserts one unit-incrementing sequence source per channel, allowing wrap from 2^32−1 to 0; resets, duplicates and jumps fail. |
| `interval_ns` | Optional inclusive `[start,end]`, with start < end, on the selected clock. All recorded timestamps must be inside; first and last must reach the respective boundaries within tolerance. |
| `boundary_tolerance_ns` | Nonnegative integer, default 0; at most half the interval length. |

Omit rate/gap/interval/sequence requirements if their assumptions are unavailable. A timestamp of zero is legal, including robot boot time. `publish_time == log_time` may indicate unavailable publication time; it is not evidence of zero latency. No cross-clock subtraction or sensor synchronization diagnosis is performed.

Multiple channels sharing a topic remain separate. A required topic can be present while one of its channels fails its count/encoding/timing requirement. This conservative behavior can produce findings for a zero-message channel; adapt the contract or investigate the recording rather than assuming channels share publishers or clocks.

Absence has different meanings: required missing topic fails C02, while dependent channel checks skip because there is no channel to inspect. If the overall scan fails, C02–C10 all skip and C01 fails. If no requirement applies to a check, it skips. Skipped results do not establish health.

The JSON report embeds the complete contract and hashes its normalized UTF-8 JSON (`sort_keys=True`, compact separators, Unicode preserved). The contract hash identifies effective content rather than the original indentation/byte layout. Reports also include the source byte SHA-256 and tool/reader/Python versions. Contracts and schema bytes are not executed.

## Scan and checksums (C01)

- **Full scan** (default) streams the whole file. It computes the file SHA-256 and verifies every CRC that is present: the data-section CRC in the Data End record, each chunk's CRC of its uncompressed records, and the summary CRC in the footer. Attachment CRCs are not checked. Attachments and unknown record types are hashed but skipped.
- **CRC coverage rule.** C01 warns about missing CRCs only when the data-section CRC is absent **and** some message data is not covered by another CRC: a chunk without a CRC, or a message outside any chunk. Default ROS 2 recordings, with chunk CRCs but no data-section CRC, therefore pass. Set `missing_crc` to `"ignore"` to suppress the warning entirely.
- **Compression.** Chunks may be uncompressed, `zstd` or `lz4`. Decompressed output is capped at the chunk's declared uncompressed size. A mismatch, any other codec, or a chunk above the size limit fails C01.
- **Fast mode** (`--fast` in the CLI, the toggle in the web app) reads only the header, footer and summary section (Statistics, Channel, Schema and indexed Metadata records) and checks the summary CRC. C01–C05 run on that information; C06–C10 skip because they need every timestamp. If the summary is missing or lacks Statistics, the scan falls back to a full scan and records `fast_mode_fallback` in the report. In fast mode `source.sha256` is `null`.
- **Limits.** Defaults: 256 MiB per record, uncompressed chunk and summary section; 20 million tracked timestamps for sorted-gap checks; 10,000 schemas/channels/metadata records. Exceeding a limit fails C01 with an explanation, rather than exhausting memory. The CLI exposes `--max-chunk-mib`, `--max-record-mib`, `--max-tracked-messages` and `--timeout`. There is no overall file-size cap.
