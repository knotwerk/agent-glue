'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {eventRecord,storedEvent,writeEvent,writeUnlinkedEvent,observe,threadKey,key}=require('../src/lifecycle-hook.cjs');
const {summarize,mergeEvents,Lifecycle}=require('../src/lifecycle.cjs');
const {tempDir}=require('../../../test/support/tmp.cjs');
const session={serverPid:'10',pane:'%2',created:'5',sessionName:'fixture'};
const identity={server:'10',pane:'%2',created:'5'};
const record=(event,at,extra={})=>eventRecord({hook_event_name:event,session_id:'chat',...extra},identity,at);
const stop=(at,tasks)=>record('Stop',at,{background_tasks:tasks});
const child=(event,at,id='child',extra={})=>record(event,at,{agent_id:id,...extra});
const agent={type:'subagent',status:'running'},shell={type:'shell',status:'running'};

test('bounded exhaustive model: every sequence of five parent/background transitions',()=>{
 // Independent specification: foreground work/waiting outranks background
 // completion; running background work counts after a finished foreground reply.
 const actions=[
  ['request',at=>record('UserPromptSubmit',at),m=>({...m,foreground:'working'})],
  ['tool',at=>record('PostToolUse',at),m=>({...m,foreground:'working'})],
  ['permission',at=>record('PermissionRequest',at),m=>({...m,foreground:'waiting'})],
  ['reply',at=>stop(at,[]),()=>({foreground:'finished',agents:0})],
  ['server',at=>stop(at,[shell]),()=>({foreground:'finished',agents:1})],
  ['delegate',at=>stop(at,[agent]),()=>({foreground:'finished',agents:1})],
  ['child finished',at=>record('SubagentStop',at,{background_tasks:[]}),m=>({...m,agents:0})],
  ['interrupt',at=>record('Interrupt',at),()=>({foreground:'idle',agents:0})],
  ['end',at=>record('SessionEnd',at),()=>({foreground:'unknown',agents:0})],
 ];
 let cases=0;
 function explore(events,model,names){
  if(events.length===5){
   const expected=({working:'active',waiting:'blocked',idle:'idle',unknown:'unknown',finished:model.agents?'active':'done'})[model.foreground];
   const message=names.join(' → '),now=10000;
   assert.equal(summarize(events,session,now).status,expected,message);
   // Hook writes can finish out of order. Check cache compaction, duplicates,
   // and reversed arrival against the same independent expected outcome.
   const compact=mergeEvents(storedEvent,events.slice().reverse(),events);
   assert.equal(summarize(compact,session,now).status,expected,'replay: '+message);
   cases++;return;
  }
  for(const [name,event,step] of actions)explore([...events,event((events.length+1)*1000)],step(model),[...names,name]);
 }
 explore([],{foreground:'unknown',agents:0},[]);
 assert.equal(cases,59049);
});

test('background classification includes running services, excludes completed jobs and scheduled wakeups',()=>{
 for(const type of ['shell','monitor','workflow','MCP task']){
  const event=stop(2000,[{type,status:'running',description:'secret',command:'private'}]);
  assert.equal(summarize([record('UserPromptSubmit',1000),event],session,3000).status,'active',type);assert.equal(event.services,1);
  assert.equal(event.agents,0);
  for(const status of ['pending','queued','scheduled','idle','completed','failed','cancelled','stopped'])assert.equal(summarize([stop(2000,[{type,status}])],session,3000).status,'done',type+': '+status);
  assert.equal(summarize([stop(2000,[{type}])],session,3000).status,'unknown');assert.doesNotMatch(JSON.stringify(event),/private|secret/);
 }
 for(const type of ['subagent','teammate','cloud session']){
  for(const status of ['running','pending','queued','in_progress'])assert.equal(summarize([stop(2000,[{type,status}])],session,3000).status,'active');
  for(const status of ['completed','failed','cancelled','stopped'])assert.equal(summarize([stop(2000,[{type,status}])],session,3000).status,'done');
 }
 for(const tasks of [[{}],[{type:'future-task',status:'running'}],[{type:'subagent',status:'future-state'}]]){
  const state=summarize([stop(2000,tasks)],session,3000);assert.equal(state.status,'unknown');assert.equal(state.reason,'unclassified-background');
 }
 assert.equal(summarize([record('Stop',2000,{session_crons:[{prompt:'secret'}]})],session,3000).status,'done');
 assert.equal(summarize([{...record('Stop',2000),background:10}],session,3000).status,'unknown','old untyped counts cannot claim ten busy agents');
});

