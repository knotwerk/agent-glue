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
 const calls=[],terminals=[];const source={id:'500:$1:100',pane:'%1',name:'Example',profile:program};
 const deps={stat:async()=>({isDirectory:()=>true}),resolve:async()=>parent,
 exec:async(cmd,args,options)=>{calls.push({cmd,args,options});return {stdout:args.includes('--help')?'--json --fork-session --session-id':cmd==='ps'?`20 10 ${program.startsWith('codex')?'codex':'claude'}`:cmd==='codex'?JSON.stringify({type:'thread.started',thread_id:child}):args[0]==='new-session'?'$9':args[0]==='display-message'?'$1\x1f500\x1f100\x1f10\x1f/source':''};},
 createTerminal:options=>{const terminal={...options,show(){this.shown=true;}};terminals.push(terminal);return terminal;},register:(session,terminal)=>{terminal.registered=session;}};
 return {source,deps,calls,terminals};
}
test('Claude creates one independently identified fork without typing in original pane',async()=>{
 const h=fixture();const result=await forkSession(h.source,"/different folder's path",h.deps);
 assert.equal(h.terminals.length,1);assert.equal(h.terminals[0].cwd,"/different folder's path");assert.equal(h.terminals[0].registered,result.session);assert.equal(h.terminals[0].shown,true);
 const launch=h.calls.find(c=>c.args[0]==='new-session');assert.ok(launch.args.at(-1).includes('--fork-session'));assert.ok(launch.args.at(-1).includes(parent));assert.notEqual(result.threadId,parent);
 assert.ok(h.calls.every(c=>!['send-keys','kill-session','kill-pane'].includes(c.args[0])));
});
test('Codex forks without a prompt before opening the child in selected folder',async()=>{
 const h=fixture('codex2');const result=await forkSession(h.source,'/other',h.deps);
 const fork=h.calls.find(c=>c.cmd==='codex'&&!c.args.includes('--help'));assert.deepEqual(fork.args,['exec','-C','/other','--json','fork',parent]);assert.ok(fork.options.env.CODEX_HOME.endsWith('.codex2'));assert.equal(result.threadId,child);
 assert.ok(h.calls.find(c=>c.args[0]==='new-session').args.at(-1).includes(child));
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
 assert.equal(h.terminals.length,1);assert.equal(h.terminals[0].shown,true);
});
