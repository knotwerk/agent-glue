'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tempDir}=require('../../../test/support/tmp.cjs');
const local=require('../src/local-reviews.cjs');
const {detail,html}=require('../src/pull-request.cjs');
test('compact coded labels preserve the full decision title and fall back for older packets',async()=>{
  const root=tempDir('review-labels');fs.mkdirSync(path.join(root,'.local/agent-glue'),{recursive:true});
  const drafts=[{id:'demo-ux-03',backlogId:'DEMO-UX-03',title:'Decision: DEMO-UX-03 — Preview drawer',label:'DEMO-UX-03 · Preview drawer',artifacts:[]},{id:'legacy',title:'Legacy title',artifacts:[]},{id:'empty',title:'Empty label fallback',label:' ',artifacts:[]},{id:'invalid',title:'Invalid label fallback',label:{html:'ignored'},artifacts:[]}];
  fs.writeFileSync(path.join(root,'.local/agent-glue/reviews.json'),JSON.stringify({version:1,drafts}));
  const exec=async command=>{if(command==='gh')return {stdout:'[]'};return {stdout:`worktree ${root}\n`};};
  const rows=await local.read(root,{exec});
  assert.deepEqual(rows.map(r=>r.label),['DEMO-UX-03 · Preview drawer','Legacy title','Empty label fallback','Invalid label fallback']);
  assert.equal((await detail(rows[0],root)).pr.title,drafts[0].title);
  const decisions=await require('../src/resources.cjs').list('prs',root,{filter:'decisions',project:async()=>root,exec});
  assert.deepEqual(decisions.items.map(r=>r.label),['DEMO-UX-03 · Preview drawer']);
});
test('local prepared drafts allow registered worktree artifacts but reject other roots',async()=>{
  const root=tempDir('local-review'),worktree=tempDir('linked-review'),other=tempDir('unregistered-review');
  fs.mkdirSync(path.join(root,'.local/agent-glue'),{recursive:true});
  fs.writeFileSync(path.join(root,'draft.md'),'# Draft\n[Gallery](gallery.html)');
  fs.writeFileSync(path.join(root,'gallery.html'),'<h1>Gallery</h1>');
  fs.writeFileSync(path.join(root,'feedback.md'),'# Pending');
  fs.writeFileSync(path.join(worktree,'shot.png'),'synthetic');fs.writeFileSync(path.join(other,'secret.md'),'not allowed');
  fs.writeFileSync(path.join(root,'.local/agent-glue/reviews.json'),JSON.stringify({version:1,drafts:[{id:'pilot',title:'Pilot',bodyFile:'draft.md',artifacts:[{path:'draft.md'},{path:'gallery.html'},{path:'feedback.md',kind:'decision'},{root:worktree,path:'shot.png'},{root:other,path:'secret.md'},{path:'../../etc/passwd'}]}]}));
  const rows=await local.read(root,{exec:async()=>({stdout:`worktree ${root}\n\nworktree ${worktree}\n`})});
  const sibling=await local.read(worktree,{exec:async()=>({stdout:`worktree ${root}\n\nworktree ${worktree}\n`})});
  assert.deepEqual(sibling,rows,'linked checkout sees the same primary review packet');
  fs.mkdirSync(path.join(worktree,'.local/agent-glue'),{recursive:true});
  fs.writeFileSync(path.join(worktree,'.local/agent-glue/reviews.json'),JSON.stringify({version:1,drafts:[]}));
  assert.deepEqual(await local.read(worktree,{exec:async()=>({stdout:`worktree ${root}\n\nworktree ${worktree}\n`})}),[],'explicit worktree index wins');
  assert.equal(rows.length,1);assert.equal(rows[0].local,true);
  assert.equal(rows[0].documents.length,4);assert.equal(rows[0].documents[3].image,true);
  const result=await detail(rows[0],root);
  assert.match(result.pr.body,/# Draft/);assert.equal(result.pr.local,true);
  const output=html(result.pr,result.documents);assert.match(output,/Prepared draft/);assert.match(output,/data-file="1">Gallery/);
  assert.match(output,/id="github" hidden/);
});

test('local packet body can live in its registered linked worktree',async()=>{
  const root=tempDir('body-primary'),worktree=tempDir('body-linked');
  fs.mkdirSync(path.join(root,'.local/agent-glue'),{recursive:true});
  fs.writeFileSync(path.join(worktree,'body.md'),'# Linked body');
  fs.writeFileSync(path.join(root,'.local/agent-glue/reviews.json'),JSON.stringify({version:1,drafts:[{id:'linked',title:'Linked',worktree,bodyFile:'body.md',artifacts:[{root:worktree,path:'body.md'}]}]}));
  const rows=await local.read(root,{exec:async()=>({stdout:`worktree ${root}\n\nworktree ${worktree}\n`})});
  assert.equal(rows[0].bodyFile,path.join(worktree,'body.md'));
  assert.match((await local.detail(rows[0])).pr.body,/# Linked body/);
});

test('local comments persist by review identity across title changes and worktree index fallback',async()=>{
 const feedback=require('../src/local-feedback.cjs');
 const root=tempDir('local-feedback'),worktree=tempDir('feedback-worktree');
 fs.mkdirSync(path.join(root,'.local/agent-glue'),{recursive:true});
 const index=path.join(root,'.local/agent-glue/reviews.json');
 fs.writeFileSync(index,JSON.stringify({version:1,drafts:[{id:'proposal',title:'Original',artifacts:[]}]}));
 const exec=async()=>({stdout:`worktree ${root}\n\nworktree ${worktree}\n`});
 const [item]=await local.read(worktree,{exec});assert.equal(item.reviewRoot,root);
 await Promise.all(['First\n\n**feedback**','Second'].map(body=>feedback.save(item,body,{exec})));
 fs.writeFileSync(index,JSON.stringify({version:1,drafts:[{id:'proposal',title:'Renamed',artifacts:[]}]}));
 const [reopened]=await local.read(worktree,{exec});
 const result=await local.detail(reopened,{exec});
 assert.equal(result.pr.comments.length,2);assert.equal(new Set(result.pr.comments.map(c=>c.id)).size,2);
 assert.equal(result.pr.comments[0].reviewId,'local:proposal');assert.match(reopened.description,/2 local comments/);
 assert.equal(fs.readFileSync(feedback.file(root),'utf8').trim().split('\n').length,2);
 assert.match(feedback.prompt(root),/Review all local PR feedback/);
});

test('local feedback rejects unsafe destinations and non-ignored storage',async()=>{
 const feedback=require('../src/local-feedback.cjs');
 const root=tempDir('feedback-safety'),outside=tempDir('feedback-outside');
 const item={local:true,id:'local:test',title:'Test',reviewRoot:root};
 await assert.rejects(feedback.save(item,'text',{exec:async()=>{throw Error('not ignored');}}),/Ignore/);
 await assert.rejects(feedback.save(item,' ',{exec:async()=>({})}),/Write a comment/);
 fs.symlinkSync(outside,path.join(root,'.local'));
 await assert.rejects(feedback.save(item,'text',{exec:async()=>({})}),/real project directories/);
 assert.deepEqual(fs.readdirSync(outside),[]);
});
