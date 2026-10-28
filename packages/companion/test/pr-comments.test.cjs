'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {postComment}=require('../src/pr-comments.cjs');
const item={number:12,url:'https://github.com/example/project/pull/12'};
test('comments target the exact PR and send literal multiline Markdown on stdin',async()=>{
 const body='Please change this.\n\n```sh\n$(touch nope) `literal`\n```';let call;
 await postComment(item,'/selected/project',body,{exec:async(...args)=>{call=args;}});
 assert.deepEqual(call.slice(0,2),['gh',['pr','comment',item.url,'--body-file','-']]);
 assert.equal(call[2].cwd,'/selected/project');assert.equal(call[3],body);
});
test('comments reject empty, oversized and unpublished feedback without a network call',async()=>{
 const exec=async()=>assert.fail('unexpected network call');
 for(const [target,body] of [[item,' '],[item,'x'.repeat(60001)],[{...item,local:true},'text'],[{...item,number:13},'text']])await assert.rejects(postComment(target,'/p',body,{exec}));
});
test('uncertain posting failures do not retry or expose CLI output',async()=>{
 let calls=0;
 await assert.rejects(postComment(item,'/p','feedback',{exec:async()=>{calls++;throw Error('private subprocess details');}}),error=>/Check the PR/.test(error.message)&&!error.message.includes('private subprocess'));
 assert.equal(calls,1);
});
