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
 await observe({base,env:{},exec:()=>assert.fail('No tmux without pane identity')});
 await observe({base,env:{TMUX_PANE:'%2'},input:['{"prompt":"private"'],exec:()=>assert.fail('No tmux on invalid JSON')});
 await observe({base,env:{TMUX_PANE:'%2'},input:[JSON.stringify({hook_event_name:'Stop',session_id:'chat',prompt:'private',transcript_path:'/secret'})],exec:async(file,args)=>{assert.equal(file,'tmux');assert.equal(args[0],'display-message');return {stdout:'10\x1f%2\x1f5\n'};}});
 const diagnostics=await fs.readFile(path.join(base,'diagnostics.jsonl'),'utf8');assert.doesNotMatch(diagnostics,/private|secret|prompt/);
 assert.deepEqual(diagnostics.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x).stage),['missing_tmux_pane','input']);
 const lifecycle=new Lifecycle(base);await lifecycle.refresh([session]);assert.equal(lifecycle.get(session.sessionName).status,'done');
});

test('journal refuses symlinks rather than appending outside observer storage',async()=>{
 const {tempDir}=require('../../../test/support/tmp.cjs');const {key}=require('../src/lifecycle-hook.cjs');
 const base=tempDir('journal-symlink'),dir=path.join(base,key('10','%2'));await fs.mkdir(dir);
 const protectedFile=path.join(base,'protected');await fs.writeFile(protectedFile,'unchanged');await fs.symlink(protectedFile,path.join(dir,'events.jsonl'));
 await assert.rejects(writeEvent(base,record('Stop',1000)));assert.equal(await fs.readFile(protectedFile,'utf8'),'unchanged');
});
