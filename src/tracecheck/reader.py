"""Strict, bounded, streaming MCAP reader used by Backplane Tracecheck.

The reader parses MCAP records itself (the record layouts are small and fixed by
the MCAP specification) so that every length is checked before any allocation,
and so the browser implementation in ``web/`` can mirror it exactly.

* Full mode reads the file once, sequentially, in bounded pieces. SHA-256 and the
  MCAP data-section / summary CRCs are computed on the fly. zstd and lz4 chunks
  are decompressed with output capped at the chunk's declared size, which must
  itself be under a configured limit.
* Fast mode reads only the header, footer and summary section (plus indexed
  metadata records), so multi-GB files are inventoried in milliseconds.

Message payloads are not decoded, except recognised recorder event messages (see
``events.py``), from which only an action and a topic name are read.
"""

from __future__ import annotations

import hashlib
import io
import struct
import time
import zlib
from array import array
from dataclasses import dataclass, field
from typing import BinaryIO, Callable

from . import events as rec_events

MAGIC = b"\x89MCAP0\r\n"
(
    OP_HEADER,
    OP_FOOTER,
    OP_SCHEMA,
    OP_CHANNEL,
    OP_MESSAGE,
    OP_CHUNK,
    OP_MESSAGE_INDEX,
    OP_CHUNK_INDEX,
    OP_ATTACHMENT,
    OP_ATTACHMENT_INDEX,
    OP_STATISTICS,
    OP_METADATA,
    OP_METADATA_INDEX,
    OP_SUMMARY_OFFSET,
    OP_DATA_END,
) = range(1, 16)
KNOWN_OPCODES = frozenset(range(1, 16))
CHUNK_OPCODES = frozenset({OP_SCHEMA, OP_CHANNEL, OP_MESSAGE})

MiB = 1 << 20
TEXT_LIMIT = 1024  # names, topics, encodings, profile, library, metadata keys
META_VALUE_LIMIT = 65536  # ROS 2 stores QoS YAML in channel metadata values
META_PAIRS_LIMIT = 100
FOOTER_RECORD_SIZE = 1 + 8 + 20
SUPPORTED_COMPRESSION = ("", "zstd", "lz4")

_U16 = struct.Struct("<H")
_U32 = struct.Struct("<I")
_U64 = struct.Struct("<Q")
_MSG = struct.Struct("<HIQQ")


@dataclass(frozen=True)
class Limits:
    """Resource bounds. Exceeding any limit stops the scan without conclusions."""

    max_record_bytes: int = 256 * MiB
    max_chunk_uncompressed_bytes: int = 256 * MiB
    max_summary_bytes: int = 256 * MiB
    max_messages: int = 10**12
    max_records: int = 10**12
    max_tracked_messages: int = 20_000_000
    max_entities: int = 10_000
    max_seconds: float | None = None
    evidence_per_finding: int = 20


class ScanError(ValueError):
    """The recording could not be read within the format rules and limits."""


class ScanTimeout(ScanError):
    """The configured wall-clock limit was reached."""


class ScanTruncated(ScanError):
    """The file ends before its MCAP structure is complete (for example, no footer).

    A recording that stopped unexpectedly, a file cut off during copying, or a corrupted
    record length all look like this; the file alone cannot tell them apart.
    """


# --------------------------------------------------------------------------- parsing


