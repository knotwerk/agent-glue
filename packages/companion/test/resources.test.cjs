'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {list,filters}=require('../src/resources.cjs');
const {detail,html}=require('../src/pull-request.cjs');
test('PR filters query only the selected repository with bounded read-only calls',async()=>{
  for(const filter of Object.keys(filters).filter(f=>f!=='priority'&&f!=='decisions')){
    let call;
    const result=await list('prs','/selected',{filter,project:async cwd=>cwd,exec:async(...args)=>{call=args;return {stdout:JSON.stringify([{number:3,title:'Review <script>',url:'https://github.com/a/b/pull/3',isDraft:true,comments:[{createdAt:'2026-10-14T12:00:00Z'}]},{number:4,title:'Bad',url:'javascript:alert(1)'}])};}});
    assert.equal(call[0],'gh');assert.equal(call[2].cwd,'/selected');assert.equal(call[2].timeout,20000);
    assert.equal(call[1][call[1].indexOf('--state')+1],['all','comments'].includes(filter)?'all':['merged','closed'].includes(filter)?filter:'open');
    assert.equal(call[1].at(-1),filters[filter]);assert.equal(result.items.length,1);
    assert.equal(result.items[0].commentAt,'2026-10-14T12:00:00Z');
  }
  await assert.rejects(list('prs','/selected',{project:async cwd=>cwd,exec:async()=>{throw Object.assign(new Error('absent'),{code:'ENOENT'});}}),/Install GitHub CLI/);
});
test('Decisions filter lists prefixed PRs, and the retired tab performs no discovery',async()=>{
  const result=await list('prs','/selected',{filter:'decisions',project:async cwd=>cwd,exec:async()=>({stdout:JSON.stringify([{number:1,title:'Decision: Navigation — choose grouping',url:'https://github.com/a/b/pull/1'},{number:2,title:'Notes on Decision process',url:'https://github.com/a/b/pull/2'}])})});
  assert.deepEqual(result.items.map(i=>i.number),[1]);
  assert.deepEqual((await list('decisions','/selected',{project:async cwd=>cwd,exec:async()=>{throw Error('unexpected discovery');}})).items,[]);
});
test('PR detail resolves mentioned and changed local files, rejects traversal and mismatched PRs',async()=>{
  const root=tempDir('pr-detail');fs.mkdirSync(path.join(root,'docs'));fs.writeFileSync(path.join(root,'docs/review.md'),'# Review');
  fs.writeFileSync(path.join(root,'docs/view.html'),'<h1>View</h1>');
  const item={number:3,url:'https://github.com/a/b/pull/3'};
  const pr={...item,title:'Review',body:'See [review](docs/review.md) and [view](https://github.com/a/b/blob/main/docs/view.html). Also ../../outside.md',files:[{path:'docs/review.md'}],comments:[{body:'<script>alert(1)</script>'}]};
  const result=await detail(item,root,{exec:async()=>({stdout:JSON.stringify(pr)})});
  assert.deepEqual(result.documents.filter(d=>d.group==='review').map(d=>d.relative).sort(),['docs/review.md','docs/view.html']);
  await assert.rejects(detail(item,root,{exec:async()=>({stdout:JSON.stringify({...pr,number:4})})}),/different pull request/);
  const output=html({...pr,title:'<img src=x onerror=alert(1)>'},result.documents);
  assert.ok(!output.includes('<img'));assert.ok(!output.includes('<script>alert(1)'));
  assert.match(output,/data-file="0"/);assert.match(output,/Open in GitHub/);assert.match(output,/<h2>Review material<\/h2>/);
  const standard=html({...pr,body:'## Review material\n[Notes](docs/review.md)'},result.documents);
  assert.equal((standard.match(/<h2>Review material<\/h2>/g)||[]).length,1);
  assert.equal((standard.match(/data-file="0"/g)||[]).length,1);
  assert.match(output,/script-src 'nonce-/);
});

test('Priority includes older review requests and own waiting PRs, deduplicated',async()=>{
  const pr=(number,state='OPEN')=>({number,state,title:'PR '+number,url:`https://github.com/a/b/pull/${number}`,updatedAt:'2026-10-14T12:00:00Z'});
  const queries=[];
  const result=await list('prs','/selected',{project:async cwd=>cwd,exec:async(cmd,args,opts)=>{
    assert.equal(opts.cwd,'/selected');queries.push(args);
    const search=args.at(-1);
    return {stdout:JSON.stringify(search.includes('review-requested:')?[pr(2)]:search.includes('author:')?[pr(1),pr(3)]:[pr(1),pr(4,'MERGED')])};
  }});
  assert.equal(queries.length,3);
  assert.equal(result.items.length,4);
  assert.equal(result.items.find(p=>p.number===2).reviewRequested,true);
  assert.equal(result.items.find(p=>p.number===3).mineAwaitingReview,true);
});

test('Priority ranks unread feedback, requests, own waiting PRs, activity, then closed PRs',()=>{
  const {prioritize}=require('../src/resources.cjs');
  const items=[
    {number:1,state:'MERGED',newComments:true,updatedAt:'2026-12-01'},
    {number:2,state:'OPEN',updatedAt:'2026-11-01'},
    {number:3,state:'OPEN',mineAwaitingReview:true,updatedAt:'2026-01-01'},
    {number:4,state:'OPEN',reviewRequested:true,updatedAt:'2026-01-01'},
    {number:5,state:'OPEN',newComments:true,commentAt:'2026-10-01'},
    {number:6,state:'OPEN',newComments:true,commentAt:'2026-10-02'}
  ];
  assert.deepEqual(prioritize(items).map(p=>p.number),[6,5,4,3,2,1]);
  items[5].newComments=false;
  assert.deepEqual(prioritize(items).map(p=>p.number),[5,4,3,2,6,1]);
  assert.equal(items[0].number,1,'does not mutate input order');
});

test('published local packets reconcile by branch while fork branches remain separate',async()=>{
  const root=tempDir('published-packet');fs.mkdirSync(path.join(root,'.local/agent-glue'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local/agent-glue/reviews.json'),JSON.stringify({version:1,drafts:[{id:'published',title:'Published',branch:'feat/local',artifacts:[]},{id:'other',title:'Other',branch:'feat/fork',artifacts:[]}]}));
  const rows=[{number:1,title:'Published',url:'https://github.com/a/b/pull/1',headRefName:'feat/local',isCrossRepository:false},{number:2,title:'Fork work',url:'https://github.com/a/b/pull/2',headRefName:'feat/fork',isCrossRepository:true}];
  const result=await list('prs',root,{filter:'all',project:async cwd=>cwd,exec:async command=>({stdout:command==='git'?`worktree ${root}\n`:JSON.stringify(rows)})});
  assert.deepEqual(result.items.map(i=>i.id),['local:other','https://github.com/a/b/pull/1','https://github.com/a/b/pull/2']);
});

test('closed PR branch reuse does not hide a new prepared packet',async()=>{
  const root=tempDir('reused-branch');fs.mkdirSync(path.join(root,'.local/agent-glue'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local/agent-glue/reviews.json'),JSON.stringify({version:1,drafts:[{id:'new',title:'New work',branch:'feature',artifacts:[]}]}));
  const result=await list('prs',root,{filter:'all',project:async()=>root,exec:async command=>({stdout:command==='git'?`worktree ${root}\n`:JSON.stringify([{number:1,title:'Old work',url:'https://github.com/a/b/pull/1',headRefName:'feature',state:'CLOSED'}])})});
  assert.ok(result.items.some(i=>i.id==='local:new'));
});

test('unregistered PR body links cannot borrow a matching basename',()=>{
  const output=html({title:'Review',body:'## Review material\n[Wrong](other/plan.md)\n[Right](docs/plan.md)'},[{path:'/project/docs/plan.md',relative:'docs/plan.md',hrefs:['docs/plan.md'],label:'Plan',preview:true,group:'review'}]);
  assert.match(output,/<span class="reference">Wrong<\/span>/);
  assert.match(output,/data-file="0">Right/);
});

test('PR sorting offers stable natural code order and explicit numeric/activity order',()=>{
 const {sortItems}=require('../src/resources.cjs');
 const items=[{id:'b',label:'CODE-10',number:10,updatedAt:'2020'},{id:'a',label:'CODE-2',number:2,updatedAt:'2025'}];
 assert.deepEqual(sortItems(items).map(i=>i.id),['a','b']);
 assert.deepEqual(sortItems(items,'number').map(i=>i.id),['b','a']);
 assert.deepEqual(sortItems(items,'updated').map(i=>i.id),['a','b']);
 assert.deepEqual(items.map(i=>i.id),['b','a']);
});
