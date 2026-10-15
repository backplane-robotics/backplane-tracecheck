import base64
import copy
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
from mcap.writer import Writer, CompressionType
from mcap.data_stream import RecordBuilder
from tracecheck.contract import loads, validate, ContractError
from tracecheck.engine import analyze_bytes, analyze_file
from tracecheck.reader import Limits, MiB
from tracecheck.samples import CONTRACT, write_sample, generate
from tracecheck.report import render
from tracecheck.server import LocalServer

def chunk_offsets(data):
    """File offsets of top-level Chunk records (opcode 6)."""
    out, p = [], 8
    while p < len(data) - 8:
        op, n = data[p], int.from_bytes(data[p+1:p+9], 'little')
        if op == 6: out.append(p)
        if op == 2: break  # Footer
        p += 9 + n
    return out

class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.c = copy.deepcopy(CONTRACT); self.t = self.c['topics']['/demo/position']
    def tearDown(self): self.temp.cleanup()
    def analyze(self, limits=None, fast=False, **kwargs):
        p = self.root/'sample.mcap'; write_sample(p, **kwargs)
        self.data = p.read_bytes()
        return analyze_bytes(self.data, self.c, p.name, limits=limits, fast=fast)
    def check(self, r, n): return r['checks'][n-1]['status']
    def test_clean_all_ten_pass_and_hash(self):
        r = self.analyze(); self.assertEqual(r['status_counts']['pass'], 10)
        self.assertEqual(r['source']['sha256'], hashlib.sha256(self.data).hexdigest())
        self.assertTrue(r['scan_complete'])
    def test_faults_have_exact_six_failures(self):
        r = self.analyze(fault=True)
        self.assertEqual([x['id'] for x in r['checks'] if x['status']=='fail'], ['C04','C05','C06','C07','C08','C09'])
    def test_uncompressed_unchunked(self): self.assertEqual(self.analyze(chunked=False)['overall'], 'pass')
    def test_no_crc_warn(self):
        r = self.analyze(crc=False); self.assertEqual(self.check(r,1),'warn')
        self.assertEqual(r['checksum_coverage']['data_section'],'absent')
    def test_compressed_zstd_and_lz4_pass(self):
        for codec in [CompressionType.ZSTD, CompressionType.LZ4]:
            with self.subTest(codec=codec):
                r = self.analyze(compression=codec)
                self.assertTrue(r['scan_complete']); self.assertEqual(r['status_counts']['pass'], 10)
                self.assertEqual(r['checksum_coverage']['chunk_present_verified'], 1)
    def test_unknown_codec_rejected(self):
        self.analyze(compression=CompressionType.ZSTD, crc=False)
        r=analyze_bytes(self.data.replace(b'zstd',b'evil'),self.c)
        self.assertFalse(r['scan_complete']); self.assertIn('unsupported compression',r['checks'][0]['findings'][0]['detail'])
    def test_bad_magic_and_truncation(self):
        self.analyze()
        for data in [b'bad', self.data[:-12], self.data+b'extra']:
            with self.subTest(size=len(data)):
                r=analyze_bytes(data,self.c); self.assertFalse(r['scan_complete']); self.assertEqual(r['status_counts']['skipped'],9)
    def test_data_crc_corruption(self):
        self.analyze(chunked=False); data=self.data.replace(b'"x":1',b'"x":2')
        self.assertFalse(analyze_bytes(data,self.c)['scan_complete'])
    def test_chunk_crc_corruption(self):
        self.analyze(); data=self.data.replace(b'"x":1',b'"x":2')
        self.assertIn('chunk CRC mismatch',analyze_bytes(data,self.c)['checks'][0]['findings'][0]['detail'])
    def test_schema_zero_legal_but_contract_mismatch(self):
        r=self.analyze(schema=False); self.assertTrue(r['scan_complete']); self.assertEqual(self.check(r,3),'fail')
    def test_missing_required_topic(self):
        self.c['topics']['/missing']={'required':True}; r=self.analyze(); self.assertEqual(self.check(r,2),'fail')
    def test_optional_absent_topic_skips(self):
        self.c['topics']['/missing']={'required':False}; r=self.analyze(); self.assertEqual(self.check(r,2),'pass')
    def test_encoding_mismatch(self): self.assertEqual(self.check(self.analyze(encoding='cdr'),3),'fail')
    def test_schema_fingerprint(self):
        self.t['schema_sha256']=hashlib.sha256(b'{"type":"object"}').hexdigest()
        self.assertEqual(self.check(self.analyze(),3),'pass')
        self.t['schema_sha256']='0'*64
        self.assertEqual(self.check(self.analyze(),3),'fail')
    def test_metadata_nonempty_semantics(self):
        self.c['metadata']['session']['software_version']=None
        self.assertEqual(self.check(self.analyze(),4),'pass')
        self.assertEqual(self.check(self.analyze(metadata=False),4),'fail')
    def test_clock_unconfirmed_skips_timing(self):
        self.t['clock_confirmed']=False; r=self.analyze()
        for n in [6,7,8,10]: self.assertEqual(self.check(r,n),'skipped')
    def test_zero_boot_timestamp_and_equal_publish_log_allowed(self):
        self.t['time_basis']='publish_time'; self.assertEqual(self.analyze()['overall'],'pass')
    def test_zero_span_rate_skipped(self): self.assertEqual(self.check(self.analyze(times=[0,0]),6),'skipped')
    def test_one_message_rate_gap_regression_sequence_skipped(self):
        r=self.analyze(times=[0])
        for n in [6,7,8,9]: self.assertEqual(self.check(r,n),'skipped')
    def test_sorted_gap_independent_of_regression(self):
        r=self.analyze(times=[0,200000000,100000000]); self.assertEqual(self.check(r,7),'pass'); self.assertEqual(self.check(r,8),'fail')
    def test_equal_gap_boundary_passes_and_one_ns_over_fails(self):
        self.assertEqual(self.check(self.analyze(times=[0,100000000]),7),'pass')
        self.assertEqual(self.check(self.analyze(times=[0,100000001]),7),'fail')
    def test_rate_exact_bounds(self):
        self.assertEqual(self.check(self.analyze(times=[0,100000000]),6),'pass')
        self.assertEqual(self.check(self.analyze(times=[0,100000001]),6),'fail')
    def test_sequence_wrap_and_reset(self):
        self.assertEqual(self.check(self.analyze(times=[0,1,2],seq=[2**32-1,0,1]),9),'pass')
        self.assertEqual(self.check(self.analyze(times=[0,1,2],seq=[0,0,0]),9),'fail')
    def test_sequence_disabled(self):
        self.t['sequence']='disabled'; self.assertEqual(self.check(self.analyze(),9),'skipped')
    def test_interval_endpoints_and_outside(self):
        self.assertEqual(self.check(self.analyze(times=[0,1000000000]),10),'pass')
        self.assertEqual(self.check(self.analyze(times=[1,1000000000]),10),'fail')
        self.assertEqual(self.check(self.analyze(times=[0,1000000001]),10),'fail')
    def test_ns_above_javascript_precision_remain_exact(self):
        start=1700000000000000001; self.t['interval_ns']=[start,start+1]
        r=self.analyze(times=[start,start+1]); self.assertEqual(self.check(r,10),'pass')
        text=json.dumps(r); self.assertIn(str(start),text); self.assertIn(str(start),render(r))
    def test_evidence_offsets_locate_messages(self):
        r=self.analyze(fault=True,chunked=False)
        ev=r['checks'][7]['findings'][0]['evidence'][0]
        for side in ['previous','current']:
            self.assertEqual(self.data[ev[side]['file_offset']],5)
        r=self.analyze(fault=True)
        ev=r['checks'][7]['findings'][0]['evidence'][0]['current']
        off=ev['chunk_file_offset']; self.assertIn(off, chunk_offsets(self.data))
        # Uncompressed chunk body: 8+8+8+4 fixed fields, empty compression string (4), data length (8).
        self.assertEqual(self.data[off+9+40+ev['chunk_inner_offset']],5)
    def test_evidence_cap_preserves_total(self):
        r=self.analyze(times=list(range(100,0,-1)))
        f=r['checks'][7]['findings'][0]; self.assertEqual(len(f['evidence']),20); self.assertEqual(f['evidence_count'],99)
        self.assertEqual(f['evidence_omitted'],79)
    def test_oversize_record_length(self):
        self.analyze(chunked=False)
        data=self.data[:9]+(2**40).to_bytes(8,'little')+self.data[17:]
        self.assertFalse(analyze_bytes(data,self.c)['scan_complete'])
        r=analyze_bytes(self.data,self.c,limits=Limits(max_record_bytes=16))
        self.assertFalse(r['scan_complete']); self.assertIn('byte limit',r['checks'][0]['findings'][0]['detail'])
    def test_internal_length_bound(self):
        self.analyze(chunked=False)
        data=self.data[:17]+(2**32-1).to_bytes(4,'little')+self.data[21:]
        r=analyze_bytes(data,self.c); self.assertFalse(r['scan_complete']); self.assertIn('boundary',r['checks'][0]['findings'][0]['detail'])
    def test_declared_expansion_size_rejected(self):
        self.analyze(crc=False); off=chunk_offsets(self.data)[0]
        data=self.data[:off+9+16]+(2**50).to_bytes(8,'little')+self.data[off+9+24:]
        r=analyze_bytes(data,self.c); self.assertFalse(r['scan_complete'])
    def test_message_limit_incomplete(self):
        self.assertFalse(self.analyze(limits=Limits(max_messages=3))['scan_complete'])
    def test_total_record_limit(self):
        self.assertFalse(self.analyze(limits=Limits(max_records=2))['scan_complete'])
    def test_large_text_field_rejected(self):
        f=io.BytesIO(); w=Writer(f,compression=CompressionType.NONE); w.start(profile='x'*1025);w.finish()
        self.assertFalse(analyze_bytes(f.getvalue(),self.c)['scan_complete'])
    def test_unknown_top_level_record_warns(self):
        self.analyze(chunked=False,crc=False)
        off=8+9+int.from_bytes(self.data[9:17],'little')
        builder=RecordBuilder();builder.start_record(0x80);builder.write(b'unknown');builder.finish_record()
        r=analyze_bytes(self.data[:off]+builder.end()+self.data[off:],self.c)
        self.assertTrue(r['scan_complete']);self.assertEqual(self.check(r,1),'warn')
        self.assertEqual(r['checks'][0]['findings'][0]['unknown_records_skipped'],1)
    def test_html_escapes_untrusted_text(self):
        self.c['name']='<script>alert(1)</script>'; text=render(self.analyze())
        self.assertNotIn('<script>',text); self.assertIn('&lt;script&gt;',text)
    def test_two_channels_same_topic_separate(self):
        f=io.BytesIO(); w=Writer(f,compression=CompressionType.NONE); w.start()
        for encoding in ['json','cdr']:
            cid=w.register_channel('/demo/position',encoding,0)
            w.add_message(cid,0,b'',0)
        w.finish(); r=analyze_bytes(f.getvalue(),self.c)
        self.assertEqual(len(r['inventory']),2); self.assertEqual(self.check(r,3),'fail')
    def test_no_summary_index_required(self):
        f=io.BytesIO(); w=Writer(f,compression=CompressionType.NONE,use_statistics=False,use_summary_offsets=False,
                                repeat_channels=False,repeat_schemas=False); w.start(); w.finish()
        r=analyze_bytes(f.getvalue(),self.c); self.assertTrue(r['scan_complete']); self.assertEqual(self.check(r,2),'fail')

