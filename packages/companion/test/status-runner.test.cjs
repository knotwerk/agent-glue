'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {summarize,parse,account}=require('../src/status-runner.cjs');
const result={taskId:null,title:'Fix sorting',status:'active',request:'Sort recent files',summary:'Tests remain',next:'Run tests',files:['src/files.js'],agents:[]};
const claude=JSON.stringify({result:JSON.stringify({tasks:[result]}),usage:{input_tokens:20,output_tokens:10,cache_read_input_tokens:5}});
const codex=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({tasks:[result]})}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:40,output_tokens:10}});
test('one-off summaries preserve account identity, use stdin and never resume conversations',async()=>{
 for(const profile of ['claudelp','codex2']){
  const calls=[];const source={id:'session',profile,name:'Example',cwd:'/original'};
  const report=await summarize(source,'x'.repeat(25000)+' SYNTHETIC_SNAPSHOT_ONLY',tempDir('status-runner'),{exec:async(cli,args,options)=>{calls.push({cli,args,options});return {stdout:args.includes('--help')?'--ignore-user-config --ephemeral --restricted --tools --no-session-persistence':cli==='claude'?claude:codex};}});
  assert.equal(calls.length,2);const call=calls[1];assert.notEqual(call.options.cwd,source.cwd);assert.ok(call.options.input.includes('SYNTHETIC_SNAPSHOT_ONLY'));assert.ok(JSON.parse(call.options.input.slice(call.options.input.indexOf('{"terminal":'))).output.length<=24000);
  assert.ok(!call.args.some(a=>a==='resume'||a==='--resume'||a==='fork'));assert.ok(!call.args.some(a=>a.includes('SYNTHETIC_SNAPSHOT_ONLY')));
  assert.equal(call.options.env.TMUX,undefined);assert.equal(call.options.env.CODEX_THREAD_ID,undefined);
  assert.ok(call.options.env[profile==='codex2'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'].endsWith('/.'+profile));
  if(profile==='codex2'){assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.includes('read-only'));assert.ok(call.args.includes('shell_tool'));}
  else{assert.equal(call.args[call.args.indexOf('--tools')+1],'');assert.ok(call.args.includes('--strict-mcp-config'));}
  assert.equal(report.items[0].source,'snapshot');assert.equal(report.items[0].tokens,undefined);assert.equal(report.summaryTokens,profile==='codex2'?50:35);
 }
});
test('unsupported CLI capabilities and invalid output fail without inventing a status',async()=>{
 let calls=0;await assert.rejects(summarize({profile:'codex',name:'test'},'output',tempDir('status-capability'),{exec:async()=>{calls++;return {stdout:'old version'};}}),/Update codex/);assert.equal(calls,1);
 assert.throws(()=>account('bash'));
 assert.throws(()=>parse('claude',JSON.stringify({is_error:true,result:'Error'})));
 assert.throws(()=>parse('codex','{"type":"turn.failed"}'));
 assert.throws(()=>parse('claude',JSON.stringify({result:JSON.stringify({tasks:[{...result,files:[{}]}]})})));
 assert.equal(parse('claude',JSON.stringify({result:JSON.stringify({tasks:[{...result,tokens:123456}]})})).tokens,undefined);
});

test('refresh updates matching tasks, appends new tasks and retains unseen unfinished work',()=>{
 const {merge,visible}=require('../src/status-runner.cjs');const source={name:'Example'};
 const first=merge(undefined,{items:[{...result,label:'Fix sorting',taskId:null},{...result,label:'Fix downloads',request:'Repair downloads',taskId:null}]},source,'2026-10-29T12:00:00Z');
 const [sorting,downloads]=first.items;
 const second=merge(first,{items:[{...result,taskId:sorting.id,label:'Sort files reliably',status:'review'},{...result,taskId:null,label:'New work',request:'Add filters'}]},source,'2026-10-29T13:00:00Z');
 assert.deepEqual(second.items.map(t=>t.id).slice(0,2),[sorting.id,downloads.id]);assert.equal(second.items.length,3);
 assert.equal(second.items[0].status,'review');assert.equal(second.items[1].updatedAt,'2026-10-29T12:00:00Z');
 const repeat=merge(second,{items:[{...result,taskId:null,label:'New work',request:'Add filters',summary:'Updated progress'}]},source);
 assert.equal(repeat.items.length,3);assert.equal(repeat.items[2].summary,'Updated progress');
 const distinct=merge(repeat,{items:[{...result,taskId:null,label:'New work',request:'An unrelated user request'}]},source);assert.equal(distinct.items.length,4,'similar titles do not merge different requests');
 const unchanged=merge(second,{items:[]},source);assert.deepEqual(unchanged.items,second.items);
 assert.throws(()=>merge(second,{items:[{...result,taskId:'foreign-id'}]},source),/unknown task/);
 assert.equal(first.items[0].status,'active','input records never mutated');
 assert.equal(visible(second.items).length,3);
});

test('default list keeps every unfinished task and only the three latest completions',()=>{
 const {visible,merge,combine}=require('../src/status-runner.cjs');
 const active=['active','blocked','review','unknown'].map((status,i)=>({id:'active'+i,status,updatedAt:'2026-10-29T10:00:00Z'}));
 const completed=Array.from({length:5},(_,i)=>({id:'done'+i,status:'done',completedAt:`2026-10-29T1${i}:00:00Z`,updatedAt:`2026-10-29T1${i}:00:00Z`}));
 assert.deepEqual(visible([...active,...completed]).map(t=>t.id),['active0','active1','active2','active3','done4','done3','done2']);
 const updated=merge({items:completed},{items:[{...result,taskId:'done0',label:'Old completed task',status:'done'}]},{name:'Example'},'2026-10-29T20:00:00Z');
 assert.equal(visible(updated.items).some(t=>t.id==='done0'),false,'editing an old completion does not make it newly completed');
 assert.equal(combine({items:[completed[0]]},[completed[0]]).length,1);
 assert.equal(combine({id:'legacy',status:'active'},[]).length,1,'single-report upgrade preserves existing work');
});
