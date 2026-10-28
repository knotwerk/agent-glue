'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const statuses=['active','blocked','review','done'];
async function read(root){
  const dir=path.join(root,'.local/agent-glue/tasks');
  try{
    const base=await fs.realpath(root);
    let current=base;
    for(const part of ['.local','agent-glue','tasks']){
      current=path.join(current,part);
      const info=await fs.lstat(current);
      if(!info.isDirectory()||info.isSymbolicLink())throw Error('Tasks folder must be a real project directory.');
    }
    const names=[];
    const directory=await fs.opendir(dir);
    for await(const entry of directory){
      if(entry.name.endsWith('.json'))names.push(entry.name);
      if(names.length>200)throw Error('Tasks supports up to 200 task files. Archive older tasks outside this folder.');
    }
    const items=[];let invalid=0;
    for(const name of names.sort()){
      let handle;
      try{
        handle=await fs.open(path.join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const info=await handle.stat();
        if(!info.isFile()||info.size>16384)throw Error('Invalid task file');
        const buffer=Buffer.alloc(16385);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
        if(bytesRead>16384)throw Error('Task too large');
        const task=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
        if(!task||typeof task.title!=='string'||!task.title.trim()||task.title.length>300||!statuses.includes(task.status))throw Error('Invalid task');
        for(const key of ['owner','summary','next'])if(task[key]!==undefined&&(typeof task[key]!=='string'||task[key].length>4000))throw Error('Invalid task text');
        if(typeof task.updatedAt!=='string'||!Number.isFinite(Date.parse(task.updatedAt)))throw Error('Missing update time');
        items.push({id:'task:'+name,label:task.title,status:task.status,owner:task.owner||'',summary:task.summary||'',next:task.next||'',updatedAt:new Date(task.updatedAt).toISOString()});
      }catch{invalid++;}finally{await handle?.close();}
    }
    items.sort((a,b)=>statuses.indexOf(a.status)-statuses.indexOf(b.status)||a.label.localeCompare(b.label,undefined,{numeric:true}));
    return {root,items,warning:invalid?`${invalid} task file(s) could not be read. Check JSON, status and updatedAt in .local/agent-glue/tasks/.`:''};
  }catch(error){if(error.code==='ENOENT')return {root,items:[]};throw error;}
}
module.exports={read};
