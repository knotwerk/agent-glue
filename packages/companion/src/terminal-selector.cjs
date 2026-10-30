'use strict';
// Layout prototype only: no tmux discovery, capture, status guessing or polling.
function registerSelector(vscode,context){
 if(!vscode.window.createTreeView)return;
 const changed=new vscode.EventEmitter(),ids=new WeakMap();let nextId=0;
 const provider={onDidChangeTreeData:changed.event,
  getChildren:()=>[...vscode.window.terminals],
  getTreeItem(terminal){
   if(!ids.has(terminal))ids.set(terminal,String(++nextId));
   const selected=terminal===vscode.window.activeTerminal;
   return {id:ids.get(terminal),label:terminal.name,description:selected?'Selected':'',
    iconPath:new vscode.ThemeIcon(selected?'terminal':'circle-outline'),
    tooltip:terminal.name+' — '+(selected?'selected terminal':'click to focus')+'\nLifecycle status is not connected in this layout prototype.',
    command:{command:'agentGlue.focusSelectorTerminal',title:'Focus terminal',arguments:[terminal]}};
  },getParent:()=>undefined};
 const tree=vscode.window.createTreeView('agentGlue.terminalSelector',{treeDataProvider:provider,showCollapseAll:false});
 tree.message='Layout prototype · activity status not connected';
 const refresh=()=>{changed.fire();const terminal=vscode.window.activeTerminal;if(tree.visible&&terminal)void Promise.resolve(tree.reveal(terminal,{select:true,focus:false})).catch(()=>{});};
 context.subscriptions.push(changed,tree,
  vscode.commands.registerCommand('agentGlue.focusSelectorTerminal',terminal=>{
   if(vscode.window.terminals.includes(terminal))terminal.show(false);
  }),
  vscode.commands.registerCommand('agentGlue.tryTerminalSelector',async()=>{
   try{
    await vscode.commands.executeCommand('vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.panel.terminal'});
    await vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
   }catch{
    await vscode.commands.executeCommand('agentGlue.terminalSelector.focus');
    await vscode.window.showInformationMessage('Automatic placement is unavailable. Use the Terminal Selector view menu → Move View → Terminal to try the layout.');
   }
  }),
  vscode.commands.registerCommand('agentGlue.resetTerminalSelector',async()=>{
   await vscode.commands.executeCommand('vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.view.extension.agentGlueSelector'});
  }));
 for(const event of ['onDidOpenTerminal','onDidCloseTerminal','onDidChangeActiveTerminal','onDidChangeTerminalState'])if(vscode.window[event])context.subscriptions.push(vscode.window[event](refresh));
 context.subscriptions.push(tree.onDidChangeVisibility(refresh));
 return {provider,refresh};
}
module.exports={registerSelector};
