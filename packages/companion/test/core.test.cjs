'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/core.cjs');
const { tempDir, gitProject } = require('../../../test/support/tmp.cjs');

const SEP = '\x1f';
const line = (id, session, pane, cwd, title = '') => [id, session, pane, cwd, title].join(SEP);

test('parseSessions keeps only well-formed agent panes', () => {
  const out = [
    line('$1', 'claude-main', '%3', '/p', 'Fix bug'),
    line('$2', 'codex2-api', '%4', '/q'),
    line('$3', 'claudelp-x', '%5', '/r'),
    line('$4', 'bash-shell', '%6', '/s'),
    line('1', 'claude-bad-id', '%7', '/s'),
    line('$5', 'claude-bad-pane', '7', '/s'),
    line('$6', 'codex9-nope', '%8', '/s'),
    '',
  ].join('\n');
  const parsed = core.parseSessions(out);
  assert.deepEqual(parsed.map(s => s.sessionName), ['claude-main', 'codex2-api', 'claudelp-x']);
  assert.equal(parsed[0].name, 'Fix bug');
  assert.equal(parsed[1].name, 'codex2-api');
  assert.equal(parsed[1].profile, 'codex2');
  assert.equal(parsed[0].cwd, '/p');
});

test('sessions uses an injected exec with a read-only tmux listing', async () => {
  const calls = [];
  const exec = async (cmd, args, options) => { calls.push([cmd, args, options]); return { stdout: line('$1', 'claude-a', '%1', '/p') + '\n' }; };
  const result = await core.sessions(exec);
  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'tmux');
  assert.equal(calls[0][1][0], 'list-panes');
  assert.equal(calls[0][2].timeout,1500);
  assert.ok(!calls[0][1].some(a => /send-keys|kill|capture/.test(a)));
});

test('sessions treats a missing tmux server as empty but surfaces other failures', async () => {
  const none = async () => { throw Object.assign(new Error('x'), { stderr: 'no server running on /tmp/tmux-1/default' }); };
  assert.deepEqual(await core.sessions(none), []);
  const bad = async () => { throw Object.assign(new Error('boom'), { stderr: 'permission denied' }); };
  await assert.rejects(core.sessions(bad), /boom/);
});

test('references finds markdown links, quoted paths, and relative paths', () => {
  const text = [
    'Wrote [plan](docs/plan.md:12:3) and "notes/a.markdown"',
    'Open ./report.html, ../up/x.htm; and /abs/path/y.md)',
    '[pin] /abs/pinned.md',
    'Also: file.txt image.png',
  ].join('\n');
  const found = core.references(text, '/work/proj');
  const paths = found.map(f => f.path);
  assert.ok(paths.includes('/work/proj/docs/plan.md'));
  assert.ok(paths.includes('/work/proj/notes/a.markdown'));
  assert.ok(paths.includes('/work/proj/report.html'));
  assert.ok(paths.includes('/work/up/x.htm'));
  assert.ok(paths.includes('/abs/path/y.md'));
  assert.equal(found.find(f => f.path === '/abs/pinned.md').pinned, true);
  assert.equal(found.find(f => f.path === '/abs/path/y.md').pinned, false);
  assert.ok(paths.includes('/work/proj/file.txt'));
  assert.ok(paths.includes('/work/proj/image.png'));
});

test('references skips scheme links in markdown and deduplicates paths', () => {
  const found = core.references('[x](https://example.com/a.md) [y](./a.md) [z](./a.md)', '/w');
  assert.deepEqual(found.map(f => f.path), ['/w/a.md']);
});

test('references output is always rejected by inside() when it escapes the project', async () => {
  // URLs in prose may yield bogus absolute candidates; the containment check is
  // the boundary that keeps them from ever being read.
  const root = tempDir('refs');
  const found = core.references('see https://example.com/a/y.md and /etc/hosts.md', root);
  for (const ref of found) await assert.rejects(core.inside(root, ref.path));
});

test('observe merges, pins, sorts and caps the list', () => {
  const first = core.observe([], [{ id: 'a', path: 'a', pinned: false }, { id: 'b', path: 'b', pinned: true }]);
  assert.equal(first[0].id, 'b');
  const again = core.observe(first, [{ id: 'a', path: 'a', pinned: true }, { id: 'c', path: 'c', pinned: false }]);
  assert.equal(again.length, 3);
  assert.equal(again.find(f => f.id === 'a').pinned, true);
  const many = core.observe([], Array.from({ length: 300 }, (_, i) => ({ id: `f${i}`, path: `f${i}`, pinned: false })));
  assert.equal(many.length, 100);
});

