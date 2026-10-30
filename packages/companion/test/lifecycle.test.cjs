'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {eventRecord,writeEvent}=require('../src/lifecycle-hook.cjs');
const {summarize,mergeHooks,Lifecycle,install}=require('../src/lifecycle.cjs');
const session={serverPid:'10',pane:'%2',created:'5',sessionName:'codex-fixture'};
const record=(event,at)=>eventRecord({hook_event_name:event,session_id:'chat'},{server:'10',pane:'%2',created:'5'},at);
test('lifecycle ignores content and child-agent events',()=>{
 const event=eventRecord({hook_event_name:'Stop',session_id:'chat',prompt:'secret',last_assistant_message:'secret',transcript_path:'/private'},{server:'10',pane:'%2',created:'5'},100);
 assert.equal(JSON.stringify(event).includes('secret'),false);assert.equal(JSON.stringify(event).includes('private'),false);
 assert.equal(eventRecord({hook_event_name:'Stop',session_id:'chat',agent_id:'child'},session),undefined);
 assert.equal(eventRecord({hook_event_name:'Notification',session_id:'chat',notification_type:'idle_prompt'},session),undefined);
});
test('events distinguish work, permission, completion, interruption and stale/mismatched sessions',()=>{
 const events=[record('UserPromptSubmit',1000),record('PermissionRequest',2000)];
 assert.equal(summarize(events,session,3000).status,'blocked');events.push(record('PostToolUse',4000));
 assert.equal(summarize(events,session,5000).status,'active');events.push(record('Stop',6000));
 assert.equal(summarize(events,session,7000).status,'done');assert.equal(summarize(events,session,1000000).status,'done');
 assert.equal(summarize([record('PreToolUse',4000)],session,1000000).status,'unknown');
 assert.equal(summarize(events,{...session,created:'6'},7000).status,'unknown');
 events.push(record('Interrupt',8000));assert.equal(summarize(events,session,9000).status,'idle');
});
test('hook merging preserves existing handlers and is idempotent with observer-only output',()=>{
 const old={theme:'dark',hooks:{Stop:[{hooks:[{type:'command',command:'existing'}]}]}};
 const result=mergeHooks(old,'observer',false);assert.equal(result.theme,'dark');assert.equal(result.hooks.Stop.length,2);
 assert.deepEqual(mergeHooks(result,'observer',false),result);assert.equal(old.hooks.Stop.length,1);
 assert.ok(!result.hooks.Notification);assert.ok(mergeHooks({},'observer',true).hooks.Notification);
});

test('file observer reads only bounded own event records and rejects stale pane identity',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const base=tempDir('lifecycle-events');
 await writeEvent(base,record('UserPromptSubmit',Date.now()-10));await writeEvent(base,record('Stop',Date.now()));
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);assert.equal(lifecycle.get(session.sessionName).status,'done');
 await lifecycle.refresh([{...session,serverPid:'11'}]);assert.equal(lifecycle.get(session.sessionName).status,'unknown');
});
test('installer handles independent account directories without changing existing hooks or following settings symlinks',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const home=tempDir('lifecycle-install'),base=path.join(home,'state'),source=path.join(__dirname,'../src/lifecycle-hook.cjs');
 await fs.mkdir(path.join(home,'.codex'));await fs.mkdir(path.join(home,'.claude2'));await fs.mkdir(path.join(home,'.claude'));
 const existing={theme:'dark',hooks:{Stop:[{hooks:[{type:'command',command:'existing'}]}]}};
 await fs.writeFile(path.join(home,'.codex/hooks.json'),JSON.stringify(existing));
 const protectedFile=path.join(home,'protected.json');await fs.writeFile(protectedFile,'{}');await fs.symlink(protectedFile,path.join(home,'.claude/settings.json'));
 const result=await install({home,base,source,node:'/node'});
 assert.ok(result.includes('codex: configured'));assert.ok(result.some(s=>s.startsWith('claude: not changed')));
 assert.equal(await fs.readFile(protectedFile,'utf8'),'{}');
 const codex=JSON.parse(await fs.readFile(path.join(home,'.codex/hooks.json'),'utf8'));assert.equal(codex.hooks.Stop.length,2);
 assert.equal(codex.theme,'dark');assert.ok(!codex.hooks.Notification);
 const claude=JSON.parse(await fs.readFile(path.join(home,'.claude2/settings.json'),'utf8'));assert.ok(claude.hooks.Notification);
 await install({home,base,source,node:'/node'});assert.equal(JSON.parse(await fs.readFile(path.join(home,'.codex/hooks.json'),'utf8')).hooks.Stop.length,2);
});