class ContractTests(unittest.TestCase):
    def test_invalid_matrix(self):
        variants=[{}, {'version':True,'name':'n','topics':{'t':{}}}, {'version':1,'name':'n','topics':{'t':{'min_count':-1}}},
            {'version':1,'name':'n','topics':{'t':{'min_count':True}}}, {'version':1,'name':'n','topics':{'t':{'typo':3}}},
            {'version':1,'name':'n','topics':{'t':{'min_count':10,'max_count':2}}},
            {'version':1,'name':'n','topics':{'t':{'interval_ns':[4,2]}}},
            {'version':1,'name':'n','topics':{'t':{'max_rate_hz':10**500}}}]
        for c in variants:
            with self.subTest(c=str(c)[:100]),self.assertRaises(ContractError): validate(c)
    def test_duplicate_nan_bad_json(self):
        for text in ['{"version":1,"version":1}','{"x":NaN}','{','[]','x'*65537]:
            with self.subTest(text=text[:30]),self.assertRaises(ContractError): loads(text)

class CLITests(unittest.TestCase):
    def test_cli_outputs_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); generate(root/'examples'); original=(root/'examples/clean.mcap').read_bytes()
            for name,code in [('clean',0),('clean-zstd',0),('clean-lz4',0),('faults',1),('malformed',1),('unsupported-codec',1),('no-crc',1)]:
                cmd=[sys.executable,'-m','tracecheck','check',str(root/f'examples/{name}.mcap'),'--contract',str(root/'examples/demo-contract.json'),'--out',str(root/name)]
                r=subprocess.run(cmd,capture_output=True,text=True); self.assertEqual(r.returncode,code,r.stderr)
                report=json.loads((root/name/'report.json').read_text()); self.assertEqual(len(report['checks']),10)
                self.assertTrue((root/name/'report.html').read_text().startswith('<!doctype html>'))
                again=subprocess.run(cmd,capture_output=True,text=True); self.assertEqual(again.returncode,2)
            self.assertEqual(original,(root/'examples/clean.mcap').read_bytes())
    def test_bad_config_exit_two(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'bad.json'; p.write_text('{')
            r=subprocess.run([sys.executable,'-m','tracecheck','validate-contract',str(p)],capture_output=True)
            self.assertEqual(r.returncode,2)
    def test_cli_flags_fast_ignore_crc_fail_on(self):
        from tracecheck.__main__ import main
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); generate(root/'ex'); c=str(root/'ex/demo-contract.json')
            nocrc=str(root/'ex/no-crc.mcap')
            self.assertEqual(main(['check',nocrc,'--contract',c,'--out',str(root/'a'),'--quiet']),1)
            self.assertEqual(main(['check',nocrc,'--contract',c,'--out',str(root/'b'),'--quiet','--ignore-missing-crc']),0)
            self.assertEqual(main(['check',nocrc,'--contract',c,'--out',str(root/'c'),'--quiet','--fail-on','fail']),0)
            self.assertEqual(json.loads((root/'b/report.json').read_text())['contract']['missing_crc'],'ignore')
            self.assertEqual(main(['check',str(root/'ex/clean-zstd.mcap'),'--contract',c,'--out',str(root/'d'),'--fast']),0)
            r=json.loads((root/'d/report.json').read_text())
            self.assertEqual(r['scan_mode'],'fast'); self.assertIsNone(r['source']['sha256'])
            self.assertEqual(main(['check',str(root/'ex/missing.mcap'),'--contract',c,'--out',str(root/'e')]),2)

