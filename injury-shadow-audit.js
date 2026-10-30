#!/usr/bin/env node
/* e229: read-only forward scorecard for injury-aware pre-match shadow forecast.
 * Compare exactly the same strictly prematch frozen games. No retrospective
 * generation of shadow predictions; no automatic model promotion.
 */
'use strict';
const fs=require('node:fs');
const f=process.argv[2]||'cloud-pred.json';
const raw=JSON.parse(fs.readFileSync(f,'utf8'));
const rows=Object.values(raw.sc||{}).filter(s=>{
 if(require('./scripts/prematch-evidence').rejection(s)||!s.fz.shadowInjury)return false;
 const t=Date.parse(s.date||'');
 if(!Number.isFinite(t)||+s.fzT>=t)return false;
 const p=s.fz,alt=p.shadowInjury;
 return [s.hs,s.as,p.si,p.sj,alt.si,alt.sj].every(x=>Number.isInteger(Number(x))&&Number(x)>=0);
});
const agg=ss=>{
 let base=0,shadow=0,changed=0,baseChanged=0,shadowChanged=0;
 for(const s of ss){
  const p=s.fz,alt=p.shadowInjury,actual=+s.hs+'-'+(+s.as),b=+p.si+'-'+(+p.sj),a=+alt.si+'-'+(+alt.sj);
  base+=+(b===actual);shadow+=+(a===actual);
  if(a!==b){changed++;baseChanged+=+(b===actual);shadowChanged+=+(a===actual)}
 }
 const n=ss.length,pct=x=>n?+(100*x/n).toFixed(2):null;
 return {n,baselineHits:base,shadowHits:shadow,baselinePct:pct(base),
  shadowPct:pct(shadow),changedPredictions:changed,baselineHitsChanged:baseChanged,
  shadowHitsChanged:shadowChanged};
};
const out={method:'strictly frozen pre-match shadow vs existing production score',all:agg(rows),
 byLeague:Object.fromEntries([...new Set(rows.map(s=>s.lg||'unknown'))].sort().map(l=>[l,agg(rows.filter(s=>(s.lg||'unknown')===l))])),
 note:'No historical shadow backfill, no auto-promotion. These are prospective comparisons only.'};
console.log(JSON.stringify(out,null,2));
if(process.env.GITHUB_STEP_SUMMARY){
 const g=out.all;
 fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  '### e229 球員傷停影子預測（嚴格賽前樣本）\n\n'+
  '| 場次 | 正式比分命中 | 影子比分命中 | 預測不同場次 |\n|---:|---:|---:|---:|\n'+
  '|'+g.n+'|'+g.baselineHits+' ('+g.baselinePct+'%)|'+g.shadowHits+' ('+g.shadowPct+'%)|'+g.changedPredictions+'|\n\n'+
  '不回填影子預測，不修改正式模型。\n');
}