test('service reports expire, stop explicitly, and never borrow the foreground turn timer',()=>{
 const running=stop(2000,[shell]);
 const state=summarize([record('UserPromptSubmit',1000),running],session,3000);
 assert.equal(state.status,'active');assert.equal(state.services,1);assert.equal(state.since,undefined);assert.match(state.label,/services reported running/);
 assert.equal(summarize([running],session,1000000).status,'unknown','a stale running report is not a heartbeat');
 const finished=stop(4000,[{...shell,status:'completed'}]);assert.equal(summarize([running,finished],session,5000).status,'done');
 const {services,...old}=running;assert.equal(summarize([old],session,3000).status,'unknown','v0.1.83 omitted service states; do not infer green from its zero agents');
});

test('children are tracked separately, cannot clear another child, and can require user input',()=>{
 const events=[stop(1000,[]),child('PreToolUse',2000,'a'),child('PreToolUse',3000,'b')];
 events.push(child('SubagentStop',4000,'a'));
 assert.equal(summarize(mergeEvents(storedEvent,events),session,5000).status,'active','b is still working');
 events.push(child('PermissionRequest',5000,'b'));
 assert.equal(summarize(mergeEvents(storedEvent,events),session,6000).status,'blocked');
 events.push(child('PostToolUse',6000,'b'));
 assert.equal(summarize(mergeEvents(storedEvent,events),session,7000).status,'active');
 events.push(child('SubagentStop',7000,'b'));
 assert.equal(summarize(mergeEvents(storedEvent,events),session,8000).status,'done');
 for(const main of ['PermissionRequest','Interrupt','SessionEnd']){
  const sequence=[record(main,1000),child('PreToolUse',2000),child('SubagentStop',3000)];
  assert.equal(summarize(sequence,session,4000).status,({PermissionRequest:'blocked',Interrupt:'idle',SessionEnd:'unknown'})[main]);
 }
});

test('a newer background snapshot wins over an older stop, without resurrecting its count',()=>{
 const events=[stop(1000,[agent,agent]),child('SubagentStop',2000,'a',{background_tasks:[]}),child('PreToolUse',3000,'b')];
 const state=summarize(events,session,4000);assert.equal(state.status,'active');assert.equal(state.agents,0);
 assert.equal(summarize(events,session,20*60*1000).status,'unknown');
 events.push(child('SubagentStop',4000,'b',{background_tasks:[]}));
 assert.equal(summarize(mergeEvents(storedEvent,events),session,5000).status,'done');
 const sameChild=[stop(1000,[agent,agent]),child('SubagentStop',2000,'a',{background_tasks:[]}),child('PreToolUse',3000,'a')];
 assert.equal(summarize(mergeEvents(storedEvent,sameChild),session,4000).agents,0,'a new tool by the same child cannot erase the zero snapshot');
 sameChild.push(child('SubagentStop',4000,'a'));
 assert.equal(summarize(mergeEvents(storedEvent,sameChild),session,5000).status,'done');
});

test('exhaustive child interleavings: each child clears only its own work or permission',()=>{
 const actions=['a work','a wait','a stop','b work','b wait','b stop'];let cases=0;
 function explore(events,children,names){
  if(names.length===5){
   const statuses=Object.values(children),expected=statuses.includes('wait')?'blocked':statuses.includes('work')?'active':'done';
   const compact=mergeEvents(storedEvent,events.slice().reverse());
   assert.equal(summarize(compact,session,10000).status,expected,names.join(' → '));cases++;return;
  }
  for(const action of actions){
   const [id,status]=action.split(' '),event=({work:'PreToolUse',wait:'PermissionRequest',stop:'SubagentStop'})[status];
   explore([...events,child(event,(names.length+2)*1000,id)],{...children,[id]:status},[...names,action]);
  }
 }
 explore([stop(1000,[])],{},[]);assert.equal(cases,7776);
 assert.equal(summarize([record('SessionStart',1000),child('PreToolUse',2000)],session,3000).status,'active');
});

test('late child events cannot switch to an old conversation or erase another conversation slot',()=>{
 const events=[record('UserPromptSubmit',1000),record('Stop',2000),{...record('PermissionRequest',3000),session:'new'},child('PreToolUse',4000)];
 const compact=mergeEvents(storedEvent,events);
 assert.equal(summarize(compact,session,5000).status,'blocked');
 assert.equal(summarize(compact,{...session,threadId:'chat'},5000).status,'active');
 assert.equal(summarize(compact,{...session,threadId:'new'},5000).status,'blocked');
 const both=mergeEvents(storedEvent,events,[{...record('Stop',4500),session:'new',pane:'%3'}]);
 assert.equal(summarize(both,session,5000).status,'blocked','a neighbouring pane cannot clear a permission request');
 const newChild={...child('PreToolUse',4000),session:'unknown-new-chat'};
 assert.equal(summarize([record('Stop',2000),newChild],session,5000).status,'unknown','unidentified new conversation must not inherit the old green');
});

