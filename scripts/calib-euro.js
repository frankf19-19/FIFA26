/* 歐陸足球雲端校準 v9:可中斷續跑(checkpoint)+ 逐場賽果帳本 matches.json(回測用)
   + 比賽過程(半場比分、進球時間、紅黃牌、射門、犯規)→ 每隊「過程體質」指標(領先守成率、落後追平率、下半場淨進球、紅牌率)。
   每完成一個聯賽 → 立刻寫入 calib.json 並 commit+push;
   中斷重跑時,跳過「當天已完成」的聯賽,從斷點接續。 */
const { execSync } = require("child_process");
const fs = require("fs");
const LEAGUES = ["eng.1","esp.1","ita.1","ger.1","fra.1","uefa.champions","uefa.europa","usa.1","jpn.1","eng.2","sco.1"];
const WEEKS = 26;
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const sb = (lg,a,b) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${a}-${b}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const flatWalk = d => { const f={}; (function w(o){ if(!o||typeof o!=="object")return;
  if(Array.isArray(o)){o.forEach(w);return;}
  const k=o.name||o.abbreviation, v=o.displayValue!=null?o.displayValue:(o.value!=null?o.value:null);
  if(k&&v!=null&&(typeof v==="string"||typeof v==="number")&&f[k]==null)f[k]=v;
  for(const q in o)w(o[q]); })(d); return f; };

