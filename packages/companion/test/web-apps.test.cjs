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
