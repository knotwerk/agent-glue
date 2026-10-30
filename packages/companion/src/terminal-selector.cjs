'use strict';
// Native terminal controls; lifecycle status is deliberately not inferred here.
function registerSelector(vscode,context,sessionForTerminal=()=>undefined){
 if(!vscode.window.createTreeView)return;
 const changed=new vscode.EventEmitter(),ids=new WeakMap();let nextId=0;
 const mime='application/vnd.code.tree.agentglue.terminalselector';
 let saved=context.workspaceState?.get('terminalSelector.order',[])||[],ordered=[],dragged=[],restoredSessions=false;
 const isOpen=terminal=>vscode.window.terminals.includes(terminal);
 const locationKey=location=>location===2||(location&&typeof location==='object'&&'viewColumn' in location)?'editor':'panel';
 const identity=terminal=>{
  const session=sessionForTerminal(terminal);if(session)return 'tmux:'+session;
  const options=terminal.creationOptions||{};
  const base=JSON.stringify([terminal.name,String(options.cwd||''),options.shellPath||'',locationKey(options.location)]);
  const peers=vscode.window.terminals.filter(t=>!sessionForTerminal(t)&&JSON.stringify([t.name,String(t.creationOptions?.cwd||''),t.creationOptions?.shellPath||'',locationKey(t.creationOptions?.location)])===base);
  return 'terminal:'+base+':'+peers.indexOf(terminal);
 };
 const children=()=>{
  const terminals=[...vscode.window.terminals];
  const restoreSessions=!restoredSessions&&terminals.some(t=>sessionForTerminal(t));
  if(restoreSessions)restoredSessions=true;
  if(!ordered.length||restoreSessions)ordered=terminals.slice().sort((a,b)=>{const ai=saved.indexOf(identity(a)),bi=saved.indexOf(identity(b));return (ai<0?Infinity:ai)-(bi<0?Infinity:bi);});
  else ordered=ordered.filter(isOpen).concat(terminals.filter(t=>!ordered.includes(t)));
  return ordered;
 };
 const provider={onDidChangeTreeData:changed.event,getChildren:children,
  getTreeItem(terminal){
   if(!ids.has(terminal))ids.set(terminal,String(++nextId));
   const selected=terminal===vscode.window.activeTerminal,location=terminal.creationOptions?.location;
   const editor=location===2||Boolean(location&&typeof location==='object'&&'viewColumn' in location);
   const same=vscode.window.terminals.filter(t=>t.name===terminal.name);
   const description=[editor?'Editor':'',same.length>1?'Tab '+(same.indexOf(terminal)+1):''].filter(Boolean).join(' · ');
   return {id:ids.get(terminal),label:terminal.name,description:description||undefined,contextValue:sessionForTerminal(terminal)?'agentGlueAgentTerminal':'agentGlueTerminal',
    iconPath:new vscode.ThemeIcon('terminal'),
    tooltip:terminal.name+' — '+(selected?'selected terminal':'click to focus')+'\n'+(sessionForTerminal(terminal)||'Shell terminal')+'\nActivity status is not connected yet.',
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
 let lastSignature;
 const refresh=()=>{const signature=vscode.window.terminals.map(t=>{if(!ids.has(t))ids.set(t,String(++nextId));return [ids.get(t),t.name,sessionForTerminal(t),t===vscode.window.activeTerminal].join('|');}).join('\n');if(signature===lastSignature)return;lastSignature=signature;changed.fire();const terminal=vscode.window.activeTerminal;if(tree.visible&&terminal)void Promise.resolve(tree.reveal(terminal,{select:true,focus:false})).catch(()=>{});};
 context.subscriptions.push(changed,tree,
  vscode.commands.registerCommand('agentGlue.focusSelectorTerminal',terminal=>{if(isOpen(terminal))terminal.show(false);}),
  vscode.commands.registerCommand('agentGlue.splitSelectorTerminal',terminal=>{
   if(!isOpen(terminal))return;
   const cwd=terminal.shellIntegration?.cwd||terminal.creationOptions?.cwd;
   vscode.window.createTerminal({location:{parentTerminal:terminal},...(cwd?{cwd}:{})}).show(false);
  }),
  vscode.commands.registerCommand('agentGlue.tryTerminalSelector',async()=>{
   try{
    await vscode.commands.executeCommand('vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.panel.terminal'});
    await vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
   }catch{
    await vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
    await vscode.window.showInformationMessage('Automatic placement is unavailable. Use the Terminals view menu → Move View → Terminal to try the layout.');
   }
  }),
  vscode.commands.registerCommand('agentGlue.resetTerminalSelector',async()=>{
   await vscode.commands.executeCommand('vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.view.extension.agentGlueSelector'});
  }));
 for(const event of ['onDidOpenTerminal','onDidCloseTerminal','onDidChangeActiveTerminal','onDidChangeTerminalState'])if(vscode.window[event])context.subscriptions.push(vscode.window[event](refresh));
 context.subscriptions.push(tree.onDidChangeVisibility(refresh));
 return {provider,refresh,dragAndDropController};
}
module.exports={registerSelector};
