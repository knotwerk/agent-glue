'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {TerminalActivity,terminalUri}=require('../src/terminal-activity.cjs');
function uri(value){const parsed=new URL(value);return {scheme:parsed.protocol.slice(0,-1),authority:parsed.host,path:parsed.pathname,query:parsed.search.slice(1),fragment:parsed.hash.slice(1),with(changes){const u=new URL(value);if(changes.fragment!==undefined)u.hash=changes.fragment;if(changes.query!==undefined)u.search=changes.query;return uri(u.href);},toString(){return value;}};}
function fixture(){
 const a={name:'Same label'},b={name:'Same label'},emitted=[];
 const vscode={Uri:{parse:uri},EventEmitter:class{constructor(){this.event=()=>{};}fire(v){emitted.push(v);}dispose(){}},ThemeColor:class{constructor(id){this.id=id;}},window:{terminals:[a,b],registerFileDecorationProvider:p=>({dispose(){}})}};
 const context={subscriptions:[]},provider=new TerminalActivity(vscode,context),sessions=[{id:'one',name:'Same label',sessionName:'claude-one',profile:'claude'},{id:'two',name:'Same label',sessionName:'codex-two',profile:'codex'}];
 const link={sessionForTerminal:t=>t===a?'claude-one':t===b?'codex-two':undefined};
 return {a,b,vscode,provider,sessions,link,emitted};
}
test('native tab URI validation rejects files, foreign schemes and commands',()=>{
 const h=fixture();for(const value of ['file:///project/a','https://example.com','vscode-terminal://remote/workspace/4','vscode-terminal:/workspace/0','vscode-terminal:/workspace/4?command=run'])assert.throws(()=>terminalUri(h.vscode,value));
 assert.equal(terminalUri(h.vscode,'vscode-terminal:/workspace/4#Label').fragment,'');
});
test('decorations target bound resource and terminal object, even with duplicate names',()=>{
 const h=fixture(),a=uri('vscode-terminal:/workspace/4'),b=uri('vscode-terminal:/workspace/7');
 h.provider.bind(a,h.a,h.sessions[0]);h.provider.bind(b,h.b,h.sessions[1]);
 const now=Date.now(),report=status=>({items:[{status,updatedAt:new Date(now).toISOString()}]});
 h.provider.update(h.sessions,{one:report('done'),two:report('blocked')},'one',false,h.link,now);
 assert.equal(h.provider.provideFileDecoration(a).color.id,'terminal.ansiGreen');assert.equal(h.provider.provideFileDecoration(b).color.id,'terminal.ansiRed');
 assert.equal(h.provider.provideFileDecoration(uri('file:///workspace/4')),undefined);
 assert.equal(h.provider.provideFileDecoration(uri('vscode-terminal:/other-window/4')),undefined);
 h.vscode.window.terminals=[h.b];assert.equal(h.provider.provideFileDecoration(a),undefined,'closed tab must never decorate a replacement');
 h.provider.update(h.sessions,{},'two',false,h.link,now);assert.equal(h.provider.bindings.size,1);
});
test('native working badge is compact with elapsed time; stale reports turn neutral',()=>{
 const h=fixture(),resource=uri('vscode-terminal:/workspace/4'),now=Date.now();h.provider.bind(resource,h.a,h.sessions[0]);
 for(let offset=0;offset<=65000;offset+=5000)h.provider.activity.observe('one','• Working (esc to interrupt)',now+offset);
 h.provider.update(h.sessions,{},'one',true,h.link,now+65000);
 let badge=h.provider.provideFileDecoration(resource);assert.equal(badge.badge,'1m');assert.equal(badge.color.id,'terminal.ansiYellow');assert.match(badge.tooltip,/1:05/);
 h.provider.update(h.sessions,{},'two',false,h.link,now+400000);assert.equal(h.provider.provideFileDecoration(resource).badge,'?');
 h.provider.update(h.sessions,{},'one',true,{sessionForTerminal:()=> 'different-session'},now);assert.equal(h.provider.provideFileDecoration(resource),undefined);
});
test('bindings are not persisted or revived against new terminal IDs',()=>{
 const h=fixture();h.provider.bind(uri('vscode-terminal:/workspace/4'),h.a,h.sessions[0]);h.provider.dispose();assert.equal(h.provider.bindings.size,0);
});