test('observe does not re-pin a manually unpinned file', () => {
  const prev = [{ id: 'a', pinned: false, manual: true, seen: 1 }];
  const next = core.observe(prev, [{ id: 'a', pinned: true }]);
  assert.equal(next[0].pinned, false);
});

test('inside accepts files in the project and rejects traversal, siblings and missing files', async () => {
  const base = tempDir('inside');
  const root = path.join(base, 'proj');
  const sibling = path.join(base, 'proj-evil');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(root, 'docs/a.md'), '# a');
  fs.writeFileSync(path.join(sibling, 's.md'), '# s');
  fs.writeFileSync(path.join(base, 'outside.md'), '# o');
  assert.equal(await core.inside(root, path.join(root, 'docs/a.md')), path.join(root, 'docs/a.md'));
  await assert.rejects(core.inside(root, path.join(root, '../outside.md')), /outside/);
  await assert.rejects(core.inside(root, path.join(sibling, 's.md')), /outside/);
  await assert.rejects(core.inside(root, path.join(root, 'docs/missing.md')));
});

test('inside rejects a symlink that resolves outside the project', async () => {
  const base = tempDir('inside-link');
  const root = path.join(base, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(base, 'secret.md'), 'secret');
  fs.symlinkSync(path.join(base, 'secret.md'), path.join(root, 'link.md'));
  fs.symlinkSync(base, path.join(root, 'dirlink'));
  await assert.rejects(core.inside(root, path.join(root, 'link.md')), /outside/);
  await assert.rejects(core.inside(root, path.join(root, 'dirlink/secret.md')), /outside/);
});

test('project resolves the git toplevel through an injected exec', async () => {
  const dir = tempDir('project');
  const exec = async (cmd, args) => { assert.equal(cmd, 'git'); assert.deepEqual(args, ['-c', 'core.fsmonitor=false', '-C', '/cwd', 'rev-parse', '--show-toplevel']); return { stdout: `${dir}\n` }; };
  assert.equal(await core.project('/cwd', exec), dir);
});

test('draftText joins the note with attachment paths and paste guards the terminal', () => {
  assert.equal(core.draftText({ text: 'hello', attachments: [{ path: '/a' }, { path: '/b' }] }), 'hello\n\n/a\n\n/b');
  assert.equal(core.draftText({ text: '', attachments: [{ path: '/a' }] }), '/a');
  const sent = [];
  const terminal = { show: () => sent.push('show'), sendText: (t, nl) => sent.push([t, nl]) };
  core.paste(terminal, { text: 'line one\nline two\twith tab' });
  assert.deepEqual(sent, ['show', ['\x1b[200~line one\nline two\twith tab\x1b[201~', false]]);
  assert.equal(sent[1][1], false, 'never submits');
});

test('paste refuses missing terminals and control characters, never submitting', () => {
  assert.throws(() => core.paste(null, { text: 'x' }), /unavailable/);
  for (const bad of ['a\x1b[31mred', 'a\rb', 'a\x00b', 'a\x7fb', 'a\x03b']) {
    const terminal = { show() { throw new Error('should not show'); }, sendText() { throw new Error('should not send'); } };
    assert.throws(() => core.paste(terminal, { text: bad }), /control characters/);
  }
  assert.throws(() => core.paste({ show() {}, sendText() {} }, { text: 'ok', attachments: [{ path: '/p\x1b' }] }), /control characters/);
});

test('supported matches only Markdown and HTML documents', () => {
  for (const ok of ['a.md', 'A.MD', 'a.markdown', 'a.html', 'a.HTM']) assert.ok(core.supported(ok), ok);
  for (const bad of ['a.txt', 'a.md.exe', 'a.svg', 'md', 'a.mdx']) assert.ok(!core.supported(bad), bad);
});

// ---------------------------------------------------------------- uploads

const b64 = text => Buffer.from(text).toString('base64');
const inboxOf = root => path.join(root, '.local/agent-glue/inbox');

