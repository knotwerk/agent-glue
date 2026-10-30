'use strict';
// Builds the Companion bundle. Sessions ships its sources as-is and needs no build.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { root, packages, requireNode22 } = require('./lib/packages.cjs');

requireNode22();

const companion = packages.companion.dir;
const dist = path.join(companion, 'dist');
const entry = path.join(companion, 'src/extension.cjs');

async function main() {
  if (!fs.existsSync(entry)) throw new Error(`Missing host entry point: ${path.relative(root, entry)}`);
  fs.mkdirSync(dist, { recursive: true });
  const helper=path.join(dist,'mac-dictation.vsix');
  require('node:child_process').execFileSync(path.join(root,'node_modules/.bin/vsce'),['package','--no-dependencies','--out',helper],{cwd:packages['mac-dictation'].dir,stdio:'pipe'});
  require('./package.cjs').audit('mac-dictation',helper);

  // Host bundle: vscode stays external; markdown-it and parse5 are bundled so the
  // VSIX needs no node_modules.
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(dist, 'extension.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    legalComments: 'none',
    logLevel: 'warning',
  });

  // Preview expects a browser bundle that defines the global `mermaid`.
  const mermaidSource = path.join(root, 'node_modules/mermaid/dist/mermaid.min.js');
  if (!fs.existsSync(mermaidSource)) throw new Error('mermaid is not installed; run npm ci.');
  fs.copyFileSync(mermaidSource, path.join(dist, 'mermaid.js'));

  // Preserve transitive notices too, including the prebuilt Mermaid dependencies.
  const notices = require('./lib/licenses.cjs').notices(root, ['markdown-it', 'parse5', 'mermaid']);
  fs.writeFileSync(path.join(dist, 'THIRD_PARTY_LICENSES.txt'), notices);

  fs.copyFileSync(path.join(companion,'src/lifecycle-hook.cjs'),path.join(dist,'lifecycle-hook.cjs'));
  verifyBundle(dist);
  console.log(`Built ${path.relative(root, dist)}/ (extension.cjs, mermaid.js, THIRD_PARTY_LICENSES.txt)`);
}

function verifyBundle(dir) {
  const code = fs.readFileSync(path.join(dir, 'extension.cjs'), 'utf8');
  const problems = [];
  if (!/require\(["']vscode["']\)/.test(code)) problems.push('bundle does not require vscode');
  for (const dep of ['markdown-it', 'parse5']) {
    if (new RegExp(`require\\(["']${dep}["']\\)`).test(code)) problems.push(`${dep} is not bundled`);
  }
  if (/require\(["'][^"']*(sessions|\.\.\/\.\.)/.test(code)) problems.push('bundle references the sessions package');
  const mermaid = fs.readFileSync(path.join(dir, 'mermaid.js'), 'utf8');
  if (mermaid.length < 1_000_000 || !/mermaid/.test(mermaid.slice(0, 200000) + mermaid.slice(-200000))) problems.push('mermaid.js does not look like the browser bundle');
  if (problems.length) throw new Error(`Bundle verification failed: ${problems.join('; ')}`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
