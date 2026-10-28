'use strict';
// Render actual Companion views with invented data. No VS Code host, tmux,
// network, credentials, conversations or external project files are accessed.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('playwright');
const {renderSidebar}=require('../packages/companion/src/views.cjs');
const {html:reviewHtml}=require('../packages/companion/src/pull-request.cjs');
const {openPreview}=require('../packages/companion/src/preview.cjs');
const root=path.resolve(__dirname,'..');
function executable(){
  if(process.env.AGENT_GLUE_CHROMIUM)return process.env.AGENT_GLUE_CHROMIUM;
  const cache=path.join(os.homedir(),'.cache/ms-playwright');
  if(fs.existsSync(cache))for(const name of fs.readdirSync(cache).filter(n=>n.startsWith('chromium_headless_shell-')).sort().reverse()){
    for(const sub of fs.readdirSync(path.join(cache,name))){const file=path.join(cache,name,sub,'chrome-headless-shell');if(fs.existsSync(file))return file;}
  }
  return chromium.executablePath();
}
const now=Date.now();
const base={sessions:[{id:'demo',name:'claude-docs',cwd:'/workspace/demo'}],selectedSessionId:'demo',resourceFolder:'/workspace/demo',files:[],uploads:[],draft:{id:'demo',targetId:'demo',text:'Please simplify the overview and add a screenshot.'}};
const states={
 files:{...base,resourceTab:'files',files:[
  {id:'guide',path:'/workspace/demo/docs/getting-started.md',label:'getting-started.md',modified:now-5*60000,seen:now},
  {id:'image',path:'/workspace/demo/reports/preview.png',label:'preview.png',modified:now-12*60000},
  {id:'html',path:'/workspace/demo/reports/comparison.html',label:'comparison.html',modified:now-25*60000},
  {id:'data',path:'/workspace/demo/reports/results.csv',label:'results.csv',modified:now-3600000},
  {id:'zip',path:'/workspace/demo/releases/demo.zip',label:'demo.zip',modified:now-2*3600000}
 ]},
 prs:{...base,resourceTab:'prs',prFilter:'all',prSort:'title',prReadFilter:'all',resourceItems:[
  {id:'pr-1',label:'DOC-01 · Improve the quick start',description:'Prepared draft · not published',newComments:true,reviewDocuments:[{label:'Review notes',path:'/workspace/demo/docs/review.md',group:'review'},{label:'README.md',relative:'README.md',path:'/workspace/demo/README.md',group:'changes',status:'modified'}]},
  {id:'pr-2',label:'UI-02 · Clearer file filters',description:'Open',markedRead:true},
  {id:'pr-3',label:'UI-03 · Download actions',description:'Draft'}
 ]},
 tasks:{...base,resourceTab:'tasks',resourceItems:[
  {id:'task-1',label:'Finish the getting-started guide',status:'active',owner:'claude-docs',summary:'Examples are written. Checking the installation steps.',next:'Verify from a fresh checkout',updatedAt:new Date(now-5*60000).toISOString()},
  {id:'task-2',label:'Choose the preview layout',status:'review',owner:'codex-ui',summary:'Two alternatives are ready for review.',next:'Human feedback on comparison.html',updatedAt:new Date(now-22*60000).toISOString()},
  {id:'task-3',label:'Test native dictation',status:'blocked',owner:'claude-docs',summary:'Waiting for a Mac acceptance check.',updatedAt:new Date(now-3600000).toISOString()}
 ]}
};
(async()=>{
 const browser=await chromium.launch({executablePath:executable()});
 try{
  const fixture=path.join(root,'_script_outputs','screenshot-demo');fs.mkdirSync(fixture,{recursive:true});
  const document=path.join(fixture,'comparison.html');
  fs.writeFileSync(document,`<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px system-ui;color:#233242;background:#f6f9fc;margin:0;padding:28px}h1{font-size:28px;line-height:1.2}h2{font-size:18px;margin-top:28px}p{line-height:1.6}.tag{font-size:11px;letter-spacing:2px;color:#177a79}.card{border:1px solid #d2dce6;background:white;border-radius:8px;padding:16px;margin:16px 0}.bars{display:flex;align-items:end;gap:18px;height:120px;margin:18px 0}.bar{background:#218b99;color:white;padding:12px;border-radius:5px 5px 0 0;flex:1}.old{height:65%;background:#66788a}.new{height:95%}small{color:#627586}</style></head><body><span class="tag">DESIGN REVIEW · SYNTHETIC EXAMPLE</span><h1>A clearer first-run experience</h1><p>Compare two layouts without leaving the review. This HTML file lives beside the code.</p><div class="card"><strong>Proposed layout</strong><div class="bars"><div class="bar old">Before</div><div class="bar new">After</div></div><small>Illustrative values only — not product metrics.</small></div><h2>What changed?</h2><p>One obvious next step, simpler copy, and a visible link to the setup guide.</p><h2>Decision needed</h2><p>Is this enough context for someone opening the project for the first time?</p></body></html>`);
  const fake={ViewColumn:{One:1},window:{createWebviewPanel:()=>({webview:{onDidReceiveMessage(){}},onDidDispose(){}})}};
  const preview=await openPreview(fake,{extensionPath:path.join(root,'packages/companion')},document,fixture,new Map());
  const review=reviewHtml({local:true,title:'DOC-01 · Improve the first-run experience',isDraft:true,baseRefName:'main',body:'## Why this change\nThe current setup asks new users to assemble the workflow themselves.\n\n## Proposed change\nKeep one short path from installation to the first agent session.\n\n## Review material\n- [Design comparison](comparison.html)\n- [Implementation notes](notes.md)\n\n## What to review\nIs the next step clear? Open the rendered comparison and leave feedback below.',comments:[],files:[]},[{label:'Design comparison',relative:'comparison.html',path:document,hrefs:['comparison.html'],preview:true},{label:'Implementation notes',path:'/synthetic/notes.md',hrefs:['notes.md'],preview:true}]);
  const page=await browser.newPage({viewport:{width:1180,height:820},deviceScaleFactor:1});
  await page.addInitScript(()=>{window.acquireVsCodeApi=()=>({getState:()=>({}),setState(){},postMessage(){}});});
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='https://demo.invalid')return route.abort();
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#111820;color:#e9eef4;font:15px system-ui;padding:34px}h1{font-size:30px;margin:0 0 8px}p{color:#b5c1cd;line-height:1.5;margin:0 0 24px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{min-width:0}h2{font-size:16px;margin:0;padding:12px 14px;background:#263341;border-radius:8px 8px 0 0}iframe{display:block;border:1px solid #364453;width:100%;height:510px;background:#202124}.caption{font-size:13px;margin:14px 2px 0}.note{margin-top:25px;font-size:12px;color:#8e9eac}</style></head><body><h1>Keep the CLI. Lose the friction.</h1><p>Agent Glue Companion follows the agent terminal you select in VS Code.</p><div class="grid">${[['files','1 · Find the file','Recent mentions and edits rise to the top. Filter by type or time; open, preview or download.'],['prs','2 · Review the work','Stable ordering, local read marks and review files. Leave feedback in the review preview.'],['tasks','3 · Keep track','See progress, blockers and next steps. Agents maintain a small local task record.']].map(([key,title,caption])=>`<div class="card"><h2>${title}</h2><iframe src="/${key}" title="${key}"></iframe><p class="caption">${caption}</p></div>`).join('')}</div><p class="note">Actual sidebar rendering with synthetic demo data. VS Code’s native view toolbar is outside these panels.</p></body></html>`});
   if(url.pathname==='/preview')return route.fulfill({contentType:'text/html',body:preview.webview.html});
   if(url.pathname==='/review')return route.fulfill({contentType:'text/html',body:review});
   if(states[url.pathname.slice(1)])return route.fulfill({contentType:'text/html',body:renderSidebar({nonce:'demo',cspSource:'https://demo.invalid',scriptUri:'https://demo.invalid/companion.js',styleUri:'https://demo.invalid/companion.css'})});
   const name=path.basename(url.pathname);
   if(['companion.js','companion.css'].includes(name)||/^material-[a-z]+\.svg$/.test(name))return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'image/svg+xml',body:fs.readFileSync(path.join(root,'packages/companion/media',name))});
   return route.abort();
  });
  await page.goto('https://demo.invalid/');
  for(const [name,state] of Object.entries(states)){
   const frame=page.frames().find(f=>f.url()==='https://demo.invalid/'+name);
   await frame.waitForSelector('#draft-text');
   await frame.evaluate(state=>{
    const vars={'--vscode-font-family':'system-ui, sans-serif','--vscode-foreground':'#dbe4ec','--vscode-descriptionForeground':'#9cabb9','--vscode-dropdown-background':'#26313c','--vscode-dropdown-foreground':'#dbe4ec','--vscode-dropdown-border':'#3b4b5a','--vscode-input-background':'#26313c','--vscode-input-foreground':'#dbe4ec','--vscode-sideBar-background':'#1b252e','--vscode-button-background':'#1976b9','--vscode-button-foreground':'#ffffff'};
    for(const [key,value] of Object.entries(vars))document.documentElement.style.setProperty(key,value);
    window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state}}));
   },state);
   if(name==='prs')await frame.locator('.pr-chevron').first().click();
   if(name==='tasks')await frame.locator('.task-item summary').first().click();
  }
  await page.evaluate(()=>document.fonts.ready);
  const out=path.join(root,'docs/images');fs.mkdirSync(out,{recursive:true});
  await page.screenshot({path:path.join(out,'agent-glue-sidebar.png'),fullPage:true});
  await page.setViewportSize({width:1420,height:850});
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:25px;background:#111820;color:#e9eef4;font:15px system-ui}h1{font-size:27px;margin:0 0 8px}p{color:#b5c1cd;margin:0 0 20px}.grid{display:grid;grid-template-columns:310px 1fr 1fr;gap:16px}h2{font-size:14px;background:#263341;padding:12px;margin:0}iframe{width:100%;height:660px;border:1px solid #364453;box-sizing:border-box;background:#1b252e}small{display:block;margin-top:18px;color:#9cabb9}</style></head><body><h1>Review the changes. Open the document.</h1><p>Follow review material directly into rendered Markdown or HTML, alongside the PR.</p><div class="grid"><section><h2>1 · Expand the review files</h2><iframe src="https://demo.invalid/prs"></iframe></section><section><h2>2 · Read and leave feedback</h2><iframe src="https://demo.invalid/review"></iframe></section><section><h2>3 · Open the rendered HTML</h2><iframe src="https://demo.invalid/preview"></iframe></section></div><small>Actual Agent Glue webviews, arranged for explanation. All project content is synthetic. The same preview supports Markdown and Mermaid.</small></body></html>`);
  const sidebar=page.frames().find(f=>f.url()==='https://demo.invalid/prs');
  await sidebar.waitForSelector('#draft-text');
  await sidebar.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:{type:'state',state}})),{...states.prs,resourceItems:[{...states.prs.resourceItems[0],reviewDocuments:[{label:'Design comparison',path:'/synthetic/comparison.html',group:'review'},{label:'Implementation notes',path:'/synthetic/notes.md',group:'review'},{label:'README.md',path:'/synthetic/README.md',group:'changes'}]}]});
  await sidebar.locator('.pr-chevron').first().click();
  for(const frame of page.frames().filter(f=>/demo.invalid\/(prs|review)$/.test(f.url())))await frame.evaluate(()=>{for(const [k,v] of Object.entries({'--vscode-font-family':'system-ui, sans-serif','--vscode-foreground':'#dbe4ec','--vscode-descriptionForeground':'#9cabb9','--vscode-dropdown-background':'#26313c','--vscode-dropdown-foreground':'#dbe4ec','--vscode-button-background':'#1976b9','--vscode-button-foreground':'white','--vscode-input-background':'#26313c','--vscode-input-foreground':'#dbe4ec'}))document.documentElement.style.setProperty(k,v);});
  await page.screenshot({path:path.join(out,'agent-glue-pr-review.png'),fullPage:true});
  console.log('Rendered docs/images/agent-glue-sidebar.png and agent-glue-pr-review.png from synthetic fixtures.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
