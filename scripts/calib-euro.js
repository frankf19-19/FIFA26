/* 歐陸足球雲端校準 v2:抓近 182 天(26 週)完賽紀錄。
   輸出:各聯賽 主場係數/進球環境/和局率 + 各球隊攻防紀錄(gp/gf/ga)。 */
const LEAGUES = ["eng.1","esp.1","ita.1","ger.1","fra.1","uefa.champions","uefa.europa","usa.1","jpn.1","eng.2"];
const WEEKS = 26;
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const sb = (lg,a,b) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${a}-${b}`;

(async () => {
  const now = new Date();
  const out = { updated: now.toISOString(), days: WEEKS*7, n: 0, leagues: {} };
  for (const lg of LEAGUES) {
    let hw=0, dr=0, goals=0, n=0;
    const T = {};                                        // 球隊攻防:key=#id 與小寫隊名
    const add=(id,nm,gf,ga)=>{
      const o=(T["#"+id]=T["#"+id]||{gp:0,gf:0,ga:0});
      o.gp++; o.gf+=gf; o.ga+=ga;
      if(nm) T[String(nm).toLowerCase()]=o;
    };
    for (let seg=0; seg<WEEKS; seg++) {
      const b=new Date(now); b.setDate(b.getDate()-seg*7);
      const a=new Date(now); a.setDate(a.getDate()-(seg+1)*7);
      try {
        const r = await fetch(sb(lg, ymd(a), ymd(b)));
        if (!r.ok) continue;
        const j = await r.json();
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
          add((H.team||{}).id,(H.team||{}).displayName,hs,as);
          add((A.team||{}).id,(A.team||{}).displayName,as,hs);
        }
      } catch(e) {}
      await new Promise(r=>setTimeout(r,250));
    }
    if (n >= 8) {
      const ha = Math.max(0.05, Math.min(0.45, 0.24 + (hw/n-0.46)*1.2));
      out.leagues[lg] = { ha:+ha.toFixed(3), lgAvg:+Math.max(1,Math.min(2,goals/n/2)).toFixed(3),
        draw:+(dr/n).toFixed(3), n, teams:T };
      out.n += n;
    }
  }
  // 第三層:每隊球員名單(id/姓名/位置/背號)——客戶端抓不到時的雲端備援
  for (const lg of Object.keys(out.leagues)) {
    try {
      const tr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams`);
      if (!tr.ok) continue;
      const tj = await tr.json();
      let teams=[]; try{teams=tj.sports[0].leagues[0].teams.map(t=>t.team);}catch(e){teams=(tj.teams||[]).map(t=>t.team||t);}
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
          // 每名球員的賽季統計(今年,空則試去年)—— 瀏覽器抓不到時的雲端快照
          const Y=new Date().getFullYear();
          const flatWalk=d=>{const f={};(function w2(o){if(!o||typeof o!=="object")return;
            if(Array.isArray(o)){o.forEach(w2);return;}
            const k=o.name||o.abbreviation,v=o.displayValue!=null?o.displayValue:(o.value!=null?o.value:null);
            if(k&&v!=null&&(typeof v==="string"||typeof v==="number")&&f[k]==null)f[k]=v;
            for(const q in o)w2(o[q]);})(d);return f;};
          for (const a of flat.slice(0,30)) {
            const S=[];                                  // 逐季歷史:[[季,出場,球,助,分鐘],...]
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
              await new Promise(r=>setTimeout(r,80));
            }
            if (S.length) a.push(S);
          }
          if (flat.length) {
            const key="#"+t.id;
            out.leagues[lg].teams[key]=out.leagues[lg].teams[key]||{gp:0,gf:0,ga:0};
            out.leagues[lg].teams[key].r=flat;
          }
        } catch(e) {}
        await new Promise(r=>setTimeout(r,150));
      }
    } catch(e) {}
  }
  require("fs").writeFileSync("calib.json", JSON.stringify(out));
  console.log("calib.json:", out.n, "場 /", WEEKS*7, "天,", Object.keys(out.leagues).length, "個聯賽");
})();
