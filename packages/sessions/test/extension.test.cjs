'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function host(options={}){
 const commands=new Map(),listeners={},calls=[],messages=[],execOptions=[],terminals=options.terminals||[];
 const optionsRename=options.rename,optionsExecFile=options.execFile;
 let session='claude-fixture-20261014_120000',title='Fixture agent';
 const dispose=()=>({dispose(){}});
 const context={subscriptions:[],globalStorageUri:{fsPath:'/fake/storage'},globalState:options.globalState||{get:()=>undefined,update:async()=>{}}};
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:'/fixture/workspace'}}]},extensions:{all:[]},commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return dispose();}},tasks:{registerTaskProvider:(name,provider)=>{listeners.tasks=provider;return dispose();}},TaskScope:{Workspace:1},Task:class{constructor(...args){this.args=args;}},ProcessExecution:class{constructor(...args){this.args=args;}},window:{terminals,showInformationMessage(message){messages.push(message);},showWarningMessage(){},onDidChangeTerminalState:fn=>{listeners.change=fn;return dispose();},onDidCloseTerminal:fn=>{listeners.close=fn;return dispose();},onDidOpenTerminal:fn=>{listeners.open=fn;return dispose();},createTerminal:options=>{const terminal={...options,creationOptions:options,processId:Promise.resolve(42),dispose(){throw new Error('Unexpected terminal destruction');}};terminals.push(terminal);return terminal;}}};
 const child={
  exec(command,settings,callback){if(typeof settings==='function'){callback=settings;settings=undefined;}calls.push(command);execOptions.push(settings);if(options.exec)return options.exec(command,settings,callback);let stdout='';if(command.includes('list-sessions'))stdout=options.sessions?options.sessions():[session,title,'','1700000000'].join('\x1f')+'\n';if(command.includes('list-clients'))stdout=options.clients?.()||'';if(command.startsWith('ps '))stdout=options.processes?.()||'';callback(null,stdout,'');},
  execFile(file,args,options,callback){if(typeof options==='function')callback=options;calls.push({file,args,options});if(optionsExecFile)return optionsExecFile(file,args,options,callback);let stdout='';if(file==='tmux'&&args[0]==='display-message')stdout='/fixture/actual-agent-project\n';if(file.endsWith('agent-tmux-rename.zsh')&&optionsRename){try{return callback(null,optionsRename(args)+'\n','');}catch(error){return callback(error,'','');}}if(file.endsWith('agent-tmux-rename.zsh')){session='claude-renamed-20261014_120000';title=args[1];stdout=session+'\n';}callback(null,stdout,'');}
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

test('ordinary shells become agent terminals after a new PID promise, across supported accounts',async()=>{
 for(const profile of ['claude','claude2','claudel','claudelp','codex','codex2','codex3','codexl']){
  let connected=false;
  const session=profile+'-keen-grove',terminal={name:'zsh',processId:Promise.resolve(undefined),creationOptions:{shellPath:'/bin/zsh'}};
  const h=host({terminals:[terminal],sessions:()=>connected?[session,'keen-grove','','1700000000','$7','500'].join('\x1f')+'\n':'',clients:()=>connected?`82\x1f${session}\n`:'',processes:()=> '82 81 tmux: client\n81 1 zsh\n'});
  await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),undefined);
  terminal.processId=Promise.resolve(81);terminal.name='tmux';connected=true;h.listeners.change(terminal);
  await h.api.refresh();
  assert.equal(h.api.sessionForTerminal(terminal),session,profile);assert.equal(h.api.titleForTerminal(terminal),'keen-grove');
  assert.equal(h.terminals.length,1,'adopt the launching shell rather than open a second client');
  assert.ok(!h.calls.some(c=>c.file?.endsWith('agent-tmux-rename.zsh')),'a process title is not a user rename');
  terminal.name='My chosen label';assert.equal(h.api.titleForTerminal(terminal),'My chosen label');
 }
});

