'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {profile,resolveThread,forkSession}=require('../fork.cjs');
const parent='01900000-0000-7000-8000-000000000001',child='01900000-0000-7000-8000-000000000002';
test('account variants retain separate configuration directories',()=>{assert.equal(profile('codex2').envKey,'CODEX_HOME');assert.ok(profile('claudelp').home.endsWith('/.claudelp'));assert.throws(()=>profile('bash'));});
test('Claude resolves PID metadata without reading conversation histories',async()=>{
 let readPath;const id=await resolveThread(42,profile('claude'),async()=>({stdout:'Thu Oct 29 12:00:00 2026'}),async file=>{readPath=file;return JSON.stringify({pid:42,sessionId:parent,startedAt:Date.parse('2026-10-29T12:00:00Z')});});
 assert.equal(id,parent);assert.ok(readPath.endsWith('/sessions/42.json'));
});
test('Codex refuses conflicting descriptors rather than choosing latest',async()=>{
 const account=profile('codex');await assert.rejects(resolveThread(42,account,async()=>({stdout:`n${account.home}/sessions/rollout-${parent}.jsonl\nn${account.home}/sessions/rollout-${child}.jsonl`})),/unambiguous/);
});
function fixture(program='claude'){
 const calls=[],terminals=[],notes=[];const source={id:'500:$1:100',pane:'%1',name:'Example',profile:program};
 const deps={writeHandoff:async(dir,text)=>{notes.push(text);return '/private/fork-notice.txt';},readAccount:async(pid,account)=>account,stat:async()=>({isDirectory:()=>true}),resolve:async()=>parent,
 exec:async(cmd,args,options)=>{calls.push({cmd,args,options});return {stdout:args.includes('--help')?'--json --fork-session --session-id':cmd==='ps'?`20 10 ${program.startsWith('codex')?'codex':'claude'}`:cmd==='codex'?JSON.stringify({type:'thread.started',thread_id:child}):args[0]==='new-session'?'$9':args[0]==='display-message'?'$1\x1f500\x1f100\x1f10\x1f/source':''};},
 createTerminal:options=>{const terminal={...options,show(){this.shown=true;}};terminals.push(terminal);return terminal;},register:(session,terminal)=>{terminal.registered=session;}};
 return {source,deps,calls,terminals,notes};
}
test('Claude creates one independently identified fork without typing in original pane',async()=>{
 const h=fixture();const result=await forkSession(h.source,"/different folder's path",h.deps);
 assert.equal(h.terminals.length,1);assert.equal(h.terminals[0].cwd,"/different folder's path");assert.equal(h.terminals[0].registered,result.session);assert.equal(h.terminals[0].shown,true);assert.equal(h.terminals[0].strictEnv,true);assert.equal(h.terminals[0].env.PATH,process.env.PATH);
 const launch=h.calls.find(c=>c.args[0]==='new-session');assert.ok(launch.args.at(-1).includes('--fork-session'));assert.ok(launch.args.at(-1).includes(parent));assert.notEqual(result.threadId,parent);
 assert.ok(h.calls.every(c=>!['send-keys','kill-session','kill-pane'].includes(c.args[0])));
});
test('Codex forks without a prompt before opening the child in selected folder',async()=>{
 const h=fixture('codex2');const result=await forkSession(h.source,'/other',h.deps);
 const fork=h.calls.find(c=>c.cmd==='codex'&&!c.args.includes('--help'));assert.deepEqual(fork.args,['exec','-C','/other','--json','fork',parent]);assert.ok(fork.options.env.CODEX_HOME.endsWith('.codex2'));assert.equal(result.threadId,child);
 assert.ok(h.calls.find(c=>c.args[0]==='new-session').args.at(-1).includes(child));
});
for(const program of ['claudelp','codex2'])test(`${program} receives ownership and deferred compaction guidance only in the child`,async()=>{
 const h=fixture(program),result=await forkSession(h.source,'/other',h.deps);
 assert.equal(h.notes.length,1);const note=h.notes[0];
 assert.match(note,/wait for the user to give this branch its first task/);
 assert.match(note,/Do not continue the inherited task or compact yet/);
 assert.match(note,/After that first task is given/);assert.match(note,/suggest compaction/);
 assert.match(note,/never means stopping processes, deleting files or resuming inherited subagents/);
 assert.match(note,/remain with the parent/);assert.match(note,/Preserve this notice/);
 const metadata=JSON.parse(note.slice(note.indexOf('\n{')+1));assert.equal(metadata.parentThreadId,parent);assert.equal(metadata.parentName,'Example');assert.equal(metadata.destination,'/other');assert.ok(Number.isFinite(Date.parse(metadata.createdAt)));
 const command=h.calls.find(c=>c.args[0]==='new-session').args.at(-1);
 assert.match(command,/NEW branch/);assert.match(command,/Do not continue the inherited task or compact yet/);assert.ok(command.includes(result.forkNoticeFile));
 const mutations=h.calls.filter(c=>c.cmd==='tmux'&&c.args[0]!=='display-message');
 assert.ok(mutations.every(c=>c.args[0]==='new-session'||(c.args[0]==='set-option'&&c.args[2]==='$9')),'only newly created tmux session may be changed');
 assert.ok(mutations.some(c=>c.args[3]==='@agent_glue_parent_thread_id'&&c.args[4]===parent));
 assert.ok(mutations.some(c=>c.args[3]==='@agent_glue_fork_notice_file'&&c.args[4]===result.forkNoticeFile));
});
test('notice storage failure prevents creating a fork or terminal',async()=>{
 const h=fixture('codex');h.deps.writeHandoff=async()=>{throw Error('notice storage unavailable');};
 await assert.rejects(forkSession(h.source,'/other',h.deps),/notice storage unavailable/);
 assert.equal(h.terminals.length,0);assert.ok(!h.calls.some(c=>c.args[0]==='new-session'||(c.cmd==='codex'&&!c.args.includes('--help'))));
});
test('child CLI receives the entire notice as one literal prompt argument',async()=>{
 const fs=require('node:fs'),path=require('node:path'),{tempDir}=require('../../../test/support/tmp.cjs');
 const execFile=require('node:util').promisify(require('node:child_process').execFile),dir=tempDir('fork-notice-argv');
 for(const cli of ['claude','codex'])fs.writeFileSync(path.join(dir,cli),`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});
 fs.writeFileSync(path.join(dir,'zsh'),'#!/bin/sh\nexit 0\n',{mode:0o700});
 for(const cli of ['claude','codex']){
  const h=fixture(cli);h.source.name="O'Brien $(must-not-run)";
  const noticePath="/private/fork's $(literal) note.txt";h.deps.writeHandoff=async()=>noticePath;
  await forkSession(h.source,dir,h.deps);
  const command=h.calls.find(c=>c.args[0]==='new-session').args.at(-1);
  const result=await execFile('/bin/sh',['-c',command],{env:{PATH:dir},cwd:dir});
  const args=JSON.parse(result.stdout.split('\n')[0]),prompt=args.at(-1);
  assert.match(prompt,/NEW branch/);assert.match(prompt,/remain with the parent/);assert.ok(prompt.includes(JSON.stringify(noticePath)));
  assert.equal(args.filter(arg=>arg.includes('NEW branch')).length,1);assert.equal(result.stderr,'');
  if(cli==='claude')assert.ok(args.includes(parent));else assert.deepEqual(args.slice(0,2),['resume',child]);
 }
});
test('stale source identity and failed native fork create no terminal',async()=>{
 const h=fixture();h.source.id='replaced';await assert.rejects(forkSession(h.source,'/other',h.deps),/changed/);assert.equal(h.terminals.length,0);
 const c=fixture('codex');const run=c.deps.exec;c.deps.exec=async(...args)=>{if(args[0]==='codex')throw Error('unsupported');return run(...args);};await assert.rejects(forkSession(c.source,'/other',c.deps),/unsupported/);assert.equal(c.terminals.length,0);
});
test('metadata fallback requires one directory/account/process-era match, not nearest time',()=>{
 const {metadataMatches}=require('../fork.cjs');const start=Date.parse('2026-10-29T12:00:00Z');
 const rows=[{id:parent,cwd:'/project',source:'cli',timestamp:'2026-10-29T12:00:01Z'},{id:child,cwd:'/project',source:'cli',timestamp:'2026-10-29T12:01:00Z'}];
 assert.equal(metadataMatches(rows,'/project',start).length,2);assert.deepEqual(metadataMatches(rows.slice(1),'/project',start),[]);assert.deepEqual(metadataMatches(rows,'/other',start),[]);assert.deepEqual(metadataMatches(rows,'/project',start+120000),[]);
});

test('an immediately failing CLI leaves the new shell available before tmux labeling and attachment',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 const {tempDir}=require('../../../test/support/tmp.cjs');
 const execFile=require('node:util').promisify(require('node:child_process').execFile);
 const dir=tempDir('fork-startup-failure');
 fs.writeFileSync(path.join(dir,'claude'),'#!/bin/sh\necho "synthetic startup failure" >&2\nexit 23\n',{mode:0o700});
 fs.writeFileSync(path.join(dir,'zsh'),'#!/bin/sh\necho "fallback-shell-ready"\n',{mode:0o700});
 const h=fixture('claudelp'),run=h.deps.exec;let shellReady=false,output;
 h.deps.exec=async(cmd,args,options)=>{
  if(cmd==='tmux'&&args[0]==='new-session'){
   const shellIndex=args.indexOf('/bin/sh');assert.ok(shellIndex>0);
   output=await execFile(args[shellIndex],args.slice(shellIndex+1),{env:{PATH:dir},cwd:dir});
   shellReady=output.stdout.includes('fallback-shell-ready');
  }
  if(cmd==='tmux'&&args[0]==='set-option'){
   if(!shellReady)throw Error('no such session: fork exited');
   assert.equal(args[2],'$9','label by stable tmux identity');
  }
  return run(cmd,args,options);
 };
 await forkSession(h.source,dir,h.deps);
 assert.match(output.stderr,/synthetic startup failure/);
 assert.match(output.stdout,/status 23/);
 assert.equal(h.terminals.length,1);assert.equal(h.terminals[0].shown,true);assert.equal(h.terminals[0].strictEnv,true);assert.equal(h.terminals[0].env.PATH,process.env.PATH);
});

for(const [sourceProgram,targetProgram] of [['claude','codex2'],['codex','claudel'],['claude','claude2']]){
 test(`handoff ${sourceProgram} to ${targetProgram} starts one fresh conversation with private context`,async()=>{
  const h=fixture(sourceProgram);let note;
  h.deps.writeHandoff=async(directory,text)=>{note=text;return "/private/handoff's note.txt";};
  const result=await forkSession(h.source,'/other',h.deps,{profile:targetProgram,status:'Model: Example model',tasks:'Fix the report'});
  assert.equal(h.terminals.length,1);assert.ok(result.session.startsWith(targetProgram+'-Example-'));
  assert.match(note,/NEW conversation/);assert.ok(note.includes(parent));assert.match(note,/Model: Example model/);assert.match(note,/Fix the report/);assert.match(note,/~\/.zshrc/);
  const launch=h.calls.find(c=>c.args[0]==='new-session').args.at(-1);
  assert.ok(launch.includes(profile(targetProgram).home));assert.ok(launch.includes('handoff'));assert.ok(!launch.includes('--resume'));assert.ok(!launch.includes('--fork-session'));
  assert.ok(!launch.includes('Example model'),'private status is not placed in process arguments');
  assert.ok(h.calls.every(c=>!['send-keys','capture-pane','kill-session'].includes(c.args[0])));
  assert.equal(h.calls.filter(c=>c.cmd==='codex'&&!c.args.includes('--help')).length,0,'no headless fork call for a fresh handoff');
  if(targetProgram.startsWith('codex'))assert.equal(result.threadId,undefined,'never fabricate a Codex resume identity');
 });
}
test('handoffs tolerate unavailable source identity but reject invalid target and oversize notes',async()=>{
 const h=fixture();h.deps.resolve=async()=>{throw Error('not yet saved');};let note;
 h.deps.writeHandoff=async(dir,text)=>{note=text;return '/private/handoff.txt';};
 await forkSession(h.source,'/other',h.deps,{profile:'codex',status:'',tasks:''});assert.match(note,/Unknown/);
 const invalid=fixture();await assert.rejects(forkSession(invalid.source,'/other',invalid.deps,{profile:'sh; bad',status:'',tasks:''}),/Unsupported/);
 await assert.rejects(forkSession(invalid.source,'/other',invalid.deps,{profile:'codex',status:'x'.repeat(16001),tasks:''}),/too long/);assert.equal(invalid.terminals.length,0);
});
test('handoff notes are private unique files outside the project',async()=>{
 const {saveHandoff}=require('../fork.cjs'),fs=require('node:fs/promises');
 const {tempDir}=require('../../../test/support/tmp.cjs');const dir=tempDir('handoff-private');
 const a=await saveHandoff(dir,'Synthetic context'),b=await saveHandoff(dir,'Other context');
 assert.notEqual(a,b);assert.equal(await fs.readFile(a,'utf8'),'Synthetic context');assert.equal((await fs.stat(a)).mode&0o777,0o600);
});

test('Linux account discovery uses only the running process account path, not the tmux prefix',async()=>{
 const {processAccount}=require('../fork.cjs');const configured=profile('claudelp');let file;
 const actual=await processAccount(42,profile('claude'),{platform:'linux',read:async p=>{file=p;return 'HOME=/fixture\0CLAUDE_CONFIG_DIR='+configured.home+'\0API_KEY=synthetic-secret\0UNRELATED=ignored\0';}});
 assert.equal(file,'/proc/42/environ');assert.equal(actual.home,configured.home);assert.equal(actual.program,'claudelp');assert.equal(actual.cli,'claude');assert.ok(!JSON.stringify(actual).includes('synthetic-secret'));
 const codex=await processAccount(42,profile('codex2'),{platform:'linux',read:async()=> 'HOME=/fixture\0'});assert.equal(codex.home,'/fixture/.codex');
 await assert.rejects(processAccount(42,profile('claude'),{platform:'linux',read:async()=>{throw Error('denied');}}),/Cannot verify/);
 await assert.rejects(processAccount(42,profile('claude'),{platform:'linux',read:async()=> 'CLAUDE_CONFIG_DIR=relative\0'}),/not absolute/);
});

test('Claude live listing resolves exactly one current process without opening session files',async()=>{
 const account=profile('claudelp'),start='Thu Oct 29 12:00:00 2026';let listed=false;
 const id=await resolveThread(42,account,async(command,args,options)=>{
  if(command==='ps')return {stdout:start};
  assert.equal(command,'claude');assert.deepEqual(args,['agents','--json']);assert.equal(options.env.CLAUDE_CONFIG_DIR,account.home);assert.equal(options.timeout,5000);listed=true;
  return {stdout:JSON.stringify([{pid:7,sessionId:child,startedAt:Date.parse(start)},{pid:42,sessionId:parent,startedAt:Date.parse(start)}])};
 },async()=>assert.fail('live listing must not read any session/history files'));
 assert.equal(listed,true);assert.equal(id,parent);
});

test('Claude live identity rejects ambiguous, stale, future and malformed process metadata',()=>{
 const {claudeIdentity}=require('../fork.cjs'),start=Date.parse('2026-10-29T12:00:00Z'),row={pid:42,sessionId:parent,startedAt:start};
 assert.throws(()=>claudeIdentity([row,{...row,sessionId:child}],42,start,start),/multiple conversations/);
 for(const candidate of [{...row,pid:43},{...row,startedAt:start-3000},{...row,startedAt:start+3000},{...row,startedAt:'bad'},{...row,sessionId:'bad'}])assert.equal(claudeIdentity([candidate],42,start,start),undefined);
 assert.equal(claudeIdentity([row],42,NaN,start),undefined);
});

test('a mislabeled Claude tmux session forks under the running claudelp account',async()=>{
 const h=fixture('claude');h.deps.readAccount=async(pid,account)=>{assert.equal(pid,'20');assert.equal(account.program,'claude');return profile('claudelp');};
 h.deps.resolve=async(pid,account)=>{assert.equal(account.program,'claudelp');assert.equal(account.home,profile('claudelp').home);return parent;};
 const result=await forkSession(h.source,'/other',h.deps);
 assert.ok(result.session.startsWith('claudelp-'));assert.equal(h.terminals.length,1);
 assert.equal(h.calls.find(c=>c.args.includes('--help')).options.env.CLAUDE_CONFIG_DIR,profile('claudelp').home);
 const launch=h.calls.find(c=>c.args[0]==='new-session').args.at(-1);assert.ok(launch.includes(profile('claudelp').home));assert.ok(launch.includes(parent));assert.ok(launch.includes('--fork-session'));
 assert.ok(h.calls.every(c=>!['send-keys','capture-pane','kill-session'].includes(c.args[0])));
});

test('unreadable running account prevents creation instead of guessing from the session label',async()=>{
 const h=fixture();h.deps.readAccount=async()=>{throw Error('Cannot verify the running CLI account');};
 await assert.rejects(forkSession(h.source,'/other',h.deps),/Cannot verify/);
 assert.equal(h.terminals.length,0);assert.ok(!h.calls.some(c=>c.args[0]==='new-session'));
});
