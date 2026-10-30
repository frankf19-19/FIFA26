'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {xgShadow}=require('../scripts/xg-shadow');
const {exactShadow}=require('../scripts/exact-shadow');
const {audit,actualLoss,pairedInterval}=require('../xg-shadow-audit');
const p=()=>({core:1,lh:1.5,la:1,rho:0,xg:{real:1,nH:25,nA:30,hFactor:1.4,aFactor:.8}});
test('shot xG experiment requires real source, coverage and domestic core model',()=>{
 assert.ok(xgShadow(p(),'eng.1'));
 assert.equal(xgShadow({...p(),core:0},'eng.1'),null);
 assert.equal(xgShadow(p(),'uefa.champions'),null);
 for(const change of [{real:0},{nH:19},{hFactor:null},{aFactor:Infinity}])
  assert.equal(xgShadow({...p(),xg:{...p().xg,...change}},'eng.1'),null);
});
test('fixed correction is bounded and preserves input and score objective',()=>{
 const v=p(),copy=JSON.stringify(v),q=xgShadow(v,'eng.1');
 assert.equal(JSON.stringify(v),copy);
 assert.equal(q.lh,v.lh*Math.exp(.25*Math.log(v.xg.hFactor)));
 assert.equal(q.si,exactShadow(q).si);assert.equal(q.sj,exactShadow(q).sj);
 const big=xgShadow({...p(),xg:{...p().xg,hFactor:1e9,aFactor:1e-9}},'eng.1');
 assert.equal(big.homeLogShift,.1);assert.equal(big.awayLogShift,-.1);
});
test('audit uses matched prospective frozen samples, excluding null results and late freezes',()=>{
 const v=p(),b=exactShadow(v),q=xgShadow(v,'eng.1');
 const s={date:'2026-10-01T12:00:00Z',fzT:Date.parse('2026-10-01T11:59:00Z'),hs:q.si,as:q.sj,lg:'eng.1',fz:{shadowExact:b,shadowXg:q}};
 const out=audit({sc:{good:s,missing:{...s,hs:null},late:{...s,fzT:Date.parse(s.date)}}});
 assert.equal(out.all.n,1);assert.equal(out.all.xg.hits,1);
 assert.ok(Number.isFinite(out.all.xg.logLoss));
 assert.ok(Math.abs(actualLoss({lh:1,la:1,rho:0},0,0)-2)<1e-10);
});
test('weekly paired interval is deterministic and preserves same-forecast zero difference',()=>{
 const b=exactShadow(p()),rows=[];
 for(let k=0;k<10;k++)rows.push({date:new Date(Date.UTC(2026,0,1)+k*7*86400000).toISOString(),hs:1,as:0,fz:{shadowExact:b,shadowXg:b}});
 assert.deepEqual(pairedInterval(rows).deltaTop1PercentagePoints,[0,0]);
 assert.deepEqual(pairedInterval(rows).deltaLogLoss,[0,0]);
 assert.deepEqual(pairedInterval(rows),pairedInterval(rows));
 assert.equal(pairedInterval([]).interval,null);
});
