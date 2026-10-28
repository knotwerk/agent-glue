'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const core=require('./core.cjs');
const MAX_BYTES=4*1024*1024;
const relative='.local/agent-glue/review-comments.jsonl';
function file(root){return path.join(root,relative);}
async function read(root){
  if(!root)return [];
  let handle;
  try{
    await core.inside(root,file(root));
    handle=await fs.open(file(root),constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Local feedback file is invalid or larger than 4 MB.');
    const text=await handle.readFile('utf8');
    // A different window may currently be appending its last record.
    const lines=text.split('\n');lines.pop();
    return lines.filter(Boolean).map(line=>{
      const row=JSON.parse(line);
      if(row.version!==1||typeof row.reviewId!=='string'||typeof row.body!=='string'||typeof row.createdAt!=='string')throw new Error('Invalid local feedback record.');
      return row;
    });
  }catch(error){if(error.code==='ENOENT')return [];throw error;}
  finally{await handle?.close();}
}
async function save(item,body,{exec=core.run}={}){
  if(!item.local||!item.reviewRoot||!item.id.startsWith('local:'))throw new Error('Reopen this prepared review from Agent Glue before saving feedback.');
  if(typeof body!=='string'||!body.trim())throw new Error('Write a comment first.');
  if(Buffer.byteLength(body,'utf8')>60000)throw new Error('Comment must be 60 KB or smaller.');
  const root=await fs.realpath(item.reviewRoot);
  await exec('git',['-c','core.fsmonitor=false','-C',root,'check-ignore','-q','--',relative]).catch(()=>{throw new Error('Ignore .local/agent-glue/ in this repository before saving local feedback.');});
  let directory=root;
  for(const segment of ['.local','agent-glue']){
    directory=path.join(directory,segment);
    await fs.mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await fs.lstat(directory);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Local feedback requires real project directories.');
  }
  const row={version:1,id:crypto.randomUUID(),reviewId:item.id,title:item.title,backlogId:item.backlogId||'',branch:item.branch||'',bodyFile:item.bodyFile||'',author:{login:'Local reviewer'},createdAt:new Date().toISOString(),body};
  const handle=await fs.open(file(root),constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{
    const stat=await handle.stat(),bytes=Buffer.from(JSON.stringify(row)+'\n');
    if(!stat.isFile()||stat.size+bytes.length>MAX_BYTES)throw new Error('Local feedback file is invalid or larger than 4 MB.');
    const result=await handle.write(bytes);
    if(result.bytesWritten!==bytes.length)throw new Error('Incomplete local feedback write. Check the feedback file before retrying.');
    await handle.sync();
  }finally{await handle.close();}
  return row;
}
function prompt(root){
  return `Review all local PR feedback in ${file(root)} against the prepared reviews in ${path.join(root,'.local/agent-glue/reviews.json')}. Read the linked review material, make the requested changes, and report which comment IDs you addressed or need clarified. Preserve the feedback log. Do not push or publish unless separately authorized.`;
}
module.exports={read,save,file,prompt};
