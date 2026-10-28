'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const core=require('./core.cjs');
const reviewFiles=require('./review-files.cjs');
const {reviewLabel}=require('./review-label.cjs');
const feedback=require('./local-feedback.cjs');
async function read(root,{exec=core.run}={}){
  try{root=await fs.realpath(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const {stdout}=await exec('git',['-C',root,'worktree','list','--porcelain'],{timeout:10000,maxBuffer:1024*1024});
  const allowed=new Set([await fs.realpath(root)]);
  const worktrees=[];
  for(const match of stdout.matchAll(/^worktree (.+)$/gm))try{const directory=await fs.realpath(match[1]);allowed.add(directory);worktrees.push(directory);}catch{}
  // A worktree-local index wins; otherwise use the primary checkout's index.
  try{await fs.lstat(path.join(root,'.local/agent-glue/reviews.json'));}
  catch(error){if(error.code!=='ENOENT')throw error;if(worktrees[0])root=worktrees[0];}
  const file=path.join(root,'.local/agent-glue/reviews.json');
  let manifest;
  try{await core.inside(root,file);if((await fs.stat(file)).size>1024*1024)throw new Error('Local review index is too large.');manifest=JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  if(manifest.version!==1||!Array.isArray(manifest.drafts))throw new Error('Invalid local review index.');
  const drafts=[];
  const comments=await feedback.read(root);
  for(const draft of manifest.drafts.slice(0,50)){
    if(typeof draft.id!=='string'||typeof draft.title!=='string'||!Array.isArray(draft.artifacts))continue;
    const documents=[];
    for(const entry of draft.artifacts.slice(0,100)){
      try{
        const declared=await fs.realpath(entry.root||root);if(!allowed.has(declared))continue;
        if(core.privatePath(path.relative(declared,path.resolve(declared,entry.path))))continue;
        const full=await core.inside(declared,path.resolve(declared,entry.path));
        if(core.privatePath(path.relative(declared,full)))continue;
        if(!(await fs.stat(full)).isFile())continue;
        documents.push({path:full,root:declared,relative:path.relative(declared,full),label:entry.label||path.basename(full),preview:core.supported(full),image:/\.(png|jpe?g|gif|webp)$/i.test(full),group:entry.group==='changes'?'changes':'review',href:entry.href,anchor:entry.anchor||String(entry.href||'').split('#').slice(1).join('#')});
      }catch{}
    }
    let worktree=root;
    if(draft.worktree){try{const candidate=await fs.realpath(draft.worktree);if(allowed.has(candidate))worktree=candidate;}catch{}}
    const body=documents.find(d=>d.path===path.resolve(root,draft.bodyFile||''))||documents.find(d=>d.path===path.resolve(worktree,draft.bodyFile||''));
    const reviewComments=comments.filter(comment=>comment.reviewId==='local:'+draft.id);
    const commentAt=reviewComments.map(comment=>comment.createdAt).sort().at(-1)||'';
    drafts.push({commentAt,reviewRoot:root,feedbackPath:feedback.file(root),id:'local:'+draft.id,label:reviewLabel(typeof draft.label==='string'&&draft.label.trim()?draft.label.trim():draft.title,draft.backlogId),title:draft.title,local:true,state:'OPEN',number:0,description:'Prepared draft · not published'+(reviewComments.length?' · '+reviewComments.length+' local comments':''),branch:draft.branch||'',head:reviewFiles.sha(draft.head)?draft.head:'',base:reviewFiles.sha(draft.base)?draft.base:'',baseRefName:draft.baseRefName||'main',worktree,publishedUrl:typeof draft.publishedUrl==='string'?draft.publishedUrl:'',backlogId:draft.backlogId||draft.id,bodyFile:body?.path,documents,updatedAt:draft.updatedAt||''});
  }
  return drafts;
}
async function detail(item,{exec=core.run}={}){
  let body='Prepared locally; no GitHub PR has been published.';
  if(item.bodyFile){const doc=item.documents.find(d=>d.path===item.bodyFile);const safe=await core.inside(doc.root,doc.path);if((await fs.stat(safe)).size<=1024*1024)body=await fs.readFile(safe,'utf8');}
  const files=await reviewFiles.changes(item.worktree,item.base,item.head,{exec});
  const documents=(files.length?[...item.documents.filter(d=>d.group!=='changes'),...files]:item.documents).map(({imageData,...doc})=>({...doc}));
  const bodyRoot=item.bodyFile?path.dirname(item.bodyFile):(item.worktree||item.documents[0]?.root);
  for(const d of documents){d.isBodyFile=d.path===item.bodyFile;if(d.group!=='changes')d.hrefs=[d.href,d.relative,d.path,path.relative(bodyRoot,d.path)].filter(Boolean);}
  return {pr:{number:0,title:item.title,body,local:true,headRefName:item.branch,baseRefName:item.baseRefName||'main',isDraft:true,comments:(await feedback.read(item.reviewRoot)).filter(comment=>comment.reviewId===item.id),reviews:[],files:files.map(d=>({path:d.relative}))},documents};
}
module.exports={read,detail};
