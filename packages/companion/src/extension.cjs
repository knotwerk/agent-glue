'use strict';
const {mainEditorColumn}=require('./editor-target.cjs');
const vscode=require('vscode');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const core=require('./core.cjs');
const {WebApps,appLabel,appStatus,appDetails,hiddenEndpoint}=require('./web-apps.cjs');
const resources=require('./resources.cjs');
const {TerminalActivity,terminalUri}=require('./terminal-activity.cjs');
const {BrowserLinks}=require('./browser-links.cjs');
const {openPullRequest,detail:reviewDetail,openReviewDocument}=require('./pull-request.cjs');
const {renderSidebar,renderDraft}=require('./views.cjs');
const {openPreview}=require('./preview.cjs');
function activate(context){
  if(!vscode.workspace.isTrusted)return;
  const views=new Set(),panels=new Map(),uploads=new core.Uploads();
  const browserLinks=new BrowserLinks({mermaidPath:path.join(context.extensionPath,'dist/mermaid.js')});
  context.subscriptions.push(browserLinks);
  let terminalActivity;const activityReports={};
  const statusReports=context.workspaceState.get('statusReports',{});let statusRunBusy=false,statusRunSessionId;
  const apps=new WebApps(core.run);let appsPanel,appsSignature,forkBusy=false;
  let sidebar,sidebarWebview,draftPanel,draftWebview,sessionList=[],selected=context.workspaceState.get('selected'),files=context.workspaceState.get('files',{});
  // Recover files hidden with the removed sidebar action; honor explicit [remove] directives.
  for(const entries of Object.values(files))for(const file of entries){
    if(file.hidden&&!/^\s*\[remove\]/i.test(file.lastDirective||''))file.hidden=false;
  }
  let draft=context.workspaceState.get('draft',{id:crypto.randomUUID(),text:'',attachments:[]});
  let refreshWork,refreshAgain=false,lastMappedTerminal,api,status='',connectionStatus='',helperSetup;
  let dictationRequest,followTarget=false,clipboardBusy=false,manualSelection;
  const uploadBatches=new Map();
  const uploadBusy=()=>clipboardBusy||uploadBatches.size||uploads.pending.size||uploads.active.size;
  const terminalSelector=vscode.window.createTreeView?require('./terminal-selector.cjs').registerSelector(vscode,context,terminal=>api?.sessionForTerminal(terminal)):undefined;
  let resourceTab='files',prFilter=context.workspaceState.get('prFilter','all'),resourceItems=[],resourceStatus='',resourceKey='',resourceRoot,resourceGeneration=0,resourceLoadedAt=0;
  let prSort=context.workspaceState.get('prSort','title'),prReadFilter=context.workspaceState.get('prReadFilter','all');
  const prRead=context.workspaceState.get('prRead',{});
  const readKey=item=>JSON.stringify([resourceRoot,item.id]);
  const visibleResources=()=>resourceTab==='tasks'?resourceItems:resourceItems.map(item=>({...item,markedRead:Boolean(prRead[readKey(item)])})).filter(item=>prReadFilter!=='unread'||!item.markedRead);
  const prSeen=context.workspaceState.get('prSeen',{});
  async function probeDictation(capability){
    try{
      const info=await vscode.commands.executeCommand('agentGlueMac.status');
      if(!info)return false;
      if(!['nativeDownload','localFiles'].includes(capability)&&info.platform!=='darwin')throw new Error('Dictation helper is running on the wrong host; it must run locally on the Mac.');
      if(info.version&&info.safeNativeErrors!==true)return false;
      if(capability==='localFiles'&&!(info.maxFileBytes>=200*1024*1024))return false;
      return !capability||info[capability]===true;
    }catch(error){
      if(/command.*(not found|not registered)/i.test(error.message))return false;
      throw error;
    }
  }
  async function ensureDictation(capability){
    if(await probeDictation(capability))return;
    if(!helperSetup)helperSetup=(async()=>{
      status=capability==='localFiles'?'Setting up local file uploads…':capability==='nativeDownload'?'Setting up native downloads…':'Setting up macOS Dictation…';publish();
      const helper=vscode.Uri.joinPath(context.extensionUri,'dist','mac-dictation.vsix');
      await vscode.commands.executeCommand('workbench.extensions.installExtension',helper);
      // Installing a VSIX can finish before its local host registers commands.
      // An already-running older helper needs a reload rather than another install.
      let ready=false;
      for(let attempt=0;attempt<10;attempt++){
        if(await probeDictation(capability)){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      if(!ready){
        const message='The local Agent Glue helper was updated. Reload Window to activate it, then retry your action.';
        const action=await vscode.window.showInformationMessage(message,'Reload Window');
        if(action==='Reload Window')await vscode.commands.executeCommand('workbench.action.reloadWindow');
        throw new Error(message);
      }
      status='';publish();
    })().finally(()=>{helperSetup=undefined;});
    await helperSetup;
    if(!await probeDictation(capability))throw new Error('Reload Window to activate the updated local helper, then try again.');
  }
  async function appAction(id,action='open'){
    const item=apps.items.find(a=>a.id===id);if(!item)throw new Error('This web app is no longer available. Refresh the view.');
    if(action==='menu'){
      const chosen=await vscode.window.showQuickPick(['Open','Open in browser','Copy link','Diagnostics'],{placeHolder:appLabel(item.url)+' — '+item.url});
      if(!chosen)return;action={'Open':'open','Open in browser':'browser','Copy link':'copy','Diagnostics':'diagnostics'}[chosen];
    }
    if(action==='diagnostics'){
      const result=await vscode.window.showInformationMessage(appDetails(item)+' — '+item.url+'. A responding server does not guarantee a rendered page. If the page is blank, try the external browser; inspect its Network and Console for failed requests or scripts.','Open in browser','Copy link');
      if(!result)return;action=result==='Open in browser'?'browser':'copy';
    }
    const uri=vscode.Uri.parse(item.url);
    if(action==='browser'){await vscode.env.openExternal(uri);return;}
    const external=await vscode.env.asExternalUri(uri);
    if(action==='copy'){await vscode.env.clipboard.writeText(external.toString());return;}
    const column=await mainEditorColumn(vscode);
    try{await vscode.commands.executeCommand('simpleBrowser.api.open',external,{viewColumn:column,preserveFocus:false});}catch{await vscode.env.openExternal(uri);}
  }
  function renderAppsPanel(){
    if(!appsPanel)return;
    const signature=JSON.stringify(apps.items);if(signature===appsSignature)return;appsSignature=signature;
    const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const nonce=crypto.randomBytes(20).toString('hex');
    appsPanel.webview.html=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground)}td,th{text-align:left;padding:8px}button{cursor:pointer}table{width:100%}</style></head><body><h2>Web apps · ${apps.items.filter(a=>!hiddenEndpoint(a)).length} responding</h2><p>Agent CLI ports are excluded. Services and protected endpoints are hidden by default. Use … → Diagnostics for details or Open in browser if a page is blank.</p><label><input id="all" type="checkbox">Show services, protected and unreachable endpoints</label><table><tr><th>Status</th><th>Discovery</th><th>Terminal</th><th>Folder</th><th>File / page</th><th>Address</th><th></th></tr>${apps.items.map(a=>`<tr data-running="${!hiddenEndpoint(a)}" ${hiddenEndpoint(a)?'hidden':''}><td title="${esc(appDetails(a))}">${esc(appStatus(a))}</td><td>${a.source==='link'?'Terminal link':'Port · guessed /'}</td><td>${esc(a.terminal)}</td><td>${esc(a.cwd)}</td><td>${esc(appLabel(a.url))}</td><td><button data-id="${esc(a.id)}" data-action="open">${esc(a.url)}</button></td><td><button data-id="${esc(a.id)}" data-action="menu">…</button></td></tr>`).join('')}</table><script nonce="${nonce}">const v=acquireVsCodeApi();const all=document.getElementById('all');all.checked=Boolean(v.getState()?.showStopped);const filter=()=>document.querySelectorAll('[data-running="false"]').forEach(r=>r.hidden=!all.checked);filter();all.onchange=()=>{v.setState({showStopped:all.checked});filter();};document.onclick=e=>{const b=e.target.closest('[data-id]');if(b)v.postMessage({id:b.dataset.id,action:b.dataset.action});};document.oncontextmenu=e=>{const b=e.target.closest('[data-id]');if(b){e.preventDefault();v.postMessage({id:b.dataset.id,action:'menu'});}};</script></body></html>`;
  }
  async function showApps(){
    if(!appsPanel){appsPanel=vscode.window.createWebviewPanel('agentGlue.webApps','Agent Glue — Web apps',await mainEditorColumn(vscode),{enableScripts:true});appsPanel.onDidDispose(()=>{appsPanel=undefined;appsSignature=undefined;});appsPanel.webview.onDidReceiveMessage(m=>appAction(m.id,m.action).catch(e=>vscode.window.showErrorMessage(e.message)));}
    else appsPanel.reveal(await mainEditorColumn(vscode));
    await apps.refresh(await core.sessions(),true);renderAppsPanel();
  }
  async function attachmentRecipient(targetId){
    if(!targetId)throw Error('Choose an agent in the recipient list before attaching files.');
    if(targetId!==draft.targetId)throw Error('The draft recipient changed. Choose the files again for the intended recipient.');
    let target=byId(targetId);
    if(!target){await refresh();target=byId(targetId);}
    if(!target)throw Error('The chosen agent session is no longer available. Choose another recipient.');
    const root=draft.root||await core.project(target.cwd).catch(()=>undefined);
    if(!root)throw Error('Cannot find a Git project for '+target.name+'. Open the agent in its project folder and try again.');
    if(targetId!==draft.targetId)throw Error('The draft recipient changed. Choose the files again for the intended recipient.');
    draft.root=root;return {targetId,root};
  }
  async function importLocalFiles(message){
    if(!Array.isArray(message.paths)||!message.paths.length||message.paths.length>20||message.paths.some(p=>typeof p!=='string'||p.length>4096))throw Error('Drop or paste up to 20 local file paths.');
    if(uploadBusy())throw Error('Wait for the current upload to finish.');
    clipboardBusy=true;
    try{
      await refresh();
      const {targetId,root}=await attachmentRecipient(message.targetId);
      await ensureDictation('localFiles');
      for(const localPath of message.paths){
        let file;
        try{file=await vscode.commands.executeCommand('agentGlueMac.readLocalFile',localPath);}
        catch(error){
          // A pasted path may already refer to a file on the SSH host.
          const remote=path.isAbsolute(localPath)&&/ENOENT/.test(error.message||'')?await fs.stat(localPath).catch(()=>undefined):undefined;
          if(!remote?.isFile())throw error;
          draft.attachments.push({name:path.basename(localPath),path:localPath,size:remote.size,targetId});await save();publish();continue;
        }
        if(!file||typeof file.data!=='string'||!Number.isSafeInteger(file.size)||file.size<0||file.size>200*1024*1024||file.data.length>4*Math.ceil(200*1024*1024/3))throw Error('The local helper did not return a valid file. Reload and retry.');
        const bytes=Buffer.from(file.data,'base64');if(bytes.length!==file.size||bytes.toString('base64')!==file.data)throw Error('The local file transfer was incomplete. Try again.');
        const id=crypto.randomUUID();
        try{
          status='Uploading '+file.name+'…';publish();
          await uploads.start({id,name:file.name,size:bytes.length,mime:'application/octet-stream'},root,targetId);
          for(let offset=0;offset<bytes.length;offset+=192*1024)await uploads.chunk({id,offset,data:bytes.subarray(offset,offset+192*1024).toString('base64')});
          draft.attachments.push(await uploads.finish(id));await save();publish();
        }catch(error){await uploads.abort(id);throw error;}
      }
      status='Files attached with remote paths.';
    }finally{clipboardBusy=false;}
  }
  async function runStatus(){
    if(statusRunBusy)return;
    statusRunBusy=true;statusRunSessionId=selected;publish();
    try{
      await refresh();
      const source=byId(selected),active=vscode.window.activeTerminal;statusRunSessionId=source?.id;
      if(!source||!sidebar?.visible)throw Error('Select an agent terminal and open Agent Glue before running status.');
      const {stdout}=await core.run('tmux',['capture-pane','-p','-J','-t',source.pane,'-S','-500'],{maxBuffer:1024*1024});
      if(selected!==source.id||active!==vscode.window.activeTerminal||!sidebar?.visible)throw Error('Selected terminal changed. Run status again.');
      status='Summarizing '+source.name+'…';publish();
      const runner=require('./status-runner.cjs');
      const local=await resources.list('tasks',source.cwd,{session:source});
      if(selected!==source.id||active!==vscode.window.activeTerminal||!sidebar?.visible)throw Error('Selected terminal changed. Run status again.');
      const previous={items:runner.combine(statusReports[source.id],local.items)};
      const report=await runner.summarize({...source},stdout,path.join(context.globalStorageUri.fsPath,'status-runs'),{previous});
      statusReports[source.id]=report;activityReports[source.id]=report;
      const oldest=Object.keys(statusReports).sort((a,b)=>statusReports[b].updatedAt.localeCompare(statusReports[a].updatedAt));for(const id of oldest.slice(100))delete statusReports[id];
      await context.workspaceState.update('statusReports',statusReports);
      status='Status updated for '+source.name+'.';
      if(selected===source.id&&resourceTab==='tasks')loadResources(true);
    }finally{statusRunBusy=false;statusRunSessionId=undefined;publish();}
  }
  async function bindTerminalActivity(values){
    if(!Array.isArray(values)||values.length!==1)throw Error('Drag one terminal row at a time to link its status badge.');
    const uri=terminalUri(vscode,values[0]);
    if(!vscode.window.registerFileDecorationProvider)throw Error('This VS Code host does not support terminal decorations.');
    const link=await sessionsApi();if(!link)throw Error('Enable Agent Glue Sessions to identify the terminal.');
    await link.refresh();const sessions=await core.sessions();
    const choices=vscode.window.terminals.flatMap(terminal=>{
      const source=core.sessionForTerminal(terminal,sessions,link.sessionForTerminal(terminal));
      return source?[{label:terminal.name,description:source.profile+' · '+source.cwd,detail:source.sessionName,terminal,source}]:[];
    });
    const choice=await vscode.window.showQuickPick(choices,{title:'Which terminal row did you drag?',placeHolder:'Confirm the source tab. VS Code supplies its resource ID without its name.'});
    if(!choice)return;
    if(link.sessionForTerminal(choice.terminal)!==choice.source.sessionName)throw Error('The terminal changed. Drop it again.');
    terminalActivity??=new TerminalActivity(vscode,context);
    terminalActivity.bind(uri,choice.terminal,choice.source);
    status='Native terminal badge linked. Repeat for other tabs; links last until this window reloads.';
    await refresh();
  }
  async function forkConversation(target){
    if(forkBusy)return;
    forkBusy=true;
    try{
      // Terminal context menus pass the clicked Terminal (or selected array).
      // Never fall back to the sidebar's stale selection for an explicit target.
      if(Array.isArray(target)){if(target.length!==1)throw new Error('Choose one agent terminal to fork.');target=target[0];if(!target)throw new Error('This terminal is no longer available.');}
      const terminal=target??vscode.window.activeTerminal;
      if(!terminal)throw new Error('Select an agent terminal first.');
      const link=await sessionsApi();if(!link?.forkSession)throw new Error('Update Agent Glue Sessions to enable conversation forks.');
      const source=core.sessionForTerminal(terminal,await core.sessions(),link.sessionForTerminal(terminal));
      if(!source)throw new Error('This terminal is not an attached agent session.');
      const folder=await new Promise(resolve=>{
        const input=vscode.window.createInputBox();input.title='Fork '+source.name;input.value=source.cwd;input.prompt='Destination folder on the workspace host. Enter to create the fork.';
        input.buttons=[{iconPath:new vscode.ThemeIcon('folder-open'),tooltip:'Browse folders'}];let done=false,browsing=false;
        const finish=value=>{if(done)return;done=true;resolve(value);input.dispose();};
        input.onDidHide(()=>{if(!browsing)finish();});
        input.onDidTriggerButton(async()=>{browsing=true;try{const picked=await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,defaultUri:vscode.Uri.file(input.value)});if(picked?.[0])input.value=picked[0].fsPath;}finally{browsing=false;if(!done)input.show();}});
        input.onDidAccept(async()=>{try{const folder=path.resolve(source.cwd,input.value.replace(/^~(?=\/|$)/,require('node:os').homedir()));if(!(await fs.stat(folder)).isDirectory())throw Error();finish(folder);}catch{input.validationMessage='Choose an existing folder on the workspace host.';}});input.show();
      });
      if(!folder)return;
      let options;
      if(Array.isArray(link.handoffProfiles)){
        const choice=await vscode.window.showQuickPick([
          {label:'Same CLI / account',description:source.profile+' · native conversation fork',profile:source.profile},
          ...link.handoffProfiles.filter(program=>program!==source.profile).map(program=>({label:program,description:'New conversation with a handoff note',profile:program}))
        ],{title:'Continue with which CLI / account?',placeHolder:'Same account preserves history; another account receives source details and saved status'});
        if(!choice)return;
        if(choice.profile!==source.profile){
          const details=await vscode.window.showInputBox({title:'Optional source status for '+choice.profile,prompt:'Paste /status output or a short handoff note. Enter to skip; Escape cancels. This is shared with the new agent.',value:'',validateInput:value=>value.length>16000?'Keep the handoff under 16,000 characters.':undefined});
          if(details===undefined)return;
          const runner=require('./status-runner.cjs');
          const local=await resources.list('tasks',source.cwd,{session:source});
          const tasks=runner.visible(runner.combine(statusReports[source.id],local.items));
          options={profile:choice.profile,status:details,tasks:JSON.stringify(tasks).slice(0,24000)};
        }
      }
      await link.forkSession({...source},folder,options);
    }finally{forkBusy=false;}
  }
  const cleared=new Set();
  let queue=Promise.resolve();
  const byId=id=>sessionList.find(s=>s.id===id);
  const save=async()=>{await context.workspaceState.update('files',files);await context.workspaceState.update('draft',draft);await context.workspaceState.update('selected',selected);};
  const state=()=>({statusRunBusy,statusRunSessionId,webApps:apps.items.filter(item=>item.sessionId===selected&&!hiddenEndpoint(item)).map(item=>({...item,label:appLabel(item.url),healthLabel:appStatus(item),details:appDetails(item)})),webAppsActiveTotal:apps.items.filter(item=>!hiddenEndpoint(item)).length,sessions:sessionList,selectedSessionId:selected,filesMessage:byId(selected)?`No existing files found in the recent terminal output for ${byId(selected).name}.`:'No matching agent session for the selected terminal. Select an attached agent terminal or use Choose Session in the view menu.',resourceTab,prFilter,prSort,prReadFilter,resourceItems:visibleResources(),resourceStatus,resourceGeneration,resourceFolder:resourceRoot||byId(selected)?.cwd||'',files:(files[selected]||[]).filter(f=>!f.hidden&&!f.missing),draft,status:status||connectionStatus});
  const post=(view,message)=>{try{void Promise.resolve(view.postMessage(message)).catch(()=>views.delete(view));}catch{views.delete(view);}};
  const publish=()=>{terminalSelector?.refresh();terminalActivity?.update(sessionList,{...statusReports,...activityReports},selected,Boolean(sidebar?.visible),api);if(sidebar)sidebar.title=byId(selected)?'AG - '+byId(selected).profile:'AG';for(const view of views)post(view,{type:'state',state:state()});};
  function loadResources(force=false){
    const cwd=byId(selected)?.cwd;
    const key=resourceTab+':'+prFilter+':'+(cwd||'')+(resourceTab==='tasks'?':'+selected:'');
    if(!force&&key===resourceKey&&(resourceTab==='files'||Date.now()-resourceLoadedAt<(resourceTab==='tasks'?5000:60000)))return;
    void vscode.commands.executeCommand('setContext','agentGlue.resourceTab',resourceTab);
    if(sidebar)sidebar.description=({files:'Files',prs:'PRs',tasks:'Terminal status'})[resourceTab];
    const changed=key!==resourceKey;
    resourceKey=key;resourceLoadedAt=Date.now();const generation=++resourceGeneration;
    if(changed){resourceItems=[];resourceRoot=undefined;}
    resourceStatus='';
    if(resourceTab==='files'){publish();return;}
    if(!cwd){resourceStatus='Select an agent terminal to see its project.';publish();return;}
    resourceStatus='Loading…';publish();
    void resources.list(resourceTab,cwd,{filter:prFilter,session:byId(selected)}).then(result=>{
      if(generation!==resourceGeneration)return;
      resourceRoot=result.root;
      if(resourceTab==='tasks'){const {combine,visible}=require('./status-runner.cjs');const combined=combine(statusReports[selected],result.items);activityReports[selected]={items:combined};result={...result,items:visible(combined)};}
      resourceItems=result.items.map(item=>({...item,newComments:item.commentAt&&item.commentAt>(prSeen[item.id]||new Date(Date.now()-7*86400000).toISOString())}));
      if(resourceTab==='prs')resourceItems=resources.sortItems(resourceItems,prSort);
      resourceStatus=result.warning||'';publish();
    }).catch(error=>{if(generation===resourceGeneration){resourceItems=[];resourceStatus=error.message;publish();}});
  }
  async function sessionsApi(){
    if(api)return api;
    const extension=vscode.extensions.getExtension('knotwerk.agent-glue-sessions');
    if(extension)try{api=await extension.activate();terminalSelector?.refresh();}catch{api=undefined;}
    return api;
  }
  function refresh(){
    if(refreshWork){refreshAgain=true;return refreshWork;}
    refreshWork=(async()=>{
    try{
      sessionList=await core.sessions();
      const link=await sessionsApi();
      const activeTerminal=vscode.window.activeTerminal;
      const activeName=link?.sessionForTerminal(activeTerminal);
      if(manualSelection&&manualSelection.terminal!==activeTerminal)manualSelection=undefined;
      const active=byId(manualSelection?.id)||core.sessionForTerminal(activeTerminal,sessionList,activeName);
      const previous=selected;
      if(active){selected=active.id;lastMappedTerminal=activeTerminal;}
      else if(activeTerminal&&activeTerminal!==lastMappedTerminal)selected=undefined;
      if(selected&&!byId(selected))selected=undefined;
      if(previous!==selected){cleared.delete(previous);followTarget=true;}
      if(!selected&&!vscode.window.activeTerminal&&sessionList.length)selected=sessionList[0].id;
      const session=byId(selected);
      if(session&&sidebar?.visible&&!cleared.has(selected)){
        const {stdout}=await core.run('tmux',['capture-pane','-p','-J','-t',session.pane,'-S','-2000'],{maxBuffer:1024*1024});
        if(vscode.window.activeTerminal!==activeTerminal){refreshAgain=true;return;}
        terminalActivity?.observe(session.id,stdout);
        apps.observe(session,stdout);
        const existing=await core.discoverReferences(stdout,session.cwd,{projectRoot:core.project});
        if(vscode.window.activeTerminal!==activeTerminal){refreshAgain=true;return;}
        const previousFiles=(files[session.id]||[]).map(file=>({...file}));
        await Promise.all(previousFiles.map(async file=>{try{const info=await fs.stat(file.path);file.missing=!info.isFile();file.modified=info.mtimeMs;}catch{file.missing=true;}}));
        if(vscode.window.activeTerminal!==activeTerminal){refreshAgain=true;return;}
        if(!cleared.has(session.id))files[session.id]=core.observe(previousFiles,existing);
      }
      if(session&&!uploadBusy()&&(!draft.targetId||!draft.root||followTarget)){
        const recipient=(!draft.targetId||followTarget)?session:byId(draft.targetId);
        const root=recipient?await core.project(recipient.cwd).catch(()=>undefined):undefined;
        // Project lookup can overlap a new upload or terminal switch.
        if(recipient&&!uploadBusy()&&vscode.window.activeTerminal===activeTerminal){draft.targetId=recipient.id;draft.targetName=recipient.name;draft.root=root;followTarget=false;}
      }
      if(sidebar?.visible)loadResources();
      if(sidebar?.visible||appsPanel?.visible)void apps.refresh(sessionList).then(()=>{renderAppsPanel();publish();}).catch(error=>{status='Web apps: '+error.message;publish();});
      connectionStatus=link?'':'Sessions extension unavailable: previews and Copy still work. Enable Sessions for terminal focus and paste.';
      await save();publish();
    }catch(error){status=error.message;publish();}
    })().finally(()=>{refreshWork=undefined;if(refreshAgain){refreshAgain=false;void refresh();}});
    return refreshWork;
  }
  async function terminal(id){
    const fresh=await core.sessions();
    const session=fresh.find(s=>s.id===id);
    if(!session)throw new Error('The selected agent is closed. Your draft is preserved.');
    const link=await sessionsApi();
    if(!link)throw new Error('Enable Agent Glue Sessions to focus or paste to a terminal. Copy is available.');
    await link.refresh();
    const result=link.terminalForSession(session.sessionName);
    if(!result)throw new Error('No attached terminal matches this session. Your draft is preserved.');
    return result;
  }
  async function discussReview(text){
    await refresh();
    const targetId=selected,activeTerminal=vscode.window.activeTerminal;
    if(!targetId)throw new Error('Select an attached agent terminal before pasting.');
    const request=typeof text==='function'?text(byId(targetId)):text;
    const target=await terminal(targetId);
    if(selected!==targetId||vscode.window.activeTerminal!==activeTerminal)throw new Error('The selected terminal changed. Try the action again.');
    core.paste(target,{text:request,attachments:[]});
  }
  async function preview(file){
    if(!core.supported(file)){await vscode.commands.executeCommand('vscode.open',vscode.Uri.file(file),await mainEditorColumn(vscode));return;}
    let root;
    try{root=await core.project(path.dirname(file));}catch{root=path.dirname(file);}
    await openPreview(vscode,context,file,root,panels);
  }
  async function downloadFile(file){
    if(!(await fs.stat(file)).isFile())throw new Error('Download requires a regular file.');
    await ensureDictation('nativeDownload');
    // Pass a URI, not a path string: VS Code translates it across SSH hosts.
    const result=await vscode.commands.executeCommand('agentGlueMac.downloadFile',vscode.Uri.file(file));
    if(!result)throw new Error('Reload Window to activate native downloads, then try again.');
    status=result.cancelled?'Download cancelled.':'File downloaded to your computer.';
  }
  async function browserFile(file,copy=false,download=false){
    const root=await core.project(path.dirname(file)).catch(()=>path.dirname(file));
    const url=await browserLinks.link(file,root,{download});
    if(copy){await vscode.env.clipboard.writeText(url);status='Browser link copied. Available while this VS Code connection stays open.';}
    else await vscode.env.openExternal(vscode.Uri.parse(url));
  }
  async function layout(){
    const config=vscode.workspace.getConfiguration('workbench');
    const terminalConfig=vscode.workspace.getConfiguration('terminal.integrated');
    const previous=context.globalState.get('layout');
    if(previous){
      await config.update('sideBar.location',previous.sideBar,vscode.ConfigurationTarget.Global);
      await terminalConfig.update('tabs.enabled',previous.tabs,vscode.ConfigurationTarget.Global);
      await context.globalState.update('layout',undefined);
    }else{
      await context.globalState.update('layout',{sideBar:config.inspect('sideBar.location')?.globalValue,tabs:terminalConfig.inspect('tabs.enabled')?.globalValue});
      await config.update('sideBar.location','right',vscode.ConfigurationTarget.Global);
      await terminalConfig.update('tabs.enabled',false,vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand('workbench.view.extension.agentGlue');
  }
  async function openDraft(){
    await refresh();
    if(draftPanel){
      try{draftPanel.reveal(vscode.ViewColumn.Active,false);}catch{views.delete(draftWebview);draftPanel=undefined;draftWebview=undefined;}
    }
    if(!draftPanel){
    draftPanel=vscode.window.createWebviewPanel('agentGlue.draft','Agent Glue — Dictation Draft',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]});
    const panel=draftPanel;
    const webview=panel.webview;
    draftWebview=webview;
    panel.onDidDispose(()=>{
      if(draftPanel===panel){draftPanel=undefined;draftWebview=undefined;}
      views.delete(webview);
    });
    setup(webview,true);
    }
    post(draftWebview,{type:'focusDraft'});

  }
  async function handle(message,view){
    if(!message||typeof message.type!=='string')return;
    if(message.type.startsWith('upload')){
      try{
        if(message.type==='uploadBatchStart'){
          if(!/^[a-zA-Z0-9-]{1,80}$/.test(message.id)||uploadBatches.has(view))throw new Error('An attachment batch is already active.');
          const batch={id:message.id,targetId:message.targetId,ids:new Set(),lastActivity:Date.now()};
          uploadBatches.set(view,batch); // Freeze recipient while its project lookup is pending.
          try{Object.assign(batch,await attachmentRecipient(message.targetId));}
          catch(error){uploadBatches.delete(view);throw error;}
          await view.postMessage({type:'uploadBatchReady',id:message.id});
        }else if(message.type==='uploadBatchEnd'){
          const batch=uploadBatches.get(view);
          if(batch?.id===message.id){for(const id of batch.ids)await uploads.abort(id);uploadBatches.delete(view);}
        }else if(message.type==='uploadAbort'){
          await uploads.abort(message.id);
        }else if(message.type==='uploadStart'){
          if(!draft.targetId||!draft.root)throw new Error('Select an agent in a Git project before uploading.');
          if(!byId(draft.targetId))throw new Error('The draft recipient is unavailable.');
          const batch=uploadBatches.get(view);
          if(message.batchId&&batch?.id!==message.batchId)throw new Error('Attachment batch expired. Choose the files again.');
          if(message.targetId&&message.targetId!==draft.targetId)throw new Error('The draft recipient changed. Choose the file again.');
          if(batch){batch.lastActivity=Date.now();batch.ids.add(message.id);}
          await uploads.start(message,batch?.root||draft.root,batch?.targetId||draft.targetId);
          await view.postMessage({type:'uploadReady',id:message.id});
        }else if(message.type==='uploadChunk'){const batch=uploadBatches.get(view);if(batch)batch.lastActivity=Date.now();await view.postMessage({type:'uploadAck',id:message.id,received:await uploads.chunk(message)});}
        else if(message.type==='uploadFinish'){
          const attachment=await uploads.finish(message.id);
          // Target changes are refused during transfer, so this draft retains ownership.
          draft.attachments.push(attachment);await save();publish();await view.postMessage({type:'uploadComplete',id:message.id});
        }
      }catch(error){if(!['uploadStart','uploadBatchStart'].includes(message.type))await uploads.abort(message.id);await view.postMessage({type:'uploadError',id:message.id,error:error.message});}
      return;
    }
    switch(message.type){
      case 'webApp':await appAction(message.id,message.action);break;
      case 'showWebApps':await showApps();break;
      case 'ready':await refresh();if(message.clientPlatform==='mac')await ensureDictation();publish();if(view===draftWebview)post(view,{type:'focusDraft'});break;
      case 'refresh':cleared.delete(selected);await refresh();loadResources(true);break;
      case 'resourceTab':if(['files','prs','tasks'].includes(message.tab)){resourceTab=message.tab;loadResources();}break;
      case 'prFilter':if(resources.filters[message.filter]!==undefined){prFilter=message.filter;await context.workspaceState.update('prFilter',prFilter);loadResources();}break;
      case 'prSort':if(['title','number','updated','priority'].includes(message.sort)){prSort=message.sort;resourceItems=resources.sortItems(resourceItems,prSort);await context.workspaceState.update('prSort',prSort);}break;
      case 'prReadFilter':if(['all','unread'].includes(message.filter)){prReadFilter=message.filter;await context.workspaceState.update('prReadFilter',prReadFilter);}break;
      case 'markPrRead':{
        const item=resourceItems.find(item=>item.id===message.id);
        if(!item||!resourceRoot||message.generation!==resourceGeneration)break;
        const key=readKey(item);
        if(message.read===true)prRead[key]=new Date().toISOString();else if(message.read===false)delete prRead[key];
        await context.workspaceState.update('prRead',prRead);break;
      }
      case 'expandResource':{
        const item=resourceItems.find(item=>item.id===message.id);if(!item||!resourceRoot||(message.generation!==undefined&&message.generation!==resourceGeneration))break;
        try{const result=await reviewDetail(item,resourceRoot);if(resourceItems.includes(item)){item.reviewDocuments=result.documents;item.reviewError='';}}
        catch(error){if(resourceItems.includes(item))item.reviewError=error.message;}
        break;
      }
      case 'openReviewFile':{
        const item=resourceItems.find(item=>item.id===message.id);const doc=item?.reviewDocuments?.[message.index];if(!doc)break;
        if(doc.isBodyFile)await openPullRequest(vscode,context,item,resourceRoot,panels,{onDiscuss:discussReview});
        else await openReviewDocument(vscode,context,doc,resourceRoot,panels);
        break;
      }
      case 'openResource':{
        const item=resourceItems.find(item=>item.id===message.id);
        if((item?.url||item?.local)&&resourceRoot){
          if(message.external&&item.url)await vscode.env.openExternal(vscode.Uri.parse(item.url));
          else {
            await openPullRequest(vscode,context,item,resourceRoot,panels,{onDiscuss:discussReview});
            prSeen[item.id]=new Date().toISOString();
            await context.workspaceState.update('prSeen',Object.fromEntries(Object.entries(prSeen).sort((a,b)=>b[1].localeCompare(a[1])).slice(0,500)));
            item.newComments=false;
          }
        }else if(item?.path){if(message.external||message.copy)await browserFile(item.path,Boolean(message.copy));else await preview(item.path);}
        break;
      }
      case 'clearFiles':
        if(selected){files[selected]=(files[selected]||[]).filter(file=>file.pinned);cleared.add(selected);}
        break;
      case 'bindTerminalActivity':await bindTerminalActivity(message.uris);break;
      case 'pinFile':await vscode.commands.executeCommand('agentGlue.pin');break;
      case 'selectSession':{
        if(!byId(message.id))throw new Error('Session is no longer available.');
        selected=message.id;followTarget=true;(await terminal(selected)).show();await refresh();break;
      }
      case 'previewFile':{const file=(files[selected]||[]).find(f=>f.id===message.id);if(file)await preview(file.path);break;}
      case 'fileMenu':{
        const file=(files[selected]||[]).find(f=>f.id===message.id);if(!file)break;
        const action=await vscode.window.showQuickPick(['Open','Download','Copy path'],{placeHolder:file.path});
        if(action==='Open')await preview(file.path);
        if(action==='Download')await downloadFile(file.path);
        if(action==='Copy path')await vscode.env.clipboard.writeText(file.path);
        break;
      }
      case 'fileAction':{
        const sessionId=selected;
        const file=(files[sessionId]||[]).find(f=>f.id===message.id);if(!file)break;
        if(message.action==='download')await downloadFile(file.path);
        else if(message.action==='browser'||message.action==='copyLink')await browserFile(file.path,message.action==='copyLink');
        else if(message.action==='describe'&&file.pinned){
          const description=await vscode.window.showInputBox({title:'Pinned file description',prompt:'Optional description shown beneath the filename. Leave empty to clear.',value:file.description||'',validateInput:value=>value.length>500?'Use 500 characters or fewer.':undefined});
          const current=(files[sessionId]||[]).find(f=>f.id===message.id);
          if(current?.pinned&&description!==undefined&&description.length<=500)current.description=description.trim();
        }
        else if(['pin','unpin'].includes(message.action)){file.pinned=message.action==='pin';file.manual=true;}
        files[sessionId]=core.observe(files[sessionId]||[],[]);
        break;
      }
      case 'removeAttachment':draft.attachments=draft.attachments.filter(attachment=>attachment.path!==message.path);break;
      case 'editDraft':if(typeof message.text==='string'&&message.text.length<=1000000)draft.text=message.text;break;
      case 'changeTarget':{
        if(uploadBusy())throw new Error('Wait for the current upload before changing the draft recipient.');
        const target=byId(message.targetId);if(!target)throw new Error('Select an available agent.');
        draft.targetId=target.id;draft.targetName=target.name;draft.root=await core.project(target.cwd).catch(()=>undefined);followTarget=false;break;
      }
      case 'copyDraft':if(typeof message.text==='string')draft.text=message.text;await vscode.env.clipboard.writeText(core.draftText(draft));status='Draft copied.';break;
      case 'pasteDraft':if(typeof message.text==='string')draft.text=message.text;core.paste(await terminal(draft.targetId),draft);status='Draft pasted. Press Enter in the terminal to send.';break;
      case 'importLocalFiles':await importLocalFiles(message);break;
      case 'pasteClipboardImage':{
        if(!draft.targetId||!draft.root||!byId(draft.targetId))throw new Error('Select an agent in a Git project before attaching an image.');
        clipboardBusy=true;
        try{
        await ensureDictation('clipboardImage');
        status='Reading image from your Mac clipboard…';publish();
        const image=await vscode.commands.executeCommand('agentGlueMac.readClipboardImage');
        if(!image||typeof image.data!=='string'||image.data.length>36*1024*1024)throw new Error('The Mac helper returned no usable image.');
        const bytes=Buffer.from(image.data,'base64');
        if(!bytes.length||bytes.length>25*1024*1024||bytes.toString('base64')!==image.data||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('The Mac helper returned an invalid or oversized PNG image.');
        const id=crypto.randomUUID();
        try{
          await uploads.start({id,name:'screenshot.png',size:bytes.length,mime:'image/png'},draft.root,draft.targetId);
          for(let offset=0;offset<bytes.length;offset+=192*1024)await uploads.chunk({id,offset,data:bytes.subarray(offset,offset+192*1024).toString('base64')});
          draft.attachments.push(await uploads.finish(id));
          status='Screenshot attached on the SSH host.';
        }catch(error){await uploads.abort(id);throw error;}
        }finally{clipboardBusy=false;}
        break;
      }
      case 'dictate':{
        await ensureDictation();
        dictationRequest={view,id:crypto.randomUUID()};
        post(view,{type:'dictationReady',id:dictationRequest.id});
        break;
      }
      case 'startDictation':{
        if(dictationRequest?.view!==view||dictationRequest.id!==message.id)break;
        dictationRequest=undefined;
        await vscode.commands.executeCommand('agentGlueMac.startDictation');
        status='';break;
      }
      case 'openDraft':await openDraft();break;
      case 'layout':await layout();break;
    }
    await save();publish();
  }
  function setup(view,isDraft){
    views.add(view);
    view.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'media')]};
    view.html=(isDraft?renderDraft:renderSidebar)({nonce:crypto.randomBytes(20).toString('hex'),cspSource:view.cspSource,scriptUri:view.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media/companion.js')),styleUri:view.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'media/companion.css'))});
    context.subscriptions.push(view.onDidReceiveMessage(message=>{if(message?.type==='setupTasks')return runStatus().catch(error=>{status=error.message;publish();});queue=queue.then(()=>handle(message,view)).catch(async error=>{status=error.message;if(['previewFile','openReviewFile','openResource','fileMenu','fileAction'].includes(message.type))vscode.window.showErrorMessage('Agent Glue: '+error.message);try{await save();}catch{}publish();});return queue;}));
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('agentGlue.companion',{resolveWebviewView(view){sidebar=view;const webview=view.webview;sidebarWebview=webview;setup(webview,false);view.onDidChangeVisibility(()=>{if(view.visible)void refresh();});view.onDidDispose(()=>{if(sidebar===view){sidebar=undefined;sidebarWebview=undefined;}views.delete(webview);});void refresh();}},{webviewOptions:{retainContextWhenHidden:true}}));
  const command=(name,fn)=>context.subscriptions.push(vscode.commands.registerCommand(name,async(...args)=>{try{return await fn(...args);}catch(error){vscode.window.showErrorMessage(error.message);}}));
  command('agentGlue.fork',forkConversation);
  command('agentGlue.webApps',showApps);
  command('agentGlue.showfiles',()=>handle({type:'resourceTab',tab:'files'},sidebarWebview));
  command('agentGlue.showtasks',()=>handle({type:'resourceTab',tab:'tasks'},sidebarWebview));
  command('agentGlue.showprs',()=>handle({type:'resourceTab',tab:'prs'},sidebarWebview));
  command('agentGlue.refreshResources',()=>handle({type:'refresh'},sidebarWebview));
  command('agentGlue.clearFiles',()=>handle({type:'clearFiles'},sidebarWebview));
  command('agentGlue.chooseSession',async()=>{
    await refresh();
    const choice=await vscode.window.showQuickPick(sessionList.map(session=>({label:session.name,description:session.cwd,id:session.id})),{placeHolder:'Choose the agent session whose files you want to see'});
    if(!choice)return;
    manualSelection={id:choice.id,terminal:vscode.window.activeTerminal};
    await refresh();
  });
  command('agentGlue.preview',async uri=>{uri=uri||vscode.window.activeTextEditor?.document.uri;if(!uri){const picked=await vscode.window.showOpenDialog({canSelectMany:false,filters:{Documents:['md','markdown','html','htm']}});uri=picked?.[0];}if(uri)await preview(uri.fsPath);});
  command('agentGlue.pin',async()=>{const picked=await vscode.window.showOpenDialog({canSelectMany:false,canSelectFiles:true,canSelectFolders:false,title:'Pin file',defaultUri:byId(selected)?vscode.Uri.file(byId(selected).cwd):undefined});if(!picked?.[0])return;if(!selected)throw new Error('Select an agent first.');const file=picked[0].fsPath;if(!(await fs.stat(file)).isFile())throw new Error('Choose a regular file to pin.');files[selected]=core.observe(files[selected]||[],[{id:file,path:file,label:path.basename(file),pinned:true}]);const entry=files[selected].find(f=>f.id===file);entry.hidden=false;entry.pinned=true;entry.manual=true;await save();publish();});
  command('agentGlue.installInstructions',async()=>{
    const cwd=byId(selected)?.cwd;
    const selectedRoot=cwd?await core.project(cwd):undefined;
    const folders=vscode.workspace.workspaceFolders||[];
    const folder=selectedRoot?{uri:vscode.Uri.file(selectedRoot)}:folders.length===1?folders[0]:await vscode.window.showWorkspaceFolderPick({placeHolder:'Choose the workspace for Agent Glue instructions'});
    if(!folder)throw new Error('Open or choose a workspace folder first.');
    const results=await require('./instructions.cjs').install(folder.uri.fsPath);
    vscode.window.showInformationMessage(results.join('; '));
  });
  command('agentGlue.dictate',async()=>{
    await vscode.commands.executeCommand('agentGlue.companion.focus');
    if(!sidebarWebview)throw new Error('Agent Glue sidebar is not ready. Try the shortcut again.');
    post(sidebarWebview,{type:'requestDictation'});
  });
  command('agentGlue.draft',openDraft);command('agentGlue.layout',layout);
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(()=>{if(sidebar?.visible)void refresh();}));
  const interval=setInterval(()=>{for(const [view,batch] of uploadBatches)if(Date.now()-batch.lastActivity>120000)uploadBatches.delete(view);void uploads.expire();if(terminalActivity)publish();if(sidebar?.visible||appsPanel?.visible)void refresh();},3000);
  context.subscriptions.push({dispose(){clearInterval(interval);void uploads.close();for(const panel of panels.values())panel.dispose();draftPanel?.dispose();appsPanel?.dispose();}});
  // Reveal the companion on startup without taking keyboard focus from the editor or terminal.
  void vscode.commands.executeCommand('agentGlue.companion.focus',{preserveFocus:true}).catch(error=>{
    vscode.window.showErrorMessage(`Unable to open Agent Glue: ${error.message}`);
  });
}
module.exports={activate};
