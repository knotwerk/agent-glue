'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {read}=require('../src/tasks.cjs');
const {list}=require('../src/resources.cjs');
const task={title:'Build the thing',status:'active',owner:'claude-example',summary:'Checking',next:'Verify',updatedAt:'2026-10-21T12:00:00Z'};
test('tasks lists independent records, reports invalid files and never calls GitHub',async()=>{
 const root=tempDir('tasks');const dir=path.join(root,'.local/agent-glue/tasks');await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'one.json'),JSON.stringify(task));
 await fs.writeFile(path.join(dir,'two.json'),JSON.stringify({...task,status:'done',title:'Finished'}));
 await fs.writeFile(path.join(dir,'partial.json'),'{');
 await fs.writeFile(path.join(dir,'invalid.json'),JSON.stringify({...task,status:'running'}));
 await fs.writeFile(path.join(dir,'oversized.json'),' '.repeat(16385));
 await fs.writeFile(path.join(dir,'draft.tmp'),'{');
 const result=await list('tasks',root,{project:async()=>root,exec:async()=>{throw Error('No subprocess allowed');}});
 assert.deepEqual(result.items.map(x=>x.status),['active','done']);assert.match(result.warning,/3 task/);
 assert.equal(result.items[0].owner,'claude-example');
 await fs.writeFile(path.join(dir,'one.json'),JSON.stringify({...task,status:'blocked',next:'Need a decision'}));
 assert.equal((await read(root)).items[0].next,'Need a decision');
});
test('tasks handles missing folders and refuses symlink directories and records',async()=>{
 const root=tempDir('tasks-paths');assert.deepEqual((await read(root)).items,[]);
 const dir=path.join(root,'.local/agent-glue/tasks');await fs.mkdir(dir,{recursive:true});
 const outside=path.join(root,'outside.json');await fs.writeFile(outside,JSON.stringify(task));
 await fs.symlink(outside,path.join(dir,'link.json'));
 assert.match((await read(root)).warning,/1 task/);
 const linked=tempDir('tasks-linked');await fs.symlink(path.join(root,'.local'),path.join(linked,'.local'));
 await assert.rejects(read(linked),/real project directory/);
});

test('terminal status isolates session identities, sorts updates and validates optional reports',async()=>{
 const root=tempDir('terminal-status'),dir=path.join(root,'.local/agent-glue/tasks');await fs.mkdir(dir,{recursive:true});
 const first={id:'500:$1:100',sessionName:'claude-first'},second={id:'500:$2:101',sessionName:'claude-second'};
 const records={
  first:{...task,sessionId:first.id,request:'Fix the filters',files:['src/filters.js'],agents:['reviewer: checking'],tokens:1234},
  done:{...task,sessionId:first.id,status:'done',updatedAt:'2026-10-21T13:00:00Z'},
  second:{...task,sessionId:second.id},
  reused:{...task,sessionId:'500:$1:99',owner:first.sessionName},
  legacy:{...task,owner:first.sessionName},
  unknown:{...task},
  invalid:{...task,sessionId:first.id,tokens:-1}
 };
 for(const [name,record] of Object.entries(records))await fs.writeFile(path.join(dir,name+'.json'),JSON.stringify(record));
 const result=await list('tasks',root,{project:async()=>root,session:first});
 assert.deepEqual(result.items.map(r=>r.id),['task:done.json','task:first.json','task:legacy.json']);
 assert.equal(result.items[1].request,'Fix the filters');assert.deepEqual(result.items[1].files,['src/filters.js']);assert.equal(result.items[1].tokens,1234);
 assert.equal(result.items[0].tokens,undefined);assert.match(result.warning,/1 task/);
 assert.deepEqual((await read(root,{session:second})).items.map(r=>r.id),['task:second.json']);
});
