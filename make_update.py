# Build a release:  python3 tools/make_update.py 13.11.0
# Writes releases/Demon-Conqueror-<v>.dcupdate (upload at Render /upload) and releases/index.html (upload to GitHub).
import re, sys, json, gzip, base64, subprocess, os
V = sys.argv[1]; R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); G = os.path.join(R, 'src', 'game.html')
s = open(G).read(); s = re.sub(r"const APP_VERSION = '[^']*'", f"const APP_VERSION = '{V}'", s); s = re.sub(r"^const UPD = .*$", "const UPD = null;", s, count=1, flags=re.M)
open(G, 'w').write(s)
gz = base64.b64encode(gzip.compress(s.encode(), 9, mtime=0)).decode()
key = os.path.join(R, 'PRIVATE-signing-key', 'upd_private.pem')
if not os.path.exists(key) and os.environ.get('UPD_PRIVATE_KEY'):   # Claude Code on the web: the key lives in the cloud environment, never in the repo
    key = '/tmp/upd_private.pem'; open(key, 'w').write(os.environ['UPD_PRIVATE_KEY'].replace('\\n', '\n'))
sig = subprocess.run(['node', '-e', "const c=require('crypto'),f=require('fs');process.stdout.write(c.sign('sha256',Buffer.from(f.readFileSync(0,'utf8')),{key:f.readFileSync(process.argv[1]),dsaEncoding:'ieee-p1363'}).toString('base64'))", key], input=V + '\n' + gz, capture_output=True, text=True, check=True).stdout
os.makedirs(os.path.join(R, 'releases'), exist_ok=True)
open(os.path.join(R, 'releases', f'Demon-Conqueror-{V}.dcupdate'), 'w').write(json.dumps({'v': V, 'gz': gz, 'sig': sig}))
open(os.path.join(R, 'releases', 'index.html'), 'w').write(s.replace("const UPD = null;", "const UPD = " + json.dumps({'v': V, 'gz': gz, 'sig': sig}) + ";", 1))
print('built', V)
