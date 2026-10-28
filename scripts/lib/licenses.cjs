"use strict";
const fs = require('node:fs');
const path = require('node:path');

// Include the complete installed runtime dependency tree, conservatively covering
// both the esbuild host bundle and Mermaid's prebuilt browser bundle.
function notices(root, names) {
  const packages = new Map();
  function visit(name, from) {
    let ancestor = from;
    let dir;
    for (;;) {
      dir = path.join(ancestor, 'node_modules', name);
      if (fs.existsSync(path.join(dir, 'package.json'))) break;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error(`Missing runtime dependency ${name}`);
      ancestor = parent;
    }
    dir = fs.realpathSync(dir);
    if (packages.has(dir)) return;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const files = fs.readdirSync(dir).filter(file => /^(licen[cs]e|copying|copyright|notice)([.-]|$)/i.test(file) && fs.statSync(path.join(dir, file)).isFile()).sort();
    if (!files.length) throw new Error(`No license notice found for ${manifest.name}`);
    packages.set(dir, {manifest, text: files.map(file => `${file}\n\n${fs.readFileSync(path.join(dir, file), 'utf8').trim()}\n`).join('\n')});
    for (const dependency of Object.keys(manifest.dependencies || {}).sort()) visit(dependency, dir);
  }
  for (const name of names) visit(name, root);
  return [...packages.values()].sort((a,b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`))
    .map(({manifest,text}) => `== ${manifest.name} ${manifest.version} ==\n\n${text}`).join('\n');
}
module.exports = { notices };
