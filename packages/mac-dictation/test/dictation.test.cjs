'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {start,SCRIPT}=require('../extension.js');
test('Mac helper invokes only the fixed local menu script',async()=>{
  let call;
  await start({platform:'darwin',exec:async(...args)=>{call=args;}});
  assert.equal(call[0],'/usr/bin/osascript');
  assert.deepEqual(call[1],['-e',SCRIPT]);
  assert.match(SCRIPT,/frontmost is true/);
  assert.match(SCRIPT,/com.microsoft.VSCode/);
  assert.doesNotMatch(SCRIPT,/keystroke|key code/);
});
test('Mac helper refuses a remote Linux host and reports permission failures',async()=>{
  await assert.rejects(start({platform:'linux',exec:async()=>assert.fail('must not execute')}),/locally on your Mac/);
  await assert.rejects(start({platform:'darwin',exec:async()=>{throw new Error('permission denied');}}),/Accessibility.*permission denied/);
});

test('clipboard image is read on the Mac via AppKit and validated before transfer',async()=>{
  const {readClipboardImage,CLIPBOARD_SCRIPT}=require('../extension.js');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  let call;
  const result=await readClipboardImage({platform:'darwin',exec:async(...args)=>{call=args;return {stdout:png.toString('base64')+'\n'};}});
  assert.deepEqual(call.slice(0,2),['/usr/bin/osascript',['-l','JavaScript','-e',CLIPBOARD_SCRIPT]]);
  assert.equal(result.data,png.toString('base64'));
  assert.equal(result.size,png.length);
  await assert.rejects(readClipboardImage({platform:'linux',exec:async()=>assert.fail('remote clipboard must not be read')}),/locally/);
  for(const stdout of ['',Buffer.from('text').toString('base64'),'invalid!'])await assert.rejects(readClipboardImage({platform:'darwin',exec:async()=>({stdout})}),/valid PNG/);
  await assert.rejects(readClipboardImage({platform:'darwin',exec:async()=>{throw new Error('No image in the Mac clipboard');}}),/No image/);
});

test('native clipboard errors do not echo the subprocess script',async()=>{
  const {readClipboardImage,CLIPBOARD_SCRIPT}=require('../extension.js');
  await assert.rejects(readClipboardImage({platform:'darwin',exec:async()=>{throw new Error('Command failed: /usr/bin/osascript -e '+CLIPBOARD_SCRIPT);}}),error=>{
    assert.match(error.message,/Could not read the Mac clipboard/);
    assert.doesNotMatch(error.message,/ObjC|NSPasteboard|osascript/);
    return true;
  });
});

test('native downloads copy the exact remote URI outside the workspace to a local Save destination',async()=>{
  const {downloadFile}=require('../extension.js');
  const uri=(scheme,path)=>({scheme,path,toString:()=>scheme+':'+path});
  const source=uri('vscode-remote','/another-project/review-v2.html');
  let destination=uri('file','/Downloads/review-v2.html'),calls=[],options;
  const vscode={Uri:{isUri:value=>Boolean(value?.scheme),file:path=>uri('file',path)},FileType:{File:1},ProgressLocation:{Notification:15},
    workspace:{fs:{stat:async()=>({type:1}),copy:async(...args)=>calls.push(args)}},
    window:{showSaveDialog:async value=>{options=value;return destination;},withProgress:async(options,task)=>task()}};
  assert.deepEqual(await downloadFile(vscode,source),{cancelled:false});
  assert.equal(options.defaultUri.scheme,'file');assert.match(options.defaultUri.path,/Downloads.*review-v2.html$/);
  assert.deepEqual(calls,[[source,destination,{overwrite:true}]]);
  destination=undefined;assert.deepEqual(await downloadFile(vscode,source),{cancelled:true});assert.equal(calls.length,1);
  destination=uri('vscode-remote','/remote/destination');await assert.rejects(downloadFile(vscode,source),/on your computer/);assert.equal(calls.length,1);
  await assert.rejects(downloadFile(vscode,uri('https','/file')),/local or SSH/);
  vscode.workspace.fs.stat=async()=>({type:2});await assert.rejects(downloadFile(vscode,source),/regular file/);
});

test('local file uploads read HTML and file URLs byte-for-byte and reject folders and oversized files',async()=>{
 const {readLocalFile}=require('../extension.js');const fs=require('node:fs/promises'),path=require('node:path');
 const {tempDir}=require('../../../test/support/tmp.cjs');const dir=tempDir('local-upload'),file=path.join(dir,'review two.html');
 const bytes=Buffer.from('<!doctype html><p>Review ✓</p>');await fs.writeFile(file,bytes);
 for(const source of [file,require('node:url').pathToFileURL(file).href]){
  const result=await readLocalFile(source);assert.equal(result.name,'review two.html');assert.equal(result.size,bytes.length);assert.deepEqual(Buffer.from(result.data,'base64'),bytes);
 }
 await assert.rejects(readLocalFile(dir),/not a folder/);
 await assert.rejects(readLocalFile('relative.html'),/absolute path/);
 await assert.rejects(readLocalFile('https://example.com/file.html'),/absolute path/);
 const large=path.join(dir,'large.html');await fs.writeFile(large,'');await fs.truncate(large,25*1024*1024+1);await assert.rejects(readLocalFile(large),/25 MB/);
});
