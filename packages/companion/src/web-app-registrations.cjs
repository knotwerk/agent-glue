'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const core=require('./core.cjs');
const {localUrl}=require('./web-apps.cjs');
const relative='.local/agent-glue/web-apps.json',limit=64*1024;
async function manifest(root){
 // Do not follow a registry or parent directory symlink into private files.
 let file=root;
 for(const part of relative.split('/')){
  file=path.join(file,part);const stat=await fs.lstat(file);
  if(stat.isSymbolicLink())throw Error('Web app registration must not be a symlink.');
 }
 const handle=await fs.open(file,'r');
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>limit)throw Error('Invalid web app registration size.');
  const buffer=Buffer.alloc(limit+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
  if(bytesRead>limit)throw Error('Web app registration is too large.');
  const value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  if(value?.version!==1||!Array.isArray(value.apps))throw Error('Invalid web app registration.');
  const apps=[],ids=new Set(),urls=new Set();
  for(const app of value.apps.slice(0,30)){
   if(!app||typeof app.id!=='string'||! /^[\w-]{1,80}$/.test(app.id)||typeof app.url!=='string'||app.url.length>2048)continue;
   const url=localUrl(app.url);if(!url||ids.has(app.id)||urls.has(url))continue;
   const label=typeof app.label==='string'?app.label.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,160):'';
   ids.add(app.id);urls.add(url);apps.push({id:app.id,url,...(label?{label}:{})});
  }
  return {root,apps};
 }finally{await handle.close();}
}
async function projectApps(cwd,{exec=core.run}={}){
 if(typeof cwd!=='string'||!cwd)return;
 const bounded=(cmd,args)=>exec(cmd,args,{timeout:1500,maxBuffer:256*1024});
 const root=await core.project(cwd,bounded);
 try{return await manifest(root);}catch(error){if(error.code!=='ENOENT')throw error;}
 // Like local reviews, a worktree's own registry wins, including an empty one.
 const {stdout}=await bounded('git',['-c','core.fsmonitor=false','-C',root,'worktree','list','--porcelain']);
 const first=stdout.match(/^worktree (.+)$/m)?.[1];if(!first)return;
 const primary=await fs.realpath(first);if(primary===root)return;
 try{return await manifest(primary);}catch(error){if(error.code!=='ENOENT')throw error;}
}
module.exports={projectApps};
