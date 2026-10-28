'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {BrowserLinks,zeroTierAddress}=require('../src/browser-links.cjs');
test('browser links use only ZeroTier addresses, never the public or LAN interface',()=>{
  assert.equal(zeroTierAddress({eth0:[{address:'192.168.1.2',family:'IPv4'}],ztabc:[{address:'172.28.50.205',family:'IPv4'}]}),'172.28.50.205');
  assert.throws(()=>zeroTierAddress({eth0:[{address:'192.168.1.2',family:'IPv4'}]}),/No ZeroTier/);
});
test('browser link serves selected documents only, sandboxed, and rechecks symlinks',async t=>{
  const root=tempDir('browser-link');const file=path.join(root,'review.md');fs.writeFileSync(file,'# Shared review');
  const server=new BrowserLinks({host:'127.0.0.1'});t.after(()=>server.dispose());
  const [url,again]=await Promise.all([server.link(file,root),server.link(file,root)]);
  assert.equal(url,again);
  const response=await fetch(url);assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(await response.text(),/sandbox="allow-scripts".*Shared review/s);
  assert.equal((await fetch(new URL('/',url))).status,404);
  assert.equal((await fetch(new URL('/etc/passwd',url))).status,404);
  assert.equal((await fetch(url,{method:'POST'})).status,404);
  await assert.rejects(server.link('/etc/passwd',root),/outside/);
  const link=path.join(root,'escape.md');fs.symlinkSync('/etc/passwd',link);
  await assert.rejects(server.link(link,root),/outside/);
});

test('downloads preserve original bytes and are separate from sandboxed previews',async t=>{
  const root=tempDir('download');const file=path.join(root,'shared data.csv');const bytes=Buffer.from('a,b\n1,2\n');fs.writeFileSync(file,bytes);
  const server=new BrowserLinks({host:'127.0.0.1'});t.after(()=>server.dispose());
  const url=await server.link(file,root,{download:true});
  const response=await fetch(url);
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-disposition'),/attachment; filename\*=UTF-8''shared%20data.csv/);
  assert.equal(response.headers.get('content-type'),'application/octet-stream');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  assert.equal((await fetch(url,{method:'HEAD'})).headers.get('content-length'),String(bytes.length));
  await assert.rejects(server.link(file,root),/Markdown and HTML/);
  const md=path.join(root,'readme.md');fs.writeFileSync(md,'# Original');
  assert.notEqual(await server.link(md,root),await server.link(md,root,{download:true}));
  await assert.rejects(server.link('/etc/passwd',root,{download:true}),/outside/);
});
