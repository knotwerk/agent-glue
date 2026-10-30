'use strict';
const {records}=require('./status-runner.cjs');
// These are explicit UI signals, not an inference from output volume or silence.
function signal(output){
 const tail=String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').trimEnd().split('\n').slice(-12).join('\n');
 if(/(?:^|\n)\s*(?:Do you want to (?:proceed|allow|run)|Would you like to (?:run|allow)|Approve this (?:command|action)|Allow this (?:command|tool))/i.test(tail)&&/(?:yes|allow|approve)/i.test(tail))return 'blocked';
 if(/(?:^|\n)\s*(?:[•✢✳✶✻✽✱⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*\besc(?:ape)? to (?:interrupt|cancel)\b.*|esc(?:ape)? to (?:interrupt|cancel))\s*$/im.test(tail))return 'active';
 // Completion prose is deliberately not matched: it can be quoted or historical.
 return undefined;
}
function reported(report,now){
 const items=records(report),unfinished=items.filter(item=>item.status!=='done');
 const status=unfinished.some(i=>i.status==='blocked')?'blocked':unfinished.some(i=>i.status==='active')?'active':unfinished.length?'unknown':items.length?'done':'unknown';
 const updatedAt=Math.max(0,...items.map(i=>Date.parse(i.updatedAt)||0));
 const agents=new Set(items.flatMap(i=>i.agents||[]).map(s=>s.trim()).filter(Boolean));
 const stale=updatedAt>0&&now-updatedAt>5*60*1000;
 return {status:stale?'unknown':status,label:stale?'Old report':({active:'Working',blocked:'Needs attention',done:'Done',unknown:'Unknown'})[status],updatedAt,helpers:agents.size||undefined,reported:true};
}
class Activity {
 constructor(){this.observations=new Map();}
 observe(id,output,now=Date.now()){
  const status=signal(output),old=this.observations.get(id);
  this.observations.set(id,{status,since:status&&old?.status===status&&now-old.updatedAt<10000?old.since:now,updatedAt:now});
 }
 list(sessions,reports,{selected,visible,now=Date.now()}={}){
  const ids=new Set(sessions.map(s=>s.id));for(const id of this.observations.keys())if(!ids.has(id))this.observations.delete(id);
  return sessions.map(session=>{
   const item=reported(reports[session.id],now),observed=this.observations.get(session.id);
   const current=visible&&selected===session.id&&observed?.status&&now-observed.updatedAt<10000;
   if(!current&&observed?.status&&observed.updatedAt>=item.updatedAt){const stale=now-observed.updatedAt>5*60*1000;Object.assign(item,{status:stale?'unknown':observed.status,label:stale?'Old observation':observed.status==='active'?'Working':'Waiting for you',updatedAt:observed.updatedAt,reported:true,observed:true});}
   if(current&&observed.updatedAt>=item.updatedAt)Object.assign(item,{status:observed.status,label:observed.status==='active'?'Working':'Waiting for you',since:observed.since,updatedAt:observed.updatedAt,reported:false});
   return {id:session.id,name:session.name,profile:session.profile,...item};
  });
 }
}
module.exports={Activity,signal,reported};
