'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {rejection,availableBefore}=require('../scripts/prematch-evidence');
const {exactShadow}=require('../scripts/exact-shadow');
const kick=Date.parse('2026-10-01T12:00:00Z');
const row=()=>({date:new Date(kick).toISOString(),fzT:kick-60000,hs:0,as:0,fz:{lh:1.5,la:1,rho:0,si:1,sj:0}});
test('requires actual result and positive strictly prematch timestamp',()=>{
 assert.equal(rejection(row()),null);
 for(const value of [null,undefined,'',NaN]){
  assert.equal(rejection({...row(),hs:value}),'missingResult');
  assert.equal(rejection({...row(),fzT:value}),'notPrematch');
 }
 assert.equal(rejection({...row(),fzT:kick}),'notPrematch');
 assert.equal(rejection({...row(),date:undefined}),'missingKickoff');
});
test('result must have been observed before decision, not just kicked off',()=>{
 assert.equal(availableBefore(row(),kick+86400000),false);
 const s={...row(),resultObservedAt:kick+3*3600000};
 assert.equal(availableBefore(s,kick+3600000),false);
 assert.equal(availableBefore(s,s.resultObservedAt),false);
 assert.equal(availableBefore(s,s.resultObservedAt+1),true);
});
test('exact score objective uses probability maximum and keeps input immutable',()=>{
 const p={lh:1.5,la:.6,rho:0,si:3,sj:1},before=JSON.stringify(p),q=exactShadow(p);
 assert.deepEqual([q.si,q.sj],[1,0]);assert.equal(JSON.stringify(p),before);
 assert.ok(q.top3.every(c=>c.p>0&&c.p<1));assert.ok(q.gridMass>.999999);
 assert.equal(exactShadow({lh:NaN,la:1}),null);
});
test('production workflow executes the instrumented entry point',()=>{
 const workflow=fs.readFileSync('.github/workflows/cloud-pred.yml','utf8');
 assert.match(workflow,/node scripts\/predict-euro.js/);
 const active=fs.readFileSync('scripts/predict-euro.js','utf8');
 assert.match(active,/shadowExact:exactShadow\(pp\)/);assert.match(active,/shadowXg:xgShadow\(pp,l.id\)/);assert.match(active,/rho: pp.rho, factors/);
 assert.match(active,/if\(capturedAt>=kick\)continue/);
});
test('walk-forward excludes outcomes unavailable at earliest test snapshot',()=>{
 const os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fifa-evidence-'));
 try{
  const sc={};
  for(let i=0;i<400;i++){
   const t=kick+i*86400000;
   sc[i]={...row(),date:new Date(t).toISOString(),fzT:t-86400000,resultObservedAt:t+3*3600000};
  }
  const file=path.join(dir,'fixture.json');fs.writeFileSync(file,JSON.stringify({sc}));
  const result=JSON.parse(execFileSync(process.execPath,['multiwindow-benchmark.js',file],{encoding:'utf8'}));
  assert.equal(result.global.folds.length,4);
  // First test is index 160, captured at day 159. Index 159's result was not yet known.
  assert.equal(result.global.folds[0].trainN,159);
  for(const s of Object.values(sc))delete s.resultObservedAt;
  fs.writeFileSync(file,JSON.stringify({sc}));
  const unknown=JSON.parse(execFileSync(process.execPath,['multiwindow-benchmark.js',file],{encoding:'utf8'}));
  assert.equal(unknown.global.folds.length,0);
 }finally{fs.unlinkSync(path.join(dir,'fixture.json'));fs.rmdirSync(dir);}
});
test('real grading path preserves prematch evidence and never rewrites scored history',async()=>{
 const {JSDOM}=require('jsdom');
 const html=fs.readFileSync('index.html','utf8');
 const dom=new JSDOM('',{runScripts:'outside-only',url:'https://example.test'}),w=dom.window;
 try{
  let js=html.match(/<script>([\s\S]*)<\/script>/)[1].replace(/\binit\(\);?\s*$/,'');
  w.fetch=async()=>{throw new Error('Offline test: unexpected request');};
  w.eval(js+`;window.testAPI={gradeFinished,scGet,scSet};predict=()=>({H:50,D:30,A:20,dq:1,si:1,sj:0,conf:'中',pick:'Home'});noPredGate=()=>false;`);
  const frozen={H:50,D:30,A:20,si:1,sj:0,lh:1.5,la:1,rho:0,factors:{capturedAt:new Date(kick-60000).toISOString()}};
  const ex={...row(),hs:undefined,as:undefined,pred:frozen,fz:frozen,t:1,tU:kick-60000,locked:1,dq:1,lg:'eng.1',cal:1,adj:1};
  w.testAPI.scSet({one:ex});
  const game={id:'one',completed:true,hs:1,as:0,hn:'Home',an:'Away',date:ex.date,league:'eng.1',hid:'1',aid:'2'};
  await w.testAPI.gradeFinished([game]);
  const after=w.testAPI.scGet().one;
  assert.equal(after.date,ex.date);assert.ok(after.resultObservedAt>kick);
  assert.equal(JSON.stringify(after.fz),JSON.stringify(frozen));
  const saved=JSON.stringify(after);await w.testAPI.gradeFinished([game]);
  assert.equal(JSON.stringify(w.testAPI.scGet().one),saved);
 }finally{w.close();}
});
