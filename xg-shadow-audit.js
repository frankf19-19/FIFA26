'use strict';
const fs=require('node:fs');
const {collect}=require('./scripts/prematch-evidence');
const {exactShadow}=require('./scripts/exact-shadow');
function actualLoss(p,hs,as){
 const mass=exactShadow(p)?.gridMass;
 if(!(mass>0))return null;
 const prob=(k,l)=>{let v=Math.exp(-l);for(let j=1;j<=k;j++)v*=l/j;return v;};
 const h=p.lh,a=p.la,r=p.rho??0;
 const tau=hs===0&&as===0?1-h*a*r:hs===0&&as===1?1+h*r:hs===1&&as===0?1+a*r:hs===1&&as===1?1-r:1;
 return -Math.log(Math.max(1e-15,prob(hs,h)*prob(as,a)*Math.max(.01,tau)/mass));
}
function compare(rows){
 let b=0,c=0,b3=0,c3=0,bl=0,cl=0,changed=0,onlyBase=0,onlyXg=0;
 for(const s of rows){
  const p=s.fz.shadowExact,q=s.fz.shadowXg,h=Number(s.hs),a=Number(s.as);
  const hit=v=>Number(v.si)===h&&Number(v.sj)===a;
  const top3=v=>v.top3.some(z=>z.i===h&&z.j===a);
  const bh=hit(p),ch=hit(q);b+=bh;c+=ch;b3+=top3(p);c3+=top3(q);
  bl+=actualLoss(p,h,a);cl+=actualLoss(q,h,a);
  changed+=p.si!==q.si||p.sj!==q.sj;onlyBase+=bh&&!ch;onlyXg+=ch&&!bh;
 }
 const n=rows.length;
 return {n,changed,onlyBase,onlyXg,baseline:{hits:b,top1:n?b/n:null,top3:n?b3/n:null,logLoss:n?bl/n:null},
  xg:{hits:c,top1:n?c/n:null,top3:n?c3/n:null,logLoss:n?cl/n:null},
  deltaTop1Points:n?100*(c-b)/n:null,weeklyPaired95:pairedInterval(rows)};
}
function pairedInterval(rows){
 const blocks=new Map();
 for(const s of rows){
  const k=Math.floor(Date.parse(s.date)/(7*86400000)),p=s.fz.shadowExact,q=s.fz.shadowXg;
  const b=blocks.get(k)||{n:0,hit:0,loss:0};
  b.n++;b.hit+=(q.si===+s.hs&&q.sj===+s.as)-(p.si===+s.hs&&p.sj===+s.as);
  b.loss+=actualLoss(q,+s.hs,+s.as)-actualLoss(p,+s.hs,+s.as);blocks.set(k,b);
 }
 const weeks=[...blocks.values()];
 if(weeks.length<8)return {weeks:weeks.length,interval:null,note:'Fewer than 8 observed calendar-week blocks; no interval reported.'};
 let seed=20261031;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
 const hit=[],loss=[];
 for(let i=0;i<2000;i++){
  let n=0,h=0,l=0;
  for(let j=0;j<weeks.length;j++){const b=weeks[Math.floor(random()*weeks.length)];n+=b.n;h+=b.hit;l+=b.loss;}
  hit.push(100*h/n);loss.push(l/n);
 }
 hit.sort((a,b)=>a-b);loss.sort((a,b)=>a-b);
 return {weeks:weeks.length,resamples:2000,deltaTop1PercentagePoints:[hit[49],hit[1949]],deltaLogLoss:[loss[49],loss[1949]]};
}
function audit(data){
 const evidence=collect(data);
 const rows=evidence.rows.filter(s=>s.fz.shadowExact?.kind==='unrestricted-dc-mode-v1'&&
  s.fz.shadowXg?.kind==='core-shot-xg-quarter-v1');
 return {method:'prospective shot-xG ablation; both candidates use unrestricted exact-score mode',
  rejected:evidence.rejected,all:compare(rows),byLeague:Object.fromEntries([...new Set(rows.map(s=>s.lg||'unknown'))].map(l=>[l,compare(rows.filter(s=>(s.lg||'unknown')===l))])),
  note:'No historical backfill or automatic promotion. These are observed-time snapshots, not proof of original source publication time.'};
}
if(require.main===module)console.log(JSON.stringify(audit(JSON.parse(fs.readFileSync(process.argv[2]||'cloud-pred.json','utf8'))),null,2));
module.exports={audit,actualLoss,pairedInterval};