test('completion timestamp is stable under unrelated child finishes and timer uses latest request',()=>{
 const events=[record('UserPromptSubmit',1000),stop(2000,[]),child('SubagentStop',3000,'internal',{background_tasks:[]})];
 assert.equal(summarize(events,session,4000).at,2000,'incidental child completion must not reset the read mark');
 events.push(record('UserPromptSubmit',4000),record('PostToolUse',5000));
 assert.equal(summarize(events,session,6000).since,4000);
 assert.equal(summarize(mergeEvents(storedEvent,events),session,6000).since,4000);
 const resumed=[record('UserPromptSubmit',1000),child('PermissionRequest',2000),stop(3000,[]),record('PostToolUse',4000)];
 assert.equal(summarize(resumed,session,5000).status,'active','a finished turn cannot leave an old child permission in a resumed turn');
 assert.equal(summarize(mergeEvents(storedEvent,resumed),session,5000).status,'active');
});

test('bounded caches discard previous-turn children, and overflow cannot silently retain a false colour',async()=>{
 const events=[record('UserPromptSubmit',1000),...Array.from({length:1024},(_,i)=>child('PreToolUse',2000+i,'child-'+i))];
 assert.throws(()=>mergeEvents(storedEvent,events),/Too many/);
 const next=mergeEvents(storedEvent,events,[record('UserPromptSubmit',4000)]);
 assert.equal(next.length,1);assert.equal(summarize(next,session,5000).status,'active');
 const base=tempDir('lifecycle-overflow'),dir=path.join(base,key('10','%2'));await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const host=new Lifecycle(base);await host.refresh([session]);
 assert.equal(host.get('fixture').status,'unknown','overflow must not masquerade as successfully replayed current state');
 assert.match(host.get('fixture').label,/could not be read/);
});

test('equal timestamps and duplicate deliveries have deterministic colours',()=>{
 const events=[record('UserPromptSubmit',1000),record('PermissionRequest',2000),record('Stop',2000)];
 const expected=summarize(events,session,3000);
 for(const order of [events,events.slice().reverse(),[events[1],events[2],events[0]],events.concat(events)]){
  assert.deepEqual(summarize(mergeEvents(storedEvent,order),session,3000),expected);
 }
});

test('lookup timeout preserves events and an earlier exact ancestry link recovers without touching the terminal',async()=>{
 const base=tempDir('lifecycle-lookup-recovery'),now=Date.now();
 await writeEvent(base,record('UserPromptSubmit',now-1000));
 const first=new Lifecycle(base);await first.refresh([session]);assert.equal(first.get('fixture').status,'active');
 await observe({base,pid:123,now:()=>now,input:[JSON.stringify({hook_event_name:'Stop',session_id:'chat',prompt:'private'})],exec:async()=>{throw Object.assign(Error('timeout'),{killed:true});}});
 const journal=await fs.readFile(path.join(base,'threads',threadKey('chat'),'events.jsonl'),'utf8');assert.doesNotMatch(journal,/private|prompt/);
 await first.refresh([session]);assert.equal(first.get('fixture').status,'done');
 const second=new Lifecycle(base);await second.refresh([session]);assert.equal(second.get('fixture').status,'done');
 await second.refresh([{...session,created:'6'}]);assert.equal(second.get('fixture').status,'unknown','reused pane cannot inherit an old link');
});

test('four independent accounts recover mixed colours through journals and a fresh host',async()=>{
 const base=tempDir('lifecycle-multi-account'),now=Date.now(),sessions=[];
 const scenarios=[['claude','PostToolUse','active'],['claude2','PermissionRequest','blocked'],['codex','Stop','done'],['codexl',null,'unknown']];
 for(const [i,[profile,event]] of scenarios.entries()){
  const row={...session,pane:'%'+i,threadId:profile,sessionName:profile};sessions.push(row);
  if(event)await writeUnlinkedEvent(base,{event,session:profile,at:now});
 }
 for(let restart=0;restart<2;restart++){
  const host=new Lifecycle(base);await host.refresh(sessions);
  for(const [profile,,expected] of scenarios)assert.equal(host.get(profile).status,expected,profile);
 }
});

test('version-four caches replay service metadata and keep the journal untouched',async()=>{
 const base=tempDir('lifecycle-v4'),now=Date.now(),dir=path.join(base,key('10','%2'));
 await writeEvent(base,stop(now,[shell]));const first=new Lifecycle(base);await first.refresh([session]);
 const file=path.join(dir,'state.json'),cache=JSON.parse(await fs.readFile(file));
 cache.version=4;cache.events=cache.events.map(({services,...e})=>e);cache.state={status:'active'};await fs.writeFile(file,JSON.stringify(cache));
 const journal=await fs.readFile(path.join(dir,'events.jsonl'));
 const reloaded=new Lifecycle(base);await reloaded.refresh([session]);assert.equal(reloaded.get('fixture').status,'active');assert.equal(reloaded.get('fixture').services,1);
 assert.deepEqual(await fs.readFile(path.join(dir,'events.jsonl')),journal);
});
