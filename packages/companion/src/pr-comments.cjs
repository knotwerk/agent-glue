'use strict';
const {execFile}=require('node:child_process');
function runWithInput(command,args,options,body){
  return new Promise((resolve,reject)=>{
    const child=execFile(command,args,options,(error,stdout)=>error?reject(error):resolve({stdout}));
    child.stdin.on('error',()=>{}); // Process failure is reported by execFile.
    child.stdin.end(body);
  });
}
async function postComment(item,root,body,{exec=runWithInput}={}){
  if(item.local||!Number.isInteger(item.number)||item.number<1||typeof item.url!=='string'||!new RegExp('^https://[^/]+/[^/]+/[^/]+/pull/'+item.number+'$').test(item.url))throw new Error('Open a published GitHub PR to post a comment.');
  if(typeof body!=='string'||!body.trim())throw new Error('Write a comment first.');
  if(Buffer.byteLength(body,'utf8')>60000)throw new Error('Comment must be 60 KB or smaller.');
  try{
    await exec('gh',['pr','comment',item.url,'--body-file','-'],{cwd:root,timeout:30000,maxBuffer:1024*1024},body);
  }catch{
    throw new Error('Could not confirm posting. Your draft is kept. Check the PR on GitHub before retrying to avoid a duplicate; also check GitHub CLI login and permissions.');
  }
}
module.exports={postComment};