class _Cursor:
    """Strict little-endian field reader over a byte buffer."""

    __slots__ = ("b", "p", "end")

    def __init__(self, b: bytes | memoryview, start: int = 0, end: int | None = None):
        self.b = b
        self.p = start
        self.end = len(b) if end is None else end

    def take(self, n: int) -> int:
        if n < 0 or n > self.end - self.p:
            raise ScanError("field exceeds record boundary")
        p = self.p
        self.p = p + n
        return p

    def u8(self) -> int:
        return self.b[self.take(1)]

    def u16(self) -> int:
        return _U16.unpack_from(self.b, self.take(2))[0]

    def u32(self) -> int:
        return _U32.unpack_from(self.b, self.take(4))[0]

    def u64(self) -> int:
        return _U64.unpack_from(self.b, self.take(8))[0]

    def raw(self, n: int) -> bytes:
        p = self.take(n)
        return bytes(self.b[p : p + n])

    def string(self, limit: int = TEXT_LIMIT) -> str:
        n = self.u32()
        p = self.take(n)
        if n > limit * 4:
            raise ScanError(f"record text field exceeds {limit} characters")
        try:
            s = bytes(self.b[p : p + n]).decode("utf-8")
        except UnicodeDecodeError as e:
            raise ScanError("record text field is not valid UTF-8") from e
        if len(s) > limit:
            raise ScanError(f"record text field exceeds {limit} characters")
        return s

    def string_map(self) -> dict[str, str]:
        n = self.u32()
        sub = _Cursor(self.b, self.take(n), self.p)
        out: dict[str, str] = {}
        pairs = 0
        while sub.p < sub.end:
            pairs += 1
            if pairs > META_PAIRS_LIMIT:
                raise ScanError("metadata field or pair count exceeds limit")
            key = sub.string(TEXT_LIMIT)
            out[key] = sub.string(META_VALUE_LIMIT)
        return out

    def u16_u64_map(self) -> dict[int, int]:
        n = self.u32()
        sub = _Cursor(self.b, self.take(n), self.p)
        out: dict[int, int] = {}
        while sub.p < sub.end:
            key = sub.u16()
            out[key] = sub.u64()
        return out


def _parse_header(c: _Cursor) -> tuple[str, str]:
    return c.string(), c.string()


def _parse_schema(c: _Cursor) -> tuple[int, dict]:
    sid = c.u16()
    name = c.string()
    encoding = c.string()
    data = c.raw(c.u32())
    if sid == 0:
        raise ScanError("schema id zero is reserved")
    return sid, {"name": name, "encoding": encoding, "sha256": hashlib.sha256(data).hexdigest()}


def _parse_channel(c: _Cursor) -> tuple[int, dict]:
    cid = c.u16()
    schema_id = c.u16()
    topic = c.string()
    encoding = c.string()
    metadata = c.string_map()
    return cid, {"topic": topic, "schema_id": schema_id, "message_encoding": encoding, "metadata": metadata}


def _parse_metadata(c: _Cursor) -> tuple[str, dict[str, str]]:
    return c.string(), c.string_map()


def iter_records(buf: bytes, start: int = 0, end: int | None = None):
    """Yield ``(offset, opcode, body_start, body_end)`` for consecutive records in ``buf``."""
    end = len(buf) if end is None else end
    p = start
    while p < end:
        if end - p < 9:
            raise ScanError("truncated record header")
        op = buf[p]
        length = _U64.unpack_from(buf, p + 1)[0]
        body = p + 9
        if length > end - body:
            raise ScanError("record extends beyond its container")
        yield p, op, body, body + length
        p = body + length


def decompress(compression: str, data: bytes, size: int) -> bytes:
    """Decompress a chunk, producing at most ``size`` bytes; any other length is an error."""
    if compression not in ("zstd", "lz4"):
        raise ScanError(f"unsupported compression: {compression[:40]!r}")
    try:
        if compression == "zstd":
            import zstandard

            parts, total = [], 0
            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(data), read_across_frames=True) as r:
                while total <= size:
                    part = r.read(min(MiB, size + 1 - total))
                    if not part:
                        break
                    parts.append(part)
                    total += len(part)
            out = b"".join(parts)
        else:
            import lz4.frame

            out = lz4.frame.LZ4FrameDecompressor().decompress(data, max_length=size + 1)
    except Exception as e:  # codec libraries raise their own exception types
        raise ScanError(f"{compression} chunk decompression failed: {str(e)[:120]}") from e
    if len(out) != size:
        raise ScanError("decompressed chunk size differs from declared uncompressed size")
    return out


# --------------------------------------------------------------------------- tracking


@dataclass(frozen=True)
class TrackConfig:
    """What the contract needs to know about one channel's messages."""

    basis_log: bool = True
    sequence: bool = False
    max_gap: int | None = None  # set only when a gap check will run


