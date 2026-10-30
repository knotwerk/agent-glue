'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {links,owners,listeners,socketRows,WebApps}=require('../src/web-apps.cjs');
test('only local http endpoints are discovered and wildcard hosts are usable',()=>{
 assert.deepEqual(links('https://example.org http://localhost:3000/index.html http://0.0.0.0:8000/ http://u:p@localhost:90/'),['http://localhost:3000/index.html','http://localhost:8000/']);
 assert.deepEqual(links('http://[::1]:5000/'),['http://[::1]:5000/']);
});
test('listener adapters and ancestry do not attribute unrelated processes',()=>{
 assert.deepEqual(listeners('p20\ncnode\nn*:3000\n'),[{pid:'20',name:'node',port:3000}]);
 assert.deepEqual(socketRows('LISTEN 0 128 127.0.0.1:8000 0.0.0.0:* users:(("python",pid=42,fd=3))'),[{pid:'42',port:8000}]);
 assert.deepEqual([...owners([{pid:'2',ppid:'1'},{pid:'3',ppid:'2'},{pid:'4',ppid:'9'}],'1')],['1','2','3']);
});
test('links survive unavailable process tools and are marked stopped without HTTP response',async()=>{
 const apps=new WebApps(async()=>{throw Error('missing');},async url=>url.includes('3000'));
 const a={id:'a',name:'First',cwd:'/a',pane:'%1'},b={id:'b',name:'Second',cwd:'/b',pane:'%2'};
 apps.observe(a,'http://localhost:3000/index.html http://localhost:8000/');apps.observe(b,'http://localhost:9000/');
 const rows=await apps.refresh([a,b],true);assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.running).length,1);assert.equal(rows[0].cwd,'/a');
});
test('server association survives reparenting but never PID reuse',async()=>{
 let parent='10',start='Thu Oct 29 12:00:00 2026';
 const exec=async cmd=>({stdout:cmd==='ps'?`10 1 Thu Oct 29 11:00:00 2026 zsh\n20 ${parent} ${start} node`:cmd==='ss'?'LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=20,fd=3))':'%1\x1f10'});
 const apps=new WebApps(exec,async()=>true),a={id:'a',name:'One',cwd:'/a',pane:'%1'};
 assert.equal((await apps.refresh([a],true)).length,1);parent='1';assert.equal((await apps.refresh([a],true)).length,1);start='Thu Oct 29 13:00:00 2026';assert.equal((await apps.refresh([a],true)).filter(row=>row.running).length,0);
});

test('web app labels show filenames or routes without inventing an index file',()=>{
 const {appLabel}=require('../src/web-apps.cjs');
 assert.equal(appLabel('http://localhost:3000/reviews/report%20v2.html?mode=preview'),'report v2.html');
 assert.equal(appLabel('http://localhost:3000/'),'App root (/)');
 assert.equal(appLabel('http://localhost:3000/dashboard/'),'dashboard/');
 assert.equal(appLabel('http://localhost:3000/%oops'),'%oops');
});

test('keeps distinct routes on a server and marks their discovery source',async()=>{
 const apps=new WebApps(async()=>{throw Error('no discovery');},async()=>({running:true,kind:'page',statusCode:200}));
 const session={id:'a',name:'One',cwd:'/a',pane:'%1'};
 apps.observe(session,'http://localhost:3000/report.html http://localhost:3000/health');
 const items=await apps.refresh([session],true);
 assert.equal(items.length,2);assert.ok(items.every(i=>i.source==='link'));assert.ok(items.some(i=>i.url.endsWith('/report.html')));
});
test('HTTP probes distinguish pages, services, errors and redirects without following links',async()=>{
 const http=require('node:http');const {probe,appStatus,appDetails}=require('../src/web-apps.cjs');
 const requests=[];const server=http.createServer((req,res)=>{
  requests.push(req.method+' '+req.url);
  const statuses={'/missing':404,'/error':500,'/redirect':302};res.statusCode=statuses[req.url]||200;
  res.setHeader('Content-Type',req.url==='/api'?'application/json':'text/html; charset=utf-8');
  if(req.url==='/redirect')res.setHeader('Location','http://example.invalid/');
  if(req.url==='/framed')res.setHeader('X-Frame-Options','DENY');res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [route,kind] of [['/','page'],['/api','service'],['/missing','error'],['/error','error'],['/redirect','redirect']]){
   const result=await probe(base+route);assert.equal(result.kind,kind);assert.equal(result.running,true);
   if(kind==='error')assert.match(appStatus(result),/^HTTP [45]/);
  }
  const framed=await probe(base+'/framed');assert.equal(framed.frameRestricted,true);assert.match(appDetails({...framed,source:'process'}),/homepage guessed/);
  assert.ok(requests.every(r=>r.startsWith('HEAD ')));assert.equal(requests.length,6);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('agent-owned listeners are excluded even when mentioned elsewhere; child web servers survive',async()=>{
 const processes='10 1 Thu Oct 29 11:00:00 2026 zsh\n20 10 Thu Oct 29 11:00:00 2026 codex\n21 20 Thu Oct 29 11:00:00 2026 node\n30 1 Thu Oct 29 11:00:00 2026 claude';
 const sockets='LISTEN 0 128 127.0.0.1:38105 0.0.0.0:* users:(("codex",pid=20,fd=3))\nLISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=21,fd=3))\nLISTEN 0 128 127.0.0.1:4000 0.0.0.0:* users:(("claude",pid=30,fd=3))';
 const checked=[];const apps=new WebApps(async cmd=>({stdout:cmd==='ps'?processes:cmd==='ss'?sockets:'%1\x1f10\n%2\x1f30'}),async url=>{checked.push(url);return {running:true,kind:'page'};});
 const sessions=[{id:'a',name:'A',pane:'%1'},{id:'b',name:'B',pane:'%2'}];
 apps.observe(sessions[1],'http://localhost:38105/ http://localhost:4000/');
 apps.items=[{id:'old',source:'process',sessionId:'a',url:'http://localhost:38105/'}];
 const result=await apps.refresh(sessions,true);
 assert.deepEqual(result.map(r=>r.url),['http://localhost:3000/']);assert.deepEqual(checked,['http://localhost:3000/']);
});
test('protected and non-page endpoints are hidden by default without labelling them stopped',()=>{
 const {hiddenEndpoint}=require('../src/web-apps.cjs');
 for(const item of [{running:true,statusCode:401},{running:true,statusCode:403},{running:true,kind:'service'},{running:false}])assert.equal(hiddenEndpoint(item),true);
 assert.equal(hiddenEndpoint({running:true,kind:'page'}),false);
 assert.equal(hiddenEndpoint({running:true,kind:'error',statusCode:404}),false);
});
