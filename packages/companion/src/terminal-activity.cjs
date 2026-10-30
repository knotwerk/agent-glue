'use strict';
const {Activity}=require('./activity.cjs');
function terminalUri(vscode,value){
 if(typeof value!=='string'||value.length>4096)throw Error('Drop one terminal row from this VS Code window.');
 const uri=vscode.Uri.parse(value);
 if(uri.scheme!=='vscode-terminal'||uri.authority||uri.query||!/^\/[^/]+\/[1-9]\d*$/.test(uri.path))throw Error('Not a native terminal tab.');
 return uri.with({fragment:'',query:''});
}
class TerminalActivity {
 constructor(vscode,context){
  this.vscode=vscode;this.bindings=new Map();this.activity=new Activity();this.rows=new Map();this.sessions=new Map();
  this.changed=new vscode.EventEmitter();this.onDidChangeFileDecorations=this.changed.event;
  context.subscriptions.push(this,this.changed,vscode.window.registerFileDecorationProvider(this));
 }
 bind(uri,terminal,session){
  if(!this.vscode.window.terminals.includes(terminal))throw Error('That terminal closed. Drop its replacement to link it.');
  this.bindings.set(uri.toString(),{uri,terminal,sessionId:session.id});this.changed.fire(uri);
 }
 observe(id,text){this.activity.observe(id,text);}
 update(sessions,reports,selected,visible,link,now=Date.now()){
  this.sessions=new Map(sessions.map(s=>[s.id,s]));this.link=link;this.now=now;
  this.rows=new Map(this.activity.list(sessions,reports,{selected,visible,now}).map(row=>[row.id,row]));
  const changed=[];
  for(const [key,binding] of this.bindings){changed.push(binding.uri);if(!this.valid(binding))this.bindings.delete(key);}
  if(changed.length)this.changed.fire(changed);
 }
 valid(binding){
  const source=this.sessions.get(binding.sessionId);
  return this.vscode.window.terminals.includes(binding.terminal)&&source&&this.link?.sessionForTerminal(binding.terminal)===source.sessionName;
 }
 provideFileDecoration(uri){
  if(uri.scheme!=='vscode-terminal')return;
  const binding=this.bindings.get(uri.with({fragment:'',query:''}).toString());
  if(!binding||!this.valid(binding))return;
  const row=this.rows.get(binding.sessionId);if(!row)return;
  const colors={active:'terminal.ansiYellow',blocked:'terminal.ansiRed',done:'terminal.ansiGreen',unknown:'descriptionForeground'};
  let badge={active:'●',blocked:'!',done:'✓',unknown:'?'}[row.status]||'?';
  let tooltip='Agent Glue: '+row.label;
  if(row.since&&!row.reported&&row.status==='active'){
   const seconds=Math.max(0,Math.floor((this.now-row.since)/1000)),minutes=Math.floor(seconds/60);
   badge=minutes<10?minutes+'m':minutes<100?String(minutes):'●';
   tooltip+=` · observed working for ${minutes}:${String(seconds%60).padStart(2,'0')}`;
  }
  if(row.reported)tooltip+=' · '+(row.observed?'last observed':'saved report')+(row.updatedAt?' '+new Date(row.updatedAt).toISOString():' unavailable');
  if(row.helpers)tooltip+=` · ${row.helpers} reported helper descriptions (not a live agent count)`;
  return {badge,color:new this.vscode.ThemeColor(colors[row.status]||colors.unknown),tooltip,propagate:false};
 }
 dispose(){this.bindings.clear();}
}
module.exports={TerminalActivity,terminalUri};
