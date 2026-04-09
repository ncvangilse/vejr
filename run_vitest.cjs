const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const result = spawnSync(
  path.join(__dirname, 'node_modules', '.bin', 'vitest.cmd'),
  ['run', '--reporter=verbose', '--no-color'],
  {
    cwd: __dirname,
    timeout: 60000,
    encoding: 'utf8',
  }
);

let out = '';
out += '=== EXIT: ' + result.status + ' ===\n';
if (result.stdout) out += '=== STDOUT ===\n' + result.stdout + '\n';
if (result.stderr) out += '=== STDERR ===\n' + result.stderr + '\n';
if (result.error)  out += '=== ERROR ===\n' + result.error.message + '\n';

fs.writeFileSync(path.join(__dirname, 'vitest_result.txt'), out, 'utf8');
process.stdout.write(out);