test('relaunch with a changed numeric PID is rediscovered without waiting for or accepting an older promise',async()=>{
 let resolveOld,connected=false;
 const terminal={name:'tmux',processId:new Promise(resolve=>{resolveOld=resolve;}),creationOptions:{shellPath:'/bin/zsh'}};
 const h=host({terminals:[terminal],sessions:()=>connected?oneSession():'',clients:()=>connected?'81\x1fclaude-one\n':''});
 await completes(h.api.refresh());
 terminal.processId=Promise.resolve(81);connected=true;await completes(h.api.refresh());
 assert.equal(h.api.sessionForTerminal(terminal),'claude-one');assert.equal(h.terminals.length,1);
 resolveOld(71);await new Promise(resolve=>setImmediate(resolve));await completes(h.api.refresh());
 assert.equal(h.api.sessionForTerminal(terminal),'claude-one');assert.equal(h.terminals.length,1);
 terminal.processId=Promise.resolve(91);connected=false;await completes(h.api.refresh());
 assert.equal(h.api.sessionForTerminal(terminal),undefined,'a relaunched ordinary shell cannot retain its old agent dot');
});

test('a shell leaving tmux loses its old mapping even when its original PID stays alive',async()=>{
 let connected=true;
 const terminal={name:'tmux',processId:Promise.resolve(71),creationOptions:{shellPath:'/bin/zsh'}};
 const h=host({terminals:[terminal],sessions:oneSession,clients:()=>connected?'72\x1fclaude-one\n':'',processes:()=> '72 71 tmux\n71 1 zsh\n'});
 await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),'claude-one');
 connected=false;terminal.name='zsh';await h.api.refresh();
 assert.equal(h.api.sessionForTerminal(terminal),undefined);assert.equal(h.api.titleForTerminal(terminal),'zsh');
});

test('an undefined initial PID is unresolved, not permission to create a duplicate client',async()=>{
 const terminal={name:'tmux',processId:Promise.resolve(undefined),creationOptions:{shellPath:'/bin/zsh'}};
 const h=host({terminals:[terminal],sessions:oneSession,clients:()=> '71\x1fclaude-one\n'});
 await completes(h.api.refresh());assert.equal(h.terminals.length,1);assert.equal(h.api.sessionForTerminal(terminal),undefined);
 terminal.processId=Promise.resolve(71);await completes(h.api.refresh());
 assert.equal(h.terminals.length,1);assert.equal(h.api.sessionForTerminal(terminal),'claude-one');
});

test('a shell launching tmux with the same shell PID gains a session title on the next discovery',async()=>{
 for(const profile of ['claude','codex']){
  let connected=false;const session=profile+'-keen-grove';
  const terminal={name:'zsh',processId:Promise.resolve(71),creationOptions:{shellPath:'/bin/zsh'}};
  const h=host({terminals:[terminal],sessions:()=>connected?[session,'keen-grove','','1700000000','$7','500'].join('\x1f'):'',clients:()=>connected?`72\x1f${session}\n`:'',processes:()=> '72 71 tmux: client\n71 1 zsh\n'});
  await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),undefined);
  connected=true;terminal.name='tmux';h.listeners.change(terminal);await h.api.refresh();
  assert.equal(h.api.sessionForTerminal(terminal),session);assert.equal(h.api.titleForTerminal(terminal),'keen-grove');assert.equal(h.terminals.length,1);
 }
});

test('a PID promise replaced during client lookup cannot create a duplicate from the obsolete snapshot',async()=>{
 let connected=false,replaced=false;
 const terminal={name:'tmux',processId:Promise.resolve(71),creationOptions:{shellPath:'/bin/zsh'}};
 const h=host({terminals:[terminal],exec:(command,settings,callback)=>{
  let stdout='';if(command.includes('list-sessions')&&connected)stdout=oneSession();
  if(command.includes('list-clients')&&connected){
   if(replaced)stdout='81\x1fclaude-one\n';
   else {terminal.processId=Promise.resolve(81);replaced=true;}
  }
  callback(null,stdout,'');
 }});
 await h.api.refresh();connected=true;await h.api.refresh();
 assert.equal(h.terminals.length,1,'the old PID snapshot is incomplete after replacement');
 await h.api.refresh();assert.equal(h.api.sessionForTerminal(terminal),'claude-one');assert.equal(h.terminals.length,1);
});