test('journal preserves repeated concurrent events and strips non-metadata fields',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {key}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('journal-concurrent'),dir=path.join(base,key('10','%2'));
 await Promise.all(Array.from({length:24},(_,i)=>writeEvent(base,{...record('PreToolUse',1000+i),prompt:'private text',transcript_path:'/private/history'})));
 const text=await fs.readFile(path.join(dir,'events.jsonl'),'utf8');const events=text.trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.equal(events.length,24);assert.equal(new Set(events.map(e=>e.at)).size,24);
 assert.doesNotMatch(text,/private|prompt|transcript/);
 assert.equal((await fs.stat(path.join(dir,'events.jsonl'))).mode&0o777,0o600);
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);
 assert.equal(lifecycle.get(session.sessionName).at,1023);
});

test('snapshots resume appended events; corrupt caches and torn log tails recover without truncation',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {key,appendRecord}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('journal-recovery'),dir=path.join(base,key('10','%2')),now=Date.now();
 await writeEvent(base,record('UserPromptSubmit',now-1000));
 const first=new Lifecycle(base);await first.refresh([session]);
 const snapshotFile=path.join(dir,'state.json'),journal=path.join(dir,'events.jsonl');
 const snapshot=JSON.parse(await fs.readFile(snapshotFile,'utf8'));assert.equal(snapshot.state.status,'active');
 assert.equal(snapshot.cursor.offset,(await fs.stat(journal)).size);
 // Simulate a crash after journaling but before updating the legacy cache.
 await appendRecord(journal,record('Stop',now));
 const second=new Lifecycle(base);await second.refresh([session]);assert.equal(second.get(session.sessionName).status,'done');
 await fs.writeFile(snapshotFile,'{torn cache');
 await fs.appendFile(journal,'{"event":"truncated');
 const prefix=await fs.readFile(journal);
 await appendRecord(journal,record('UserPromptSubmit',now+1));
 const third=new Lifecycle(base);await third.refresh([session]);assert.equal(third.get(session.sessionName).status,'active');
 assert.equal(third.get(session.sessionName).since,now+1);
 assert.deepEqual((await fs.readFile(journal)).subarray(0,prefix.length),prefix,'recovery must not rewrite the journal');
});

test('legacy event slots remain readable and a new journal does not discard their status',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {key}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('journal-legacy'),dir=path.join(base,key('10','%2')),now=Date.now();await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'Stop.json'),JSON.stringify(record('Stop',now-1000)));
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);assert.equal(lifecycle.get(session.sessionName).status,'done');
 await writeEvent(base,record('UserPromptSubmit',now));await lifecycle.refresh([session]);
 assert.equal(lifecycle.get(session.sessionName).status,'active');
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'Stop.json'),'utf8')).at,now-1000);
});

test('timers use the recorded prompt and never a tool heartbeat or an already finished turn',()=>{
 assert.equal(summarize([record('PreToolUse',2000)],session,3000).since,undefined);
 assert.equal(summarize([record('UserPromptSubmit',1000),record('PreToolUse',2000),record('PostToolUse',3000)],session,4000).since,1000);
 assert.equal(summarize([record('UserPromptSubmit',1000),record('Stop',2000),record('PreToolUse',3000)],session,4000).since,undefined);
});

