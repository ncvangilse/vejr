const vm = require('vm');
const fs = require('fs');
const src = fs.readFileSync('config.js', 'utf8') + '\n' + fs.readFileSync('shore.js', 'utf8');
try {
  new vm.Script(src);
  process.stdout.write('SYNTAX OK\n');
} catch(e) {
  process.stdout.write('SYNTAX ERROR: ' + e.message + '\n');
}

