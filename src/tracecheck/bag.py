"""ROS 2 bag folders: read ``metadata.yaml`` and decide which MCAP files make up the recording.

A rosbag2 recording is a folder holding ``metadata.yaml`` and one or more ``.mcap`` files
(split by size or duration). rosbag2 writes ``metadata.yaml`` when the recording is closed, so
a recorder that stopped unexpectedly may leave a folder without one.

``metadata.yaml`` is read with a small, bounded YAML-subset parser (block mappings and
sequences, plain and quoted scalars, block scalars, empty flow collections). It covers what
rosbag2 writes; anything else is reported as unreadable rather than guessed at. The browser
version in ``web/src/engine/bag.js`` mirrors this file exactly.
"""

from __future__ import annotations

import re

META_NAME = "metadata.yaml"
META_LIMIT = 1 << 20  # bytes
MAX_FILES = 1000
_DEPTH_LIMIT = 32
_INT = re.compile(r"^[0-9]{1,20}$")
_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", "e": "\x1b"}
_WS = " \t"


class BagError(ValueError):
    """The folder cannot be checked as a bag (for example, a non-MCAP storage format)."""


class MetaError(ValueError):
    """metadata.yaml could not be read."""


# --------------------------------------------------------------------------- YAML subset


def _scalar(text: str):
    s = text.strip(_WS)
    if s in ("", "~", "null", "Null", "NULL"):
        return None
    if s == "{}":
        return {}
    if s == "[]":
        return []
    if s[0] == '"':
        out, i = [], 1
        while i < len(s):
            ch = s[i]
            if ch == '"':
                if s[i + 1 :].strip(_WS) and not s[i + 1 :].strip(_WS).startswith("#"):
                    raise MetaError("text after a quoted value")
                return "".join(out)
            if ch == "\\":
                i += 1
                if i >= len(s):
                    break
                e = s[i]
                if e in _ESCAPES:
                    out.append(_ESCAPES[e])
                elif e in "xuU":
                    n = {"x": 2, "u": 4, "U": 8}[e]
                    digits = s[i + 1 : i + 1 + n]
                    if len(digits) != n or not all(c in "0123456789abcdefABCDEF" for c in digits):
                        raise MetaError("bad escape in quoted value")
                    v = int(digits, 16)
                    if v > 0x10FFFF or 0xD800 <= v <= 0xDFFF:
                        raise MetaError("bad escape in quoted value")
                    out.append(chr(v))
                    i += n
                else:
                    raise MetaError("bad escape in quoted value")
            else:
                out.append(ch)
            i += 1
        raise MetaError("unterminated quoted value")
    if s[0] == "'":
        out, i = [], 1
        while i < len(s):
            if s[i] == "'":
                if s[i + 1 : i + 2] == "'":
                    out.append("'")
                    i += 2
                    continue
                if s[i + 1 :].strip(_WS) and not s[i + 1 :].strip(_WS).startswith("#"):
                    raise MetaError("text after a quoted value")
                return "".join(out)
            out.append(s[i])
            i += 1
        raise MetaError("unterminated quoted value")
    if s[0] in "[{&*!|>%@`":
        raise MetaError("unsupported YAML value")
    cut = s.find(" #")
    return (s[:cut] if cut >= 0 else s).rstrip(_WS)


def _key_split(content: str) -> tuple[str, str] | None:
    """Split ``key: value`` (or ``key:``) on the first ': ' outside quotes; None if not a mapping entry."""
    if content[0] in "\"'":
        raise MetaError("quoted keys are not supported")
    i = content.find(": ")
    if i < 0:
        if content.endswith(":"):
            return content[:-1].rstrip(_WS), ""
        return None
    return content[:i].rstrip(_WS), content[i + 2 :]


class _Lines:
    def __init__(self, text: str):
        self.items: list[tuple[int, str]] = []
        for raw in text.split("\n"):
            line = raw.rstrip(_WS + "\r")
            stripped = line.lstrip(" ")
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("\t"):
                raise MetaError("tab indentation")
            if stripped in ("---", "..."):
                continue
            if stripped.startswith("%"):
                raise MetaError("YAML directives are not supported")
            self.items.append((len(line) - len(stripped), stripped))
        self.i = 0


