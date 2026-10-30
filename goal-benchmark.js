#!/usr/bin/env node
/* e227 - readonly chronological holdout benchmark for goal-expectation calibration.
 * Never writes model state or promotes parameters. Only genuinely frozen predictions.
 */
'use strict';
const fs=require('node:fs');
const evidence=require('./scripts/prematch-evidence');
const data=JSON.parse(fs.readFileSync(process.argv[2]||'cloud-pred.json','utf8'));
const lambdaGrid=[0.85,0.9,0.95,1,1.05,1.1,1.15];
const maxGoals=12;
const safeNum=n=>Number.isFinite(+n)?+n:null;
function valid(s){
  const p=s&&s.fz;
  return !evidence.rejection(s)&&p&&safeNum(p.lh)>0&&safeNum(p.la)>0&&
   Number.isInteger(+s.hs)&&Number.isInteger(+s.as)&&+s.hs>=0&&+s.as>=0&&
   +s.hs<=maxGoals&&+s.as<=maxGoals;
}
const rows=Object.values(data.sc||{}).filter(valid).map(s=>({
 league:s.lg||'unknown',resultObservedAt:s.resultObservedAt,frozen:+s.fzT,
 date:Date.parse(s.date||'')||+s.fzT,
 hs:+s.hs,as:+s.as,lh:+s.fz.lh,la:+s.fz.la,
 rho:Number.isFinite(+s.fz.rho)?+s.fz.rho:0
})).filter(s=>Number.isFinite(s.date)&&s.date>0).sort((a,b)=>a.date-b.date);
function scores(s,mh,ma){
 const lh=s.lh*mh,la=s.la*ma,r=s.rho;
 const hp=[Math.exp(-lh)],ap=[Math.exp(-la)];
 for(let k=1;k<=maxGoals;k++){hp[k]=hp[k-1]*lh/k;ap[k]=ap[k-1]*la/k;}
 const all=[];let z=0;
 for(let i=0;i<=maxGoals;i++)for(let j=0;j<=maxGoals;j++){
   let tau=1;
   if(i===0&&j===0)tau=1-lh*la*r;
   else if(i===0&&j===1)tau=1+lh*r;
   else if(i===1&&j===0)tau=1+la*r;
   else if(i===1&&j===1)tau=1-r;
   const prob=hp[i]*ap[j]*Math.max(.01,tau);
   z+=prob;all.push({i,j,prob});
 }
 all.forEach(x=>x.prob/=z);all.sort((a,b)=>b.prob-a.prob);
 return all;
}
function evaluate(set,mh,ma){
 let hit=0,top3=0,top5=0,ll=0,homeBias=0,awayBias=0;
 for(const s of set){
  const dist=scores(s,mh,ma),actual=dist.find(x=>x.i===s.hs&&x.j===s.as);
  hit+=+(dist[0].i===s.hs&&dist[0].j===s.as);
  top3+=+dist.slice(0,3).some(x=>x.i===s.hs&&x.j===s.as);
  top5+=+dist.slice(0,5).some(x=>x.i===s.hs&&x.j===s.as);
  ll+=-Math.log(Math.max(1e-12,actual?.prob||0));
  homeBias+=s.hs-s.lh*mh;awayBias+=s.as-s.la*ma;
 }
 const n=set.length||1;
 return {n:set.length,top1Pct:+(100*hit/n).toFixed(2),top3Pct:+(100*top3/n).toFixed(2),
  top5Pct:+(100*top5/n).toFixed(2),logLoss:+(ll/n).toFixed(5),
  goalsResidualHome:+(homeBias/n).toFixed(3),goalsResidualAway:+(awayBias/n).toFixed(3)};
}
function run(set){
 if(set.length<100)return {n:set.length,note:'Fewer than 100 qualifying frozen results: no model comparison'};
 const split=Math.floor(set.length*0.7),test=set.slice(split);
 const cutoff=Math.min(...test.map(s=>s.frozen));
 const train=set.slice(0,split).filter(s=>s.date<cutoff&&evidence.availableBefore({...s,date:new Date(s.date).toISOString()},cutoff));
 if(train.length<70)return {n:set.length,trainN:train.length,note:"Insufficient results observed before test forecast time"};
 // Select parameters ONLY on older training games; compare on untouched newer games.
 const candidates=[];
 for(const mh of lambdaGrid)for(const ma of lambdaGrid)
   candidates.push({mh,ma,train:evaluate(train,mh,ma)});
 candidates.sort((a,b)=>a.train.logLoss-b.train.logLoss);
 const winner=candidates[0];
 const base=evaluate(test,1,1),challenger=evaluate(test,winner.mh,winner.ma);
 const delta=+(challenger.logLoss-base.logLoss).toFixed(5);
 return {n:set.length,trainN:train.length,testN:test.length,
  splitDate:new Date(test[0].date).toISOString().slice(0,10),
  chosenOnTraining:{homeMultiplier:winner.mh,awayMultiplier:winner.ma,trainingLogLoss:winner.train.logLoss},
  holdout:{baseline:base,challenger,deltaLogLoss:delta,
   hasEvidenceOfImprovement:delta<-.01&&challenger.top1Pct>=base.top1Pct},
  note:'Exploratory holdout only: candidate is not deployed; repeat walk-forward across multiple time windows before promotion.'};
}
const output={source:process.argv[2]||'cloud-pred.json',lockedWithGoals:rows.length,
 global:run(rows),byLeague:Object.fromEntries([...new Set(rows.map(s=>s.league))].sort().map(l=>[l,run(rows.filter(s=>s.league===l))]))};
console.log(JSON.stringify(output,null,2));
if(process.env.GITHUB_STEP_SUMMARY){
 const g=output.global,h=g.holdout;
 fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  '### e227 進球期望值時序留出測試\n\n'+
  (h?('| 賽前樣本 | 訓練 | 測試 | 切點 | 原始 Top1 | 候選 Top1 | 原始 Log Loss | 候選 Log Loss |\n'+
  '|---:|---:|---:|---|---:|---:|---:|---:|\n'+
  '|'+g.n+'|'+g.trainN+'|'+g.testN+'|'+g.splitDate+'|'+h.baseline.top1Pct+'%|'+h.challenger.top1Pct+'%|'+h.baseline.logLoss+'|'+h.challenger.logLoss+'|\n\n'):
  ('Not enough locked completed matches ('+g.n+').\n\n'))+
  '**注意：此工具不會修改預測或自動採用候選參數。**\n');
}
