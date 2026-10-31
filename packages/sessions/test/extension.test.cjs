'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function host(options={}){
 const commands=new Map(),listeners={},calls=[],messages=[],execOptions=[],terminals=options.terminals||[];
 let session='claude-fixture-20261014_120000',title='Fixture agent';
 const dispose=()=>({dispose(){}});
 const context={subscriptions:[],globalStorageUri:{fsPath:'/fake/storage'},globalState:options.globalState||{get:()=>undefined,update:async()=>{}}};
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:'/fixture/workspace'}}]},extensions:{all:[]},commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return dispose();}},tasks:{registerTaskProvider:(name,provider)=>{listeners.tasks=provider;return dispose();}},TaskScope:{Workspace:1},Task:class{constructor(...args){this.args=args;}},ProcessExecution:class{constructor(...args){this.args=args;}},window:{terminals,showInformationMessage(message){messages.push(message);},showWarningMessage(){},onDidChangeTerminalState:fn=>{listeners.change=fn;return dispose();},onDidCloseTerminal:fn=>{listeners.close=fn;return dispose();},onDidOpenTerminal:fn=>{listeners.open=fn;return dispose();},createTerminal:options=>{const terminal={...options,processId:Promise.resolve(42),dispose(){throw new Error('Unexpected terminal destruction');}};terminals.push(terminal);return terminal;}}};
 const child={
  exec(command,settings,callback){if(typeof settings==='function'){callback=settings;settings=undefined;}calls.push(command);execOptions.push(settings);if(options.exec)return options.exec(command,settings,callback);let stdout='';if(command.includes('list-sessions'))stdout=options.sessions?.()||[session,title,'','1700000000'].join('\x1f')+'\n';if(command.includes('list-clients'))stdout=options.clients?.()||'';if(command.startsWith('ps '))stdout=options.processes?.()||'';callback(null,stdout,'');},
  execFile(file,args,options,callback){if(typeof options==='function')callback=options;calls.push({file,args,options});let stdout='';if(file==='tmux'&&args[0]==='display-message')stdout='/fixture/actual-agent-project\n';if(file.endsWith('agent-tmux-rename.zsh')){session='claude-renamed-20261014_120000';title=args[1];stdout=session+'\n';}callback(null,stdout,'');}
 };
 // Node promisify honors this result shape for native child_process functions.
 for(const name of ['exec','execFile'])child[name][require('node:util').promisify.custom]=(...args)=>new Promise((resolve,reject)=>child[name](...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
 const sandbox={module:{exports:{}},require:name=>name==='vscode'?vscode:name==='child_process'?child:require(name),__dirname:path.resolve(__dirname,'..'),console,process,Date:options.Date||Date,setInterval:fn=>{listeners.intervals??=[];listeners.intervals.push(fn);return listeners.intervals.length;},clearInterval(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension.js'),'utf8'),sandbox);
 const api=sandbox.module.exports.activate(context);
 return {api,vscode,context,calls,listeners,terminals,messages,commands,execOptions};
}
test('Sessions attaches once and resolves exact session identity, not a similar title',async()=>{
 const h=host();await h.api.refresh();await h.api.refresh();
 assert.equal(h.terminals.length,1);
 const target=h.api.terminalForSession('claude-fixture-20261014_120000');assert.equal(target,h.terminals[0]);
 assert.equal(h.api.terminalForSession('Fixture agent'),undefined);
 assert.equal(h.api.sessionForTerminal(target),'claude-fixture-20261014_120000');
 assert.ok(target.shellPath.endsWith('/helpers/agent-tmux-attach.zsh'));
 assert.equal(target.env.AGENT_GLUE_WORKSPACE,'/fixture/workspace');
 assert.ok(target.env.AGENT_GLUE_TASKS_FILE.startsWith('/fake/storage/'));
 assert.equal(target.strictEnv,true,'tmux clients must opt out of extension environment injection');
 assert.equal(target.env.PATH,process.env.PATH,'strict environments retain the host launcher PATH');
 assert.equal(target.env.HOME,process.env.HOME);
});
test('rename uses actual agent cwd and preserves the tracked terminal',async()=>{
 const h=host();await h.api.refresh();h.terminals[0].name='Renamed agent';h.listeners.change(h.terminals[0]);await h.api.refresh();
 const call=h.calls.find(c=>c.file?.endsWith('agent-tmux-rename.zsh'));
 assert.equal(call.args[2],'/fixture/actual-agent-project');
 assert.equal(h.terminals.length,1);
 assert.equal(h.api.terminalForSession('claude-renamed-20261014_120000'),h.terminals[0]);
});


test('new session waits for its launching terminal to become a tmux client',async()=>{
 let now=1800000000000,connected=false;
 const session='claude-cool-spark-20270115_080000';
 const original={name:'tmux',processId:Promise.resolve(71),dispose(){assert.fail('must not close the launching terminal');}};
 const h=host({terminals:[original],Date:class extends Date{static now(){return now;}},
  sessions:()=>[session,'cool-spark','',String(1800000000),'$7','500'].join('\x1f')+'\n',
  clients:()=>connected?'72\x1f'+session+'\n':'',processes:()=> '72 71 tmux\n71 1 zsh\n'});
 await h.api.refresh();assert.equal(h.terminals.length,1,'must not attach while original client is starting');
 now+=5000;await h.api.refresh();assert.equal(h.terminals.length,1);
 connected=true;original.name='cool-spark';now+=6000;
 await Promise.all([h.api.refresh(),h.api.refresh(),h.api.refresh()]);
 assert.equal(h.terminals.length,1);assert.equal(h.api.terminalForSession(session),original);
});

test('fresh detached session is attached once after the startup grace period',async()=>{
 let now=1800000000000;
 const h=host({Date:class extends Date{static now(){return now;}},sessions:()=>['claude-cool-spark','cool-spark','',String(1800000000),'$8','500'].join('\x1f')+'\n'});
 await h.api.refresh();assert.equal(h.terminals.length,0);
 now+=11000;await Promise.all([h.api.refresh(),h.api.refresh()]);
 assert.equal(h.terminals.length,1);
});

test('session rename before client discovery preserves a pending attachment by tmux identity',async()=>{
 let session='claude-cool-spark';
 const h=host({sessions:()=>[session,'cool-spark','','1700000000','$9','500'].join('\x1f')+'\n'});
 await h.api.refresh();assert.equal(h.terminals.length,1);
 session='claude-cool-spark-renamed';await h.api.refresh();
 assert.equal(h.terminals.length,1);assert.equal(h.api.terminalForSession(session),h.terminals[0]);
});

test('identical titles in distinct tmux sessions are not merged',async()=>{
 const h=host({sessions:()=>['claude-one\x1fcool-spark\x1f\x1f1700000000\x1f$1\x1f500','claude-two\x1fcool-spark\x1f\x1f1700000001\x1f$2\x1f500'].join('\n')+'\n'});
 await h.api.refresh();await h.api.refresh();
 assert.equal(h.terminals.length,2);
 assert.notEqual(h.api.terminalForSession('claude-one'),h.api.terminalForSession('claude-two'));
});

test('a generated terminal label is never closed when the tmux session is named',async()=>{
 let session='claude-cool-spark',title='cool-spark',disposed=0;
 const terminal={name:'cool-spark',processId:Promise.resolve(71),dispose(){disposed++;}};
 const h=host({terminals:[terminal],sessions:()=>[session,title,'','1700000000','$7','500'].join('\x1f')+'\n',clients:()=>`71\x1f${session}\n`});
 await h.api.refresh();
 session='claude-mod';title='mod';
 await h.api.refresh();await h.api.refresh();
 assert.equal(disposed,0,'renaming must never terminate the original terminal');
 assert.equal(h.terminals.length,1);
 assert.equal(h.api.terminalForSession('claude-mod'),terminal);
});

test('client discovery runs after pending terminal process IDs resolve',async()=>{
 let connected=false;
 const session='claude-slow-launch';
 const terminal={name:'tmux',processId:{then(resolve){connected=true;resolve(71);}},dispose(){assert.fail('must preserve launcher');}};
 const h=host({terminals:[terminal],sessions:()=>[session,'slow-launch','','1700000000','$7','500'].join('\x1f')+'\n',clients:()=>connected?`72\x1f${session}\n`:'',processes:()=> '72 71 tmux\n71 1 zsh\n'});
 await h.api.refresh();
 assert.equal(h.terminals.length,1);
 assert.equal(h.api.terminalForSession(session),terminal);
});

test('slow Codex launcher is not duplicated after the ten-second grace expires',async()=>{
 let connected=false,now=1800000000000;
 const session='codex-calm-spark-20270115_080000';
 const original={name:'calm-spark',processId:Promise.resolve(71)};
 const h=host({terminals:[original],Date:class extends Date{static now(){return now;}},sessions:()=>[session,'calm-spark','',String(1800000000),'$7','500'].join('\x1f')+'\n',clients:()=>connected?`72\x1f${session}\n`:'',processes:()=> '72 71 tmux\n71 1 zsh\n'});
 await h.api.refresh();now+=60000;await h.api.refresh();
 assert.equal(h.terminals.length,1);
 assert.equal(h.api.sessionForTerminal(original),undefined,'title alone must not assign identity');
 connected=true;await h.api.refresh();
 assert.equal(h.terminals.length,1);assert.equal(h.api.terminalForSession(session),original);
});

test('detached session attaches after an unrelated matching shell changes its title',async()=>{
 const original={name:'calm-spark',processId:Promise.resolve(71)};
 const h=host({terminals:[original],sessions:()=>['codex-calm-spark','calm-spark','','1700000000','$7','500'].join('\x1f')+'\n'});
 await h.api.refresh();assert.equal(h.terminals.length,1);
 original.name='zsh';await h.api.refresh();assert.equal(h.terminals.length,2);
});


test('automatic restoration is quiet; explicit Attach still reports its result',async()=>{
 const h=host();await h.api.refresh();
 assert.deepEqual(h.messages,[]);
 h.commands.get('tmuxClaude.attachAll')();await h.api.refresh();
 assert.deepEqual(h.messages,['No new agent tmux sessions to attach']);
});

async function completes(promise) {
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Discovery stalled on a terminal PID')),500);})]);}finally{clearTimeout(timer);}
}
test('an unresolved terminal PID does not block known mappings or rename, and never creates an ambiguous duplicate',async()=>{
 let resolvePid,ready=false;
 const known={name:'Fixture agent',processId:Promise.resolve(71)};
 const pending={name:'tmux',processId:new Promise(resolve=>{resolvePid=resolve;})};
 const h=host({terminals:[known,pending],clients:()=> '71\x1fclaude-fixture-20261014_120000\n'+(ready?'72\x1fcodex-other\n':''),sessions:()=>['claude-fixture-20261014_120000\x1fFixture agent\x1f\x1f1700000000\x1f$1\x1f500','codex-other\x1fOther\x1f\x1f1700000001\x1f$2\x1f500'].join('\n')});
 await completes(h.api.refresh());assert.equal(h.api.sessionForTerminal(known),'claude-fixture-20261014_120000');assert.equal(h.terminals.length,2);
 known.name='Renamed agent';h.listeners.change(known);await completes(h.api.refresh());assert.ok(h.calls.some(c=>c.file?.endsWith('agent-tmux-rename.zsh')));
 ready=true;resolvePid(72);await new Promise(resolve=>setImmediate(resolve));await completes(h.api.refresh());assert.equal(h.api.sessionForTerminal(pending),'codex-other');assert.equal(h.terminals.length,2);
});

test('unchanged rename ticks do no discovery work and repeated pending attach ticks coalesce',async()=>{
 const h=host();await h.api.refresh();h.vscode.window.activeTerminal=h.terminals[0];
 let before=h.calls.length;
 for(let i=0;i<30;i++)h.listeners.intervals[0]();
 await h.api.refresh();assert.equal(h.calls.length-before,3,'only the explicit refresh should perform discovery');
 before=h.calls.length;for(let i=0;i<30;i++)h.listeners.intervals[1]();await h.api.refresh();
 assert.equal(h.calls.length-before,6,'one pending attach pass plus the explicit refresh');
 assert.ok(h.execOptions.every(o=>o.timeout===1500&&o.maxBuffer>=1024*1024));
});

test('failed session/client/process discovery preserves existing mappings and defers new attachments',async()=>{
 let fail;
 const h=host({exec:(command,settings,callback)=>{
  if(fail&&command.includes(fail))return callback(Object.assign(new Error('fixture timeout'),{killed:true}),'','');
  const stdout=command.includes('list-sessions')?'claude-one\x1fOne\x1f\x1f1700000000\x1f$1\x1f500\n':'';callback(null,stdout,'');
 }});
 await h.api.refresh();const terminal=h.terminals[0];
 for(const step of ['list-sessions','list-clients','ps -eo']){fail=step;await h.api.refresh();assert.equal(h.api.terminalForSession('claude-one'),terminal);assert.equal(h.terminals.length,1);}
 fail=undefined;await h.api.refresh();assert.equal(h.terminals.length,1);
});

test('a PID resolving during an older client snapshot cannot trigger a duplicate attachment',async()=>{
 let resolvePid,connected=false,snapshotTaken=false;
 const terminal={name:'tmux',processId:new Promise(resolve=>{resolvePid=resolve;})};
 const h=host({terminals:[terminal,{name:'zsh',processId:Promise.resolve(99)}],exec:(command,settings,callback)=>{
  let stdout='';if(command.includes('list-sessions'))stdout='codex-late\x1fLate\x1f\x1f1700000000\x1f$1\x1f500\n';
  if(command.includes('list-clients')){stdout=connected?'71\x1fcodex-late\n':'';if(!snapshotTaken){snapshotTaken=true;connected=true;resolvePid(71);}}
  callback(null,stdout,'');
 }});
 await h.api.refresh();await h.api.refresh();assert.equal(h.terminals.length,2);assert.equal(h.api.terminalForSession('codex-late'),terminal);
});

test('a terminal closing during discovery is not restored to the mapping',async()=>{
 const terminal={name:'One',processId:Promise.resolve(71)};let h;
 h=host({terminals:[terminal],exec:(command,settings,callback)=>{
  let stdout='';if(command.includes('list-sessions'))stdout='claude-one\x1fOne\x1f\x1f1700000000\x1f$1\x1f500\n';
  if(command.includes('list-clients')){stdout='71\x1fclaude-one\n';h.vscode.window.terminals.splice(0,1);}
  callback(null,stdout,'');
 }});
 await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),undefined);
});

const attachmentKey='agentTmuxRestore.attachments.v1';
const attachmentEnv='AGENT_GLUE_ATTACHMENT_TOKEN';
const attachmentToken='11111111-2222-4333-8444-555555555555';
const oneSession=()=> 'claude-one\x1fOne\x1f\x1f1700000000\x1f$1\x1f500\n';
function savedState(entries=[[attachmentToken,'500:$1:1700000000']]){
 const values=new Map([[attachmentKey,entries]]);
 return {get:key=>values.get(key),update:async(key,value)=>{values.set(key,value);}};
}
function pendingAttachment(token=attachmentToken){return {name:'One',processId:new Promise(()=>{}),creationOptions:{shellPath:'/old-extension/helpers/agent-tmux-attach.zsh',env:{[attachmentEnv]:token}}};}

test('a saved attachment identifies a restored terminal before its PID without process scans',async()=>{
 const terminal=pendingAttachment(),h=host({terminals:[terminal],globalState:savedState(),sessions:oneSession});
 await completes(h.api.refresh());
 assert.equal(h.api.terminalForSession('claude-one'),terminal);assert.equal(h.terminals.length,1);
 assert.ok(h.calls.every(call=>typeof call==='string'&&call.includes('list-sessions')));
});

test('new attachments save a token that remains usable in a new extension host after a session rename',async()=>{
 const state=savedState([]),first=host({globalState:state,sessions:oneSession});await first.api.refresh();
 const created=first.terminals[0],token=created.env[attachmentEnv];assert.match(token,/^[a-f0-9-]{36}$/);
 assert.equal(state.get(attachmentKey).length,1);
 const restored={name:'One',creationOptions:JSON.parse(JSON.stringify(created)),processId:new Promise(()=>{})};
 const second=host({terminals:[restored],globalState:state,sessions:()=>oneSession().replace('claude-one','claude-renamed')});
 await completes(second.api.refresh());assert.equal(second.api.terminalForSession('claude-renamed'),restored);assert.equal(second.terminals.length,1);
});

test('stale, unknown or malformed attachment records never identify a similarly named session',async()=>{
 for(const entries of [[[attachmentToken,'501:$1:1700000000']],[[attachmentToken,'500:$1:1700000001']],[[attachmentToken,'500:$2:1700000000']],[],{},[null,[attachmentToken,{}]]]){
  const terminal=pendingAttachment(),h=host({terminals:[terminal],globalState:savedState(entries),sessions:oneSession});
  await completes(h.api.refresh());assert.equal(h.api.sessionForTerminal(terminal),undefined);assert.equal(h.terminals.length,1);
 }
});

test('ordinary shells cannot inherit attachment identity, and lost launch metadata falls back when PID arrives',async()=>{
 for(const creationOptions of [{shellPath:'/bin/zsh',env:{[attachmentEnv]:attachmentToken}},{}]){
  let resolvePid,ready=false;const terminal={name:'One',creationOptions,processId:new Promise(resolve=>{resolvePid=resolve;})};
  const h=host({terminals:[terminal],globalState:savedState(),sessions:oneSession,clients:()=>ready?'71\x1fclaude-one\n':''});
  await completes(h.api.refresh());assert.equal(h.api.sessionForTerminal(terminal),undefined);
  ready=true;resolvePid(71);await new Promise(resolve=>setImmediate(resolve));await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),'claude-one');assert.equal(h.terminals.length,1);
 }
});

