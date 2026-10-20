"""Deterministic invented recordings; no robot data, imported assets, or fault execution."""

import json
import struct
from pathlib import Path

from mcap.writer import CompressionType, Writer

DYNREC = 'rosbag2_dynamic_recorder_interfaces/msg/'

CONTRACT = {'version': 1, 'name': 'Synthetic 10 Hz demo (edit for your recording)', 'profile': '',
            'metadata': {'session': {'software_version': 'demo-1'}}, 'topics': {
                '/demo/position': {'required': True, 'message_encoding': 'json', 'schema_name': 'DemoPosition',
                 'schema_encoding': 'jsonschema', 'min_count': 11, 'max_count': 11,
                 'clock_confirmed': True, 'time_basis': 'log_time', 'min_rate_hz': 10, 'max_rate_hz': 10,
                 'max_gap_ns': 100000000, 'check_regression': True, 'sequence': 'increment_mod32',
                 'interval_ns': [0, 1000000000], 'boundary_tolerance_ns': 0}}}

# Contract for the larger multi-topic demo written by write_fleet_sample().
FLEET_CONTRACT = {
    'version': 1, 'name': 'Synthetic mobile-robot demo', 'missing_crc': 'warn',
    'metadata': {'session': {'robot_id': None, 'software_version': None}},
    'topics': {
        '/imu': {'message_encoding': 'cdr', 'schema_name': 'sensor_msgs/msg/Imu', 'clock_confirmed': True,
                 'min_rate_hz': 190, 'max_rate_hz': 210, 'max_gap_ns': 20000000, 'check_regression': True},
        '/odom': {'message_encoding': 'cdr', 'schema_name': 'nav_msgs/msg/Odometry', 'clock_confirmed': True,
                  'min_rate_hz': 45, 'max_rate_hz': 55, 'max_gap_ns': 50000000, 'check_regression': True},
        '/scan': {'message_encoding': 'cdr', 'schema_name': 'sensor_msgs/msg/LaserScan', 'clock_confirmed': True,
                  'min_rate_hz': 9, 'max_rate_hz': 11, 'max_gap_ns': 200000000},
        '/camera/image/compressed': {'message_encoding': 'cdr', 'schema_name': 'sensor_msgs/msg/CompressedImage',
                                     'clock_confirmed': True, 'min_rate_hz': 14, 'max_rate_hz': 16,
                                     'max_gap_ns': 150000000},
    },
}


def write_sample(path, fault=False, chunked=True, compression=CompressionType.NONE, crc=True,
                 times=None, seq=None, metadata=True, schema=True, encoding='json'):
    with Path(path).open('wb') as f:
        w = Writer(f, use_chunking=chunked, compression=compression, enable_crcs=crc, enable_data_crcs=crc)
        w.start(profile='', library='backplane-tracecheck synthetic generator')
        sid = w.register_schema('DemoPosition', 'jsonschema', b'{"type":"object"}') if schema else 0
        cid = w.register_channel('/demo/position', encoding, sid)
        if metadata and not fault:
            w.add_metadata('session', {'software_version': 'demo-1'})
        ts = times if times is not None else ([0,100000000,200000000,800000000,700000000,1000000000] if fault else [i*100000000 for i in range(11)])
        for i,t in enumerate(ts):
            sequence = seq[i] if seq is not None else (i+2 if fault and i>=3 else i)
            w.add_message(cid, t, b'{"x":1,"synthetic":true}', t, sequence=sequence)
        w.finish()


