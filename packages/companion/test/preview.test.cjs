'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const preview = require('../src/preview.cjs');
const { tempDir } = require('../../../test/support/tmp.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function project(files) {
  const base = tempDir('preview');
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { base, root };
}
const render = (p, name, mermaid) => preview.documentHtml(path.join(p.root, name), p.root, mermaid);
const body = html => html.slice(html.indexOf('<body>'));

test('escape handles all HTML-significant characters', () => {
  assert.equal(preview.escape(`<a href="x" b='y'>&`), '&lt;a href=&quot;x&quot; b=&#39;y&#39;&gt;&amp;');
  assert.equal(preview.escape(5), '5');
});

test('documents ship with a deny-by-default CSP', async () => {
  const p = project({ 'a.md': '# Hi' });
  const html = await render(p, 'a.md');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1].replace(/&#39;/g, "'");
  for (const directive of ["default-src 'none'", "connect-src 'none'", "font-src 'none'", "img-src data:", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.ok(!/frame-src|https?:/.test(csp));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<h1'));
});

test('markdown renders headings and tables', async () => {
  const p = project({ 'a.md': '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' });
  const html = await render(p, 'a.md');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<table>/);
});

test('markdown cannot inject raw HTML, scripts or event handlers', async () => {
  const src = '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<iframe src="https://evil"></iframe>\n\nText <b onclick="x()">bold</b>';
  const html = body(await render(project({ 'a.md': src }), 'a.md'));
  assert.ok(!/<script/i.test(html), 'no script element without mermaid');
  assert.ok(!/<img|<iframe|<b /i.test(html));
  assert.match(html, /&lt;script&gt;/);
});

test('markdown links and images are neutralised', async () => {
  const src = '[js](javascript:alert(1)) [web](https://evil.example/x) [rel](other.md) [anchor](#sec)\n\n![remote](https://evil.example/p.png) ![proto](//evil.example/p.png)';
  const html = body(await render(project({ 'a.md': src }), 'a.md'));
  assert.ok(!/(href|src)="[^"]*javascript:/i.test(html));
  assert.ok(!/(href|src)="[^"]*evil\.example/.test(html));
  assert.ok(!/href="(?!#)/.test(html), 'only fragment hrefs survive');
  assert.match(html, /href="#sec"/);
  assert.ok(!/src="[^"]/.test(html), 'no image keeps a source');
});

test('HTML documents lose navigation, embedding and exfiltration vectors', async () => {
  const src = `<html><head><base href="https://evil/"><meta http-equiv="refresh" content="0;url=https://evil"><link rel="stylesheet" href="https://evil/x.css"></head><body>
<a href="https://evil/x" target="_blank" ping="https://evil/p" download>x</a><a href="javascript:alert(1)">js</a>
<form action="https://evil/post"><button formaction="https://evil/f">go</button></form>
<iframe src="https://evil"></iframe><object data="https://evil"></object><embed src="https://evil">
<img src="https://evil/a.png" srcset="https://evil/b.png 2x"><img src="//evil/c.png"><img src="file:///etc/passwd"><img src="data:image/png;base64,AAAA">
<video src="https://evil/v"></video><script src="https://evil/s.js"></script><iframe srcdoc="<script>1</script>"></iframe>
<svg><a xlink:href="https://evil/svg"><text>t</text></a><use href="https://evil/u.svg#a"/></svg></body></html>`;
  const html = body(await render(project({ 'a.html': src }), 'a.html'));
  assert.ok(!/evil/.test(html), html);
  assert.ok(!/<(base|meta|link|iframe|object|embed)\b/i.test(html));
  assert.ok(!/\b(target|ping|download|action|formaction|srcdoc|srcset)=/i.test(html));
  assert.ok(!/javascript:/i.test(html));
  assert.ok(!/file:/.test(html));
  assert.ok(!/src="[^"]/.test(html), 'no src attribute keeps a value');
});

test('HTML meta CSP overrides from the document are removed', async () => {
  const src = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>x</body></html>';
  const html = await render(project({ 'a.html': src }), 'a.html');
  assert.equal(html.match(/Content-Security-Policy/g).length, 1);
  assert.ok(!/default-src \*/.test(html));
});

test('local images inside the project are inlined as data URIs', async () => {
  const p = project({ 'docs/a.md': '![x](img/p.png) ![y](img/space%20name.png)', 'docs/img/p.png': PNG, 'docs/img/space name.png': PNG });
  const html = await render(p, 'docs/a.md');
  const sources = [...html.matchAll(/src="(data:[^"]+)"/g)].map(m => m[1]);
  assert.equal(sources.length, 2);
  for (const s of sources) assert.equal(s, `data:image/png;base64,${PNG.toString('base64')}`);
});

