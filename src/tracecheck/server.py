"""Loopback, token/origin guarded, one cancellable worker; no persistent uploads."""
import base64
import json
import secrets
import subprocess
import sys
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from .contract import loads
from .report import render
from .samples import CONTRACT

ROOT = Path(__file__).resolve().parent
UPLOAD_LIMIT = 64 * 1024 * 1024  # base64-in-JSON upload; use the CLI or the web app for larger files
MAX_FILE = UPLOAD_LIMIT
TIMEOUT = 30

class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, port):
        super().__init__(('127.0.0.1', port), Handler)
        self.token = secrets.token_urlsafe(32)
        self.origin = f'http://127.0.0.1:{self.server_port}'
        self.gate = threading.Lock()
        self.proc_lock = threading.Lock()
        self.proc = None
        self.cancelled = False

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup(); self.connection.settimeout(15)
    def log_message(self, *args):
        pass  # No filenames, contracts, payloads or tokens in access logs.
    def send(self, status, body, content_type='application/json'):
        if getattr(self, 'defer_response', False):
            self.pending_response = (status, body, content_type)
            return
        b = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type+'; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        try:
            self.wfile.write(b)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def authorized(self, post=False):
        if self.headers.get('Host') != self.server.origin.removeprefix('http://'):
            self.send(403, '{"error":"Host rejected"}'); return False
        if post and (self.headers.get('X-Session-Token') != self.server.token or
                     self.headers.get('Origin') != self.server.origin):
            self.send(403, '{"error":"Local session token/origin rejected"}'); return False
        return True
    def discard_body(self):
        # Draining bounded competing uploads avoids TCP reset before the 409 is read on Windows.
        try:
            remaining = int(self.headers.get('Content-Length', '0'))
            if 0 <= remaining <= MAX_FILE*4//3+200000:
                while remaining:
                    part = self.rfile.read(min(65536, remaining))
                    if not part: break
                    remaining -= len(part)
        except (ValueError, OSError):
            pass
    def do_GET(self):
        if not self.authorized(): return
        if self.path == '/':
            text = (ROOT/'ui.html').read_text(encoding='utf-8').replace('__TOKEN__', self.server.token)
            self.send(200, text, 'text/html')
        elif self.path == '/default-contract':
            self.send(200, json.dumps(CONTRACT, indent=2))
        elif self.path == '/status':
            self.send(200, json.dumps({'busy': self.server.gate.locked()}))
        else:
            self.send(404, '{"error":"Not found"}')
    def do_POST(self):
        if not self.authorized(True): return
        if self.path == '/cancel':
            with self.server.proc_lock:
                self.server.cancelled = True
                if self.server.proc and self.server.proc.poll() is None:
                    self.server.proc.kill()
            self.send(200, '{"cancelled":true}'); return
        if self.path not in ['/run', '/validate']:
            self.send(404, '{"error":"Not found"}'); return
        if not self.server.gate.acquire(blocking=False):
            self.discard_body()
            self.send(409, '{"error":"A local check is running. Cancel it or wait, then retry."}'); return
        self.defer_response = True
        try:
            self.server.cancelled = False
            length = int(self.headers.get('Content-Length', '0'))
            limit = MAX_FILE*4//3+200000 if self.path == '/run' else 150000
            if not 0 < length <= limit or self.headers.get('Transfer-Encoding'):
                raise ValueError('Request exceeds limit or unsupported transfer encoding')
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError('Incomplete upload')
            request = json.loads(body)
            contract = loads(request['contract'])
            if self.path == '/validate':
                self.send(200, '{"valid":true}'); return
            data = base64.b64decode(request['data'], validate=True)
            if len(data) > MAX_FILE:
                raise ValueError('Recording exceeds 64 MiB')
            name = str(request.get('filename', 'recording.mcap')).replace('\\', '/').split('/')[-1][:256]
            with tempfile.TemporaryDirectory(prefix='tracecheck-') as temp:
                folder = Path(temp)
                (folder/'input.mcap').write_bytes(data)
                (folder/'contract.json').write_text(json.dumps(contract), encoding='utf-8')
                with self.server.proc_lock:
                    if self.server.cancelled:
                        raise ValueError('Cancelled')
                    proc = subprocess.Popen([sys.executable, '-m', 'tracecheck', '_worker', str(folder/'input.mcap'),
                                             str(folder/'contract.json'), '--name', name], stdout=subprocess.PIPE,
                                             stderr=subprocess.PIPE, text=True, encoding='utf-8')
                    self.server.proc = proc
                try:
                    stdout, stderr = proc.communicate(timeout=TIMEOUT)
                except subprocess.TimeoutExpired:
                    proc.kill(); proc.communicate(); raise ValueError('30-second worker limit reached; scan incomplete') from None
                if self.server.cancelled:
                    raise ValueError('Cancelled; no report retained')
                if proc.returncode:
                    raise ValueError('Worker failed; no conclusions. Run the CLI on this file for details.')
                r = json.loads(stdout)
                self.send(200, json.dumps({'overall': r['overall'], 'scan_complete': r['scan_complete'],
                                           'counts': r['status_counts'], 'json': json.dumps(r, indent=2), 'html': render(r)}))
        except Exception as e:
            message = str(e) if isinstance(e, ValueError) else type(e).__name__
            self.send(400, json.dumps({'error': message.replace(str(Path.home()), '~')[:500]}))
        finally:
            with self.server.proc_lock:
                self.server.proc = None
            self.server.gate.release()
            self.defer_response = False
            self.send(*self.pending_response)

def serve(port=8765, open_browser=False):
    server = LocalServer(port)
    print('Backplane Tracecheck:', server.origin, flush=True)
    print('Loopback only. Ctrl+C stops. Upload copies are temporary; reports stay in this browser until downloaded.', flush=True)
    if open_browser:
        webbrowser.open(server.origin)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        with server.proc_lock:
            if server.proc and server.proc.poll() is None: server.proc.kill()
        server.server_close()
