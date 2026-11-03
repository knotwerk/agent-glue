'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const core=require('../src/core.cjs');
const {ensureInboxIgnored}=require('../src/upload-ignore.cjs');
const {gitProject,tempDir}=require('../../../test/support/tmp.cjs');
const exclude=root=>path.join(root,'.git/info/exclude');
test('parallel first uploads append one exclusion and preserve existing content',async()=>{
 const root=gitProject('parallel-exclude',{ignoreLocal:false});const before=await fs.readFile(exclude(root),'utf8');
 await Promise.all(Array.from({length:4},()=>ensureInboxIgnored(root,core.run)));
 const after=await fs.readFile(exclude(root),'utf8');assert.ok(after.startsWith(before));
 assert.equal(after.split('/.local/agent-glue/inbox/').length,2);
});
test('existing ignore coverage causes no metadata change',async()=>{
 const root=gitProject('existing-exclude'),before=await fs.readFile(exclude(root),'utf8');
 await ensureInboxIgnored(root,core.run);assert.equal(await fs.readFile(exclude(root),'utf8'),before);
});
test('linked worktree uses Git shared local exclusions without creating a .git directory',async()=>{
 const root=gitProject('exclude-primary',{ignoreLocal:false});
 const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'});
 git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','Fixture']);
 const worktree=path.join(tempDir('exclude-worktree'),'linked');git(['worktree','add','--detach',worktree]);
 await ensureInboxIgnored(worktree,core.run);
 assert.match(await fs.readFile(exclude(root),'utf8'),/\/\.local\/agent-glue\/inbox\//);
 assert.ok((await fs.stat(path.join(worktree,'.git'))).isFile());
 await core.run('git',['-C',worktree,'check-ignore','-q','--','.local/agent-glue/inbox/document.md']);
});
test('a higher priority unignore fails before any upload bytes are stored',async()=>{
 const root=gitProject('conflicting-exclude',{ignoreLocal:false});await fs.writeFile(path.join(root,'.gitignore'),'!/.local/agent-glue/inbox/\n');
 await assert.rejects(new core.Uploads().start({id:'x',name:'file.md',size:10},root,'t'),/overrides the local upload exclusion/);
 await assert.rejects(fs.stat(path.join(root,'.local')), {code:'ENOENT'});
});
test('exclude symlink is not followed and failed setup can be retried',async()=>{
 const root=gitProject('exclude-link',{ignoreLocal:false}),target=path.join(tempDir('exclude-target'),'file');await fs.writeFile(target,'KEEP');
 // Use a synthetic alternate Git metadata path so no fixture files need removal.
 const info=path.join(tempDir('exclude-synthetic'),'info');await fs.mkdir(info);const file=path.join(info,'exclude');await fs.symlink(target,file);
 const exec=async(cmd,args,opts)=>args.includes('rev-parse')?{stdout:file+'\n'}:core.run(cmd,args,opts);
 await assert.rejects(ensureInboxIgnored(root,exec));assert.equal(await fs.readFile(target,'utf8'),'KEEP');
 await ensureInboxIgnored(root,core.run);
});
