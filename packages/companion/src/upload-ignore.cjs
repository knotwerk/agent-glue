'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const queues=new Map();
const rule='/.local/agent-glue/inbox/';
async function ensureInboxIgnored(root,exec){
 const git=args=>exec('git',['-c','core.fsmonitor=false','-C',root,...args],{timeout:3000,maxBuffer:65536});
 const ignored=async()=>{try{await git(['check-ignore','-q','--','.local/agent-glue/inbox/probe']);return true;}catch(error){if(error.code===1)return false;throw Error('Could not check Git exclusions for the upload folder.');}};
 if(await ignored())return;
 // Ask Git for the shared exclude path: .git is a file in linked worktrees.
 const {stdout}=await git(['rev-parse','--path-format=absolute','--git-path','info/exclude']);
 const file=stdout.trim();
 if(!path.isAbsolute(file)||path.basename(file)!=='exclude'||path.basename(path.dirname(file))!=='info')throw Error('Could not locate Git local exclusions.');
 const pending=(queues.get(file)||Promise.resolve()).catch(()=>{}).then(async()=>{
  if(await ignored())return;
  const dir=path.dirname(file);
  await fs.mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const directory=await fs.lstat(dir);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('Git exclusions folder must be a real directory.');
  const handle=await fs.open(file,constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{
   const stat=await handle.stat();if(!stat.isFile()||stat.size>1024*1024)throw Error('Git exclusions file is invalid or too large.');
   const buffer=Buffer.alloc(1024*1024+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
   if(bytesRead>1024*1024)throw Error('Git exclusions file is too large.');
   const text=buffer.subarray(0,bytesRead).toString('utf8');
   if(!text.split(/\r?\n/).includes(rule))await handle.writeFile((text&&!text.endsWith('\n')?'\n':'')+'\n# Agent Glue: local uploaded attachments\n'+rule+'\n');
  }finally{await handle.close();}
  if(!await ignored())throw Error('A project Git ignore rule overrides the local upload exclusion. Allow /.local/agent-glue/inbox/ to be ignored before uploading.');
 });
 queues.set(file,pending);
 try{await pending;}finally{if(queues.get(file)===pending)queues.delete(file);}
}
module.exports={ensureInboxIgnored};
