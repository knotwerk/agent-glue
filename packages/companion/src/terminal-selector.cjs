'use strict';
const path=require('node:path');
// Native terminal controls; lifecycle status is deliberately not inferred here.
function registerSelector(vscode,context,sessionForTerminal=()=>undefined,statusForSession=()=>({status:'unknown',label:'No lifecycle events yet'})){
 if(!vscode.window.createTreeView)return;
 const changed=new vscode.EventEmitter(),ids=new WeakMap();let nextId=0;
 const mime='application/vnd.code.tree.agentglue.terminalselector';
 let saved=context.workspaceState?.get('terminalSelector.order',[])||[],ordered=[],dragged=[],restoredSessions=false;
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
 const children=()=>{
  const terminals=listed();
  const restoreSessions=!restoredSessions&&terminals.some(t=>sessionForTerminal(t));
  if(restoreSessions)restoredSessions=true;
  if(!ordered.length||restoreSessions)ordered=terminals.slice().sort((a,b)=>{const ai=saved.indexOf(identity(a)),bi=saved.indexOf(identity(b));return (ai<0?Infinity:ai)-(bi<0?Infinity:bi);});
  else ordered=ordered.filter(isOpen).concat(terminals.filter(t=>!ordered.includes(t)));
  return ordered;
 };
 const status=terminal=>sessionForTerminal(terminal)?statusForSession(sessionForTerminal(terminal)):undefined;
 const statusIcon=state=>{const color=({active:'amber',blocked:'red',done:'green'})[state.status]||'grey';const media=path.join(context.extensionPath||path.resolve(__dirname,'..'),'media');return {light:vscode.Uri.file(path.join(media,'status-'+color+'-light.svg')),dark:vscode.Uri.file(path.join(media,'status-'+color+'-dark.svg'))};};
 const provider={onDidChangeTreeData:changed.event,getChildren:children,
  getTreeItem(terminal){
   if(!ids.has(terminal))ids.set(terminal,String(++nextId));
   const selected=terminal===vscode.window.activeTerminal,location=terminal.creationOptions?.location;
   const editor=location===2||Boolean(location&&typeof location==='object'&&'viewColumn' in location);
   const same=listed().filter(t=>t.name===terminal.name);
   const state=status(terminal),now=Date.now();
   const age=at=>{const seconds=Math.max(0,Math.floor((now-at)/1000));return seconds<60?seconds+'s':Math.floor(seconds/60)+'m';};
   const label=state?({active:'Working',blocked:'Needs input',done:'Finished',idle:'Idle',unknown:state.at?'Status stale':'No status'})[state.status]:'';
   const elapsed=state?.status==='active'&&state.since?age(state.since):state?.at?age(state.at)+' ago':'';
   const description=[label,elapsed,editor?'Editor':'',same.length>1?'Tab '+(same.indexOf(terminal)+1):''].filter(Boolean).join(' · ');
   return {id:ids.get(terminal),label:terminal.name,description:description||undefined,contextValue:sessionForTerminal(terminal)?'agentGlueAgentTerminal':'agentGlueTerminal',
    iconPath:state?statusIcon(state):new vscode.ThemeIcon('terminal'),
    tooltip:terminal.name+' — '+(selected?'selected terminal':'click to focus')+'\n'+(sessionForTerminal(terminal)||'Shell terminal')+'\n'+(state?state.label+(state.at?' · '+new Date(state.at).toLocaleTimeString():''):'Shell terminal'),
    command:{command:'agentGlue.focusSelectorTerminal',title:'Focus terminal',arguments:[terminal]}};
  },getParent:()=>undefined};
 const dragAndDropController={dragMimeTypes:[mime],dropMimeTypes:[mime],
  handleDrag(source,transfer){dragged=source.filter(isOpen);transfer.set(mime,new vscode.DataTransferItem('terminals'));},
  async handleDrop(target,transfer){
   if(!transfer.get(mime)||!dragged.length)return;
   const moving=dragged.filter(isOpen);dragged=[];if(!moving.length||moving.includes(target))return;
   const rest=children().filter(t=>!moving.includes(t)),index=target?rest.indexOf(target):rest.length;
   if(index<0)return;rest.splice(index,0,...moving);ordered=rest;restoredSessions=true;saved=ordered.map(identity);
   await context.workspaceState?.update('terminalSelector.order',saved);changed.fire();
  }};
 const tree=vscode.window.createTreeView('agentGlue.terminalSelector',{treeDataProvider:provider,showCollapseAll:false,dragAndDropController});
 let lastSignature,lastSelected;
 const refresh=()=>{const signature=listed().map(t=>{if(!ids.has(t))ids.set(t,String(++nextId));return [ids.get(t),t.name,sessionForTerminal(t),t===vscode.window.activeTerminal,JSON.stringify(status(t)),status(t)?.at||status(t)?.since?Math.floor(Date.now()/3000):''].join('|');}).join('\n');if(signature===lastSignature)return;lastSignature=signature;changed.fire();const terminal=vscode.window.activeTerminal,selectionChanged=terminal!==lastSelected;lastSelected=terminal;if(selectionChanged&&tree.visible&&terminal&&isOpen(terminal))void Promise.resolve(tree.reveal(terminal,{select:true,focus:false})).catch(()=>{});};
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
  vscode.commands.registerCommand('agentGlue.focusSelectorTerminal',terminal=>{if(isOpen(terminal))terminal.show(false);}),
  vscode.commands.registerCommand('agentGlue.splitSelectorTerminal',terminal=>{
   if(!isOpen(terminal))return;
   const cwd=terminal.shellIntegration?.cwd||terminal.creationOptions?.cwd;
   vscode.window.createTerminal({location:{parentTerminal:terminal},...(cwd?{cwd}:{})}).show(false);
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
 for(const event of ['onDidOpenTerminal','onDidCloseTerminal','onDidChangeActiveTerminal','onDidChangeTerminalState'])if(vscode.window[event])context.subscriptions.push(vscode.window[event](refresh));
 context.subscriptions.push(tree.onDidChangeVisibility(()=>{refresh();hideSafely();}));
 return {provider,refresh,dragAndDropController,get visible(){return tree.visible;}};
}
module.exports={registerSelector};
