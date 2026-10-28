'use strict';
const {mainEditorColumn}=require('./editor-target.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const MarkdownIt=require('markdown-it');
const core=require('./core.cjs');
const {escape,openPreview}=require('./preview.cjs');
const reviewFiles=require('./review-files.cjs');
const {postComment}=require('./pr-comments.cjs');
const localFeedback=require('./local-feedback.cjs');
async function detail(item,root,{exec=core.run,includeImages=false}={}){
  if(item.local){const result=await require('./local-reviews.cjs').detail(item,{exec});if(includeImages)await addImages(result.documents);return result;}
  const {stdout}=await exec('gh',['pr','view',String(item.number),'--json','number,title,body,url,author,isDraft,state,comments,reviews,files,headRefName,baseRefName,headRefOid,baseRefOid'],{cwd:root,timeout:20000,maxBuffer:8*1024*1024});
  const pr=JSON.parse(stdout);
  if(pr.number!==item.number||pr.url!==item.url)throw new Error('GitHub returned a different pull request. Refresh the PR list.');
  const repoURL=item.url.replace(/\/pull\/\d+$/,'');
  const checkouts=new Map(),tracked=new Map();
  if(reviewFiles.sha(pr.headRefOid))try{
    const {stdout:trees}=await exec('git',['-C',root,'worktree','list','--porcelain'],{timeout:10000,maxBuffer:1024*1024});
    for(const block of trees.split('\n\n')){
      const lines=block.split('\n'),revision=lines.find(l=>l.startsWith('HEAD '))?.slice(5),location=lines.find(l=>l.startsWith('worktree '))?.slice(9);
      if(location&&reviewFiles.sha(revision))checkouts.set(revision,await fs.realpath(location));
    }
  }catch{}
  const cleanRoots=new Map();
  async function matching(revision){
    if(!reviewFiles.sha(pr.headRefOid))return root; // Legacy metadata has no revision claim.
    if(!cleanRoots.has(revision)){
      const candidate=checkouts.get(revision);
      cleanRoots.set(revision,candidate&&await reviewFiles.cleanCheckout(candidate,revision,{exec})?candidate:null);
      if(cleanRoots.get(revision)){
        const {stdout}=await exec('git',['-C',candidate,'ls-tree','-r','--name-only','-z',revision],{timeout:10000,maxBuffer:4*1024*1024});
        tracked.set(revision,new Set(stdout.split('\0')));
      }
    }
    return cleanRoots.get(revision);
  }
  const documents=[],byPath=new Map();
  const parsed=reviewFiles.links(pr.body);
  for(const link of [...parsed.review,...parsed.all.filter(l=>l.image)]){
    const resolved=reviewFiles.resolveLink(link.href,repoURL,[pr.headRefName,pr.baseRefName,pr.headRefOid,pr.baseRefOid]);
    if(!resolved)continue;
    const {relative,anchor,ref}=resolved;
    const revision=ref?(reviewFiles.sha(ref)?ref:ref===pr.headRefName?pr.headRefOid:ref===pr.baseRefName?pr.baseRefOid:''):pr.headRefOid;
    const checkout=await matching(revision),key=(ref||revision||'')+':'+relative+'#'+anchor;
    if(byPath.has(key)){byPath.get(key).hrefs.push(link.href);continue;}
    const doc={root:checkout||root,path:path.resolve(checkout||root,relative),relative,label:link.label||relative,group:'review',revision,anchor,hrefs:[link.href],preview:core.supported(relative),image:/\.(png|jpe?g|gif|webp)$/i.test(relative),missing:true,githubUrl:resolved.githubUrl||repoURL+'/blob/'+encodeURIComponent(revision||pr.headRefName||'main')+'/'+relative.split('/').map(encodeURIComponent).join('/')+(anchor?'#'+encodeURIComponent(anchor):'')};
    if(checkout&&(!revision||tracked.get(revision)?.has(relative)))try{doc.path=await core.inside(checkout,doc.path);doc.missing=!reviewFiles.safeRelative(path.relative(checkout,doc.path))||!(await fs.stat(doc.path)).isFile();}catch{}
    documents.push(doc);byPath.set(key,doc);
    if(documents.length>=200)break;
  }
  let changed=[];
  if(reviewFiles.sha(pr.baseRefOid)&&reviewFiles.sha(pr.headRefOid))try{changed=await reviewFiles.changes(root,pr.baseRefOid,pr.headRefOid,{exec});}catch{}
  if(!changed.length)changed=(pr.files||[]).filter(f=>reviewFiles.safeRelative(f.path)).map(f=>({root,path:path.resolve(root,f.path),relative:f.path,label:f.path,group:'changes',missing:true,githubUrl:item.url+'/files'}));
  documents.push(...changed);
  if(includeImages)await addImages(documents);
  return {pr,documents};
}
async function addImages(documents){
  let bytes=0;
  for(const doc of documents){
    if(!doc.image||doc.missing||doc.group==='changes')continue;
    try{
      const file=await core.inside(doc.root,doc.path),stat=await fs.stat(file);
      if(stat.size>5*1024*1024||bytes+stat.size>20*1024*1024)continue;
      const data=await fs.readFile(file),ext=path.extname(file).toLowerCase();
      const valid=ext==='.png'?data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):['.jpg','.jpeg'].includes(ext)?data.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):ext==='.gif'?/^GIF8[79]a$/.test(data.subarray(0,6).toString()):data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP';
      if(!valid)continue;bytes+=data.length;
      doc.imageData='data:image/'+(ext==='.jpg'||ext==='.jpeg'?'jpeg':ext.slice(1))+';base64,'+data.toString('base64');
    }catch{}
  }
}
async function openReviewDocument(vscode,context,doc,root,panels){
  if(doc.missing){if(doc.githubUrl)await vscode.env.openExternal(vscode.Uri.parse(doc.githubUrl));else throw new Error('This review file is unavailable. Refresh the PR.');return;}
  if(doc.group==='changes'&&doc.base&&doc.head){await reviewFiles.openDiff(vscode,context,doc);return;}
  let allowedFiles;
  if(doc.revision){
    if(!await reviewFiles.cleanCheckout(doc.root,doc.revision)){
      if(doc.githubUrl){await vscode.env.openExternal(vscode.Uri.parse(doc.githubUrl));return;}
      throw new Error('Review checkout changed; refresh this PR.');
    }
    const {stdout}=await core.run('git',['-C',doc.root,'ls-tree','-r','--name-only','-z',doc.revision],{timeout:10000,maxBuffer:4*1024*1024});
    allowedFiles=new Set(stdout.split('\0'));allowedFiles.revision=doc.revision;
  }
  const file=await core.inside(doc.root||root,doc.path);
  if(doc.image)await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(file),await mainEditorColumn(vscode));
  else if(doc.preview)await openPreview(vscode,context,file,doc.root||root,panels,doc.anchor||'',undefined,allowedFiles);
  else await vscode.window.showTextDocument(vscode.Uri.file(file),{viewColumn:await mainEditorColumn(vscode)});
}

