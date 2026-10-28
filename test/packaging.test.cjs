'use strict';
// Build output and package boundaries. Builds Companion (idempotent, ignored
// output), then proves the bundle is self-contained and each package lists
// only what it should. Nothing is installed or published.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, tempDir } = require('./support/tmp.cjs');
const { packages } = require('../scripts/lib/packages.cjs');

execFileSync(process.execPath, [path.join(root, 'scripts/build.cjs')], { cwd: root, stdio: 'pipe' });
const dist = path.join(packages.companion.dir, 'dist');

test('companion bundle bundles its parsers and leaves only vscode and node built-ins external', () => {
  const code = fs.readFileSync(path.join(dist, 'extension.cjs'), 'utf8');
  const externals = new Set([...code.matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1]));
  for (const spec of externals) assert.ok(spec === 'vscode' || spec.startsWith('node:') || Module.builtinModules.includes(spec), `unexpected external ${spec}`);
  assert.ok(externals.has('vscode'));
  assert.ok(code.includes('MarkdownIt') || code.includes('markdown-it'));
  assert.ok(code.length > 200_000, 'markdown-it and parse5 are inlined');
});

test('companion bundle loads from a directory with no node_modules and no sibling packages', () => {
  const isolated = tempDir('bundle');
  fs.mkdirSync(path.join(isolated, 'dist'));
  for (const f of ['extension.cjs']) fs.copyFileSync(path.join(dist, f), path.join(isolated, 'dist', f));
  const script = `
    const Module = require('node:module'); const load = Module._load;
    Module._load = function (request, ...rest) { return request === 'vscode' ? {} : load.call(this, request, ...rest); };
    const mod = require(process.argv[1]);
    if (typeof mod.activate !== 'function') throw new Error('no activate');
    console.log('loaded');`;
  const out = execFileSync(process.execPath, ['-e', script, path.join(isolated, 'dist/extension.cjs')], { cwd: isolated, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(out.trim(), 'loaded');
});

test('mermaid bundle is a browser build that defines the global', () => {
  const file = path.join(dist, 'mermaid.js');
  const code = fs.readFileSync(file, 'utf8');
  assert.ok(code.length > 1_000_000);
  assert.ok(!/^\s*(import|export)\s/m.test(code.slice(0, 2000)), 'must be a classic script, not an ES module');
});

test('both packages declare independent identities and no shared runtime files', () => {
  const sessions = JSON.parse(fs.readFileSync(path.join(packages.sessions.dir, 'package.json'), 'utf8'));
  const companion = JSON.parse(fs.readFileSync(path.join(packages.companion.dir, 'package.json'), 'utf8'));
  assert.notEqual(sessions.name, companion.name);
  assert.equal(sessions.publisher, companion.publisher);
  assert.equal(sessions.extensionDependencies, undefined);
  assert.equal(companion.extensionDependencies, undefined, 'Companion must work without Sessions installed');
  assert.equal(companion.extensionPack, undefined);
});

for (const name of Object.keys(packages)) {
  test(`${name} VSIX file list matches its allowlist (vsce ls)`, () => {
    const spec = packages[name];
    const listing = execFileSync(path.join(root, 'node_modules/.bin/vsce'), ['ls', '--no-dependencies'], { cwd: spec.dir, encoding: 'utf8' });
    const files = listing.split('\n').map(l => l.trim()).filter(l => l && !/^(INFO|WARNING)/.test(l));
    for (const required of spec.required) assert.ok(files.some(f => f.toLowerCase() === required.toLowerCase()), `missing ${required}`);
    for (const file of files) assert.ok(spec.allowed.some(re => re.test(file)), `unexpected ${file}`);
  });
}

test('Sessions never ships tests or sources of Companion', () => {
  const ignore = fs.readFileSync(path.join(packages.sessions.dir, '.vscodeignore'), 'utf8').split('\n');
  assert.equal(ignore[0], '**');
  assert.ok(!ignore.some(l => /vendor/.test(l) && l.startsWith('!')));
});

test('Companion ships existing media assets', () => {
  for (const asset of ['companion.js', 'companion.css', 'icon.svg']) assert.ok(fs.existsSync(path.join(packages.companion.dir, 'media', asset)), asset);
  const ignore = fs.readFileSync(path.join(packages.companion.dir, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^!media\/\*\*$/m);
});

test('restoration leaves CLI permission policy to the user configuration', () => {
  const script=fs.readFileSync(path.join(packages.sessions.dir,'helpers/agent-tmux-restore.zsh'),'utf8');
  assert.doesNotMatch(script,/--dangerously-|--permission-mode/);
  assert.match(script,/command codex resume/);
  assert.match(script,/command claude --name/);
});