/* v8:逐場賽果帳本(以 ESPN event id 為鍵,跨日累積、永不刪除 → 歷史會越來越長,供離線回測) */
let MATCHES = {};
try { MATCHES = JSON.parse(fs.readFileSync("matches.json","utf8")) || {}; } catch(e) { MATCHES = {}; }
function saveMatches(){
  const keys = Object.keys(MATCHES).sort((a,b)=>(MATCHES[a].d||"").localeCompare(MATCHES[b].d||""));
  const o={}; keys.forEach(k=>o[k]=MATCHES[k]);
  fs.writeFileSync("matches.json", JSON.stringify(o));
}
function save(out, lg){
  out.updated = new Date().toISOString();
  fs.writeFileSync("calib.json", JSON.stringify(out));
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
function accProcess(T, hid, aid, hs, as, pr, w){
  if(!pr) return;
  const o=id=>{ const t=T["#"+id]; if(!t) return null; t.pr=t.pr||{n:0,g1:0,g2:0,c1:0,c2:0,lt:0,ltw:0,ltd:0,tr:0,trx:0,rc:0}; return t.pr; };
  const h1=pr.ht[0], a1=pr.ht[1], h2=hs-h1, a2=as-a1;
  if(h2<0||a2<0) return;                                   // 事件與終場比分對不上(烏龍球歸屬等)→ 不納入過程統計
  const H=o(hid), A=o(aid); if(!H||!A) return;
  const side=(t,gf1,ga1,gf2,ga2,rcn,gf,ga)=>{ t.n+=w; t.g1+=gf1*w; t.c1+=ga1*w; t.g2+=gf2*w; t.c2+=ga2*w; t.rc+=rcn*w;
    if(gf1>ga1){ t.lt+=w; if(gf>ga) t.ltw+=w; else if(gf===ga) t.ltd+=w; }
    if(gf1<ga1){ t.tr+=w; if(gf>=ga) t.trx+=w; } };
  side(H,h1,a1,h2,a2,pr.rc[0],hs,as); side(A,a1,h1,a2,h2,pr.rc[1],as,hs);
}
(async () => {
  const today = new Date().toISOString().slice(0,10);
  let out = { updated:"", d:today, days:WEEKS*7, n:0, leagues:{} };
  try {
    const prev = JSON.parse(fs.readFileSync("calib.json","utf8"));
    if (prev && prev.d === today && prev.leagues) { out = prev; console.log("接續今天的進度:已完成", Object.keys(prev.leagues).filter(k=>prev.leagues[k].done).join(", ")||"(無)"); }
  } catch(e) {}

  for (const lg of LEAGUES) {
    if (out.leagues[lg] && out.leagues[lg].done) { console.log("跳過(今天已完成):", lg); continue; }
    console.log("處理中:", lg);
    const now = new Date();
    let hw=0, dr=0, goals=0, n=0;
    const T={};
    const add=(id,nm,gf,ga,isHome,dt,w2)=>{ const w=(w2!=null?w2:1); const o=(T["#"+id]=T["#"+id]||{gp:0,gf:0,ga:0,hgp:0,hgf:0,hga:0,agp:0,agf:0,aga:0,lp:""});
      o.gp+=w; o.gf+=gf*w; o.ga+=ga*w; if(gf===ga) o.dr=(o.dr||0)+w;
      if(isHome){ o.hgp+=w; o.hgf+=gf*w; o.hga+=ga*w; } else { o.agp+=w; o.agf+=gf*w; o.aga+=ga*w; }
      if(dt && dt>o.lp) o.lp=dt;                               // 最近一場日期(休息日計算用)
      if(nm) T[String(nm).toLowerCase()]=o; };
    // ── 賽果(近 182 天)──
    for (let seg=0; seg<WEEKS; seg++) {
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
            try {
              const od=(c.odds||[])[0]; let ol=null;
              if (od) { const ml=x=>x&&x.moneyLine!=null?+x.moneyLine:null;
                const mh=ml(od.homeTeamOdds), ma=ml(od.awayTeamOdds), md=ml(od.drawOdds);
                if (mh!=null&&ma!=null&&md!=null) ol=[mh,md,ma]; }
              const prevM=MATCHES[ev.id]||{};
              MATCHES[ev.id]={ lg, d:(ev.date||"").slice(0,10), hid:String((H.team||{}).id||""), hn:(H.team||{}).displayName||"",
                aid:String((A.team||{}).id||""), an:(A.team||{}).displayName||"", hs, as,
                ...(prevM.sot?{sot:prevM.sot}:{}), ...(prevM.ev?{ev:prevM.ev}:{}), ...(prevM.noev?{noev:1}:{}),
                ...(prevM.sh?{sh:prevM.sh}:{}), ...(prevM.fl?{fl:prevM.fl}:{}), ...(prevM.ml?{ml:prevM.ml}:{}), ...(ol?{ml:ol}:{}) };
            } catch(e) {}
            { const __ag=Math.max(0,(Date.now()-(Date.parse(ev.date)||Date.now()))/86400000);
              const __wl=Math.exp(-Math.LN2*__ag/60);
              n+=__wl; goals+=(hs+as)*__wl;
              if(hs>as) hw+=__wl; else if(hs===as) dr+=__wl; }
            // 時間衰減:半衰期 60 天(上週的比賽 ≈ 半年前的 8 倍話語權)
            const __age=Math.max(0,(Date.now()-(Date.parse(ev.date)||Date.now()))/86400000);
            const __w=Math.exp(-Math.LN2*__age/60);
            add((H.team||{}).id,(H.team||{}).displayName,hs,as,true, ev.date||"", __w);
            add((A.team||{}).id,(A.team||{}).displayName,as,hs,false,ev.date||"", __w);
            // 射正數(自產 xG 用):抓該場 summary 的 shotsOnTarget(v8:帳本已有射正 → 直接沿用,省請求)
            const __cached=MATCHES[ev.id]&&MATCHES[ev.id].sot&&(MATCHES[ev.id].ev||MATCHES[ev.id].noev);
            if (__cached) { const [sh2,sa2,ch,ca2,ph,pa]=MATCHES[ev.id].sot;
              accProcess(T,(H.team||{}).id,(A.team||{}).id,hs,as,MATCHES[ev.id].ev,__w);
              const acc0=(id,f,a2,ps,cf,cA)=>{ const o=T["#"+id]; if(o){
                o.stn=(o.stn||0)+__w; o.stf=(o.stf||0)+f*__w; o.sta=(o.sta||0)+a2*__w;
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
                      o.stn=(o.stn||0)+__w; o.stf=(o.stf||0)+f*__w; o.sta=(o.sta||0)+a2*__w;
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
    if (n < 8) { out.leagues[lg]={done:1, n:0}; save(out, lg+" (樣本不足)"); continue; }
    const ha = Math.max(0.05, Math.min(0.45, 0.24 + (hw/n-0.46)*1.2));
    // v9:聯賽過程平均(領先守成率 / 落後不敗率 / 下半場淨進球 / 紅牌率),供前端算各隊相對體質
    let pA={n:0,lt:0,ltw:0,tr:0,trx:0,h2:0,rc:0};
    for (const k in T) { const q=T[k]&&T[k].pr; if(!q||k[0]!=="#") continue; pA.n+=q.n; pA.lt+=q.lt; pA.ltw+=q.ltw; pA.tr+=q.tr; pA.trx+=q.trx; pA.h2+=((q.g2-q.c2)-(q.g1-q.c1)); pA.rc+=q.rc; }
    const prAvg = pA.n>0 ? { hold:+(pA.lt?pA.ltw/pA.lt:0.75).toFixed(3), cb:+(pA.tr?pA.trx/pA.tr:0.35).toFixed(3), rc:+(pA.rc/pA.n).toFixed(3) } : null;
    for (const k in T) { const q=T[k]&&T[k].pr; if(q) for(const f in q) q[f]=+(+q[f]).toFixed(2); }
    out.leagues[lg] = { ha:+ha.toFixed(3), lgAvg:+Math.max(1,Math.min(2,goals/n/2)).toFixed(3),
      draw:+(dr/n).toFixed(3), n, teams:T, ...(prAvg?{prAvg}:{}) };
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
              if (S.length) a.push(S);
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
        if (t2.stn>=8) {
          const sf2=t2.stf+CW*(t2.crf||0), sa3=t2.sta+CW*(t2.cra||0);
          t2.xg={ n:t2.stn, xf:+(conv*sf2/t2.stn).toFixed(3), xa:+(conv*sa3/t2.stn).toFixed(3) };
          if (t2.psn>=8) t2.ps=+(t2.psf/t2.psn).toFixed(1);   // 平均控球率(顯示用)
        }
      }
      console.log("SOT-xG:", lg, "轉化率", (SOT_G[lg]&&SOT_S[lg])?(SOT_G[lg]/SOT_S[lg]).toFixed(3):"預設0.30");
    } catch(e) {}
    out.leagues[lg].done = 1;
    save(out, lg);                       // ← checkpoint:此聯賽完成即存檔+推送
    console.log("完成:", lg, "(", n, "場 )");
  }
  // xG 已改為自產(SOT-xG,於各聯賽 checkpoint 內完成;外部源 Understat/FBref 均擋機房 IP)
  console.log("全部完成:", out.n, "場,", Object.keys(out.leagues).length, "個聯賽");
})();
