'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {reviewLabel,isOrderedTitle}=require('../src/review-label.cjs');
const {html}=require('../src/pull-request.cjs');
test('ordered review titles retain their own priority code rather than a GitHub or backlog prefix',()=>{
 for(const title of ['001-STATE: Engine assurance','002-UX: Workbook overview','003-MATH: Typed kernels and safe reuse']){
  assert.equal(isOrderedTitle(title),true);
  for(const code of ['#28','GF-ADMIN-01',''])assert.equal(reviewLabel(title,code),title);
  for(const local of [true,false])assert.ok(html({title,local,number:28,body:''},[]).includes('<h1>'+title+'</h1>'));
 }
 assert.equal(reviewLabel('Decision: GF-ADMIN-01 — Engineering workspace','GF-ADMIN-01'),'GF-ADMIN-01 · Decision · Engineering workspace');
 assert.equal(reviewLabel('Regular review','#3'),'#3 · Regular review');
 for(const title of ['01-UX: Short','1234-UX: Long','001-ux: Lowercase','001-UX Missing colon','001-UX: '])assert.equal(isOrderedTitle(title),false);
 assert.match(html({title:'Regular review',number:3,body:''},[]),/<h1>#3 Regular review<\/h1>/);
});