test('rename before client discovery is retained even when the terminal becomes inactive',async()=>{
 let connected=false,renamed=false;
 const terminal={name:'tmux',processId:Promise.resolve(71)};
 const h=host({terminals:[terminal],sessions:()=> 'claude-keen-grove\x1fkeen-grove\x1f\x1f9999999999\x1f$1\x1f500\n',clients:()=>connected?'71\x1fclaude-keen-grove\n':'',rename:()=>{renamed=true;return 'claude-research';}});
 await h.api.refresh();terminal.name='Research';h.listeners.change(terminal);await h.api.refresh();assert.equal(renamed,false);
 h.vscode.window.activeTerminal=undefined;connected=true;await h.api.refresh();
 assert.equal(renamed,true);assert.equal(h.terminals.length,1);assert.equal(h.api.sessionForTerminal(terminal),'claude-research');
});

test('explicit rename reports persistence failure instead of accepting a local-only title',async()=>{
 const h=host({rename:()=>{throw new Error('fixture rename failure');}});await h.api.refresh();
 const terminal=h.terminals[0];await assert.rejects(h.api.renameTerminal(terminal,'Research'),/could not be renamed/);
 assert.equal(terminal.name,'Fixture agent');assert.equal(h.api.sessionForTerminal(terminal),'claude-fixture-20261014_120000');
 await h.api.refresh();assert.equal(h.terminals.length,1);
});

test('session, client and process queries overlap without waiting on pending terminal PIDs',async()=>{
 const held=new Map();let hold=false;
 const terminal={name:'zsh',processId:Promise.resolve(71)};
 const h=host({terminals:[terminal],exec:(command,settings,callback)=>{
  if(hold){held.set(command,callback);return;}callback(null,'','');
 }});await h.api.refresh();hold=true;
 const work=h.api.refresh();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(held.size,3,'all independent discovery queries must start before any completes');
 for(const callback of held.values())callback(null,'','');await completes(work);
});

