# After changing server/server.js:  python3 tools/render_env.py   -> releases/render-env-P1-P5.txt (paste P1..P5 into Render, redeploy)
import gzip, base64, os
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__))); s = open(os.path.join(R, 'server', 'server.js'), 'rb').read()
b = base64.b64encode(gzip.compress(s, 9)).decode(); k = -(-len(b) // 5); parts = [b[i * k:(i + 1) * k] for i in range(5)]
open(os.path.join(R, 'releases', 'render-env-P1-P5.txt'), 'w').write('\n\n'.join(f'P{i + 1}\n{p}' for i, p in enumerate(parts)) + '\n'); print('ok')
