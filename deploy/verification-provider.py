"""Disposable protocol fixture for deployment checks; no external model calls."""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))))
        data=body.get('input',[])
        self.send_response(200);self.send_header('content-type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'data':[{'index':i,'embedding':[1,0,0]} for i,_ in enumerate(data)]}).encode())
    def log_message(self,*args): pass
HTTPServer(('0.0.0.0',6060),Handler).serve_forever()
