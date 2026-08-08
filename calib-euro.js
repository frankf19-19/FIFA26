/* 歐陸足球雲端校準:每日抓近 28 天完賽結果,計算各聯賽
   主場係數 ha 與進球環境 lgAvg,寫入 calib.json(全裝置共用)。 */
const LEAGUES = ["eng.1","esp.1","ita.1","ger.1","fra.1","uefa.champions","uefa.europa","usa.1","jpn.1","eng.2"];
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
const sb = (lg,a,b) => `https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${a}-${b}`;

(async () => {
  const now = new Date();
  const out = { updated: now.toISOString(), n: 0, leagues: {} };
  for (const lg of LEAGUES) {
    let hw=0, dr=0, aw=0, goals=0, n=0;
    for (let seg=0; seg<4; seg++) {                      // 4 段 × 7 天 = 近 28 天
      const b=new Date(now); b.setDate(b.getDate()-seg*7);
      const a=new Date(now); a.setDate(a.getDate()-(seg+1)*7);
      try {
        const r = await fetch(sb(lg, ymd(a), ymd(b)));
        if (!r.ok) continue;
        const j = await r.json();
        for (const ev of (j.events||[])) {
          const c=(ev.competitions||[])[0]; if(!c) continue;
          const st=(c.status||{}).type||{}; if(!st.completed) continue;
          const H=(c.competitors||[]).find(x=>x.homeAway==="home");
          const A=(c.competitors||[]).find(x=>x.homeAway==="away");
          if(!H||!A) continue;
          const hs=+H.score, as=+A.score;
          if(isNaN(hs)||isNaN(as)) continue;
          n++; goals+=hs+as;
          if(hs>as) hw++; else if(hs<as) aw++; else dr++;
        }
      } catch(e) {}
      await new Promise(r=>setTimeout(r,300));
    }
    if (n >= 8) {                                        // 樣本足才輸出,避免小樣本噪音
      const hwr = hw/n;                                  // 實際主勝率 → 主場係數(0.46 主勝率 ≈ 0.24 基準)
      const ha = Math.max(0.05, Math.min(0.45, 0.24 + (hwr-0.46)*1.2));
      const lgAvg = Math.max(1.0, Math.min(2.0, goals/n/2));
      out.leagues[lg] = { ha:+ha.toFixed(3), lgAvg:+lgAvg.toFixed(3), draw:+(dr/n).toFixed(3), n };
      out.n += n;
    }
  }
  require("fs").writeFileSync("calib.json", JSON.stringify(out, null, 1));
  console.log("calib.json 已更新:", out.n, "場,", Object.keys(out.leagues).length, "個聯賽");
})();
