import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const vitestBin = resolve(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const proc = spawn(process.execPath, [vitestBin, 'run', '--reporter=verbose', '--no-color'], {
  cwd: ROOT,
  env: { ...process.env, FORCE_COLOR: '0' },
});

let out = '';
proc.stdout.on('data', d => { out += d; process.stdout.write(d); });
proc.stderr.on('data', d => { out += d; process.stderr.write(d); });
proc.on('close', code => {
  writeFileSync(resolve(ROOT, 'test_run_result.txt'), out);
  process.exit(code);
});



