'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const parse5=require('parse5');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {documentHtml,openPreview}=require('../src/preview.cjs');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
function fixture(){
  const base=tempDir('preview-links'),root=path.join(base,'project'),extensionPath=path.join(base,'extension');
  fs.mkdirSync(path.join(root,'docs'),{recursive:true});fs.mkdirSync(path.join(extensionPath,'dist'),{recursive:true});
  fs.writeFileSync(path.join(extensionPath,'dist/mermaid.js'),'window.mermaid={initialize(){}};');
  fs.writeFileSync(path.join(root,'start.md'),'# Review\n\n[Proposal](docs/proposal.md#recommended-option)\n\n[Bad](../outside.md)');
  fs.writeFileSync(path.join(root,'docs/proposal.md'),'# Proposal\n\n[Mockup](mockup.html#choice)\n\n## Recommended option\n\n[Heading](#recommended-option)');
  fs.writeFileSync(path.join(root,'docs/mockup.html'),'<a href="#choice">Jump</a><div style="height:1200px"></div><h2 id="choice">Choice</h2><a href="shot.png">Screenshot</a>');
  fs.writeFileSync(path.join(root,'docs/shot.png'),PNG);
  fs.writeFileSync(path.join(base,'outside.md'),'not readable');
  const events={panels:[],opened:[],errors:[]},panels=new Map();
  const vscode={ViewColumn:{One:1},Uri:{file:fsPath=>({fsPath})},env:{clipboard:{writeText(){}}},commands:{async executeCommand(...args){events.opened.push(args);}},window:{
    showErrorMessage(message){events.errors.push(message);},showTextDocument(){},
    createWebviewPanel(type,title,column,options){const p={type,title,column,options,revealed:[],messages:[],reveal(c){this.revealed.push(c);},onDidDispose(f){this.disposed=f;},webview:{onDidReceiveMessage(f){this.handler=f;},postMessage(m){p.messages.push(m);}}};events.panels.push(p);return p;}
  }};
  return {base,root,context:{extensionPath},vscode,events,panels};
}
function all(tree,tag){return [...(tree.tagName===tag?[tree]:[]),...(tree.childNodes||[]).flatMap(n=>all(n,tag))];}
function documentFrom(panel){const tree=parse5.parse(panel.webview.html),iframe=all(tree,'iframe')[0];return parse5.parse(iframe.attrs.find(a=>a.name==='srcdoc').value);}
function linkMessage(panel,label){
  const node=all(documentFrom(panel),'a').find(n=>n.childNodes.some(t=>t.value===label));
  const id=node?.attrs.find(a=>a.name==='data-agent-glue-link')?.value;
  const channel=/channel='([a-f0-9]+)'/.exec(panel.webview.html)[1];
  return {type:'previewLink',channel,id};
}
test('preview follows document-relative Markdown, HTML and screenshot links through validated capabilities',async()=>{
  const e=fixture();const start=await openPreview(e.vscode,e.context,path.join(e.root,'start.md'),e.root,e.panels);
  assert.equal(linkMessage(start,'Bad').id,undefined);
  await start.webview.handler({...linkMessage(start,'Proposal'),channel:'wrong'});
  await start.webview.handler({...linkMessage(start,'Proposal'),id:'/etc/passwd'});
  assert.equal(e.events.panels.length,1);
  await start.webview.handler({...linkMessage(start,'Proposal'),path:'/etc/passwd'});
  const proposal=e.events.panels[1];assert.equal(proposal.title,'proposal.md');assert.equal(proposal.column,1);
  assert.ok(all(documentFrom(proposal),'h2').some(n=>n.attrs.some(a=>a.name==='id'&&a.value==='recommended-option')));
  await proposal.webview.handler(linkMessage(proposal,'Mockup'));
  const mockup=e.events.panels[2];assert.equal(mockup.title,'mockup.html');
  await mockup.webview.handler(linkMessage(mockup,'Screenshot'));
  assert.deepEqual(e.events.opened,[['vscode.open',{fsPath:path.join(e.root,'docs/shot.png')},1]]);
  await openPreview(e.vscode,e.context,path.join(e.root,'docs/proposal.md'),e.root,e.panels,'recommended-option');
  assert.deepEqual(proposal.messages,[{type:'previewAnchor',anchor:'recommended-option'}]);
  assert.deepEqual(proposal.revealed,[1]);assert.deepEqual(e.events.errors,[]);
});
test('preview link map excludes escapes, memory, commands, external links, and absent files',async()=>{
  const e=fixture();fs.mkdirSync(path.join(e.root,'.claude'));fs.writeFileSync(path.join(e.root,'.claude/private.md'),'private');
  fs.symlinkSync(path.join(e.base,'outside.md'),path.join(e.root,'escape.md'));
  fs.symlinkSync(path.join(e.root,'.claude/private.md'),path.join(e.root,'private.md'));
  fs.writeFileSync(path.join(e.root,'unsafe.html'),'<a href="escape.md">Escape</a><a href="private.md">Private alias</a><a href=".claude/private.md">Private</a><a href="command:workbench.action.reloadWindow">Command</a><a href="https://example.test/">Web</a><a href="absent.md">Absent</a><a href="docs/proposal.md#x" data-agent-glue-link="forged">Good</a>');
  const links=new Map(),html=await documentHtml(path.join(e.root,'unsafe.html'),e.root,'',{channel:'test',links});
  assert.ok(!html.includes('data-agent-glue-link="forged"'));
  assert.ok([...links.values()].some(v=>v.file===path.join(e.root,'docs/proposal.md')&&v.anchor==='x'));
  assert.ok([...links.values()].every(v=>[path.join(e.root,'docs/proposal.md'),path.join(e.root,'start.md'),path.join(e.root,'unsafe.html')].includes(v.file)));
  const ordinary=await documentHtml(path.join(e.root,'unsafe.html'),e.root);
  assert.ok(!ordinary.includes('data-agent-glue-link='),'standalone browser previews cannot request VS Code actions');
});
test('preview revalidates a mapped file on click and contains file errors',async()=>{
  const e=fixture(),start=await openPreview(e.vscode,e.context,path.join(e.root,'start.md'),e.root,e.panels);
  fs.renameSync(path.join(e.root,'docs/proposal.md'),path.join(e.root,'docs/original.md'));
  fs.symlinkSync(path.join(e.base,'outside.md'),path.join(e.root,'docs/proposal.md'));
  await start.webview.handler(linkMessage(start,'Proposal'));
  assert.equal(e.events.panels.length,1);assert.match(e.events.errors[0],/outside/);
});
test('PR body previews explicitly resolve links and images from a validated repository base',async()=>{
  const e=fixture(),body=path.join(e.root,'docs/body.md');
  fs.writeFileSync(body,'[Proposal](docs/proposal.md#recommended-option)\n\n![Capture](docs/shot.png)');
  const ordinary=await openPreview(e.vscode,e.context,body,e.root,e.panels);
  assert.equal(linkMessage(ordinary,'Proposal').id,undefined,'default preview uses document-relative paths');
  const pr=await openPreview(e.vscode,e.context,body,e.root,e.panels,'',e.root);
  assert.ok(linkMessage(pr,'Proposal').id,'explicit PR base resolves root-relative paths');
  assert.match(all(documentFrom(pr),'img')[0].attrs.find(a=>a.name==='src').value,/^data:image\/png;base64,/);
  await pr.webview.handler(linkMessage(pr,'Proposal'));
  const proposal=e.events.panels.at(-1);assert.equal(proposal.title,'proposal.md');
  assert.ok(linkMessage(proposal,'Mockup').id,'linked document resumes its own directory convention');
  const count=e.events.panels.length;
  await openPreview(e.vscode,e.context,body,e.root,e.panels,'',e.root);
  assert.equal(e.events.panels.length,count,'same resolution mode reuses its panel');
  await assert.rejects(openPreview(e.vscode,e.context,body,e.root,e.panels,'',e.base),/outside/);
  await assert.rejects(openPreview(e.vscode,e.context,body,e.root,e.panels,'',body),/directory/);
});
test('revision previews read and navigate only declared tracked files, including assets and HTML siblings',async()=>{
  const e=fixture(),body=path.join(e.root,'docs/tracked.html');
  fs.writeFileSync(body,'<link rel="stylesheet" href="ignored.css"><img src="shot.png"><a href="proposal.md">Tracked</a><a href="ignored.md">Ignored</a><a href="alias.md">Alias</a>');
  fs.writeFileSync(path.join(e.root,'docs/ignored.css'),'body{color:magenta}');
  fs.writeFileSync(path.join(e.root,'docs/ignored.md'),'## Ignored contents');
  fs.symlinkSync(path.join(e.root,'docs/ignored.md'),path.join(e.root,'docs/alias.md'));
  const allowed=new Set(['docs/tracked.html','docs/proposal.md','docs/mockup.html','docs/alias.md']);allowed.revision='a'.repeat(40);
  const links=new Map(),html=await documentHtml(body,e.root,'',{links,channel:'test',allowedFiles:allowed});
  assert.ok(!html.includes('color:magenta'));assert.ok(!html.includes('data:image/png'));
  assert.ok([...links.values()].every(v=>['tracked.html','proposal.md','mockup.html'].includes(path.basename(v.file))));
  const panel=await openPreview(e.vscode,e.context,body,e.root,e.panels,'',undefined,allowed);
  assert.equal(linkMessage(panel,'Ignored').id,undefined);assert.equal(linkMessage(panel,'Alias').id,undefined);
  await panel.webview.handler(linkMessage(panel,'Tracked'));
  const proposal=e.events.panels.at(-1);await proposal.webview.handler(linkMessage(proposal,'Mockup'));
  const mockup=e.events.panels.at(-1);assert.equal(mockup.title,'mockup.html');
  assert.equal(linkMessage(mockup,'Screenshot').id,undefined,'recursive previews retain the tracked-file restriction');
  await assert.rejects(openPreview(e.vscode,e.context,path.join(e.root,'docs/ignored.md'),e.root,e.panels,'',undefined,allowed),/not tracked/);
  await assert.rejects(documentHtml(path.join(e.root,'docs/ignored.md'),e.root,'',{links:new Map(),allowedFiles:allowed}),/not tracked/);
  const local=await openPreview(e.vscode,e.context,body,e.root,e.panels);
  assert.ok(linkMessage(local,'Ignored').id,'unrestricted local previews retain their existing behavior');
  const other=new Set(allowed);other.revision='b'.repeat(40);
  const changed=await openPreview(e.vscode,e.context,body,e.root,e.panels,'',undefined,other);
  assert.notEqual(changed,panel,'identical file sets at another commit cannot reveal stale cached content');
});
function chromiumPath(){
  if(process.env.AGENT_GLUE_CHROMIUM)return process.env.AGENT_GLUE_CHROMIUM;
  const cache=path.join(os.homedir(),'.cache/ms-playwright');
  if(!fs.existsSync(cache))return;
  for(const dir of fs.readdirSync(cache).filter(n=>n.startsWith('chromium_headless_shell-')).reverse()){
    for(const sub of fs.readdirSync(path.join(cache,dir))){const exe=path.join(cache,dir,sub,'chrome-headless-shell');if(fs.existsSync(exe))return exe;}
  }
}
const executablePath=chromiumPath();
test('browser: review links bridge from opaque frame, anchors scroll, foreign frames cannot request navigation', {skip:!executablePath&&'no Chromium available'},async t=>{
  const e=fixture();const start=await openPreview(e.vscode,e.context,path.join(e.root,'start.md'),e.root,e.panels);
  const {chromium}=require('playwright'),browser=await chromium.launch({executablePath});t.after(()=>browser.close());
  const page=await browser.newPage(),requests=[],messages=[];
  let current=start;
  await page.exposeFunction('sendToHost',async message=>{messages.push(message);await current.webview.handler(message);});
  await page.route('**/*',route=>{
    if(route.request().url()==='https://preview.test/')return route.fulfill({contentType:'text/html',body:current.webview.html.replace('<script nonce','<script>window.acquireVsCodeApi=()=>({postMessage:m=>window.sendToHost(m)})</script><script nonce')});
    requests.push(route.request().url());return route.abort();
  });
  await page.goto('https://preview.test/');
  let frame=page.frames()[1];await frame.getByRole('link',{name:'Proposal',exact:true}).click();
  await page.waitForFunction(()=>true);await assertEventually(()=>e.events.panels.length===2);
  current=e.events.panels[1];await page.reload();frame=page.frames()[1];
  await frame.getByRole('link',{name:'Mockup',exact:true}).click();await assertEventually(()=>e.events.panels.length===3);
  current=e.events.panels[2];await page.reload();frame=page.frames()[1];
  await frame.waitForFunction(()=>window.scrollY>0);
  assert.equal(await frame.evaluate(()=>window.origin),'null');
  await frame.evaluate(()=>window.scrollTo(0,0));await frame.getByRole('link',{name:'Jump',exact:true}).click();
  await frame.waitForFunction(()=>window.scrollY>0);assert.equal(frame.url(),'about:srcdoc#choice');
  const before=messages.length;await page.evaluate(m=>window.postMessage(m,'*'),linkMessage(current,'Screenshot'));
  await page.evaluate(()=>new Promise(requestAnimationFrame));assert.equal(messages.length,before);
  await frame.getByRole('link',{name:'Screenshot',exact:true}).click();await assertEventually(()=>e.events.opened.length===1);
  assert.equal(e.events.opened[0][0],'vscode.open');assert.deepEqual(requests,[]);
});
test('browser: initial and host anchors select the correct interactive gallery without leaving srcdoc', {skip:!executablePath&&'no Chromium available'},async t=>{
  const e=fixture(),file=path.join(e.root,'gallery.html');
  fs.writeFileSync(path.join(e.root,'one.md'),'# First proposal');fs.writeFileSync(path.join(e.root,'two.md'),'# Second proposal');
  fs.writeFileSync(file,`<a id="one" href="#one">First</a><a id="two" href="#two">Second</a><h2 id="title"></h2><a id="source-link" href="one.md">Read proposal</a><script>window.clicks=0;document.addEventListener('click',()=>window.clicks++);const select=()=>{document.getElementById('title').textContent=location.hash==='#two'?'Second mockup':'First mockup';document.getElementById('source-link').href=location.hash==='#two'?'two.md':'one.md';};window.addEventListener('hashchange',select);select();</script>`);
  const panel=await openPreview(e.vscode,e.context,file,e.root,e.panels,'two');
  const {chromium}=require('playwright'),browser=await chromium.launch({executablePath});t.after(()=>browser.close());
  const page=await browser.newPage(),requests=[];
  const messages=[];await page.exposeFunction('sendToHost',async m=>{messages.push(m);await panel.webview.handler(m);});
  await page.route('**/*',route=>{
    if(route.request().url()==='https://preview.test/')return route.fulfill({contentType:'text/html',body:panel.webview.html.replace('<script nonce','<script>window.acquireVsCodeApi=()=>({postMessage:m=>window.sendToHost(m)})</script><script nonce')});
    requests.push(route.request().url());return route.abort();
  });
  await page.goto('https://preview.test/');const frame=page.frames()[1];
  await frame.waitForFunction(()=>document.getElementById('title').textContent==='Second mockup');
  assert.equal(frame.url(),'about:srcdoc#two');assert.equal(await frame.evaluate(()=>window.clicks),0);
  await frame.getByRole('link',{name:'First',exact:true}).click();
  await frame.waitForFunction(()=>document.getElementById('title').textContent==='First mockup');
  assert.equal(await frame.evaluate(()=>window.clicks),1,'ordinary anchor click runs page listener exactly once');
  await page.evaluate(()=>window.postMessage({type:'previewAnchor',anchor:'two'},'*'));
  await frame.waitForFunction(()=>document.getElementById('title').textContent==='Second mockup');
  assert.equal(await frame.evaluate(()=>window.clicks),1,'host navigation does not synthesize extra clicks');
  assert.equal(frame.url(),'about:srcdoc#two');assert.equal(await frame.evaluate(()=>window.origin),'null');assert.deepEqual(requests,[]);
  await frame.getByRole('link',{name:'Read proposal',exact:true}).click();
  await assertEventually(()=>e.events.panels.some(p=>p.title==='two.md'));
  assert.ok(!e.events.panels.some(p=>p.title==='one.md'),'rewritten link does not reuse stale original capability');
  await frame.getByRole('link',{name:'First',exact:true}).click();
  await frame.waitForFunction(()=>document.getElementById('title').textContent==='First mockup');
  await frame.getByRole('link',{name:'Read proposal',exact:true}).click();
  await assertEventually(()=>e.events.panels.some(p=>p.title==='one.md'));
  const sent=messages.length;
  for(const ref of ['../outside.md','missing.md','command:workbench.action.reloadWindow','https://outside.test/']){
    await frame.locator('#source-link').evaluate((a,href)=>a.setAttribute('href',href),ref);
    await frame.getByRole('link',{name:'Read proposal',exact:true}).click();
  }
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  assert.equal(messages.length,sent,'unknown rewritten hrefs cannot send stale or arbitrary host requests');
  assert.deepEqual(requests,[]);
});
async function assertEventually(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.ok(predicate());}

test('concurrent preview opens share one panel',async()=>{
  const e=fixture(),file=path.join(e.root,'start.md');
  await Promise.all(Array.from({length:5},()=>openPreview(e.vscode,e.context,file,e.root,e.panels)));
  assert.equal(e.events.panels.length,1);
  assert.equal(e.panels.size,1);
});
