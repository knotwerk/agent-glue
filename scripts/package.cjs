'use strict';
// Packages both extensions into dist/vsix and audits what went into each VSIX.
// Run through `npm run package` so the build happens first. Never installs.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, vsixDir, packages, manifest, vsixPath, requireNode22 } = require('./lib/packages.cjs');

requireNode22();

const vsce = path.join(root, 'node_modules/.bin/vsce');
const secretNames = /(^|\/)(\.env.*|.*\.pem|.*\.key|id_rsa.*|credentials.*|.*\.sqlite|.*\.jsonl)$/i;
const forbiddenDirs = /(^|\/)(node_modules|vendor|src|test|tests|_script_outputs|\.local|\.git|\.github|docs|inbox)\//;

function archive(file) {
  let list;
  try { list = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }); }
  catch (error) { throw new Error(`Could not read ${file} (is unzip installed?): ${error.message}`); }
  return list.split('\n').filter(Boolean);
}

function entry(file, name) {
  return execFileSync('unzip', ['-p', file, `extension/${name}`], { maxBuffer: 200 * 1024 * 1024 });
}

function audit(name, file = vsixPath(name)) {
  const spec = packages[name];
  const entries = archive(file);
  const problems = [];
  const files = entries.filter(e => e.startsWith('extension/') && !e.endsWith('/')).map(e => e.slice('extension/'.length));
  for (const required of spec.required) {
    if (!files.some(f => f.toLowerCase() === required.toLowerCase())) problems.push(`missing ${required}`);
  }
  for (const f of files) {
    if (!spec.allowed.some(re => re.test(f))) problems.push(`unexpected file ${f}`);
    if (forbiddenDirs.test(f) || secretNames.test(f) || (/\.(vsix|map|log)$/.test(f) && !(name==='companion'&&f==='dist/mac-dictation.vsix'))) problems.push(`forbidden file ${f}`);
  }
  for (const rel of spec.identical) {
    const actual = files.find(f => f.toLowerCase() === rel.toLowerCase());
    if (!actual) continue;
    const source = path.join(spec.dir, rel);
    if (!entry(file, actual).equals(fs.readFileSync(source))) problems.push(`${rel} differs from the repository copy`);
  }
  // Sessions executes its zsh helpers directly, so they must keep the executable bit.
  const modes = execFileSync('unzip', ['-Z', file], { encoding: 'utf8' }).split('\n');
  for (const f of files.filter(f => f.endsWith('.zsh'))) {
    const row = modes.find(l => l.endsWith(`extension/${f}`));
    if (!row || !/^-r.x/.test(row)) problems.push(`${f} is not executable in the VSIX`);
  }
  const m = JSON.parse(entry(file, 'package.json').toString('utf8'));
  if (m.name !== manifest(name).name) problems.push('manifest name mismatch');
  if (m.dependencies && Object.keys(m.dependencies).length) problems.push('manifest declares runtime dependencies that the VSIX does not carry');
  if(name==='companion')audit('mac-dictation',path.join(spec.dir,'dist/mac-dictation.vsix'));
  const other = name === 'sessions' ? 'companion' : 'sessions';
  for (const f of files) if (f.includes(other)) problems.push(`${f} mentions the ${other} package`);
  if (problems.length) throw new Error(`${path.relative(root, file)}:\n  - ${problems.join('\n  - ')}`);
  return { file, files };
}

function main() {
  if (!fs.existsSync(vsce)) throw new Error('vsce is not installed; run npm ci.');
  if (!fs.existsSync(path.join(packages.companion.dir, 'dist/extension.cjs'))) throw new Error('Companion is not built. Run npm run package (which builds first).');
  fs.mkdirSync(vsixDir, { recursive: true });
  for (const name of Object.keys(packages)) {
    const out = vsixPath(name);
    // --no-dependencies: Companion is bundled and Sessions has none.
    execFileSync(vsce, ['package', '--no-dependencies',  '--out', out], { cwd: packages[name].dir, stdio: 'inherit' });
    const { files } = audit(name);
    console.log(`\n${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB) passed audit:\n  ${files.join('\n  ')}\n`);
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exit(1); }
}
module.exports = { audit };