test('hook pipeline records fixed diagnostic codes without raw input and uses injected tmux metadata',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {observe}=require('../src/lifecycle-hook.cjs');const base=tempDir('hook-diagnostics');
 await observe({base,input:['{'],exec:()=>assert.fail('No tmux on invalid JSON')});
 await observe({base,env:{TMUX_PANE:'%2'},input:['{"prompt":"private"'],exec:()=>assert.fail('No tmux on invalid JSON')});
 await observe({base,env:{TMUX_PANE:'%2'},input:[JSON.stringify({hook_event_name:'Stop',session_id:'chat',prompt:'private',transcript_path:'/secret'})],pid:5001,exec:async(file,args)=>{if(file==='ps')return {stdout:'5001 5000\n5000 1\n'};assert.equal(file,'tmux');assert.equal(args[0],'list-panes');return {stdout:'5000\x1f10\x1f%2\x1f5\n'};}});
 const diagnostics=await fs.readFile(path.join(base,'diagnostics.jsonl'),'utf8');assert.doesNotMatch(diagnostics,/private|secret|prompt/);
 assert.deepEqual(diagnostics.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).stage),['input','input']);
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);assert.equal(lifecycle.get(session.sessionName).status,'done');
});

test('journal refuses symlinks rather than appending outside observer storage',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {key}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('journal-symlink'),dir=path.join(base,key('10','%2'));await fs.mkdir(dir);
 const protectedFile=path.join(base,'protected');await fs.writeFile(protectedFile,'unchanged');await fs.symlink(protectedFile,path.join(dir,'events.jsonl'));
 await assert.rejects(writeEvent(base,record('Stop',1000)));assert.equal(await fs.readFile(protectedFile,'utf8'),'unchanged');
});

test('Codex hook uses actual process ancestry despite a stale or unrelated TMUX_PANE',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {observe}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('codex-stale-pane'),now=Date.now();
 const exec=async(file,args)=>{
  if(file==='ps')return {stdout:'5002 5001\n5001 5000\n5000 4000\n4000 1\n6000 4000\n'};
  assert.deepEqual(args.slice(0,3),['list-panes','-a','-F']);
  return {stdout:'5000\x1f10\x1f%2\x1f5\n6000\x1f10\x1f%84\x1f6\n'};
 };
 for(const [event,at] of [['UserPromptSubmit',now-1000],['Stop',now]])await observe({base,pid:5002,env:{TMUX_PANE:'%84'},input:[JSON.stringify({hook_event_name:event,session_id:'chat'})],exec,now:()=>at});
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session,{...session,pane:'%84',created:'6',sessionName:'unrelated'}]);
 assert.equal(lifecycle.get(session.sessionName).status,'done');assert.equal(lifecycle.get('unrelated').status,'unknown');
});

test('pane ancestry refuses detached hooks, cyclic process data and ambiguous linked sessions',()=>{
 const {identityFromProcesses}=require('../src/lifecycle-hook.cjs');
 const pane='5000\x1f10\x1f%2\x1f5';
 assert.equal(identityFromProcesses(pane,'5002 5001\n5001 1',5002),undefined);
 assert.equal(identityFromProcesses(pane,'5002 5001\n5001 5002',5002),undefined);
 assert.equal(identityFromProcesses(pane+'\n5000\x1f10\x1f%2\x1f6','5002 5000\n5000 1',5002),undefined);
});

test('shared daemon hooks use an exact thread binding without inheriting a terminal environment',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {observe,identityFromProcesses}=require('../src/lifecycle-hook.cjs');const base=tempDir('daemon-thread-binding');
 const panes='5000\x1f10\x1f%2\x1f5\x1fchat\n6000\x1f10\x1f%84\x1f6\x1fother';
 await observe({base,pid:9000,env:{},input:[JSON.stringify({hook_event_name:'Stop',session_id:'chat'})],exec:async file=>({stdout:file==='tmux'?panes:'9000 8000\n8000 1\n'})});
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);assert.equal(lifecycle.get(session.sessionName).status,'done');
 assert.equal(identityFromProcesses(panes+'\n6001\x1f10\x1f%85\x1f7\x1fchat','9000 1',9000,'chat'),undefined,'duplicate bindings must not select a terminal arbitrarily');
});