def _block_scalar(lines: _Lines, indent: int, header: str) -> str:
    if header not in ("|", "|-", "|+", ">", ">-", ">+"):
        raise MetaError("unsupported block scalar")
    parts = []
    while lines.i < len(lines.items) and lines.items[lines.i][0] > indent:
        parts.append(lines.items[lines.i][1])
        lines.i += 1
    return ("\n" if header[0] == "|" else " ").join(parts)


def _value(lines: _Lines, indent: int, rest: str, depth: int):
    """Value after ``key:`` or ``-``: inline scalar, block scalar, or nested block on later lines."""
    r = rest.strip(_WS)
    if r[:1] in ("|", ">"):
        return _block_scalar(lines, indent, r.split(" #")[0].strip(_WS))
    if r:
        return _scalar(r)
    if lines.i < len(lines.items):
        nxt_indent, nxt = lines.items[lines.i]
        if nxt_indent > indent or (nxt_indent == indent and (nxt == "-" or nxt.startswith("- "))):
            return _block(lines, nxt_indent, depth + 1)
    return None


def _block(lines: _Lines, indent: int, depth: int):
    if depth > _DEPTH_LIMIT:
        raise MetaError("nesting too deep")
    first = lines.items[lines.i][1]
    if first == "-" or first.startswith("- "):
        seq = []
        while lines.i < len(lines.items):
            ind, content = lines.items[lines.i]
            if ind != indent or not (content == "-" or content.startswith("- ")):
                break
            rest = content[1:]
            body = rest.lstrip(" ")
            if not body:
                lines.i += 1
                seq.append(_value(lines, indent, "", depth))
                continue
            if body[:1] in ("|", ">") or body[0] in "\"'" or _key_split(body) is None:
                lines.i += 1
                seq.append(_value(lines, indent, body, depth))
                continue
            # "- key: value" starts a mapping whose entries sit at the column after "- ".
            lines.items[lines.i] = (indent + len(rest) - len(body) + 1, body)
            seq.append(_block(lines, lines.items[lines.i][0], depth + 1))
        return seq
    mapping: dict = {}
    while lines.i < len(lines.items):
        ind, content = lines.items[lines.i]
        if ind < indent:
            break
        if ind > indent:
            raise MetaError("unexpected indentation")
        if content == "-" or content.startswith("- "):
            break
        kv = _key_split(content)
        if kv is None or not kv[0]:
            raise MetaError("expected 'key: value'")
        key, rest = kv
        if key in mapping:
            raise MetaError("duplicate key")
        lines.i += 1
        mapping[key] = _value(lines, indent, rest, depth)
    return mapping


def parse_yaml(text: str):
    lines = _Lines(text)
    if not lines.items:
        raise MetaError("empty document")
    if lines.items[0][0] != 0:
        raise MetaError("unexpected indentation")
    out = _block(lines, 0, 0)
    if lines.i != len(lines.items):
        raise MetaError("unexpected indentation")
    return out


# --------------------------------------------------------------------------- bag metadata


def _int(v, what: str) -> int | None:
    if v is None:
        return None
    if not isinstance(v, str) or not _INT.match(v):
        raise MetaError(f"{what} is not a whole number")
    return int(v)


def _str(v) -> str | None:
    if v is None or isinstance(v, str):
        return v
    raise MetaError("expected a text value")


def _basename(path: str) -> str:
    name = re.split(r"[\\/]", path)[-1]
    if name in ("", ".", ".."):
        raise MetaError("bad file path")
    return name


