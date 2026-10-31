'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const path=require('node:path');
test('loading Companion for terminal restoration does not initialize document parsers or PR modules',()=>{
 const entry=path.resolve(__dirname,'../packages/companion/src/extension.cjs');
 // Separate process ensures other tests have not already cached the renderers.
 const script=`const Module=require('node:module'),original=Module._load;
 Module._load=function(name,...args){
  if(name==='vscode')return {};
  if(/^(markdown-it|parse5)$/.test(name)||/\\/(preview|pull-request|review-files)\\.cjs$/.test(name))throw Error('Eager document module: '+name);
  return original.call(this,name,...args);
 };require(process.argv[1]);`;
 assert.doesNotThrow(()=>execFileSync(process.execPath,['-e',script,entry],{stdio:'pipe'}));
});

test('reconnecting a named session performs no repeated window or pane mutations',()=>{
 const fs=require('node:fs'),{tempDir}=require('./support/tmp.cjs');
 const dir=tempDir('attach-fast'),bin=path.join(dir,'bin'),log=path.join(dir,'calls');fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_TMUX_LOG"\ncase "$1" in\n has-session) exit 0 ;;\n show-option) printf "research\\n" ;;\n attach-session) exit 0 ;;\n *) echo "Unexpected tmux call" >&2; exit 99 ;;\nesac\n',{mode:0o755});
 execFileSync('zsh',['-f',path.resolve(__dirname,'../packages/sessions/helpers/agent-tmux-attach.zsh'),'claude-research','research'],{env:{PATH:bin+path.delimiter+process.env.PATH,HOME:dir,XDG_STATE_HOME:dir,FIXTURE_TMUX_LOG:log},stdio:'pipe'});
 assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n'),['has-session -t =claude-research','show-option -qv -t claude-research @title','attach-session -t =claude-research']);
});
