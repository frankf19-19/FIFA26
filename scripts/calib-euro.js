/* 歐陸足球雲端校準 v10(v9 + 先發陣容「有他/沒他」球員影響力學習 + 天氣留底與聯賽天氣進球比):可中斷續跑(checkpoint)+ 逐場賽果帳本 matches.json(回測用)
   + 比賽過程(半場比分、進球時間、紅黃牌、射門、犯規)→ 每隊「過程體質」指標(領先守成率、落後追平率、下半場淨進球、紅牌率)。
   每完成一個聯賽 → 立刻寫入 calib.json 並 commit+push;
   中斷重跑時,跳過「當天已完成」的聯賽,從斷點接續。 */
const { execSync } = require("child_process");
const fs = require("fs");
const LEAGUES = ["eng.1","esp.1","ita.1","ger.1","fra.1","uefa.champions","uefa.europa","usa.1","jpn.1","eng.2","sco.1",
  "por.1","ned.1","tur.1","bel.1"];   // v12:葡超/荷甲/土超/比甲 —— 只為歐冠/歐霸對手提供球隊資料(前端不列賽程)
const WEEKS = 26;
/* v15:時間衰減半衰期 —— 原本 60 天。用 2279 場帳本做滾動回測(以最後 120 天為保留區間、
   完全不參與調參),60 天:Brier 0.6617/命中 44.8%;120 天:Brier 0.6356/命中 47.1%。
   60 天衰減太快,等於丟掉太多有效樣本;拉長到 120 天在保留區間穩定較佳。 */
const HALF_LIFE = 120;
/* v16:先發陣容強度基準 —— 用帳本裡每場的先發名單(xi)與球隊名冊的球員產出,
   算出每隊「平常派出的先發強度」。賽前拿到當日先發名單後,就能算出
   「今天的陣容 ÷ 平常的陣容」,反映輪換、休息、傷病的真實影響。
   實測(1078 場):強度比 0.6x → 場均 1.18 球、1.0x → 1.52 球、1.2x → 1.67 球。 */
/* ===== v17:Understat 射門級 xG(英超/西甲/德甲/義甲/法甲)=====
   ESPN 沒有射門位置與品質,只能用「射正 × 聯賽轉換率」粗估 xG。Understat 有每一腳射門的 xG,
   以及每個球員的 xG/xA。網頁內嵌 JSON(teamsData / datesData / playersData),不需要 API 金鑰。
   寫入:
     隊伍  t.ux = { n, xg, xga, npxg }   (近 HALF_LIFE 衰減加權的場均)
     球員  out.upr[名字正規化|隊名正規化] = (xG+0.7xA)/games  → buildXiBase 優先採用
   任何失敗都只印 log,不影響其他流程。 */
const UNDERSTAT={ "eng.1":"EPL", "esp.1":"La_liga", "ger.1":"Bundesliga", "ita.1":"Serie_A", "fra.1":"Ligue_1" };
const US_ALIAS={ "wolverhampton wanderers":"wolverhampton", "tottenham":"tottenham hotspur", "manchester utd":"manchester united",
  "newcastle united":"newcastle", "brighton":"brighton & hove albion", "west ham":"west ham united", "nottingham forest":"nottingham forest",
  "atletico madrid":"atlético madrid", "athletic club":"athletic bilbao", "alaves":"deportivo alavés", "real betis":"real betis balompié",
  "celta vigo":"celta de vigo", "rayo vallecano":"rayo vallecano", "espanyol":"espanyol", "girona":"girona",
  "bayern munich":"bayern münchen", "borussia dortmund":"borussia dortmund", "borussia m.gladbach":"borussia mönchengladbach",
  "bayer leverkusen":"bayer 04 leverkusen", "rb leipzig":"rb leipzig", "eintracht frankfurt":"eintracht frankfurt", "freiburg":"sc freiburg",
  "fc koln":"1. fc köln", "st. pauli":"fc st. pauli", "union berlin":"1. fc union berlin", "heidenheim":"1. fc heidenheim",
  "hoffenheim":"tsg 1899 hoffenheim", "wolfsburg":"vfl wolfsburg", "augsburg":"fc augsburg", "mainz":"1. fsv mainz 05",
  "werder bremen":"sv werder bremen", "hamburg sv":"hamburger sv", "stuttgart":"vfb stuttgart",
  "internazionale":"inter", "inter milan":"inter", "ac milan":"milan", "as roma":"roma", "hellas verona":"verona",
  "paris saint-germain":"paris saint germain", "marseille":"olympique marseille", "lyon":"olympique lyonnais", "lille":"lille",
  "monaco":"monaco", "nice":"nice", "saint-etienne":"saint-etienne", "lens":"lens" };
