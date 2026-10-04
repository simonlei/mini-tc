#!/usr/bin/env node
// Shared by dev.sh / dev.bat: hash package.json + package-lock.json contents so
// the launcher can skip `npm install` when nothing changed (it still costs ~29s
// even when npm prints "up to date").
//
// Usage:
//   node scripts/deps-hash.js
//       prints the SHA-256 of the two manifests
//   node scripts/deps-hash.js --stamp <file> --stamp-after-install
//       runs `npm install`, prints how long it took, then writes the hash to
//       <file>. Exits non-zero when npm install fails.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const files = ['package.json', 'package-lock.json'];

function hash() {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const p = path.join(root, f);
    h.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.alloc(0));
  }
  return h.digest('hex');
}

const argv = process.argv.slice(2);
if (!argv.includes('--stamp-after-install')) {
  process.stdout.write(hash());
  process.exit(0);
}

const stampIdx = argv.indexOf('--stamp');
const stampFile = stampIdx >= 0 && argv[stampIdx + 1] ? argv[stampIdx + 1] : '';
const started = Date.now();
const r = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: true });
const elapsed = Date.now() - started;

if (r.error) {
  console.error(`[ERROR] npm install could not start: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);

console.log(`>> npm install took ${elapsed} ms`);
if (stampFile) {
  try {
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, hash());
  } catch (e) {
    console.warn(`[WARN] could not write deps stamp: ${e.message}`);
  }
}