'use strict';
// Runs every *.test.cjs under test/ and packages/*/test/ with the Node test runner.
// All tmux access in tests is injected. As a belt-and-braces guard a failing
// `tmux` shim sits first on PATH, and the run fails if anything ever invokes it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, outputs, stamp, requireNode22 } = require('./lib/packages.cjs');

requireNode22();

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'support') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.test.cjs')) out.push(full);
  }
  return out;
}

const files = [
  ...collect(path.join(root, 'test')),
  ...fs.readdirSync(path.join(root, 'packages')).flatMap(name => collect(path.join(root, 'packages', name, 'test'))),
].sort();
if (!files.length) { console.error('No test files found.'); process.exit(1); }

const guardDir = path.join(outputs, 'test-guard');
const guardLog = path.join(guardDir, `${stamp()}_${process.pid}_tmux-invocations.log`);
fs.mkdirSync(guardDir, { recursive: true });
const shim = path.join(guardDir, 'bin');
fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'tmux'), '#!/bin/sh\necho "tmux $*" >> "$AGENT_GLUE_TMUX_GUARD_LOG"\necho "tmux is blocked during Agent Glue tests" >&2\nexit 99\n', { mode: 0o755 });

const env = { ...process.env, PATH: `${shim}${path.delimiter}${process.env.PATH}`, AGENT_GLUE_TMUX_GUARD_LOG: guardLog, AGENT_GLUE_TEST: '1' };
delete env.TMUX; // never inherit a pointer to a live tmux server
delete env.TMUX_PANE;

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { cwd: root, env, stdio: 'inherit' });
let status = result.status ?? 1;
if (fs.existsSync(guardLog)) {
  console.error(`\nA test invoked tmux. Calls were blocked and recorded in ${path.relative(root, guardLog)}:\n${fs.readFileSync(guardLog, 'utf8')}`);
  status = status || 1;
}
process.exit(status);
