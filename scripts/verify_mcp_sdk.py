"""Verify the real official MCP client against a running local Atlas server.
Only for the explicitly seeded development account; create and revoke a temporary key.
"""
import http.cookiejar
import json
import os
import subprocess
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parent.parent
base = os.environ.get("ATLAS_LOCAL_API", "http://127.0.0.1:8000")
jar = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(path, data=None, method="GET"):
    return json.load(client.open(urllib.request.Request(base + path, method=method, data=None if data is None else json.dumps(data).encode(), headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:5173"})))

if not call('/api/public-config')['demo']:
    raise SystemExit("This verification script requires SEED_DEMO=true; it does not operate on production accounts.")
call('/api/auth/login', {"tenant": "atlas", "email": "admin@atlas.local", "password": "AtlasDemo123!"}, "POST")
key = call('/api/keys', {"name": "Official SDK verification", "scopes": ["search.read", "document.read"], "expires_days": 1}, "POST")
try:
    environment = dict(os.environ, ATLAS_API_KEY=key['key'], ATLAS_MCP_URL=base + '/mcp')
    subprocess.run(['npm', 'run', 'agent:example'], cwd=root / 'frontend', env=environment, check=True)
finally:
    call('/api/keys/' + key['id'], {}, "DELETE")
    call('/api/auth/logout', {}, "POST")
    print('Temporary MCP verification key revoked.')
