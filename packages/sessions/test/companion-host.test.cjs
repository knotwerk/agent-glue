'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const realCore=require('../../companion/src/core.cjs');
function fixture(){
 const stored=new Map(),messages=[],captures=[],pasted=[],commands=new Map();let provider,receive;
 let sessions=[{id:'first',sessionName:'claude-one',name:'One',pane:'%1',cwd:'/one'},{id:'second',sessionName:'codex-two',name:'Two',pane:'%2',cwd:'/two'}];
 const state={get:(k,f)=>stored.has(k)?stored.get(k):f,update:async(k,v)=>stored.set(k,structuredClone(v))};
 const disposable=()=>({dispose(){}});
 const terminals=new Map(sessions.map(s=>[s.sessionName,{name:s.name,show(){vscode.window.activeTerminal=this;},sendText(text,submit){pasted.push({name:s.name,text,submit});}}]));
 const link={sessionForTerminal:t=>[...terminals].find(([,v])=>v===t)?.[0],refresh:async()=>{},terminalForSession:name=>terminals.get(name)};
 const vscode={workspace:{isTrusted:true},extensions:{getExtension:()=>({activate:async()=>link})},Uri:{joinPath:(_,p)=>p},ViewColumn:{Beside:2},commands:{executeCommand:async()=>{},registerCommand:(name,fn)=>{commands.set(name,fn);return disposable();}},env:{clipboard:{writeText:async text=>{fixture.copied=text;}}},window:{activeTerminal:undefined,onDidChangeActiveTerminal:()=>disposable(),registerWebviewViewProvider:(_,p)=>{provider=p;return disposable();},showErrorMessage:message=>{throw new Error(message);}}};
 class Uploads{constructor(){this.active=new Map();this.pending=new Set();}async close(){}async expire(){}async abort(id){this.active.delete(id);}async start(message,root,targetId){this.active.set(message.id,{root,targetId});}}
 const core={...realCore,Uploads,sessions:async()=>sessions,project:async cwd=>cwd,run:async(command,args)=>{captures.push(args);return {stdout:''};}};
 const sandbox={module:{exports:{}},require:name=>name==='vscode'?vscode:name==='./editor-target.cjs'?require('../../companion/src/editor-target.cjs'):name==='./web-apps.cjs'?require('../../companion/src/web-apps.cjs'):name==='./core.cjs'?core:name==='./activity.cjs'?require('../../companion/src/activity.cjs'):name==='./browser-links.cjs'?require('../../companion/src/browser-links.cjs'):name==='./resources.cjs'?require('../../companion/src/resources.cjs'):name==='./pull-request.cjs'?require('../../companion/src/pull-request.cjs'):name==='./views.cjs'?require('../../companion/src/views.cjs'):name==='./preview.cjs'?{openPreview:async()=>{}}:require(name),setInterval:()=>1,clearInterval(){},console};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../companion/src/extension.cjs'),'utf8'),sandbox);
 sandbox.module.exports.activate({workspaceState:state,globalState:state,subscriptions:[],extensionUri:'fixture',extensionPath:'/fixture'});
 const webview={cspSource:'fixture:',asWebviewUri:p=>p,postMessage:async message=>{messages.push(structuredClone(message));},onDidReceiveMessage:fn=>{receive=fn;return disposable();}};
 const view={visible:true,webview,onDidChangeVisibility:()=>disposable(),onDidDispose:()=>disposable()};provider.resolveWebviewView(view);
 const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
 return {stored,messages,captures,pasted,view,settle,send:async message=>{receive(message);await settle();},closeFirst:()=>{sessions=sessions.filter(s=>s.id!=='first');}};
}
test('host follows selected terminal while preserving note and pasting without Enter',async()=>{
 const h=fixture();await h.settle();assert.equal(h.stored.get('draft').targetId,'first');
 await h.send({type:'editDraft',text:'A note\nwith two lines'});
 await h.send({type:'selectSession',id:'second'});
 assert.equal(h.stored.get('selected'),'second');assert.equal(h.stored.get('draft').targetId,'second');
 await h.send({type:'pasteDraft',text:'A note\nwith two lines'});
 assert.deepEqual(h.pasted,[{name:'Two',text:'\x1b[200~A note\nwith two lines\x1b[201~',submit:false}]);
});
test('closed recipient preserves draft and cannot redirect paste to another terminal',async()=>{
 const h=fixture();await h.settle();h.closeFirst();await h.send({type:'pasteDraft',text:'Keep this draft'});
 assert.equal(h.pasted.length,0);assert.ok(h.messages.some(m=>m.state?.status.includes('closed')));
 await h.send({type:'editDraft',text:'Keep this draft'});assert.equal(h.stored.get('draft').text,'Keep this draft');
});
test('capture runs only for selected pane while the sidebar is visible',async()=>{
 const h=fixture();await h.settle();assert.ok(h.captures.filter(args=>args[0]==='capture-pane').every(args=>args[args.indexOf('-t')+1]==='%1'));
 h.view.visible=false;const count=h.captures.length;await h.send({type:'refresh'});assert.equal(h.captures.length,count);
});
test('an in-flight attachment locks its recipient until transfer finishes',async()=>{
 const h=fixture();await h.settle();await h.send({type:'uploadStart',id:'test',name:'a.png',size:1});
 await h.send({type:'changeTarget',targetId:'second'});
 assert.equal(h.stored.get('draft').targetId,'first');assert.ok(h.messages.some(m=>m.state?.status.includes('Wait for the current upload')));
});
