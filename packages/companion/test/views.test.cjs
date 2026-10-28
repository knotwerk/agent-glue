'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const views = require('../src/views.cjs');

const options = { nonce: 'abc123', scriptUri: 'vscode-resource://x/companion.js?a=1&b="2"', styleUri: 'vscode-resource://x/companion.css', cspSource: 'vscode-resource:' };

test('sidebar and draft views carry a strict CSP with a nonce-only script', () => {
  for (const html of [views.renderSidebar(options), views.renderDraft(options)]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1].replace(/&#39;/g, "'");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-abc123'/);
    assert.match(csp, /connect-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp));
    assert.equal(html.match(/<script/g).length, 1);
    assert.ok(!/\son[a-z]+=/i.test(html), 'no inline event handlers');
  }
});

test('view options are attribute-escaped', () => {
  const html = views.renderSidebar({ ...options, nonce: '"><script>x</script>' });
  assert.ok(!html.includes('"><script>x'));
  const src = /<script nonce="[^"]*" src="([^"]*)"/.exec(html)[1];
  assert.ok(src.includes('&amp;b=&quot;2&quot;'));
});

test('draft view omits terminal and file sections but keeps the composer', () => {
  const draft = views.renderDraft(options);
  const sidebar = views.renderSidebar(options);
  assert.ok(!/id="sessions"|id="files"|id="open-draft"/.test(draft));
  assert.ok(!/id="sessions"/.test(sidebar) && /id="files"/.test(sidebar));
  for (const id of ['draft-text', 'drop-zone', 'paste-draft', 'target']) assert.ok(draft.includes(`id="${id}"`), id);
});

test('paste action never promises auto-submit', () => {
  assert.match(views.renderSidebar(options), /Paste to agent without pressing Enter/);
  assert.doesNotMatch(views.renderSidebar(options), /Note &amp; attachments|Note & attachments|paste-hint|draft-help|target-row|drop-prompt/);
});

test('every id used by the webview script exists in the rendered markup', () => {
  const script = fs.readFileSync(path.join(__dirname, '../media/companion.js'), 'utf8');
  const html = views.renderSidebar(options);
  const ids = new Set([...script.matchAll(/byId\('([^']+)'\)/g)].map(m => m[1]));
  assert.ok(ids.size > 5);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
});

test('webview upload chunks fit the host chunk limit after base64', () => {
  const script = fs.readFileSync(path.join(__dirname, '../media/companion.js'), 'utf8');
  const [, kib] = /CHUNK_BYTES = (\d+) \* 1024/.exec(script);
  const encoded = Math.ceil((Number(kib) * 1024) / 3) * 4;
  assert.ok(encoded <= 300000, `base64 chunk of ${encoded} chars exceeds the host limit`);
});
