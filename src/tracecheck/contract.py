"""Small strict contract language; unknown keys and ambiguous numbers are errors."""
import json
import math
import re

MAX_CONTRACT = 64 * 1024
MISSING_CRC = ('warn', 'ignore')

class ContractError(ValueError):
    pass

def require(ok, message):
    if not ok:
        raise ContractError(message)

def keys(obj, allowed, where):
    require(isinstance(obj, dict), f"{where}: expected an object")
    require(not (set(obj) - set(allowed)), f"{where}: unknown keys {sorted(set(obj)-set(allowed))}")

def string(value, where):
    require(isinstance(value, str) and 0 < len(value) <= 256, f"{where}: expected 1–256 characters")

def number(value, where, integer=False):
    require(type(value) in ((int,) if integer else (int, float)) and 0 <= value <= 2**64-1 and math.isfinite(value),
            f"{where}: expected a finite nonnegative {'integer' if integer else 'number'}")

def unique(pairs):
    result = {}
    for k, v in pairs:
        require(k not in result, f"duplicate key: {k}")
        result[k] = v
    return result

def loads(text):
    require(len(text.encode('utf-8')) <= MAX_CONTRACT, "contract exceeds 64 KiB")
    try:
        value = json.loads(text, object_pairs_hook=unique, parse_constant=lambda v: (_ for _ in ()).throw(ContractError(f"invalid number: {v}")))
    except (ValueError, RecursionError) as e:
        raise ContractError(str(e)) from e
    return validate(value)

def validate(c):
    keys(c, ['version', 'name', 'profile', 'missing_crc', 'metadata', 'topics'], 'contract')
    require(type(c.get('version')) is int and c['version'] == 1, 'version must be 1')
    string(c.get('name'), 'name')
    if 'profile' in c:
        require(isinstance(c['profile'], str) and len(c['profile']) <= 256, 'profile must be a string')
    require(c.get('missing_crc', 'warn') in MISSING_CRC, f'missing_crc must be one of {list(MISSING_CRC)}')
    keys(c.get('metadata', {}), c.get('metadata', {}).keys() if isinstance(c.get('metadata', {}), dict) else [], 'metadata')
    for name, fields in c.get('metadata', {}).items():
        string(name, 'metadata name')
        require(isinstance(fields, dict) and len(fields) <= 30, 'metadata fields must be an object, <=30 keys')
        for key, expected in fields.items():
            string(key, 'metadata key')
            if expected is not None:
                string(expected, 'metadata expected value')
    topics = c.get('topics')
    require(isinstance(topics, dict) and 0 < len(topics) <= 50, 'topics must contain 1–50 entries')
    for topic, t in topics.items():
        string(topic, 'topic')
        keys(t, ['required', 'message_encoding', 'schema_name', 'schema_encoding', 'schema_sha256', 'min_count', 'max_count',
                 'time_basis', 'clock_confirmed', 'min_rate_hz', 'max_rate_hz', 'max_gap_ns',
                 'check_regression', 'sequence', 'interval_ns', 'boundary_tolerance_ns'], topic)
        for k in ['required', 'clock_confirmed', 'check_regression']:
            if k in t:
                require(type(t[k]) is bool, f'{topic}.{k}: expected boolean')
        for k in ['message_encoding', 'schema_name', 'schema_encoding']:
            if k in t:
                string(t[k], f'{topic}.{k}')
        if 'schema_sha256' in t:
            require(isinstance(t['schema_sha256'], str) and re.fullmatch('[0-9a-f]{64}', t['schema_sha256']) is not None,
                    f'{topic}.schema_sha256: expected 64 lowercase hex characters')
        for k in ['min_count', 'max_count', 'max_gap_ns', 'boundary_tolerance_ns']:
            if k in t:
                number(t[k], f'{topic}.{k}', True)
        for k in ['min_rate_hz', 'max_rate_hz']:
            if k in t:
                number(t[k], f'{topic}.{k}')
        for lo, hi in [('min_count', 'max_count'), ('min_rate_hz', 'max_rate_hz')]:
            if lo in t and hi in t:
                require(t[lo] <= t[hi], f'{topic}: {lo} exceeds {hi}')
        require(t.get('time_basis', 'log_time') in ['log_time', 'publish_time'], f'{topic}: unsupported time_basis')
        require(t.get('sequence', 'disabled') in ['disabled', 'increment_mod32'], f'{topic}: unsupported sequence policy')
        if 'interval_ns' in t:
            v = t['interval_ns']
            require(isinstance(v, list) and len(v) == 2, f'{topic}: interval_ns needs [start,end]')
            for x in v:
                number(x, f'{topic}.interval_ns', True)
            require(v[0] < v[1], f'{topic}: interval start must precede end')
            require(t.get('boundary_tolerance_ns', 0) * 2 <= v[1]-v[0], f'{topic}: boundary tolerance too large')
    require(len(json.dumps(c).encode()) <= MAX_CONTRACT, 'contract exceeds 64 KiB')
    return c
