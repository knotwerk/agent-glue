'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
function host(options={}){
 const commands=new Map(),listeners={},calls=[],terminals=options.terminals||[];
 let session='claude-fixture-20261014_120000',title='Fixture agent';
 const dispose=()=>({dispose(){}});
 const context={subscriptions:[],globalStorageUri:{fsPath:'/fake/storage'},globalState:{update:async()=>{}}};
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:{fsPath:'/fixture/workspace'}}]},extensions:{all:[]},commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return dispose();}},tasks:{registerTaskProvider:(name,provider)=>{listeners.tasks=provider;return dispose();}},TaskScope:{Workspace:1},Task:class{constructor(...args){this.args=args;}},ProcessExecution:class{constructor(...args){this.args=args;}},window:{terminals,showInformationMessage(){},showWarningMessage(){},onDidChangeTerminalState:fn=>{listeners.change=fn;return dispose();},onDidCloseTerminal:fn=>{listeners.close=fn;return dispose();},createTerminal:options=>{const terminal={...options,processId:Promise.resolve(42),dispose(){throw new Error('Unexpected terminal destruction');}};terminals.push(terminal);return terminal;}}};
 const child={
  exec(command,callback){calls.push(command);let stdout='';if(command.includes('list-sessions'))stdout=options.sessions?.()||[session,title,'','1700000000'].join('\x1f')+'\n';if(command.includes('list-clients'))stdout=options.clients?.()||'';if(command.startsWith('ps '))stdout=options.processes?.()||'';callback(null,stdout,'');},
  execFile(file,args,options,callback){if(typeof options==='function')callback=options;calls.push({file,args,options});let stdout='';if(file==='tmux'&&args[0]==='display-message')stdout='/fixture/actual-agent-project\n';if(file.endsWith('agent-tmux-rename.zsh')){session='claude-renamed-20261014_120000';title=args[1];stdout=session+'\n';}callback(null,stdout,'');}
 };
 // Node promisify honors this result shape for native child_process functions.
 for(const name of ['exec','execFile'])child[name][require('node:util').promisify.custom]=(...args)=>new Promise((resolve,reject)=>child[name](...args,(error,stdout,stderr)=>error?reject(error):resolve({stdout,stderr})));
 const sandbox={module:{exports:{}},require:name=>name==='vscode'?vscode:name==='child_process'?child:require(name),__dirname:path.resolve(__dirname,'..'),console,process,Date:options.Date||Date,setInterval:()=>1,clearInterval(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension.js'),'utf8'),sandbox);
 const api=sandbox.module.exports.activate(context);
 return {api,vscode,context,calls,listeners,terminals};
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
