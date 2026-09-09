'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let failed = false;
for (const dir of ['src', 'scripts', 'test', 'media'])
  for (const file of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, dir, file)], {
      encoding: 'utf8'
    });
    if (result.status) {
      failed = true;
      process.stderr.write(result.stderr);
    }
  }
JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
JSON.parse(fs.readFileSync(path.join(root, 'data/presets.json')));
if (failed) process.exit(1);
console.log('JavaScript syntax and JSON checks passed.');