class Track:
    """Incremental per-channel statistics; memory is O(1) unless a gap check needs timestamps."""

    __slots__ = (
        "cid", "cfg", "ev", "count", "first", "last", "lo", "hi", "monotonic",
        "seq_bad", "seq_bad_n", "reg_bad", "reg_bad_n", "gap_bad", "gap_bad_n",
        "times", "ords", "loc_a", "loc_b",
    )  # fmt: skip

    def __init__(self, cid: int, cfg: TrackConfig | None, evidence_limit: int):
        self.cid = cid
        self.cfg = cfg
        self.ev = evidence_limit
        self.count = 0
        self.first = self.last = self.lo = self.hi = None
        self.monotonic = True
        self.seq_bad: list = []
        self.reg_bad: list = []
        self.gap_bad: list = []
        self.seq_bad_n = self.reg_bad_n = self.gap_bad_n = 0
        gap = cfg is not None and cfg.max_gap is not None
        self.times = array("Q") if gap else None
        self.ords = array("Q") if gap else None
        self.loc_a = array("q") if gap else None
        self.loc_b = array("q") if gap else None

    def add(self, m: tuple) -> None:
        """``m`` is ``(ordinal, loc_a, loc_b, log_time, publish_time, sequence)``."""
        self.count += 1
        cfg = self.cfg
        k = 3 if cfg.basis_log else 4
        t = m[k]
        prev = self.last
        if prev is None:
            self.first = self.lo = self.hi = m
        else:
            if cfg.sequence and m[5] != (prev[5] + 1) & 0xFFFFFFFF:
                self.seq_bad_n += 1
                if len(self.seq_bad) < self.ev:
                    self.seq_bad.append((prev, m))
            pt = prev[k]
            if t < pt:
                self.monotonic = False
                self.reg_bad_n += 1
                if len(self.reg_bad) < self.ev:
                    self.reg_bad.append((prev, m))
            elif self.monotonic and cfg.max_gap is not None and t - pt > cfg.max_gap:
                self.gap_bad_n += 1
                if len(self.gap_bad) < self.ev:
                    self.gap_bad.append((prev, m))
            if t < self.lo[k]:
                self.lo = m
            if t >= self.hi[k]:
                self.hi = m
        self.last = m
        if self.times is not None:
            self.times.append(t)
            self.ords.append(m[0])
            self.loc_a.append(m[1])
            self.loc_b.append(m[2])

    def sorted_gaps(self, explain: Callable[[int, int], list | None] | None = None) -> tuple[list, int, list, int]:
        """Return (sample, total, explained sample, explained total) of sorted-adjacent gaps above ``max_gap``.

        Each sample item is ``(prev_index, cur_index, gap)`` into the stored arrays, or, for the
        in-order fast path without ``explain``, ``(prev_msg, cur_msg, gap)`` tuples. When ``explain``
        is given, items are always index-based, and gaps it explains are counted separately with
        its labels as a fourth item.
        """
        k = 3 if self.cfg.basis_log else 4
        if self.monotonic and explain is None:
            return [(a, b, b[k] - a[k]) for a, b in self.gap_bad], self.gap_bad_n, [], 0
        times, limit = self.times, self.cfg.max_gap
        if self.monotonic:
            order = range(len(times))
        else:
            order = sorted(range(len(times)), key=times.__getitem__)  # stable: ties keep file order
        sample, total, explained, explained_n = [], 0, [], 0
        for i in range(1, len(order)):
            a, b = order[i - 1], order[i]
            g = times[b] - times[a]
            if g > limit:
                why = explain(times[a], times[b]) if explain is not None else None
                if why:
                    explained_n += 1
                    if len(explained) < self.ev:
                        explained.append((a, b, g, why))
                    continue
                total += 1
                if len(sample) < self.ev:
                    sample.append((a, b, g))
        return sample, total, explained, explained_n


# --------------------------------------------------------------------------- results


@dataclass
class ScanResult:
    mode: str
    size: int
    sha256: str | None = None
    profile: str | None = None
    schemas: dict = field(default_factory=dict)
    channels: dict = field(default_factory=dict)
    metadata: list = field(default_factory=list)
    tracks: dict = field(default_factory=dict)
    counts: dict | None = None  # fast mode: channel id -> message count
    crc: dict = field(default_factory=dict)
    compression: dict = field(default_factory=dict)
    unknown: int = 0
    stats: dict = field(default_factory=dict)
    fast_fallback: str | None = None
    # Full scan only. Used to describe how much of a cut-off file was readable.
    complete_bytes: int = 0  # end offset of the last complete top-level record
    data_end_seen: bool = False
    log_time_range: tuple[int, int] | None = None  # min and max log_time over all messages read
    # Full scan only. Recognised recorder event messages; None when the recording has none.
    recorder_events: dict | None = None
    events: list = field(default_factory=list)  # (log_time, ordinal, kind, action, topic)


