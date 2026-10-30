'use strict';
const {exactShadow}=require('./exact-shadow');
// Fixed prospective ablation: reintroduce only a quarter of the recorded
// shot-xG correction overwritten by compact-core. Same score objective as
// shadowExact, so the comparison isolates lambda changes, not score selection.
function xgShadow(p,league){
 if(!['eng.1','esp.1','ita.1','ger.1','fra.1'].includes(league))return null;
 const x=p&&p.xg;
 if(!p?.core||x?.real!==1||!(x.nH>=20&&x.nA>=20))return null;
 if(![x.hFactor,x.aFactor].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0))return null;
 const shift=v=>Math.max(-.1,Math.min(.1,.25*Math.log(v)));
 const dh=shift(x.hFactor),da=shift(x.aFactor);
 const q=exactShadow({...p,lh:Number(p.lh)*Math.exp(dh),la:Number(p.la)*Math.exp(da)});
 return q?{...q,kind:'core-shot-xg-quarter-v1',source:'Understat via calib',
  sourceLeague:league,sampleHome:x.nH,sampleAway:x.nA,homeLogShift:dh,awayLogShift:da}:null;
}
module.exports={xgShadow};