test('linking parses only a session ID and rejects stale pane identities',async()=>{
 const {parseThreadId,bindThread}=require('../src/lifecycle.cjs');const id='11111111-2222-3333-4444-555555555555';
 assert.equal(parseThreadId('Session: '+id),id);assert.equal(parseThreadId(id),id);assert.equal(parseThreadId('made up '+id),undefined);
 const calls=[];await bindThread(session,id,async(file,args)=>{calls.push(args);return {stdout:'10\x1f%2\x1f5\n'};});
 assert.deepEqual(calls[1],['set-option','-p','-t','%2','@agent_glue_thread_id',id]);
 await assert.rejects(bindThread(session,id,async()=>({stdout:'10\x1f%2\x1f6\n'})),/terminal changed/);
});

test('unlinked daemon events recover immediately after an exact link, including the prompt timer',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {observe,threadKey}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('unlinked-events'),now=Date.now(),id='11111111-2222-3333-4444-555555555555';
 const exec=async file=>({stdout:file==='tmux'?'5000\x1f10\x1f%2\x1f5\n':'9000 8000\n8000 1\n'});
 for(const [event,at] of [['UserPromptSubmit',now-5000],['PreToolUse',now-1000]])await observe({base,pid:9000,exec,now:()=>at,input:[JSON.stringify({hook_event_name:event,session_id:id,prompt:'private',transcript_path:'/secret'})]});
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);assert.equal(lifecycle.get(session.sessionName).status,'unknown');
 const linked={...session,threadId:id};await lifecycle.refresh([linked]);assert.equal(lifecycle.get(session.sessionName).status,'active');assert.equal(lifecycle.get(session.sessionName).since,now-5000);
 const journal=await fs.readFile(path.join(base,'threads',threadKey(id),'events.jsonl'),'utf8');assert.doesNotMatch(journal,/private|secret|prompt|transcript|pane|server|created/);
 await writeEvent(base,{...record('Stop',now),session:id});await lifecycle.refresh([linked]);assert.equal(lifecycle.get(session.sessionName).status,'done');
 const reloaded=new Lifecycle(base);await reloaded.refresh([linked]);assert.equal(reloaded.get(session.sessionName).status,'done');
 await reloaded.refresh([{...linked,threadId:'another-conversation'}]);assert.equal(reloaded.get(session.sessionName).status,'unknown','a new conversation must not inherit the previous green dot');
});

test('unlinked child agents and irrelevant notifications are never retained',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {observe}=require('../src/lifecycle-hook.cjs');const base=tempDir('unlinked-ignore');
 for(const input of [{hook_event_name:'Stop',agent_id:'child',session_id:'parent'},{hook_event_name:'Notification',notification_type:'idle_prompt',session_id:'parent'}])await observe({base,pid:9000,input:[JSON.stringify(input)],exec:async()=>({stdout:''})});
 assert.deepEqual(await fs.readdir(base),[]);
});

test('an exact conversation linked to two different panes cannot colour both as finished',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {writeUnlinkedEvent}=require('../src/lifecycle-hook.cjs');const base=tempDir('duplicate-thread-links');
 await writeUnlinkedEvent(base,{event:'Stop',session:'same-thread',at:Date.now()});
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([{...session,threadId:'same-thread'},{...session,pane:'%3',sessionName:'other-terminal',threadId:'same-thread'}]);
 assert.equal(lifecycle.get(session.sessionName).status,'unknown');assert.equal(lifecycle.get('other-terminal').status,'unknown');assert.match(lifecycle.get('other-terminal').label,/multiple terminals/);
});

