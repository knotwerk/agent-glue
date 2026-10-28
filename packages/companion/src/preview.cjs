'use strict';
const {mainEditorColumn}=require('./editor-target.cjs');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const parse5=require('parse5');
const MarkdownIt=require('markdown-it');
const {inside,supported,privatePath}=require('./core.cjs');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inlineJson=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const adapter=parse5.defaultTreeAdapter;
const HTML_NS='http://www.w3.org/1999/xhtml';
const IMAGE_LIMIT=5*1024*1024, STYLE_LIMIT=1024*1024, ASSET_BUDGET=20*1024*1024, ASSET_FILES=200;
const IMAGE_TYPES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'};
const DROPPED=['base','iframe','frame','frameset','object','embed','portal','meta','link'];
const DROPPED_ATTRS=['srcdoc','srcset','formaction','action','target','download','ping','poster','background','manifest'];
const external=ref=>/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref);
const BASE_STYLE='body{font:16px system-ui;line-height:1.6;padding:24px;color:#222;background:#fff}img{max-width:100%}pre{overflow:auto;padding:12px;background:#f3f3f3}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 12px}';
async function allowedPath(root,file,allowedFiles){
  if(!allowedFiles)return true;
  const base=await fs.realpath(root);
  const relative=value=>path.relative(base,value).split(path.sep).join('/');
  // Check both named and resolved paths: a tracked symlink cannot grant access
  // to ignored content, and an ignored alias cannot impersonate a tracked file.
  return allowedFiles.has(relative(path.resolve(file)))&&allowedFiles.has(relative(await fs.realpath(file)));
}
async function documentHtml(file,root,mermaidSource='',navigation) {
  if(!await allowedPath(root,file,navigation?.allowedFiles))throw new Error('File is not tracked in this review revision.');
  file=await inside(root,file);
  if(!supported(file))throw new Error('Choose a Markdown or HTML document.');
  const documentStat=await fs.stat(file);
  if(!documentStat.isFile())throw new Error('Preview requires a regular file.');
  if(documentStat.size>25*1024*1024)throw new Error('Preview limit is 25 MB. Download the file to open it locally.');
  const source=await fs.readFile(file,'utf8');
  const markdown=/\.(md|markdown)$/i.test(file);
  // Only a host caller may select PR-body repository-relative resolution.
  const linkBase=navigation?.linkBase?await inside(root,navigation.linkBase):path.dirname(file);
  if(!(await fs.stat(linkBase)).isDirectory())throw new Error('Review link base must be a directory.');
  const md=new MarkdownIt({html:false,linkify:false});
  const headings=new Map();
  if(navigation)md.renderer.rules.heading_open=(tokens,i,options,env,self)=>{
    const text=tokens[i+1]?.content||'';
    const slug=text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s/g,'-');
    const count=headings.get(slug)||0;headings.set(slug,count+1);
    tokens[i].attrSet('id',slug+(count?'-'+count:''));
    return self.renderToken(tokens,i,options);
  };
  const fence=md.renderer.rules.fence;
  md.renderer.rules.fence=(tokens,i,...rest)=>tokens[i].info.trim()==='mermaid'?`<pre class="mermaid">${escape(tokens[i].content)}</pre>`:fence(tokens,i,...rest);
  const tree=parse5.parse(markdown?md.render(source):source);
  // Every inlined asset counts against one per-document budget, including repeats.
  const budget={files:0,bytes:0}, cache=new Map();
  async function link(ref){
    if(!navigation||navigation.links.size>=500||!ref||external(ref)||ref.startsWith('#'))return null;
    try{
      const hash=ref.indexOf('#'), anchor=hash<0?'':decodeURIComponent(ref.slice(hash+1));
      const target=decodeURIComponent((hash<0?ref:ref.slice(0,hash)).split('?')[0]);
      const candidate=path.resolve(linkBase,target);
      if(privatePath(path.relative(root,candidate)))return null;
      const local=await inside(root,candidate);
      if(!await allowedPath(root,candidate,navigation.allowedFiles))return null;
      if(privatePath(path.relative(root,local)))return null;
      if(!supported(local)&&!IMAGE_TYPES[path.extname(local).toLowerCase()])return null;
      if(!(await fs.stat(local)).isFile())return null;
      const id=crypto.randomBytes(18).toString('hex');
      navigation.links.set(id,{file:local,anchor});return id;
    }catch{return null;}
  }
  async function asset(ref,dir,types,limit){
    if(budget.files>=ASSET_FILES||budget.bytes>=ASSET_BUDGET)return null;
    ref=ref.trim().split(/[?#]/)[0];
    if(!ref||external(ref))return null;
    try {
      const candidate=path.resolve(dir,decodeURIComponent(ref));
      const local=await inside(root,candidate);
      if(!await allowedPath(root,candidate,navigation?.allowedFiles))return null;
      const mime=types[path.extname(local).toLowerCase()];
      if(!mime)return null;
      if(!cache.has(local)){
        const stat=await fs.stat(local);
        cache.set(local,stat.isFile()&&stat.size<=limit&&stat.size<=ASSET_BUDGET-budget.bytes?await fs.readFile(local):null);
      }
      const data=cache.get(local);
      if(!data||budget.files>=ASSET_FILES||budget.bytes+data.length>ASSET_BUDGET)return null;
      budget.files++;budget.bytes+=data.length;
      return {mime,data,local};
    }catch{return null;/* Missing/outside assets stay unavailable. */}
  }
  async function image(ref,dir){
    if(/^data:/i.test(ref)){
      const match=/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(ref);
      if(!match||match[2].length>Math.ceil(IMAGE_LIMIT/3)*4)return '';
      const bytes=Buffer.from(match[2],'base64'), mime=match[1].toLowerCase();
      const valid=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):mime==='image/jpeg'?bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')):mime==='image/gif'?/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
      if(!valid||bytes.length>IMAGE_LIMIT||budget.files>=ASSET_FILES||budget.bytes+bytes.length>ASSET_BUDGET)return '';
      budget.files++;budget.bytes+=bytes.length;
      return 'data:'+mime+';base64,'+bytes.toString('base64');
    }
    const found=await asset(ref,dir,IMAGE_TYPES,IMAGE_LIMIT);
    return found?`data:${found.mime};base64,${found.data.toString('base64')}`:'';
  }
  // Local raster url() references become data URIs; anything else stays and is blocked by the CSP.
  async function css(text,dir){
    const pattern=/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
    let out='',last=0;
    for(const m of text.matchAll(pattern)){
      out+=text.slice(last,m.index);last=m.index+m[0].length;
      const data=m[2]&&!/^data:/i.test(m[2])?await image(m[2],dir):'';
      out+=data?`url("${data}")`:/^data:/i.test(m[2])?m[0]:'url("")';
    }
    return out+text.slice(last);
  }
  // Style element text is serialised raw, so it must not be able to close its element.
  const styleText=async(text,dir)=>(await css(text,dir)).replace(/<\/style/gi,'<\\/style');
  async function stylesheet(link){
    const attr=name=>link.attrs.find(a=>a.name===name)?.value;
    if(!/(^|\s)stylesheet(\s|$)/i.test(attr('rel')||'')||!attr('href'))return null;
    const found=await asset(attr('href'),path.dirname(file),{'.css':'text/css'},STYLE_LIMIT);
    if(!found)return null;
    const style=adapter.createElement('style',HTML_NS,attr('media')?[{name:'media',value:attr('media')}]:[]);
    adapter.insertText(style,await styleText(found.data.toString('utf8'),path.dirname(found.local)));
    return style;
  }
  async function walk(node){
    if(node.content)await walk(node.content);
    if(node.childNodes){
      const kept=[];
      for(const n of node.childNodes){
        if(n.tagName==='link'&&!markdown){const style=await stylesheet(n);if(style){style.parentNode=node;kept.push(style);}continue;}
        if(DROPPED.includes(n.tagName))continue;
        if(n.tagName==='style'&&!markdown)for(const t of n.childNodes)if(t.nodeName==='#text')t.value=await styleText(t.value,path.dirname(file));
        kept.push(n);
      }
      node.childNodes=kept;
      for(const n of node.childNodes)await walk(n);
    }
    if(!node.attrs)return;
    node.attrs=node.attrs.filter(a=>!DROPPED_ATTRS.includes(a.name)&&a.name!=='data-agent-glue-link');
    let linkId;
    for(const attr of node.attrs){
      if(attr.name==='href') {
        if(node.tagName==='a'&&!attr.namespace)linkId=await link(attr.value.trim());
        if(!attr.value.startsWith('#'))attr.value='#';
      }
      if(attr.name==='style'&&!markdown)attr.value=await css(attr.value,path.dirname(file));
      if(attr.name==='src') {
        const ref=attr.value;
        attr.value=node.tagName==='img'?await image(ref,markdown?linkBase:path.dirname(file)):'';
      }
    }
    if(linkId)node.attrs.push({name:'data-agent-glue-link',value:linkId});
  }
  await walk(tree);
  // Interactive HTML galleries may change a source link when selecting a tab.
  // Predeclare bounded sibling capabilities rather than trusting a live href.
  const siblingLinks=Object.create(null);
  if(navigation&&!markdown){
    const entries=await fs.readdir(linkBase,{withFileTypes:true});
    for(const entry of entries.filter(e=>e.isFile()&&(supported(e.name)||IMAGE_TYPES[path.extname(e.name).toLowerCase()])).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,500)){
      if(navigation.links.size>=500)break;
      const id=await link(encodeURIComponent(entry.name));
      if(id)for(const ref of [entry.name,'./'+entry.name,encodeURIComponent(entry.name),'./'+encodeURIComponent(entry.name)])siblingLinks[ref]=id;
    }
  }
  const policy="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none';";
  // Merge into the parsed document's own head/body so HTML documents keep their structure and head styles.
  tree.childNodes=tree.childNodes.filter(n=>n.nodeName!=='#documentType');
  const htmlNode=tree.childNodes.find(n=>n.tagName==='html');
  const head=htmlNode.childNodes.find(n=>n.tagName==='head'), bodyNode=htmlNode.childNodes.find(n=>n.tagName==='body');
  const prefix=parse5.parseFragment(`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}">${markdown?`<style>${BASE_STYLE}</style>`:''}`).childNodes;
  for(const n of prefix.reverse()){n.parentNode=head;head.childNodes.unshift(n);}
  const mermaid=markdown&&mermaidSource?`<script>${mermaidSource.replace(/<\/script/gi,'<\\/script')}</script><script>mermaid.initialize({startOnLoad:true,securityLevel:'strict'});</script>`:'';
  // The opaque frame can request only capabilities present in the host's map.
  // Anchor scrolling never navigates srcdoc to its embedding page's URL.
  const bridge=navigation?`<script>(()=>{const channel=${JSON.stringify(navigation?.channel||'')},siblings=${inlineJson(siblingLinks)};const scroll=anchor=>{if(!anchor)return;try{anchor=decodeURIComponent(anchor.replace(/^#/,''))}catch{}const target=document.getElementById(anchor)||Array.from(document.getElementsByName(anchor))[0];if(target){const hash='#'+encodeURIComponent(anchor);if(location.hash!==hash)location.hash=hash;target.scrollIntoView();}};document.addEventListener('click',event=>{const a=event.target.closest?.('a');if(!a)return;event.preventDefault();const ref=a.getAttribute('href')||'',id=ref==='#'?a.getAttribute('data-agent-glue-link'):Object.hasOwn(siblings,ref)?siblings[ref]:null;if(id&&channel)parent.postMessage({type:'previewLink',channel,id},'*');else if(ref.startsWith('#'))scroll(ref);},true);window.addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='previewAnchor'&&event.data.channel===channel)scroll(event.data.anchor);});window.addEventListener('DOMContentLoaded',()=>requestAnimationFrame(()=>scroll(${inlineJson(String(navigation?.anchor||''))})));})();</script>`:'';
  if(bodyNode){
    for(const n of parse5.parseFragment(mermaid+bridge).childNodes){n.parentNode=bodyNode;bodyNode.childNodes.push(n);}
  }
  return `<!doctype html>${parse5.serialize(tree)}`;
}
const pendingPreviews=new WeakMap();
async function openPreview(vscode,context,file,root,panels,anchor='',linkBase,allowedFiles){
  if(!await allowedPath(root,file,allowedFiles))throw new Error('File is not tracked in this review revision.');
  const key=await inside(root,file);
  const base=linkBase?await inside(root,linkBase):path.dirname(key);
  if(!(await fs.stat(base)).isDirectory())throw new Error('Review link base must be a directory.');
  const scope=allowedFiles?'\0tracked:'+String(allowedFiles.revision||'')+':'+crypto.createHash('sha256').update(JSON.stringify([...allowedFiles].sort())).digest('hex'):'';
  const panelKey=(base===path.dirname(key)?key:key+'\0'+base)+scope;
  if(panels.has(panelKey)){
    const existing=panels.get(panelKey);existing.reveal(await mainEditorColumn(vscode));
    if(anchor)await existing.webview.postMessage?.({type:'previewAnchor',anchor:String(anchor)});
    return;
  }
  let pending=pendingPreviews.get(panels);
  if(!pending){pending=new Map();pendingPreviews.set(panels,pending);}
  if(pending.has(panelKey)){
    const panel=await pending.get(panelKey);
    panel.reveal(await mainEditorColumn(vscode));
    if(anchor)await panel.webview.postMessage?.({type:'previewAnchor',anchor:String(anchor)});
    return panel;
  }
  const creation=(async()=>{
  const diagram=/\.(md|markdown)$/i.test(key)?await fs.readFile(path.join(context.extensionPath,'dist/mermaid.js'),'utf8'):'';
  const channel=crypto.randomBytes(18).toString('hex'),links=new Map();
  const content=await documentHtml(key,root,diagram,{channel,links,anchor,linkBase:base,allowedFiles});
  const panel=vscode.window.createWebviewPanel('agentGlue.preview',path.basename(key),await mainEditorColumn(vscode),{enableScripts:true,localResourceRoots:[],retainContextWhenHidden:true});
  panels.set(panelKey,panel);panel.onDidDispose(()=>{if(panels.get(panelKey)===panel)panels.delete(panelKey);});
  const nonce=crypto.randomBytes(18).toString('hex');
  // The srcdoc frame inherits this policy too, so it must allow the frame's inline scripts, styles and data: images.
  panel.webview.html=`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self';"><style>body{margin:0}nav{padding:8px;display:flex;gap:12px}iframe{border:0;width:100%;height:calc(100vh - 45px)}</style></head><body><nav><button id="source">Open source</button><button id="copy">Copy reference</button></nav><iframe title="Document preview" sandbox="allow-scripts" srcdoc="${escape(content)}"></iframe><script nonce="${nonce}">const vscode=acquireVsCodeApi();const frame=document.querySelector('iframe'),channel='${channel}';document.getElementById('source').onclick=()=>vscode.postMessage({type:'source'});document.getElementById('copy').onclick=()=>vscode.postMessage({type:'copy'});window.addEventListener('message',event=>{const m=event.data;if(event.source===frame.contentWindow){if(m?.type==='previewLink'&&m.channel===channel&&typeof m.id==='string')vscode.postMessage({type:'previewLink',channel,id:m.id});}else if(m?.type==='previewAnchor'&&typeof m.anchor==='string'){frame.contentWindow.postMessage({type:'previewAnchor',channel,anchor:m.anchor},'*');}});</script></body></html>`;
  panel.webview.onDidReceiveMessage(async message=>{
    if(!message)return;
    try{
      if(message.type==='copy')await vscode.env.clipboard.writeText(key);
      if(message.type==='source'){
        if(!await allowedPath(root,key,allowedFiles))throw new Error('File is not tracked in this review revision.');
        await vscode.window.showTextDocument(vscode.Uri.file(await inside(root,key)),await mainEditorColumn(vscode));
      }
      if(message.type==='previewLink'&&message.channel===channel&&links.has(message.id)){
        const target=links.get(message.id),local=await inside(root,target.file);
        if(!await allowedPath(root,target.file,allowedFiles))throw new Error('File is not tracked in this review revision.');
        if(privatePath(path.relative(await fs.realpath(root),local)))throw new Error('File is outside review material.');
        if(!(await fs.stat(local)).isFile())throw new Error('Review links require a regular file.');
        if(supported(local))await openPreview(vscode,context,local,root,panels,target.anchor,undefined,allowedFiles);
        else await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(local),await mainEditorColumn(vscode));
      }
    }catch(error){await vscode.window.showErrorMessage?.('Cannot open review link: '+error.message);}
  });
  return panel;
  })();
  pending.set(panelKey,creation);
  try{return await creation;}finally{pending.delete(panelKey);}
}
module.exports={documentHtml,openPreview,escape};