test('images outside the project, via traversal, encoding or symlinks, stay empty', async () => {
  const p = project({
    'docs/a.html': '<img src="../../secret.png"><img src="..%2F..%2Fsecret.png"><img src="/etc/hostname.png"><img src="link.png"><img src="dirlink/secret.png"><img src="%E0%A4%A.png">',
  });
  fs.writeFileSync(path.join(p.base, 'secret.png'), PNG);
  fs.symlinkSync(path.join(p.base, 'secret.png'), path.join(p.root, 'docs/link.png'));
  fs.symlinkSync(p.base, path.join(p.root, 'docs/dirlink'));
  const html = body(await render(p, 'docs/a.html'));
  assert.ok(!/data:image/.test(html));
  assert.equal([...html.matchAll(/<img src="">/g)].length, 6);
});

test('only raster image types are inlined and large images are skipped', async () => {
  const p = project({ 'a.html': '<img src="v.svg"><img src="n.txt"><img src="big.png"><img src="ok.GIF">', 'v.svg': '<svg onload="1"/>', 'n.txt': 'hi', 'ok.GIF': PNG });
  fs.writeFileSync(path.join(p.root, 'big.png'), Buffer.alloc(0));
  fs.truncateSync(path.join(p.root, 'big.png'), 5 * 1024 * 1024 + 1);
  const html = body(await render(p, 'a.html'));
  assert.equal([...html.matchAll(/src="data:image\/gif/g)].length, 1);
  assert.equal([...html.matchAll(/<img src="">/g)].length, 3);
});

test('documentHtml refuses files outside the project, symlink escapes and unsupported types', async () => {
  const p = project({ 'a.txt': 'x', 'ok.md': 'ok' });
  fs.writeFileSync(path.join(p.base, 'outside.md'), 'secret');
  fs.symlinkSync(path.join(p.base, 'outside.md'), path.join(p.root, 'link.md'));
  await assert.rejects(preview.documentHtml(path.join(p.base, 'outside.md'), p.root), /outside/);
  await assert.rejects(preview.documentHtml(path.join(p.root, 'link.md'), p.root), /outside/);
  await assert.rejects(preview.documentHtml(path.join(p.root, 'a.txt'), p.root), /Markdown or HTML/);
  await assert.rejects(preview.documentHtml(path.join(p.root, 'missing.md'), p.root));
  assert.match(await render(p, 'ok.md'), /ok/);
});

test('documentHtml enforces the 25 MB preview limit', async () => {
  const p = project({ 'ok.md': 'x' });
  const big = path.join(p.root, 'big.md');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 25 * 1024 * 1024 + 1);
  await assert.rejects(preview.documentHtml(big, p.root), /25 MB/);
});

test('mermaid fences render as inert escaped blocks', async () => {
  const src = '```mermaid\ngraph TD\nA["<script>alert(1)</script>"] --> B\n```\n\n```js\n<b>code</b>\n```';
  const html = body(await render(project({ 'a.md': src }), 'a.md'));
  assert.match(html, /<pre class="mermaid">graph TD\nA\["&lt;script&gt;alert\(1\)&lt;\/script&gt;"\] --&gt; B\n<\/pre>/);
  assert.ok(!/<script/i.test(html));
  assert.match(html, /&lt;b&gt;code&lt;\/b&gt;/);
});

test('mermaid bundle is inlined only for markdown, with strict security level', async () => {
  const bundle = 'window.mermaid={initialize(){}};/* </script><img src=x> */';
  const md = await render(project({ 'a.md': '# x' }), 'a.md', bundle);
  assert.match(md, /securityLevel:'strict'/);
  assert.ok(md.includes('window.mermaid={initialize(){}}'));
  assert.equal(md.match(/<\/script/gi).length, 2, 'bundle cannot close its own script element');
  assert.ok(md.includes('<\\/script>'));
  const html = await render(project({ 'a.html': '<p>x</p>' }), 'a.html', bundle);
  assert.ok(!/securityLevel|window\.mermaid/.test(html));
  const none = await render(project({ 'a.md': '# x' }), 'a.md');
  assert.ok(!/securityLevel/.test(none));
});

// ----------------------------------------------------------- openPreview

function fakeVscode() {
  const events = { clipboard: [], shown: [], panels: [] };
  const vscode = {
    ViewColumn: { Beside: -2, One: 1 },
    Uri: { file: fsPath => ({ fsPath }) },
    env: { clipboard: { writeText: async t => events.clipboard.push(t) } },
    window: {
      showTextDocument: async uri => events.shown.push(uri.fsPath),
      createWebviewPanel(type, title, column, options) {
        const panel = {
          type, title, column, options, revealed: [], webview: { html: '', handler: null, onDidReceiveMessage(h) { this.handler = h; } },
          disposeHandler: null, reveal(c) { this.revealed.push(c); }, onDidDispose(h) { this.disposeHandler = h; },
        };
        events.panels.push(panel);
        return panel;
      },
    },
  };
  return { vscode, events };
}

function extensionDir(bundle = 'window.mermaid={initialize(){}};') {
  const dir = tempDir('extension');
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.writeFileSync(path.join(dir, 'dist/mermaid.js'), bundle);
  return dir;
}

test('openPreview builds a locked-down webview with a sandboxed iframe', async () => {
  const p = project({ 'a.md': '# <Hi> & "bye"' });
  const { vscode, events } = fakeVscode();
  const panels = new Map();
  const panel = await preview.openPreview(vscode, { extensionPath: extensionDir() }, path.join(p.root, 'a.md'), p.root, panels);
  assert.equal(events.panels.length, 1);
  assert.deepEqual(panel.options.localResourceRoots, []);
  assert.equal(panel.options.enableScripts, true);
  const html = panel.webview.html;
  const nonce = /<script nonce="([0-9a-f]{36})">/.exec(html)[1];
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-src 'self'/);
  assert.ok(!/https?:|\*|unsafe-eval/.test(csp), csp);
  // srcdoc frames inherit this policy, so inline scripts need 'unsafe-inline' unless a nonce is listed.
  assert.ok(/script-src [^;]*('unsafe-inline'|'nonce-)/.test(csp));
  assert.match(html, /<iframe [^>]*sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(html));
  assert.equal(html.match(/<script/g).length, 1, 'only the nonce bootstrap script is a real element');
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.match(html, /srcdoc="&lt;!doctype html&gt;/);
  assert.ok(!/srcdoc="[^"]*[<>]/.test(html), 'srcdoc attribute is fully escaped');
  assert.equal(panels.size, 1);
});

test('openPreview uses a fresh nonce per panel', async () => {
  const p = project({ 'a.md': 'a', 'b.md': 'b' });
  const { vscode } = fakeVscode();
  const ctx = { extensionPath: extensionDir() };
  const one = await preview.openPreview(vscode, ctx, path.join(p.root, 'a.md'), p.root, new Map());
  const two = await preview.openPreview(vscode, ctx, path.join(p.root, 'b.md'), p.root, new Map());
  const n = h => /<script nonce="([0-9a-f]{36})">/.exec(h)[1];
  assert.notEqual(n(one.webview.html), n(two.webview.html));
});

test('openPreview reveals an existing panel and forgets disposed ones', async () => {
  const p = project({ 'a.md': 'a' });
  const { vscode, events } = fakeVscode();
  const panels = new Map();
  const ctx = { extensionPath: extensionDir() };
  const file = path.join(p.root, 'a.md');
  const panel = await preview.openPreview(vscode, ctx, file, p.root, panels);
  assert.equal(await preview.openPreview(vscode, ctx, file, p.root, panels), undefined);
  assert.deepEqual(panel.revealed, [1]);
  assert.equal(panel.column,1);
  assert.equal(events.panels.length, 1);
  panel.disposeHandler();
  assert.equal(panels.size, 0);
  await preview.openPreview(vscode, ctx, file, p.root, panels);
  assert.equal(events.panels.length, 2);
});

test('openPreview webview messages copy or open only the validated file', async () => {
  const p = project({ 'a.md': 'a' });
  const { vscode, events } = fakeVscode();
  const file = path.join(p.root, 'a.md');
  const panel = await preview.openPreview(vscode, { extensionPath: extensionDir() }, file, p.root, new Map());
  await panel.webview.handler({ type: 'copy', path: '/etc/passwd' });
  await panel.webview.handler({ type: 'source', path: '/etc/passwd' });
  await panel.webview.handler({ type: 'other' });
  assert.deepEqual(events.clipboard, [file]);
  assert.deepEqual(events.shown, [file]);
});

test('openPreview rejects outside files and a missing mermaid bundle without opening a panel', async () => {
  const p = project({ 'a.md': 'a' });
  fs.writeFileSync(path.join(p.base, 'out.md'), 'x');
  const { vscode, events } = fakeVscode();
  await assert.rejects(preview.openPreview(vscode, { extensionPath: extensionDir() }, path.join(p.base, 'out.md'), p.root, new Map()), /outside/);
  const empty = tempDir('no-bundle');
  await assert.rejects(preview.openPreview(vscode, { extensionPath: empty }, path.join(p.root, 'a.md'), p.root, new Map()), /ENOENT/);
  assert.equal(events.panels.length, 0);
});

test('openPreview HTML documents with script keep it confined to the sandboxed srcdoc', async () => {
  const p = project({ 'a.html': '<p>hi</p><script>document.title="x"</script>' });
  const { vscode } = fakeVscode();
  const panel = await preview.openPreview(vscode, { extensionPath: extensionDir() }, path.join(p.root, 'a.html'), p.root, new Map());
  assert.equal(panel.webview.html.match(/<script/g).length, 1);
  assert.match(panel.webview.html, /&lt;script&gt;document\.title/);
});

// Regression: parse5 stores template contents in a separate fragment.
test('template contents are sanitised like the rest of the document', async () => {
  const src = '<template><img src="https://evil/x.png"><a href="https://evil/x">x</a></template>';
  const html = body(await render(project({ 'a.html': src }), 'a.html'));
  assert.ok(!/evil/.test(html));
});

test('self-contained HTML review screenshots retain valid raster data URIs', async () => {
  const src=`<img src="data:image/png;base64,${PNG.toString('base64')}"><img src="data:image/svg+xml;base64,PHN2Zz4=">`;
  const html=body(await render(project({'a.html':src}),'a.html'));
  assert.ok(html.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`));
  assert.ok(!html.includes('data:image/svg+xml'));
});
