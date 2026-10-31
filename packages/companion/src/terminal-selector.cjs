'use strict';
const path=require('node:path');
// Native terminal controls; lifecycle status is deliberately not inferred here.
function registerSelector(vscode,context,sessionForTerminal=()=>undefined,statusForSession=()=>({status:'unknown',label:'No lifecycle events yet'}),cwdForTerminal=terminal=>terminal.shellIntegration?.cwd||terminal.creationOptions?.cwd){
 if(!vscode.window.createTreeView)return;
 let providerReady=false;
 void Promise.resolve(vscode.commands.executeCommand('setContext','agentGlue.terminalsReady',false)).catch(()=>{});
 const changed=new vscode.EventEmitter(),ids=new WeakMap();let nextId=0;
 const mime='application/vnd.code.tree.agentglue.terminalselector';
 let saved=context.workspaceState?.get('terminalSelector.order',[])||[],ordered=[],dragged=[],restoredSessions=false;
 let savedGroups=context.workspaceState?.get('terminalSelector.groups',[])||[];
 const parents=new Map(),detached=new WeakSet(),pending=new WeakSet();
 const detachedIds=new Set(context.workspaceState?.get('terminalSelector.detached',[])||[]);
 const listed=()=>vscode.window.terminals.filter(t=>!t.creationOptions?.hideFromUser);
 const isOpen=terminal=>listed().includes(terminal);
 const locationKey=location=>location===2||(location&&typeof location==='object'&&'viewColumn' in location)?'editor':'panel';
 const identity=terminal=>{
  const session=sessionForTerminal(terminal);if(session)return 'tmux:'+session;
  const options=terminal.creationOptions||{};
  const base=JSON.stringify([terminal.name,String(options.cwd||''),options.shellPath||'',locationKey(options.location)]);
  const peers=listed().filter(t=>!sessionForTerminal(t)&&JSON.stringify([t.name,String(t.creationOptions?.cwd||''),t.creationOptions?.shellPath||'',locationKey(t.creationOptions?.location)])===base);
  return 'terminal:'+base+':'+peers.indexOf(terminal);
 };
 const flatChildren=()=>{
  const terminals=listed();
  const restoreSessions=!restoredSessions&&terminals.some(t=>sessionForTerminal(t));
  if(restoreSessions)restoredSessions=true;
  if(!ordered.length||restoreSessions)ordered=terminals.slice().sort((a,b)=>{const ai=saved.indexOf(identity(a)),bi=saved.indexOf(identity(b));return (ai<0?Infinity:ai)-(bi<0?Infinity:bi);});
  else ordered=ordered.filter(isOpen).concat(terminals.filter(t=>!ordered.includes(t)));
  return ordered;
 };
 const children=parent=>{
  const flat=flatChildren();
  for(const [child,root] of parents)if((!isOpen(child)&&!pending.has(child))||!isOpen(root))parents.delete(child);
  for(const terminal of flat){
   const root=terminal.creationOptions?.location?.parentTerminal;
   if(root&&isOpen(root)&&root!==terminal&&!detached.has(terminal)&&!detachedIds.has(identity(terminal)))parents.set(terminal,parents.get(root)||root);
  }
  const byIdentity=new Map(flat.map(t=>[identity(t),t]));
  for(const [rootId,childId] of savedGroups){const root=byIdentity.get(rootId),child=byIdentity.get(childId);if(root&&child&&root!==child&&!detached.has(child)&&!detachedIds.has(childId))parents.set(child,root);}
  return flat.filter(t=>parent?parents.get(t)===parent:!parents.has(t));
 };
 const markDetached=terminal=>{detached.add(terminal);detachedIds.add(identity(terminal));};
 const saveGroups=async()=>{savedGroups=[...parents].filter(([child,root])=>isOpen(child)&&isOpen(root)).map(([child,root])=>[identity(root),identity(child)]);await context.workspaceState?.update('terminalSelector.groups',savedGroups);await context.workspaceState?.update('terminalSelector.detached',[...detachedIds]);};
 async function selectTerminal(terminal){
  if(!isOpen(terminal))return false;
  const selected=await new Promise(resolve=>{
   let done=false,listener,timer;
   const finish=value=>{if(done)return;done=true;listener?.dispose();clearTimeout(timer);resolve(value);};
   listener=vscode.window.onDidChangeActiveTerminal(active=>{if(active===terminal)finish(true);});
   timer=setTimeout(()=>finish(false),1500);terminal.show(false);if(vscode.window.activeTerminal===terminal)finish(true);
  });
  return selected&&isOpen(terminal)&&vscode.window.activeTerminal===terminal;
 }
 async function moveToOwnTerminal(terminal){
  children();const root=parents.get(terminal),siblings=children(terminal);
  if(!root&&!siblings.length)return false;
  if(!await selectTerminal(terminal))return false;
  await vscode.commands.executeCommand('workbench.action.terminal.unsplit');
  markDetached(terminal);parents.delete(terminal);
  if(!root&&siblings.length){const [next,...rest]=siblings;parents.delete(next);markDetached(next);for(const child of rest){parents.set(child,next);detached.add(child);}}
  await saveGroups();changed.fire();refresh();return true;
 }
 const status=terminal=>sessionForTerminal(terminal)?statusForSession(sessionForTerminal(terminal)):undefined;
 const readCompletions={...context.workspaceState?.get('terminalSelector.readCompletions',{})};
 const unread=terminal=>{const state=status(terminal);return state?.status==='done'&&Number.isFinite(state.at)&&readCompletions[sessionForTerminal(terminal)]!==state.at;};
 let readTimer;
 const scheduleRead=terminal=>{
  clearTimeout(readTimer);if(!isOpen(terminal)||!unread(terminal))return;
  const name=sessionForTerminal(terminal),at=status(terminal).at;
  readTimer=setTimeout(()=>{
   if(!isOpen(terminal)||vscode.window.activeTerminal!==terminal||sessionForTerminal(terminal)!==name||status(terminal)?.status!=='done'||status(terminal).at!==at)return;
   readCompletions[name]=at;void context.workspaceState?.update('terminalSelector.readCompletions',{...readCompletions});changed.fire(terminal);
  },2000);
 };
 const statusIcon=(state,fresh)=>{const color=({active:'amber',blocked:'red',done:fresh?'green-new':'green'})[state.status]||'grey';const media=path.join(context.extensionPath||path.resolve(__dirname,'..'),'media');return {light:vscode.Uri.file(path.join(media,'status-'+color+'-light.svg')),dark:vscode.Uri.file(path.join(media,'status-'+color+'-dark.svg'))};};
 const provider={onDidChangeTreeData:changed.event,getChildren(parent){
   // VS Code has requested real provider data. Until this point, the manifest's
   // welcome content replaces its misleading "no data provider" startup message.
   if(!providerReady){providerReady=true;void Promise.resolve(vscode.commands.executeCommand('setContext','agentGlue.terminalsReady',true)).catch(()=>{});}
   return children(parent);
  },
  getTreeItem(terminal){
   if(!ids.has(terminal))ids.set(terminal,String(++nextId));
   const location=terminal.creationOptions?.location;
   const editor=location===2||Boolean(location&&typeof location==='object'&&'viewColumn' in location);
   const same=listed().filter(t=>t.name===terminal.name);
   const state=status(terminal),now=Date.now();
   const age=at=>{const minutes=Math.max(0,Math.floor((now-at)/60000));return minutes<1?'<1m':minutes+'m';};
   const elapsed=state?.status==='active'?(state.since?age(state.since):''):state?.at?age(state.at)+' ago':'';
   const description=[elapsed,editor?'Editor':'',same.length>1?'Tab '+(same.indexOf(terminal)+1):''].filter(Boolean).join(' · ');
   const group=children(terminal).length>0,split=parents.has(terminal),agent=Boolean(sessionForTerminal(terminal));
   const contextValue=agent?(group?'agentGlueAgentGroupTerminal':split?'agentGlueAgentSplitTerminal':'agentGlueAgentTerminal'):(group?'agentGlueGroupTerminal':split?'agentGlueSplitTerminal':'agentGlueTerminal');
   return {id:ids.get(terminal),label:terminal.name,description:description||undefined,contextValue,collapsibleState:group?2:0,
    iconPath:state?statusIcon(state,unread(terminal)):new vscode.ThemeIcon('terminal'),
    command:{command:'agentGlue.focusSelectorTerminal',title:'Focus terminal',arguments:[terminal]}};
  },
  async resolveTreeItem(item,terminal,token){
   // Resolve the folder only on hover. Do not query tmux for every row/timer tick.
   let cwd=terminal.shellIntegration?.cwd||terminal.creationOptions?.cwd;
   try{cwd=await cwdForTerminal(terminal)||cwd;}catch{}
   if(token?.isCancellationRequested||!isOpen(terminal))return item;
   const folder=typeof cwd==='string'?cwd:cwd?.fsPath;
   const state=status(terminal),elapsed=provider.getTreeItem(terminal).description;
   item.tooltip=terminal.name+' — '+(terminal===vscode.window.activeTerminal?'selected terminal':'click to focus')+'\n'+(sessionForTerminal(terminal)||'Shell terminal')+(folder?'\nFolder: '+folder:'')+'\n'+(state?state.label+(elapsed?' · '+elapsed:'')+(state.at?' · '+new Date(state.at).toLocaleTimeString():''):'Shell terminal')+(unread(terminal)?'\nNew completion — open this terminal to mark read':'');
   return item;
  },getParent:terminal=>{children();return parents.get(terminal);}};
 const dragAndDropController={dragMimeTypes:[mime],dropMimeTypes:[mime],
  handleDrag(source,transfer){dragged=source.filter(isOpen);transfer.set(mime,new vscode.DataTransferItem('terminals'));},
  async handleDrop(target,transfer){
   if(!transfer.get(mime)||!dragged.length)return;
   let moving=dragged.filter(isOpen);dragged=[];if(!moving.length||moving.includes(target))return;
   children();for(const terminal of moving){const root=parents.get(terminal);if(root&&target!==root&&parents.get(target)!==root){if(!await moveToOwnTerminal(terminal))return;}}
   moving=[...new Set(moving.flatMap(t=>[t,...children(t)]))];
   const rest=flatChildren().filter(t=>!moving.includes(t)),index=target?rest.indexOf(target):rest.length;
   if(index<0)return;rest.splice(index,0,...moving);ordered=rest;restoredSessions=true;saved=ordered.map(identity);
   await context.workspaceState?.update('terminalSelector.order',saved);changed.fire();
  }};
 const tree=vscode.window.createTreeView('agentGlue.terminalSelector',{treeDataProvider:provider,showCollapseAll:false,dragAndDropController});
 let lastStructure,lastSelected,rowSignatures=new Map();
 const refresh=()=>{
  const terminals=listed(),next=new Map();children();
  for(const terminal of terminals){
   const item=provider.getTreeItem(terminal);
   // Heartbeat timestamps and hover-only details do not change a visible row.
   // Refreshing the entire tree every three seconds dismisses VS Code hovers.
   next.set(terminal,JSON.stringify([item.label,item.description,item.iconPath,item.contextValue,item.collapsibleState,sessionForTerminal(terminal)]));
  }
  const structure=terminals.map(t=>[ids.get(t),ids.get(parents.get(t))].join(':')).join('|');
  if(structure!==lastStructure){lastStructure=structure;changed.fire();}
  else for(const terminal of terminals)if(next.get(terminal)!==rowSignatures.get(terminal))changed.fire(terminal);
  rowSignatures=next;
  const terminal=vscode.window.activeTerminal,selectionChanged=terminal!==lastSelected;lastSelected=terminal;
  if(selectionChanged&&tree.visible&&terminal&&isOpen(terminal))void Promise.resolve(tree.reveal(terminal,{select:true,focus:false})).catch(()=>{});
 };
 const settingKey='terminalSelector.nativeTabs';
 let replaceNative=context.workspaceState?.get('terminalSelector.replaceNative',true)??true;
 async function hideNative(){
  if(!replaceNative||!vscode.workspace?.getConfiguration)return;
  const config=vscode.workspace.getConfiguration('terminal.integrated'),info=config.inspect('tabs.enabled');
  if(!context.workspaceState.get(settingKey))await context.workspaceState.update(settingKey,{target:info?.workspaceValue!==undefined?2:1,value:info?.workspaceValue??info?.globalValue});
  const prior=context.workspaceState.get(settingKey);await config.update('tabs.enabled',false,prior.target);
 }
 async function restoreNative(){
  const prior=context.workspaceState?.get(settingKey);if(!prior)return;
  const config=vscode.workspace.getConfiguration('terminal.integrated');
  const info=config.inspect('tabs.enabled'),current=prior.target===2?info.workspaceValue:info.globalValue;
  if(current===false)await config.update('tabs.enabled',prior.value,prior.target);
  await context.workspaceState.update(settingKey,undefined);
 }
 const hideSafely=()=>{if(tree.visible)void hideNative().catch(()=>{});};
 hideSafely();
 context.subscriptions.push(changed,tree,
  vscode.commands.registerCommand('agentGlue.newSelectorTerminal',()=>vscode.commands.executeCommand('workbench.action.terminal.newWithProfile')),
  vscode.commands.registerCommand('agentGlue.focusSelectorTerminal',terminal=>{if(isOpen(terminal)){terminal.show(false);scheduleRead(terminal);}}),
  vscode.commands.registerCommand('agentGlue.markSelectorUnread',async terminal=>{
   if(!isOpen(terminal)||status(terminal)?.status!=='done')return;
   clearTimeout(readTimer);delete readCompletions[sessionForTerminal(terminal)];
   await context.workspaceState?.update('terminalSelector.readCompletions',{...readCompletions});changed.fire(terminal);
  }),
  vscode.commands.registerCommand('agentGlue.newSelectorShell',async terminal=>{
   if(!isOpen(terminal))return;
   const cwd=await cwdForTerminal(terminal);if(!isOpen(terminal))return;
   vscode.window.createTerminal({name:'zsh',shellPath:'zsh',...(cwd?{cwd}:{})}).show(false);
  }),
  vscode.commands.registerCommand('agentGlue.renameSelectorTerminal',async terminal=>{
   if(!isOpen(terminal))return;
   // Own the selector's name prompt, then confirm the clicked terminal is
   // active before applying the name through the native RenameWithArgs command.
   const name=await vscode.window.showInputBox({title:'Rename Terminal',value:terminal.name,prompt:'Choose a name for this terminal',validateInput:value=>value.trim()?undefined:'Enter a terminal name.'});
   if(name===undefined||!name.trim())return;
   if(!await selectTerminal(terminal))return;
   await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg',{name:name.trim()});refresh();
  }),
  vscode.commands.registerCommand('agentGlue.moveSelectorTerminal',moveToOwnTerminal),
  vscode.commands.registerCommand('agentGlue.splitSelectorTerminal',async terminal=>{
   if(!isOpen(terminal))return;
   const cwd=await cwdForTerminal(terminal);if(!isOpen(terminal))return;
   const split=vscode.window.createTerminal({name:'zsh',shellPath:'zsh',location:{parentTerminal:terminal},...(cwd?{cwd}:{})});
   pending.add(split);parents.set(split,parents.get(terminal)||terminal);split.show(false);await saveGroups();refresh();
  }),
  vscode.commands.registerCommand('agentGlue.tryTerminalSelector',async()=>{
   replaceNative=true;await context.workspaceState?.update('terminalSelector.replaceNative',true);
   try{
    await vscode.commands.executeCommand('vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.panel.terminal'});
    await vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
    await hideNative();
   }catch{
    await vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
    await hideNative();
    await vscode.window.showInformationMessage('Automatic placement is unavailable. Use the Terminals view menu → Move View → Terminal to try the layout.');
   }
  }),
  vscode.commands.registerCommand('agentGlue.resetTerminalSelector',async()=>{
   replaceNative=false;await context.workspaceState?.update('terminalSelector.replaceNative',false);
   await vscode.commands.executeCommand('vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.view.extension.agentGlueSelector'});
   await restoreNative();
  }));
 if(vscode.window.onDidOpenTerminal)context.subscriptions.push(vscode.window.onDidOpenTerminal(terminal=>{const wasPending=pending.has(terminal);pending.delete(terminal);children();if(wasPending)void saveGroups();refresh();}));
 if(vscode.window.onDidCloseTerminal)context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal=>{
  const siblings=[...parents].filter(([child,root])=>root===terminal&&isOpen(child)).map(([child])=>child);
  parents.delete(terminal);if(siblings.length){const [next,...rest]=siblings;parents.delete(next);markDetached(next);for(const child of rest){parents.set(child,next);detached.add(child);}}
  children();void saveGroups();refresh();
 }));
 if(vscode.window.onDidChangeActiveTerminal)context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(terminal=>{scheduleRead(terminal);refresh();}));
 if(vscode.window.onDidChangeTerminalState)context.subscriptions.push(vscode.window.onDidChangeTerminalState(refresh));
 context.subscriptions.push({dispose(){clearTimeout(readTimer);}});
 context.subscriptions.push(tree.onDidChangeVisibility(()=>{refresh();hideSafely();}));
 return {provider,refresh,dragAndDropController,get visible(){return tree.visible;}};
}
module.exports={registerSelector};
