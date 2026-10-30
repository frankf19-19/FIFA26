#!/usr/bin/env node
/* e228: read-only, expanding-window evaluation of prematch goal multipliers.
 * Never selects using a future test fold; never changes model state.
 * Each fold independently trains on older matches, then scores the following period.
 */
'use strict';
const fs=require('node:fs');
const path=process.argv[2]||'cloud-pred.json';
const data=JSON.parse(fs.readFileSync(path,'utf8'));
const MAX=10, MIN_TRAIN=120, MIN_TEST=25;
const MULT=[0.85,0.90,0.95,1,1.05,1.10,1.15];
const logfac=Array.from({length:MAX+1},(_,i)=>{let n=0;for(let j=2;j<=i;j++)n+=Math.log(j);return n});
function parseMatch(s){
 if(!s||s.void||!s.fz||!s.fzT)return null;
 const p=s.fz, kick=Date.parse(s.date||'');
 const frozen=Number(s.fzT);
 if(!Number.isFinite(kick)||!Number.isFinite(frozen)||frozen>=kick)return null;
 const hs=Number(s.hs),as=Number(s.as),lh=Number(p.lh),la=Number(p.la);
 if(!Number.isInteger(hs)||!Number.isInteger(as)||hs<0||as<0||hs>MAX||as>MAX
 ||!Number.isFinite(lh)||!Number.isFinite(la)||lh<=0||la<=0)return null;
 return {kick,hs,as,lh,la,rho:Number.isFinite(Number(p.rho))?Number(p.rho):0,lg:s.lg||'unknown'};
}
const rows=Object.values(data.sc||{}).map(parseMatch).filter(Boolean).sort((a,b)=>a.kick-b.kick);
function tau(i,j,lh,la,r){
 if(i===0&&j===0)return Math.max(.01,1-lh*la*r);
 if(i===0&&j===1)return Math.max(.01,1+lh*r);
 if(i===1&&j===0)return Math.max(.01,1+la*r);
 if(i===1&&j===1)return Math.max(.01,1-r);
 return 1;
}
function rankAndLog(s,mh,ma){
 const lh=s.lh*mh,la=s.la*ma;
 const a=[];let z=0,actual=0;
 const hp=[Math.exp(-lh)],ap=[Math.exp(-la)];
 for(let k=1;k<=MAX;k++){hp[k]=hp[k-1]*lh/k;ap[k]=ap[k-1]*la/k;}
 for(let i=0;i<=MAX;i++)for(let j=0;j<=MAX;j++){
  const p=hp[i]*ap[j]*tau(i,j,lh,la,s.rho);z+=p;
  a.push({i,j,p});
  if(i===s.hs&&j===s.as)actual=p;
 }
 a.sort((x,y)=>y.p-x.p||(x.i-y.i)||(x.j-y.j));
 return {logLoss:-Math.log(Math.max(1e-12,actual/z)),
  top1:+(a[0].i===s.hs&&a[0].j===s.as),
  top3:+a.slice(0,3).some(x=>x.i===s.hs&&x.j===s.as),
  top5:+a.slice(0,5).some(x=>x.i===s.hs&&x.j===s.as)};
}
function score(set,mh,ma){
 const sum={n:set.length,top1:0,top3:0,top5:0,loss:0};
 for(const s of set){const v=rankAndLog(s,mh,ma);sum.top1+=v.top1;sum.top3+=v.top3;sum.top5+=v.top5;sum.loss+=v.logLoss}
 return {n:sum.n,top1Pct:sum.n?+(100*sum.top1/sum.n).toFixed(2):null,
  top3Pct:sum.n?+(100*sum.top3/sum.n).toFixed(2):null,
  top5Pct:sum.n?+(100*sum.top5/sum.n).toFixed(2):null,
  logLoss:sum.n?+(sum.loss/sum.n).toFixed(5):null};
}
function evaluate(set){
 if(set.length<MIN_TRAIN+MIN_TEST*3)return {n:set.length,folds:[],note:'insufficient strictly prematch games'};
 const n=set.length, folds=[];
 // Nonoverlapping forward periods: 40-55%, 55-70%, 70-85%, 85-100%.
 const cuts=[.40,.55,.70,.85,1].map(x=>Math.floor(n*x));
 for(let i=0;i<4;i++){
  const start=cuts[i],end=cuts[i+1];
  if(start<MIN_TRAIN||end-start<MIN_TEST)continue;
  // If kickoff timestamps tie at boundary, keep tied matches in the test window.
  // Training cutoff must be strictly before first evaluated kickoff.
  const test=set.slice(start,end);
  const train=set.slice(0,start).filter(s=>s.kick<test[0].kick);
  if(train.length<MIN_TRAIN)continue;
  let best={mh:1,ma:1,loss:Infinity};
  for(const mh of MULT)for(const ma of MULT){
   let loss=0;
   for(const s of train)loss+=rankAndLog(s,mh,ma).logLoss;
   if(loss<best.loss-1e-8)best={mh,ma,loss};
  }
  const baseline=score(test,1,1),challenger=score(test,best.mh,best.ma);
  folds.push({period:[new Date(test[0].kick).toISOString().slice(0,10),new Date(test[test.length-1].kick).toISOString().slice(0,10)],
   trainN:train.length,testN:test.length,selected:{home:best.mh,away:best.ma},
   baseline,challenger,deltaLogLoss:+(challenger.logLoss-baseline.logLoss).toFixed(5),
   deltaTop1Pct:+(challenger.top1Pct-baseline.top1Pct).toFixed(2)});
 }
 const used=folds.reduce((n,f)=>n+f.testN,0);
 const meanMetric=(v)=>used?+(folds.reduce((sum,f)=>sum+f.testN*f[v[0]][v[1]],0)/used).toFixed(5):null;
 const b=meanMetric(['baseline','logLoss']),c=meanMetric(['challenger','logLoss']);
 const baseHit=meanMetric(['baseline','top1Pct']),challHit=meanMetric(['challenger','top1Pct']);
 const wins=folds.filter(f=>f.deltaLogLoss<0).length;
 return {n,folds,totalTested:used,weightedBaselineLogLoss:b,weightedChallengerLogLoss:c,
  weightedBaselineTop1Pct:baseHit,weightedChallengerTop1Pct:challHit,
  winningFolds:wins,eligibleForFurtherResearch:folds.length>=3&&wins>=3&&c<b-.01&&challHit>=baseHit,
  note:'Research signal only. Holdout has now been inspected; no automatic production promotion.'};
}
const byLeague=Object.fromEntries([...new Set(rows.map(r=>r.lg))].sort().map(l=>[l,evaluate(rows.filter(r=>r.lg===l))]));
const report={source:path,method:'expanding-window 4 nonoverlapping forward periods',prematchEligible:rows.length,
 global:evaluate(rows),byLeague};
console.log(JSON.stringify(report,null,2));
if(process.env.GITHUB_STEP_SUMMARY){
 const g=report.global;
 let line='### e228 正確比分多期間時序回測\n\n賽前符合條件 '+rows.length+' 場，測試期間 '+g.folds.length+' 段。\n\n';
 line+='| 期間 | 訓練場次 | 測試場次 | λ 主/客倍率 | 基準 Top1 | 候選 Top1 | 基準 Log Loss | 候選 Log Loss |\n|---|---:|---:|---|---:|---:|---:|---:|\n';
 for(const f of g.folds)line+='|'+f.period.join(' 至 ')+'|'+f.trainN+'|'+f.testN+'|'+f.selected.home+'/'+f.selected.away+'|'+f.baseline.top1Pct+'%|'+f.challenger.top1Pct+'%|'+f.baseline.logLoss+'|'+f.challenger.logLoss+'|\n';
 line+='\n僅為研究報告，不會調整任何已鎖定或正式預測。\n';
 fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,line);
}
