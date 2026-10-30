'use strict';
// Drives packages/companion/src/extension.cjs against a fake VS Code host. tmux
// access is replaced by stubs on the core module, so nothing here can touch a
// real agent terminal (scripts/test.cjs also blocks a real tmux on PATH).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { root: repoRoot, gitProject } = require('./support/tmp.cjs');

const companionDir = path.join(repoRoot, 'packages/companion');
const entry = path.join(companionDir, 'src/extension.cjs');
const manifest = JSON.parse(fs.readFileSync(path.join(companionDir, 'package.json'), 'utf8'));
const core = require(path.join(companionDir, 'src/core.cjs'));

let currentVscode;
const originalLoad = Module._load;
// The host captures `vscode` once at load, so hand it a proxy onto the per-test fake.
const vscodeProxy = new Proxy({}, { get: (_, key) => currentVscode[key] });
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeProxy : originalLoad.call(this, request, ...rest); };
const extension = require(entry);

function memento(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: (k, d) => (data.has(k) ? data.get(k) : d), update: async (k, v) => { v === undefined ? data.delete(k) : data.set(k, v); } };
}

function fakeHost({ trusted = true, sessionsApi, globalSettings = {} } = {}) {
  const log = { commands: new Map(), providers: new Map(), errors: [], clipboard: [], settings: [], executed: [], panels: [] };
  const settings = { ...globalSettings };
  const config = section => ({
    inspect: key => ({ globalValue: settings[`${section}.${key}`] }),
    update: async (key, value) => { log.settings.push([`${section}.${key}`, value]); if (value === undefined) delete settings[`${section}.${key}`]; else settings[`${section}.${key}`] = value; },
  });
  const vscode = {
    ViewColumn: { Beside: -2, One: 1, Active: -1 },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: fsPath => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
    workspace: { isTrusted: trusted, getConfiguration: config },
    extensions: { getExtension: id => (id === 'knotwerk.agent-glue-sessions' && sessionsApi ? { activate: async () => sessionsApi } : undefined) },
    env: { clipboard: { writeText: async t => log.clipboard.push(t) } },
    commands: { getCommands:async()=>[], registerCommand: (id, fn) => { log.commands.set(id, fn); return { dispose() {} }; }, executeCommand: async (...a) => { log.executed.push(a); } },
    window: {
      activeTerminal: undefined,
      onDidChangeActiveTerminal: fn => { log.activeTerminalChanged=fn; return { dispose() {} }; },
      registerWebviewViewProvider: (id, provider) => { log.providers.set(id, provider); return { dispose() {} }; },
      showErrorMessage: m => log.errors.push(m),
      showInformationMessage: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => {},
      createWebviewPanel: (type, title, col, options) => {
        const panel = fakeWebview(options);
        const webview=panel.webview;
        let disposed=false;
        Object.defineProperty(panel,'webview',{get(){if(disposed)throw new Error('Webview is disposed');return webview;}});
        panel.viewType = type; panel.column=col;
        panel.reveal = () => {if(disposed)throw new Error('Webview is disposed');};
        panel.onDidDispose = fn => { panel.closed=fn; return { dispose() {} }; };
        panel.dispose = () => {if(disposed)return;disposed=true;panel.closed?.();};
        log.panels.push(panel);
        return panel;
      },
    },
  };
  return { vscode, log, settings };
}

function fakeWebview(options = {}) {
  const posted = [];
  let handler;
  const view = {
    visible: true, posted, options,
    webview: null,
    onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
  };
  const webview = {
    options, html: '', cspSource: 'vscode-resource:', posted,
    asWebviewUri: uri => `webview:${uri.fsPath}`,
    postMessage: async m => { posted.push(m); return true; },
    onDidReceiveMessage: h => { handler = h; return { dispose() {} }; },
    send: message => handler(message),
  };
  view.webview = webview;
  Object.assign(view, { send: webview.send, postMessage: webview.postMessage });
  // The panel API exposes webview members through `.webview`.
  return view;
}

