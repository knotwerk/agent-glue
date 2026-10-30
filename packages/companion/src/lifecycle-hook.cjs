'use strict';
// Standalone hook. Never retain prompts, messages, tool inputs or transcript paths.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const EVENTS=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','Interrupt','SessionEnd'];
const root=()=>path.join(require('node:os').homedir(),'.local','state','agent-glue','lifecycle');
const key=(server,pane)=>crypto.createHash('sha256').update(server+':'+pane).digest('hex');
function eventRecord(input,identity,now=Date.now()){
 if(!EVENTS.includes(input.hook_event_name)||input.agent_id||typeof input.session_id!=='string'||input.session_id.length>200)return;
 if(input.hook_event_name==='Notification'&&!['permission_prompt','elicitation_dialog'].includes(input.notification_type))return;
 return {event:input.hook_event_name,session:input.session_id,server:String(identity.server),pane:identity.pane,created:String(identity.created),at:now};
}
async function writeEvent(base,event){
 const dir=path.join(base,key(event.server,event.pane));await fs.mkdir(dir,{recursive:true,mode:0o700});
 // One slot per event type, fixed-size records. Concurrent event types cannot overwrite each other.
 const file=path.join(dir,event.event+'.json'),tmp=file+'.'+process.pid+'.tmp';
 await fs.writeFile(tmp,JSON.stringify(event),{mode:0o600});await fs.rename(tmp,file);
}
async function main(){
 try{
  if(!/^%\d+$/.test(process.env.TMUX_PANE||''))return;
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>1024*1024)return;}
  const input=JSON.parse(text);
  const {stdout}=await require('node:util').promisify(require('node:child_process').execFile)('tmux',['display-message','-p','-t',process.env.TMUX_PANE,'#{pid}\x1f#{pane_id}\x1f#{session_created}'],{timeout:600,maxBuffer:1024});
  const [server,pane,created]=stdout.trim().split('\x1f');if(!/^\d+$/.test(server)||!/^%\d+$/.test(pane)||!/^\d+$/.test(created))return;
  const event=eventRecord(input,{server,pane,created}),rootIndex=process.argv.indexOf('--event-root');if(event)await writeEvent(rootIndex>=0?process.argv[rootIndex+1]:root(),event);
 }catch{/* A status observer must never block the user's agent. */}
}
if(require.main===module&&process.argv.includes('--agent-glue-hook'))main().finally(()=>process.stdout.write('{}\n'));
module.exports={EVENTS,root,key,eventRecord,writeEvent};