def parse_info(text: str) -> dict:
    """Extract what Tracecheck needs from metadata.yaml. Raises MetaError."""
    doc = parse_yaml(text)
    root = doc.get("rosbag2_bagfile_information") if isinstance(doc, dict) else None
    if not isinstance(root, dict):
        raise MetaError("no rosbag2_bagfile_information section")
    files_meta = root.get("files")
    claimed: dict[str, int | None] = {}
    if files_meta is not None:
        if not isinstance(files_meta, list):
            raise MetaError("files is not a list")
        for item in files_meta:
            if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                raise MetaError("bad files entry")
            claimed[_basename(item["path"])] = _int(item.get("message_count"), "file message_count")
    rel = root.get("relative_file_paths")
    if rel is None:
        listed = list(claimed)
    elif isinstance(rel, list) and all(isinstance(p, str) for p in rel):
        listed = [_basename(p) for p in rel]
    else:
        raise MetaError("relative_file_paths is not a list of paths")
    if len(set(listed)) != len(listed):
        raise MetaError("a file is listed twice")
    topics = []
    raw_topics = root.get("topics_with_message_count") or []
    if not isinstance(raw_topics, list):
        raise MetaError("topics_with_message_count is not a list")
    for item in raw_topics:
        meta = item.get("topic_metadata") if isinstance(item, dict) else None
        if not isinstance(meta, dict) or not isinstance(meta.get("name"), str):
            raise MetaError("bad topics_with_message_count entry")
        topics.append({"name": meta["name"], "type": _str(meta.get("type")),
                       "message_count": _int(item.get("message_count"), "topic message_count")})  # fmt: skip
    return {
        "version": _int(root.get("version"), "version"),
        "storage_identifier": _str(root.get("storage_identifier")),
        "ros_distro": _str(root.get("ros_distro")),
        "compression_format": _str(root.get("compression_format")) or "",
        "compression_mode": _str(root.get("compression_mode")) or "",
        "message_count": _int(root.get("message_count"), "message_count"),
        "files": [{"name": n, "message_count": claimed.get(n)} for n in listed],
        "topics": topics,
    }


def _natural_key(name: str):
    return [(0, int(p), "") if p[0] in "0123456789" else (1, 0, p) for p in re.split(r"([0-9]+)", name) if p]


def plan(folder: str, names: list[str], meta_text: str | None, meta_sha256: str | None = None,
         meta_error: str | None = None) -> dict:  # fmt: skip
    """Decide which files form the recording.

    ``names`` are the plain file names in the bag folder (no subfolders). ``meta_error`` marks a
    metadata.yaml that exists but could not be read as text. Returns the ``bag`` report section
    without scan results. Raises BagError when the folder can't be checked.
    """
    present = set(names)
    mcaps = sorted((n for n in names if n.endswith(".mcap")), key=lambda n: (_natural_key(n), n))
    info, error = None, meta_error
    if meta_error is not None:
        meta_text = ""
    elif meta_text is not None:
        try:
            info = parse_info(meta_text)
        except (MetaError, RecursionError) as e:
            error = str(e)[:200]
    bag: dict = {"folder": folder, "metadata": "absent" if meta_text is None else "unreadable" if info is None else "present"}
    if error is not None:
        bag["metadata_error"] = error
    bag["metadata_sha256"] = meta_sha256
    if info is not None:
        storage = info["storage_identifier"] or ""
        if storage not in ("", "mcap"):
            raise BagError(f"this bag uses {storage[:40]!r} storage; only MCAP bags can be checked")
        if info["compression_mode"].lower() == "file":
            raise BagError("this bag uses rosbag2 file compression; decompress it first")
        bag.update(ros_distro=info["ros_distro"], storage_identifier=info["storage_identifier"],
                   message_count_claimed=info["message_count"], topics_claimed=info["topics"])  # fmt: skip
        files = [{"name": f["name"], "listed": True, "present": f["name"] in present,
                  "messages_claimed": f["message_count"]} for f in info["files"]]  # fmt: skip
        listed = {f["name"] for f in files}
        files += [{"name": n, "listed": False, "present": True, "messages_claimed": None}
                  for n in mcaps if n not in listed]  # fmt: skip
    else:
        files = [{"name": n, "listed": None, "present": True, "messages_claimed": None} for n in mcaps]
    if len(files) > MAX_FILES:
        raise BagError(f"bag folder lists more than {MAX_FILES} files")
    if not any(f["present"] and f["listed"] is not False for f in files):
        raise BagError("no MCAP recording files found in the bag folder")
    bag["files"] = files
    return bag
