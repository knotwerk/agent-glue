'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSelector}=require('../src/terminal-selector.cjs');
function host(){
 const commands=new Map(),events={},calls=[],shown=[],reveals=[];
 const a={name:'Same',show:focus=>shown.push(['a',focus])},b={name:'Same',show:focus=>shown.push(['b',focus])};
 const disposable=()=>({dispose(){}});
 const tree={visible:true,reveal:async(...args)=>reveals.push(args),onDidChangeVisibility:fn=>{events.visibility=fn;return disposable();},dispose(){}};
 const vscode={EventEmitter:class{event=()=>{};fire(){}dispose(){}},ThemeIcon:class{constructor(id){this.id=id;}},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return disposable();},executeCommand:async(...args)=>calls.push(args)},window:{terminals:[a,b],activeTerminal:a,createTreeView:()=>tree,showInformationMessage:async()=>{}}};
 for(const event of ['onDidOpenTerminal','onDidCloseTerminal','onDidChangeActiveTerminal','onDidChangeTerminalState'])vscode.window[event]=fn=>{events[event]=fn;return disposable();};
 const selector=registerSelector(vscode,{subscriptions:[]});return {vscode,selector,commands,calls,shown,reveals,a,b};
}
test('selector identifies duplicate names by terminal identity and never focuses a closed tab',()=>{
 const h=host(),p=h.selector.provider;assert.notEqual(p.getTreeItem(h.a).id,p.getTreeItem(h.b).id);
 assert.equal(p.getTreeItem(h.a).description,'Selected');assert.match(p.getTreeItem(h.a).tooltip,/not connected/);
 const item=p.getTreeItem(h.b);h.commands.get(item.command.command)(...item.command.arguments);assert.deepEqual(h.shown,[['b',false]]);
 h.vscode.window.terminals=[h.a];h.commands.get(item.command.command)(...item.command.arguments);assert.equal(h.shown.length,1);
});
test('selector placement is explicit and reversible; refresh never steals terminal focus',async()=>{
 const h=host();assert.deepEqual(h.calls,[]);h.selector.refresh();assert.deepEqual(h.shown,[]);assert.equal(h.reveals[0][1].focus,false);
 await h.commands.get('agentGlue.tryTerminalSelector')();assert.deepEqual(h.calls[0],['vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.panel.terminal'}]);
 await h.commands.get('agentGlue.resetTerminalSelector')();assert.equal(h.calls.at(-1)[1].destinationId,'workbench.view.extension.agentGlueSelector');
});
