'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Activity,signal,reported}=require('../src/activity.cjs');
const now=Date.parse('2026-10-30T12:00:00Z'),sessions=[{id:'one',name:'Example',profile:'claude2'}];
const item=(status,extras={})=>({status,updatedAt:new Date(now).toISOString(),...extras});
test('activity recognizes explicit working and permission UI, never silence or completion prose',()=>{
 assert.equal(signal('• Working (2s • esc to interrupt)'), 'active');
 assert.equal(signal('Do you want to proceed?\n 1. Yes\n 2. No'), 'blocked');
 for(const text of ['', 'All done!', 'The documentation mentions esc to interrupt.', 'Working on this now'])assert.equal(signal(text),undefined);
 assert.equal(signal('• Working (2s • esc to interrupt)\n'+Array(20).fill('older output').join('\n')),undefined,'ignore old signals');
});
test('report badges prioritize blocked work and go neutral when stale',()=>{
 assert.equal(reported({items:[item('done'),item('active'),item('blocked')]},now).status,'blocked');
 assert.equal(reported({items:[item('done')]},now).status,'done');
 assert.equal(reported({items:[]},now).status,'unknown');
 assert.equal(reported({items:[item('active')]},now+301000).status,'unknown');
 assert.equal(reported({items:[item('active',{agents:['Helper one','Helper one','Helper two']})]},now).helpers,2);
});
test('working timer preserves continuous observations but resets across gaps; hidden rows are snapshots',()=>{
 const activity=new Activity();activity.observe('one','• Working (2s • esc to interrupt)',now);
 activity.observe('one','• Working (5s • esc to interrupt)',now+3000);
 let row=activity.list(sessions,{}, {selected:'one',visible:true,now:now+3000})[0];assert.equal(row.since,now);assert.equal(row.reported,false);
 row=activity.list(sessions,{}, {selected:'other',visible:true,now:now+4000})[0];assert.equal(row.reported,true);assert.equal(row.observed,true);
 activity.observe('one','• Working (25s • esc to interrupt)',now+25000);
 row=activity.list(sessions,{}, {selected:'one',visible:true,now:now+25000})[0];assert.equal(row.since,now+25000);
 assert.equal(activity.list(sessions,{}, {visible:false,now:now+400000})[0].status,'unknown');
 activity.list([],{});assert.equal(activity.observations.size,0);
});
test('current permission prompt overrides an older completed task without trusting terminal text as HTML',()=>{
 const activity=new Activity();activity.observe('one','Do you want to proceed?\n1. Yes\n2. No',now+1000);
 const row=activity.list(sessions,{one:{items:[item('done')]}},{selected:'one',visible:true,now:now+1000})[0];assert.equal(row.status,'blocked');assert.equal(row.label,'Waiting for you');
});

test('activity inspects actual terminal lines and strips ANSI controls',()=>{
 assert.equal(signal('Some previous output\n\u001b[33m• Working (4s • esc to interrupt)\u001b[0m\n'), 'active');
 assert.equal(signal('Do you want to proceed?\n1. Yes\n'+Array(20).fill('new output').join('\n')),undefined);
});
