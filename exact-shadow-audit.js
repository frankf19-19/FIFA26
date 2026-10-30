'use strict';
const fs=require('node:fs');
const {collect}=require('./scripts/prematch-evidence');
const evidence=collect(JSON.parse(fs.readFileSync(process.argv[2]||'cloud-pred.json','utf8')));
const rows=evidence.rows.filter(s=>s.fz.shadowExact?.kind==='unrestricted-dc-mode-v1');
function agg(rows){
 let baseline=0,shadow=0,onlyBaseline=0,onlyShadow=0;
 for(const s of rows){
  const p=s.fz,q=p.shadowExact,b=+p.si===+s.hs&&+p.sj===+s.as,c=q.si===+s.hs&&q.sj===+s.as;
  baseline+=b;shadow+=c;onlyBaseline+=b&&!c;onlyShadow+=c&&!b;
 }
 return {n:rows.length,baselineHits:baseline,shadowHits:shadow,onlyBaseline,onlyShadow,
  deltaPercentagePoints:rows.length?100*(shadow-baseline)/rows.length:null};
}
console.log(JSON.stringify({method:'prospective paired exact-score decision experiment',rejected:evidence.rejected,
 all:agg(rows),byLeague:Object.fromEntries([...new Set(rows.map(s=>s.lg))].map(l=>[l,agg(rows.filter(s=>s.lg===l))])),
 note:'Only recorded prematch shadow forecasts. No reconstructed history, no automatic promotion.'},null,2));
