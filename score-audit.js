#!/usr/bin/env node
/* e226: read-only audit of prematch frozen exact scores; never retune on the test set. */
const fs=require('node:fs');
const input=process.argv[2]||'cloud-pred.json';
const data=JSON.parse(fs.readFileSync(input,'utf8'));
const rows=Object.values(data.sc||{}).filter(s=>s&&s.hs!=null&&s.as!=null&&!s.void&&s.fzT&&s.fz&&s.fz.si!=null&&s.fz.sj!=null);
const pct=(a,n)=>n?+(100*a/n).toFixed(2):null;
const brier=(p,s)=>['H','D','A'].reduce((v,k)=>v+((+p[k]/100)-(k===(s.hs>s.as?'H':s.hs<s.as?'A':'D')?1:0))**2,0);
const poisson=(k,lam)=>{let f=1;for(let i=2;i<=k;i++)f*=i;return Math.exp(-lam)*lam**k/f};
function cells(p){
 const lh=+p.lh,la=+p.la,r=Number.isFinite(+p.rho)?+p.rho:0;
 if(!(lh>0&&la>0))return null;
 const out=[];let total=0;
 for(let i=0;i<=10;i++)for(let j=0;j<=10;j++){
  let t=1;if(i===0&&j===0)t=1-lh*la*r;
  else if(i===0&&j===1)t=1+lh*r;
  else if(i===1&&j===0)t=1+la*r;
  else if(i===1&&j===1)t=1-r;
  const prob=poisson(i,lh)*poisson(j,la)*Math.max(.01,t);
  out.push({i,j,prob});total+=prob;
 }
 return out.map(x=>({...x,prob:x.prob/total})).sort((a,b)=>b.prob-a.prob);
}
const out={at:new Date().toISOString(),source:input,eligible:rows.length,exact:0,top3LockedN:0,top3LockedHit:0,matrixN:0,matrixTop3:0,matrixTop5:0,brierSum:0,logLossSum:0,leagues:{}};
for(const s of rows){
 const p=s.fz;const league=s.lg||'unknown';
 const z=out.leagues[league]||(out.leagues[league]={n:0,exact:0});
 z.n++;out.exact+=+(+p.si===+s.hs&&+p.sj===+s.as);z.exact+=+(+p.si===+s.hs&&+p.sj===+s.as);
 if(Number.isFinite(+p.H)&&Number.isFinite(+p.D)&&Number.isFinite(+p.A))out.brierSum+=brier(p,s);
 if(Array.isArray(p.sc3)&&p.sc3.length){out.top3LockedN++;out.top3LockedHit+=+p.sc3.some(c=>+c.i===+s.hs&&+c.j===+s.as)}
 const c=cells(p);
 if(c){out.matrixN++;out.matrixTop3+=+c.slice(0,3).some(v=>v.i===+s.hs&&v.j===+s.as);
 out.matrixTop5+=+c.slice(0,5).some(v=>v.i===+s.hs&&v.j===+s.as);
 out.logLossSum+=-Math.log(Math.max(1e-12,c.find(v=>v.i===+s.hs&&v.j===+s.as)?.prob||0))}
}
const result={source:input,eligibleLocked:out.eligible,top1Pct:pct(out.exact,out.eligible),lockedTop3Pct:pct(out.top3LockedHit,out.top3LockedN),lockedTop3N:out.top3LockedN,matrixTop3Pct:pct(out.matrixTop3,out.matrixN),matrixTop5Pct:pct(out.matrixTop5,out.matrixN),matrixN:out.matrixN,exactScoreLogLoss:out.matrixN?+(out.logLossSum/out.matrixN).toFixed(4):null,leagues:Object.fromEntries(Object.entries(out.leagues).map(([k,v])=>[k,{n:v.n,top1Pct:pct(v.exact,v.n)}]))};
console.log(JSON.stringify(result,null,2));
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'### FIFA26 e226 賽前鎖定比分稽核\n\n'+
 '| 樣本 | Top 1 | 鎖定 Top 3 | 矩陣 Top 3 | 矩陣 Top 5 | Log Loss |\n|---:|---:|---:|---:|---:|---:|\n'+
 '|'+result.eligibleLocked+'|'+result.top1Pct+'%|'+result.lockedTop3Pct+'%|'+result.matrixTop3Pct+'%|'+result.matrixTop5Pct+'%|'+result.exactScoreLogLoss+'|\n\n');