test('Claude Stop remains amber while its reported background work is running, and keeps the turn timer',()=>{
 const identity={server:'10',pane:'%2',created:'5'};
 const stop=eventRecord({hook_event_name:'Stop',session_id:'chat',background_tasks:[{id:'private-id',description:'private task',command:'secret shell command',status:'running'}],session_crons:[{prompt:'private prompt'}]},identity,2000);
 assert.equal(stop.background,1);assert.doesNotMatch(JSON.stringify(stop),/private|secret|command|cron/);
 const events=[record('UserPromptSubmit',1000),stop];
 const state=summarize(events,session,3000);assert.equal(state.status,'active');assert.equal(state.since,1000);assert.match(state.label,/Background work/);
 const quiet=summarize(events,session,1000000);assert.equal(quiet.status,'active','explicit unfinished background work must not expire during a long task');
 assert.match(quiet.label,/last reported \(1\); no update for 16 min/);assert.equal(quiet.at,2000);assert.equal(quiet.since,1000);
 events.push(eventRecord({hook_event_name:'SubagentStop',session_id:'chat',agent_id:'child',background_tasks:[],last_assistant_message:'private'},identity,4000));
 assert.equal(summarize(events,session,5000).status,'done');
});

test('quiet background work stays amber across reload, and later completion or interruption clears it',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const base=tempDir('quiet-background'),now=Date.now(),started=now-40*60*1000;
 await writeEvent(base,record('UserPromptSubmit',started));await writeEvent(base,{...record('Stop',started+1000),background:7});
 const first=new Lifecycle(base);await first.refresh([session]);assert.equal(first.get(session.sessionName).status,'active');assert.match(first.get(session.sessionName).label,/last reported \(7\)/);
 const second=new Lifecycle(base);await second.refresh([session]);assert.equal(second.get(session.sessionName).status,'active');assert.equal(second.get(session.sessionName).since,started);
 await writeEvent(base,{...record('Stop',now-1000),event:'SubagentStop',background:0});await second.refresh([session]);assert.equal(second.get(session.sessionName).status,'done');
 for(const event of ['Interrupt','SessionEnd']){
  const state=summarize([record('UserPromptSubmit',started),{...record('Stop',started+1000),background:7},record(event,now)],session,now+1);
  assert.equal(state.status,event==='Interrupt'?'idle':'unknown');
 }
});

test('a child finishing cannot turn an active or blocked parent green',()=>{
 const snapshot=eventRecord({hook_event_name:'SubagentStop',session_id:'chat',agent_id:'child',background_tasks:[]},{server:'10',pane:'%2',created:'5'},3000);
 assert.equal(summarize([record('UserPromptSubmit',1000),snapshot],session,4000).status,'active');
 assert.equal(summarize([record('PermissionRequest',2000),snapshot],session,4000).status,'blocked');
 assert.equal(summarize([snapshot],session,4000).status,'unknown');
 assert.equal(eventRecord({hook_event_name:'SubagentStop',session_id:'chat',agent_id:'child'},session),undefined,'Codex child completions have no parent-scoped background snapshot');
 assert.equal(mergeHooks({},'observer',false).hooks.SubagentStop,undefined);assert.ok(mergeHooks({},'observer',true).hooks.SubagentStop);
});

test('background counts survive pane and unlinked journals, cache recovery, and final completion',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {writeUnlinkedEvent}=require('../src/lifecycle-hook.cjs');const base=tempDir('background-recovery'),now=Date.now();
 const linked={...session,threadId:'chat'};await writeUnlinkedEvent(base,{event:'Stop',session:'chat',at:now-2000,background:2});
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([linked]);assert.equal(lifecycle.get(session.sessionName).status,'active');
 await writeEvent(base,{...record('Stop',now-1000),background:1});await lifecycle.refresh([linked]);assert.equal(lifecycle.get(session.sessionName).status,'active');
 const second=new Lifecycle(base);await second.refresh([linked]);assert.equal(second.get(session.sessionName).status,'active');
 await writeEvent(base,{...record('Stop',now),background:0});await second.refresh([linked]);assert.equal(second.get(session.sessionName).status,'done');
});

