'use strict';
// Shared package facts for build, check and package. Keep Sessions and Companion
// independent: nothing here lets one package's contents leak into the other.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const outputs = path.join(root, '_script_outputs');
const vsixDir = path.join(root, 'dist/vsix');

const materialMedia=['css','document','html','image','javascript','json','markdown','pdf','python','table','typescript','zip'].map(name=>`media/material-${name}.svg`).concat('media/material-license.txt');

const statusMedia=['red','amber','green','grey'].flatMap(color=>['light','dark'].map(theme=>`media/status-${color}-${theme}.svg`));

const packages = {
  'mac-dictation': {
    dir: path.join(root, 'packages/mac-dictation'),
    required: ['LICENSE.txt', 'package.json','readme.md','extension.js'],
    identical: ['LICENSE.txt', 'package.json','extension.js'],
    allowed: [/^license\.txt$/i, /^package\.json$/, /^readme\.md$/i, /^extension\.js$/],
  },
  sessions: {
    dir: path.join(root, 'packages/sessions'),
    // Entries every VSIX must contain (paths inside the archive's extension/ folder).
    required: ['LICENSE.txt', 'package.json', 'readme.md', 'fork.cjs', 'extension.js', 'helpers/agent-tmux-attach.zsh', 'helpers/agent-tmux-rename.zsh', 'helpers/agent-tmux-restore.zsh', 'helpers/agent-tmux-state.zsh', 'helpers/sync-agent-tmux-tasks.zsh'],
    // Files that must match the repository byte-for-byte.
    identical: ['LICENSE.txt', 'fork.cjs', 'extension.js', 'helpers/agent-tmux-attach.zsh', 'helpers/agent-tmux-rename.zsh', 'helpers/agent-tmux-restore.zsh', 'helpers/agent-tmux-state.zsh', 'helpers/sync-agent-tmux-tasks.zsh', 'package.json'],
    allowed: [/^license\.txt$/i, /^package\.json$/, /^readme\.md$/i, /^extension\.js$/, /^fork\.cjs$/, /^helpers\/[a-z-]+\.zsh$/],
  },
  companion: {
    dir: path.join(root, 'packages/companion'),
    required: ['LICENSE.txt', 'package.json', 'readme.md', 'dist/extension.cjs', 'dist/lifecycle-hook.cjs', 'dist/mermaid.js', 'dist/THIRD_PARTY_LICENSES.txt', 'dist/mac-dictation.vsix', 'media/companion.js', 'media/companion.css', 'media/icon.svg', ...materialMedia, ...statusMedia],
    identical: ['LICENSE.txt', 'media/companion.js', 'media/companion.css', 'media/icon.svg', 'package.json', 'dist/extension.cjs', 'dist/lifecycle-hook.cjs', 'dist/mermaid.js', 'dist/mac-dictation.vsix', ...materialMedia, ...statusMedia],
    allowed: [/^license\.txt$/i, /^package\.json$/, /^readme\.md$/i, /^dist\/(extension\.cjs|lifecycle-hook\.cjs|mermaid\.js|THIRD_PARTY_LICENSES\.txt|mac-dictation\.vsix)$/, /^media\/[a-z.-]+$/],
  },
};

function manifest(name) {
  return JSON.parse(fs.readFileSync(path.join(packages[name].dir, 'package.json'), 'utf8'));
}

function vsixPath(name) {
  const m = manifest(name);
  return path.join(vsixDir, `${m.name}-${m.version}.vsix`);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '_');
}

function requireNode22() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    console.error(`Node 22 or newer is required (found ${process.versions.node}).`);
    process.exit(1);
  }
}

module.exports = { root, outputs, vsixDir, packages, manifest, vsixPath, stamp, requireNode22 };
