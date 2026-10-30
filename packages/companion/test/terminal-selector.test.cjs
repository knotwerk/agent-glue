'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerSelector}=require('../src/terminal-selector.cjs');
function host(){
 const commands=new Map(),events={},calls=[],shown=[],reveals=[];
 const a={name:'Same',show:focus=>shown.push(['a',focus])},b={name:'Same',show:focus=>shown.push(['b',focus])};
 const disposable=()=>({dispose(){}});
 const tree={visible:true,reveal:async(...args)=>reveals.push(args),onDidChangeVisibility:fn=>{events.visibility=fn;return disposable();},dispose(){}};
 const vscode={Uri:{file:fsPath=>({fsPath})},EventEmitter:class{event=()=>{};fire(){}dispose(){}},ThemeColor:class{constructor(id){this.id=id;}},ThemeIcon:class{constructor(id,color){this.id=id;this.color=color;}},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return disposable();},executeCommand:async(...args)=>calls.push(args)},window:{terminals:[a,b],activeTerminal:a,createTreeView:()=>tree,showInformationMessage:async()=>{}}};
 for(const event of ['onDidOpenTerminal','onDidCloseTerminal','onDidChangeActiveTerminal','onDidChangeTerminalState'])vscode.window[event]=fn=>{events[event]=fn;return disposable();};
 const values=new Map();vscode.DataTransferItem=class {constructor(value){this.value=value;}};
 const context={subscriptions:[],workspaceState:{get:(k,d)=>values.get(k)||d,update:async(k,v)=>values.set(k,v)}};
 const selector=registerSelector(vscode,context,t=>t===a?'claude-a':'codex-b');return {vscode,selector,commands,calls,shown,reveals,a,b,context,values};
}
test('selector identifies duplicate names by terminal identity and never focuses a closed tab',()=>{
 const h=host(),p=h.selector.provider;assert.notEqual(p.getTreeItem(h.a).id,p.getTreeItem(h.b).id);
 assert.equal(p.getTreeItem(h.a).description,'No status · Tab 1');assert.match(p.getTreeItem(h.a).iconPath.dark.fsPath,/status-grey-dark.svg$/);assert.match(p.getTreeItem(h.b).iconPath.dark.fsPath,/status-grey-dark.svg$/);assert.match(p.getTreeItem(h.a).tooltip,/No lifecycle events/);
 const item=p.getTreeItem(h.b);h.commands.get(item.command.command)(...item.command.arguments);assert.deepEqual(h.shown,[['b',false]]);
 h.vscode.window.terminals=[h.a];h.commands.get(item.command.command)(...item.command.arguments);assert.equal(h.shown.length,1);
});
test('selector placement is explicit and reversible; refresh never steals terminal focus',async()=>{
 const h=host();assert.deepEqual(h.calls,[]);h.selector.refresh();assert.deepEqual(h.shown,[]);assert.equal(h.reveals[0][1].focus,false);
 await h.commands.get('agentGlue.tryTerminalSelector')();assert.deepEqual(h.calls[0],['vscode.moveViews',{viewIds:['agentGlue.terminalSelector'],destinationId:'workbench.panel.terminal'}]);
 await h.commands.get('agentGlue.resetTerminalSelector')();assert.equal(h.calls.at(-1)[1].destinationId,'workbench.view.extension.agentGlueSelector');
});

 test('row controls target exact objects and preserve order across registration',async()=>{
 const h=host();let split;
 h.vscode.window.createTerminal=options=>{split=options;return {show(){}};};
 h.commands.get('agentGlue.splitSelectorTerminal')(h.b);assert.equal(split.location.parentTerminal,h.b);
 assert.equal(h.commands.has('agentGlue.closeSelectorTerminal'),false);
 const transfer=new Map();h.selector.dragAndDropController.handleDrag([h.b],transfer);
 await h.selector.dragAndDropController.handleDrop(h.a,transfer);
 assert.deepEqual(h.selector.provider.getChildren(),[h.b,h.a]);
 const again=registerSelector(h.vscode,h.context,t=>t===h.a?'claude-a':'codex-b');
 assert.deepEqual(again.provider.getChildren(),[h.b,h.a]);
 });

test('fork hover action uses existing command and only mapped agent rows',()=>{
 const h=host();assert.equal(h.selector.provider.getTreeItem(h.a).contextValue,'agentGlueAgentTerminal');
 const shell=registerSelector(h.vscode,h.context);assert.equal(shell.provider.getTreeItem(h.a).contextValue,'agentGlueTerminal');
 const menu=require('../package.json').contributes.menus['view/item/context'];
 const fork=menu.find(item=>item.command==='agentGlue.fork');assert.match(fork.when,/viewItem == agentGlueAgentTerminal/);
 assert.ok(fork.group<menu.find(item=>item.command==='agentGlue.splitSelectorTerminal').group);
 assert.ok(!menu.some(item=>/close/i.test(item.command)));
});

test('live status colors reflect the mapped session and native tabs setting is restored',async()=>{
 const h=host();let configured=true;
 h.vscode.workspace={getConfiguration:()=>({inspect:()=>({globalValue:configured}),update:async(key,value)=>{assert.equal(key,'tabs.enabled');configured=value;}})};
 const live=registerSelector(h.vscode,h.context,t=>t===h.a?'a':'b',name=>({status:name==='a'?'active':'blocked',label:name==='a'?'Working':'Waiting for you',since:Date.now()-61000}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(configured,false);
 assert.match(live.provider.getTreeItem(h.a).iconPath.dark.fsPath,/status-amber-dark.svg$/);assert.match(live.provider.getTreeItem(h.b).iconPath.dark.fsPath,/status-red-dark.svg$/);
 assert.match(live.provider.getTreeItem(h.a).description,/1m/);
 await h.commands.get('agentGlue.resetTerminalSelector')();assert.equal(configured,true);
});

test('RAG rows have explicit text and hidden tool terminals stay out of the selector',()=>{
 const h=host();h.vscode.window.terminals.push({name:'Thinking',creationOptions:{hideFromUser:true}});
 const list=registerSelector(h.vscode,h.context,t=>t===h.a?'a':'b',name=>({status:name==='a'?'active':'done',label:'Reported',since:Date.now()-61000,at:Date.now()-5000}));
 assert.deepEqual(list.provider.getChildren(),[h.a,h.b]);
 assert.match(list.provider.getTreeItem(h.a).description,/Working · 1m/);
 assert.match(list.provider.getTreeItem(h.b).description,/Finished · 5s ago/);
 assert.match(list.provider.getTreeItem(h.a).iconPath.light.fsPath,/status-amber-light.svg$/);
 assert.match(list.provider.getTreeItem(h.b).iconPath.dark.fsPath,/status-green-dark.svg$/);
});

test('selected status dots retain intrinsic color and update when status changes',()=>{
 const h=host();let state='active';
 const list=registerSelector(h.vscode,h.context,()=> 'agent',()=>({status:state,label:state}));
 const before=list.provider.getTreeItem(h.a).iconPath;h.vscode.window.activeTerminal=h.b;
 assert.deepEqual(list.provider.getTreeItem(h.a).iconPath,before);
 h.vscode.window.activeTerminal=h.a;state='done';const after=list.provider.getTreeItem(h.a).iconPath;
 assert.notDeepEqual(after,before);assert.match(after.dark.fsPath,/status-green-dark.svg$/);
 const fs=require('node:fs');for(const uri of Object.values(after)){const svg=fs.readFileSync(uri.fsPath,'utf8');assert.match(svg,/fill="#[0-9a-f]{6}"/);assert.doesNotMatch(svg,/currentColor/);}
});
