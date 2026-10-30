'use strict';
// Missing evidence stays missing: never coerce null scores/timestamps to zero.
const number=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const goal=x=>number(x)&&Number.isInteger(Number(x))&&Number(x)>=0;
function rejection(s){
 if(!s||s.void)return 'voidOrMissing';
 if(!goal(s.hs)||!goal(s.as))return 'missingResult';
 if(!s.fz)return 'missingFrozen';
 const kick=Date.parse(s.date||'');
 if(!Number.isFinite(kick))return 'missingKickoff';
 if(!number(s.fzT)||Number(s.fzT)<=0||Number(s.fzT)>=kick)return 'notPrematch';
 return null;
}
function collect(data){
 const rejected={},rows=[];
 for(const s of Object.values(data.sc||{})){
  const why=rejection(s);
  if(why)rejected[why]=(rejected[why]||0)+1;else rows.push(s);
 }
 return {rows,rejected};
}
function availableBefore(s,cutoff){
 const kick=Date.parse(s.date||'');
 return number(s.resultObservedAt)&&Number(s.resultObservedAt)>kick&&Number(s.resultObservedAt)<cutoff;
}
module.exports={number,goal,rejection,collect,availableBefore};