// Full cross-extension workflow with native objects replaced on reload. No live
// terminal, process, transcript or account directory is read by this test.
test('create, launch, rename, reorder and reload keep one named agent with its dot and position',async()=>{
 const {registerSelector}=require('../../companion/src/terminal-selector.cjs');
 for(const profile of ['claude','codex']){
  let connected=false,title='keen-grove',session=profile+'-keen-grove';
  const state=savedState([]),values=new Map();
  const options={globalState:state,sessions:()=>connected?[session,title,title==='keen-grove'?'':title,'1700000000','$7','500'].join('\x1f')+'\n':'',clients:()=>connected?`72\x1f${session}\n`:'',processes:()=> '72 71 tmux: client\n71 1 zsh\n',rename:args=>{title=args[1];session=profile+'-'+title;return session;}};
  function selector(h){
   const commands=new Map(),noop=()=>({dispose(){}});
   const window={...h.vscode.window,showInputBox:async()=> 'Research',showErrorMessage:message=>assert.fail(message),createTreeView:()=>({visible:false,reveal:async()=>{},onDidChangeVisibility:noop,dispose(){}})};
   for(const key of ['onDidOpenTerminal','onDidCloseTerminal','onDidChangeActiveTerminal','onDidChangeTerminalState'])window[key]=noop;
   const vscode={...h.vscode,window,Uri:{file:fsPath=>({fsPath})},ThemeIcon:class{constructor(id){this.id=id;}},EventEmitter:class{event=()=>{};fire(){}dispose(){}},DataTransferItem:class{},commands:{registerCommand:(key,fn)=>{commands.set(key,fn);return noop();},executeCommand:async(key,args)=>{if(key==='workbench.action.terminal.renameWithArg'){window.activeTerminal.name=args.name;h.listeners.change(window.activeTerminal);}}}};
   const context={subscriptions:[],workspaceState:{get:(key,fallback)=>values.get(key)??fallback,update:async(key,value)=>values.set(key,value)}};
   const tree=registerSelector(vscode,context,h.api.sessionForTerminal,()=>({status:'active',label:'Working'}),()=>'/fixture',h.api.titleForTerminal,h.api);
   for(const terminal of h.terminals)terminal.show=()=>{window.activeTerminal=terminal;};
   return {...tree,commands,window};
  }
  const other={name:'Other',processId:Promise.resolve(99)};
  const h=host({...options,terminals:[other]});await h.api.refresh();const tree=selector(h);tree.provider.getChildren();
  const terminal={name:'zsh',processId:Promise.resolve(71),creationOptions:{shellPath:'/bin/zsh'}};
  terminal.show=()=>{tree.window.activeTerminal=terminal;};h.terminals.push(terminal);h.listeners.open(terminal);await h.api.refresh();tree.refresh();
  assert.equal(tree.provider.getTreeItem(terminal).iconPath.id,'terminal');
  const transfer=new Map();tree.dragAndDropController.handleDrag([terminal],transfer);await tree.dragAndDropController.handleDrop(other,transfer);
  connected=true;terminal.name='tmux';await tree.commands.get('agentGlue.renameSelectorTerminal')(terminal);await h.api.refresh();tree.refresh();
  assert.equal(title,'research');assert.equal(h.terminals.length,2);assert.equal(tree.provider.getTreeItem(terminal).label,'Research');
  assert.match(tree.provider.getTreeItem(terminal).iconPath.dark.fsPath,/status-amber/);
  assert.equal(tree.provider.getChildren()[0],terminal);assert.ok(values.get('terminalSelector.order')[0].startsWith('tmux-id:'));
  // Reload with existing native terminals, in a different enumeration order.
  const restored={...terminal,processId:Promise.resolve(71)};
  const second=host({...options,terminals:[{...other},restored]});const again=selector(second);again.provider.getChildren();await second.api.refresh();again.refresh();
  assert.equal(second.terminals.length,2);assert.equal(again.provider.getChildren()[0],restored);assert.equal(again.provider.getTreeItem(restored).label,'Research');
  assert.match(again.provider.getTreeItem(restored).iconPath.dark.fsPath,/status-amber/);
  // Reload after VS Code lost its ordinary shell: restore from tmux's saved
  // title and stable identity, preserving the same selector position.
  connected=true;const third=host({...options,terminals:[{...other}],clients:()=>''});await third.api.refresh();await third.api.refresh();
  const final=selector(third),attached=third.api.terminalForSession(session);
  assert.equal(third.terminals.length,2);assert.ok(attached);assert.equal(final.provider.getChildren()[0],attached);
  assert.equal(final.provider.getTreeItem(attached).label,'research');assert.match(final.provider.getTreeItem(attached).iconPath.dark.fsPath,/status-amber/);
 }
});

test('explicit rename of an unmapped tmux tab fails visibly, rather than saving only its label',async()=>{
 const terminal={name:'tmux',processId:Promise.resolve(71)};
 const h=host({terminals:[terminal],sessions:()=>''});await h.api.refresh();
 await assert.rejects(h.api.renameTerminal(terminal,'Research'),/still being identified/);
 assert.equal(terminal.name,'tmux');
});

test('explicit shell name before launch is saved once that exact shell connects',async()=>{
 let connected=false;
 const terminal={name:'zsh',processId:Promise.resolve(71)};
 const h=host({terminals:[terminal],sessions:()=>connected?'claude-keen-grove\x1fkeen-grove\x1f\x1f1700000000\x1f$7\x1f500\n':'',clients:()=>connected?'71\x1fclaude-keen-grove\n':''});
 await h.api.refresh();await h.api.renameTerminal(terminal,'Research');terminal.name='Research';h.listeners.change(terminal);await h.api.refresh();
 connected=true;terminal.name='tmux';h.listeners.change(terminal);await h.api.refresh();
 assert.ok(h.calls.some(c=>c.file?.endsWith('agent-tmux-rename.zsh')&&c.args[1]==='research'));assert.equal(h.terminals.length,1);
});

