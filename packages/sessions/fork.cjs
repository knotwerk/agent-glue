'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const quote=s=>`'${String(s).replace(/'/g,"'\\''")}'`;
function profile(program){
 if(!/^(codex[23l]?|claude[2l]?|claudelp)$/.test(program))throw Error('Unsupported agent account.');
 const codex=program.startsWith('codex');
 return {cli:codex?'codex':'claude',envKey:codex?'CODEX_HOME':'CLAUDE_CONFIG_DIR',home:path.join(os.homedir(),'.'+program)};
}
async function readMetadata(file){
 const handle=await fs.open(file,'r');try{const buffer=Buffer.alloc(65537);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>65536)throw Error('Session metadata is too large.');return buffer.subarray(0,bytesRead).toString('utf8');}finally{await handle.close();}
}
async function resolveThread(pid,account,exec,read=readMetadata){
 if(account.cli==='claude'){
  try{const value=JSON.parse(await read(path.join(account.home,'sessions',`${pid}.json`),'utf8'));
   const {stdout}=await exec('ps',['-p',String(pid),'-o','lstart=']);const started=Date.parse(stdout.trim());
   if(value.pid===Number(pid)&&uuid.test(value.sessionId)&&Number.isFinite(started)&&value.startedAt>=started-2000)return value.sessionId;
  }catch{}
 }
 // Open rollout descriptors identify the running process, not another chat
 // with a similar title, directory, or creation timestamp.
 const {stdout}=await exec('lsof',['-p',String(pid),'-Fn'],{timeout:3000,maxBuffer:1024*1024}).catch(()=>({stdout:''}));
 const ids=new Set();
 for(const line of stdout.split('\n')){
  if(!line.startsWith('n'+account.home+'/sessions/'))continue;
  const match=line.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  if(match)ids.add(match[1]);
 }
 if(ids.size===1)return [...ids][0];
 if(ids.size===0&&account.cli==='codex'){
  const {stdout:started}=await exec('ps',['-p',String(pid),'-o','lstart=']);
  const since=Date.parse(started.trim());
  const {stdout:cwdRows}=await exec('lsof',['-a','-p',String(pid),'-d','cwd','-Fn']).catch(()=>({stdout:''}));
  const cwd=account.cwd||cwdRows.split('\n').find(line=>line.startsWith('n'))?.slice(1);
  if(Number.isFinite(since)&&cwd){
   const paths=[];
   async function visit(dir,depth){if(depth>4||paths.length>=500)return;const entries=await fs.readdir(dir,{withFileTypes:true}).catch(()=>[]);for(const entry of entries.sort((a,b)=>b.name.localeCompare(a.name))){if(paths.length>=500)break;const file=path.join(dir,entry.name);if(entry.isDirectory())await visit(file,depth+1);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))paths.push(file);}}
   await visit(path.join(account.home,'sessions'),0);
   const records=[];
   for(const file of paths.sort().reverse().slice(0,120)){
    let handle;try{handle=await fs.open(file,'r');const buffer=Buffer.alloc(16384);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);const first=buffer.subarray(0,bytesRead).toString('utf8').split('\n')[0];const record=JSON.parse(first);if(record.type==='session_meta')records.push(record.payload);}catch{}finally{await handle?.close();}
   }
   const matches=metadataMatches(records,cwd,since);if(matches.length===1)return matches[0];
  }
 }
 throw Error('The running CLI has not exposed an unambiguous conversation identity. Retry after its next turn. No conversation was forked.');
}
function metadataMatches(records,cwd,since){
 const candidates=records.filter(r=>r.cwd===cwd&&r.source==='cli'&&uuid.test(r.id)&&Date.parse(r.timestamp)>=since-2000);
 const ids=[...new Set(candidates.map(r=>r.id))];
 // A later unrelated chat must not be mistaken for an older resumed chat.
 if(ids.length===1&&!candidates.some(r=>Date.parse(r.timestamp)<=since+2000))return [];
 return ids;
}
async function forkSession(source,destination,{exec,createTerminal,register,resolve=resolveThread,stat=fs.stat}){
 const {stdout}=await exec('tmux',['display-message','-p','-t',source.pane,'#{session_id}\x1f#{pid}\x1f#{session_created}\x1f#{pane_pid}\x1f#{pane_current_path}']);
 const [sid,server,created,panePid,panePath]=stdout.trim().split('\x1f');
 if(`${server}:${sid}:${created}`!==source.id)throw Error('The source terminal changed or closed.');
 if(!(await stat(destination)).isDirectory())throw Error('Choose an existing directory on the workspace host.');
 const account=profile(source.profile);account.cwd=panePath;
 const table=(await exec('ps',['-eo','pid=,ppid=,comm='])).stdout.split('\n').map(l=>l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
 const descendants=new Set([panePid]);let changed=true;
 while(changed){changed=false;for(const r of table)if(descendants.has(r[2])&&!descendants.has(r[1])){descendants.add(r[1]);changed=true;}}
 const candidates=table.filter(r=>descendants.has(r[1])&&path.basename(r[3])===account.cli);
 if(candidates.length!==1)throw Error('Cannot identify one running agent in this pane. No conversation was forked.');
 const parent=await resolve(candidates[0][1],account,exec);
 let child=crypto.randomUUID();
 const env={...process.env,[account.envKey]:account.home};
 const helpArgs=account.cli==='codex'?['exec','fork','--help']:['--help'];
 const help=await exec(account.cli,helpArgs,{cwd:destination,env,timeout:10000,maxBuffer:1024*1024});
 if(account.cli==='codex'?!help.stdout.includes('--json'):!help.stdout.includes('--fork-session')||!help.stdout.includes('--session-id'))throw Error('Update the agent CLI to a version with native conversation forking.');
 if(account.cli==='codex'){
  const result=await exec('codex',['exec','-C',destination,'--json','fork',parent],{cwd:destination,env,timeout:30000,maxBuffer:1024*1024});
  const started=result.stdout.split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}}).find(e=>e.type==='thread.started');
  if(!uuid.test(started?.thread_id))throw Error('Codex did not return a fork identity. No terminal was created.');
  child=started.thread_id;
 }
 const title=source.name+'-fork-'+crypto.randomBytes(2).toString('hex');
 const session=source.profile+'-'+title.replace(/[^a-zA-Z0-9-]/g,'-');
 const args=account.cli==='codex'?['resume',child,'-C',destination]:['--resume',parent,'--fork-session','--session-id',child,'--name',title];
 const command=`${account.envKey}=${quote(account.home)} command ${account.cli} ${args.map(quote).join(' ')}`;
 await exec('tmux',['new-session','-d','-s',session,'-c',destination,'zsh','-lic',command]);
 await exec('tmux',['set-option','-t','='+session,'@title',title]);
 await exec('tmux',['set-option','-t','='+session,'@agent_glue_thread_id',child]);
 const terminal=createTerminal({name:title,shellPath:path.join(__dirname,'helpers/agent-tmux-attach.zsh'),shellArgs:[session,title],cwd:destination});
 register(session,terminal);terminal.show();return {session,threadId:child};
}
module.exports={profile,resolveThread,forkSession,metadataMatches};
