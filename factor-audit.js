#!/usr/bin/env node
/* e230: read-only audit of prematch model-factor provenance.
 * Counts historical frozen evidence only; never fills missing historical inputs. */
'use strict';
const fs=require('node:fs');
const file=process.argv[2]||'cloud-pred.json';
const data=JSON.parse(fs.readFileSync(file,'utf8'));
const fields=['lineup','injuries','squad','xg','rest','process','headToHead','weather','tier'];
const rows=Object.values(data.sc||{}).filter(s=>s&&s.fz&&s.fzT);
const out={source:file,frozenRows:rows.length,
 withFactors:0,strictPrematch:0,withPublishedLineup:0,withInjuryContext:0,byField:Object.fromEntries(fields.map(x=>[x,0])),byLeague:{}};
for(const s of rows){
 const p=s.fz, f=p.factors;if(!f||require('./scripts/prematch-evidence').rejection({...s,hs:0,as:0}))continue;
 out.withFactors++;
 const kickoff=Date.parse(s.date||'');
 if(Number.isFinite(kickoff)&&+s.fzT<kickoff)out.strictPrematch++;
 const league=s.lg||'unknown';
 const L=out.byLeague[league]||(out.byLeague[league]={withFactors:0,lineups:0,injuries:0});
 L.withFactors++;
 for(const field of fields)if(f[field]!=null){out.byField[field]++;if(field==='lineup'){L.lineups++;out.withPublishedLineup++;}if(field==='injuries'){L.injuries++;out.withInjuryContext++;}}
}
console.log(JSON.stringify(out,null,2));
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
 '### e230 賽前預測特徵來源覆蓋率\n\n'+
 '| 凍結預測 | 有特徵來源 | 嚴格賽前 | 有先發強度 | 有傷停個別資訊 |\n|---:|---:|---:|---:|---:|\n'+
 '|'+out.frozenRows+'|'+out.withFactors+'|'+out.strictPrematch+'|'+out.withPublishedLineup+'|'+out.withInjuryContext+'|\n\n'+
 '舊資料缺少特徵來源時不回填；所有指標僅計入賽前快照。\n');