test('restored helper with a ready PID but a late client retains its token mapping without a duplicate',async()=>{
 const terminal=pendingAttachment();terminal.processId=Promise.resolve(71);
 const h=host({terminals:[terminal],globalState:savedState(),sessions:oneSession});
 await h.api.refresh();await h.api.refresh();assert.equal(h.terminals.length,1);
 assert.equal(h.api.sessionForTerminal(terminal),'claude-one');assert.equal(h.api.identityForTerminal(terminal),'500:$1:1700000000');
});

test('terminating an agent requires named confirmation and stops only its verified session',async()=>{
 let stopped=false,disposed=0;
 const h=host({sessions:()=>stopped?'':oneSession(),execFile:(file,args,options,callback)=>{
  assert.equal(file,'tmux');assert.deepEqual(Array.from(args),['if-shell','-F','-t','$1:','#{&&:#{==:#{pid},500},#{==:#{session_created},1700000000}}',"kill-session -t '$1'",'display-message -p agent-glue-target-changed']);
  assert.equal(options.timeout,1500);stopped=true;callback(null,'','');
 }});await h.api.refresh();const terminal=h.terminals[0];terminal.dispose=()=>{disposed++;h.terminals.splice(h.terminals.indexOf(terminal),1);};
 h.vscode.window.showWarningMessage=async(message,options,action)=>{
  assert.match(message,/One/);assert.equal(options.modal,true);assert.match(options.detail,/claude-one/);assert.match(options.detail,/all processes/);assert.equal(action,'Terminate');assert.equal(stopped,false);return action;
 };
 await h.api.terminateTerminal(terminal);await h.api.refresh();assert.equal(stopped,true);assert.equal(disposed,1);assert.equal(h.terminals.length,0,'terminated sessions do not reattach');
});

test('cancel and dismiss never terminate an agent or close its tab',async()=>{
 for(const answer of [undefined,'Cancel']){
  const h=host({sessions:oneSession});await h.api.refresh();const terminal=h.terminals[0];
  h.vscode.window.showWarningMessage=async()=>answer;assert.equal(await h.api.terminateTerminal(terminal),true);
  assert.equal(h.terminals.length,1);assert.ok(!h.calls.some(c=>c.file==='tmux'&&c.args[0]==='if-shell'));
 }
});

test('termination rejects changed identities, moved clients and closed tabs after confirmation',async()=>{
 for(const change of ['identity','client','closed']){
  let changed=false;const terminal={name:'One',processId:Promise.resolve(71),dispose(){assert.fail('must not close an unconfirmed target');}};
  const h=host({terminals:[terminal],sessions:()=>oneSession().replace('500',changed&&change==='identity'?'501':'500'),clients:()=>changed&&change==='client'?'':'71\x1fclaude-one\n'});await h.api.refresh();
  h.vscode.window.showWarningMessage=async()=>{changed=true;if(change==='closed')h.terminals.length=0;return 'Terminate';};
  await assert.rejects(h.api.terminateTerminal(terminal),/changed|no longer open/);
  assert.ok(!h.calls.some(c=>c.file==='tmux'&&c.args[0]==='if-shell'));
 }
});

test('tmux failure or an atomic identity mismatch leaves the terminal open',async()=>{
 for(const failed of [false,true]){
  const h=host({sessions:oneSession,execFile:(file,args,options,callback)=>callback(failed?Error('fixture failure'):null,failed?'':'agent-glue-target-changed\n','')});await h.api.refresh();
  h.vscode.window.showWarningMessage=async()=> 'Terminate';await assert.rejects(h.api.terminateTerminal(h.terminals[0]),/changed|fixture failure/);
  assert.equal(h.terminals.length,1);
 }
});

test('ordinary shells are handed back for local confirmation and pending confirmation does not block discovery',async()=>{
 const shell={name:'zsh',processId:Promise.resolve(99)},h=host({terminals:[shell],sessions:oneSession});await h.api.refresh();
 assert.equal(await h.api.terminateTerminal(shell),false);
 let confirm;h.vscode.window.showWarningMessage=()=>new Promise(resolve=>{confirm=resolve;});
 const pending=h.api.terminateTerminal(h.terminals[1]);await new Promise(resolve=>setImmediate(resolve));
 await completes(h.api.refresh());confirm(undefined);await pending;
});