async function upload(uploads, root, id, name, content) {
  const data = Buffer.from(content);
  await uploads.start({ id, name, size: data.length }, root, 't1');
  if (data.length) await uploads.chunk({ id, offset: 0, data: data.toString('base64') });
  return uploads.finish(id);
}

test('Uploads stores a file privately inside the ignored inbox', async () => {
  const root = gitProject('upload-ok');
  const uploads = new core.Uploads();
  const result = await upload(uploads, root, 'abc-1', 'notes.txt', 'hello world');
  assert.equal(path.dirname(result.path), inboxOf(root));
  assert.equal(result.targetId, 't1');
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'hello world');
  assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  for (const dir of ['.local', '.local/agent-glue', '.local/agent-glue/inbox']) assert.equal(fs.statSync(path.join(root, dir)).mode & 0o077, 0, dir);
  assert.equal(result.handle, undefined);
  assert.equal(uploads.active.size, 0);
});

test('Uploads accepts empty files and multi-chunk files in order', async () => {
  const root = gitProject('upload-chunks');
  const uploads = new core.Uploads();
  assert.equal(fs.statSync((await upload(uploads, root, 'empty', 'e.bin', '')).path).size, 0);
  await uploads.start({ id: 'multi', name: 'm.txt', size: 6 }, root, 't');
  assert.equal(await uploads.chunk({ id: 'multi', offset: 0, data: b64('abc') }), 3);
  assert.equal(await uploads.chunk({ id: 'multi', offset: 3, data: b64('def') }), 6);
  const done = await uploads.finish('multi');
  assert.equal(fs.readFileSync(done.path, 'utf8'), 'abcdef');
});

test('Uploads sanitises hostile file names and never leaves the inbox', async () => {
  const root = gitProject('upload-names');
  const uploads = new core.Uploads();
  const names = ['../../etc/passwd', '..\\..\\win.ini', '/abs/path/evil.sh', 'a\nb;$(rm -rf).txt', '..', '', null, 'x'.repeat(500)];
  for (const [i, name] of names.entries()) {
    const done = await upload(uploads, root, `n${i}`, name, 'x');
    assert.equal(path.dirname(done.path), inboxOf(root), String(name));
    assert.match(path.basename(done.path), /^[0-9a-f-]{36}-[a-zA-Z0-9._ -]+$/);
    assert.ok(done.name.length <= 160);
  }
});

test('Uploads never overwrites: identical names get distinct files', async () => {
  const root = gitProject('upload-unique');
  const uploads = new core.Uploads();
  const a = await upload(uploads, root, 'one', 'same.txt', 'A');
  const b = await upload(uploads, root, 'two', 'same.txt', 'B');
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'A');
});

test('Uploads rejects invalid or duplicate upload identities', async () => {
  const root = gitProject('upload-ids');
  const uploads = new core.Uploads();
  for (const id of ['', 'a/b', '../x', 'a b', 'x'.repeat(81), 'é']) {
    await assert.rejects(uploads.start({ id, name: 'f', size: 1 }, root, 't'), /identity/, JSON.stringify(id));
  }
  await uploads.start({ id: 'dup', name: 'f', size: 1 }, root, 't');
  await assert.rejects(uploads.start({ id: 'dup', name: 'f', size: 1 }, root, 't'), /identity/);
  await uploads.close();
});

test('Uploads enforces the 200 MB size limit and integer sizes', async () => {
  const root = gitProject('upload-size');
  const uploads = new core.Uploads();
  const limit = 200 * 1024 * 1024;
  for (const size of [limit + 1, -1, 1.5, NaN, Infinity, '10', null, undefined]) {
    await assert.rejects(uploads.start({ id: 'big', name: 'f', size }, root, 't'), /200 MB/, String(size));
  }
  assert.equal(fs.existsSync(path.join(root, '.local')), false, 'rejected sizes must not touch the filesystem');
  await uploads.start({ id: 'exact', name: 'f', size: limit }, root, 't');
  await uploads.close();
});

test('Uploads refuses to store anything when .local is not git-ignored', async () => {
  const root = gitProject('upload-unignored', { ignoreLocal: false });
  const uploads = new core.Uploads();
  await assert.rejects(uploads.start({ id: 'x', name: 'f', size: 1 }, root, 't'));
  assert.equal(fs.existsSync(path.join(root, '.local')), false);
  assert.equal(uploads.active.size, 0);
});

