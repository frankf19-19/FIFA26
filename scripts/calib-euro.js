/* 歐陸足球雲端校準 v7:可中斷續跑(checkpoint)。
   每完成一個聯賽 → 立刻寫入 calib.json 並 commit+push;
   中斷重跑時,跳過「當天已完成」的聯賽,從斷點接續。 */
const { execSync } = require("child_process");
const fs = require("fs");
const LEAGUES = ["eng.1","esp.1","ita.1","ger.1","fra.1","uefa.champions","uefa.europa","usa.1","jpn.1","eng.2"];
const WEEKS = 26;
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const sb = (lg,a,b) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${a}-${b}`;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const flatWalk = d => { const f={}; (function w(o){ if(!o||typeof o!=="object")return;
  if(Array.isArray(o)){o.forEach(w);return;}
  const k=o.name||o.abbreviation, v=o.displayValue!=null?o.displayValue:(o.value!=null?o.value:null);
  if(k&&v!=null&&(typeof v==="string"||typeof v==="number")&&f[k]==null)f[k]=v;
  for(const q in o)w(o[q]); })(d); return f; };

function save(out, lg){
  out.updated = new Date().toISOString();
  fs.writeFileSync("calib.json", JSON.stringify(out));
  if (process.env.GIT_PUSH === "1") {
    try {
      execSync(`git add calib.json && (git diff --cached --quiet || git commit -m "calib checkpoint: ${lg}")`, {stdio:"inherit"});
      execSync(`git pull --rebase origin main || (git rebase --abort; git pull --no-rebase -X ours origin main)`, {stdio:"inherit", shell:"/bin/bash"});
      execSync(`git push`, {stdio:"inherit"});
    } catch(e) { console.log("push 暫時失敗(資料已寫入,下個 checkpoint 再試):", String(e).slice(0,80)); }
  }
}

const SOT_G={}, SOT_S={};
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
    const add=(id,nm,gf,ga,isHome,dt)=>{ const o=(T["#"+id]=T["#"+id]||{gp:0,gf:0,ga:0,hgp:0,hgf:0,hga:0,agp:0,agf:0,aga:0,lp:""});
      o.gp++; o.gf+=gf; o.ga+=ga;
      if(isHome){ o.hgp++; o.hgf+=gf; o.hga+=ga; } else { o.agp++; o.agf+=gf; o.aga+=ga; }
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
            n++; goals+=hs+as;
            if(hs>as) hw++; else if(hs===as) dr++;
            add((H.team||{}).id,(H.team||{}).displayName,hs,as,true, ev.date||"");
            add((A.team||{}).id,(A.team||{}).displayName,as,hs,false,ev.date||"");
            // 射正數(自產 xG 用):抓該場 summary 的 shotsOnTarget
            try {
              const sr2=await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/summary?event=${ev.id}`);
              if (sr2.ok) {
                const sj2=await sr2.json();
                const bt=(sj2.boxscore&&sj2.boxscore.teams)||[];
                const sotOf=t2=>{ const st2=(t2.statistics||[]).find(x=>x.name==="shotsOnTarget"); return st2?+st2.displayValue:null; };
                if (bt.length===2) {
                  const id0=String((bt[0].team||{}).id), s0=sotOf(bt[0]), s1=sotOf(bt[1]);
                  if (s0!=null&&s1!=null) {
                    const hFirst = id0===String((H.team||{}).id);
                    const sh2=hFirst?s0:s1, sa2=hFirst?s1:s0;
                    const acc=(id,f,a2)=>{ const o=T["#"+id]; if(o){ o.stn=(o.stn||0)+1; o.stf=(o.stf||0)+f; o.sta=(o.sta||0)+a2; } };
                    acc((H.team||{}).id, sh2, sa2); acc((A.team||{}).id, sa2, sh2);
                    SOT_G[lg]=(SOT_G[lg]||0)+hs+as; SOT_S[lg]=(SOT_S[lg]||0)+sh2+sa2;
                  }
                }
              }
            } catch(e) {}
            await sleep(100);
          } }
      } catch(e) {}
      await sleep(200);
    }
    if (n < 8) { out.leagues[lg]={done:1, n:0}; save(out, lg+" (樣本不足)"); continue; }
    const ha = Math.max(0.05, Math.min(0.45, 0.24 + (hw/n-0.46)*1.2));
    out.leagues[lg] = { ha:+ha.toFixed(3), lgAvg:+Math.max(1,Math.min(2,goals/n/2)).toFixed(3),
      draw:+(dr/n).toFixed(3), n, teams:T };
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
      const conv=(SOT_G[lg]&&SOT_S[lg])?SOT_G[lg]/SOT_S[lg]:0.30;
      for (const k in T) {
        const t2=T[k];
        if (t2.stn>=8) t2.xg={ n:t2.stn, xf:+(conv*t2.stf/t2.stn).toFixed(3), xa:+(conv*t2.sta/t2.stn).toFixed(3) };
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
