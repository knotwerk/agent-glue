'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {EVENTS,root,key,storedEvent,atomicJson}=require('./lifecycle-hook.cjs');
const NO_EVENTS='No lifecycle events yet. In each Codex account, use /hooks to review and enable all Agent Glue entries (--agent-glue-hook).';
const REPLAY_BYTES=2*1024*1024;
async function readJson(file,maxBytes){
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)return;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return;}
}
function mergeEvents(...groups){
 const slots=new Map();
 for(const group of groups)for(const value of Array.isArray(group)?group:[]){const event=storedEvent(value);if(event&&(!slots.has(event.event)||event.at>=slots.get(event.event).at)){slots.delete(event.event);slots.set(event.event,event);}}
 return [...slots.values()];
}
async function readJournal(dir,previous,legacy){
 const flags=require('node:fs').constants;
 let handle;
 try{handle=await fs.open(path.join(dir,'events.jsonl'),flags.O_RDONLY|(flags.O_NOFOLLOW||0));}
 catch(error){if(error.code==='ENOENT')return {events:mergeEvents(previous?.events||[],legacy),cursor:null};throw error;}
 try{
  const stat=await handle.stat();if(!stat.isFile())throw Error('Unsafe observer journal');
  const compatible=previous?.version===1&&Array.isArray(previous.events)&&previous.events.length<=EVENTS.length&&previous.events.every(storedEvent)&&previous.cursor?.dev===stat.dev&&previous.cursor?.ino===stat.ino&&Number.isSafeInteger(previous.cursor.offset)&&previous.cursor.offset>=0&&previous.cursor.offset<=stat.size;
  let offset=compatible?previous.cursor.offset:0,events=mergeEvents(compatible?previous.events:legacy);
  const bytes=Buffer.alloc(Math.min(REPLAY_BYTES,stat.size-offset));
  const {bytesRead}=await handle.read(bytes,0,bytes.length,offset);
  const complete=bytes.subarray(0,bytesRead).lastIndexOf(10);
  if(complete>=0){
   for(const line of bytes.subarray(0,complete+1).toString('utf8').split('\n')){
    if(!line||line.length>2048)continue;
    try{events=mergeEvents(events,[JSON.parse(line)]);}catch{/* Skip a torn or corrupt record; subsequent records remain readable. */}
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
 const valid=events.filter(e=>EVENTS.includes(e.event)&&e.server===String(session.serverPid)&&e.pane===session.pane&&e.created===String(session.created)&&Number.isFinite(e.at)&&e.at<=now+1000).sort((a,b)=>a.at-b.at);
 const latest=valid.at(-1);if(!latest)return {status:'unknown',label:NO_EVENTS};
 const current=valid.filter(e=>e.session===latest.session);
 if(now-latest.at>15*60*1000&&!['Stop','SessionStart','Interrupt','SessionEnd'].includes(latest.event))return {status:'unknown',label:'No recent update; last working/waiting event over 15 minutes ago',at:latest.at};
 let status=({SessionStart:'idle',UserPromptSubmit:'active',PreToolUse:'active',PostToolUse:'active',PermissionRequest:'blocked',Notification:'blocked',Stop:'done',Interrupt:'idle',SessionEnd:'unknown'})[latest.event];
 const prompt=current.find(e=>e.event==='UserPromptSubmit'&&e.at<=latest.at);
 const ended=current.filter(e=>['Stop','Interrupt','SessionEnd'].includes(e.event)&&e.at<latest.at).at(-1);
 const since=prompt&&(!ended||prompt.at>ended.at)?prompt.at:undefined;
 return {status,label:({active:'Working',blocked:'Waiting for you',done:'Turn finished',idle:'Idle',unknown:'Session ended'})[status],at:latest.at,since,event:latest.event};
}
class Lifecycle{
 constructor(base=root()){this.base=base;this.rows=new Map();this.checkpoints=new Map();}
 async refresh(sessions){
  const rows=new Map();
  await Promise.all(sessions.map(async session=>{
   const id=key(String(session.serverPid),session.pane),dir=path.join(this.base,id);
   const events=await Promise.all(EVENTS.map(event=>readJson(path.join(dir,event+'.json'),2048)));
   const previous=this.checkpoints.get(id)||await readJson(path.join(dir,'state.json'),16384);
   let replay;
   try{replay=await readJournal(dir,previous,events.filter(Boolean));}
   catch{rows.set(session.sessionName,{status:'unknown',label:'Status journal could not be read; previous records have been preserved.'});return;}
   const state=replay.catchingUp?{status:'unknown',label:'Recovering status from the event log…'}:summarize(replay.events,session);
   const snapshot={version:1,...replay,state};
   rows.set(session.sessionName,state);
   if(replay.events.length&&JSON.stringify(previous)!==JSON.stringify(snapshot)){
    // The log is authoritative. Snapshot failure never discards events or stops
    // live status; another host can safely replay from an older checkpoint.
    try{await atomicJson(path.join(dir,'state.json'),snapshot);}catch{}
   }
   this.checkpoints.set(id,snapshot);
  }));this.rows=rows;
  const live=new Set(sessions.map(s=>key(String(s.serverPid),s.pane)));for(const id of this.checkpoints.keys())if(!live.has(id))this.checkpoints.delete(id);
 }
 get(session){return this.rows.get(session)||{status:'unknown',label:NO_EVENTS};}
}
const profiles=['claude','claude2','claudel','claudelp','codex','codex2','codex3','codexl'];
function mergeHooks(config,command,claude){
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Expected a settings object');
 const next=structuredClone(config);next.hooks??={};if(typeof next.hooks!=='object'||Array.isArray(next.hooks))throw Error('Invalid hooks object');
 for(const event of EVENTS.filter(e=>claude?e!=='Interrupt':e!=='Notification')){
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
module.exports={Lifecycle,summarize,mergeHooks,install};
