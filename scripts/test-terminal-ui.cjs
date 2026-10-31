'use strict';
// Real VS Code UI with synthetic pseudoterminals, an isolated home/profile and
// loopback-only browser requests. No CLI, shell, tmux or existing terminal use.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),runtime=process.env.AGENT_GLUE_VSCODE_RUNTIME||path.join(root,'_script_outputs/vscode-ui-runtime');
if(!fs.existsSync(path.join(runtime,'out/server-main.js')))throw Error('Set AGENT_GLUE_VSCODE_RUNTIME to an extracted VS Code web server. See CONTRIBUTING.md.');
fs.mkdirSync(path.join(root,'_script_outputs'),{recursive:true});
const executablePath=process.env.AGENT_GLUE_CHROMIUM||chromium.executablePath();
if(!fs.existsSync(executablePath))throw Error('Run npx playwright install chromium, or set AGENT_GLUE_CHROMIUM.');
const dir=fs.mkdtempSync(path.join(root,'_script_outputs/terminal-ui-')),ext=path.join(dir,'extensions','fixture'),project=path.join(dir,'project');
for(const p of [ext,project,path.join(dir,'user','User'),path.join(dir,'home'),path.join(dir,'run')])fs.mkdirSync(p,{recursive:true});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'packages/companion/package.json')));
const contributions={viewsWelcome:manifest.contributes.viewsWelcome,commands:manifest.contributes.commands.filter(x=>/Selector|agentGlue.fork$/.test(x.command)),viewsContainers:{panel:manifest.contributes.viewsContainers.panel},views:{agentGlueSelector:manifest.contributes.views.agentGlueSelector},menus:{'view/item/context':manifest.contributes.menus['view/item/context'],'view/title':manifest.contributes.menus['view/title'].filter(x=>x.when==='view == agentGlue.terminalSelector')}};
fs.writeFileSync(path.join(ext,'package.json'),JSON.stringify({name:'agent-glue-ui-fixture',publisher:'fixture',version:'1.0.0',engines:{vscode:'^1.100.0'},main:'extension.cjs',extensionKind:['workspace'],capabilities:{untrustedWorkspaces:{supported:true}},activationEvents:['onStartupFinished'],contributes:contributions}));
fs.mkdirSync(path.join(ext,'media'));for(const name of fs.readdirSync(path.join(root,'packages/companion/media')).filter(n=>n.endsWith('.svg')))fs.copyFileSync(path.join(root,'packages/companion/media',name),path.join(ext,'media',name));
fs.writeFileSync(path.join(ext,'extension.cjs'),`const vscode=require('vscode'),fs=require('fs');
exports.activate=async context=>{
 void vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
 await new Promise(resolve=>{const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(dir,'register-provider'))})){clearInterval(poll);resolve();}},50);});
 const {registerSelector}=require(${JSON.stringify(path.join(root,'packages/companion/src/terminal-selector.cjs'))});
 const {summarize}=require(${JSON.stringify(path.join(root,'packages/companion/src/lifecycle.cjs'))});
 const {eventRecord}=require(${JSON.stringify(path.join(root,'packages/companion/src/lifecycle-hook.cjs'))});
 const identity={server:'1',pane:'%1',created:'1'},session={serverPid:'1',pane:'%1',created:'1'};
 let selector,control=[eventRecord({hook_event_name:'UserPromptSubmit',session_id:'ui'},identity,Date.now())];
 function terminal(name){const write=new vscode.EventEmitter();return vscode.window.createTerminal({name,pty:{onDidWrite:write.event,open(){write.fire('Synthetic terminal for UI testing. No shell or tmux.\\r\\n');},close(){}}});}
 const a=terminal('UI Alpha'),b=terminal('UI Beta');a.show(false);selector=registerSelector(vscode,context,t=>t===b?'fixture-agent':undefined,()=>summarize(control,session),async()=>'/remote/projects/example');
 const timer=setInterval(()=>{try{control=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir,'control.json'))},'utf8')).map(e=>eventRecord(e,identity,e.at));}catch{}selector.refresh();fs.writeFileSync(${JSON.stringify(path.join(dir,'state.json'))},JSON.stringify({names:vscode.window.terminals.map(t=>t.name),active:vscode.window.activeTerminal?.name}));},150);context.subscriptions.push({dispose(){clearInterval(timer);}});
 await vscode.commands.executeCommand('agentGlue.tryTerminalSelector');
};`);
fs.writeFileSync(path.join(dir,'user','User','settings.json'),JSON.stringify({'telemetry.telemetryLevel':'off','security.workspace.trust.enabled':false,'workbench.startupEditor':'none','workbench.tips.enabled':false,'terminal.integrated.hideOnStartup':'whenEmpty','extensions.autoUpdate':false,'extensions.ignoreRecommendations':true}));
const server=cp.spawn(path.join(runtime,'node'),[path.join(runtime,'out/server-main.js'),'--host','127.0.0.1','--port','0','--without-connection-token','--accept-server-license-terms','--telemetry-level','off','--user-data-dir',path.join(dir,'user'),'--server-data-dir',path.join(dir,'server'),'--extensions-dir',path.join(dir,'extensions')],{env:{PATH:process.env.PATH,HOME:path.join(dir,'home'),XDG_RUNTIME_DIR:path.join(dir,'run'),TMUX:'',TMUX_PANE:''},stdio:['ignore','pipe','pipe']});
let output='',startupError;server.on('error',error=>{startupError=error;});server.stdout.on('data',x=>{output+=x;fs.appendFileSync(path.join(dir,'server.log'),x);});server.stderr.on('data',x=>fs.appendFileSync(path.join(dir,'server.log'),x));
(async()=>{
 let browser;
 try{
  const started=Date.now();while(!/Extension host agent listening on (\d+)/.test(output)){if(startupError)throw startupError;if(server.exitCode!==null)throw Error('UI server exited: '+output);if(Date.now()-started>20000)throw Error('UI server startup timeout: '+output);await new Promise(r=>setTimeout(r,100));}
  const port=output.match(/Extension host agent listening on (\d+)/)[1];
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:950}});page.setDefaultTimeout(10000);await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:'+port+'/')?route.continue():route.abort());page.on('pageerror',e=>fs.appendFileSync(path.join(dir,'browser.log'),e.message+'\n'));
  await page.goto('http://127.0.0.1:'+port+'/?folder='+encodeURIComponent(project));
  await page.getByText(/Loading terminals…|Trust this workspace to show terminals\./).first().waitFor({timeout:45000});
  const manageTrust=page.getByRole('button',{name:'Manage Workspace Trust',exact:true});
  if(await manageTrust.isVisible()){
   await manageTrust.click();await page.getByRole('button',{name:'Trust',exact:true}).click();
   await page.locator('.monaco-modal-editor-block .codicon-close').first().click();
   await page.locator('.monaco-modal-editor-block').waitFor({state:'hidden'});
  }
  await page.getByText('Loading terminals…',{exact:true}).waitFor({timeout:45000});
  assert.equal(await page.getByText('There is no data provider registered that can provide view data.',{exact:true}).isVisible(),false);
  await page.screenshot({path:path.join(dir,'loading.png')});
  fs.writeFileSync(path.join(dir,'register-provider'),'ready');
  await page.getByRole('treeitem').filter({hasText:'UI Beta'}).first().waitFor({timeout:45000});
  assert.equal(await page.getByText('Loading terminals…',{exact:true}).isVisible(),false);
  const trust=page.getByRole('button',{name:'Trust Folder & Continue'});if(await trust.isVisible())await trust.click();
  await page.screenshot({path:path.join(dir,'before.png')});
  await page.getByRole('treeitem').filter({hasText:'UI Beta'}).first().click({button:'right'});
  const renameMenu=page.getByRole('menuitem',{name:/Rename Terminal/});await renameMenu.click();if(await renameMenu.isVisible())await renameMenu.press('Enter');
  const box=page.locator('.quick-input-widget input');await box.waitFor({state:'visible',timeout:10000});
  await box.fill('UI Renamed');await box.press('Enter');
  await page.getByRole('treeitem').filter({hasText:'UI Renamed'}).first().waitFor({timeout:10000});
  await page.screenshot({path:path.join(dir,'after.png')});
  const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));assert.ok(state.names.includes('UI Alpha'));assert.ok(state.names.includes('UI Renamed'));assert.ok(!state.names.includes('UI Beta'));
  const renamed=page.getByRole('treeitem').filter({hasText:'UI Renamed'}).first();
  const color=async name=>{await page.waitForFunction(({name})=>[...document.querySelectorAll('[role=treeitem]')].some(row=>row.textContent.includes('UI Renamed')&&new RegExp('status-'+name+'-(?:dark|light)\\.svg').test(row.innerHTML)), {name});};
  const signals=[{hook_event_name:'UserPromptSubmit',session_id:'ui',at:Date.now()-1000}];
  const signal=(event,extra={})=>{signals.push({hook_event_name:event,session_id:'ui',at:Date.now(),...extra});fs.writeFileSync(path.join(dir,'control.json'),JSON.stringify(signals));};
  await color('amber');
  await renamed.locator('.label-name').hover();
  const hover=page.locator('.monaco-hover').filter({hasText:'Folder: /remote/projects/example'}).first();
  await hover.waitFor({state:'visible'});
  const originalHover=await hover.elementHandle();
  for(let i=0;i<4;i++){signal('PreToolUse');await page.waitForTimeout(1500);assert.equal(await hover.isVisible(),true,'heartbeat refresh must preserve the folder hover');assert.equal(await originalHover.evaluate(e=>e.isConnected),true,'hover must not be closed and recreated');}
  await page.mouse.move(20,20);
  signal('PermissionRequest');await color('red');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).active,'UI Renamed');await color('red');
  signal('PostToolUse');await color('amber');
  signal('Stop',{background_tasks:[{type:'shell',status:'running'}]});
  await page.waitForTimeout(500);await color('amber');
  signal('Stop',{background_tasks:[{type:'shell',status:'completed'}]});
  await color('green-new');await renamed.click();await page.waitForTimeout(2200);await page.keyboard.press('F1');const commands=page.locator('.quick-input-widget input');await commands.fill('>Agent Glue: Try Terminal Selector Beside Terminals');await page.waitForTimeout(300);await commands.press('Enter');await color('green');
  await renamed.click({button:'right'});const unread=page.getByRole('menuitem',{name:'Mark Unread',exact:true});await unread.click();if(await unread.isVisible())await unread.press('Enter');await color('green-new');
  await page.screenshot({path:path.join(dir,'unread.png')});
  console.log(JSON.stringify({passed:true,checks:['loading without provider warning','rename exact terminal','hook events to amber/red/green','running service amber, stopped service green','folder hover survives heartbeat refreshes','selected colour preserved','finished ring','read delay','mark unread'],dir,state}));
 }catch(e){console.error(e.stack);console.error('UI artifacts: '+dir);if(browser){const p=browser.contexts()[0]?.pages()[0];if(p){await p.screenshot({path:path.join(dir,'failure.png')});fs.writeFileSync(path.join(dir,'failure.txt'),await p.locator('body').innerText());}}process.exitCode=1;
 }finally{try{await browser?.close();}finally{server.kill('SIGTERM');}}
})();