function usNorm(x){ return String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/\b(fc|cf|sc|ac|as|ud|cd|sd|rcd|sv|vfb|vfl|tsg|bsc|fsv|ssc|us|afc)\b/g,"").replace(/[^a-z0-9]+/g," ").trim(); }
function usParse(html,key){
  const m=html.match(new RegExp("var\\s+"+key+"\\s*=\\s*JSON\\.parse\\('([^']*)'\\)"));
  if(!m) return null;
  const txt=m[1].replace(/\\x([0-9A-Fa-f]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  try{ return JSON.parse(txt); }catch(e){ return null; }
}
async function understat(out){
  const now=Date.now(); const yr=(new Date().getUTCMonth()+1>=7)?new Date().getUTCFullYear():new Date().getUTCFullYear()-1;
  out.upr=out.upr||{}; let teamsHit=0, teamsMiss=[], players=0;
  for(const lg in UNDERSTAT){
    const L=out.leagues[lg]; if(!L||!L.teams) continue;
    try{
      const url=`https://understat.com/league/${UNDERSTAT[lg]}/${yr}`;
      const r=await fetch(url,{headers:{"User-Agent":"Mozilla/5.0","Accept":"text/html"}});
      if(!r.ok){ console.log("understat",lg,"HTTP",r.status); continue; }
      const html=await r.text();
      const teams=usParse(html,"teamsData"), players_=usParse(html,"playersData");
      if(!teams){ console.log("understat",lg,"no teamsData"); continue; }
      // 建立 understat 隊名 → calib 隊物件
      const T=L.teams; const byNorm={};
      for(const k in T){ if(k[0]==="#"||!T[k]||T[k].$) continue; byNorm[usNorm(k)]=T[k]; const al=US_ALIAS[k]; if(al) byNorm[usNorm(al)]=T[k]; }
      const usTeamNorm={};
      for(const id in teams){ const u=teams[id]; const nm=usNorm(u.title); usTeamNorm[u.title]=nm;
        let t=byNorm[nm]; if(!t){ const k2=Object.keys(byNorm).find(k=>k&&(nm.includes(k)||k.includes(nm))); if(k2) t=byNorm[k2]; }
        if(!t){ teamsMiss.push(lg+":"+u.title); continue; }
        let sw=0,xg=0,xga=0,npxg=0,n=0;
        for(const h of (u.history||[])){ const d=Date.parse(h.date); if(!(d>0)) continue;
          const w=Math.max(0.25,Math.exp(-Math.LN2*((now-d)/86400000)/HALF_LIFE));
          sw+=w; xg+=w*(+h.xG||0); xga+=w*(+h.xGA||0); npxg+=w*(+h.npxG||0); n++; }
        if(n>=3&&sw>0){ t.ux={ n, xg:+(xg/sw).toFixed(3), xga:+(xga/sw).toFixed(3), npxg:+(npxg/sw).toFixed(3) }; teamsHit++; }
      }
      if(Array.isArray(players_)){ for(const p of players_){ const g=+p.games||0; if(g<3) continue;
        const key=usNorm(p.player_name)+"|"+usNorm(p.team_title);
        out.upr[key]=+(((+p.xG||0)+0.7*(+p.xA||0))/g).toFixed(4); players++; } }
      await new Promise(r=>setTimeout(r,800));
    }catch(e){ console.log("understat",lg,"failed:",e.message); }
  }
  console.log(`understat: 隊伍 ${teamsHit} 命中,未對應 ${teamsMiss.length}${teamsMiss.length?" ["+teamsMiss.slice(0,8).join(", ")+"]":""}; 球員 ${players}`);
}
let UPR_HIT=0;
function buildXiBase(out){
  try{
    const PR={};
    for(const lg in (out.leagues||{})){
      const T=(out.leagues[lg]||{}).teams||{};
      const nameOf=new Map(); for(const k in T){ if(k[0]!=="#"&&T[k]&&!T[k].$) nameOf.set(T[k],k); }   // v17:別名鍵 → 隊名
      for(const k in T){ const t=T[k];
        if(k[0]!=="#"||!t||!Array.isArray(t.r)) continue;
        for(const a of t.r){
          if(!Array.isArray(a[4])||!a[4].length) continue;
          const b=a[4].reduce((m,x)=>((+x[1]||0)>(+m[1]||0)?x:m),a[4][0]);
          const app=+b[1]||0; if(app<3) continue;
          let v=((+b[2]||0)+0.7*(+b[3]||0))/app;
          // v17:Understat 的 xG+xA 較不受幸運進球影響;有的話優先(依 名字|隊名 對應)
          try{ if(out.upr){ const tn=usNorm(nameOf.get(t)||""); const key=usNorm(a[1])+"|"+tn; if(out.upr[key]!=null){ v=out.upr[key]; UPR_HIT++; } } }catch(e){}
          PR[String(a[0])]=v;
        }
      }
    }
    const strOf=str=>{ const ids=String(str||"").split(",").filter(Boolean);
      const v=ids.map(x=>PR[x]).filter(x=>x!=null);
      if(v.length<6) return null;
      return v.sort((a,b)=>b-a).slice(0,11).reduce((s,x)=>s+x,0); };
    const acc={};
    for(const id in MATCHES){ const M=MATCHES[id];
      if(!M||!Array.isArray(M.xi)||M.xi.length!==2) continue;
      const sh=strOf(M.xi[0]), sa=strOf(M.xi[1]);
      const kh=M.lg+"|"+M.hid, ka=M.lg+"|"+M.aid;
      if(sh!=null){ (acc[kh]=acc[kh]||[0,0])[0]+=sh; acc[kh][1]++; }
      if(sa!=null){ (acc[ka]=acc[ka]||[0,0])[0]+=sa; acc[ka][1]++; }
    }
    let wrote=0;
    for(const key in acc){ const [sum,n2]=acc[key]; if(n2<5) continue;
      const [lg,tid]=key.split("|"); const T=(out.leagues[lg]||{}).teams;
      if(T&&T["#"+tid]){ T["#"+tid].xiB=+(sum/n2).toFixed(4); T["#"+tid].xiN=n2; wrote++; }
    }
    out.pr=PR;
    console.log("xiBase teams="+wrote+" players="+Object.keys(PR).length+" (understat xG+xA 覆蓋 "+UPR_HIT+" 人)");
  }catch(e){ console.log("buildXiBase failed:", e.message); }
}

const WEEKS_CUP = 60;   // v14:歐冠/歐霸賽季 9 月~5 月,26 週只掃得到淘汰賽尾巴 → 盃賽掃 60 週(約 14 個月),完整涵蓋上一屆
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const sb = (lg,a,b) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${a}-${b}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const flatWalk = d => { const f={}; (function w(o){ if(!o||typeof o!=="object")return;
  if(Array.isArray(o)){o.forEach(w);return;}
  const k=o.name||o.abbreviation, v=o.displayValue!=null?o.displayValue:(o.value!=null?o.value:null);
  if(k&&v!=null&&(typeof v==="string"||typeof v==="number")&&f[k]==null)f[k]=v;
  for(const q in o)w(o[q]); })(d); return f; };

/* v12:原始場數(gn/hgn/agn/nr/stnr)與衰減加權分離 —— 衰減只影響「比率」,樣本門檻改看原始場數(開季前 2 個月各層不再被誤關)
/* v8:逐場賽果帳本(以 ESPN event id 為鍵,跨日累積、永不刪除 → 歷史會越來越長,供離線回測) */
let MATCHES = {};
try { MATCHES = JSON.parse(fs.readFileSync("matches.json","utf8")) || {}; } catch(e) { MATCHES = {}; }
function saveMatches(){
  const keys = Object.keys(MATCHES).sort((a,b)=>(MATCHES[a].d||"").localeCompare(MATCHES[b].d||""));
  const o={}; keys.forEach(k=>o[k]=MATCHES[k]);
  fs.writeFileSync("matches.json", JSON.stringify(o));
}
/* v12:輸出瘦身 —— 隊名別名鍵原本與 "#id" 指向同一物件,JSON 會寫兩份(檔案 ×2);改寫成 {$:"#id"},前端/雲端載入時還原 */
function slimOut(out){
  const o={...out, leagues:{}};
  for(const lg in (out.leagues||{})){ const L=out.leagues[lg]; if(!L||!L.teams){ o.leagues[lg]=L; continue; }
    const T=L.teams, T2={}, idOf=new Map();
    for(const k in T) if(k[0]==="#") idOf.set(T[k],k);
    for(const k in T){ const t=T[k]; T2[k]=(k[0]!=="#"&&t&&idOf.has(t))?{$:idOf.get(t)}:t; }
    o.leagues[lg]={...L, teams:T2}; }
  return o;
}
function unslim(out){ try{ for(const lg in (out.leagues||{})){ const T=out.leagues[lg]&&out.leagues[lg].teams; if(!T) continue; for(const k in T){ const t=T[k]; if(t&&t.$&&T[t.$]) T[k]=T[t.$]; } } }catch(e){} return out; }
/* v13:Dixon-Coles 低分相關係數 rho 實測擬合(最大概似,格點搜尋)
   —— 前端原本寫死 -0.13,實測 1975 場合併後約 -0.01,各聯賽 -0.37~+0.14 差異很大;
      寫死的負值會把 1-1 的機率灌水約 13%,導致精準比分過度集中在 1-1。
      樣本不足時往 0 收縮:rho_out = rho_fit × n/(n+150) */
function fitRho(rows){
  try{
    if(!rows || rows.length<60) return null;
    const N=rows.length;
    const lh=rows.reduce((s,r)=>s+r[0],0)/N, la=rows.reduce((s,r)=>s+r[1],0)/N;
    const fact=[1,1,2,6,24,120,720,5040,40320];
    const pois=(l,k)=>k<9?Math.exp(-l)*Math.pow(l,k)/fact[k]:1e-9;
    const tau=(i,j,r)=> (i===0&&j===0)?1-lh*la*r : (i===0&&j===1)?1+lh*r : (i===1&&j===0)?1+la*r : (i===1&&j===1)?1-r : 1;
    let best=null;
    for(let k=-40;k<=25;k++){
      const r=k/100; let ll=0, bad=false;
      for(const [i,j] of rows){
        const t=tau(i,j,r); if(t<=0.01){ bad=true; break; }
        ll+=Math.log(Math.max(pois(lh,i)*pois(la,j)*t,1e-12));
      }
      if(bad) continue;
      if(!best || ll>best[1]) best=[r,ll];
    }
    if(!best) return null;
    return +(best[0]*N/(N+150)).toFixed(3);   // 樣本收縮
  }catch(e){ return null; }
}
function save(out, lg){
  out.updated = new Date().toISOString();
  fs.writeFileSync("calib.json", JSON.stringify(slimOut(out)));
  try { saveMatches(); } catch(e) {}
  if (process.env.GIT_PUSH === "1") {
    try {
      execSync(`git add calib.json matches.json && (git diff --cached --quiet || git commit -m "calib checkpoint: ${lg}")`, {stdio:"inherit"});
      execSync(`git pull --rebase origin main || (git rebase --abort; git pull --no-rebase -X ours origin main)`, {stdio:"inherit", shell:"/bin/bash"});
      execSync(`git push`, {stdio:"inherit"});
    } catch(e) { console.log("push 暫時失敗(資料已寫入,下個 checkpoint 再試):", String(e).slice(0,80)); }
  }
}

const SOT_G={}, SOT_S={}, SOT_C={};
/* v9:從 summary.keyEvents 抽出比賽過程。回傳 {ht:[h,a], gm:"12H,45A,78H", rc:[h,a], yc:[h,a]} */
function parseProcess(sj, homeId){
  const ev=(sj&&sj.keyEvents)||[]; if(!ev.length) return null;
  const out={ht:[0,0], gm:[], rc:[0,0], yc:[0,0]}; let any=false;
  for(const e of ev){
    const t=String((e.type&&e.type.text)||"").toLowerCase();
    const tid=String((e.team&&e.team.id)||""); if(!tid) continue;
    const side=tid===String(homeId)?0:1;
    const per=(e.period&&e.period.number)||0;
    const disp=String((e.clock&&e.clock.displayValue)||"");
    const mm=parseInt(disp,10); const plus=(disp.match(/\+(\d+)/)||[])[1];
    const min=(isNaN(mm)?0:mm)+(plus?+plus:0);
    const isGoal=(t.includes("goal")||(t.includes("penalty")&&t.includes("scored")))&&!t.includes("missed")&&!t.includes("saved")&&!t.includes("shootout")&&!t.includes("disallowed");
    if(isGoal){ any=true; const own=t.includes("own"); const s=own?1-side:side; out.gm.push(min+(s===0?"H":"A")); if(per===1||(per===0&&min<=45)) out.ht[s]++; }
    else if(t.includes("red")){ any=true; out.rc[side]++; }
    else if(t.includes("yellow")){ any=true; out.yc[side]++; }
  }
  if(!any) return null;
  out.gm=out.gm.join(",");
  return out;
}
/* v10:先發陣容 → 球員「有他 / 沒他」影響力。PL[teamId][playerId]={n,gd,nm} ; TT[teamId]={n,gd} */
const PL={}, TT={};
let PREV_NM={};   // 上次 calib.json 裡的球員名(快取路徑沒有名字時補用)
let PREV_STATS={};   // v5:上季球員數據(換季保護:新季 app<5 時沿用上季,避免開季初「暫無球員數據」)
try { const rp=JSON.parse(fs.readFileSync("roster-prev.json","utf8")); for(const k in rp) PREV_STATS[k]=rp[k]; } catch(e) {}
try { const pc=JSON.parse(fs.readFileSync("calib.json","utf8")); for(const lg in (pc.leagues||{})){ const Ts=pc.leagues[lg].teams||{}; for(const k in Ts){ (Ts[k].pi||[]).forEach(a=>{ if(a[1]) PREV_NM[a[0]]=a[1]; }); (Ts[k].r||[]).forEach(a=>{ if(a[1]) PREV_NM[String(a[0])]=a[1];
  if(Array.isArray(a[4])&&a[4].length){ const best=a[4].reduce((m,row)=>((+row[1]||0)>(+m[1]||0)?row:m),a[4][0]); if((+best[1]||0)>=5) PREV_STATS[String(a[0])]=best; } }); } } } catch(e) {}
function parseXI(sj, homeId){
  const rs=(sj&&sj.rosters)||[]; if(rs.length!==2) return null;
  const pick=r=>(r.roster||[]).filter(x=>x.starter).map(x=>{ const a=x.athlete||{}; return [String(a.id||""),(a.displayName||"").slice(0,40)]; }).filter(x=>x[0]);
  const h=rs.find(r=>String((r.team||{}).id)===String(homeId)), a=rs.find(r=>String((r.team||{}).id)!==String(homeId));
  if(!h||!a) return null; const H=pick(h), A=pick(a);
  if(H.length<7||A.length<7) return null;
  return {h:H, a:A};
}
function accXI(hid, aid, hs, as, xi, w){
  if(!xi) return;
  const side=(tid,list,gd)=>{ const t=(TT[tid]=TT[tid]||{n:0,gd:0}); t.n+=w; t.gd+=gd*w;
    const P=(PL[tid]=PL[tid]||{}); list.forEach(([pid,nm])=>{ const o=(P[pid]=P[pid]||{n:0,gd:0,nm}); o.n+=w; o.gd+=gd*w; if(nm) o.nm=nm; }); };
  side(String(hid), xi.h, hs-as); side(String(aid), xi.a, as-hs);
}
function finishXI(T){
  for(const tid in PL){ const t=T["#"+tid]; const tot=TT[tid]; if(!t||!tot||tot.n<6) continue;
    const out=[];
    for(const pid in PL[tid]){ const o=PL[tid][pid]; const nw=tot.n-o.n;
      if(o.n<3||nw<3) continue;                                   // 兩邊都要 ≥3 場才有比較意義
      const w_=o.gd/o.n, wo=(tot.gd-o.gd)/nw;
      const k=Math.min(1, Math.min(o.n,nw)/8);                     // 收縮:兩邊各 8 場才全額
      const imp=+(k*(w_-wo)).toFixed(2);
      if(Math.abs(imp)>=0.15) out.push([pid,o.nm,imp,+o.n.toFixed(1),+nw.toFixed(1)]); }
    out.sort((a,b)=>Math.abs(b[2])-Math.abs(a[2]));
    if(out.length) t.pi=out.slice(0,10);                           // 每隊最多存 10 人
  }
}
/* v10:天氣(ESPN 有給才存) */
function parseWx(ev,c){ const w=(c&&c.weather)||ev.weather||null; if(!w) return null;
  const o={}; if(w.displayValue) o.c=String(w.displayValue).slice(0,30); if(w.temperature!=null) o.t=+w.temperature; if(w.conditionId!=null) o.id=String(w.conditionId);
  return Object.keys(o).length?o:null; }
const WX={};
function accWx(lg,wx,hs,as,w){ if(!wx||!wx.c) return; const c=String(wx.c).toLowerCase();
  const k=/rain|shower|storm|snow|drizzle|sleet/.test(c)?"wet":"dry";
  const o=(WX[lg]=WX[lg]||{wet:{n:0,g:0},dry:{n:0,g:0}}); o[k].n+=w; o[k].g+=(hs+as)*w; }
function accProcess(T, hid, aid, hs, as, pr, w){
  if(!pr) return;
  const o=id=>{ const t=T["#"+id]; if(!t) return null; t.pr=t.pr||{n:0,g1:0,g2:0,c1:0,c2:0,lt:0,ltw:0,ltd:0,tr:0,trx:0,rc:0}; return t.pr; };
  const h1=pr.ht[0], a1=pr.ht[1], h2=hs-h1, a2=as-a1;
  if(h2<0||a2<0) return;                                   // 事件與終場比分對不上(烏龍球歸屬等)→ 不納入過程統計
  const H=o(hid), A=o(aid); if(!H||!A) return;
  const side=(t,gf1,ga1,gf2,ga2,rcn,gf,ga)=>{ t.n+=w; t.nr=(t.nr||0)+1; t.g1+=gf1*w; t.c1+=ga1*w; t.g2+=gf2*w; t.c2+=ga2*w; t.rc+=rcn*w;
    if(gf1>ga1){ t.lt+=w; if(gf>ga) t.ltw+=w; else if(gf===ga) t.ltd+=w; }
    if(gf1<ga1){ t.tr+=w; if(gf>=ga) t.trx+=w; } };
  side(H,h1,a1,h2,a2,pr.rc[0],hs,as); side(A,a1,h1,a2,h2,pr.rc[1],as,hs);
}
(async () => {
  const today = new Date().toISOString().slice(0,10);
  let out = { updated:"", d:today, days:WEEKS*7, n:0, leagues:{} };
  try {
    const prev = JSON.parse(fs.readFileSync("calib.json","utf8"));
    if (!process.env.CALIB_FULL && prev && prev.d === today && prev.leagues) { out = unslim(prev); console.log("接續今天的進度:已完成", Object.keys(prev.leagues).filter(k=>prev.leagues[k].done).join(", ")||"(無)"); }   // v12c:手動觸發(CALIB_FULL=1)一律全量重跑,不接續
  } catch(e) {}

  for (const lg of LEAGUES) {
    if (out.leagues[lg] && out.leagues[lg].done) { console.log("跳過(今天已完成):", lg); continue; }
    console.log("處理中:", lg);
    const now = new Date();
    let hw=0, dr=0, goals=0, n=0, nr=0; const SCR=[];   // v13:SCR 收集本聯賽所有比分,供 Dixon-Coles rho 實測擬合
    const T={};
    const add=(id,nm,gf,ga,isHome,dt,w2)=>{ const w=(w2!=null?w2:1); const o=(T["#"+id]=T["#"+id]||{gp:0,gf:0,ga:0,hgp:0,hgf:0,hga:0,agp:0,agf:0,aga:0,lp:""});
      o.gp+=w; o.gf+=gf*w; o.ga+=ga*w; if(gf===ga) o.dr=(o.dr||0)+w;
      o.gn=(o.gn||0)+1; if(isHome) o.hgn=(o.hgn||0)+1; else o.agn=(o.agn||0)+1;   // v12:原始場數(不衰減)
      o.w2=(o.w2||0)+w*w;   // v12:權重平方和 → 前端算有效樣本數 ESS=gp²/w2(介於衰減值與原始場數之間,作資料權重用)
      if(isHome){ o.hgp+=w; o.hgf+=gf*w; o.hga+=ga*w; } else { o.agp+=w; o.agf+=gf*w; o.aga+=ga*w; }
      if(dt && dt>o.lp) o.lp=dt;                               // 最近一場日期(休息日計算用)
      if(nm) T[String(nm).toLowerCase()]=o; };
    // ── 賽果(近 182 天)──
    const WK = /^uefa\./.test(lg) ? WEEKS_CUP : WEEKS;   // v14:盃賽掃更長區間
    for (let seg=0; seg<WK; seg++) {
      const b=new Date(now); b.setDate(b.getDate()-seg*7);
      const a=new Date(now); a.setDate(a.getDate()-(seg+1)*7);
      try {
        const r = await fetch(sb(lg, ymd(a), ymd(b)));
        if (r.ok) { const j = await r.json();
          for (const ev of (j.events||[])) {
            const c=(ev.competitions||[])[0]; if(!c) continue;
            if(!(((c.status||{}).type)||{}).completed) continue;
            const H=(c.competitors||[]).find(x=>x.homeAway==="home");
            const A=(c.competitors||[]).find(x=>x.homeAway==="away");
            if(!H||!A) continue;
            const hs=+H.score, as=+A.score;
            if(isNaN(hs)||isNaN(as)) continue;
            // v8:逐場帳本(不覆蓋已存在且已含射正的紀錄;賠率若 ESPN 有提供則一併存)
            const __wx=parseWx(ev,c);
            try {
              const od=(c.odds||[])[0]; let ol=null;
              if (od) { const ml=x=>x&&x.moneyLine!=null?+x.moneyLine:null;
                const nl=s=>{ const x=od.moneyline&&od.moneyline[s]; const v=x&&((x.close&&x.close.odds)||(x.open&&x.open.odds)); return v!=null?parseFloat(String(v).replace("+","")):null; };
                const mh=nl("home")!=null?nl("home"):ml(od.homeTeamOdds), ma=nl("away")!=null?nl("away"):ml(od.awayTeamOdds), md=nl("draw")!=null?nl("draw"):ml(od.drawOdds);
                if (mh!=null&&ma!=null&&md!=null) ol=[mh,md,ma]; }
              const prevM=MATCHES[ev.id]||{};
              MATCHES[ev.id]={ lg, d:(ev.date||"").slice(0,10), hid:String((H.team||{}).id||""), hn:(H.team||{}).displayName||"",
                aid:String((A.team||{}).id||""), an:(A.team||{}).displayName||"", hs, as,
                ...(prevM.sot?{sot:prevM.sot}:{}), ...(prevM.ev?{ev:prevM.ev}:{}), ...(prevM.noev?{noev:1}:{}),
                ...(prevM.sh?{sh:prevM.sh}:{}), ...(prevM.fl?{fl:prevM.fl}:{}), ...(prevM.xi?{xi:prevM.xi}:{}), ...(prevM.noxi?{noxi:1}:{}),
                ...(prevM.wx?{wx:prevM.wx}:{}), ...(__wx?{wx:__wx}:{}), ...(prevM.ml?{ml:prevM.ml}:{}), ...(ol?{ml:ol}:{}) };
              accWx(lg, (__wx||prevM.wx), hs, as, 1);
            } catch(e) {}
            { const __ag=Math.max(0,(Date.now()-(Date.parse(ev.date)||Date.now()))/86400000);
              const __wl=Math.exp(-Math.LN2*__ag/HALF_LIFE);
              n+=__wl; nr+=1; goals+=(hs+as)*__wl; SCR.push([hs,as]);
              if(hs>as) hw+=__wl; else if(hs===as) dr+=__wl; }
            // 時間衰減:半衰期 60 天(上週的比賽 ≈ 半年前的 8 倍話語權)
            const __age=Math.max(0,(Date.now()-(Date.parse(ev.date)||Date.now()))/86400000);
            const __w=Math.max(0.25, Math.exp(-Math.LN2*__age/HALF_LIFE));   // v11:衰減下限 0.25,上季戰績開季時仍保有話語權
            add((H.team||{}).id,(H.team||{}).displayName,hs,as,true, ev.date||"", __w);
            add((A.team||{}).id,(A.team||{}).displayName,as,hs,false,ev.date||"", __w);
            // 射正數(自產 xG 用):抓該場 summary 的 shotsOnTarget(v8:帳本已有射正 → 直接沿用,省請求)
            const __cached=MATCHES[ev.id]&&MATCHES[ev.id].sot&&(MATCHES[ev.id].ev||MATCHES[ev.id].noev)&&(MATCHES[ev.id].xi||MATCHES[ev.id].noxi);
            if (__cached) { const [sh2,sa2,ch,ca2,ph,pa]=MATCHES[ev.id].sot;
              accProcess(T,(H.team||{}).id,(A.team||{}).id,hs,as,MATCHES[ev.id].ev,__w);
              try{ const x=MATCHES[ev.id].xi; if(x) accXI((H.team||{}).id,(A.team||{}).id,hs,as,{h:x[0].split(",").map(s=>[s,""]),a:x[1].split(",").map(s=>[s,""])},__w); }catch(e){}
              const acc0=(id,f,a2,ps,cf,cA)=>{ const o=T["#"+id]; if(o){
                o.stn=(o.stn||0)+__w; o.stnr=(o.stnr||0)+1; o.stf=(o.stf||0)+f*__w; o.sta=(o.sta||0)+a2*__w;
                if(ps!=null){ o.psn=(o.psn||0)+1; o.psf=(o.psf||0)+ps; }
                if(cf!=null){ o.crf=(o.crf||0)+cf; o.cra=(o.cra||0)+(cA||0); } } };
              acc0((H.team||{}).id,sh2,sa2,ph,ch,ca2); acc0((A.team||{}).id,sa2,sh2,pa,ca2,ch);
              SOT_G[lg]=(SOT_G[lg]||0)+hs+as; SOT_S[lg]=(SOT_S[lg]||0)+sh2+sa2;
              if(ch!=null&&ca2!=null) SOT_C[lg]=(SOT_C[lg]||0)+ch+ca2; }
            else try {
              const sr2=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/summary?event=${ev.id}`);
              if (sr2.ok) {
                const sj2=await sr2.json();
                try { const pr=parseProcess(sj2,(H.team||{}).id);
                  if (MATCHES[ev.id]) { if(pr) MATCHES[ev.id].ev=pr; else MATCHES[ev.id].noev=1; }
                  accProcess(T,(H.team||{}).id,(A.team||{}).id,hs,as,pr,__w);
                  const xi=parseXI(sj2,(H.team||{}).id);
                  if (MATCHES[ev.id]) { if(xi) MATCHES[ev.id].xi=[xi.h.map(x=>x[0]).join(","), xi.a.map(x=>x[0]).join(",")]; else MATCHES[ev.id].noxi=1; }
                  accXI((H.team||{}).id,(A.team||{}).id,hs,as,xi,__w);
                  // 射門/犯規(帳本留底)
                  const bt0=(sj2.boxscore&&sj2.boxscore.teams)||[];
                  if (bt0.length===2&&MATCHES[ev.id]) { const g2=(t2,nm2)=>{ const st2=(t2.statistics||[]).find(x=>x.name===nm2); return st2?parseFloat(st2.displayValue):null; };
                    const hf=String((bt0[0].team||{}).id)===String((H.team||{}).id);
                    const ts0=g2(bt0[0],"totalShots"), ts1=g2(bt0[1],"totalShots"), f0=g2(bt0[0],"foulsCommitted"), f1=g2(bt0[1],"foulsCommitted");
                    if(ts0!=null&&ts1!=null) MATCHES[ev.id].sh=hf?[ts0,ts1]:[ts1,ts0];
                    if(f0!=null&&f1!=null) MATCHES[ev.id].fl=hf?[f0,f1]:[f1,f0]; }
                } catch(e) {}
                const bt=(sj2.boxscore&&sj2.boxscore.teams)||[];
                const gv=(t2,nm2)=>{ const st2=(t2.statistics||[]).find(x=>x.name===nm2); return st2?parseFloat(st2.displayValue):null; };
                const sotOf=t2=>gv(t2,"shotsOnTarget");
                if (bt.length===2) {
                  const id0=String((bt[0].team||{}).id), s0=sotOf(bt[0]), s1=sotOf(bt[1]);
                  if (s0!=null&&s1!=null) {
                    const hFirst = id0===String((H.team||{}).id);
                    const sh2=hFirst?s0:s1, sa2=hFirst?s1:s0;

                    const p0=gv(bt[0],"possessionPct"), p1=gv(bt[1],"possessionPct");
                    const c0=gv(bt[0],"wonCorners"),   c1=gv(bt[1],"wonCorners");
                    const ph=hFirst?p0:p1, pa=hFirst?p1:p0;
                    const ch=hFirst?c0:c1, ca2=hFirst?c1:c0;
                    try { if (MATCHES[ev.id]) MATCHES[ev.id].sot=[sh2,sa2,ch??null,ca2??null,ph??null,pa??null]; } catch(e) {}
                    const acc=(id,f,a2,ps,cf,cA)=>{ const o=T["#"+id]; if(o){
                      o.stn=(o.stn||0)+__w; o.stnr=(o.stnr||0)+1; o.stf=(o.stf||0)+f*__w; o.sta=(o.sta||0)+a2*__w;
                      if(ps!=null&&!isNaN(ps)){ o.psn=(o.psn||0)+1; o.psf=(o.psf||0)+ps; }
                      if(cf!=null&&!isNaN(cf)){ o.crf=(o.crf||0)+cf; o.cra=(o.cra||0)+(cA||0); } } };
                    acc((H.team||{}).id, sh2, sa2, ph, ch, ca2); acc((A.team||{}).id, sa2, sh2, pa, ca2, ch);
                    SOT_G[lg]=(SOT_G[lg]||0)+hs+as; SOT_S[lg]=(SOT_S[lg]||0)+sh2+sa2;
                    if(ch!=null&&ca2!=null&&!isNaN(ch)&&!isNaN(ca2)) SOT_C[lg]=(SOT_C[lg]||0)+ch+ca2;
                  }
                }
              }
            } catch(e) {}
            await sleep(100);
          } }
      } catch(e) {}
      await sleep(200);
    }
    n=+n.toFixed(1);
    if (nr < 8) { out.leagues[lg]={done:1, n:0, nr}; save(out, lg+" (樣本不足)"); continue; }   // v12:門檻看原始場數
    const ha = Math.max(0.05, Math.min(0.45, 0.24 + (hw/n-0.46)*1.2));
    // v9:聯賽過程平均(領先守成率 / 落後不敗率 / 下半場淨進球 / 紅牌率),供前端算各隊相對體質
    let pA={n:0,lt:0,ltw:0,tr:0,trx:0,h2:0,rc:0};
    for (const k in T) { const q=T[k]&&T[k].pr; if(!q||k[0]!=="#") continue; pA.n+=q.n; pA.lt+=q.lt; pA.ltw+=q.ltw; pA.tr+=q.tr; pA.trx+=q.trx; pA.h2+=((q.g2-q.c2)-(q.g1-q.c1)); pA.rc+=q.rc; }
    const prAvg = pA.n>0 ? { hold:+(pA.lt?pA.ltw/pA.lt:0.75).toFixed(3), cb:+(pA.tr?pA.trx/pA.tr:0.35).toFixed(3), rc:+(pA.rc/pA.n).toFixed(3) } : null;
    for (const k in T) { const q=T[k]&&T[k].pr; if(q) for(const f in q) q[f]=+(+q[f]).toFixed(2); }
    out.leagues[lg] = { ha:+ha.toFixed(3), lgAvg:+Math.max(1,Math.min(2,goals/n/2)).toFixed(3),
      draw:+(dr/n).toFixed(3), n, nr, rho:fitRho(SCR), teams:T, ...(prAvg?{prAvg}:{}) };
    out.n += n;
    // ── 名單 + 球員逐季數據(含守門/防守欄位)──
    try {
      const tr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams`);
      if (tr.ok) { const tj = await tr.json();
        let teams=[]; try{teams=tj.sports[0].leagues[0].teams.map(t=>t.team);}catch(e){teams=(tj.teams||[]).map(t=>t.team||t);}
        const Y=new Date().getFullYear();
        for (const t of teams.filter(t=>t&&t.id)) {
          try {
            const rr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams/${t.id}/roster`);
            if (!rr.ok) continue;
            const rj = await rr.json();
            const grp = rj.athletes||rj.roster||[];
            const flat=[];
            const push=a=>{ if(a&&(a.fullName||a.displayName)) flat.push([a.id, a.fullName||a.displayName,
              (a.position&&(a.position.abbreviation||a.position.name))||"", a.jersey||""]); };
            grp.forEach(g=>{ if(g&&g.items) g.items.forEach(push); else push(g&&g.athlete?g.athlete:g); });
            for (const a of flat.slice(0,30)) {
              const S=[];
              for (const yr of [Y, Y-1, Y-2, Y-3]) {
                try {
                  const sr = await fetch(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${lg}/seasons/${yr}/types/1/athletes/${a[0]}/statistics`);
                  if (!sr.ok) continue;
                  const f = flatWalk(await sr.json());
                  const app=f.appearances??f.gamesPlayed, gl=f.goals??f.totalGoals;
                  if (app!=null||gl!=null) S.push([String(yr),String(app??""),String(gl??""),String(f.assists??f.goalAssists??""),String(f.minutes??""),
                    String(f.saves??""),String(f.cleanSheets??f.cleanSheet??f.shutouts??""),String(f.goalsConceded??""),
                    String(f.totalTackles??f.tackles??""),String(f.interceptions??"")]);
                } catch(e) {}
                await sleep(80);
              }
              // v5:換季保護 —— 新季所有列 app<5 且上季有 app>=5 的紀錄 → 附加上季列(前端會取 app 最大的一列)
              try { const bestApp = S.reduce((m,row)=>Math.max(m,+row[1]||0),0);
                const pv = PREV_STATS[String(a[0])];
                if (bestApp < 5 && pv && (+pv[1]||0) >= 5) S.push(pv);
              } catch(e) {}
              // v14:球員數據 —— 本季 + 出賽最多的一季 + 其餘由新到舊補到 4 季(球員頁逐季表更完整);
              //     每列去掉尾端空欄(外野球員的撲救/零封/失球欄多半是空的,省約 18% 體積;前端讀不到會顯示「—」)
              if (S.length) { const cur=S.find(r=>r[0]===String(Y)); const best=S.reduce((m,r)=>((+r[1]||0)>(+m[1]||0)?r:m),S[0]);
                const keep=[]; const add=r=>{ if(r&&!keep.some(x=>x[0]===r[0])) keep.push(r); };
                add(cur); add(best);
                S.slice().sort((x,y)=>(+y[0])-(+x[0])).forEach(r=>{ if(keep.length<4 && (+r[1]||0)>0) add(r); });
                keep.sort((x,y)=>(+y[0])-(+x[0]));
                a.push(keep.map(r=>{ const q=r.slice(); while(q.length>2 && (q[q.length-1]===""||q[q.length-1]==="0")) q.pop(); return q; })); }
            }
            if (flat.length) { const key="#"+t.id;
              T[key]=T[key]||{gp:0,gf:0,ga:0}; T[key].r=flat; }
          } catch(e) {}
          await sleep(120);
        } }
    } catch(e) {}
    // 自產 xG:射正 × 聯賽轉化率(每球射正≈多少進球),寫入 xg 欄位
    try {
      const CW=0.12;                                        // 一個角球 ≈ 0.12 個射正的價值
      const S2=(SOT_S[lg]||0)+CW*(SOT_C[lg]||0);
      const conv=(SOT_G[lg]&&S2)?SOT_G[lg]/S2:0.30;
      for (const k in T) {
        const t2=T[k];
        if ((t2.stnr||t2.stn)>=8) {
          const sf2=t2.stf+CW*(t2.crf||0), sa3=t2.sta+CW*(t2.cra||0);
          t2.xg={ n:(t2.stnr||t2.stn), xf:+(conv*sf2/t2.stn).toFixed(3), xa:+(conv*sa3/t2.stn).toFixed(3) };
          if (t2.psn>=8) t2.ps=+(t2.psf/t2.psn).toFixed(1);   // 平均控球率(顯示用)
        }
      }
      console.log("SOT-xG:", lg, "轉化率", (SOT_G[lg]&&SOT_S[lg])?(SOT_G[lg]/SOT_S[lg]).toFixed(3):"預設0.30");
    } catch(e) {}
    // v10:球員影響力(名字補自名冊 r 欄位)與聯賽天氣進球比
    try {
      for (const tid in PL) { const t=T["#"+tid]; const r=(t&&t.r)||[]; const nmOf={}; r.forEach(a=>{ nmOf[String(a[0])]=a[1]; });
        for (const pid in PL[tid]) if(!PL[tid][pid].nm) PL[tid][pid].nm=nmOf[pid]||PREV_NM[pid]||""; }
      finishXI(T);
      const W=WX[lg]; if (W && W.wet.n>=15 && W.dry.n>=15) out.leagues[lg].wx={ wet:+(W.wet.g/W.wet.n).toFixed(2), dry:+(W.dry.g/W.dry.n).toFixed(2), n:[Math.round(W.wet.n),Math.round(W.dry.n)] };
      for (const k in PL) delete PL[k]; for (const k in TT) delete TT[k];
    } catch(e) {}
    out.leagues[lg].done = 1;
    save(out, lg);                       // ← checkpoint:此聯賽完成即存檔+推送
    console.log("完成:", lg, "(", n, "場 )");
  }
  // xG 已改為自產(SOT-xG,於各聯賽 checkpoint 內完成;外部源 Understat/FBref 均擋機房 IP)
  try{ await understat(out); }catch(e){ console.log("understat 模組失敗:",e.message); }   // v17
  buildXiBase(out); save(out, null);   // v16
  console.log("全部完成:", out.n, "場,", Object.keys(out.leagues).length, "個聯賽");
})();
