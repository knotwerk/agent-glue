'use strict';
const http=require('node:http');
const https=require('node:https');
function localUrl(value){
 try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!['localhost','127.0.0.1','0.0.0.0','[::]','[::1]'].includes(u.hostname))return;
 if(['0.0.0.0','[::]'].includes(u.hostname))u.hostname='localhost';return u.href;}catch{}
}
function appLabel(value){
 try{const pathname=new URL(value).pathname;const last=pathname.split('/').filter(Boolean).at(-1);if(!last)return 'App root (/)';let name;try{name=decodeURIComponent(last);}catch{name=last;}return pathname.endsWith('/')?name+'/':name;}catch{return 'Web app';}
}
function links(text){return [...new Set((text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').match(/https?:\/\/[^\s<>"'`]+/g)||[]).map(s=>localUrl(s.replace(/[),.;]+$/,''))).filter(Boolean))].slice(-30);}
function probe(url){return new Promise(resolve=>{
 let settled=false;const finish=value=>{if(!settled){settled=true;clearTimeout(deadline);resolve(value);}};
 const request=(url.startsWith('https:')?https:http).request(url,{method:'HEAD',rejectUnauthorized:false},response=>{
  const statusCode=response.statusCode||0,contentType=String(response.headers['content-type']||'').split(';')[0].toLowerCase();
  const kind=statusCode>=400?'error':statusCode>=300?'redirect':statusCode===204?'service':/^(text\/html|application\/xhtml\+xml)$/.test(contentType)?'page':contentType?'service':'unknown';
  finish({running:true,kind,statusCode,contentType,frameRestricted:Boolean(response.headers['x-frame-options']||/frame-ancestors/i.test(String(response.headers['content-security-policy']||'')))});response.destroy();
 });
 const deadline=setTimeout(()=>{finish({running:false,kind:'unreachable',reason:'Timed out'});request.destroy();},1500);
 request.on('error',error=>finish({running:false,kind:'unreachable',reason:error.code||'Connection failed'}));request.end();
});}
function urlPort(url){const u=new URL(url);return Number(u.port||(u.protocol==='https:'?443:80));}
function hiddenEndpoint(item){return !item.running||item.kind==='service'||[401,403].includes(item.statusCode);}
function health(value){return typeof value==='boolean'?{running:value,kind:value?'unknown':'unreachable'}:value;}
function appStatus(item){return ({page:'Webpage',service:'API / service',error:'HTTP '+item.statusCode,redirect:'Redirect',unknown:'Responding · type unknown',unreachable:'Unreachable'})[item.kind]||(item.running?'Responding':'Unreachable');}
function appDetails(item){return [appStatus(item),item.statusCode?'HTTP '+item.statusCode:'',item.contentType||'',item.source==='link'?'Link mentioned in terminal':'Discovered port · homepage guessed',item.frameRestricted?'Embedding restrictions reported; try Open in browser':'',item.reason||''].filter(Boolean).join(' · ');}
function processRows(text){return text.split('\n').map(l=>l.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/)).filter(Boolean).map(m=>({pid:m[1],ppid:m[2],start:m[3],name:m[4]}));}
function owners(rows,root){const found=new Set([String(root)]);let changed=true;while(changed){changed=false;for(const row of rows)if(found.has(row.ppid)&&!found.has(row.pid)){found.add(row.pid);changed=true;}}return found;}
function listeners(text){let pid,name;const result=[];for(const line of text.split('\n')){if(line[0]==='p')pid=line.slice(1);if(line[0]==='c')name=line.slice(1);if(line[0]==='n'){const match=line.match(/:(\d+)$/);if(pid&&match)result.push({pid,name,port:Number(match[1])});}}return result;}
function socketRows(text){
 return text.split('\n').flatMap(line=>{const cols=line.trim().split(/\s+/),port=cols[3]?.match(/:(\d+)$/);if(!port)return [];return [...line.matchAll(/pid=(\d+)/g)].map(m=>({pid:m[1],port:Number(port[1])}));});
}
class WebApps{
 constructor(exec,check=probe){this.exec=exec;this.check=check;this.known=new Map();this.items=[];this.last=0;this.associations=new Map();this.scope='';}
 observe(session,text){const map=this.known.get(session.id)||new Map();for(const url of links(text)){map.delete(url);map.set(url,url);}while(map.size>30)map.delete(map.keys().next().value);this.known.set(session.id,map);}
 async refresh(sessions,force=false){
  const scope=sessions.map(s=>s.id).sort().join('|');
  if(!force&&scope===this.scope&&Date.now()-this.last<5000)return this.items;
  if(this.pending)return this.pending;
  this.scope=scope;this.pending=this.scan(sessions).finally(()=>{this.pending=undefined;});return this.pending;
 }
 async listening(){
  try{const {stdout}=await this.exec('ss',['-H','-ltnp'],{timeout:3000,maxBuffer:1024*1024});return socketRows(stdout);}catch{}
  const {stdout}=await this.exec('lsof',['-nP','-iTCP','-sTCP:LISTEN','-Fpcn'],{timeout:3000,maxBuffer:1024*1024});return listeners(stdout);
 }
 async scan(sessions){
  this.last=Date.now();let ports=[],processes=[],panes=new Map();
  try{
   const [p,l,t]=await Promise.all([this.exec('ps',['-eo','pid=,ppid=,lstart=,comm=']),this.listening(),this.exec('tmux',['list-panes','-a','-F','#{pane_id}\x1f#{pane_pid}'])]);
   processes=processRows(p.stdout);ports=l;panes=new Map(t.stdout.trim().split('\n').map(x=>x.split('\x1f')));
  }catch{/* Links still work without process discovery tools. */}
  // Match the listening process itself, never its ancestry: agents also launch real web servers.
  const infrastructure=new Set(ports.filter(port=>{
   const name=(processes.find(p=>p.pid===port.pid)?.name||port.name||'').split('/').at(-1);
   return /^(?:codex|claude)(?:[0-9]+|l|lp)?$/.test(name);
  }).map(port=>port.port));
  const candidates=[];
  for(const session of sessions){
   const urls=new Map(this.known.get(session.id)||[]);const pids=owners(processes,panes.get(session.pane));
   for(const port of ports){
    if(infrastructure.has(port.port))continue;
    const process=processes.find(p=>p.pid===port.pid);if(!process)continue;
    const key=port.pid+':'+process.start;
    if(pids.has(port.pid))this.associations.set(key,session.id);
    if(this.associations.get(key)!==session.id)continue;
    if([...urls.values()].some(url=>Number(new URL(url).port||(new URL(url).protocol==='https:'?443:80))===port.port))continue;
    const url=`http://localhost:${port.port}/`;urls.set(url,url);
   }
   for(const url of [...urls.values()].filter(url=>!infrastructure.has(urlPort(url))).slice(0,30))candidates.push({id:JSON.stringify([session.id,url]),sessionId:session.id,terminal:session.name,cwd:session.cwd,url,source:this.known.get(session.id)?.has(url)?'link':'process'});
  }
  const results=[];
  // Bound concurrent connections even when Show all spans many sessions.
  for(let i=0;i<Math.min(candidates.length,200);i+=4)await Promise.all(candidates.slice(i,i+4).map(async item=>{
   let result=health(await this.check(item.url));
   if(!result.running&&item.source==='process'){
    const tls=item.url.replace(/^http:/,'https:'),secure=health(await this.check(tls));
    if(secure.running){item.url=tls;item.id=JSON.stringify([item.sessionId,tls]);result=secure;}
   }
   results.push({...item,...result});
  }));
  for(const old of this.items)if(old.source==='process'&&!infrastructure.has(urlPort(old.url))&&sessions.some(s=>s.id===old.sessionId)&&!results.some(r=>r.id===old.id))results.push({...old,running:false,kind:'unreachable',statusCode:undefined,contentType:undefined,reason:'Listener no longer detected'});
  const liveKeys=new Set(processes.map(p=>p.pid+':'+p.start));for(const key of this.associations.keys())if(!liveKeys.has(key))this.associations.delete(key);
  this.items=results.sort((a,b)=>a.terminal.localeCompare(b.terminal)||a.url.localeCompare(b.url));return this.items;
 }
}
module.exports={appLabel,appStatus,appDetails,hiddenEndpoint,WebApps,localUrl,links,probe,owners,processRows,listeners,socketRows};