function discussionText(item,pr){
  const reference=item.local?item.bodyFile:item.url;
  if(!reference)throw new Error('This review has no reference to share.');
  return `Regarding ${item.local?'prepared draft':'PR #'+pr.number} ${pr.title} (${reference}): `;
}
function html(pr,documents){
  const nonce=crypto.randomBytes(18).toString('hex');
  const renderer=new MarkdownIt({html:false,linkify:false});
  const linkStack=[];
  const normalize=href=>{try{return decodeURIComponent(href.split('#')[0].split('?')[0]);}catch{return href;}};
  const find=href=>{
    const plain=normalize(href);
    let found=documents.findIndex(d=>[...(d.hrefs||[]),d.href].filter(Boolean).some(v=>normalize(v)===plain));
    if(found<0){const matches=documents.map((d,i)=>({d,i})).filter(({d})=>[d.path,d.relative].filter(Boolean).some(v=>normalize(v)===plain));if(matches.length===1)found=matches[0].i;}
    return found;
  };
  renderer.renderer.rules.link_open=(tokens,index)=>{
    const href=tokens[index].attrGet('href')||'',found=find(href);linkStack.push(found>=0);
    const fragment=href.includes('#')?href.slice(href.indexOf('#')+1):'';
    return found>=0?'<button data-file="'+found+'"'+(fragment?' data-anchor="'+escape(fragment)+'"':'')+'>':'<span class="reference">';
  };
  renderer.renderer.rules.link_close=()=>linkStack.pop()?'</button>':'</span>';
  renderer.renderer.rules.image=(tokens,index)=>{
    const found=find(tokens[index].attrGet('src')||''),doc=documents[found];
    return doc?.imageData?'<button class="screenshot" data-file="'+found+'"><img src="'+doc.imageData+'" alt="'+escape(tokens[index].content||doc.label)+'"></button>':escape(tokens[index].content||'Screenshot unavailable');
  };
  const md=body=>renderer.render(String(body||''));
  const body=String(pr.body||'').replace(/^# (.+)\r?\n/, (line,title)=>title.trim()===pr.title.trim()?'':line);
  const bodyTokens=renderer.parse(body,{});
  const hasReviewSection=bodyTokens.some((token,index)=>token.type==='heading_open'&&token.tag==='h2'&&bodyTokens[index+1]?.content.trim().toLowerCase()==='review material');
  const comments=[...(pr.comments||[]),...(pr.reviews||[]).filter(c=>c.body)].sort((a,b)=>(a.createdAt||a.submittedAt||'').localeCompare(b.createdAt||b.submittedAt||''));
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none';"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:960px;margin:20px auto;padding:0 20px;line-height:1.5}button{cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:5px 9px;margin:3px}button:disabled{opacity:.5;cursor:default}pre{overflow:auto;padding:12px;background:var(--vscode-textCodeBlock-background)}article{border-top:1px solid var(--vscode-panel-border);padding:12px 0}small{color:var(--vscode-descriptionForeground)}h1{font-size:22px}table{border-collapse:collapse}td,th{padding:5px;border:1px solid var(--vscode-panel-border)}.reference{text-decoration:underline}li{overflow-wrap:anywhere}img{max-width:100%;height:auto}.screenshot{background:transparent;padding:0;margin:0}</style></head><body>
<button id="discuss" title="Paste this review reference into the selected agent terminal without sending">Discuss with agent</button><button id="leave-comment" title="Write feedback on this review">Leave comment</button>${pr.local?'<button id="review-feedback">Review all local feedback</button>':''}<button id="github" ${pr.local?'hidden':''}>Open in GitHub</button><h1>${pr.local?'Prepared draft · ':'#'+escape(pr.number)+' '}${escape(pr.title)}</h1>
<small>${escape(pr.author?.login||'')} · ${pr.isDraft?'Draft':escape(pr.state||'Open')} · ${escape(pr.headRefName||'')} → ${escape(pr.baseRefName||'')}</small>
<section>${md(body)}</section>
${hasReviewSection?'':`<h2>Review material</h2><ul>${documents.map((d,i)=>d.group==='changes'?'':`<li><button data-file="${i}">${escape(d.label)}</button> <small>${d.missing?'Open in GitHub':d.image?'Screenshot':d.preview?'Preview':'Open source'}</small></li>`).join('')||'<li>No matching local files.</li>'}</ul>`}
<h2>Changes</h2><ul>${documents.map((d,i)=>d.group==='changes'?`<li><button data-file="${i}">${escape(d.relative||d.label)}</button></li>`:'').join('')||'<li>No committed changes listed.</li>'}</ul>
<section aria-label="Review feedback"><h2>Add a comment</h2><label for="comment-body">${pr.local?'Local review feedback':'Markdown feedback for PR #'+escape(pr.number)}</label><textarea id="comment-body" rows="5" maxlength="60000" style="display:block;box-sizing:border-box;width:100%;margin:8px 0;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)"></textarea><button id="post-comment" disabled>${pr.local?'Save local comment':'Post comment'}</button><span id="comment-status" role="status" aria-live="polite"></span><p><small>${pr.local?'Saved in this project for your AI to read. Nothing is posted to GitHub.':'Posts to GitHub using your signed-in GitHub CLI account.'}</small></p></section>
<div id="posted-comments"></div><h2>Comments and reviews</h2><small>${pr.local?'Feedback saved with this prepared review.':'Conversation comments and review summaries. Inline review threads are available on GitHub.'}</small>
${comments.map(c=>`<article><strong>${escape(c.author?.login||'Unknown')}</strong> <small>${escape(c.createdAt||c.submittedAt||'')} ${escape(c.state||'')}</small>${md(c.body)}</article>`).join('')||'<p>No comments.</p>'}
<script nonce="${nonce}">const api=acquireVsCodeApi();
const input=document.getElementById('comment-body'),submit=document.getElementById('post-comment'),status=document.getElementById('comment-status');
let posting=false,submitted='';
if(input){
 document.getElementById('leave-comment').onclick=()=>{input.scrollIntoView({block:'center'});input.focus();};
 input.value=api.getState()?.commentDraft||'';
 const update=()=>{submit.disabled=posting||!input.value.trim();api.setState({commentDraft:input.value});};
 input.oninput=update;update();
 submit.onclick=()=>{if(posting||!input.value.trim())return;posting=true;submitted=input.value;input.disabled=true;status.textContent=${pr.local?"'Saving…'":"'Posting…'"};update();api.postMessage({type:'postComment',body:submitted});};
 window.addEventListener('message',event=>{const m=event.data;if(m?.type!=='commentResult')return;posting=false;input.disabled=false;
 if(m.ok){const article=document.createElement('article');article.style.whiteSpace='pre-wrap';article.textContent='You · '+(m.local?'saved locally':'just posted')+'\\n\\n'+submitted;document.getElementById('posted-comments').prepend(article);input.value='';status.textContent=m.local?'Comment saved locally.':'Comment posted.';}else status.textContent=m.error||'Posting failed. Draft preserved.';
 update();});
}
document.getElementById('review-feedback')?.addEventListener('click',()=>api.postMessage({type:'reviewFeedback'}));
document.getElementById('discuss').onclick=()=>api.postMessage({type:'discuss'});document.getElementById('github').onclick=()=>api.postMessage({type:'github'});document.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>api.postMessage({type:'file',index:Number(b.dataset.file),anchor:b.dataset.anchor}));</script></body></html>`;
}
async function openPullRequest(vscode,context,item,root,panels,{onDiscuss,commentExec}={}){
  const key='pr:'+root+':'+item.id;
  const {pr,documents}=await detail(item,root,{includeImages:true});
  let panel=panels.get(key);
  if(panel){panel.dispose();panels.delete(key);}
  panel=vscode.window.createWebviewPanel('agentGlue.pullRequest',pr.local?`Draft: ${pr.title}`:`PR #${pr.number}: ${pr.title}`,await mainEditorColumn(vscode),{enableScripts:true,localResourceRoots:[],retainContextWhenHidden:true});
  panels.set(key,panel);panel.onDidDispose(()=>{if(panels.get(key)===panel)panels.delete(key);});
  panel.webview.html=html(pr,documents);
  let posting=false;
  panel.webview.onDidReceiveMessage(async message=>{
    if(message?.type==='postComment'){
      if(posting)return;
      posting=true;
      let result;
      try{if(item.local)await localFeedback.save(item,message.body);else await postComment(item,root,message.body,{exec:commentExec});result={type:'commentResult',ok:true,local:Boolean(item.local)};}
      catch(error){result={type:'commentResult',ok:false,error:error.message};}
      finally{posting=false;}
      try{await panel.webview.postMessage(result);}catch{}
      return;
    }
    try{
      if(message?.type==='reviewFeedback'&&item.local){
        if(!onDiscuss||!item.reviewRoot)throw new Error('Reopen this prepared review from Agent Glue with an agent terminal selected.');
        await onDiscuss(localFeedback.prompt(item.reviewRoot));
      }
      if(message?.type==='discuss'){
        if(!onDiscuss)throw new Error('No agent terminal is connected to this review. Reopen it from Agent Glue.');
        await onDiscuss(discussionText(item,pr));
      }
      if(message?.type==='github'&&item.url)await vscode.env.openExternal(vscode.Uri.parse(item.url));
      if(message?.type==='file'&&Number.isInteger(message.index)){
        const doc=documents[message.index];if(!doc)return;
        if(doc.isBodyFile){panel.reveal(await mainEditorColumn(vscode));return;}
        await openReviewDocument(vscode,context,typeof message.anchor==='string'&&message.anchor.length<2000?{...doc,anchor:message.anchor}:doc,root,panels);
      }
    }catch(error){vscode.window.showErrorMessage(error.message);}
  });
  return panel;
}
module.exports={detail,html,openPullRequest,openReviewDocument,discussionText};
