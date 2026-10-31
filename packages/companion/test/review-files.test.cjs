'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {gitProject}=require('../../../test/support/tmp.cjs');
const review=require('../src/review-files.cjs');
const {detail,html,discussionText,openReviewDocument}=require('../src/pull-request.cjs');
test('discussion references distinguish published PRs from local prepared drafts',()=>{
  assert.equal(discussionText({url:'https://github.com/a/b/pull/42'},{number:42,title:'Inspector: Keep selection'}),'Regarding PR #42 Inspector: Keep selection (https://github.com/a/b/pull/42): ');
  assert.equal(discussionText({local:true,bodyFile:'/repo/review.md'},{title:'Decision: Layout'}),'Regarding prepared draft Decision: Layout (/repo/review.md): ');
  assert.throws(()=>discussionText({local:true},{title:'Missing'}),/no reference/);
});
function fixture(){
  const root=gitProject('review-diff'),git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  git(['config','user.name','Test Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.writeFileSync(path.join(root,'changed.txt'),'before\n');fs.writeFileSync(path.join(root,'renamed.txt'),'same contents\n');
  git(['add','.']);git(['commit','-qm','before']);const base=git(['rev-parse','HEAD']);
  fs.writeFileSync(path.join(root,'changed.txt'),'after\n');fs.writeFileSync(path.join(root,'new.txt'),'new file\n');
  fs.renameSync(path.join(root,'renamed.txt'),path.join(root,'moved.txt'));
  git(['add','.']);git(['commit','-qm','after']);const head=git(['rev-parse','HEAD']);
  fs.writeFileSync(path.join(root,'changed.txt'),'unrelated dirty checkout\n');
  return {root,base,head};
}
test('changed files use the review revisions even when the checkout has unrelated edits',async()=>{
  const f=fixture(),docs=await review.changes(f.root,f.base,f.head);
  assert.deepEqual(docs.map(d=>[d.relative,d.status]),[['changed.txt','M'],['moved.txt','R'],['new.txt','A']]);
  const providers={},calls=[],vscode={workspace:{registerTextDocumentContentProvider:(scheme,p)=>{providers[scheme]=p;return {dispose(){}};}},Uri:{parse:value=>({toString:()=>value})},ViewColumn:{One:1},commands:{executeCommand:async(...args)=>calls.push(args)}};
  for(const doc of docs)await review.openDiff(vscode,{subscriptions:[]},doc);
  assert.equal(calls.length,3);
  const read=uri=>providers['agent-glue-review'].provideTextDocumentContent(uri);
  assert.equal(read(calls[0][1]),'before\n');assert.equal(read(calls[0][2]),'after\n');
  assert.equal(read(calls[1][1]),'same contents\n');assert.equal(read(calls[1][2]),'same contents\n');
  assert.equal(read(calls[2][1]),'');assert.equal(read(calls[2][2]),'new file\n');
  assert.equal(calls[0][4].viewColumn,1);
});
test('review links parse the dedicated section, images and slash-containing branch references',()=>{
  const result=review.links('## Context\n[Old](old.md)\n## Review material\n[Gallery](docs/view.html#details)\n![After](docs/after.png)\n## Discussion\n[Other](other.md)');
  assert.deepEqual(result.review.map(l=>l.href),['docs/view.html#details','docs/after.png']);
  assert.deepEqual(review.resolveLink('https://github.com/a/b/blob/feat/sheet-drawer/docs/view.html#details','https://github.com/a/b',['feat/sheet-drawer']),{relative:'docs/view.html',anchor:'details',ref:'feat/sheet-drawer',githubUrl:'https://github.com/a/b/blob/feat/sheet-drawer/docs/view.html#details'});
  for(const bad of ['../secret.md','docs/../../secret.md','/etc/passwd','command:thing','https://other.test/docs/a.md','docs/%2e%2e/%2e%2e/secret.md','.codex/memory.md','.git/config'])assert.equal(review.resolveLink(bad,'https://github.com/a/b'),null,bad);
});
test('hosted PR retains absent files with Github links and never substitutes a different checkout',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.root,'notes.md'),'wrong checkout version');
  const item={number:9,url:'https://github.com/a/b/pull/9'},pr={...item,title:'Decision: Example',body:'## Review material\n[Notes](notes.md)\n[Missing](missing.html#part)',headRefName:'feat/a',headRefOid:'a'.repeat(40),baseRefOid:f.base,files:[{path:'deleted.txt'}]};
  const result=await detail(item,f.root,{exec:async(cmd)=>{if(cmd==='gh')return {stdout:JSON.stringify(pr)};throw Error('objects unavailable');}});
  assert.equal(result.documents.length,3);assert.ok(result.documents.every(d=>d.missing));
  assert.equal(result.documents[1].anchor,'part');assert.match(result.documents[1].githubUrl,/missing.html#part$/);
  assert.equal(result.documents[2].group,'changes');
});
test('local PR renders validated embedded comparable screenshots without network images',async()=>{
  const f=fixture(),picture=path.join(f.root,'before.png');
  fs.writeFileSync(picture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64'));
  const body=path.join(f.root,'review.md');fs.writeFileSync(body,'## Original request\nKeep the selection.\n\n| Before | After |\n| --- | --- |\n| ![Before](before.png) | ![After](before.png) |');
  const item={local:true,title:'Inspector: Keep selection',bodyFile:body,worktree:f.root,documents:[{root:f.root,path:body,relative:'review.md',group:'review',preview:true},{root:f.root,path:picture,relative:'before.png',group:'review',image:true}]};
  const lightweight=await detail(item,f.root);assert.ok(!lightweight.documents[1].imageData);
  const result=await detail(item,f.root,{includeImages:true}),output=html(result.pr,result.documents);
  assert.ok(!item.documents[1].imageData,'sidebar item must not acquire image data');
  assert.ok(!lightweight.documents[1].imageData,'earlier lightweight result stays image-free');
  assert.match(output,/Original request/);assert.equal((output.match(/<img src="data:image\/png;base64/g)||[]).length,2);
  assert.match(output,/img-src data:/);assert.ok(!output.includes('<img src="https:'));
});

test('image changes use binary revision contents for a side-by-side comparison',async()=>{
  const f=fixture(),panels=[],context={subscriptions:[]};
  const vscode={ViewColumn:{One:1},window:{createWebviewPanel:(type,title,column,options)=>{const p={type,title,column,options,webview:{}};panels.push(p);return p;}}};
  const first=Buffer.from('first binary snapshot'),second=Buffer.from('second binary snapshot');
  await review.openDiff(vscode,context,{root:f.root,relative:'shot.png',base:f.base,head:f.head,beforePath:'shot.png',afterPath:'shot.png'},{exec:async(cmd,args,options)=>{assert.equal(options.encoding,null);return {stdout:args.at(-1).startsWith(f.base)?first:second};}});
  assert.equal(panels[0].column,1);assert.equal(panels[0].options.enableScripts,false);
  assert.ok(panels[0].webview.html.includes(first.toString('base64')));assert.ok(panels[0].webview.html.includes(second.toString('base64')));
});

test('hosted review links preserve explicit revisions and reject dirty artifact checkouts',async()=>{
  const f=fixture(),core=require('../src/core.cjs');
  const item={number:8,url:'https://github.com/a/b/pull/8'},before=`https://github.com/a/b/blob/${f.base}/changed.txt`;
  const pr={...item,title:'Review',headRefName:'feat/review',baseRefName:'main',headRefOid:f.head,baseRefOid:f.base,body:`## Review material\n[Current description](changed.txt)\n[Original description](${before})`,files:[]};
  const exec=async(command,args,options)=>command==='gh'?{stdout:JSON.stringify(pr)}:core.run(command,args,options);
  let result=await detail(item,f.root,{exec});
  assert.equal(result.documents[0].missing,true,'dirty current checkout cannot supply PR evidence');
  assert.equal(result.documents[1].revision,f.base);assert.equal(result.documents[1].githubUrl,before);
  fs.writeFileSync(path.join(f.root,'changed.txt'),'after\n');
  result=await detail(item,f.root,{exec});
  assert.equal(result.documents[0].missing,false);assert.equal(result.documents[0].label,'Current description');
  assert.equal(result.documents[1].missing,true,'base revision has no matching checkout');
});
test('hosted review links cannot resolve symlinks into excluded memory directories',async()=>{
  const f=fixture();fs.mkdirSync(path.join(f.root,'.codex'));fs.writeFileSync(path.join(f.root,'.codex/private.md'),'synthetic denied fixture');fs.symlinkSync('.codex/private.md',path.join(f.root,'notes.md'));
  const item={number:5,url:'https://github.com/a/b/pull/5'};
  const result=await detail(item,f.root,{exec:async()=>({stdout:JSON.stringify({...item,title:'Review',body:'[Notes](notes.md)',files:[]})})});
  assert.equal(result.documents[0].missing,true);
});

test('ordinary source memory directories are reviewable without exposing agent metadata',()=>{
  assert.equal(review.safeRelative('src/memory/cache.ts'),true);
  for(const name of ['memory/private.md','.claude/memory/notes.md','src/.codex/history.json','.git/config','.local/inbox/file'])assert.equal(review.safeRelative(name),false,name);
});

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=','base64');
function imageFixture(){
  const root=gitProject('review-inline-image'),git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  git(['config','user.name','Test Fixture']);git(['config','user.email','fixture@example.invalid']);
  fs.mkdirSync(path.join(root,'docs'));
  fs.writeFileSync(path.join(root,'docs/shot.png'),png);fs.writeFileSync(path.join(root,'docs/review.html'),'<h1>Committed review</h1>');
  git(['add','.']);git(['commit','-qm','first screenshot']);const base=git(['rev-parse','HEAD']);
  const current=Buffer.concat([png,Buffer.from('committed second version')]);
  fs.writeFileSync(path.join(root,'docs/shot.png'),current);
  fs.symlinkSync('shot.png',path.join(root,'docs/alias.png'));
  fs.writeFileSync(path.join(root,'docs/not-image.png'),'<script>not an image</script>');
  git(['add','.']);git(['commit','-qm','second screenshot']);const head=git(['rev-parse','HEAD']);
  const item={number:21,url:'https://github.com/a/b/pull/21'};
  const pr={...item,title:'Review screenshots',headRefName:'feature/review',baseRefName:'main',headRefOid:head,baseRefOid:base,files:[]};
  const exec=async(command,args,options)=>command==='gh'?{stdout:JSON.stringify(pr)}:require('../src/core.cjs').run(command,args,options);
  return {root,git,base,head,current,item,pr,exec};
}
test('hosted inline screenshots use exact committed bytes in dirty and ancestor checkouts without relaxing document previews',async()=>{
  const f=imageFixture(),ancestor=`https://github.com/a/b/blob/${f.base}/docs/shot.png`;
  f.pr.body=`![Current](docs/shot.png)\n![Before](${ancestor})\n[Review](docs/review.html)`;
  fs.writeFileSync(path.join(f.root,'docs/shot.png'),Buffer.concat([png,Buffer.from('uncommitted replacement')]));
  fs.writeFileSync(path.join(f.root,'docs/review.html'),'<h1>Uncommitted review</h1>');
  const lightweight=await detail(f.item,f.root,{exec:f.exec});
  assert.ok(lightweight.documents.every(doc=>!doc.imageData),'sidebar discovery must remain image-free');
  const result=await detail(f.item,f.root,{exec:f.exec,includeImages:true});
  const current=result.documents.find(doc=>doc.image&&doc.revision===f.head),before=result.documents.find(doc=>doc.image&&doc.revision===f.base);
  assert.equal(current.imageData,'data:image/png;base64,'+f.current.toString('base64'));
  assert.equal(before.imageData,'data:image/png;base64,'+png.toString('base64'));
  assert.equal(current.missing,true,'inline blob does not authorize the dirty working file');
  assert.equal(before.missing,true,'no worktree at the ancestor is needed for inline evidence');
  assert.equal(result.documents.find(doc=>doc.relative==='docs/review.html').missing,true,'HTML still requires a clean exact checkout');
  const output=html(result.pr,result.documents);
  assert.equal((output.match(/<img src="data:image\/png;base64/g)||[]).length,2);
  assert.match(output,/img-src data:/);assert.ok(!output.includes('<img src="https:'));
  const opened=[];
  await openReviewDocument({env:{openExternal:async uri=>opened.push(uri)},Uri:{parse:value=>value}},{},current,f.root,new Map());
  assert.deepEqual(opened,[current.githubUrl],'clicking unavailable working files retains the GitHub fallback');
});
test('hosted inline images reject unrelated commits, symlink entries, invalid signatures and unsafe or untracked files',async()=>{
  const f=imageFixture(),unrelated=f.git(['commit-tree',f.git(['rev-parse','HEAD^{tree}']),'-m','Unrelated history']);
  fs.writeFileSync(path.join(f.root,'docs/untracked.png'),png);
  f.pr.body=`![Unrelated](https://github.com/a/b/blob/${unrelated}/docs/shot.png)\n![Alias](docs/alias.png)\n![Invalid](docs/not-image.png)\n![Untracked](docs/untracked.png)\n![Private](.codex/private.png)\n![Traversal](docs/%2e%2e/secret.png)\n![Remote](https://other.test/shot.png)\n![Unknown branch](https://github.com/a/b/blob/other/docs/shot.png)`;
  const result=await detail(f.item,f.root,{exec:f.exec,includeImages:true});
  assert.ok(result.documents.every(doc=>!doc.imageData));
  assert.ok(result.documents.some(doc=>doc.revision===unrelated),'unavailable evidence retains its explicit reference');
  assert.ok(!result.documents.some(doc=>doc.relative.includes('.codex')||doc.relative.includes('..')));
});
test('hosted images without a known commit or with unavailable objects never substitute local bytes',async()=>{
  const f=imageFixture();f.pr.body='![Shot](docs/shot.png)';
  for(const head of [undefined,'a'.repeat(40)]){
    f.pr.headRefOid=head;
    const result=await detail(f.item,f.root,{exec:f.exec,includeImages:true});
    assert.ok(result.documents.every(doc=>!doc.imageData));
  }
});
test('committed inline raster reads enforce per-image and total budgets before loading blobs',async()=>{
  const head='a'.repeat(40),item={number:22,url:'https://github.com/a/b/pull/22'},limit=5*1024*1024;
  const paths=['oversized.png','one.png','two.png','three.png','four.png','five.png'];
  const pr={...item,title:'Bounded images',headRefOid:head,headRefName:'feature',body:paths.map(file=>`![${file}](${file})`).join('\n'),files:[]};
  const ids=new Map(paths.map((file,index)=>[file,(index+1).toString(16).repeat(40)])),reads=[];
  const data=Buffer.alloc(limit);png.copy(data);
  const result=await detail(item,'/synthetic-repository',{includeImages:true,exec:async(command,args,options)=>{
    if(command==='gh')return {stdout:JSON.stringify(pr)};
    if(args.includes('worktree'))throw Error('no exact checkout');
    assert.ok(args.includes('--no-replace-objects'));assert.ok(args.includes('--literal-pathspecs'));
    if(args.includes('ls-tree'))return {stdout:`100644 blob ${ids.get(args.at(-1))}\t${args.at(-1)}\0`};
    const operation=args[args.indexOf('cat-file')+1];
    if(operation==='-t')return {stdout:'commit\n'};
    if(operation==='-s')return {stdout:String(args.at(-1)===ids.get('oversized.png')?limit+1:limit)+'\n'};
    assert.equal(operation,'blob');assert.equal(options.encoding,null);assert.equal(options.maxBuffer,limit);
    reads.push(args.at(-1));return {stdout:data};
  }});
  assert.deepEqual(reads,['one.png','two.png','three.png','four.png'].map(file=>ids.get(file)));
  assert.equal(result.documents.filter(doc=>doc.imageData).length,4);
});
