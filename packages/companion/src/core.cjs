'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);
const MAX_BYTES = 200 * 1024 * 1024;
const supported = p => /\.(md|markdown|html?)$/i.test(p);
function parseSessions(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, pane, cwd, title, serverPid, created, threadId] = line.split('\x1f');
    return { id, serverPid, created, ...(threadId?{threadId}:{}), name: title || name, sessionName:name, pane, cwd, profile:name?.split('-')[0], available:true };
  }).filter(s => /^\$\d+$/.test(s.id) && /^%\d+$/.test(s.pane) && /^(codex[23l]?|claude[2l]?|claudelp)(?:-|$)/.test(s.sessionName)).map(s=>({...s,id:s.serverPid&&s.created?`${s.serverPid}:${s.id}:${s.created}`:s.id}));
}
async function sessions(exec = run) {
  try { return parseSessions((await exec('tmux',['list-panes','-a','-F','#{?#{&&:#{window_active},#{pane_active}},#{session_id}\x1f#{session_name}\x1f#{pane_id}\x1f#{pane_current_path}\x1f#{@title}\x1f#{pid}\x1f#{session_created}\x1f#{@agent_glue_thread_id},}'], {maxBuffer:1024*1024})).stdout); }
  catch (error) { if (/no server running|no such file/i.test(error.stderr || '')) return []; throw error; }
}
function sessionForTerminal(terminal,list,mappedName){
  const mapped=list.find(s=>s.sessionName===mappedName);
  if(mapped)return mapped;
  const name=String(terminal?.name||'').trim();
  if(!name||/^(bash|zsh|sh|tmux|node|claude|codex)$/i.test(name))return undefined;
  const matches=list.filter(s=>{
    const short=s.sessionName.replace(/^(?:codex[23l]?|claude[2l]?|claudelp)-/,'').replace(/^\d{8}_\d{6}-|-[0-9]{8}_[0-9]{6}$/g,'');
    return [s.name,s.sessionName,short].includes(name);
  });
  return matches.length===1?matches[0]:undefined;
}
async function discoverReferences(text,cwd,{projectRoot=project,stat=fs.stat}={}){
  const root=await projectRoot(cwd).catch(()=>cwd);
  const primary=references(text,cwd);
  const resolve=async file=>{
    const alternate=path.resolve(root,file.referencePath);
    for(const candidate of [file,...(alternate!==file.path?[{...file,id:alternate,path:alternate}]:[])]){
      try{const info=await stat(candidate.path);if(info.isFile())return {...candidate,...(Number.isFinite(info.mtimeMs)?{modified:info.mtimeMs}:{})};}catch{}
    }
  };
  const found=await Promise.all(primary.map(resolve));
  // CLIs sometimes draw hard line breaks themselves, which tmux capture -J
  // cannot join. Recover bounded path-only continuations, verifying the result
  // on disk before showing it. Never infer pin/remove directives from a join.
  const lines=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split('\n');
  let budget=200;
  for(let i=0;i<lines.length-1&&budget>0;i++){
    const start=lines[i].trimEnd().match(/(?:^|[\s`"'(*])((?:\/|\.\.?\/|[A-Za-z0-9_-]+\/)[A-Za-z0-9_./%+~-]*)$/);
    if(!start)continue;
    let joined=start[1];
    // A complete existing file is never joined to the next line.
    if(await resolve({referencePath:joined,path:path.resolve(cwd,joined)}))continue;
    for(let j=i+1;j<Math.min(lines.length,i+9)&&budget>0;j++){
      const next=lines[j].trim().match(/^([A-Za-z0-9_./%+~-]+)(?:[`"')*]+)?$/);
      if(!next)break;
      joined+=next[1];if(joined.length>4096)break;
      budget--;
      const candidate=references(joined,cwd).find(file=>file.referencePath===joined);
      if(!candidate)continue;
      const existing=await resolve(candidate);
      if(existing){found.push(existing);break;}
    }
  }
  return [...new Map(found.filter(Boolean).map(f=>[f.id,f])).values()];
}
function references(text,cwd) {
  const found = new Map();
  // capture-pane -J joins soft wraps; discovery also handles hard-wrapped paths.
  const lines=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split('\n');
  for (const [lineIndex,line] of lines.entries()) {
    const pattern = /(?:\[[^\]]*\]\(<?([^)>]+\.(?:[a-zA-Z][a-zA-Z0-9]{0,15}))(?:\:\d+(?::\d+)?)?>?\)|["'`]([^"'`]+\.(?:[a-zA-Z][a-zA-Z0-9]{0,15}))["'`]|((?:\/|\.\.?\/|[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-][^\s<>"'`]*?\.(?:[a-zA-Z][a-zA-Z0-9]{0,15})))(?=$|[\s):,;#?!\]*]|\.(?=\s|$))/gi;
    for (const match of line.matchAll(pattern)) {
      const raw = match[1] || match[2] || match[3];
      if (!raw || /^[a-z]+:/i.test(raw)) continue;
      if (match[3] && /[:\w/.-]/.test(line[match.index - 1] || '')) continue;
      const file = path.resolve(cwd,raw);
      const marker=/^\s*\[(share|pin|unpin|remove)\]\s+/i.exec(line);
      const prior=found.get(file);
      found.delete(file); // Repeated paths take the position of their latest mention.
      found.set(file,{id:file,path:file,mentionKey:crypto.createHash('sha256').update(lines.slice(Math.max(0,lineIndex-2),lineIndex+1).join('\n')+'|'+match.index).digest('hex'),referencePath:raw,label:path.basename(file),pinned:line.includes('[pin]'),...(prior?.action?{action:prior.action,directive:prior.directive}:{}),...(marker?{action:marker[1].toLowerCase(),directive:line.trim()}: {})});
    }
  }
  return [...found.values()];
}
function observe(previous, incoming) {
  const map = new Map(previous.map(f=>[f.id,{...f}]));
  let seen = Math.max(Date.now(), ...previous.map(f=>f.seen||0));
  for (const f of incoming) {
    const old = map.get(f.id);
    const item=old||{...f};
    if(!old||!f.mentionKey||old.mentionKey!==f.mentionKey)item.seen=++seen;
    if(f.mentionKey)item.mentionKey=f.mentionKey;
    if(Number.isFinite(f.modified))item.modified=f.modified;
    item.missing=false; // Incoming references have been checked by discovery.
    if(f.action&&item.lastDirective!==f.directive){
      if(f.action==='pin'){item.pinned=true;item.hidden=false;}
      if(f.action==='share')item.hidden=false;
      if(f.action==='unpin')item.pinned=false;
      if(f.action==='remove'){item.hidden=true;item.pinned=false;}
      item.lastDirective=f.directive;
    }else if(!f.action&&f.pinned&&!item.manual&&!item.hidden)item.pinned=true;
    map.set(f.id,item);
  }
  const recent=file=>Math.max(file.seen||0,file.modified||0);
  const sorted=[...map.values()].sort((a,b)=>recent(b)-recent(a));
  return [...sorted.filter(f=>f.pinned&&!f.hidden),...sorted.filter(f=>!f.pinned&&!f.hidden&&!f.missing).slice(0,100),...sorted.filter(f=>!f.pinned&&!f.hidden&&f.missing).slice(0,100),...sorted.filter(f=>f.hidden).slice(0,250)];
}
async function inside(root,candidate) {
  const [r,p] = await Promise.all([fs.realpath(root),fs.realpath(candidate)]);
  const relative=path.relative(r,p);
  if (relative==='..'||relative.startsWith('../')||path.isAbsolute(relative)) throw new Error('File is outside the document project.');
  return p;
}
async function project(cwd, exec=run) {
  const {stdout}=await exec('git',['-c','core.fsmonitor=false','-C',cwd,'rev-parse','--show-toplevel']);
  return fs.realpath(stdout.trim());
}
class Uploads {
  constructor(exec=run){this.active=new Map();this.pending=new Set();this.exec=exec;}
  async start(message,root,targetId){
    if(this.pending.has(message.id)||this.active.has(message.id)||this.active.size+this.pending.size>=4)throw new Error('Upload identity is in use or too many uploads are active.');
    this.pending.add(message.id);
    try{return await this.begin(message,root,targetId);}finally{this.pending.delete(message.id);}
  }
  async begin(message,root,targetId) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(message.id) || this.active.has(message.id)) throw new Error('Invalid upload identity.');
    if (!Number.isSafeInteger(message.size)||message.size<0||message.size>MAX_BYTES) throw new Error('Files must be 200 MB or smaller.');
    const inbox=path.join(root,'.local/agent-glue/inbox');
    // Require ignore coverage before storing any attachment.
    await this.exec('git',['-c','core.fsmonitor=false','-C',root,'check-ignore','-q','--','.local/agent-glue/inbox/probe']).catch(()=>{throw new Error('Ignore .local/agent-glue/ in this project before uploading.');});
    let current=root;
    for(const segment of ['.local','agent-glue','inbox']) {
      current=path.join(current,segment);
      await fs.mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      const stat=await fs.lstat(current);
      if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Attachment folder must be a real directory.');
    }
    await inside(root,inbox);
    const name=path.basename(String(message.name||'attachment')).replace(/[^a-zA-Z0-9._ -]/g,'_').slice(-160)||'attachment';
    const file=path.join(inbox,`${crypto.randomUUID()}-${name}`);
    await this.exec('git',['-c','core.fsmonitor=false','-C',root,'check-ignore','-q','--',path.relative(root,file)]).catch(()=>{throw new Error('The attachment filename is not ignored by Git.');});
    const handle=await fs.open(file,'wx',0o600);
    this.active.set(message.id,{handle,path:file,name,size:message.size,received:0,targetId,lastActivity:Date.now()});
  }
  async chunk(message) {
    const item=this.active.get(message.id);
    if(!item||item.busy||message.offset!==item.received||typeof message.data!=='string'||message.data.length>300000||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data))throw new Error('Invalid upload chunk.');
    const bytes=Buffer.from(message.data,'base64');
    if(item.received+bytes.length>item.size)throw new Error('Upload exceeds announced size.');
    item.busy=true;item.lastActivity=Date.now();
    try {
    let written=0;
    while(written<bytes.length){const result=await item.handle.write(bytes,written,bytes.length-written,item.received+written); if(!result.bytesWritten)throw new Error('Upload write failed.'); written+=result.bytesWritten;}
    item.received+=bytes.length;
    return item.received;
    }finally{item.busy=false;}
  }
  async finish(id) {
    const item=this.active.get(id);
    if(!item||item.busy||item.received!==item.size)throw new Error('Upload is incomplete.');
    try{await item.handle.sync();}finally{await item.handle.close();this.active.delete(id);}
    const {handle,...attachment}=item;return attachment;
  }
  async abort(id){const item=this.active.get(id);if(item){await item.handle.close().catch(()=>{});this.active.delete(id);}}
  async expire(){for(const [id,item] of this.active)if(!item.busy&&Date.now()-item.lastActivity>120000)await this.abort(id);}
  async close(){for(const item of this.active.values())await item.handle.close();this.active.clear();}
}
function privatePath(relative){
  const parts=relative.toLowerCase().split(/[\\/]/).filter(p=>p&&p!=='.');
  return parts[0]==='memory'||parts.some(p=>['.git','.claude','.codex'].includes(p));
}
function draftText(draft){return [draft.text,...(draft.attachments||[]).map(a=>a.path)].filter(Boolean).join('\n\n');}
function paste(terminal,draft){if(!terminal)throw new Error('The selected terminal is unavailable. Your draft is preserved.'); const text=draftText(draft); if(/[\x00-\x08\x0b-\x1f\x7f]/.test(text))throw new Error('Remove control characters before pasting.'); terminal.show();terminal.sendText('\x1b[200~'+text+'\x1b[201~',false);}
module.exports={privatePath,sessionForTerminal,discoverReferences,run,sessions,parseSessions,references,observe,inside,project,Uploads,draftText,paste,supported};