def _cdr_event(stamp_ns, *fields):
    """Little-endian plain CDR for a dynrec event: Time stamp, then uint8 (int) and string (str) fields."""
    out = bytearray(b'\x00\x01\x00\x00')

    def align(n):
        out.extend(b'\x00' * ((-(len(out) - 4)) % n))

    align(4)
    out += struct.pack('<iI', stamp_ns // 1_000_000_000, stamp_ns % 1_000_000_000)
    for f in fields:
        if isinstance(f, int):
            out.append(f)
        else:
            b = f.encode()
            align(4)
            out += struct.pack('<I', len(b) + 1) + b + b'\x00'
    return bytes(out)


def write_fleet_sample(path, seconds=60, compression=CompressionType.ZSTD, dropout=None, payload_scale=1,
                       chunk_size=1024 * 1024, pauses=(), unsubscribed=()):
    """A multi-topic, ROS 2-shaped synthetic recording (payloads are filler bytes, not real CDR).

    ``dropout`` = (topic, start_s, end_s) removes that topic's messages in the window to create a gap.
    ``payload_scale`` multiplies payload sizes, to produce large files for streaming tests.
    ``pauses`` = [(start_s, end_s)] and ``unsubscribed`` = [(topic, start_s, end_s)] remove messages
    like a dynrec recorder would, and write its PauseEvent / SubscriptionChangeEvent messages
    (real CDR, following the rosbag2_dynamic_recorder 0.2.0 message definitions).
    """
    start = 1_760_000_000_000_000_000  # fixed epoch, 2025-10-09
    rates = {'/imu': 200, '/odom': 50, '/scan': 10, '/camera/image/compressed': 15}
    sizes = {'/imu': 300, '/odom': 700, '/scan': 4400, '/camera/image/compressed': 60000}
    types = [('/imu', 'sensor_msgs/msg/Imu'), ('/odom', 'nav_msgs/msg/Odometry'),
             ('/scan', 'sensor_msgs/msg/LaserScan'), ('/camera/image/compressed', 'sensor_msgs/msg/CompressedImage')]
    recorder = bool(pauses or unsubscribed)
    with Path(path).open('wb') as f:
        w = Writer(f, compression=compression, chunk_size=chunk_size)
        w.start(profile='ros2', library='backplane-tracecheck synthetic generator')
        cids = {}
        for topic, schema in types:
            sid = w.register_schema(schema, 'ros2msg', f'# synthetic placeholder for {schema}'.encode())
            cids[topic] = w.register_channel(topic, 'cdr', sid, {'offered_qos_profiles': '- history: 3\n  depth: 0\n'})
        if recorder:
            for name, short in [('pause', 'PauseEvent'), ('subscription_change', 'SubscriptionChangeEvent')]:
                sid = w.register_schema(DYNREC + short, 'ros2msg', f'# synthetic placeholder for {short}'.encode())
                cids[name] = w.register_channel(f'/dynamic_recorder/events/{name}', 'cdr', sid)
        w.add_metadata('session', {'robot_id': 'demo-amr-01', 'software_version': 'demo-2.3.1', 'synthetic': 'true'})
        events = []
        for topic, hz in rates.items():
            period = 1_000_000_000 // hz
            for i in range(seconds * hz):
                t = start + i * period
                if dropout and dropout[0] == topic and dropout[1] * 1e9 <= i * period < dropout[2] * 1e9:
                    continue
                if any(a * 1e9 <= i * period < b * 1e9 for a, b in pauses):
                    continue
                if any(u == topic and a * 1e9 <= i * period < b * 1e9 for u, a, b in unsubscribed):
                    continue
                events.append((t, topic, i, None))
        node = '/dynamic_recorder'
        if recorder:
            for topic, schema in types:
                events.append((start, 'subscription_change', 0, _cdr_event(start, topic, schema, 0, 'startup', node)))
            for a, b in pauses:
                ta, tb = start + int(a * 1e9), start + int(b * 1e9)
                events.append((ta, 'pause', 0, _cdr_event(ta, 0, 'service:pause', node)))
                events.append((tb, 'pause', 0, _cdr_event(tb, 1, 'service:resume', node)))
            for topic, a, b in unsubscribed:
                schema = dict(types)[topic]
                ta, tb = start + int(a * 1e9), start + int(b * 1e9)
                events.append((ta, 'subscription_change', 0,
                               _cdr_event(ta, topic, schema, 1, 'service:unsubscribe_topics', node)))
                events.append((tb, 'subscription_change', 0,
                               _cdr_event(tb, topic, schema, 0, 'service:subscribe_topics', node)))
        events.sort(key=lambda e: (e[0], e[1], e[2]))
        blobs = {topic: bytes((i * 31 + 7) & 0xFF for i in range(n * payload_scale)) for topic, n in sizes.items()}
        for seq, (t, topic, i, payload) in enumerate(events):
            if payload is None:
                w.add_message(cids[topic], t, blobs[topic], t, sequence=i)
            else:
                w.add_message(cids[topic], t, payload, t, sequence=seq)
        w.finish()


def generate(dest):
    dest = Path(dest)
    dest.mkdir(exist_ok=True)
    (dest/'demo-contract.json').write_text(json.dumps(CONTRACT, indent=2), encoding='utf-8')
    (dest/'fleet-contract.json').write_text(json.dumps(FLEET_CONTRACT, indent=2), encoding='utf-8')
    write_sample(dest/'clean.mcap')
    write_sample(dest/'clean-zstd.mcap', compression=CompressionType.ZSTD)
    write_sample(dest/'clean-lz4.mcap', compression=CompressionType.LZ4)
    write_sample(dest/'faults.mcap', fault=True)
    write_sample(dest/'unchunked.mcap', chunked=False)
    write_sample(dest/'no-crc.mcap', compression=CompressionType.ZSTD, crc=False)
    write_sample(dest/'unsupported-codec.mcap', compression=CompressionType.ZSTD, crc=False)
    p = dest/'unsupported-codec.mcap'
    p.write_bytes(p.read_bytes().replace(b'zstd', b'brot'))
    (dest/'malformed.mcap').write_bytes(b'not an MCAP recording\x00')
    (dest/'truncated.mcap').write_bytes((dest/'clean.mcap').read_bytes()[:-12])
    write_fleet_sample(dest/'fleet-zstd.mcap', seconds=20)
    # Cut part-way through the message data, like a recorder that stopped mid-write: no summary, no footer.
    fleet = (dest/'fleet-zstd.mcap').read_bytes()
    (dest/'interrupted-zstd.mcap').write_bytes(fleet[:len(fleet) * 55 // 100])
    write_fleet_sample(dest/'fleet-dropout-lz4.mcap', seconds=20, compression=CompressionType.LZ4,
                       dropout=('/scan', 8, 9.5))
    # A dynrec-style recording: paused for 1 s, and the camera topic unsubscribed for 0.8 s.
    write_fleet_sample(dest/'fleet-paused-zstd.mcap', seconds=30, pauses=[(8, 9)],
                       unsubscribed=[('/camera/image/compressed', 20, 20.8)])
