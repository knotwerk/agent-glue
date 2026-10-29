'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {summarize,parse,account}=require('../src/status-runner.cjs');
const result={title:'Fix sorting',status:'active',request:'Sort recent files',summary:'Tests remain',next:'Run tests',files:['src/files.js'],agents:[]};
const claude=JSON.stringify({result:JSON.stringify(result),usage:{input_tokens:20,output_tokens:10,cache_read_input_tokens:5}});
const codex=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}})+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:40,output_tokens:10}});
test('one-off summaries preserve account identity, use stdin and never resume conversations',async()=>{
 for(const profile of ['claudelp','codex2']){
  const calls=[];const source={id:'session',profile,name:'Example',cwd:'/original'};
  const report=await summarize(source,'x'.repeat(25000)+' SYNTHETIC_SNAPSHOT_ONLY',tempDir('status-runner'),{exec:async(cli,args,options)=>{calls.push({cli,args,options});return {stdout:args.includes('--help')?'--ignore-user-config --ephemeral --restricted --tools --no-session-persistence':cli==='claude'?claude:codex};}});
  assert.equal(calls.length,2);const call=calls[1];assert.notEqual(call.options.cwd,source.cwd);assert.ok(call.options.input.includes('SYNTHETIC_SNAPSHOT_ONLY'));assert.ok(call.options.input.length<26000);
  assert.ok(!call.args.some(a=>a==='resume'||a==='--resume'||a==='fork'));assert.ok(!call.args.some(a=>a.includes('SYNTHETIC_SNAPSHOT_ONLY')));
  assert.equal(call.options.env.TMUX,undefined);assert.equal(call.options.env.CODEX_THREAD_ID,undefined);
  assert.ok(call.options.env[profile==='codex2'?'CODEX_HOME':'CLAUDE_CONFIG_DIR'].endsWith('/.'+profile));
  if(profile==='codex2'){assert.ok(call.args.includes('--ignore-user-config'));assert.ok(call.args.includes('read-only'));assert.ok(call.args.includes('shell_tool'));}
  else{assert.equal(call.args[call.args.indexOf('--tools')+1],'');assert.ok(call.args.includes('--strict-mcp-config'));}
  assert.equal(report.source,'snapshot');assert.equal(report.tokens,undefined);assert.equal(report.summaryTokens,profile==='codex2'?50:35);
 }
});
test('unsupported CLI capabilities and invalid output fail without inventing a status',async()=>{
 let calls=0;await assert.rejects(summarize({profile:'codex',name:'test'},'output',tempDir('status-capability'),{exec:async()=>{calls++;return {stdout:'old version'};}}),/Update codex/);assert.equal(calls,1);
 assert.throws(()=>account('bash'));
 assert.throws(()=>parse('claude',JSON.stringify({is_error:true,result:'Error'})));
 assert.throws(()=>parse('codex','{"type":"turn.failed"}'));
 assert.throws(()=>parse('claude',JSON.stringify({result:JSON.stringify({...result,files:[{}]})})));
 assert.equal(parse('claude',JSON.stringify({result:JSON.stringify({...result,tokens:123456})})).tokens,undefined);
});
