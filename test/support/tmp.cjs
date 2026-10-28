'use strict';
// Synthetic fixtures live under the git-ignored _script_outputs tree. Tests never
// delete them; each run gets fresh unique directories for later inspection.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const base = path.join(root, '_script_outputs', 'test-tmp');

function tempDir(label) {
  fs.mkdirSync(base, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  return fs.realpathSync(fs.mkdtempSync(path.join(base, `${stamp}-${label}-`)));
}

// A synthetic project: a real (temporary) git repository whose .gitignore
// covers .local/, mirroring what the upload boundary requires.
function gitProject(label, { ignoreLocal = true } = {}) {
  const dir = tempDir(label);
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q', dir]);
  if (ignoreLocal) fs.writeFileSync(path.join(dir, '.gitignore'), '.local/\n');
  return dir;
}

module.exports = { root, base, tempDir, gitProject };
