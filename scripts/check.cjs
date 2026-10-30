'use strict';
// Static release checks: syntax, manifests, package independence,
// git hygiene, private-material scan, CI wiring, and (when a build
// exists) the exact VSIX file lists. Reads no runtime state and starts nothing
// beyond git/vsce listing commands.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, packages, manifest, vsixPath, requireNode22 } = require('./lib/packages.cjs');

requireNode22();

const failures = [];
const notes = [];
const fail = message => failures.push(message);
const rel = p => path.relative(root, p);
const read = p => fs.readFileSync(p, 'utf8');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '_script_outputs', '.git', 'vendor'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

function syntax() {
  const files = [
    ...walk(path.join(root, 'scripts'), f => /\.cjs$/.test(f)),
    ...walk(path.join(root, 'test'), f => /\.cjs$/.test(f)),
    ...walk(path.join(root, 'packages'), f => /\.(cjs|js)$/.test(f)),
  ];
  for (const file of files) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch (error) { fail(`syntax error in ${rel(file)}: ${String(error.stderr).split('\n')[0]}`); }
  }
  for (const file of walk(path.join(root, 'packages'), f => /\.zsh$/.test(f))) {
    const first = read(file).split('\n')[0];
    if (!/^#!.*zsh/.test(first)) fail(`${rel(file)} lacks a zsh shebang`);
    if (!(fs.statSync(file).mode & 0o100)) fail(`${rel(file)} is not executable`);
  }
  notes.push(`syntax: ${files.length} JavaScript files`);
}

function manifests() {
  const rootManifest = JSON.parse(read(path.join(root, 'package.json')));
  const all = {};
  const license = read(path.join(root, 'LICENSE'));
  if (rootManifest.license !== 'MIT') fail('root manifest must declare MIT');
  for (const name of Object.keys(packages)) {
    const m = all[name] = manifest(name);
    const where = `packages/${name}/package.json`;
    if (m.license !== 'MIT') fail(`${where}: license must be MIT`);
    if (read(path.join(packages[name].dir, 'LICENSE.txt')) !== license) fail(`${name}: LICENSE differs from root`);
    if (m.version !== rootManifest.version) fail(`${where}: version ${m.version} differs from the root ${rootManifest.version}`);
    if (!m.publisher || !m.name || !m.displayName || !m.description) fail(`${where}: missing identity fields`);
    if (!/^\^?\d+\.\d+\.\d+$/.test(m.engines?.vscode || '')) fail(`${where}: engines.vscode must be a plain range`);
    if (m.dependencies && Object.keys(m.dependencies).length) fail(`${where}: runtime dependencies are not packaged (--no-dependencies)`);
    if (!m.extensionKind?.includes(name==='mac-dictation'?'ui':'workspace')) fail(`${where}: extensionKind must include workspace for Remote SSH`);
    if (m.capabilities?.untrustedWorkspaces?.supported !== false) fail(`${where}: must declare untrusted workspaces unsupported`);
    for (const f of ['README.md', '.vscodeignore']) {
      if (!fs.existsSync(path.join(packages[name].dir, f))) fail(`packages/${name}/${f} is missing`);
    }
    if (!/^\*\*$/m.test(read(path.join(packages[name].dir, '.vscodeignore')))) fail(`packages/${name}/.vscodeignore must start from an allowlist ("**")`);
  }
  if (all.sessions.name === all.companion.name) fail('package names must differ');
  const ids = [...all.sessions.contributes.commands, ...all.companion.contributes.commands].map(c => c.command);
  if (new Set(ids).size !== ids.length) fail('command ids are not unique across packages');

  // Sessions entry point.
  if (!fs.existsSync(path.join(packages.sessions.dir, all.sessions.main))) fail(`sessions main ${all.sessions.main} is missing`);

  // Companion: entry source, contributed commands/views registered in the host, assets present.
  const entry = path.join(packages.companion.dir, 'src/extension.cjs');
  if (!fs.existsSync(entry)) { fail('packages/companion/src/extension.cjs is missing'); return; }
  const host = read(entry) + read(path.join(packages.companion.dir, 'src/terminal-selector.cjs'));
  for (const { command } of all.companion.contributes.commands) {
    if (!host.includes(`'${command}'`) && !host.includes(`"${command}"`)) fail(`companion host does not register ${command}`);
  }
  for (const view of Object.values(all.companion.contributes.views).flat()) {
    if (!host.includes(view.id)) fail(`companion host does not provide view ${view.id}`);
  }
  for (const container of all.companion.contributes.viewsContainers.activitybar) {
    if (!fs.existsSync(path.join(packages.companion.dir, container.icon))) fail(`missing icon ${container.icon}`);
  }
  if (all.companion.main !== './dist/extension.cjs') fail('companion main must be ./dist/extension.cjs');
  if (!/require\(['"]vscode['"]\)/.test(host)) fail('companion host should require vscode');
  const sessionApi = /extensions\.getExtension\(['"]([^'"]+)['"]\)/.exec(host);
  if (sessionApi && sessionApi[1] !== `${all.sessions.publisher}.${all.sessions.name}`) fail(`companion looks up ${sessionApi[1]} but Sessions is ${all.sessions.publisher}.${all.sessions.name}`);
  notes.push('manifests: versions, identities, contributions and assets consistent');
}

function independence() {
  const checks = {
    sessions: { dir: packages.sessions.dir, forbidden: /companion/i },
    companion: { dir: packages.companion.dir, forbidden: /\.\.\/\.\.\/sessions|packages\/sessions|vendor\/original/ },
  };
  for (const [name, { dir, forbidden }] of Object.entries(checks)) {
    const files = walk(dir, f => /\.(cjs|js)$/.test(f) && !f.includes(`${path.sep}test${path.sep}`));
    for (const file of files) {
      const text = read(file);
      for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1];
        if (spec.startsWith('.') && !path.resolve(path.dirname(file), spec).startsWith(dir + path.sep)) fail(`${rel(file)} requires ${spec}, which leaves package ${name}`);
        if (forbidden.test(spec)) fail(`${rel(file)} requires ${spec}`);
      }
    }
  }
  const sessionsSource = read(path.join(packages.sessions.dir, 'extension.js'));
  if (/agent-glue-companion|agentGlue\.(companion|preview|draft|layout|pin)\b/.test(sessionsSource)) fail('sessions must not depend on companion identifiers');
  notes.push('independence: no cross-package requires');
}

function hygiene() {
  let tracked = [];
  try { tracked = [...git('ls-files').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean); }
  catch (error) { fail(`git listing failed: ${error.message}`); return; }
  const bad = /(^|\/)(node_modules|dist|_script_outputs|\.local)\/|\.vsix$|\.env($|\.)|\.pem$|\.key$|\.jsonl$|\.DS_Store$/;
  for (const file of tracked) if (bad.test(file)) fail(`${file} must stay out of git`);
  for (const probe of ['dist/x', 'x.vsix', '_script_outputs/x', '.local/agent-glue/inbox/x', 'node_modules/x']) {
    try { git('check-ignore', '-q', '--', probe); } catch { fail(`.gitignore does not cover ${probe}`); }
  }
  const secret = [/sk-ant-[A-Za-z0-9_-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{30,}/, /AKIA[0-9A-Z]{16}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/i];
  for (const file of tracked) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).size > 3 * 1024 * 1024 || file === 'package-lock.json') continue;
    const text = fs.readFileSync(full, 'latin1');
    for (const re of secret) {
      // Test fixtures deliberately contain look-alikes only when they are written to be inert.
      if (re.test(text) && !file.startsWith('test/') && !file.includes('/test/')) fail(`${file} looks like it contains a credential (${re})`);
    }
  }
  const lock = JSON.parse(read(path.join(root, 'package-lock.json')));
  const rootManifest = JSON.parse(read(path.join(root, 'package.json')));
  for (const name of Object.keys(packages)) {
    if (!lock.packages?.[`packages/${name}`]) fail(`package-lock.json lacks the packages/${name} workspace entry; npm ci would fail (run npm install --package-lock-only)`);
  }
  const declared = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
  for (const [dep, version] of Object.entries(declared)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`${dep} should be pinned to an exact version (found ${version})`);
    const locked = lock.packages?.[`node_modules/${dep}`]?.version;
    if (locked !== version) fail(`package-lock.json has ${dep}@${locked}, package.json wants ${version}`);
  }
  notes.push(`hygiene: ${tracked.length} non-ignored files scanned`);
}

