'use strict';
// Standalone hook. Never retain prompts, messages, tool inputs or transcript paths.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const EVENTS=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','Interrupt','SessionEnd'];
const root=()=>path.join(require('node:os').homedir(),'.local','state','agent-glue','lifecycle');
const key=(server,pane)=>crypto.createHash('sha256').update(server+':'+pane).digest('hex');
function storedEvent(value){
 if(!value||!EVENTS.includes(value.event)||typeof value.session!=='string'||!value.session||value.session.length>200||!/^\d{1,20}$/.test(value.server)||!/^%\d{1,20}$/.test(value.pane)||!/^\d{1,20}$/.test(value.created)||!Number.isSafeInteger(value.at)||value.at<0)return;
 return {event:value.event,session:value.session,server:String(value.server),pane:value.pane,created:String(value.created),at:value.at};
}
function eventRecord(input,identity,now=Date.now()){
 if(!EVENTS.includes(input.hook_event_name)||input.agent_id||typeof input.session_id!=='string'||input.session_id.length>200)return;
 if(input.hook_event_name==='Notification'&&!['permission_prompt','elicitation_dialog'].includes(input.notification_type))return;
 return storedEvent({event:input.hook_event_name,session:input.session_id,server:String(identity.server),pane:identity.pane,created:String(identity.created),at:now});
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
async function observe({base,env=process.env,input=process.stdin,exec=require('node:util').promisify(require('node:child_process').execFile),now=Date.now}={}){
 let stage='input';
 try{
  if(!/^%\d+$/.test(env.TMUX_PANE||'')){stage='missing_tmux_pane';throw Error('Missing pane');}
  let text='';for await(const chunk of input){text+=chunk;if(text.length>1024*1024)throw Error('Oversized input');}
  const payload=JSON.parse(text),receivedAt=now();stage='tmux_lookup';
  const {stdout}=await exec('tmux',['display-message','-p','-t',env.TMUX_PANE,'#{pid}\x1f#{pane_id}\x1f#{session_created}'],{timeout:600,maxBuffer:1024});
  const [server,pane,created]=stdout.trim().split('\x1f');if(!/^\d+$/.test(server)||!/^%\d+$/.test(pane)||!/^\d+$/.test(created))throw Error('Invalid tmux identity');
  const event=eventRecord(payload,{server,pane,created},receivedAt);stage='storage';if(event)await writeEvent(base,event);
 }catch{
  // Only fixed reason codes, never exception text or hook input. Fail open even
  // when the diagnostic log itself cannot be written.
  try{await privateDirectory(base);await appendRecord(path.join(base,'diagnostics.jsonl'),{at:Date.now(),stage});}catch{}
 }
}
if(require.main===module&&process.argv.includes('--agent-glue-hook')){
 const rootIndex=process.argv.indexOf('--event-root'),base=rootIndex>=0?process.argv[rootIndex+1]:root();
 observe({base}).finally(()=>process.stdout.write('{}\n'));
}
module.exports={EVENTS,root,key,eventRecord,storedEvent,writeEvent,appendRecord,atomicJson,observe};
