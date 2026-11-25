'use strict';
// OpenCode (`opencode`, and the `neon` launcher profile) saved-session lookup.
// A synthetic `opencode` stands in for the CLI; no real session store is read.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {tempDir}=require('../../../test/support/tmp.cjs');
const helpers=path.resolve(__dirname,'../helpers'),created=1800000000,at=seconds=>(created+seconds)*1000;
const skip=spawnSync('jq',['--version']).status===0?false:'jq is not installed';

function state(rows,call){
 const dir=tempDir('opencode-state'),bin=path.join(dir,'bin'),project=path.join(dir,'project'),log=path.join(dir,'calls'),list=path.join(dir,'rows.json');
 fs.mkdirSync(bin);fs.mkdirSync(project);fs.writeFileSync(list,JSON.stringify(rows(project)));
 fs.writeFileSync(path.join(bin,'opencode'),'#!/bin/sh\nprintf "%s|%s\\n" "$PWD" "$*" >> "$FIXTURE_LOG"\ncat "$FIXTURE_ROWS"\n',{mode:0o755});
 const stdout=execFileSync('zsh',['-f','-c','source "$1"; '+call,'zsh',path.join(helpers,'agent-tmux-state.zsh'),project],{env:{PATH:bin+path.delimiter+process.env.PATH,HOME:dir,XDG_STATE_HOME:dir,FIXTURE_LOG:log,FIXTURE_ROWS:list},encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 return {stdout,project,calls:fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n'):[]};
}
const row=(id,createdAt,directory)=>({id,title:'Synthetic',created:createdAt,updated:createdAt,projectId:'global',directory});

for(const program of ['opencode','neon'])test(`${program} resumes the conversation started in its folder after launch`,{skip},()=>{
 const h=state(project=>[
  row('ses_other0folder',at(5),'/elsewhere'),
  row('ses_before0launch',at(-600),project),
  row('ses_later',at(900),project),
  row('ses_first',at(40),project),
  row('not-a-session; rm -rf x',at(1),project),
 ],`agent_tmux_resume_id ${program} ${created} "$2"`);
 assert.equal(h.stdout,'ses_first');
 assert.deepEqual(h.calls,[`${h.project}|session list --format json -n 50`],'asks the CLI once, from the session folder');
});

test('no conversation yet leaves the resume id empty rather than guessing',{skip},()=>{
 assert.equal(state(project=>[row('ses_old',at(-600),project)],`agent_tmux_resume_id neon ${created} "$2"`).stdout,'');
 assert.equal(state(()=>({error:'unexpected output'}),`agent_tmux_resume_id neon ${created} "$2"`).stdout,'');
});

test('resume commands name the launcher and the saved conversation',()=>{
 const h=state(()=>[],'agent_tmux_resume_command neon ses_first; agent_tmux_resume_command opencode ses_first; agent_tmux_resume_command opencode');
 assert.deepEqual(h.stdout.split('\n'),['neon --session ses_first','opencode --session ses_first','opencode --continue']);assert.deepEqual(h.calls,[]);
});

test('restoration restarts OpenCode on the saved conversation, and neon through its launcher',()=>{
 const script=fs.readFileSync(path.join(helpers,'agent-tmux-restore.zsh'),'utf8');
 assert.match(script,/command opencode --session\$\(quote_cmd_args "\$resume_id"\)/);
 assert.match(script,/cmd="neon --session\$\(quote_cmd_args "\$resume_id"\)"/);
 assert.doesNotMatch(script,/--auto/);
});

test('restoring a neon session types its launcher command into the new session pane',()=>{
 const dir=tempDir('opencode-restore'),bin=path.join(dir,'bin'),copy=path.join(dir,'helpers'),log=path.join(dir,'calls'),project=path.join(dir,'project'),session='neon-review-20261014_120000';
 for(const folder of [bin,copy,project])fs.mkdirSync(folder);
 // Copied without the task-sync helper, so nothing is scheduled after the test.
 for(const name of ['agent-tmux-restore.zsh','agent-tmux-state.zsh'])fs.copyFileSync(path.join(helpers,name),path.join(copy,name));
 fs.writeFileSync(path.join(bin,'tmux'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_LOG"\n[ "$1" = has-session ] && exit 1\nexit 0\n',{mode:0o755});
 fs.writeFileSync(path.join(bin,'opencode'),'#!/bin/sh\necho "[]"\n',{mode:0o755});
 execFileSync('zsh',['-f',path.join(copy,'agent-tmux-restore.zsh'),'neon',session,'review',String(created),project,'ses_first'],{env:{PATH:bin+path.delimiter+process.env.PATH,HOME:dir,XDG_STATE_HOME:dir,FIXTURE_LOG:log},stdio:'pipe'});
 const calls=fs.readFileSync(log,'utf8').trim().split('\n');
 assert.ok(calls.includes(`new-session -d -s ${session} -c ${project}`),calls.join('\n'));
 assert.ok(calls.includes(`send-keys -t =${session}: cd ${project} && neon --session ses_first Enter`),calls.join('\n'));
});
