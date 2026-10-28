'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {tempDir}=require('../../../test/support/tmp.cjs');
const {install,instructions}=require('../src/instructions.cjs');

test('agent instructions append once while preserving existing project rules',async()=>{
  const root=tempDir('instructions');
  await fs.writeFile(path.join(root,'AGENTS.md'),'Keep these project rules.\n');
  await install(root);
  const once=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
  assert.ok(once.startsWith('Keep these project rules.\n'));
  assert.ok(once.includes(instructions));
  await install(root);
  assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),once);
  assert.ok((await fs.readFile(path.join(root,'CLAUDE.md'),'utf8')).includes('[remove]'));
});

test('instruction installation refuses symlink targets',async()=>{
  const root=tempDir('instructions-link');
  const target=path.join(root,'original.md');
  await fs.writeFile(target,'Keep unchanged');
  await fs.symlink(target,path.join(root,'AGENTS.md'));
  await assert.rejects(install(root));
  assert.equal(await fs.readFile(target,'utf8'),'Keep unchanged');
});

test('task instructions upgrade older installations exactly once',async()=>{
 const root=tempDir('instructions-upgrade');
 await fs.writeFile(path.join(root,'AGENTS.md'),'Existing rules\n'+instructions);
 const {taskInstructions}=require('../src/instructions.cjs');
 await install(root);
 const result=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
 assert.ok(result.startsWith('Existing rules\n'+instructions));assert.ok(result.includes(taskInstructions));
 await install(root);assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),result);
});
