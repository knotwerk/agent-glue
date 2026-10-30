'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {EVENTS,root,key,threadKey,storedEvent,storedThreadEvent,atomicJson}=require('./lifecycle-hook.cjs');
const NO_EVENTS='No lifecycle events yet. Review Agent Glue hooks in /hooks. For Codex shared-server sessions, right-click → Link Codex Status using the Session ID from /status.';
const REPLAY_BYTES=2*1024*1024;
const CACHE_VERSION=3; // Replay checkpoints from hosts that discarded child activity.
async function readJson(file,maxBytes){
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)return;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return;}
}
function mergeEvents(parse,...groups){
 const slots=new Map();
 for(const group of groups)for(const value of Array.isArray(group)?group:[]){const event=parse(value);if(event&&(!slots.has(event.event)||event.at>=slots.get(event.event).at)){slots.delete(event.event);slots.set(event.event,event);}}
 return [...slots.values()];
}
async function readJournal(dir,previous,legacy,parse=storedEvent){
 const flags=require('node:fs').constants;
 let handle;
 try{handle=await fs.open(path.join(dir,'events.jsonl'),flags.O_RDONLY|(flags.O_NOFOLLOW||0));}
 catch(error){if(error.code==='ENOENT')return {events:mergeEvents(parse,previous?.events||[],legacy),cursor:null};throw error;}
 try{
  const stat=await handle.stat();if(!stat.isFile())throw Error('Unsafe observer journal');
  const compatible=previous?.version===CACHE_VERSION&&Array.isArray(previous.events)&&previous.events.length<=EVENTS.length&&previous.events.every(parse)&&previous.cursor?.dev===stat.dev&&previous.cursor?.ino===stat.ino&&Number.isSafeInteger(previous.cursor.offset)&&previous.cursor.offset>=0&&previous.cursor.offset<=stat.size;
  let offset=compatible?previous.cursor.offset:0,events=mergeEvents(parse,compatible?previous.events:legacy);
  const bytes=Buffer.alloc(Math.min(REPLAY_BYTES,stat.size-offset));
  const {bytesRead}=await handle.read(bytes,0,bytes.length,offset);
  const complete=bytes.subarray(0,bytesRead).lastIndexOf(10);
  if(complete>=0){
   for(const line of bytes.subarray(0,complete+1).toString('utf8').split('\n')){
    if(!line||line.length>2048)continue;
    try{events=mergeEvents(parse,events,[JSON.parse(line)]);}catch{/* Skip a torn or corrupt record; subsequent records remain readable. */}
   }
   offset+=complete+1;
  }else if(bytesRead===REPLAY_BYTES){
   // Impossible for our small records; make progress past corrupt oversized data.
   offset+=bytesRead;
  }
  return {events,cursor:{dev:stat.dev,ino:stat.ino,offset},catchingUp:stat.size-offset>2048};
 }finally{await handle.close();}
}
function summarize(events,session,now=Date.now()){
 const valid=events.filter(e=>EVENTS.includes(e.event)&&(!session.threadId||e.session===session.threadId)&&e.server===String(session.serverPid)&&e.pane===session.pane&&e.created===String(session.created)&&Number.isFinite(e.at)&&e.at<=now+1000).sort((a,b)=>a.at-b.at);
 const latest=valid.at(-1);if(!latest)return {status:'unknown',label:NO_EVENTS};
 const current=valid.filter(e=>e.session===latest.session);
 // A child finishing does not finish the parent. Its parent-scoped snapshot
 // can complete a previously stopped parent only when no background work remains.
 const main=current.filter(e=>!['SubagentStop','SubagentActivity'].includes(e.event)).at(-1);
 const child=current.filter(e=>e.event==='SubagentActivity').at(-1);
 const childWorking=latest.event==='SubagentActivity'&&(!main||['Stop','UserPromptSubmit','PreToolUse','PostToolUse'].includes(main.event));
 if(!main){
  if(childWorking&&now-child.at<=15*60*1000)return {status:'active',label:'Child agent working; parent status unavailable',at:child.at,event:child.event};
  return {status:'unknown',label:'Background update received; waiting for the main agent status',at:latest.at};
 }
 const background=main.event==='Stop'?(latest.event==='SubagentStop'?latest.background:main.background):undefined;
 let status=({SessionStart:'idle',UserPromptSubmit:'active',PreToolUse:'active',PostToolUse:'active',PermissionRequest:'blocked',Notification:'blocked',Stop:background>0?'active':'done',Interrupt:'idle',SessionEnd:'unknown'})[main.event];
 if(childWorking)status='active';
 const stale=now-latest.at>15*60*1000;
 // A stopped foreground reply can leave explicit unfinished background work.
 // Silence during a long task is not an event that clears that work. Preserve
 // amber, but make the age of this report clear rather than claiming a heartbeat.
 const statusAt=childWorking||latest.event==='SubagentStop'?latest.at:main.at;
 if(now-statusAt>15*60*1000&&['active','blocked'].includes(status)&&!(background>0))return {status:'unknown',label:'No recent update; last working/waiting event over 15 minutes ago',at:statusAt};
 const prompt=current.find(e=>e.event==='UserPromptSubmit'&&e.at<=latest.at);
 const ended=current.filter(e=>(['Interrupt','SessionEnd'].includes(e.event)||(e.event==='Stop'&&!(e.background>0)))&&e.at<latest.at).at(-1);
 const since=prompt&&(!ended||prompt.at>ended.at)?prompt.at:undefined;
 const backgroundLabel=stale?'Background work last reported ('+background+'); no update for '+Math.floor((now-latest.at)/60000)+' min':'Background work continues ('+background+')';
 return {status,label:childWorking&&!stale?'Child agent working':background>0?backgroundLabel:({active:'Working',blocked:'Waiting for you',done:'Turn finished',idle:'Idle',unknown:'Session ended'})[status],at:statusAt,since,event:latest.event};
}
class Lifecycle{
 constructor(base=root()){this.base=base;this.rows=new Map();this.checkpoints=new Map();this.threadCheckpoints=new Map();}
 async refresh(sessions){
  const rows=new Map();
  const bindings=new Map();for(const session of sessions)if(session.threadId){const bound=bindings.get(session.threadId)||new Set();bound.add([session.serverPid,session.pane,session.created].join(':'));bindings.set(session.threadId,bound);}
  await Promise.all(sessions.map(async session=>{
   if(session.threadId&&bindings.get(session.threadId).size>1){rows.set(session.sessionName,{status:'unknown',label:'This conversation is linked to multiple terminals. Link the correct Session ID for each terminal.'});return;}
   const id=key(String(session.serverPid),session.pane),dir=path.join(this.base,id);
   const events=await Promise.all(EVENTS.map(event=>readJson(path.join(dir,event+'.json'),2048)));
   const previous=this.checkpoints.get(id)||await readJson(path.join(dir,'state.json'),16384);
   let replay;
   try{replay=await readJournal(dir,previous,events.filter(Boolean));}
   catch{rows.set(session.sessionName,{status:'unknown',label:'Status journal could not be read; previous records have been preserved.'});return;}
   let recovered=[];
   if(session.threadId){
    const threadDir=path.join(this.base,'threads',threadKey(session.threadId));
    try{
     const legacy=await Promise.all(EVENTS.map(event=>readJson(path.join(threadDir,event+'.json'),2048)));
     const pending=await readJournal(threadDir,this.threadCheckpoints.get(session.threadId),legacy.filter(Boolean),storedThreadEvent);
     this.threadCheckpoints.set(session.threadId,{version:CACHE_VERSION,...pending});
     recovered=pending.events.filter(event=>event.session===session.threadId).map(event=>({...event,server:String(session.serverPid),pane:session.pane,created:String(session.created)}));
     if(pending.catchingUp)replay.catchingUp=true;
    }catch{rows.set(session.sessionName,{status:'unknown',label:'Conversation status log could not be read; records have been preserved.'});return;}
   }
   const matching=replay.events.filter(event=>!session.threadId||event.session===session.threadId);
   const state=replay.catchingUp?{status:'unknown',label:'Recovering status from the event log…'}:summarize(mergeEvents(storedEvent,recovered,matching),session);
   const snapshot={version:CACHE_VERSION,...replay,state};
   rows.set(session.sessionName,state);
   if(replay.events.length&&JSON.stringify(previous)!==JSON.stringify(snapshot)){
    // The log is authoritative. Snapshot failure never discards events or stops
    // live status; another host can safely replay from an older checkpoint.
    try{await atomicJson(path.join(dir,'state.json'),snapshot);}catch{}
   }
   this.checkpoints.set(id,snapshot);
  }));this.rows=rows;
  const live=new Set(sessions.map(s=>key(String(s.serverPid),s.pane)));for(const id of this.checkpoints.keys())if(!live.has(id))this.checkpoints.delete(id);
  const linked=new Set(sessions.map(s=>s.threadId));for(const id of this.threadCheckpoints.keys())if(!linked.has(id))this.threadCheckpoints.delete(id);
 }
 get(session){return this.rows.get(session)||{status:'unknown',label:NO_EVENTS};}
}
const profiles=['claude','claude2','claudel','claudelp','codex','codex2','codex3','codexl'];
function mergeHooks(config,command,claude){
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Expected a settings object');
 const next=structuredClone(config);next.hooks??={};if(typeof next.hooks!=='object'||Array.isArray(next.hooks))throw Error('Invalid hooks object');
 for(const event of EVENTS.filter(e=>e!=='SubagentActivity'&&(claude?e!=='Interrupt':!['Notification','SubagentStop'].includes(e)))){
  const groups=next.hooks[event]||[];if(!Array.isArray(groups))throw Error('Invalid '+event+' hooks');
  if(groups.some(group=>group.hooks?.some(h=>h.command===command)))continue;
  next.hooks[event]=[...groups,{hooks:[{type:'command',command,timeout:2}]}];
 }
 return next;
}
async function install({home=require('node:os').homedir(),source,node=process.execPath,base=path.join(home,'.local','state','agent-glue','lifecycle')}={}){
 await fs.mkdir(base,{recursive:true,mode:0o700});
 const helper=path.join(base,'hook.cjs'),helperTmp=helper+'.'+require('node:crypto').randomUUID()+'.tmp';
 await fs.writeFile(helperTmp,await fs.readFile(source),{mode:0o600,flag:'wx'});await fs.rename(helperTmp,helper);
 const quote=s=>"'"+s.replace(/'/g,"'\\''")+"'";const command=quote(node)+' '+quote(helper)+' --agent-glue-hook --event-root '+quote(base);
 const results=[];
 for(const profile of profiles){
  const dir=path.join(home,'.'+profile);try{if(!(await fs.lstat(dir)).isDirectory())continue;}catch{continue;}
  const file=path.join(dir,profile.startsWith('claude')?'settings.json':'hooks.json');
  try{
   let original='{}';try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Unsafe settings file');original=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
   const updated=JSON.stringify(mergeHooks(JSON.parse(original),command,profile.startsWith('claude')),null,2)+'\n';
   if(updated!==original){
    // Keep a private exact backup; refuse to replace a concurrently edited config.
    await fs.writeFile(path.join(base,profile+'-'+Date.now()+'.backup.json'),original,{flag:'wx',mode:0o600});
    const current=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '{}';throw e;});if(current!==original)throw Error('Settings changed during setup');
    const temporary=file+'.agent-glue-'+process.pid+'.tmp';await fs.writeFile(temporary,updated,{flag:'wx',mode:0o600});await fs.rename(temporary,file);
   }
   results.push(profile+': configured');
  }catch{results.push(profile+': not changed (settings need manual review)');}
 }
 return results;
}
function parseThreadId(value){
 const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
 return String(value).trim().match(new RegExp('^('+uuid+')$','i'))?.[1]?.toLowerCase()||String(value).match(new RegExp('^\\s*(?:│\\s*)?Session:\\s*('+uuid+')\\s*(?:│)?\\s*$','im'))?.[1]?.toLowerCase();
}
async function bindThread(session,value,exec){
 const thread=parseThreadId(value);if(!thread)throw Error('Paste the Session ID from Codex /status.');
 const {stdout}=await exec('tmux',['display-message','-p','-t',session.pane,'#{pid}\x1f#{pane_id}\x1f#{session_created}']);
 if(stdout.trim()!==[session.serverPid,session.pane,session.created].join('\x1f'))throw Error('This terminal changed while linking. Try again.');
 await exec('tmux',['set-option','-p','-t',session.pane,'@agent_glue_thread_id',thread]);return thread;
}
module.exports={Lifecycle,summarize,mergeHooks,install,parseThreadId,bindThread};