class _Registry:
    """Schema/channel/metadata bookkeeping shared by both scan modes."""

    def __init__(self, result: ScanResult, limits: Limits):
        self.r = result
        self.limits = limits

    def _bound(self) -> None:
        r, n = self.r, self.limits.max_entities
        if len(r.channels) > n or len(r.schemas) > n or len(r.metadata) > n:
            raise ScanError(f"channel/schema/metadata count exceeds {n}")

    def schema(self, c: _Cursor, loc: dict) -> None:
        sid, value = _parse_schema(c)
        old = self.r.schemas.get(sid)
        if old is not None and old["value"] != value:
            raise ScanError("conflicting repeated schema id")
        self.r.schemas.setdefault(sid, {"value": value, "location": loc})
        self._bound()

    def channel(self, c: _Cursor, loc: dict) -> int:
        cid, value = _parse_channel(c)
        if value["schema_id"] and value["schema_id"] not in self.r.schemas:
            raise ScanError("channel references undefined schema")
        old = self.r.channels.get(cid)
        if old is not None and old["value"] != value:
            raise ScanError("conflicting repeated channel id")
        self.r.channels.setdefault(cid, {"value": value, "location": loc})
        self._bound()
        return cid

    def metadata(self, c: _Cursor, loc: dict) -> None:
        name, fields = _parse_metadata(c)
        self.r.metadata.append({"name": name, "fields": fields, "location": loc})
        self._bound()


class _Source:
    """Sequential, strictly bounded file reader that hashes and CRCs every byte."""

    def __init__(self, f: BinaryIO, size: int, progress: Callable[[int, int], None] | None):
        self.f = f
        self.size = size
        self.pos = 0
        self.sha = hashlib.sha256()
        self.crc = 0
        self.progress = progress
        self._next_progress = 8 * MiB

    def read(self, n: int) -> bytes:
        if n < 0 or n > self.size - self.pos:
            raise ScanTruncated("record extends beyond end of file")
        data = self.f.read(n)
        if len(data) != n:
            raise ScanTruncated("unexpected end of file")
        self.pos += n
        self.sha.update(data)
        self.crc = zlib.crc32(data, self.crc)
        if self.progress is not None and self.pos >= self._next_progress:
            self._next_progress = self.pos + 8 * MiB
            self.progress(self.pos, self.size)
        return data

    def skip(self, n: int) -> None:
        if n < 0 or n > self.size - self.pos:
            raise ScanTruncated("record extends beyond end of file")
        while n:
            step = min(n, 4 * MiB)
            self.read(step)
            n -= step

    def drain(self) -> None:
        """Hash the rest of the file after a failed scan, so the report identifies all bytes."""
        try:
            self.skip(self.size - self.pos)
        except (ScanError, OSError):
            pass


# --------------------------------------------------------------------------- full scan


