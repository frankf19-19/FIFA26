'use strict';
// Pre-registered score decision experiment: maximize P(exact score), without
// forcing the 1X2 pick or rewarding higher goal totals. No fitting, no promotion.
function exactShadow(p){
 const lh=Number(p.lh),la=Number(p.la),rho=Number(p.rho??0);
 if(!(lh>0&&la>0)||![lh,la,rho].every(Number.isFinite))return null;
 const hp=[Math.exp(-lh)],ap=[Math.exp(-la)],cells=[];
 for(let k=1;k<=15;k++){hp[k]=hp[k-1]*lh/k;ap[k]=ap[k-1]*la/k;}
 let z=0;
 for(let i=0;i<=15;i++)for(let j=0;j<=15;j++){
  const tau=i===0&&j===0?1-lh*la*rho:i===0&&j===1?1+lh*rho:i===1&&j===0?1+la*rho:i===1&&j===1?1-rho:1;
  const prob=hp[i]*ap[j]*Math.max(.01,tau);z+=prob;cells.push({i,j,p:prob});
 }
 cells.sort((a,b)=>b.p-a.p||a.i-b.i||a.j-b.j);
 return {kind:'unrestricted-dc-mode-v1',lh,la,rho,si:cells[0].i,sj:cells[0].j,
  top3:cells.slice(0,3).map(c=>({...c,p:c.p/z})),gridMass:z};
}
module.exports={exactShadow};
