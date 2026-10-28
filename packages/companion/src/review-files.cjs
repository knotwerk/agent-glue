'use strict';
const {mainEditorColumn}=require('./editor-target.cjs');
const path=require('node:path');
const fs=require('node:fs/promises');
const crypto=require('node:crypto');
const MarkdownIt=require('markdown-it');
const core=require('./core.cjs');
const providers=new WeakMap();
const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
function safeRelative(value){
  return typeof value==='string'&&value.length>0&&!value.includes('\0')&&!value.includes('\\')&&!path.isAbsolute(value)&&!core.privatePath(value)&&!value.split('/').some(x=>x==='..'||['.local'].includes(x.toLowerCase()));
}
function links(source){
  const tokens=new MarkdownIt().parse(String(source||''),{}),out=[];
  let section=false,hasSection=false;
  for(let i=0;i<tokens.length;i++){
    if(tokens[i].type==='heading_open'&&tokens[i].tag==='h2'){
      section=tokens[i+1]?.content.trim().toLowerCase()==='review material';hasSection ||= section;
    }
    const children=tokens[i].children||[];
    for(let j=0;j<children.length;j++){
      const token=children[j];
      if(token.type==='link_open'||token.type==='image'){
        const href=token.attrGet(token.type==='image'?'src':'href');
        let label=token.content||'';
        if(token.type==='link_open')for(let k=j+1;k<children.length&&children[k].type!=='link_close';k++)label+=children[k].content||'';
        if(href)out.push({href,label,section,image:token.type==='image'});
      }
    }
  }
  return {all:out,review:hasSection?out.filter(x=>x.section):out};
}
function resolveLink(href,repoURL='',refs=[]){
  try{
    const hash=href.indexOf('#'),anchor=hash>=0?decodeURIComponent(href.slice(hash+1)):'';
    let value=href.split('#')[0].split('?')[0],ref='';
    if(/^https:\/\//.test(value)){
      if(!repoURL||!value.startsWith(repoURL+'/blob/'))return null;
      value=decodeURIComponent(value.slice((repoURL+'/blob/').length));
      ref=refs.filter(Boolean).sort((a,b)=>b.length-a.length).find(r=>value.startsWith(r+'/'))||value.split('/')[0];
      value=value.slice(ref.length+1);
    }else if(/^[a-z][a-z\d+.-]*:|^\/\//i.test(value))return null;
    else value=decodeURIComponent(value).replace(/^\.\//,'');
    return safeRelative(value)?{relative:value,anchor,...(ref?{ref,githubUrl:href}:{})}:null;
  }catch{return null;}
}
async function changes(root,base,head,{exec=core.run}={}){
  if(!sha(base)||!sha(head))return [];
  const {stdout:ancestor}=await exec('git',['-C',root,'merge-base',base,head],{timeout:10000,maxBuffer:1024});
  const mergeBase=ancestor.trim();if(!sha(mergeBase))throw new Error('Cannot identify the review base.');
  const {stdout}=await exec('git',['-C',root,'diff','--name-status','-z','--find-renames',mergeBase,head,'--'],{timeout:10000,maxBuffer:4*1024*1024});
  const fields=stdout.split('\0'),out=[];
  for(let i=0;i<fields.length-1;){
    const status=fields[i++],before=fields[i++],after=/^[RC]/.test(status)?fields[i++]:before;
    if(!safeRelative(before)||!safeRelative(after))continue;
    out.push({root,path:path.resolve(root,after),relative:after,label:after,group:'changes',status:status[0],base:mergeBase,head,beforePath:status==='A'?'':before,afterPath:status==='D'?'':after,preview:false,image:false});
  }
  return out;
}
async function snapshot(exec,root,revision,file,binary=false){
  if(!file)return '';
  if(!sha(revision)||!safeRelative(file))throw new Error('Invalid review revision or file.');
  const {stdout}=await exec('git',['-C',root,'show',revision+':'+file],{timeout:10000,maxBuffer:5*1024*1024,encoding:binary?null:'utf8'});
  return stdout;
}
async function openDiff(vscode,context,doc,{exec=core.run}={}){
  if(!sha(doc.base)||!sha(doc.head))throw new Error('This prepared file has no committed comparison yet.');
  const root=await fs.realpath(doc.root);
  const image=/\.(png|jpe?g|gif|webp)$/i.test(doc.relative);
  const [before,after]=await Promise.all([snapshot(exec,root,doc.base,doc.beforePath,image),snapshot(exec,root,doc.head,doc.afterPath,image)]);
  if(image){
    const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const mime=path.extname(doc.relative).slice(1).toLowerCase().replace(/^jpg$/,'jpeg');
    const picture=(data,label)=>'<section><h2>'+label+'</h2>'+(data.length?'<img alt="'+label+'" src="data:image/'+mime+';base64,'+Buffer.from(data).toString('base64')+'">':'<p>No image at this revision.</p>')+'</section>';
    const panel=vscode.window.createWebviewPanel('agentGlue.imageComparison',doc.relative,await mainEditorColumn(vscode),{enableScripts:false,localResourceRoots:[]});
    panel.webview.html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';"><style>body{font:14px system-ui;color:var(--vscode-foreground);background:var(--vscode-editor-background)}main{display:flex;gap:16px}section{flex:1;min-width:0}img{max-width:100%;height:auto}h2{font-size:15px}</style></head><body><h1>${escape(doc.relative)}</h1><main>${picture(before,'Before · '+doc.base.slice(0,8))}${picture(after,'After · '+doc.head.slice(0,8))}</main></body></html>`;
    context.subscriptions.push(panel);return;
  }
  if(before.includes('\0')||after.includes('\0'))throw new Error('Binary file comparison is unavailable; open its review attachment or GitHub change.');
  let provider=providers.get(vscode.workspace);
  if(!provider){
    const entries=new Map();
    const disposable=vscode.workspace.registerTextDocumentContentProvider('agent-glue-review',{provideTextDocumentContent:uri=>entries.get(uri.toString())||''});
    context.subscriptions.push(disposable);provider=entries;providers.set(vscode.workspace,provider);
  }
  const key=crypto.randomBytes(12).toString('hex'),name=encodeURIComponent(path.basename(doc.relative));
  const left=vscode.Uri.parse(`agent-glue-review:/${key}/before/${name}`),right=vscode.Uri.parse(`agent-glue-review:/${key}/after/${name}`);
  provider.set(left.toString(),before);provider.set(right.toString(),after);
  while(provider.size>400)provider.delete(provider.keys().next().value);
  await vscode.commands.executeCommand('vscode.diff',left,right,doc.relative,{viewColumn:await mainEditorColumn(vscode),preview:true});
}
async function cleanCheckout(root,revision,{exec=core.run}={}){
  if(!sha(revision))return false;
  try{
    const {stdout:head}=await exec('git',['-C',root,'rev-parse','HEAD'],{timeout:10000,maxBuffer:1024});
    if(head.trim()!==revision)return false;
    const {stdout}=await exec('git',['-C',root,'status','--porcelain','--untracked-files=all'],{timeout:10000,maxBuffer:4*1024*1024});
    return !stdout.trim();
  }catch{return false;}
}
module.exports={cleanCheckout,sha,safeRelative,links,resolveLink,changes,openDiff};
