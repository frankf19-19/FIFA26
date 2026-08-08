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
  require("fs").writeFileSync("calib.json", JSON.stringify(out));
  console.log("calib.json:", out.n, "場 /", WEEKS*7, "天,", Object.keys(out.leagues).length, "個聯賽");
})();