test('live PID evidence overrides a saved attachment pointing at a different live session',async()=>{
 const terminal=pendingAttachment();terminal.processId=Promise.resolve(71);
 const h=host({terminals:[terminal],globalState:savedState(),sessions:()=>oneSession()+'codex-two\x1fTwo\x1f\x1f1700000000\x1f$2\x1f500\n',clients:()=> '71\x1fcodex-two\n'});
 await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),'codex-two');
});

test('new terminal events identify ready terminals without waiting for a timer',async()=>{
 let ready=false;const h=host({sessions:()=>ready?oneSession():'claude-wait\x1fWait\x1f\x1f9999999999\x1f$9\x1f500\n',clients:()=>ready?'71\x1fclaude-one\n':''});await h.api.refresh();
 const terminal={name:'One',processId:Promise.resolve(71)};ready=true;h.terminals.push(terminal);h.listeners.open(terminal);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.api.sessionForTerminal(terminal),'claude-one');assert.equal(h.terminals.length,1);
});

test('slow attachment storage does not block startup, and several tokens use one write',async()=>{
 let writes=0;
 const h=host({sessions:()=>oneSession()+'codex-two\x1fTwo\x1f\x1f1700000000\x1f$2\x1f500\n',globalState:{get:()=>[],update:()=>{writes++;return new Promise(()=>{});}}});
 await completes(h.api.refresh());assert.equal(h.terminals.length,2);assert.equal(writes,1);
});

test('a burst of unchanged terminal state events causes no redundant process discovery',async()=>{
 const h=host();await h.api.refresh();const before=h.calls.length;
 for(let i=0;i<40;i++)h.listeners.change(h.terminals[0]);
 await h.api.refresh();assert.equal(h.calls.length-before,3,'only the explicit refresh should scan');
});

test('state events still preserve renames of multiple terminals',async()=>{
 const h=host({sessions:()=>oneSession()+'codex-two\x1fTwo\x1f\x1f1700000000\x1f$2\x1f500\n'});await h.api.refresh();
 const [a,b]=h.terminals;a.name='Alpha renamed';b.name='Beta renamed';h.listeners.change(a);h.listeners.change(b);h.listeners.change(a);
 await h.api.refresh();const titles=h.calls.filter(c=>c.file?.endsWith('agent-tmux-rename.zsh')).map(c=>c.args[1]);assert.deepEqual(titles,['alpha-renamed','beta-renamed']);
});