def scan_full(
    f: BinaryIO,
    size: int,
    plan: Callable[[str], TrackConfig | None],
    limits: Limits | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> ScanResult:
    """Read every record. Raises ScanError (with ``.result`` partially filled) on failure."""
    limits = limits or Limits()
    started = time.monotonic()
    r = ScanResult(mode="full", size=size)
    r.crc = {
        "data_section": "absent",
        "chunk_present_verified": 0,
        "chunk_absent": 0,
        "summary": "no summary section",
        "attachments": "not checked",
    }
    r.compression = {}
    reg = _Registry(r, limits)
    src = _Source(f, size, progress)
    stats = {"records": 0, "messages": 0, "unchunked_messages": 0, "chunks": 0, "attachments_skipped": 0}
    r.stats = stats
    tracks = r.tracks
    tracked = 0
    ev = limits.evidence_per_finding
    ended = False
    header_seen = False
    summary_crc_start = None
    t_lo = t_hi = None
    event_kind: dict[int, str] = {}  # channel id -> recognised recorder event type

    def on_event(kind: str, buf, body: int, end: int, log_t: int) -> None:
        info = r.recorder_events
        if info is None:
            info = r.recorder_events = {"recorder": "rosbag2_dynamic_recorder (dynrec)", "message_counts": {},
                                        "decoded": 0, "undecodable": 0, "limit_reached": False,
                                        "note": rec_events.NOTE}  # fmt: skip
        counts = info["message_counts"]
        counts[kind] = counts.get(kind, 0) + 1
        if kind not in ("PauseEvent", "SubscriptionChangeEvent"):
            return
        ev_ = rec_events.decode(kind, bytes(buf[body + 22 : end]))
        if ev_ is None:
            info["undecodable"] += 1
        elif len(r.events) >= rec_events.EVENT_LIMIT:
            info["limit_reached"] = True
        else:
            info["decoded"] += 1
            r.events.append((log_t, stats["messages"], ev_[0], ev_[1], ev_[2]))

    def on_message(buf, body, end, a: int, b: int) -> None:
        nonlocal tracked, t_lo, t_hi
        if end - body < 22:
            raise ScanError("message record too short")
        cid, seq, log_t, pub_t = _MSG.unpack_from(buf, body)
        tr = tracks.get(cid)
        if ended or tr is None:
            raise ScanError("message after DataEnd or undefined channel")
        stats["messages"] += 1
        if stats["messages"] > limits.max_messages:
            raise ScanError(f"message count exceeds {limits.max_messages}")
        if t_lo is None or log_t < t_lo:
            t_lo = log_t
        if t_hi is None or log_t > t_hi:
            t_hi = log_t
        kind = event_kind.get(cid)
        if kind is not None:
            on_event(kind, buf, body, end, log_t)
        if tr.cfg is None:
            tr.count += 1
            return
        if tr.times is not None:
            tracked += 1
            if tracked > limits.max_tracked_messages:
                raise ScanError(
                    f"gap-check timestamp storage exceeds {limits.max_tracked_messages} messages; "
                    "raise the max_tracked_messages limit"
                )
        tr.add((stats["messages"], a, b, log_t, pub_t, seq))

    def on_channel(c: _Cursor, loc: dict) -> None:
        cid = reg.channel(c, loc)
        if cid not in tracks:
            ch = r.channels[cid]["value"]
            tracks[cid] = Track(cid, plan(ch["topic"]), ev)
            schema = r.schemas.get(ch["schema_id"], {}).get("value", {})
            kind = rec_events.event_type(schema.get("name"), ch["message_encoding"])
            if kind is not None:
                event_kind[cid] = kind

    def count_record() -> None:
        stats["records"] += 1
        if stats["records"] > limits.max_records:
            raise ScanError("record count exceeds limit")
        if limits.max_seconds is not None and (stats["records"] & 0x3FF) == 0:
            if time.monotonic() - started > limits.max_seconds:
                raise ScanTimeout(f"scan time exceeds {limits.max_seconds} seconds")

    try:
        if src.read(8) != MAGIC:
            raise ScanError("not an MCAP file (bad magic)")
        while True:
            r.complete_bytes = src.pos
            if size - src.pos < 9:
                raise ScanTruncated("unexpected end of file (missing footer)")
            crc_before = src.crc
            offset = src.pos
            head = src.read(9)
            op = head[0]
            length = _U64.unpack_from(head, 1)[0]
            count_record()
            if not header_seen and op != OP_HEADER:
                raise ScanError("first record must be Header")
            loc = {"file_offset": offset}
            if op == OP_FOOTER:
                if length < 20:
                    raise ScanError("footer record too short")
                body = src.read(16)
                summary_start = _U64.unpack_from(body, 0)[0]
                crc_mid = src.crc
                summary_crc = _U32.unpack_from(src.read(4), 0)[0]
                src.skip(length - 20)
                if summary_start == 0:
                    r.crc["summary"] = "no summary section"
                elif summary_start != summary_crc_start:
                    r.crc["summary"] = "not checked"
                elif summary_crc == 0:
                    r.crc["summary"] = "absent"
                elif summary_crc != crc_mid:
                    raise ScanError("summary CRC mismatch")
                else:
                    r.crc["summary"] = "verified"
                if src.read(8) != MAGIC:
                    raise ScanError("missing trailing magic")
                if src.pos != size:
                    raise ScanError("trailing bytes after footer magic")
                break
            if op not in (OP_HEADER, OP_SCHEMA, OP_CHANNEL, OP_MESSAGE, OP_CHUNK, OP_METADATA, OP_DATA_END):
                src.skip(length)
                if op == OP_ATTACHMENT:
                    stats["attachments_skipped"] += 1
                elif op not in KNOWN_OPCODES:
                    r.unknown += 1
                continue
            if length > limits.max_record_bytes:
                raise ScanError(f"record length exceeds {limits.max_record_bytes} byte limit")
            buf = src.read(length)
            c = _Cursor(buf)
            if op == OP_HEADER:
                if header_seen:
                    raise ScanError("repeated Header")
                header_seen = True
                r.profile, _library = _parse_header(c)
            elif op == OP_SCHEMA:
                reg.schema(c, loc)
            elif op == OP_CHANNEL:
                on_channel(c, loc)
            elif op == OP_MESSAGE:
                stats["unchunked_messages"] += 1
                on_message(buf, 0, length, offset, -1)
            elif op == OP_METADATA:
                if not ended:
                    reg.metadata(c, loc)
            elif op == OP_DATA_END:
                if ended:
                    raise ScanError("repeated DataEnd")
                ended = True
                r.data_end_seen = True
                data_crc = c.u32()
                if data_crc and data_crc != crc_before:
                    raise ScanError("data section CRC mismatch")
                r.crc["data_section"] = "verified" if data_crc else "absent"
                src.crc = 0
                summary_crc_start = src.pos
            elif op == OP_CHUNK:
                if ended:
                    raise ScanError("chunk after DataEnd")
                stats["chunks"] += 1
                c.u64()  # message_start_time
                c.u64()  # message_end_time
                usize = c.u64()
                ucrc = c.u32()
                compression = c.string()
                n = c.u64()
                p = c.take(n)
                if compression not in SUPPORTED_COMPRESSION:
                    raise ScanError(f"unsupported compression: {compression[:40]!r}")
                if compression == "":
                    if usize != n:
                        raise ScanError("chunk size inconsistent with uncompressed size")
                    inner = memoryview(buf)[p : p + n]
                else:
                    if usize > limits.max_chunk_uncompressed_bytes:
                        raise ScanError(
                            f"chunk declares {usize} uncompressed bytes, above the "
                            f"{limits.max_chunk_uncompressed_bytes} byte limit"
                        )
                    inner = decompress(compression, buf[p : p + n], usize)
                r.compression[compression or "none"] = r.compression.get(compression or "none", 0) + 1
                if ucrc:
                    if zlib.crc32(inner) != ucrc:
                        raise ScanError("chunk CRC mismatch")
                    r.crc["chunk_present_verified"] += 1
                else:
                    r.crc["chunk_absent"] += 1
                for ioff, iop, ib, ie in iter_records(inner):
                    count_record()
                    if iop == OP_MESSAGE:
                        on_message(inner, ib, ie, offset, ioff)
                    elif iop == OP_CHANNEL:
                        on_channel(_Cursor(inner, ib, ie), {"chunk_file_offset": offset, "chunk_inner_offset": ioff})
                    elif iop == OP_SCHEMA:
                        reg.schema(_Cursor(inner, ib, ie), {"chunk_file_offset": offset, "chunk_inner_offset": ioff})
                    elif iop in KNOWN_OPCODES:
                        raise ScanError("unsupported record inside chunk")
                    else:
                        r.unknown += 1
        r.sha256 = src.sha.hexdigest()
        r.stats["seconds"] = round(time.monotonic() - started, 3)
        return r
    except (ScanError, ValueError, OverflowError, MemoryError, struct.error) as e:
        r.log_time_range = None if t_lo is None else (t_lo, t_hi)
        if not isinstance(e, (ScanTimeout, MemoryError)):
            src.drain()
        r.sha256 = src.sha.hexdigest() if src.pos == size else None
        err = e if isinstance(e, ScanError) else ScanError(f"{type(e).__name__}: {e}")
        err.result = r  # type: ignore[attr-defined]
        raise err from (None if err is e else e)


# --------------------------------------------------------------------------- fast scan


def scan_fast(f: BinaryIO, size: int, limits: Limits | None = None) -> ScanResult:
    """Read header, footer and summary only. Sets ``fast_fallback`` when a full scan is needed."""
    limits = limits or Limits()
    started = time.monotonic()
    r = ScanResult(mode="fast", size=size)
    r.crc = {"data_section": "not checked (fast mode)", "chunk_present_verified": 0, "chunk_absent": 0,
             "summary": "no summary section", "attachments": "not checked"}  # fmt: skip
    reg = _Registry(r, limits)

    def read_at(offset: int, n: int) -> bytes:
        if offset < 0 or n < 0 or offset + n > size:
            raise ScanError("summary reference outside the file")
        f.seek(offset)
        data = f.read(n)
        if len(data) != n:
            raise ScanError("unexpected end of file")
        return data

    if size < 8 + 9 + FOOTER_RECORD_SIZE + 8:
        raise ScanError("file too small to be MCAP")
    head = read_at(0, 17)
    if head[:8] != MAGIC:
        raise ScanError("not an MCAP file (bad magic)")
    if head[8] != OP_HEADER:
        raise ScanError("first record must be Header")
    hlen = _U64.unpack_from(head, 9)[0]
    if hlen > limits.max_record_bytes:
        raise ScanError(f"record length exceeds {limits.max_record_bytes} byte limit")
    r.profile, _library = _parse_header(_Cursor(read_at(17, hlen)))
    header_end = 17 + hlen

    footer_at = size - 8 - FOOTER_RECORD_SIZE
    tail = read_at(footer_at, FOOTER_RECORD_SIZE + 8)
    if tail[-8:] != MAGIC:
        r.fast_fallback = "file does not end with the MCAP magic bytes (it may be incomplete)"
        return r
    if tail[0] != OP_FOOTER or _U64.unpack_from(tail, 1)[0] != 20:
        r.fast_fallback = "footer is not at the standard position"
        return r
    summary_start, _summary_offset_start = struct.unpack_from("<QQ", tail, 9)
    summary_crc = _U32.unpack_from(tail, 25)[0]
    if summary_start == 0:
        r.fast_fallback = "file has no summary section"
        return r
    if not header_end <= summary_start <= footer_at:
        raise ScanError("summary_start outside the file")
    if footer_at - summary_start > limits.max_summary_bytes:
        raise ScanError(f"summary section exceeds {limits.max_summary_bytes} byte limit")
    buf = read_at(summary_start, footer_at - summary_start)
    if summary_crc:
        if zlib.crc32(tail[:25], zlib.crc32(buf)) != summary_crc:
            raise ScanError("summary CRC mismatch")
        r.crc["summary"] = "verified"
    else:
        r.crc["summary"] = "absent"

    statistics = None
    metadata_index: list[tuple[int, int]] = []
    chunk_count = 0
    for off, op, b, e in iter_records(buf):
        loc = {"file_offset": summary_start + off}
        c = _Cursor(buf, b, e)
        if op == OP_SCHEMA:
            reg.schema(c, loc)
        elif op == OP_CHANNEL:
            reg.channel(c, loc)
        elif op == OP_STATISTICS:
            statistics = {
                "message_count": c.u64(), "schema_count": c.u16(), "channel_count": c.u32(),
                "attachment_count": c.u32(), "metadata_count": c.u32(), "chunk_count": c.u32(),
                "message_start_time": c.u64(), "message_end_time": c.u64(),
                "channel_message_counts": c.u16_u64_map(),
            }  # fmt: skip
        elif op == OP_METADATA_INDEX:
            metadata_index.append((c.u64(), c.u64()))
        elif op == OP_CHUNK_INDEX:
            chunk_count += 1
            c.take(8 * 4)  # times, chunk offset, chunk length
            c.take(c.u32())  # message index offsets
            c.u64()  # message index length
            name = c.string() or "none"
            r.compression[name] = r.compression.get(name, 0) + 1
        elif op in (OP_ATTACHMENT_INDEX, OP_SUMMARY_OFFSET):
            pass
        elif op in KNOWN_OPCODES:
            raise ScanError("unexpected record type in summary section")
        else:
            r.unknown += 1

    if statistics is None:
        r.fast_fallback = "summary has no Statistics record"
        return r
    if len(r.channels) < statistics["channel_count"]:
        r.fast_fallback = "summary does not repeat every channel"
        return r
    if len(metadata_index) < statistics["metadata_count"]:
        r.fast_fallback = "summary does not index every metadata record"
        return r

    for offset, length in metadata_index:
        if not 9 <= length <= limits.max_record_bytes:
            raise ScanError("metadata index length invalid or above limit")
        rec = read_at(offset, length)
        if rec[0] != OP_METADATA or _U64.unpack_from(rec, 1)[0] != length - 9:
            raise ScanError("metadata index does not point to a Metadata record")
        reg.metadata(_Cursor(rec, 9), {"file_offset": offset})

    r.counts = {cid: statistics["channel_message_counts"].get(cid, 0) for cid in r.channels}
    r.stats = {
        "records": None, "messages": statistics["message_count"], "chunks": statistics["chunk_count"],
        "attachments_skipped": statistics["attachment_count"], "seconds": round(time.monotonic() - started, 3),
    }  # fmt: skip
    return r
