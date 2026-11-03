'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {projectApps}=require('../src/web-app-registrations.cjs');
const registry=root=>path.join(root,'.local/agent-glue/web-apps.json');
async function write(root,value){await fs.mkdir(path.dirname(registry(root)),{recursive:true});await fs.writeFile(registry(root),JSON.stringify(value));}
const app={id:'preview',label:'Preview',url:'http://127.0.0.1:5178/'};
function git(root,primary=root){return async(cmd,args,options)=>{
 assert.equal(cmd,'git');assert.equal(options.timeout,1500);assert.ok(options.maxBuffer<=256*1024);
 return {stdout:args.includes('rev-parse')?root+'\n':`worktree ${primary}\n\nworktree ${root}\n`};
};}
test('nested folders use their git root registry; unsafe URLs, duplicates and labels are bounded',async()=>{
 const root=tempDir('web-app-registry');
 await write(root,{version:1,apps:[app,{id:'evil',url:'https://example.org/'},{id:'auth',url:'http://user:pass@localhost:42/'},{...app,url:'http://localhost:1234/'},{id:'duplicate',url:app.url},{id:'clean',label:'a\nb'+ 'x'.repeat(200),url:'http://localhost:3000/'}]});
 const result=await projectApps(path.join(root,'nested'),{exec:git(root)});
 assert.equal(result.root,root);assert.equal(result.apps.length,2);assert.deepEqual(result.apps[0],app);
 assert.equal(result.apps[1].label.length,160);assert.ok(!result.apps[1].label.includes('\n'));
});
test('linked worktree falls back to primary registry; local empty or invalid file never merges',async()=>{
 const primary=tempDir('web-primary'),root=tempDir('web-worktree');await write(primary,{version:1,apps:[app]});
 const exec=git(root,primary);assert.equal((await projectApps(root,{exec})).root,primary);
 await write(root,{version:1,apps:[]});assert.deepEqual(await projectApps(root,{exec}),{root,apps:[]});
 await write(root,{version:2,apps:[app]});await assert.rejects(projectApps(root,{exec}),/Invalid web app registration/);
});
test('missing and non-git folders do not invent registrations',async()=>{
 const root=tempDir('web-missing');assert.equal(await projectApps(root,{exec:git(root)}),undefined);
 await assert.rejects(projectApps(root,{exec:async()=>{throw Error('not git');}}),/not git/);
});
test('oversized files and symlink registries or directories are rejected before reading',async()=>{
 const root=tempDir('web-large');await write(root,{version:1,apps:[],padding:'x'.repeat(65536)});
 await assert.rejects(projectApps(root,{exec:git(root)}),/size/);
 const target=tempDir('web-target');await write(target,{version:1,apps:[app]});
 const linked=tempDir('web-symlink');await fs.mkdir(path.dirname(registry(linked)),{recursive:true});await fs.symlink(registry(target),registry(linked));
 await assert.rejects(projectApps(linked,{exec:git(linked)}),/symlink/);
 const parent=tempDir('web-parent-link');await fs.symlink(path.join(target,'.local'),path.join(parent,'.local'));
 await assert.rejects(projectApps(parent,{exec:git(parent)}),/symlink/);
});
test('registration processes at most thirty entries',async()=>{
 const root=tempDir('web-limit');await write(root,{version:1,apps:Array.from({length:31},(_,i)=>({id:'app'+i,url:`http://localhost:${3000+i}/`}))});
 assert.equal((await projectApps(root,{exec:git(root)})).apps.length,30);
});
