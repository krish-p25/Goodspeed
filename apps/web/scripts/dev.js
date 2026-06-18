const { spawnSync } = require('child_process');
const port = process.env.WEB_PORT || '3020';
spawnSync('next', ['dev', '--port', port], { stdio: 'inherit', shell: true });
