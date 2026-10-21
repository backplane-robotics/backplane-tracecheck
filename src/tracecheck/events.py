"""Recorder event messages that can explain timestamp gaps.

Some recorders write their own events into the recording. rosbag2_dynamic_recorder (dynrec)
0.2.0, for example, writes a PauseEvent when recording is paused or resumed and a
SubscriptionChangeEvent when a topic is added or removed. Tracecheck recognises these by schema
name and reads only a few plain fields (action and topic name) from their CDR payload. Every
other payload stays opaque.

The events are the recorder's own account. Tracecheck uses them to label a gap as covered by a
recorded pause or unsubscribe; it does not verify them or say why the recorder was paused.
"""

from __future__ import annotations

import struct
from typing import Callable

DYNREC_PREFIX = "rosbag2_dynamic_recorder_interfaces/msg/"
EVENT_TYPES = ("PauseEvent", "SubscriptionChangeEvent", "FileSplitEvent", "LowDiskEvent",
               "BagSizeLimitEvent", "MessagesLostEvent")  # fmt: skip
EVENT_LIMIT = 10_000  # decoded pause/subscription events kept per recording
NAME_LIMIT = 1024  # characters in a decoded topic name
NOTE = ("These events were written into the recording by the recorder. Tracecheck reads their type, action, topic "
        "name and log time to label gaps; it does not verify them or say why recording was paused.")  # fmt: skip

PAUSED, RESUMED = 0, 1
SUBSCRIBED, UNSUBSCRIBED = 0, 1
LABEL_PAUSE = "recorder_paused"
LABEL_TOPIC = "topic_unsubscribed"


def event_type(schema_name: str | None, message_encoding: str) -> str | None:
    """Return the short event type name for a recognised recorder event channel, else None."""
    if message_encoding != "cdr" or not schema_name or not schema_name.startswith(DYNREC_PREFIX):
        return None
    short = schema_name[len(DYNREC_PREFIX):]
    return short if short in EVENT_TYPES else None


class _Cdr:
    """Minimal plain-CDR (XCDR1) field reader. Alignment is relative to the end of the 4-byte header."""

    __slots__ = ("b", "p", "le")

    def __init__(self, b: bytes, le: bool):
        self.b, self.p, self.le = b, 0, le

    def _align(self, n: int) -> None:
        self.p += (-self.p) % n

    def take(self, n: int, align: int = 1) -> int:
        self._align(align)
        if self.p + n > len(self.b):
            raise ValueError("short CDR payload")
        p = self.p
        self.p += n
        return p

    def u8(self) -> int:
        return self.b[self.take(1)]

    def u32(self) -> int:
        return struct.unpack_from("<I" if self.le else ">I", self.b, self.take(4, 4))[0]

    def string(self) -> str:
        n = self.u32()
        if n < 1 or n > NAME_LIMIT * 4 + 1:
            raise ValueError("bad CDR string length")
        p = self.take(n)
        if self.b[p + n - 1] != 0:
            raise ValueError("CDR string is not NUL-terminated")
        s = self.b[p : p + n - 1].decode("utf-8")
        if len(s) > NAME_LIMIT:
            raise ValueError("CDR string too long")
        return s


def decode(kind: str, payload: bytes) -> tuple[str, int, str | None] | None:
    """Decode a PauseEvent or SubscriptionChangeEvent payload to ``(kind, action, topic)``.

    Returns None for other event types, unsupported encapsulations, or malformed payloads.
    """
    if kind not in ("PauseEvent", "SubscriptionChangeEvent"):
        return None
    if len(payload) < 4 or payload[0] != 0 or payload[1] not in (0, 1):
        return None
    c = _Cdr(bytes(payload[4:]), payload[1] == 1)
    try:
        c.take(8, 4)  # builtin_interfaces/Time stamp (int32 sec, uint32 nanosec)
        if kind == "PauseEvent":
            action = c.u8()
            return ("pause", action, None) if action in (PAUSED, RESUMED) else None
        topic = c.string()
        c.string()  # topic_type
        action = c.u8()
        return ("subscription", action, topic) if action in (SUBSCRIBED, UNSUBSCRIBED) and topic else None
    except (ValueError, UnicodeDecodeError, struct.error):
        return None


def windows(events: list) -> tuple[list, dict]:
    """Turn decoded events into (pause windows, {topic: unsubscribed windows}).

    ``events`` items are ``(log_time, ordinal, kind, action, topic)``. A window is ``(start, end)``
    with ``end`` None when it is still open at the end of the recording. A resume without a pause,
    or a subscribe without an unsubscribe, opens nothing.
    """
    pause: list = []
    topics: dict = {}
    open_pause = None
    open_topic: dict = {}
    for t, _o, kind, action, topic in sorted(events, key=lambda e: (e[0], e[1])):
        if kind == "pause":
            if action == PAUSED and open_pause is None:
                open_pause = t
            elif action == RESUMED and open_pause is not None:
                pause.append((open_pause, t))
                open_pause = None
        elif action == UNSUBSCRIBED:
            if topic not in open_topic:
                open_topic[topic] = t
        elif topic in open_topic:
            topics.setdefault(topic, []).append((open_topic.pop(topic), t))
    if open_pause is not None:
        pause.append((open_pause, None))
    for topic, start in open_topic.items():
        topics.setdefault(topic, []).append((start, None))
    return pause, topics


def explainer(wins: tuple[list, dict], topic: str, limit: int) -> Callable[[int, int], list | None] | None:
    """Return ``explain(a, b)`` for gaps on ``topic``, or None when no window applies to it.

    ``explain`` returns the sorted labels of the windows that cover the gap from ``a`` to ``b``,
    or None when, after removing those windows, any uncovered stretch is still above ``limit``.
    """
    pause, topics = wins
    spans = [(s, e, LABEL_PAUSE) for s, e in pause] + [(s, e, LABEL_TOPIC) for s, e in topics.get(topic, [])]
    if not spans:
        return None

    def explain(a: int, b: int) -> list | None:
        clipped = []
        for s, e, label in spans:
            lo = max(s, a)
            hi = b if e is None else min(e, b)
            if lo < hi:
                clipped.append((lo, hi, label))
        if not clipped:
            return None
        clipped.sort()
        cursor, widest, labels = a, 0, set()
        for lo, hi, label in clipped:
            if lo > cursor:
                widest = max(widest, lo - cursor)
            if hi > cursor:
                cursor = hi
            labels.add(label)
        widest = max(widest, b - cursor)
        return sorted(labels) if widest <= limit else None

    return explain


def covered(wins: tuple[list, dict], topic: str, a: int, b: int) -> tuple[int, list]:
    """Nanoseconds of ``[a, b]`` inside pause windows or ``topic``'s unsubscribed windows, and their labels.

    Overlapping windows are counted once. Used by C06 to leave recorded pauses out of the average rate.
    """
    pause, topics = wins
    spans = [(s, e, LABEL_PAUSE) for s, e in pause] + [(s, e, LABEL_TOPIC) for s, e in topics.get(topic, [])]
    clipped = []
    for s, e, label in spans:
        lo = max(s, a)
        hi = b if e is None else min(e, b)
        if lo < hi:
            clipped.append((lo, hi, label))
    clipped.sort()
    total, cursor, labels = 0, a, set()
    for lo, hi, label in clipped:
        lo = max(lo, cursor)
        if hi > lo:
            total += hi - lo
            cursor = hi
        labels.add(label)
    return total, sorted(labels)
