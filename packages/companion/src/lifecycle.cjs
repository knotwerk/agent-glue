'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {EVENTS,root,key}=require('./lifecycle-hook.cjs');
function summarize(events,session,now=Date.now()){
 const valid=events.filter(e=>EVENTS.includes(e.event)&&e.server===String(session.serverPid)&&e.pane===session.pane&&e.created===String(session.created)&&Number.isFinite(e.at)&&e.at<=now+1000).sort((a,b)=>a.at-b.at);
 const latest=valid.at(-1);if(!latest)return {status:'unknown',label:'No lifecycle events yet. In Codex, check /hooks trust; existing CLI sessions may need their hooks reloaded.'};
 const current=valid.filter(e=>e.session===latest.session);
 if(now-latest.at>15*60*1000&&!['Stop','SessionStart','Interrupt','SessionEnd'].includes(latest.event))return {status:'unknown',label:'No recent update; last working/waiting event over 15 minutes ago',at:latest.at};
 let status=({SessionStart:'idle',UserPromptSubmit:'active',PreToolUse:'active',PostToolUse:'active',PermissionRequest:'blocked',Notification:'blocked',Stop:'done',Interrupt:'idle',SessionEnd:'unknown'})[latest.event];
 const prompt=current.find(e=>e.event==='UserPromptSubmit'&&e.at<=latest.at);
 return {status,label:({active:'Working',blocked:'Waiting for you',done:'Turn finished',idle:'Idle',unknown:'Session ended'})[status],at:latest.at,since:prompt?.at||latest.at,event:latest.event};
}
class Lifecycle{
 constructor(base=root()){this.base=base;this.rows=new Map();}
 async refresh(sessions){
  const rows=new Map();
  await Promise.all(sessions.map(async session=>{
   const events=await Promise.all(EVENTS.map(async event=>{
    try{const file=path.join(this.base,key(String(session.serverPid),session.pane),event+'.json');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2048)return;return JSON.parse(await fs.readFile(file,'utf8'));}catch{return;}
   }));rows.set(session.sessionName,summarize(events.filter(Boolean),session));
  }));this.rows=rows;
 }
 get(session){return this.rows.get(session)||{status:'unknown',label:'No lifecycle events yet. In Codex, check /hooks trust; existing CLI sessions may need their hooks reloaded.'};}
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
 const helper=path.join(base,'hook.cjs');await fs.copyFile(source,helper);await fs.chmod(helper,0o600);
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