function workflow() {
  const dir = path.join(root, '.github/workflows');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)) : [];
  if (!files.length) { fail('no GitHub workflow found'); return; }
  const text = files.map(f => read(path.join(dir, f))).join('\n');
  for (const [re, what] of [[/node-version:\s*['"]?22/, 'Node 22'], [/npm ci/, 'npm ci'], [/npm test/, 'npm test'], [/npm run check/, 'npm run check'], [/npm run package/, 'npm run package']]) {
    if (!re.test(text)) fail(`workflow is missing ${what}`);
  }
  if (/\bpublish\b|vsce publish|ovsx/.test(text)) fail('workflows must not publish');
  notes.push('workflow: CI installs with npm ci and runs test, check and package');
}

function vsixContents() {
  const companionBuilt = fs.existsSync(path.join(packages.companion.dir, 'dist/extension.cjs'));
  if (!companionBuilt) { notes.push('vsix: SKIPPED (no build; run npm run build, or npm run package which audits both archives)'); return; }
  const vsce = path.join(root, 'node_modules/.bin/vsce');
  for (const name of Object.keys(packages)) {
    let listing;
    try { listing = execFileSync(vsce, ['ls', '--no-dependencies'], { cwd: packages[name].dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { fail(`vsce ls failed for ${name}: ${String(error.stderr || error.message).split('\n')[0]}`); continue; }
    const files = listing.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('INFO') && !l.startsWith('WARNING'));
    for (const required of packages[name].required) if (!files.some(f => f.toLowerCase() === required.toLowerCase())) fail(`${name} VSIX would miss ${required}`);
    for (const f of files) if (!packages[name].allowed.some(re => re.test(f))) fail(`${name} VSIX would include unexpected ${f}`);
  }
  notes.push('vsix: file lists match the allowlists');
}

for (const step of [syntax, manifests, independence, hygiene, workflow, vsixContents]) {
  try { step(); } catch (error) { fail(`${step.name}: ${error.message}`); }
}
for (const note of notes) console.log(`ok   ${note}`);
for (const message of failures) console.error(`FAIL ${message}`);
if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