class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=LocalServer(0); cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.origin=cls.server.origin
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def request(self,path,payload=None,headers=None):
        h={'X-Session-Token':self.server.token,'Origin':self.origin,'Content-Type':'application/json'}
        if headers: h.update(headers)
        req=urllib.request.Request(self.origin+path,data=json.dumps(payload).encode() if payload is not None else None,headers=h)
        try:
            with urllib.request.urlopen(req,timeout=10) as r: return r.status,r.read().decode()
        except urllib.error.HTTPError as e:
            with e: return e.code,e.read().decode()
    def sample_request(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'clean.mcap';write_sample(p);return {'filename':'clean.mcap','contract':json.dumps(CONTRACT),'data':base64.b64encode(p.read_bytes()).decode()}
    def test_loopback_host_origin_token_guards(self):
        self.assertEqual(self.server.server_address[0],'127.0.0.1')
        self.assertEqual(self.request('/')[0],200)
        self.assertEqual(self.request('/',headers={'Host':'evil.example'})[0],403)
        self.assertEqual(self.request('/validate',{'contract':'{}'},headers={'Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.request('/validate',{'contract':'{}'},headers={'X-Session-Token':'bad'})[0],403)
    def test_repeated_reports_invalid_configuration_recovery(self):
        for _ in range(2):
            code,body=self.request('/run',self.sample_request()); self.assertEqual(code,200,body)
            r=json.loads(body); self.assertEqual(r['overall'],'pass'); self.assertEqual(len(json.loads(r['json'])['checks']),10)
        self.assertEqual(self.request('/validate',{'contract':'{'})[0],400)
        self.assertEqual(self.request('/validate',{'contract':json.dumps(CONTRACT)})[0],200)
    def test_malformed_ui_report(self):
        req=self.sample_request();req['data']=base64.b64encode(b'bad').decode()
        code,body=self.request('/run',req);self.assertEqual(code,200);self.assertFalse(json.loads(body)['scan_complete'])
    def test_worker_cancel_busy_and_recovery(self):
        original=subprocess.Popen
        def slow(*args,**kwargs): return original([sys.executable,'-c','import time; time.sleep(60)'],**kwargs)
        result=[]
        with patch('tracecheck.server.subprocess.Popen',side_effect=slow):
            t=threading.Thread(target=lambda: result.append(self.request('/run',self.sample_request())));t.start()
            for _ in range(100):
                if self.server.proc: break
                time.sleep(.02)
            self.assertIsNotNone(self.server.proc)
            self.assertEqual(self.request('/run',self.sample_request())[0],409)
            self.assertEqual(self.request('/cancel',{})[0],200)
            t.join(5);self.assertFalse(t.is_alive());self.assertIn('Cancelled',result[0][1])
        self.assertEqual(self.request('/run',self.sample_request())[0],200)
    def test_worker_timeout(self):
        original=subprocess.Popen
        def slow(*args,**kwargs): return original([sys.executable,'-c','import time; time.sleep(60)'],**kwargs)
        with patch('tracecheck.server.subprocess.Popen',side_effect=slow),patch('tracecheck.server.TIMEOUT',.1):
            code,body=self.request('/run',self.sample_request());self.assertEqual(code,400);self.assertIn('limit reached',body)

if __name__=='__main__': unittest.main(verbosity=2)
