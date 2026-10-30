'use strict';
// Standalone hook. Never retain prompts, messages, tool inputs or transcript paths.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const EVENTS=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','SubagentStop','Interrupt','SessionEnd'];
const root=()=>path.join(require('node:os').homedir(),'.local','state','agent-glue','lifecycle');
const key=(server,pane)=>crypto.createHash('sha256').update(server+':'+pane).digest('hex');
const threadKey=session=>crypto.createHash('sha256').update(session).digest('hex');
function storedThreadEvent(value){
 if(!value||!EVENTS.includes(value.event)||typeof value.session!=='string'||!value.session||value.session.length>200||!Number.isSafeInteger(value.at)||value.at<0)return;
 const background=['Stop','SubagentStop'].includes(value.event)&&Number.isSafeInteger(value.background)&&value.background>=0&&value.background<=10000?value.background:undefined;
 if(value.event==='SubagentStop'&&background===undefined)return;
 return {event:value.event,session:value.session,at:value.at,...(background===undefined?{}:{background})};
}
function storedEvent(value){
 if(!value||!EVENTS.includes(value.event)||typeof value.session!=='string'||!value.session||value.session.length>200||!/^\d{1,20}$/.test(value.server)||!/^%\d{1,20}$/.test(value.pane)||!/^\d{1,20}$/.test(value.created)||!Number.isSafeInteger(value.at)||value.at<0)return;
 const event=storedThreadEvent(value);if(event)return {...event,server:String(value.server),pane:value.pane,created:String(value.created)};
}
function inputEvent(input,now=Date.now()){
 if(!EVENTS.includes(input.hook_event_name)||(input.agent_id&&input.hook_event_name!=='SubagentStop')||typeof input.session_id!=='string'||input.session_id.length>200)return;
 if(input.hook_event_name==='Notification'&&!['permission_prompt','elicitation_dialog'].includes(input.notification_type))return;
 // Claude's Stop/SubagentStop task list is scoped to the parent session.
 // Retain only its count, never task descriptions, commands or child messages.
 const background=['Stop','SubagentStop'].includes(input.hook_event_name)&&Array.isArray(input.background_tasks)&&input.background_tasks.length<=10000?input.background_tasks.length:undefined;
 return storedThreadEvent({event:input.hook_event_name,session:input.session_id,at:now,background});
}
function eventRecord(input,identity,now=Date.now()){
 const event=inputEvent(input,now);if(event)return storedEvent({...event,server:String(identity.server),pane:identity.pane,created:String(identity.created)});
}
async function privateDirectory(dir){
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe observer directory');
}
async function appendRecord(file,record){
 const flags=require('node:fs').constants;
 const handle=await fs.open(file,flags.O_WRONLY|flags.O_APPEND|flags.O_CREAT|(flags.O_NOFOLLOW||0),0o600);
 try{
  if(!(await handle.stat()).isFile())throw Error('Unsafe observer log');
  // A leading newline isolates a truncated final record after a crash. A single
  // append write keeps concurrent hook records separate on the local filesystem.
  const bytes=Buffer.from('\n'+JSON.stringify(record)+'\n');
  if((await handle.write(bytes)).bytesWritten!==bytes.length)throw Error('Incomplete observer append');
  await handle.sync();
 }finally{await handle.close();}
 // Persist the directory entry too, including the first creation of the log.
 const directory=await fs.open(path.dirname(file),'r');try{await directory.sync();}finally{await directory.close();}
}
async function atomicJson(file,value){
 const tmp=file+'.'+crypto.randomUUID()+'.tmp';
 await fs.writeFile(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});await fs.rename(tmp,file);
}
async function writeEvent(base,event){
 event=storedEvent(event);if(!event)throw Error('Invalid observer event');
 const dir=path.join(base,key(event.server,event.pane));await privateDirectory(dir);
 // Commit the journal before updating any replaceable cache. Keep old event
 // slots for compatibility with extension hosts that have not reloaded yet.
 await appendRecord(path.join(dir,'events.jsonl'),event);
 const parent=await fs.open(base,'r');try{await parent.sync();}finally{await parent.close();}
 await atomicJson(path.join(dir,event.event+'.json'),event);
}
async function writeUnlinkedEvent(base,event){
 event=storedThreadEvent(event);if(!event)throw Error('Invalid observer event');
 const threads=path.join(base,'threads');await privateDirectory(threads);
 const dir=path.join(threads,threadKey(event.session));await privateDirectory(dir);
 await appendRecord(path.join(dir,'events.jsonl'),event);
 for(const parent of [threads,base]){const directory=await fs.open(parent,'r');try{await directory.sync();}finally{await directory.close();}}
 await atomicJson(path.join(dir,event.event+'.json'),event);
}
function identityFromProcesses(panes,processes,pid,thread){
 const bound=panes.trim().split('\n').map(line=>line.split('\x1f')).filter(fields=>thread&&fields[4]===thread);
 if(bound.length===1){const [,server,pane,created]=bound[0];if(/^\d+$/.test(server)&&/^%\d+$/.test(pane)&&/^\d+$/.test(created))return {server,pane,created};}
 if(bound.length>1)return;
 const parents=new Map();for(const line of processes.split('\n')){const fields=line.trim().split(/\s+/);if(fields.length===2&&fields.every(v=>/^\d+$/.test(v)))parents.set(fields[0],fields[1]);}
 const ancestors=[];let current=String(pid);
 while(current&&current!=='1'&&!ancestors.includes(current)&&ancestors.length<64){ancestors.push(current);current=parents.get(current);}
 const matches=panes.trim().split('\n').map(line=>{
  const [panePid,server,pane,created]=line.split('\x1f');return {panePid,server,pane,created,distance:ancestors.indexOf(panePid)};
 }).filter(row=>row.distance>=0&&/^\d+$/.test(row.server)&&/^%\d+$/.test(row.pane)&&/^\d+$/.test(row.created)).sort((a,b)=>a.distance-b.distance);
 if(!matches.length)return;
 const nearest=matches.filter(row=>row.distance===matches[0].distance);
 if(new Set(nearest.map(row=>[row.server,row.pane,row.created].join(':'))).size!==1)return;
 const {server,pane,created}=nearest[0];return {server,pane,created};
}
async function observe({base,input=process.stdin,exec=require('node:util').promisify(require('node:child_process').execFile),now=Date.now,pid=process.pid}={}){
 let stage='input',eventName,sessionId;
 try{
  let text='';for await(const chunk of input){text+=chunk;if(text.length>1024*1024)throw Error('Oversized input');}
  const payload=JSON.parse(text),receivedAt=now();eventName=EVENTS.includes(payload.hook_event_name)?payload.hook_event_name:undefined;sessionId=typeof payload.session_id==='string'&&payload.session_id.length<=200?payload.session_id:undefined;stage='tmux_lookup';
  const metadata=inputEvent(payload,receivedAt);if(!metadata)return;
  // Codex may reuse a shell environment snapshot containing another pane ID.
  // Match this hook's actual ancestry to pane roots; never trust TMUX_PANE as
  // identity, even when it happens to point at a still-live unrelated pane.
  const [panes,processes]=await Promise.all([
   exec('tmux',['list-panes','-a','-F','#{pane_pid}\x1f#{pid}\x1f#{pane_id}\x1f#{session_created}\x1f#{@agent_glue_thread_id}'],{timeout:600,maxBuffer:1024*1024}),
   exec('ps',['-eo','pid=,ppid='],{timeout:600,maxBuffer:1024*1024})
  ]);
  stage='tmux_identity';const identity=identityFromProcesses(panes.stdout,processes.stdout,pid,sessionId);
  // Preserve status-only events from a detached server until the user supplies
  // an exact conversation link. Never guess from a folder or ambient TMUX_PANE.
  stage='storage';if(identity)await writeEvent(base,eventRecord(payload,identity,receivedAt));else await writeUnlinkedEvent(base,metadata);
 }catch(error){
  // Only fixed reason codes, never exception text or hook input. Fail open even
  // when the diagnostic log itself cannot be written.
  const code=/^E[A-Z0-9_]{1,60}$/.test(error?.code)?error.code:typeof error?.code==='number'?error.code:undefined;
  const stderr=String(error?.stderr||'');
  const reason=error?.killed?'timeout':/no server running|error connecting|failed to connect/.test(stderr)?'server_unreachable':/can't find pane|no such pane|can't find session/.test(stderr)?'pane_not_found':undefined;
  try{await privateDirectory(base);await appendRecord(path.join(base,'diagnostics.jsonl'),{at:Date.now(),stage,code,reason,event:eventName,session:sessionId});}catch{}
 }
}
if(require.main===module&&process.argv.includes('--agent-glue-hook')){
 const rootIndex=process.argv.indexOf('--event-root'),base=rootIndex>=0?process.argv[rootIndex+1]:root();
 observe({base}).finally(()=>process.stdout.write('{}\n'));
}
module.exports={EVENTS,root,key,threadKey,eventRecord,storedEvent,storedThreadEvent,writeEvent,writeUnlinkedEvent,appendRecord,atomicJson,observe,identityFromProcesses};