async function waitFor(view, predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = view.webview.posted.find(predicate);
    if (found) return found;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}; saw ${JSON.stringify(view.webview.posted.map(m => m.type))}`);
}
const lastState = view => [...view.webview.posted].reverse().find(m => m.type === 'state')?.state;
async function settle(view, ms = 60) { await new Promise(r => setTimeout(r, ms)); return lastState(view); }

function session(cwd, over = {}) {
  return { id: '$1', name: 'Fix bug', sessionName: 'claude-main', pane: '%1', cwd, profile: 'claude', available: true, ...over };
}

async function start(t, { sessions, capture = 'Wrote docs/plan.md and ./notes.html\n', sessionsApi, host } = {}) {
  const project = gitProject('host');
  fs.mkdirSync(path.join(project,'docs'));
  fs.writeFileSync(path.join(project,'docs/plan.md'),'# Plan');
  fs.writeFileSync(path.join(project,'notes.html'),'<p>Notes</p>');
  const h = host || fakeHost({ sessionsApi });
  currentVscode = h.vscode;
  const calls = [];
  const saved = { sessions: core.sessions, run: core.run };
  core.sessions = async () => (sessions ? sessions(project) : [session(project)]);
  core.run = async (cmd, args) => { calls.push([cmd, args]); return { stdout: capture }; };
  const context = { globalStorageUri:{fsPath:path.join(project,'.status-storage')}, subscriptions: [], workspaceState: memento(), globalState: memento(), extensionUri: { fsPath: companionDir }, extensionPath: companionDir };
  extension.activate(context);
  t.after(async () => { for (const s of context.subscriptions) await s.dispose?.(); core.sessions = saved.sessions; core.run = saved.run; });
  return { ...h, project, context, calls };
}

async function openSidebar(env) {
  const view = fakeWebview();
  env.log.providers.get('agentGlue.companion').resolveWebviewView(view);
  view.webview.send({ type: 'ready' });
  await waitFor(view, m => m.type === 'state' && m.state.sessions.length > 0, 'initial state');
  return view;
}

test('activate registers every contributed command and the view provider', async t => {
  const env = await start(t);
  const contributed = manifest.contributes.commands.map(c => c.command).sort();
  assert.deepEqual([...env.log.commands.keys()].sort(), contributed);
  assert.ok(env.log.providers.has(manifest.contributes.views.agentGlue[0].id));
  assert.ok(manifest.activationEvents.includes('onStartupFinished'));
  assert.deepEqual(env.log.executed.filter(c=>c[0]!=='setContext'), [['agentGlue.companion.focus', { preserveFocus: true }]]);
});

test('activate does nothing in an untrusted workspace', async t => {
  const env = await start(t, { host: fakeHost({ trusted: false }) });
  assert.equal(env.log.commands.size, 0);
  assert.equal(env.log.providers.size, 0);
  assert.deepEqual(env.log.executed, []);
});

test('sidebar webview is locked to the media folder with a nonce CSP', async t => {
  const env = await start(t);
  const view = await openSidebar(env);
  assert.deepEqual(view.webview.options.localResourceRoots.map(u => u.fsPath), [path.join(companionDir, 'media')]);
  assert.equal(view.webview.options.enableScripts, true);
  const html = view.webview.html;
  const nonce = /script-src &#39;nonce-([0-9a-f]+)&#39;/.exec(html)[1];
  assert.ok(nonce.length >= 32);
  assert.ok(html.includes(`<script nonce="${nonce}"`));
  const scriptSrc = /script-src ([^;]*);/.exec(html.match(/Content-Security-Policy" content="[^"]+"/)[0].replace(/&#39;/g, "'"))[1];
  assert.equal(scriptSrc, `'nonce-${nonce}'`);
});

test('only the selected pane is captured, read-only, and only while the view is visible', async t => {
  const env = await start(t, { sessions: p => [session(p), session(p, { id: '$2', sessionName: 'codex-b', pane: '%2' })] });
  const view = await openSidebar(env);
  const captures = env.calls.filter(([, args]) => args[0] === 'capture-pane');
  assert.ok(captures.length >= 1);
  for (const [cmd, args] of captures) {
    assert.equal(cmd, 'tmux');
    assert.ok(['capture-pane'].includes(args[0]), `unexpected tmux call ${args[0]}`);
    assert.ok(!args.includes('send-keys'));
    assert.equal(args[args.indexOf('-t') + 1], '%1');
  }
  const state = lastState(view);
  assert.deepEqual(state.files.map(f => f.label).sort(), ['notes.html', 'plan.md']);
  // Hidden view: a refresh must not capture anything new.
  view.visible = false;
  const before = env.calls.length;
  view.webview.send({ type: 'refresh' });
  await settle(view);
  assert.equal(env.calls.length, before);
});

test('malformed webview messages are ignored', async t => {
  const env = await start(t);
  const view = await openSidebar(env);
  for (const message of [null, undefined, {}, { type: 5 }, { type: 'nonsense' }, { type: 'editDraft', text: 42 }]) view.webview.send(message);
  await settle(view);
  assert.equal(lastState(view).draft.text, '');
  assert.deepEqual(env.log.errors, []);
});

test('uploads flow through the host into the ignored inbox and join the draft', async t => {
  const env = await start(t);
  const view = await openSidebar(env);
  const data = Buffer.from('synthetic attachment');
  view.webview.send({ type: 'uploadStart', id: 'up-1', name: '../shot.png', size: data.length, mime: 'image/png' });
  await waitFor(view, m => m.type === 'uploadReady' && m.id === 'up-1', 'uploadReady');
  view.webview.send({ type: 'uploadChunk', id: 'up-1', offset: 0, data: data.toString('base64') });
  const ack = await waitFor(view, m => m.type === 'uploadAck', 'uploadAck');
  assert.equal(ack.received, data.length);
  view.webview.send({ type: 'uploadFinish', id: 'up-1' });
  await waitFor(view, m => m.type === 'uploadComplete', 'uploadComplete');
  const [attachment] = lastState(view).draft.attachments;
  assert.equal(path.dirname(attachment.path), path.join(env.project, '.local/agent-glue/inbox'));
  assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'synthetic attachment');
  assert.equal(attachment.handle, undefined);
});

test('upload failures report an error and release the transfer', async t => {
  const env = await start(t);
  const view = await openSidebar(env);
  view.webview.send({ type: 'uploadStart', id: 'bad-1', name: 'f', size: 3 });
  await waitFor(view, m => m.type === 'uploadReady', 'uploadReady');
  view.webview.send({ type: 'uploadChunk', id: 'bad-1', offset: 5, data: 'AAAA' });
  const error = await waitFor(view, m => m.type === 'uploadError' && m.id === 'bad-1', 'uploadError');
  assert.match(error.error, /Invalid upload chunk/);
  // The identity is free again, so a retry may start.
  view.webview.send({ type: 'uploadStart', id: 'bad-1', name: 'f', size: 3 });
  await waitFor(view, () => view.webview.posted.filter(x => x.type === 'uploadReady').length === 2, 'second uploadReady');
  view.webview.send({ type: 'uploadStart', id: 'huge', name: 'f', size: 200 * 1024 * 1024 + 1 });
  assert.match((await waitFor(view, m => m.type === 'uploadError' && m.id === 'huge', 'size error')).error, /200 MB/);
});

test('uploads are refused when the project does not ignore .local', async t => {
  const env = await start(t);
  fs.writeFileSync(path.join(env.project, '.gitignore'), '');
  const view = await openSidebar(env);
  view.webview.send({ type: 'uploadStart', id: 'x-1', name: 'f', size: 1 });
  const error = await waitFor(view, m => m.type === 'uploadError', 'uploadError');
  assert.match(error.error, /Ignore \.local/);
  assert.equal(fs.existsSync(path.join(env.project, '.local')), false);
});

test('changing the recipient is refused during an upload', async t => {
  const env = await start(t, { sessions: p => [session(p), session(p, { id: '$2', sessionName: 'codex-b', pane: '%2' })] });
  const view = await openSidebar(env);
  view.webview.send({ type: 'uploadStart', id: 'hold-1', name: 'f', size: 5 });
  await waitFor(view, m => m.type === 'uploadReady', 'uploadReady');
  view.webview.send({ type: 'changeTarget', targetId: '$2' });
  await settle(view);
  assert.match(lastState(view).status, /Wait for the current upload/);
  assert.equal(lastState(view).draft.targetId, '$1');
});

test('paste sends bracketed text without Enter to the draft target terminal', async t => {
  const terminal = { shown: 0, sent: [], show() { this.shown++; }, sendText(text, newline) { this.sent.push([text, newline]); } };
  const api = { terminalForSession: name => (name === 'claude-main' ? terminal : undefined), sessionForTerminal: () => undefined, refresh: async () => {} };
  const env = await start(t, { sessionsApi: api });
  const view = await openSidebar(env);
  view.webview.send({ type: 'pasteDraft', text: 'hello agent' });
  await waitFor(view, m => m.type === 'state' && /Draft pasted/.test(m.state.status), 'paste status');
  assert.equal(terminal.shown, 1);
  assert.deepEqual(terminal.sent, [['\x1b[200~hello agent\x1b[201~', false]]);
  assert.match(lastState(view).status, /Press Enter/);
});

test('paste refuses control characters and keeps the draft', async t => {
  const terminal = { show() { throw new Error('must not show'); }, sendText() { throw new Error('must not send'); } };
  const api = { terminalForSession: () => terminal, sessionForTerminal: () => undefined, refresh: async () => {} };
  const env = await start(t, { sessionsApi: api });
  const view = await openSidebar(env);
  view.webview.send({ type: 'pasteDraft', text: 'rm -rf /\r' });
  await waitFor(view, m => m.type === 'state' && /control characters/.test(m.state.status), 'refusal');
  assert.equal(lastState(view).draft.text, 'rm -rf /\r', 'draft preserved');
});

test('paste without the Sessions extension explains itself and Copy still works', async t => {
  const env = await start(t);
  const view = await openSidebar(env);
  view.webview.send({ type: 'pasteDraft', text: 'note' });
  await waitFor(view, m => m.type === 'state' && /Enable Agent Glue Sessions/.test(m.state.status), 'status');
  view.webview.send({ type: 'copyDraft', text: 'note' });
  await waitFor(view, m => m.type === 'state' && m.state.status === 'Draft copied.', 'copied');
  assert.deepEqual(env.log.clipboard, ['note']);
});

test('paste to a closed agent fails safely', async t => {
  let live = true;
  const api = { terminalForSession: () => ({ show() {}, sendText() { throw new Error('must not send'); } }), sessionForTerminal: () => undefined, refresh: async () => {} };
  const env = await start(t, { sessionsApi: api, sessions: p => (live ? [session(p)] : []) });
  const view = await openSidebar(env);
  live = false;
  view.webview.send({ type: 'pasteDraft', text: 'x' });
  await waitFor(view, m => m.type === 'state' && /closed/.test(m.state.status), 'closed status');
});

test('layout toggles the sidebar and terminal tabs, then restores the previous values', async t => {
  const env = await start(t, { host: fakeHost({ globalSettings: { 'workbench.sideBar.location': 'left', 'terminal.integrated.tabs.enabled': true } }) });
  await env.log.commands.get('agentGlue.layout')();
  assert.equal(env.settings['workbench.sideBar.location'], 'right');
  assert.equal(env.settings['terminal.integrated.tabs.enabled'], false);
  await env.log.commands.get('agentGlue.layout')();
  assert.equal(env.settings['workbench.sideBar.location'], 'left');
  assert.equal(env.settings['terminal.integrated.tabs.enabled'], true);
  assert.deepEqual(env.log.executed.at(-1), ['workbench.view.extension.agentGlue']);
});

test('preview command surfaces errors instead of throwing', async t => {
  const env = await start(t);
  await env.log.commands.get('agentGlue.preview')({ fsPath: path.join(env.project, 'missing.md') });
  assert.equal(env.log.errors.length, 1);
});

test('initial ready waits for slow project discovery before offering uploads', async t => {
  const original=core.project;
  core.project=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,100));return original(...args);};
  t.after(()=>{core.project=original;});
  const env=await start(t);
  const view=await openSidebar(env);
  assert.equal(lastState(view).draft.root,env.project);
  view.webview.send({type:'uploadStart',id:'slow-project',name:'ready.txt',size:0});
  await waitFor(view,m=>m.type==='uploadReady'&&m.id==='slow-project','uploadReady after project discovery');
  assert.ok(!view.webview.posted.some(m=>m.type==='uploadError'));
});


test('clear keeps pins and switching native terminals refills recent files', async t => {
  const link={sessionForTerminal:terminal=>terminal?.sessionName,refresh:async()=>{}};
  const env=await start(t,{sessionsApi:link,sessions:root=>[session(root),session(root,{id:'$2',sessionName:'codex-other',name:'Other'})]});
  env.vscode.window.activeTerminal={sessionName:'claude-main'};
  const view=await openSidebar(env);
  const first=lastState(view).files[0];
  await view.webview.send({type:'fileAction',id:first.id,action:'pin'});
  await view.webview.send({type:'clearFiles'});
  assert.equal(lastState(view).files.length,1);
  assert.equal(lastState(view).files[0].pinned,true);
  await view.webview.send({type:'ready'});
  assert.equal(lastState(view).files.length,1,'polling must not undo Clear');
  env.vscode.window.activeTerminal={sessionName:'codex-other'};
  env.log.activeTerminalChanged();await waitFor(view,()=>lastState(view).selectedSessionId==='$2'&&lastState(view).files.length===2,'other session files');
  assert.equal(lastState(view).selectedSessionId,'$2');
  env.vscode.window.activeTerminal={sessionName:'claude-main'};
  env.log.activeTerminalChanged();await waitFor(view,()=>lastState(view).selectedSessionId==='$1'&&lastState(view).files.length===2,'restored session files');
  assert.equal(lastState(view).selectedSessionId,'$1');
  assert.equal(lastState(view).files.length,2);
  assert.ok(lastState(view).files.find(file=>file.id===first.id).pinned);
  env.vscode.window.activeTerminal={sessionName:'ordinary-shell'};
  env.log.activeTerminalChanged();await waitFor(view,()=>lastState(view).files.length===0,'unmapped terminal clears files');
  assert.equal(lastState(view).files.length,0);
});


test('expanded draft reopens after close without moving or disposing its webview', async t => {
  const env=await start(t);
  await env.log.commands.get('agentGlue.draft')();
  const first=env.log.panels[0];
  assert.equal(first.column,-1);
  await env.log.commands.get('agentGlue.draft')();
  assert.equal(env.log.panels.length,1);
  assert.equal(env.log.executed.filter(call=>call[0]==='workbench.action.moveEditorToNewWindow').length,0);
  first.dispose();
  await env.log.commands.get('agentGlue.draft')();
  assert.equal(env.log.panels.length,2);
  assert.notEqual(env.log.panels[1],first);
  assert.deepEqual(env.log.errors,[]);
});


test('missing documents are hidden, including pins, and reappear when available',async t=>{
  const env=await start(t,{capture:'docs/plan.md\n[pin] ./missing.md'});
  const view=await openSidebar(env);
  assert.deepEqual(lastState(view).files.map(f=>f.label),['plan.md']);
  fs.writeFileSync(path.join(env.project,'missing.md'),'# Now available');
  view.webview.send({type:'refresh'});await settle(view);
  assert.ok(lastState(view).files.some(f=>f.label==='missing.md'&&f.pinned));
});


test('pinned descriptions persist through refresh and support cancel, edit and clear',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  const id=lastState(view).files[0].id;
  view.webview.send({type:'fileAction',id,action:'pin'});await settle(view);
  env.vscode.window.showInputBox=async()=> ' Screenshot review notes ';
  view.webview.send({type:'fileAction',id,action:'describe'});await settle(view);
  view.webview.send({type:'refresh'});await settle(view);
  assert.equal(lastState(view).files.find(f=>f.id===id).description,'Screenshot review notes');
  env.vscode.window.showInputBox=async()=>undefined;
  view.webview.send({type:'fileAction',id,action:'describe'});await settle(view);
  assert.equal(lastState(view).files.find(f=>f.id===id).description,'Screenshot review notes');
  env.vscode.window.showInputBox=async()=>'';
  view.webview.send({type:'fileAction',id,action:'describe'});await settle(view);
  assert.equal(lastState(view).files.find(f=>f.id===id).description,'');
  assert.equal(lastState(view).files.find(f=>f.id===id).pinned,true);
});

test('sidebar expand and microphone messages reopen after repeated closes without losing notes',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  view.webview.send({type:'editDraft',text:'Keep this draft'});await settle(view);
  for(let i=0;i<3;i++){
    view.webview.send({type:'openDraft'});await settle(view);
    const panel=env.log.panels.at(-1);
    panel.webview.send({type:'ready'});await settle(view);
    assert.equal(lastState(view).draft.text,'Keep this draft');
    assert.doesNotThrow(()=>panel.dispose());
  }
  assert.equal(env.log.panels.length,3);
  assert.ok(!lastState(view).status.includes('disposed'));
  assert.deepEqual(env.log.errors,[]);
});



test('one microphone click installs, activates and refocuses before dictating',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  let installed=false;const original=env.vscode.commands.executeCommand;
  env.vscode.commands.executeCommand=async(name,...args)=>{
    if(name==='agentGlueMac.status'){if(!installed)throw new Error('command agentGlueMac.status not found');return {platform:'darwin'};}
    if(name==='workbench.extensions.installExtension')installed=true;
    return original(name,...args);
  };
  view.webview.send({type:'dictate'});await settle(view);
  const ready=view.webview.posted.find(m=>m.type==='dictationReady');assert.ok(ready);
  assert.ok(!env.log.executed.some(call=>call[0]==='agentGlueMac.startDictation'),'wait for webview focus');
  view.webview.send({type:'startDictation',id:ready.id});await settle(view);
  assert.equal(env.log.executed.filter(call=>call[0]==='agentGlueMac.startDictation').length,1);
  view.webview.send({type:'startDictation',id:ready.id});await settle(view);
  assert.equal(env.log.executed.filter(call=>call[0]==='agentGlueMac.startDictation').length,1,'ignore duplicate acknowledgments');
  assert.equal(env.log.panels.length,0);
  assert.doesNotMatch(lastState(view).status,/Mac helper installed/);
});

test('setup errors survive refresh and a later click retries installation',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  const original=env.vscode.commands.executeCommand;let attempts=0,installed=false;
  env.vscode.commands.executeCommand=async(name,...args)=>{
    if(name==='agentGlueMac.status')return installed?{platform:'darwin'}:undefined;
    if(name==='workbench.extensions.installExtension'){if(++attempts===1)throw new Error('Installation declined');installed=true;}
    return original(name,...args);
  };
  view.webview.send({type:'ready',clientPlatform:'mac'});await settle(view);
  assert.match(lastState(view).status,/Installation declined/);
  view.webview.send({type:'refresh'});await settle(view);
  assert.match(lastState(view).status,/Installation declined/);
  view.webview.send({type:'dictate'});await settle(view);
  assert.equal(attempts,2);
  assert.ok(view.webview.posted.some(m=>m.type==='dictationReady'));
  view.webview.send({type:'ready',clientPlatform:'mac'});await settle(view);
  assert.equal(attempts,2);
});

test('installer success without activation never claims dictation is ready',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  await view.webview.send({type:'dictate'});
  assert.match(lastState(view).status,/Reload Window to activate/);
  assert.ok(!view.webview.posted.some(m=>m.type==='dictationReady'));
  env.vscode.commands.executeCommand=async name=>name==='agentGlueMac.status'?{platform:'linux'}:undefined;
  view.webview.send({type:'dictate'});await settle(view);
  assert.match(lastState(view).status,/wrong host/);
});


test('Dictate Note shortcut reveals the sidebar and requests focused dictation',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  await env.log.commands.get('agentGlue.dictate')();
  assert.ok(view.webview.posted.some(m=>m.type==='requestDictation'));
  assert.equal(env.log.executed.at(-1)[0],'agentGlue.companion.focus');
  assert.ok(manifest.contributes.keybindings.some(b=>b.command==='agentGlue.dictate'&&b.mac==='ctrl+alt+d'));
});

test('explicit native clipboard action transfers Mac image into the remote inbox',async t=>{
  const env=await start(t);
  const view=await openSidebar(env);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const calls=[];
  env.vscode.commands.executeCommand=async name=>{
    calls.push(name);
    if(name==='agentGlueMac.status')return {platform:'darwin',clipboardImage:true};
    if(name==='agentGlueMac.readClipboardImage')return {data:png.toString('base64')};
  };
  assert.ok(!calls.includes('agentGlueMac.readClipboardImage'));
  view.webview.send({type:'pasteClipboardImage'});
  await waitFor(view,m=>m.type==='state'&&m.state.draft.attachments.length===1,'native clipboard attachment');
  const [attachment]=lastState(view).draft.attachments;
  assert.equal(path.dirname(attachment.path),path.join(env.project,'.local/agent-glue/inbox'));
  assert.deepEqual(fs.readFileSync(attachment.path),png);
  assert.equal(calls.filter(c=>c==='agentGlueMac.readClipboardImage').length,1);
});

test('old local helper must upgrade before clipboard access, and empty clipboard error persists',async t=>{
  const env=await start(t);const view=await openSidebar(env);let upgraded=false;
  env.vscode.commands.executeCommand=async name=>{
    if(name==='agentGlueMac.status')return {platform:'darwin',clipboardImage:upgraded};
    if(name==='workbench.extensions.installExtension'){upgraded=true;return;}
    if(name==='agentGlueMac.readClipboardImage')throw new Error('No image in the Mac clipboard');
  };
  view.webview.send({type:'pasteClipboardImage'});
  await waitFor(view,m=>m.type==='state'&&/No image/.test(m.state.status),'persistent clipboard error');
  assert.equal(upgraded,true);assert.equal(lastState(view).draft.attachments.length,0);
});

test('Note follows native terminal selection and preserves text and attachments',async t=>{
  const link={sessionForTerminal:terminal=>terminal?.sessionName,refresh:async()=>{}};
  const env=await start(t,{sessionsApi:link,sessions:root=>[session(root),session(root,{id:'$2',sessionName:'codex-other',name:'WikiOfBrands'})]});
  env.vscode.window.activeTerminal={sessionName:'claude-main'};
  const view=await openSidebar(env);
  view.webview.send({type:'editDraft',text:'Keep this note'});await settle(view);
  env.vscode.window.activeTerminal={sessionName:'codex-other'};
  env.log.activeTerminalChanged();await settle(view);
  assert.equal(lastState(view).draft.targetId,'$2');
  assert.equal(lastState(view).draft.targetName,'WikiOfBrands');
  assert.equal(lastState(view).draft.text,'Keep this note');
  view.webview.send({type:'refresh'});await settle(view);
  assert.equal(lastState(view).draft.targetId,'$2','polling must not reset recipient');
});

test('removing screenshot detaches it without deleting its file or text',async t=>{
  const env=await start(t);const view=await openSidebar(env);
  view.webview.send({type:'editDraft',text:'Keep text'});
  view.webview.send({type:'uploadStart',id:'remove-shot',name:'shot.png',size:3});
  await waitFor(view,m=>m.type==='uploadReady','ready');
  view.webview.send({type:'uploadChunk',id:'remove-shot',offset:0,data:Buffer.from('png').toString('base64')});
  await waitFor(view,m=>m.type==='uploadAck','chunk');
  view.webview.send({type:'uploadFinish',id:'remove-shot'});
  await waitFor(view,m=>m.type==='uploadComplete','complete');
  const file=lastState(view).draft.attachments[0].path;
  view.webview.send({type:'removeAttachment',path:file});await settle(view);
  assert.equal(lastState(view).draft.attachments.length,0);
  assert.equal(lastState(view).draft.text,'Keep text');
  assert.equal(fs.readFileSync(file,'utf8'),'png');
});

test('resource tabs follow terminal project and ignore stale query responses',async t=>{
  const resources=require('../packages/companion/src/resources.cjs');const original=resources.list;
  t.after(()=>{resources.list=original;});
  const pending=[];resources.list=(kind,cwd,options)=>new Promise(resolve=>pending.push({kind,cwd,options,resolve}));
  const link={sessionForTerminal:terminal=>terminal?.sessionName,refresh:async()=>{}};
  const env=await start(t,{sessionsApi:link,sessions:root=>[session(root),session(root,{id:'$2',sessionName:'codex-other',cwd:root+'/docs'})]});
  env.vscode.window.activeTerminal={sessionName:'claude-main'};const view=await openSidebar(env);
  view.webview.send({type:'resourceTab',tab:'prs'});await settle(view);
  assert.equal(pending.length,1);assert.equal(pending[0].cwd,env.project);
  env.vscode.window.activeTerminal={sessionName:'codex-other'};env.log.activeTerminalChanged();await settle(view);
  assert.equal(pending.length,2);assert.equal(pending[1].cwd,env.project+'/docs');
  pending[1].resolve({root:env.project,items:[{id:'new',label:'Right project'}]});await settle(view);
  pending[0].resolve({root:env.project,items:[{id:'old',label:'Wrong project'}]});await settle(view);
  assert.equal(lastState(view).resourceItems[0].id,'new');
  view.webview.send({type:'prFilter',filter:'mine'});await settle(view);
  assert.equal(pending[2].options.filter,'mine');
  view.webview.send({type:'resourceTab',tab:'files'});await settle(view);
  pending[2].resolve({root:env.project,items:[{id:'late'}]});await settle(view);
  assert.equal(lastState(view).resourceTab,'files');assert.equal(lastState(view).resourceItems.length,0);
});

test('native view title commands switch resource tabs and expose file actions in overflow',async t=>{
  const resources=require('../packages/companion/src/resources.cjs');const original=resources.list;
  resources.list=async()=>({root:'/synthetic',items:[]});t.after(()=>{resources.list=original;});
  const env=await start(t);const view=await openSidebar(env);
  const menu=manifest.contributes.menus['view/title'];
  assert.deepEqual(menu.filter(m=>m.group.startsWith('navigation')).map(m=>m.command),['agentGlue.showfiles','agentGlue.showprs','agentGlue.refreshResources','agentGlue.showtasks']);
  for(const tab of ['prs','files']){
    assert.ok(menu.some(m=>m.command==='agentGlue.show'+tab&&m.group.startsWith('navigation')));
    await env.log.commands.get('agentGlue.show'+tab)();await settle(view);
    assert.equal(lastState(view).resourceTab,tab);
    assert.ok(env.log.executed.some(c=>c[0]==='setContext'&&c[1]==='agentGlue.resourceTab'&&c[2]===tab));
  }
  assert.ok(menu.some(m=>m.command==='agentGlue.clearFiles'&&m.group==='fileActions@2'));
  assert.ok(!view.webview.html.includes('id="tab-files"'));
});

test('PR expand tree opens only its registered review files, including screenshots',async t=>{
  const resources=require('../packages/companion/src/resources.cjs');const original=resources.list;t.after(()=>{resources.list=original;});
  const env=await start(t);const view=await openSidebar(env);const image=path.join(env.project,'shot.png');fs.writeFileSync(image,'fixture');
  resources.list=async()=>({root:env.project,items:[{id:'local:pilot',title:'Pilot',label:'Pilot',local:true,documents:[{path:image,root:env.project,label:'Screenshot',image:true}]}]});
  env.vscode.Uri.file=fsPath=>({fsPath});
  view.webview.send({type:'resourceTab',tab:'prs'});await settle(view);
  view.webview.send({type:'expandResource',id:'local:pilot'});await settle(view);
  assert.equal(lastState(view).resourceItems[0].reviewDocuments[0].path,image);
  view.webview.send({type:'openReviewFile',id:'local:pilot',index:0});await settle(view);
  assert.ok(env.log.executed.some(c=>c[0]==='vscode.open'&&c[1].fsPath===image&&c[2]===1));
  const before=env.log.executed.length;
  view.webview.send({type:'openReviewFile',id:'local:pilot',index:99});await settle(view);
  assert.equal(env.log.executed.length,before);
});

test('Discuss with agent uses the current terminal and trusted draft reference without submitting or changing the note',async t=>{
  const resources=require('../packages/companion/src/resources.cjs'),original=resources.list;
  t.after(()=>{resources.list=original;});
  const sent=[],shown=[];
  const terminals=Object.fromEntries(['claude-main','codex-other'].map(name=>[name,{sessionName:name,show:()=>shown.push(name),sendText:(...args)=>sent.push([name,...args])}]));
  let available=true;
  const api={refresh:async()=>{},sessionForTerminal:t=>t?.sessionName,terminalForSession:name=>terminals[name]};
  const env=await start(t,{sessions:cwd=>available?[session(cwd),session(cwd,{id:'$2',sessionName:'codex-other',name:'Other agent'})]:[],sessionsApi:api});
  env.vscode.window.activeTerminal=terminals['claude-main'];
  const view=await openSidebar(env),bodyFile=path.join(env.project,'docs/plan.md');
  resources.list=async()=>({root:env.project,items:[{id:'local:pilot',title:'Decision: Review layout',local:true,bodyFile,documents:[{root:env.project,path:bodyFile,preview:true}]}]});
  view.webview.send({type:'resourceTab',tab:'prs'});await settle(view);
  view.webview.send({type:'openResource',id:'local:pilot'});await settle(view);
  const panel=env.log.panels.find(p=>p.viewType==='agentGlue.pullRequest');assert.ok(panel);
  assert.match(panel.webview.html,/id="discuss"/);
  view.webview.send({type:'editDraft',text:'Keep my existing note'});await settle(view);
  env.vscode.window.activeTerminal=terminals['codex-other'];
  const note=lastState(view).draft.text;
  await panel.webview.send({type:'discuss',text:'untrusted replacement',url:'https://wrong.invalid'});
  assert.deepEqual(sent,[['codex-other','\x1b[200~Regarding prepared draft Decision: Review layout ('+bodyFile+'): \x1b[201~',false]]);
  assert.deepEqual(shown,['codex-other']);assert.equal(lastState(view).draft.text,note);
  api.refresh=async()=>{env.vscode.window.activeTerminal=terminals['claude-main'];};
  await panel.webview.send({type:'discuss'});
  assert.equal(sent.length,1);assert.match(env.log.errors.at(-1),/selected terminal changed/);
  available=false;
  await panel.webview.send({type:'discuss'});
  assert.equal(sent.length,1);assert.match(env.log.errors.at(-1),/Select an attached agent terminal/);
});

test('recent source files open from the selected session outside the workspace; unknown IDs are ignored',async t=>{
  const env=await start(t,{capture:'_script_outputs/result.csv\n_script_outputs/helper.py'});
  fs.mkdirSync(path.join(env.project,'_script_outputs'));
  for(const name of ['result.csv','helper.py'])fs.writeFileSync(path.join(env.project,'_script_outputs',name),'fixture');
  const view=await openSidebar(env);await settle(view);
  const files=lastState(view).files;assert.equal(files.length,2);
  await view.webview.send({type:'previewFile',id:files[0].id});await settle(view);
  assert.ok(env.log.executed.some(([cmd,uri])=>cmd==='vscode.open'&&uri.fsPath===files[0].path));
  const count=env.log.executed.length;
  await view.webview.send({type:'previewFile',id:'/unlisted/file.py'});
  assert.equal(env.log.executed.length,count);
  env.vscode.window.showQuickPick=async()=> 'Copy path';
  await view.webview.send({type:'fileMenu',id:files[0].id});await settle(view);
  assert.equal(env.log.clipboard.at(-1),files[0].path);
});

test('opening HTML preserves the selected session through editor focus and transient mapping loss',async t=>{
 let mapped=true;
 const link={sessionForTerminal:terminal=>mapped?terminal?.sessionName:undefined,refresh:async()=>{}};
 const env=await start(t,{sessionsApi:link});
 const terminal={sessionName:'claude-main',name:'renamed terminal'};
 env.vscode.window.activeTerminal=terminal;
 const view=await openSidebar(env);await settle(view);
 const before=lastState(view).files.map(f=>f.id);
 const html=lastState(view).files.find(f=>f.path.endsWith('.html'));
 await view.webview.send({type:'previewFile',id:html.id});await settle(view);
 mapped=false;env.log.activeTerminalChanged();await settle(view);
 assert.equal(lastState(view).selectedSessionId,'$1');
 assert.deepEqual(lastState(view).files.map(f=>f.id),before);
 env.vscode.window.activeTerminal=undefined;env.log.activeTerminalChanged();await settle(view);
 assert.equal(lastState(view).selectedSessionId,'$1');
 assert.deepEqual(lastState(view).files.map(f=>f.id),before);
});
test('unmapped terminals with unique tmux titles get their own file list',async t=>{
 const env=await start(t,{sessionsApi:{sessionForTerminal:()=>undefined},sessions:root=>[session(root),session(root,{id:'$2',name:'trade-accumulate-aggressive',sessionName:'codex-trade-accumulate-aggressive',pane:'%2'})]});
 env.vscode.window.activeTerminal={name:'trade-accumulate-aggressive'};
 const view=await openSidebar(env);await settle(view);
 assert.equal(lastState(view).selectedSessionId,'$2');
 assert.equal(lastState(view).files.length,2);
 assert.ok(env.calls.filter(([,args])=>args[0]==='capture-pane').every(([,args])=>args[args.indexOf('-t')+1]==='%2'));
});
test('opening a recent file focuses the main editor before opening from a right-hand terminal group',async t=>{
 const env=await start(t);const view=await openSidebar(env);await settle(view);
 env.vscode.window.tabGroups={all:[{viewColumn:1},{viewColumn:2}],activeTabGroup:{viewColumn:2}};
 const file=lastState(view).files.find(f=>f.path.endsWith('.html'));
 await view.webview.send({type:'previewFile',id:file.id});await settle(view);
 assert.ok(env.log.executed.some(([command])=>command==='workbench.action.focusFirstEditorGroup'));
 assert.equal(env.log.panels.at(-1).column,1);
});

// Review regressions use delayed injected operations, never a live terminal.
test('description edits survive polling and stay with their original session',async t=>{
  const env=await start(t,{sessions:p=>[session(p),session(p,{id:'$2',sessionName:'codex-other'})]});
  const view=await openSidebar(env),id=lastState(view).files[0].id;
  view.webview.send({type:'fileAction',id,action:'pin'});await settle(view);
  let reply;env.vscode.window.showInputBox=()=>new Promise(resolve=>{reply=resolve;});
  view.webview.send({type:'fileAction',id,action:'describe'});await settle(view);
  await env.log.commands.get('agentGlue.refreshResources')();
  reply('Survives polling');await settle(view);
  assert.equal(lastState(view).files.find(f=>f.id===id).description,'Survives polling');
  view.webview.send({type:'fileAction',id,action:'describe'});await settle(view);
  env.vscode.window.activeTerminal={name:'codex-other'};env.log.activeTerminalChanged();await settle(view);
  reply('Stays with original');await settle(view);
  assert.equal(env.context.workspaceState.get('files')['$1'].find(f=>f.id===id).description,'Stays with original');
  assert.equal(lastState(view).selectedSessionId,'$2');
  assert.ok(lastState(view).files.every(f=>!f.description));
});

test('pending upload setup holds its original recipient during terminal switches',async t=>{
  const link={sessionForTerminal:t=>t?.sessionName};
  const env=await start(t,{sessionsApi:link,sessions:p=>[session(p),session(p,{id:'$2',sessionName:'codex-other'})]});
  env.vscode.window.activeTerminal={sessionName:'claude-main'};
  const view=await openSidebar(env);
  const begin=core.Uploads.prototype.begin;let release,entered;
  const began=new Promise(r=>{entered=r;});
  core.Uploads.prototype.begin=async function(...args){entered();await new Promise(r=>{release=r;});return begin.apply(this,args);};
  t.after(()=>{core.Uploads.prototype.begin=begin;release?.();});
  view.webview.send({type:'uploadStart',id:'slow-start',name:'a.txt',size:0});await began;
  env.vscode.window.activeTerminal={sessionName:'codex-other'};env.log.activeTerminalChanged();await settle(view);
  assert.equal(lastState(view).draft.targetId,'$1');
  release();await waitFor(view,m=>m.type==='uploadReady','ready after delayed setup');
});

test('failed Sessions activation leaves standalone file discovery working',async t=>{
  const host=fakeHost();host.vscode.extensions.getExtension=()=>({activate:async()=>{throw new Error('synthetic activation failure');}});
  const env=await start(t,{host});env.vscode.window.activeTerminal={name:'claude-main'};
  const view=await openSidebar(env);
  assert.equal(lastState(view).selectedSessionId,'$1');
  assert.equal(lastState(view).files.length,2);
  assert.match(lastState(view).status,/Sessions extension unavailable/);
});

test('duplicate upload start does not cancel the original transfer',async t=>{
  const env=await start(t),view=await openSidebar(env);
  const request={type:'uploadStart',id:'duplicate',name:'a.txt',size:0};
  view.webview.send(request);await waitFor(view,m=>m.type==='uploadReady','first ready');
  view.webview.send(request);await waitFor(view,m=>m.type==='uploadError','duplicate error');
  view.webview.send({type:'uploadFinish',id:'duplicate'});
  await waitFor(view,m=>m.type==='uploadComplete','original still completes');
});

test('an upload batch holds one recipient between files and releases it on completion',async t=>{
  const link={sessionForTerminal:t=>t?.sessionName};
  const env=await start(t,{sessionsApi:link,sessions:p=>[session(p),session(p,{id:'$2',sessionName:'codex-other'})]});
  env.vscode.window.activeTerminal={sessionName:'claude-main'};
  const view=await openSidebar(env);
  view.webview.send({type:'uploadBatchStart',id:'batch',targetId:'$1'});
  await waitFor(view,m=>m.type==='uploadBatchReady','batch ready');
  for(const id of ['file-one','file-two']){
    env.vscode.window.activeTerminal={sessionName:'codex-other'};env.log.activeTerminalChanged();await settle(view);
    assert.equal(lastState(view).draft.targetId,'$1','recipient held even between files');
    view.webview.send({type:'uploadStart',id,batchId:'batch',targetId:'$1',name:id+'.txt',size:0});
    await waitFor(view,m=>m.type==='uploadReady'&&m.id===id,'file ready');
    view.webview.send({type:'uploadFinish',id});
    await waitFor(view,m=>m.type==='uploadComplete'&&m.id===id,'file complete');
  }
  assert.ok(lastState(view).draft.attachments.every(a=>a.targetId==='$1'));
  view.webview.send({type:'uploadBatchEnd',id:'batch'});await settle(view);
  env.log.activeTerminalChanged();await settle(view);
  assert.equal(lastState(view).draft.targetId,'$2');
});

test('client abort releases an upload and stale recipient requests are refused',async t=>{
  const env=await start(t,{sessions:p=>[session(p),session(p,{id:'$2',sessionName:'codex-other'})]});
  const view=await openSidebar(env);
  view.webview.send({type:'uploadStart',id:'cancel',targetId:'$1',name:'a.txt',size:10});
  await waitFor(view,m=>m.type==='uploadReady','ready');
  view.webview.send({type:'uploadAbort',id:'cancel'});
  view.webview.send({type:'changeTarget',targetId:'$2'});await settle(view);
  assert.equal(lastState(view).draft.targetId,'$2');
  view.webview.send({type:'uploadStart',id:'stale',targetId:'$1',name:'a.txt',size:0});
  const error=await waitFor(view,m=>m.type==='uploadError'&&m.id==='stale','stale request refused');
  assert.match(error.error,/recipient changed/);
});

test('manual session choice works without Sessions and yields to the next terminal selection',async t=>{
  const env=await start(t);env.vscode.window.activeTerminal={name:'zsh'};
  const view=await openSidebar(env);assert.equal(lastState(view).files.length,0);
  env.vscode.window.showQuickPick=async items=>items[0];
  await env.log.commands.get('agentGlue.chooseSession')();
  assert.equal(lastState(view).selectedSessionId,'$1');assert.equal(lastState(view).files.length,2);
  await env.log.commands.get('agentGlue.refreshResources')();assert.equal(lastState(view).selectedSessionId,'$1');
  env.vscode.window.activeTerminal={name:'other-shell'};env.log.activeTerminalChanged();await settle(view);
  assert.equal(lastState(view).selectedSessionId,undefined);
});

test('large HTML reports are discovered and previewed; oversized preview errors are visible',async t=>{
  const env=await start(t,{capture:'data/explorer/review-v2.html'});
  const file=path.join(env.project,'data/explorer/review-v2.html');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,'<!doctype html><h1>Review two</h1><!--'+'x'.repeat(26*1024*1024)+'-->');
  const view=await openSidebar(env);await settle(view);
  const item=lastState(view).files.find(f=>f.path===file);assert.ok(item);
  await view.webview.send({type:'previewFile',id:item.id});await settle(view);
  assert.equal(env.log.panels.length,1);assert.match(env.log.panels[0].webview.html,/Review two/);
  assert.deepEqual(env.log.errors,[]);
  env.log.panels[0].dispose();
  fs.truncateSync(file,200*1024*1024+1);
  await view.webview.send({type:'previewFile',id:item.id});await settle(view);
  assert.match(env.log.errors.at(-1),/Preview limit is 200 MB/);
});

test('both download gestures send the selected file URI to the native helper without browser links',async t=>{
  const env=await start(t);const view=await openSidebar(env);await settle(view);
  const original=env.vscode.commands.executeCommand;
  const downloads=[];
  env.vscode.commands.executeCommand=async(command,...args)=>{
    if(command==='agentGlueMac.status')return {platform:'darwin',nativeDownload:true,safeNativeErrors:true};
    if(command==='agentGlueMac.downloadFile'){downloads.push(args[0]);return {cancelled:downloads.length===2};}
    return original(command,...args);
  };
  env.vscode.env.openExternal=async()=>assert.fail('downloads must not open links');
  const file=lastState(view).files[0];
  await view.send({type:'fileAction',id:file.id,action:'download'});
  assert.equal(downloads[0].fsPath,file.path);assert.match(lastState(view).status,/downloaded to your computer/);
  env.vscode.window.showQuickPick=async()=> 'Download';
  await view.send({type:'fileMenu',id:file.id});
  assert.equal(downloads[1].fsPath,file.path);assert.match(lastState(view).status,/cancelled/);
  await view.send({type:'fileAction',id:'unknown',action:'download'});assert.equal(downloads.length,2);
});

test('native helper installation waits for delayed activation before downloading',async t=>{
  const env=await start(t);const view=await openSidebar(env);await settle(view);
  let installed=false,probes=0,downloads=0;
  env.vscode.commands.executeCommand=async name=>{
    if(name==='agentGlueMac.status')return {platform:'darwin',nativeDownload:installed&&++probes>=3};
    if(name==='workbench.extensions.installExtension')installed=true;
    if(name==='agentGlueMac.downloadFile'){downloads++;return {cancelled:false};}
  };
  await view.send({type:'fileAction',id:lastState(view).files[0].id,action:'download'});
  assert.equal(downloads,1);assert.deepEqual(env.log.errors,[]);
});

test('a loaded old helper offers a reload and does not start a download',async t=>{
  const env=await start(t);const view=await openSidebar(env);await settle(view);
  const calls=[];let prompt;
  env.vscode.commands.executeCommand=async name=>{calls.push(name);if(name==='agentGlueMac.status')return {platform:'darwin',nativeDownload:false};};
  env.vscode.window.showInformationMessage=async(message,action)=>{prompt=message;assert.equal(action,'Reload Window');return action;};
  await view.send({type:'fileAction',id:lastState(view).files[0].id,action:'download'});
  assert.match(prompt,/Reload Window to activate/);
  assert.ok(calls.includes('workbench.action.reloadWindow'));
  assert.ok(!calls.includes('agentGlueMac.downloadFile'));
});

test('Pin File accepts ZIP archives absent from recent terminal output',async t=>{
  const env=await start(t);const view=await openSidebar(env);await settle(view);
  const zip=path.join(env.project,'bundle.zip');fs.writeFileSync(zip,'synthetic archive');
  env.vscode.window.showOpenDialog=async options=>{
    assert.equal(options.filters,undefined);assert.equal(options.canSelectFolders,false);
    return [{fsPath:zip}];
  };
  await env.log.commands.get('agentGlue.pin')();
  const file=lastState(view).files.find(file=>file.path===zip);assert.ok(file?.pinned);
  assert.deepEqual(env.log.errors,[]);
});

test('PR comment host locks submissions to the opened PR and suppresses double clicks',async t=>{
 const env=await start(t);
 const item={id:'pr-12',number:12,url:'https://github.com/example/project/pull/12'};
 core.run=async()=>({stdout:JSON.stringify({...item,title:'Example',body:'',comments:[],files:[]})});
 let release,calls=[];
 const panel=await require('../packages/companion/src/pull-request.cjs').openPullRequest(env.vscode,env.context,item,env.project,new Map(),{commentExec:async(...args)=>{calls.push(args);await new Promise(resolve=>{release=resolve;});}});
 const first=panel.webview.send({type:'postComment',body:'Feedback',url:'https://wrong.invalid'});
 await panel.webview.send({type:'postComment',body:'Duplicate'});
 assert.equal(calls.length,1);assert.equal(calls[0][1][2],item.url);
 release();await first;
 assert.ok(panel.webview.posted.some(message=>message.type==='commentResult'&&message.ok));
});

test('prepared review saves local feedback and offers all comments to the selected agent without GitHub',async t=>{
 const env=await start(t),prompts=[];
 const item={id:'local:example',local:true,title:'Prepared example',reviewRoot:env.project,worktree:env.project,documents:[]};
 const review=require('../packages/companion/src/pull-request.cjs');
 const panel=await review.openPullRequest(env.vscode,env.context,item,env.project,new Map(),{onDiscuss:async text=>prompts.push(text),commentExec:async()=>assert.fail('must not post to GitHub')});
 await panel.webview.send({type:'postComment',body:'Please simplify the proposal.'});
 assert.ok(panel.webview.posted.some(message=>message.type==='commentResult'&&message.ok&&message.local));
 const persisted=await require('../packages/companion/src/local-feedback.cjs').read(env.project);
 assert.equal(persisted[0].body,'Please simplify the proposal.');
 await panel.webview.send({type:'reviewFeedback',root:'/untrusted',text:'untrusted'});
 assert.equal(prompts.length,1);assert.ok(prompts[0].includes(path.join(env.project,'.local/agent-glue/review-comments.jsonl')));
 assert.ok(!prompts[0].includes('/untrusted'));assert.ok(!env.calls.some(([cmd])=>cmd==='gh'));
 const reopened=await review.detail(item,env.project);
 assert.equal(reopened.pr.comments.length,1);
});

test('PR code sorting and explicit read marks stay stable across refreshes and project switches',async t=>{
 const resources=require('../packages/companion/src/resources.cjs'),original=resources.list;t.after(()=>{resources.list=original;});
 let root='/project-a',reverse=false;
 resources.list=async()=>({root,items:(reverse?[10,2]:[2,10]).map(n=>({id:'local:'+n,label:'CODE-'+n,number:0,updatedAt:reverse?'2030':'2020'}))});
 const env=await start(t);const view=await openSidebar(env);await settle(view);
 await env.log.commands.get('agentGlue.showprs')();
 await waitFor(view,()=>lastState(view).resourceItems.length===2,'PR list');
 assert.deepEqual(lastState(view).resourceItems.map(i=>i.id),['local:2','local:10']);
 const generation=lastState(view).resourceGeneration;
 await view.send({type:'markPrRead',id:'local:2',read:true,generation});
 assert.equal(lastState(view).resourceItems[0].markedRead,true);
 assert.ok(env.context.workspaceState.get('prRead')[JSON.stringify([root,'local:2'])]);
 await view.send({type:'prReadFilter',filter:'unread'});
 assert.deepEqual(lastState(view).resourceItems.map(i=>i.id),['local:10']);
 reverse=true;await view.send({type:'refresh'});await settle(view);
 assert.deepEqual(lastState(view).resourceItems.map(i=>i.id),['local:10']);
 await view.send({type:'prReadFilter',filter:'all'});
 assert.deepEqual(lastState(view).resourceItems.map(i=>i.id),['local:2','local:10']);
 root='/project-b';await view.send({type:'refresh'});await settle(view);
 assert.ok(lastState(view).resourceItems.every(i=>!i.markedRead));
 await view.send({type:'markPrRead',id:'local:2',read:true,generation});
 assert.ok(lastState(view).resourceItems.every(i=>!i.markedRead),'stale row action cannot mark another project');
});

test('Tasks command reads the selected project and refreshes agent progress independently of PR filters',async t=>{
 const env=await start(t);const view=await openSidebar(env);await settle(view);
 const directory=path.join(env.project,'.local/agent-glue/tasks');fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'work.json');
 fs.writeFileSync(file,JSON.stringify({title:'Ship task view',sessionId:'$1',status:'active',updatedAt:'2026-10-21T12:00:00Z'}));
 await env.log.commands.get('agentGlue.showtasks')();
 await waitFor(view,()=>lastState(view).resourceItems.length===1,'Task list');
 assert.equal(lastState(view).resourceTab,'tasks');assert.equal(lastState(view).resourceItems[0].status,'active');
 assert.equal(lastState(view).resourceFolder,env.project);
 fs.writeFileSync(file,JSON.stringify({title:'Ship task view',sessionId:'$1',status:'done',updatedAt:'2026-10-21T13:00:00Z'}));
 await view.send({type:'refresh'});
 await waitFor(view,()=>lastState(view).resourceItems[0]?.status==='done','Task update');
 await env.log.commands.get('agentGlue.showfiles')();
 assert.equal(lastState(view).resourceTab,'files');
});

test('status robot makes one isolated request, preserves drafts, and does not paste into the agent',async t=>{
 const runner=require('../packages/companion/src/status-runner.cjs'),original=runner.summarize;t.after(()=>{runner.summarize=original;});
 const calls=[],sent=[];let finish;
 runner.summarize=(...args)=>{calls.push(args);return new Promise(resolve=>{finish=resolve;});};
 const terminal={sessionName:'claude-main',show(){},sendText:(...args)=>sent.push(args)};
 const api={refresh:async()=>{},sessionForTerminal:t=>t?.sessionName,terminalForSession:()=>terminal};
 const env=await start(t,{sessionsApi:api});env.vscode.window.activeTerminal=terminal;
 const view=await openSidebar(env);await settle(view);
 await view.send({type:'editDraft',text:'Keep my note'});
 await env.log.commands.get('agentGlue.showtasks')();await settle(view);
 const pending=view.send({type:'setupTasks',text:'untrusted'});
 for(let i=0;i<200&&!finish;i++)await new Promise(r=>setTimeout(r,5));
 assert.ok(finish,'status runner started: '+lastState(view).status);
 assert.equal(lastState(view).statusRunBusy,true);
 await view.send({type:'setupTasks'});assert.equal(calls.length,1);
 await view.send({type:'editDraft',text:'Keep my note'});
 assert.equal(calls[0][0].sessionName,'claude-main');assert.match(calls[0][1],/Wrote docs/);assert.ok(!calls[0][1].includes('untrusted'));
 finish({items:[{id:'task:result',label:'Status result',status:'active',summary:'Testing',updatedAt:new Date().toISOString(),source:'snapshot'}],updatedAt:new Date().toISOString(),summaryTokens:100});await pending;
 await waitFor(view,()=>lastState(view).resourceItems.some(r=>r.label==='Status result'),'robot result');
 assert.deepEqual(sent,[]);assert.equal(lastState(view).draft.text,'Keep my note');assert.equal(lastState(view).statusRunBusy,false);
 assert.equal(env.context.workspaceState.get('statusReports')['$1'].summaryTokens,100);
 runner.summarize=async()=>{throw Error('Synthetic failure');};await view.send({type:'setupTasks'});
 assert.equal(env.context.workspaceState.get('statusReports')['$1'].items[0].label,'Status result');assert.equal(lastState(view).statusRunBusy,false);
});

test('web app actions forward client links and open in the main editor, with external alternative',async t=>{
 const {WebApps}=require('../packages/companion/src/web-apps.cjs');const original=WebApps.prototype.scan;
 const item={id:'app',sessionId:'$1',terminal:'Fixture',cwd:'/fixture',url:'http://localhost:3000/index.html',running:true};
 WebApps.prototype.scan=async function(){this.items=[item];return this.items;};t.after(()=>{WebApps.prototype.scan=original;});
 const env=await start(t);const forwarded=[],opened=[];
 const uri=s=>({toString:()=>s});env.vscode.Uri.parse=uri;
 env.vscode.env.asExternalUri=async u=>{forwarded.push(u.toString());return uri('http://localhost:43000/index.html');};
 env.vscode.env.openExternal=async u=>{opened.push(u.toString());return true;};
 await openSidebar(env);
 await env.log.commands.get('agentGlue.webApps')();
 const panel=env.log.panels.find(p=>p.viewType==='agentGlue.webApps');assert.ok(panel.webview.html.includes('Fixture'));assert.ok(panel.webview.html.includes('<td>index.html</td>'));assert.ok(panel.webview.html.includes('Web apps · 1 active'));
 await panel.webview.send({id:'app',action:'open'});
 const browser=env.log.executed.find(c=>c[0]==='simpleBrowser.api.open');assert.equal(browser[1].toString(),'http://localhost:43000/index.html');assert.equal(browser[2].viewColumn,1);
 await panel.webview.send({id:'app',action:'copy'});assert.equal(env.log.clipboard.at(-1),'http://localhost:43000/index.html');
 await panel.webview.send({id:'app',action:'browser'});assert.deepEqual(opened,['http://localhost:3000/index.html']);assert.equal(forwarded.length,2);
});

test('fork folder prompt freezes its source and duplicate clicks do not create duplicate forks',async t=>{
 const forks=[];const env=await start(t,{sessionsApi:{sessionForTerminal:()=>undefined,forkSession:async(...args)=>forks.push(args)}});await openSidebar(env);
 let input,accept,hide;env.vscode.ThemeIcon=class{constructor(id){this.id=id;}};
 env.vscode.window.createInputBox=()=>input={onDidHide:fn=>{hide=fn;},onDidTriggerButton(){},onDidAccept:fn=>{accept=fn;},show(){},dispose(){hide?.();}};
 env.vscode.window.activeTerminal={name:'Fix bug'};
 const first=env.log.commands.get('agentGlue.fork')();await new Promise(r=>setImmediate(r));
 assert.equal(input.value,env.project);await env.log.commands.get('agentGlue.fork')();
 await accept();await first;assert.equal(forks.length,1);assert.equal(forks[0][0].id,'$1');assert.equal(forks[0][1],env.project);
 const canceled=env.log.commands.get('agentGlue.fork')();await new Promise(r=>setImmediate(r));hide();await canceled;assert.equal(forks.length,1);
});


test('terminal context fork targets clicked tab with sidebar closed and refuses unrelated or multiple terminals',async t=>{
 const forks=[];const clicked={name:'Second'},active={name:'First'};
 const env=await start(t,{sessions:cwd=>[session(cwd,{name:'First'}),session(cwd,{id:'$2',name:'Second',sessionName:'claude-second',pane:'%2'})],sessionsApi:{sessionForTerminal:terminal=>terminal===clicked?'claude-second':terminal===active?'claude-main':undefined,forkSession:async(...args)=>forks.push(args)}});
 await new Promise(r=>setTimeout(r,80));env.calls.length=0;
 env.vscode.window.activeTerminal=active;
 let input,accept,hide;env.vscode.ThemeIcon=class{};
 env.vscode.window.createInputBox=()=>input={onDidHide:fn=>{hide=fn;},onDidTriggerButton(){},onDidAccept:fn=>{accept=fn;},show(){},dispose(){hide?.();}};
 const fork=env.log.commands.get('agentGlue.fork');
 const pending=fork([clicked]);await new Promise(r=>setImmediate(r));assert.equal(input.title,'Fork Second');await accept();await pending;
 assert.equal(forks.length,1);assert.equal(forks[0][0].id,'$2');
 assert.equal(env.calls.filter(([,args])=>args[0]==='capture-pane').length,0);
 await fork({name:'Unrelated shell'});assert.match(env.log.errors.at(-1),/not an attached/);
 await fork([clicked,active]);assert.match(env.log.errors.at(-1),/Choose one/);
 await fork([undefined]);assert.match(env.log.errors.at(-1),/no longer available/);
 assert.equal(forks.length,1);
 for(const menu of ['terminal/title/context','terminal/context'])assert.ok(manifest.contributes.menus[menu].some(m=>m.command==='agentGlue.fork'));
});

test('terminal status switches between terminals in the same project without leaking reports',async t=>{
 const first={name:'First'},second={name:'Second'};
 const api={sessionForTerminal:terminal=>terminal===first?'claude-first':terminal===second?'claude-second':undefined};
 const env=await start(t,{sessions:cwd=>[session(cwd,{name:'First',sessionName:'claude-first'}),session(cwd,{id:'$2',name:'Second',sessionName:'claude-second',pane:'%2'})],sessionsApi:api});
 env.vscode.window.activeTerminal=first;
 const directory=path.join(env.project,'.local/agent-glue/tasks');fs.mkdirSync(directory,{recursive:true});
 for(const id of ['$1','$2'])fs.writeFileSync(path.join(directory,id+'.json'),JSON.stringify({title:'Work for '+id,sessionId:id,status:'active',updatedAt:'2026-10-29T12:00:00Z'}));
 const view=await openSidebar(env);await settle(view);
 await env.log.commands.get('agentGlue.showtasks')();
 await waitFor(view,()=>lastState(view).resourceItems[0]?.label==='Work for $1','first status');
 env.vscode.window.activeTerminal=second;env.log.activeTerminalChanged(second);
 await waitFor(view,()=>lastState(view).resourceItems[0]?.label==='Work for $2','second status in same folder');
 assert.equal(lastState(view).resourceItems.length,1);
});

test('path uploads use the local helper and attach remote bytes while retaining the original recipient',async t=>{
 const env=await start(t);const view=await openSidebar(env);await settle(view);
 const bytes=Buffer.from('<html>local review</html>'),execute=env.vscode.commands.executeCommand;
 env.vscode.commands.executeCommand=async(cmd,...args)=>{
  if(cmd==='agentGlueMac.status')return {platform:'linux',safeNativeErrors:true,localFiles:true,maxFileBytes:200*1024*1024};
  if(cmd==='agentGlueMac.readLocalFile'){assert.equal(args[0],'/Users/example/review.html');env.vscode.window.activeTerminal={name:'unrelated'};env.log.activeTerminalChanged(env.vscode.window.activeTerminal);return {name:'review.html',data:bytes.toString('base64'),size:bytes.length};}
  return execute(cmd,...args);
 };
 await view.send({type:'importLocalFiles',paths:['/Users/example/review.html'],targetId:'$1'});
 const attached=lastState(view).draft.attachments.at(-1);assert.ok(attached,JSON.stringify(lastState(view)));
 assert.ok(attached.path.startsWith(path.join(env.project,'.local/agent-glue/inbox/')));
 assert.deepEqual(fs.readFileSync(attached.path),bytes);
 await view.send({type:'importLocalFiles',paths:['/Users/example/review.html'],targetId:'different-session'});
 assert.equal(lastState(view).draft.attachments.length,1);assert.match(lastState(view).status,/recipient changed/);
 env.vscode.commands.executeCommand=async(cmd,...args)=>{if(cmd==='agentGlueMac.readLocalFile')throw Error('ENOENT: no local file');if(cmd==='agentGlueMac.status')return {platform:'linux',localFiles:true,maxFileBytes:200*1024*1024};return execute(cmd,...args);};
 await view.send({type:'importLocalFiles',paths:[path.join(env.project,'notes.html')],targetId:'$1'});
 assert.equal(lastState(view).draft.attachments.at(-1).path,path.join(env.project,'notes.html'),'existing remote paths remain usable');
});

test('uploads retry unresolved project roots and distinguish folder failures from recipient changes',async t=>{
 const original=core.project;let fail=true;
 core.project=async cwd=>{if(fail)throw Error('temporary lookup failure');return original(cwd);};t.after(()=>{core.project=original;});
 const env=await start(t);const view=await openSidebar(env);await settle(view);
 assert.equal(lastState(view).draft.targetId,'$1');assert.equal(lastState(view).draft.root,undefined);
 await view.send({type:'uploadBatchStart',id:'missing-root',targetId:'$1'});
 const failure=view.posted.find(m=>m.type==='uploadError'&&m.id==='missing-root');assert.match(failure.error,/Cannot find a Git project/);assert.doesNotMatch(failure.error,/recipient changed/);
 fail=false;
 await view.send({type:'uploadBatchStart',id:'retry-root',targetId:'$1'});
 assert.ok(view.posted.some(m=>m.type==='uploadBatchReady'&&m.id==='retry-root'));
 await view.send({type:'uploadStart',id:'retry-file',batchId:'retry-root',targetId:'$1',name:'report.html',size:0});
 await view.send({type:'uploadFinish',id:'retry-file'});
 assert.ok(view.posted.some(m=>m.type==='uploadComplete'&&m.id==='retry-file'));
 await view.send({type:'uploadBatchEnd',id:'retry-root'});
 await view.send({type:'uploadBatchStart',id:'wrong-recipient',targetId:'$2'});
 assert.match(view.posted.find(m=>m.type==='uploadError'&&m.id==='wrong-recipient').error,/recipient changed/);
});

test('retrying a missing upload folder preserves a manually chosen recipient',async t=>{
 const original=core.project;let fail=false;
 core.project=async cwd=>{if(fail)throw Error('temporary lookup failure');return original(cwd);};t.after(()=>{core.project=original;});
 const env=await start(t,{sessions:p=>[session(p),session(p,{id:'$2',sessionName:'claude-second',name:'Second'})]});
 const view=await openSidebar(env);await settle(view);fail=true;
 await view.send({type:'changeTarget',targetId:'$2'});assert.equal(lastState(view).draft.root,undefined);
 fail=false;await env.log.commands.get('agentGlue.refreshResources')();await settle(view);
 assert.equal(lastState(view).draft.targetId,'$2');assert.equal(lastState(view).draft.root,env.project);
});

 test('fork picker hands off to a different profile and cancels without launching',async t=>{
 const forks=[];const env=await start(t,{sessionsApi:{handoffProfiles:['claude','codex2'],sessionForTerminal:()=>undefined,forkSession:async(...args)=>forks.push(args)}});
 await openSidebar(env);env.vscode.window.activeTerminal={name:'Fix bug'};
 let accept,hide;env.vscode.ThemeIcon=class{};
 env.vscode.window.createInputBox=()=>({onDidHide:fn=>{hide=fn;},onDidTriggerButton(){},onDidAccept:fn=>{accept=fn;},show(){},dispose(){hide?.();},value:env.project});
 let choose='codex2';env.vscode.window.showQuickPick=async items=>items.find(i=>i.profile===choose);
 env.vscode.window.showInputBox=async()=> 'Model: Example model';
 let run=env.log.commands.get('agentGlue.fork')();await new Promise(r=>setImmediate(r));await accept();await run;
 assert.equal(forks.length,1);assert.equal(forks[0][2].profile,'codex2');assert.equal(forks[0][2].status,'Model: Example model');
 choose=undefined;run=env.log.commands.get('agentGlue.fork')();await new Promise(r=>setImmediate(r));await accept();await run;assert.equal(forks.length,1);
 choose='codex2';env.vscode.window.showInputBox=async()=>undefined;run=env.log.commands.get('agentGlue.fork')();await new Promise(r=>setImmediate(r));await accept();await run;assert.equal(forks.length,1);
 choose='claude';env.vscode.window.showInputBox=async()=>{throw Error('Same account must not request handoff details');};run=env.log.commands.get('agentGlue.fork')();await new Promise(r=>setImmediate(r));await accept();await run;assert.equal(forks.length,2);assert.equal(forks[1][2],undefined);
 });

test('sidebar title follows the exact CLI profile and activity never captures background panes',async t=>{
 const first={name:'First'},second={name:'Second'};
 const env=await start(t,{capture:'• Working (2s • esc to interrupt)',sessions:cwd=>[session(cwd,{name:'First',profile:'claude2'}),session(cwd,{id:'$2',name:'Second',profile:'codexl',pane:'%2'})]});
 env.vscode.window.activeTerminal=first;const view=await openSidebar(env);await settle(view);
 assert.equal(view.title,'AG - claude2');assert.equal(lastState(view).activities[0].status,'active');
 assert.equal(lastState(view).activities[1].status,'unknown');
 assert.ok(env.calls.filter(([,args])=>args[0]==='capture-pane').every(([,args])=>args[args.indexOf('-t')+1]==='%1'));
 env.vscode.window.activeTerminal=second;env.log.activeTerminalChanged(second);await settle(view);assert.equal(view.title,'AG - codexl');
 env.vscode.window.activeTerminal={name:'Unrelated shell'};env.log.activeTerminalChanged(env.vscode.window.activeTerminal);await settle(view);assert.equal(view.title,'AG');
});
