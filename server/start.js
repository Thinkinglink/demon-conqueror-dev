// Render start file: copies the server files out of /etc/secrets, installs what they need, then starts the server
const fs = require('fs'), { execSync } = require('child_process'), SRC = process.env.SECRETS_DIR || '/etc/secrets', APP = '/tmp/app';
fs.mkdirSync(APP, { recursive: true });
for (const f of ['server.js', 'package.json']) fs.copyFileSync(SRC + '/' + f, APP + '/' + f);
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: APP, stdio: 'inherit' });
process.chdir(APP); require(APP + '/server.js');
