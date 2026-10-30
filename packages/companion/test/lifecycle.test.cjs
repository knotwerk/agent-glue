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
 assert.equal(summarize(events,session,7000).status,'done');assert.equal(summarize(events,session,1000000).status,'unknown');
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