test('upgrading replays an old host checkpoint that dropped background metadata',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {key}=require('../src/lifecycle-hook.cjs');const base=tempDir('background-cache-upgrade'),now=Date.now();
 await writeEvent(base,{...record('Stop',now),background:3});
 const first=new Lifecycle(base);await first.refresh([session]);
 const file=path.join(base,key('10','%2'),'state.json');const old=JSON.parse(await fs.readFile(file,'utf8'));
 old.version=1;old.events=old.events.map(({background,...event})=>event);old.state={status:'done'};await fs.writeFile(file,JSON.stringify(old));
 const upgraded=new Lifecycle(base);await upgraded.refresh([session]);assert.equal(upgraded.get(session.sessionName).status,'active');
});

test('child tool activity makes an older finished parent amber without storing child or tool content',()=>{
 const child=eventRecord({hook_event_name:'PreToolUse',session_id:'chat',agent_id:'private-child',agent_type:'private-role',tool_input:{command:'private command'},transcript_path:'/private/history'},{server:'10',pane:'%2',created:'5'},4000);
 assert.equal(child.event,'SubagentActivity');assert.doesNotMatch(JSON.stringify(child),/private|tool_input|agent_id/);
 const events=[record('UserPromptSubmit',1000),record('Stop',2000),child];
 const state=summarize(events,session,5000);assert.equal(state.status,'active');assert.match(state.label,/Child agent working/);assert.equal(state.since,undefined,'do not invent a new parent start time');
 assert.equal(summarize(events,session,1000000).status,'unknown','activity without a task-count snapshot is not proof of indefinite work');
 assert.equal(summarize([...events,record('Stop',6000)],session,7000).status,'done');
 assert.equal(summarize([...events,{...record('Stop',6000),event:'SubagentStop',background:0}],session,7000).status,'done');
 assert.equal(mergeHooks({},'observer',true).hooks.SubagentActivity,undefined,'synthetic events are never installed as CLI hook names');
});

test('child activity cannot clear a parent permission request or resurrect an ended session',()=>{
 const child={...record('PreToolUse',4000),event:'SubagentActivity'};
 assert.equal(summarize([record('PermissionRequest',2000),child],session,5000).status,'blocked');
 assert.equal(summarize([record('SessionEnd',2000),child],session,5000).status,'unknown');
 assert.equal(summarize([record('Interrupt',2000),child],session,5000).status,'idle');
 assert.equal(summarize([child],session,5000).status,'active');
 assert.equal(summarize([child],session,1000000).status,'unknown');
 assert.equal(summarize([record('UserPromptSubmit',1000),child],session,5000).since,1000);
});

test('child activity flows through hook journals and replays after an old host ignored it',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs'),{observe,key}=require('../src/lifecycle-hook.cjs');const base=tempDir('child-activity-replay'),now=Date.now();
 await writeEvent(base,record('Stop',now-1000));const first=new Lifecycle(base);await first.refresh([session]);
 await observe({base,pid:5002,input:[JSON.stringify({hook_event_name:'PostToolUse',session_id:'chat',agent_id:'private-child',tool_response:'private response'})],now:()=>now,exec:async file=>({stdout:file==='ps'?'5002 5000\n5000 1\n':'5000\x1f10\x1f%2\x1f5\n'})});
 const dir=path.join(base,key('10','%2')),file=path.join(dir,'state.json'),old=JSON.parse(await fs.readFile(file,'utf8'));old.version=2;old.cursor.offset=(await fs.stat(path.join(dir,'events.jsonl'))).size;await fs.writeFile(file,JSON.stringify(old));
 const second=new Lifecycle(base);await second.refresh([session]);assert.equal(second.get(session.sessionName).status,'active');assert.match(second.get(session.sessionName).label,/Child agent working/);
 assert.doesNotMatch(await fs.readFile(path.join(dir,'events.jsonl'),'utf8'),/private|tool_response/);
});
