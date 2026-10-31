'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {EVENTS,root,key,threadKey,storedEvent,storedThreadEvent,atomicJson}=require('./lifecycle-hook.cjs');
const NO_EVENTS='No lifecycle events yet. Review Agent Glue hooks in /hooks. For Codex shared-server sessions, right-click → Link Codex Status using the Session ID from /status.';
const REPLAY_BYTES=2*1024*1024;
const CACHE_VERSION=5; // Replay service states stripped by older hosts.
const MAX_EVENTS=1024;
const CHILD_EVENTS=new Set(['SubagentActivity','SubagentBlocked','SubagentStop']);
const EVENT_ORDER=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Notification','PermissionRequest','SubagentActivity','SubagentBlocked','SubagentStop','Stop','Interrupt','SessionEnd'];
const compareEvents=(a,b)=>a.at-b.at||EVENT_ORDER.indexOf(a.event)-EVENT_ORDER.indexOf(b.event)||JSON.stringify(a).localeCompare(JSON.stringify(b));
async function readJson(file,maxBytes){
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)return;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return;}
}
function mergeEvents(parse,...groups){
 const slots=new Map();
 for(const group of groups)for(const value of Array.isArray(group)?group:[]){
  const event=parse(value);if(!event)continue;
  const id=JSON.stringify([event.server,event.pane,event.created,event.session,CHILD_EVENTS.has(event.event)&&event.child?'child:'+event.child:event.event]);
  if(!slots.has(id)||compareEvents(event,slots.get(id))>=0)slots.set(id,event);
  // A child's next tool/stop can replace its own state, but cannot erase the
  // parent's most recent background snapshot (including an explicit zero).
  if(event.event==='SubagentStop'&&event.background!==undefined){
   const snapshot=JSON.stringify([event.server,event.pane,event.created,event.session,'background-snapshot']);
   if(!slots.has(snapshot)||compareEvents(event,slots.get(snapshot))>=0)slots.set(snapshot,event);
  }
 }
 // Keep a bounded set of recent conversations, never merge one chat's event
 // into another. Exact-linked reads filter to their conversation before here.
 const conversations=new Map();
 for(const event of slots.values()){
  const id=JSON.stringify([event.server,event.pane,event.created,event.session]);
  const group=conversations.get(id)||[];group.push(event);conversations.set(id,group);
 }
 const latest=group=>Math.max(...(group.some(e=>!CHILD_EVENTS.has(e.event))?group.filter(e=>!CHILD_EVENTS.has(e.event)):group).map(e=>e.at));
 const events=[...conversations.values()].sort((a,b)=>latest(b)-latest(a)).slice(0,8).flatMap(group=>{
  const boundary=Math.max(-1,...group.filter(e=>['SessionStart','UserPromptSubmit','Stop','Interrupt','SessionEnd'].includes(e.event)).map(e=>e.at));
  return [...new Map(group.filter(e=>!CHILD_EVENTS.has(e.event)||e.at>=boundary).map(e=>[JSON.stringify(e),e])).values()];
 });
 if(events.length>MAX_EVENTS)throw Error('Too many concurrent status records');
 return events;
}
async function readJournal(dir,previous,legacy,parse=storedEvent){
 const flags=require('node:fs').constants;
 let handle;
 try{handle=await fs.open(path.join(dir,'events.jsonl'),flags.O_RDONLY|(flags.O_NOFOLLOW||0));}
 catch(error){if(error.code==='ENOENT')return {events:mergeEvents(parse,previous?.events||[],legacy),cursor:null};throw error;}
 try{
  const stat=await handle.stat();if(!stat.isFile())throw Error('Unsafe observer journal');
  const compatible=previous?.version===CACHE_VERSION&&Array.isArray(previous.events)&&previous.events.length<=MAX_EVENTS&&previous.events.every(parse)&&previous.cursor?.dev===stat.dev&&previous.cursor?.ino===stat.ino&&Number.isSafeInteger(previous.cursor.offset)&&previous.cursor.offset>=0&&previous.cursor.offset<=stat.size;
  let offset=compatible?previous.cursor.offset:0,events=mergeEvents(parse,compatible?previous.events:legacy);
  const bytes=Buffer.alloc(Math.min(REPLAY_BYTES,stat.size-offset));
  const {bytesRead}=await handle.read(bytes,0,bytes.length,offset);
  const complete=bytes.subarray(0,bytesRead).lastIndexOf(10);
  if(complete>=0){
   for(const line of bytes.subarray(0,complete+1).toString('utf8').split('\n')){
    if(!line||line.length>2048)continue;
    let value;try{value=JSON.parse(line);}catch{continue;/* Skip a torn or corrupt record. */}
    events=mergeEvents(parse,events,[value]);
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
 const valid=events.filter(e=>EVENTS.includes(e.event)&&(!session.threadId||e.session===session.threadId)&&e.server===String(session.serverPid)&&e.pane===session.pane&&e.created===String(session.created)&&Number.isFinite(e.at)&&e.at<=now+1000).sort(compareEvents);
 const latestParent=valid.filter(e=>!CHILD_EVENTS.has(e.event)).at(-1);
 const latestEvent=valid.at(-1);
 if(!session.threadId&&latestParent&&latestEvent.session!==latestParent.session&&!valid.some(e=>e.session===latestEvent.session&&!CHILD_EVENTS.has(e.event)))return {status:'unknown',reason:'unlinked-conversation',label:'Activity from another conversation has no parent status yet.',at:latestEvent.at};
 const conversation=session.threadId||latestParent?.session||valid.at(-1)?.session;
 const current=valid.filter(e=>e.session===conversation);
 const main=current.filter(e=>!CHILD_EVENTS.has(e.event)).at(-1);
 if(!current.length)return {status:'unknown',reason:'missing',label:NO_EVENTS};
 const latest=current.at(-1),boundary=current.filter(e=>['SessionStart','UserPromptSubmit','Interrupt','SessionEnd'].includes(e.event)).at(-1);
 const children=new Map();
 for(const event of current.filter(e=>CHILD_EVENTS.has(e.event)))children.set(event.child||'legacy',event);
 const snapshot=main?.event==='Stop'?current.filter(e=>['Stop','SubagentStop'].includes(e.event)&&e.background!==undefined&&e.at>=main.at).at(-1):undefined;
 const childrenAfter=Math.max(boundary?.at||0,snapshot?.at||0,...current.filter(e=>e.event==='Stop').map(e=>e.at));
 const liveChildren=[...children.values()].filter(e=>e.at>childrenAfter&&e.event!=='SubagentStop').sort(compareEvents);
 const blockedChild=liveChildren.filter(e=>e.event==='SubagentBlocked').at(-1);
 const activeChild=liveChildren.filter(e=>e.event==='SubagentActivity').at(-1);
 let status,reason,label,at=main?.at||latest.at,agents,services;
 if(!main){status=blockedChild?'blocked':activeChild?'active':'unknown';at=(blockedChild||activeChild||latest).at;label=status==='unknown'?'Child update received; waiting for the main agent status':'Child agent '+(status==='active'?'working':'waiting for you')+'; parent status unavailable';}
 else if(main.event==='SessionStart'){
  status=blockedChild?'blocked':activeChild?'active':'idle';label=blockedChild?'Child agent waiting for you':activeChild?'Child agent working':'Idle';at=(blockedChild||activeChild||main).at;
 }else if(['SessionEnd','Interrupt'].includes(main.event)){
  status=main.event==='SessionEnd'?'unknown':'idle';label=main.event==='SessionEnd'?'Session ended':'Idle';
 }else if(['PermissionRequest','Notification'].includes(main.event)){status='blocked';label='Waiting for you';}
 else if(main.event!=='Stop'){
  status=blockedChild?'blocked':'active';label=blockedChild?'Child agent waiting for you':'Working';at=Math.max(at,(blockedChild||activeChild)?.at||0);
 }else{
  // Only explicitly reported running services count. Version 0.1.83 did
  // not retain service states, so its omitted counts cannot prove completion.
  agents=snapshot?.agents;services=snapshot?.services;
  const uncertain=snapshot?((snapshot.uncertain??(snapshot.background>0?1:0))||(services===undefined&&snapshot.background>(agents||0)?1:0)):0;
  if(blockedChild){status='blocked';label='Child agent waiting for you';at=blockedChild.at;}
  else if(activeChild||agents>0||services>0){status='active';label=activeChild?'Child agent working':[agents>0?'Background agents working ('+agents+')':'',services>0?'Background services reported running ('+services+')':''].filter(Boolean).join('; ');at=activeChild?.at||snapshot.at;}
  else if(uncertain){status='unknown';reason='unclassified-background';label='Reply finished; background job types are unknown. Waiting for a fresh status event.';at=snapshot.at;}
  else {status='done';label='Turn finished';}
 }
 // Neither old task counts nor a silent process prove continued activity.
 if(['active','blocked'].includes(status)&&now-at>15*60*1000)return {status:'unknown',reason:'stale',label:'No recent update; last working/waiting event over 15 minutes ago',at};
 const prompt=current.filter(e=>e.event==='UserPromptSubmit').at(-1);
 const ended=current.filter(e=>['Stop','Interrupt','SessionEnd'].includes(e.event)&&e!==main).at(-1);
 const since=prompt&&(!ended||prompt.at>ended.at)&&(main?.event!=='Stop'||agents>0)?prompt.at:undefined;
 return {status,label,at,since,event:main?.event||latest.event,...(reason?{reason}:{}),...(agents===undefined?{}:{agents}),...(services===undefined?{}:{services})};
}
class Lifecycle{
 constructor(base=root()){this.base=base;this.rows=new Map();this.checkpoints=new Map();this.threadCheckpoints=new Map();}
 async refresh(sessions){
  const rows=new Map(),usedThreads=new Set();
  const bindings=new Map();for(const session of sessions)if(session.threadId){const bound=bindings.get(session.threadId)||new Set();bound.add([session.serverPid,session.pane,session.created].join(':'));bindings.set(session.threadId,bound);}
  await Promise.all(sessions.map(async session=>{
   if(session.threadId&&bindings.get(session.threadId).size>1){rows.set(session.sessionName,{status:'unknown',label:'This conversation is linked to multiple terminals. Link the correct Session ID for each terminal.'});return;}
   const id=key(String(session.serverPid),session.pane),dir=path.join(this.base,id);
   const events=await Promise.all(EVENTS.map(event=>readJson(path.join(dir,event+'.json'),2048)));
   const previous=this.checkpoints.get(id)||await readJson(path.join(dir,'state.json'),1024*1024);
   let replay;
   const parse=value=>{const e=storedEvent(value);return e&&e.server===String(session.serverPid)&&e.pane===session.pane&&e.created===String(session.created)&&(!session.threadId||e.session===session.threadId)?e:undefined;};
   try{replay=await readJournal(dir,previous,events.filter(Boolean),parse);}
   catch{rows.set(session.sessionName,{status:'unknown',label:'Status journal could not be read; previous records have been preserved.'});return;}
   let recovered=[];
   // An earlier ancestry-verified parent event is an exact conversation link,
   // not a folder/name guess. Recover later events even if their tmux lookup failed.
   const thread=session.threadId||replay.events.filter(e=>!CHILD_EVENTS.has(e.event)).sort(compareEvents).at(-1)?.session;
   if(thread){
    usedThreads.add(thread);
    const threadDir=path.join(this.base,'threads',threadKey(thread));
    try{
     const legacy=await Promise.all(EVENTS.map(event=>readJson(path.join(threadDir,event+'.json'),2048)));
     const parseThread=value=>{const e=storedThreadEvent(value);return e?.session===thread?e:undefined;};
     const previousThread=this.threadCheckpoints.get(thread)||await readJson(path.join(threadDir,'state.json'),1024*1024);
     const pending=await readJournal(threadDir,previousThread,legacy.filter(Boolean),parseThread);
     const checkpoint={version:CACHE_VERSION,...pending};this.threadCheckpoints.set(thread,checkpoint);
     if(pending.events.length&&JSON.stringify(checkpoint)!==JSON.stringify(previousThread))try{await atomicJson(path.join(threadDir,'state.json'),checkpoint);}catch{}
     recovered=pending.events.map(event=>({...event,server:String(session.serverPid),pane:session.pane,created:String(session.created)}));
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
  for(const id of this.threadCheckpoints.keys())if(!usedThreads.has(id))this.threadCheckpoints.delete(id);
 }
 get(session){return this.rows.get(session)||{status:'unknown',label:NO_EVENTS};}
}
const profiles=['claude','claude2','claudel','claudelp','codex','codex2','codex3','codexl'];
function mergeHooks(config,command,claude){
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Expected a settings object');
 const next=structuredClone(config);next.hooks??={};if(typeof next.hooks!=='object'||Array.isArray(next.hooks))throw Error('Invalid hooks object');
 for(const event of EVENTS.filter(e=>!['SubagentActivity','SubagentBlocked'].includes(e)&&(claude?e!=='Interrupt':!['Notification','SubagentStop'].includes(e)))){
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
 return String(value).trim().match(new RegExp('^('+uuid+')$','i'))?.[1]?.toLowerCase()||String(value).match(new RegExp('^\\s*(?:│\\s*)?Session(?: ID)?:\\s*('+uuid+')\\s*(?:│)?\\s*$','im'))?.[1]?.toLowerCase();
}
async function bindThread(session,value,exec){
 const thread=parseThreadId(value);if(!thread)throw Error('Paste the Session ID from Codex /status.');
 const {stdout}=await exec('tmux',['display-message','-p','-t',session.pane,'#{pid}\x1f#{pane_id}\x1f#{session_created}']);
 if(stdout.trim()!==[session.serverPid,session.pane,session.created].join('\x1f'))throw Error('This terminal changed while linking. Try again.');
 await exec('tmux',['set-option','-p','-t',session.pane,'@agent_glue_thread_id',thread]);return thread;
}
module.exports={Lifecycle,summarize,mergeEvents,mergeHooks,install,parseThreadId,bindThread};