test('Uploads checks ignore coverage through git with the inbox probe path', async () => {
  const calls = [];
  const root = tempDir('upload-injected');
  const uploads = new core.Uploads(async (cmd, args) => { calls.push([cmd, args]); throw new Error('not ignored'); });
  await assert.rejects(uploads.start({ id: 'x', name: 'f', size: 1 }, root, 't'), /Ignore \.local/);
  assert.equal(calls[0][0], 'git');
  assert.deepEqual(calls[0][1], ['-c', 'core.fsmonitor=false', '-C', root, 'check-ignore', '-q', '--', '.local/agent-glue/inbox/probe']);
  assert.equal(fs.existsSync(path.join(root, '.local')), false);
});

test('Uploads rejects a symlinked attachment folder', async () => {
  const base = tempDir('upload-symlink');
  const root = path.join(base, 'proj');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(root); fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(root, '.gitignore'), '.local\n');
  require('node:child_process').execFileSync('git', ['init', '-q', root]);
  fs.symlinkSync(elsewhere, path.join(root, '.local'));
  const uploads = new core.Uploads(async () => ({ stdout: '' })); // pretend git says ignored; the lstat guard must still fire
  await assert.rejects(uploads.start({ id: 'x', name: 'f', size: 1 }, root, 't'), /real directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('Uploads rejects a symlinked inbox leaf', async () => {
  const base = tempDir('upload-symlink-leaf');
  const root = path.join(base, 'proj');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(path.join(root, '.local/agent-glue'), { recursive: true }); fs.mkdirSync(elsewhere);
  require('node:child_process').execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), '.local/\n');
  fs.symlinkSync(elsewhere, path.join(root, '.local/agent-glue/inbox'));
  const uploads = new core.Uploads(async () => ({ stdout: '' })); // pretend git says ignored; the lstat guard must still fire
  await assert.rejects(uploads.start({ id: 'x', name: 'f', size: 1 }, root, 't'), /real directory/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('Uploads rejects malformed, out-of-order and oversized chunks', async () => {
  const root = gitProject('upload-chunk-errors');
  const uploads = new core.Uploads();
  await assert.rejects(uploads.chunk({ id: 'unknown', offset: 0, data: b64('a') }), /Invalid upload chunk/);
  await uploads.start({ id: 'c', name: 'f', size: 4 }, root, 't');
  await assert.rejects(uploads.chunk({ id: 'c', offset: 1, data: b64('a') }), /Invalid upload chunk/);
  await assert.rejects(uploads.chunk({ id: 'c', offset: 0, data: 'not base64!' }), /Invalid upload chunk/);
  await assert.rejects(uploads.chunk({ id: 'c', offset: 0, data: 'abc' }), /Invalid upload chunk/);
  await assert.rejects(uploads.chunk({ id: 'c', offset: 0, data: 42 }), /Invalid upload chunk/);
  await assert.rejects(uploads.chunk({ id: 'c', offset: 0, data: 'QQ=='.repeat(100001) }), /Invalid upload chunk/);
  await assert.rejects(uploads.chunk({ id: 'c', offset: 0, data: b64('12345') }), /exceeds announced size/);
  assert.equal(uploads.active.get('c').received, 0);
  await uploads.close();
});

test('Uploads.finish rejects incomplete uploads and unknown ids', async () => {
  const root = gitProject('upload-finish');
  const uploads = new core.Uploads();
  await assert.rejects(uploads.finish('nope'), /incomplete/);
  await uploads.start({ id: 'p', name: 'f', size: 4 }, root, 't');
  await uploads.chunk({ id: 'p', offset: 0, data: b64('ab') });
  await assert.rejects(uploads.finish('p'), /incomplete/);
  assert.ok(uploads.active.has('p'));
  await uploads.close();
  assert.equal(uploads.active.size, 0);
});

test('Uploads cannot continue a finished upload', async () => {
  const root = gitProject('upload-finished');
  const uploads = new core.Uploads();
  await upload(uploads, root, 'done', 'f', 'x');
  await assert.rejects(uploads.chunk({ id: 'done', offset: 1, data: b64('y') }), /Invalid upload chunk/);
});

test('Uploads with a real git rejects a symlinked .local before writing anything', async () => {
  const base = tempDir('upload-symlink-git');
  const root = path.join(base, 'proj');
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(root); fs.mkdirSync(elsewhere);
  require('node:child_process').execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), '.local\n');
  fs.symlinkSync(elsewhere, path.join(root, '.local'));
  await assert.rejects(new core.Uploads().start({ id: 'x', name: 'f', size: 1 }, root, 't'));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('Uploads.abort releases the handle, forgets the upload and tolerates unknown ids', async () => {
  const root = gitProject('upload-abort');
  const uploads = new core.Uploads();
  await uploads.start({ id: 'ab', name: 'f', size: 4 }, root, 't');
  await uploads.chunk({ id: 'ab', offset: 0, data: b64('ab') });
  await uploads.abort('ab');
  assert.equal(uploads.active.size, 0);
  await assert.rejects(uploads.chunk({ id: 'ab', offset: 2, data: b64('cd') }), /Invalid upload chunk/);
  await uploads.abort('ab');
  await uploads.abort('never-existed');
  // The identity can be reused for a fresh transfer after an abort.
  await uploads.start({ id: 'ab', name: 'f', size: 1 }, root, 't');
  await uploads.close();
});

test('paste cannot smuggle a bracketed-paste terminator', () => {
  const terminal = { show() {}, sendText() { throw new Error('should not send'); } };
  assert.throws(() => core.paste(terminal, { text: 'x\x1b[201~rm -rf ~\n' }), /control characters/);
});

test('Uploads limits concurrency to four transfers', async () => {
  const root = gitProject('upload-concurrency');
  const uploads = new core.Uploads();
  for (const id of ['u1', 'u2', 'u3', 'u4']) await uploads.start({ id, name: 'f', size: 1 }, root, 't');
  await assert.rejects(uploads.start({ id: 'u5', name: 'f', size: 1 }, root, 't'), /too many/);
  await uploads.abort('u1');
  await uploads.start({ id: 'u5', name: 'f', size: 1 }, root, 't');
  await uploads.close();
});

test('Uploads rejects concurrent starts that reuse an identity', async () => {
  const root = gitProject('upload-race');
  const uploads = new core.Uploads();
  const results = await Promise.allSettled([1, 2, 3].map(() => uploads.start({ id: 'same', name: 'f', size: 1 }, root, 't')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(uploads.active.size, 1);
  await uploads.close();
});

test('Uploads.expire aborts only idle uploads', async () => {
  const root = gitProject('upload-expire');
  const uploads = new core.Uploads();
  await uploads.start({ id: 'idle', name: 'f', size: 1 }, root, 't');
  await uploads.start({ id: 'fresh', name: 'f', size: 1 }, root, 't');
  uploads.active.get('idle').lastActivity = Date.now() - 121000;
  await uploads.expire();
  assert.deepEqual([...uploads.active.keys()], ['fresh']);
  await uploads.close();
});

test('Uploads verifies the final attachment filename is git-ignored too', async () => {
  const root = tempDir('upload-final-name');
  let calls = 0;
  const uploads = new core.Uploads(async () => { if (++calls === 2) throw new Error('nope'); return { stdout: '' }; });
  await assert.rejects(uploads.start({ id: 'x', name: 'f', size: 1 }, root, 't'), /not ignored/);
  assert.equal(uploads.active.size, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, '.local/agent-glue/inbox')), []);
});

test('reference discovery ignores raw web URLs and supports punctuation and bracketed paths with spaces',()=>{
 const found=core.references('See https://example.com/a.md and [plan](</project/my plan.md>). Then ./local.html!', '/project');
 assert.deepEqual(found.map(f=>f.path),['/project/my plan.md','/project/local.html']);
});
test('redrawing references keeps their order and preserves manual hide without mutating previous metadata',()=>{
 const old=[{id:'old',seen:1,pinned:false,manual:true,hidden:true},{id:'new',seen:2}];
 const snapshot=structuredClone(old);
 const next=core.observe(old,[{id:'old',pinned:true},{id:'new'}]);
 assert.deepEqual(old,snapshot);assert.deepEqual(next.map(f=>f.id),['new','old']);assert.equal(next[1].hidden,true);assert.equal(next[1].pinned,false);
});

test('bare relative directory references keep their directory rather than becoming absolute suffixes',()=>{
 assert.deepEqual(core.references('Wrote docs/plan.md and ./notes.html','/project').map(f=>f.path),['/project/docs/plan.md','/project/notes.html']);
});

test('recent files retain the newest 100 while pins survive the limit', () => {
  const pins=Array.from({length:25},(_,i)=>({id:`pin${i}`,pinned:true,seen:i}));
  const incoming=Array.from({length:130},(_,i)=>({id:`file${i}`}));
  const result=core.observe(pins,incoming);
  assert.equal(result.filter(f=>f.pinned).length,25);
  assert.equal(result.filter(f=>!f.pinned).length,100);
  assert.equal(result.find(f=>!f.pinned).id,'file129');
  assert.ok(!result.some(f=>f.id==='file0'));
});

test('agent markers pin, unpin, remove and restore without replaying old directives',()=>{
  let files=[];
  const apply=text=>{files=core.observe(files,core.references(text,'/workspace'));return files[0];};
  assert.equal(apply('[pin] ./review.md').pinned,true);
  files[0].pinned=false;files[0].manual=true;
  assert.equal(apply('[pin] ./review.md').pinned,false,'polling respects a user unpin');
  assert.equal(apply('[pin] ./review.md # next-review').pinned,true);
  assert.equal(apply('[unpin] ./review.md').pinned,false);
  assert.equal(apply('[remove] ./review.md').hidden,true);
  assert.equal(apply('See ./review.md').hidden,true,'ordinary references do not restore removed entries');
  assert.equal(apply('[share] ./review.md').hidden,false);
  assert.equal(apply('[pin] ./review.md').pinned,true);
  const output='[pin] ./review.md\n[remove] ./review.md\nSee ./review.md';
  assert.equal(apply(output).hidden,true,'latest directive survives ordinary references');
  assert.equal(apply(output).hidden,true,'polling is idempotent');
});

test('quoted agent marker paths and hidden entries do not consume recent capacity',()=>{
  const refs=core.references('[remove] "/workspace/my review.md"','/workspace');
  assert.equal(refs[0].path,'/workspace/my review.md');
  assert.equal(refs[0].action,'remove');
  const removed=core.observe([],refs);
  const result=core.observe(removed,Array.from({length:130},(_,i)=>({id:`file-${i}`})));
  assert.equal(result.filter(f=>!f.hidden).length,100);
  assert.ok(result.some(f=>f.hidden&&f.path==='/workspace/my review.md'));
});

 test('plain shared artifacts resolve against the session directory without pin notation',()=>{
   const names=['_script_outputs/demo_run/README.md','_script_outputs/demo_run/build_report.py','_script_outputs/demo_run/results.csv'];
   assert.deepEqual(core.references(names.join('\n'),'/session/project').map(f=>f.path),names.map(n=>'/session/project/'+n));
   assert.deepEqual(core.references('`script.py` [data](data.csv:12) \x1b[32m./chart.png\x1b[0m','/p').map(f=>f.path),['/p/script.py','/p/data.csv','/p/chart.png']);
 });

test('terminal matching uses unique exact titles when Sessions has no mapping',()=>{
 const sessions=[{id:'1',name:'demo-report-builder',sessionName:'codex-demo-report-builder-20261009_120000'},{id:'2',name:'Other',sessionName:'claude-other'}];
 assert.equal(core.sessionForTerminal({name:'demo-report-builder'},sessions)?.id,'1');
 assert.equal(core.sessionForTerminal({name:'demo-report-builder'},sessions,'claude-other')?.id,'2','API identity wins');
 assert.equal(core.sessionForTerminal({name:'trade'},sessions),undefined,'no fuzzy matching');
 assert.equal(core.sessionForTerminal({name:'demo-report-builder'},[...sessions,{...sessions[0],id:'3'}]),undefined,'ambiguous titles rejected');
 assert.equal(core.sessionForTerminal({name:'zsh'},sessions),undefined);
});
test('file discovery resolves project paths from nested terminal directories and prefers existing cwd files',async()=>{
 const root=tempDir('discover-nested');fs.mkdirSync(path.join(root,'src'));fs.mkdirSync(path.join(root,'_script_outputs'));
 fs.writeFileSync(path.join(root,'_script_outputs','view.html'),'synthetic');fs.writeFileSync(path.join(root,'same.csv'),'root');fs.writeFileSync(path.join(root,'src','same.csv'),'cwd');
 const absolute=path.join(root,'same.csv');
 const found=await core.discoverReferences('_script_outputs/view.html same.csv '+absolute,path.join(root,'src'),{projectRoot:async()=>root});
 assert.deepEqual(found.map(f=>f.path),[path.join(root,'_script_outputs/view.html'),path.join(root,'src','same.csv'),absolute]);
});


test('last repeated mention ranks first in recents',()=>{
  const result=core.observe([],core.references('docs/a.html\ndocs/b.md\ndocs/a.html','/synthetic'));
  assert.equal(result[0].path,'/synthetic/docs/a.html');
});

test('missing references do not evict existing recents and can reappear',()=>{
  const previous=[{id:'older',seen:1},...Array.from({length:100},(_,i)=>({id:'missing-'+i,seen:i+2,missing:true}))];
  const result=core.observe(previous,[{id:'newer'}]);
  assert.ok(result.some(file=>file.id==='older'));
  const restored=core.observe(result,[{id:'missing-0'}]);
  assert.equal(restored.find(file=>file.id==='missing-0').missing,false);
  assert.ok(restored.filter(file=>file.missing).length<=100);
});

test('ZIP downloads are discovered in plain, linked, quoted and bold references',async()=>{
  const root='/synthetic/project';
  const names=['bundle.zip','bundle.tar.gz','bundle.ZIP'];
  for(const name of names){
    const full=root+'/'+name;
    for(const text of [full,'**'+full+'**','*'+full+'*','[Download]('+full+')','`'+full+'`']){
      const found=await core.discoverReferences(text,root,{projectRoot:async()=>root,stat:async file=>{assert.equal(file,full);return {isFile:()=>true};}});
      assert.deepEqual(found.map(file=>file.path),[full],text);
      assert.equal(core.observe([],found).length,1);
    }
  }
});

test('hard-wrapped archive paths are reconstructed only when the joined file exists',async()=>{
 const full='/synthetic/project/.local/reports/runs/example-2026-10-17/package/AIPS_v3_Example_2026-10-17.zip';
 const chunks=[full.slice(0,45),full.slice(45,80),full.slice(80)];
 const opts={projectRoot:async()=>'/synthetic/project',stat:async file=>{if(file!==full)throw Error('missing');return {isFile:()=>true};}};
 const found=await core.discoverReferences('Download: '+chunks.join('\n  '),'/',opts);
 assert.deepEqual(found.map(f=>f.path),[full]);
 const missing=await core.discoverReferences(chunks.join('\n'),'/',{...opts,stat:async()=>{throw Error('missing');}});
 assert.deepEqual(missing,[]);
 const separate=await core.discoverReferences('/synthetic/a.zip\nother.zip','/synthetic',{projectRoot:async()=>'/synthetic',stat:async file=>({isFile:()=>['/synthetic/a.zip','/synthetic/other.zip','/synthetic/a.zipother.zip'].includes(file)})});
 assert.deepEqual(separate.map(f=>f.path),['/synthetic/a.zip','/synthetic/other.zip']);
});

 test('discovery retains modification time and observing again updates it independently of mention time',async()=>{
   const options={projectRoot:async()=>'/synthetic',stat:async()=>({isFile:()=>true,mtimeMs:1000})};
   const found=await core.discoverReferences('image.png','/synthetic',options);
   assert.equal(found[0].modified,1000);
   const previous=core.observe([],found);
   const next=core.observe(previous,[{...found[0],modified:2000}]);
   assert.equal(next[0].modified,2000);
   assert.equal(previous[0].modified,1000);
 });

test('unchanged captured links do not renew recency; new mentions and edits rank first',()=>{
 const text='First report\ndocs/a.md\nSecond report\ndocs/b.md';
 const first=core.observe([],core.references(text,'/synthetic'));
 const again=core.observe(first,core.references(text,'/synthetic'));
 assert.deepEqual(again.map(f=>[f.id,f.seen]),first.map(f=>[f.id,f.seen]));
 const mentioned=core.observe(again,core.references(text+'\nReview this again\ndocs/a.md','/synthetic'));
 assert.equal(mentioned[0].path,'/synthetic/docs/a.md');
 const updated=mentioned.map(f=>f.path.endsWith('b.md')?{...f,modified:mentioned[0].seen+1000}:f);
 const refreshed=core.observe(updated,core.references(text+'\nReview this again\ndocs/a.md','/synthetic'));
 assert.equal(refreshed[0].path,'/synthetic/docs/b.md');
});
