/* 雲端統一預測 v9(停抓空的傷停 API、對戰視窗 5→9 天)
   v8(e180:開賽前 2 小時抓先發名單餵模型 —— 先發陣容層原本只在前端跑,
   但「鎖定值」是雲端產生的,等於這層從來沒有進到正式預測裡。)
   v7(e162:快照存 h2l —— 近 5 次交手日期與比分,供列表直接顯示)
   v6(e159:賽前抓歷史對戰餵模型、快照存 sc3/h2)
   v5(e154:評分視窗 -4~+3 天、孤兒預測清掃、積分榜 feed 瘦身)
   v4(e151:CORS 偵測追蹤 + v3 斷供備援)
   v3:ESPN 於 2026-08-27 起移除瀏覽器跨域(CORS)支援,前端直連全滅。
   本腳本(Node 端不受 CORS 限制)照常抓取,並把賽程/積分榜/傷停打包進 cloud-pred.json 的 feed 欄位,
   前端 jget 失敗時自動改吃 feed → 網站功能維持,更新頻率降為每 30 分鐘。
   在 GitHub Actions 裡用 jsdom 載入 index.html「同一份模型程式」,讀 calib.json、抓 ESPN 賽程/傷停/積分榜,
   對未開賽的比賽做預測並鎖定、對已完賽的比賽評分,全部寫進 cloud-pred.json。
   瀏覽器開站時先吃 cloud-pred.json → 手機、電腦、任何人看到的預測數字與學習參數完全一致。
   無前視:開賽後的比賽只保留最後一次賽前鎖定值,完賽評分用的是鎖定值。 */
const fs = require("fs");
const { JSDOM } = require("jsdom");

const OUT = "cloud-pred.json";
const html = fs.readFileSync("index.html", "utf8");
let state = { updated: "", sc: {}, params: {} };
try { state = JSON.parse(fs.readFileSync(OUT, "utf8")) || state; } catch (e) {}
/* 種子:第一次啟用雲端時,把電腦上匯出的學習資料(seed-ledger.json)接過來,學習不用從零開始;只接一次 */
try {
  if (!state.seeded && fs.existsSync("seed-ledger.json")) {
    const seed = JSON.parse(fs.readFileSync("seed-ledger.json", "utf8")); const D = (seed && seed.data) || {};
    const sc = D.euroSC ? JSON.parse(D.euroSC) : {}; let n = 0;
    state.sc = state.sc || {}; for (const id in sc) { if (!state.sc[id]) { state.sc[id] = sc[id]; n++; } }
    state.params = state.params || {};
    for (const k of ["euroADJ", "euroAD", "euroMKTW", "euroADv2", "euroLGD", "euroDYN"]) if (D[k] != null && state.params[k] == null) state.params[k] = D[k];
    state.seeded = seed.t || true; console.log("已接入種子帳本:", n, "場");
  }
} catch (e) { console.log("種子讀取失敗:", e.message); }

const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://frankf19-19.github.io/FIFA26/" });
const w = dom.window;
w.fetch = (u, o) => fetch(u, o);
w.scrollTo = () => {}; w.scrollBy = () => {}; w.alert = () => {}; w.confirm = () => false;
// 還原上次的學習狀態(帳本、評級校準、攻防乘數、市場權重)→ 學習參數與上次一致、可累積
try {
  w.localStorage.setItem("euroSC", JSON.stringify(state.sc || {}));
  for (const k of ["euroADJ", "euroAD", "euroMKTW", "euroADv2", "euroLGD", "euroDYN"]) if (state.params && state.params[k] != null) w.localStorage.setItem(k, state.params[k]);
} catch (e) {}

let js = html.match(/<script>([\s\S]*)<\/script>/)[1];
js = js.replace(/\binit\(\);?\s*$/, "");          // 不跑頁面初始化(不需要 UI/計時器)
/* v3:包住 jget,凡抓到的 ESPN 賽程/積分榜/傷停都收進 FEED(賽程做欄位瘦身),存進 cloud-pred.json 給前端備援 */
js += `\n;window.__FEED={sb:{},st:{},inj:{}};
(function(){ const j0=jget;
  const slim=ev=>{ try{ const c=(ev.competitions||[])[0]||{}; return {
    id:ev.id, date:ev.date, weather:ev.weather||c.weather||undefined,
    competitions:[{ status:c.status, venue:c.venue?{fullName:c.venue.fullName||c.venue.displayName}:undefined,
      odds:(c.odds&&c.odds[0])?[{provider:c.odds[0].provider,details:c.odds[0].details,moneyline:c.odds[0].moneyline,homeTeamOdds:c.odds[0].homeTeamOdds,awayTeamOdds:c.odds[0].awayTeamOdds,drawOdds:c.odds[0].drawOdds}]:[],
      competitors:(c.competitors||[]).map(x=>({homeAway:x.homeAway,score:x.score,winner:x.winner,records:x.records,team:x.team?{id:x.team.id,displayName:x.team.displayName,logo:x.team.logo,abbreviation:x.team.abbreviation}:{}})) }] };
  }catch(e){ return null; } };
  jget=async function(url,live){ const j=await j0(url,live);
    try{ const u=String(url);
      let m=u.match(/soccer\\/([a-z0-9._]+)\\/scoreboard/);
      if(m&&j&&j.events){ const lg=m[1]; const B=(window.__FEED.sb[lg]=window.__FEED.sb[lg]||{});
        j.events.forEach(ev=>{ const s=slim(ev); if(s&&s.id) B[s.id]=s; }); }
      m=u.match(/soccer\\/([a-z0-9._]+)\\/standings/); if(m&&j) window.__FEED.st[m[1]]=j;
      m=u.match(/soccer\\/([a-z0-9._]+)\\/injuries/); if(m&&j) window.__FEED.inj[m[1]]=j;
    }catch(e){}
    return j; };
})();`;
js += "\n;window.__m={predict,parseEvents,gradeFinished,computeTuning,loadInjuries,loadStandFor,espnScore,jget,scGet,scSet,noPredGate,LEAGUES,adjGet,adGet,mktWGet,ymd,isoDate,loadH2H,loadLineup,XI_CACHE};";
w.eval(js);
const m = w.__m;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

(async () => {
  try { const C = JSON.parse(fs.readFileSync("calib.json", "utf8"));
    for (const lg in (C.leagues || {})) { const T = C.leagues[lg] && C.leagues[lg].teams; if (!T) continue; for (const k in T) { const t = T[k]; if (t && t.$ && T[t.$]) T[k] = T[t.$]; } }   // v5:calib v12 別名還原
    w.CLOUD = C; } catch (e) { console.log("calib.json 讀取失敗:", e.message); }
  // 雲端模式:關閉本機線上學習器以外的東西都照常;先用上次帳本算出學習參數
  try { m.computeTuning(); } catch (e) { console.log("computeTuning:", e.message); }
  // v9:傷停 API 對 18 個聯賽全部回傳 0 隊 0 人(實測 415 場鎖定快照無一場有傷停資料),每輪白打 18 次請求 → 停抓;先發名單層取代它
  // try { await m.loadInjuries(); } catch (e) {}

  const now = new Date();
  const d0 = new Date(now); d0.setDate(d0.getDate() - 4);   // v5:GitHub 排程可能延後數小時~一天,視窗放寬避免漏評
  const d1 = new Date(now); d1.setDate(d1.getDate() + 3);
  let nPred = 0, nLock = 0, nDone = 0;
  const allGames = [];
  for (const l of m.LEAGUES) {
    try {
      try { await m.loadStandFor(l.id); } catch (e) {}
      const data = await m.jget(m.espnScore(l.id, ymd(d0) + "-" + ymd(d1)), true);
      const games = m.parseEvents(data);
      games.forEach(g => { g.league = l.id; allGames.push(g); });
      const sc = m.scGet(); let changed = false;
      for (const g of games) {
        const ex = sc[g.id];
        const kick = Date.parse(g.date) || g.ts || 0;
        const started = g.state !== "pre" || (kick > 0 && Date.now() >= kick);
        if (started) {
          if (ex && ex.pred && !ex.fz) { ex.fz = { ...ex.pred }; ex.fzT = ex.tU || ex.t || Date.now(); ex.lg = ex.lg || l.id; changed = true; nLock++; }   // 鎖定時間 = 最後一次「賽前」預測時間
          continue;                                   // 已開賽:不再改預測(誠信)
        }
        let h2l = null;
        if (g.hid && g.aid && (kick - Date.now()) < 9 * 86400000) {   // v9:5→9 天,對戰層覆蓋率 13/62 太低,學習迴路沒樣本   // v7:5 天內的比賽先抓歷史對戰(快取)再預測,並存下逐場比分
          try { const L = await m.loadH2H(l.id, g.hid, g.aid); await sleep(120);
            if (Array.isArray(L) && L.length) h2l = L.slice(0, 5).map(x => [String(x.dt || x.d).slice(0, 10), +x.my, +x.op, x.home ? 1 : 0]);
          } catch (e) {}
        }
        // v8:開賽前 2 小時內 → 抓當日先發名單,讓陣容層真正進到鎖定值
        const mins = (kick - Date.now()) / 60000;
        if (g.hid && g.aid && kick > 0 && mins > -5 && mins < 125) {
          try { await m.loadLineup(l.id, g.id, g.hid, g.aid); await sleep(150); } catch (e) {}
        }
        const pp = m.predict(g.hn, g.an, g.odds, l.id, g.hid, g.aid, g.id);
        if (m.noPredGate(pp, l.id) || !((pp.dq || 0) >= 0.2)) continue;
        if (ex && ex.hs != null) continue;              // 已評分不動
        sc[g.id] = { ...(ex || {}),
          pred: { H: pp.H, D: pp.D, A: pp.A, si: pp.si, sj: pp.sj, conf: pp.conf, pick: pp.pick, lh: pp.lh, la: pp.la, prs: pp.prs, pw: pp.pw, pls: pp.pls, plw: pp.plw,
            ...(pp.sc3?{sc3:pp.sc3}:{}), ...(pp.h2s!=null?{h2s:pp.h2s,h2w:pp.h2w}:{}), ...(pp.h2?{h2:pp.h2}:{}), ...(h2l?{h2l}:{}), ...(pp.xi?{xi:pp.xi}:{}),
            ...(pp.pure?{pure:pp.pure}:{}), ...(pp.mkp?{mkp:pp.mkp}:{}), ...(pp.mw!=null?{mw:pp.mw}:{}) },   // v2:對戰莊家原料(純模型/市場/權重)
          odds: (g.odds || (ex && ex.odds) || null), odds0: ((ex && ex.odds0) || g.odds || null),
          dq: pp.dq, t: (ex && ex.t) || Date.now(), tU: Date.now(), v: 2, locked: 1, lg: l.id,
          hn: g.hn, an: g.an, hid: g.hid, aid: g.aid, date: g.date, cl: 1 };
        changed = true; nPred++;
      }
      if (changed) m.scSet(sc);
      await sleep(150);
    } catch (e) { console.log("聯賽失敗:", l.id, e.message); }
  }
  // v5:孤兒清掃 —— 已鎖定但超出視窗仍未評分的預測:有 lg+date 的補抓該日賽程評分;對不上且超過 14 天的標作廢(不計命中/Brier)
  try {
    const sc1 = m.scGet(); const inWin = new Set(allGames.map(g => String(g.id)));
    const orph = Object.keys(sc1).filter(id => { const s = sc1[id]; return s && s.pred && s.hs == null && !s.void && !inWin.has(String(id)); });
    let nFix = 0, nVoid = 0, nReq = 0; const seen = {};
    for (const id of orph) {
      const s = sc1[id]; const kick = Date.parse(s.date || "") || 0; const made = s.tU || s.t || 0;
      if (kick ? (Date.now() - kick < 3 * 3600000) : (Date.now() - made < 3 * 86400000)) continue;   // 還沒踢完/太新 → 不動
      if (s.lg && kick && nReq < 12) {
        const key = s.lg + "|" + ymd(new Date(kick));
        try {
          if (!seen[key]) { nReq++; seen[key] = m.parseEvents(await m.jget(m.espnScore(s.lg, ymd(new Date(kick))), true)) || []; await sleep(150); }
          const g = seen[key].find(x => String(x.id) === String(id));
          if (g) { g.league = s.lg; if (g.completed && g.hs != null) { allGames.push(g); nFix++; continue; } }
        } catch (e) {}
      }
      const age = Date.now() - (kick || made);
      if (age > 14 * 86400000) { s.void = true; s.vr = "orphan"; nVoid++; }
    }
    if (nVoid) m.scSet(sc1);
    if (orph.length) console.log(`孤兒預測 ${orph.length} 筆:補評 ${nFix} · 作廢 ${nVoid}`);
  } catch (e) { console.log("孤兒清掃:", e.message); }
  // 完賽評分(同一套 gradeFinished:含射正/過程資料,學習迴路全部照走)
  try { const sc0 = m.scGet();
    const done = allGames.filter(g => g.completed && g.hs != null && sc0[g.id] && sc0[g.id].pred);   // 只評「賽前已鎖定」的比賽(無前視)
    nDone = done.length; await m.gradeFinished(done); } catch (e) { console.log("評分:", e.message); }
  try { m.computeTuning(); } catch (e) {}

  const sc = m.scGet();
  const byKey = {};
  for (const id in sc) { const s = sc[id]; if (s && s.lg && s.hid && s.aid) byKey[s.lg + "|" + s.hid + "|" + s.aid] = id; }
  const params = {};
  for (const k of ["euroADJ", "euroAD", "euroMKTW", "euroADv2", "euroLGD", "euroDYN"]) { try { const v = w.localStorage.getItem(k); if (v != null) params[k] = v; } catch (e) {} }
  const graded = Object.values(sc).filter(s => s && s.pred && s.hs != null && !s.void);
  const hit = graded.filter(s => s.hit).length;
  // v3:賽程 feed —— 每聯賽保留近 4 天事件(避免無限膨脹),連同積分榜與傷停一起發布
  let feed = null;
  try { const F = w.__FEED || {};
    const keep = Date.now() - 4 * 86400000;
    const sb = {}; for (const lg in (F.sb || {})) { const arr = Object.values(F.sb[lg]).filter(e => (Date.parse(e.date) || 0) >= keep); if (arr.length) sb[lg] = arr; }
    // v5:積分榜瘦身 —— 只留前端 loadStandFor 會讀的欄位(1.2MB → 約 60KB)
    const KEEP = new Set(["rank","gamesPlayed","wins","ties","losses","pointsFor","pointsAgainst","pointDifferential","points"]);
    const slimSt = sd => { try { const grs = (sd.children || [sd]).map(gr => { const ents = (((gr.standings && gr.standings.entries) || gr.entries) || []).map(e => { const t = e.team || {};
          return { team: { id: t.id, displayName: t.displayName, name: t.name, logos: (t.logos && t.logos[0]) ? [{ href: t.logos[0].href }] : [] },
            stats: (e.stats || []).filter(x => KEEP.has(x.name) || KEEP.has(x.type)).map(x => ({ name: x.name, type: x.type, value: x.value, displayValue: x.displayValue })) }; });
        return { standings: { entries: ents } }; });
      return { children: grs }; } catch (e) { return sd; } };
    const st = {}; for (const lg in (F.st || {})) st[lg] = slimSt(F.st[lg]);
    feed = { t: Date.now(), sb, st, inj: F.inj || {} };
  } catch (e) {}
  // v4:ESPN 跨域(CORS)狀態追蹤 —— 每輪對主站/備站發帶 Origin 的請求,檢查 access-control-allow-origin 是否存在;斷供起點跨輪保留
  let espnCors = null;
  try {
    const probe = async host => { try { const r = await fetch(`https://${host}/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20260101`, { headers: { "Origin": "https://frankf19-19.github.io" } }); return r.headers.get("access-control-allow-origin") != null; } catch (e) { return false; } };
    const a = await probe("site.api.espn.com"), b = await probe("site.web.api.espn.com");
    const prev = state.espnCors || {};
    espnCors = { siteApi: a, webApi: b, checked: new Date().toISOString(),
      siteApiDownSince: a ? null : (prev.siteApiDownSince || new Date().toISOString()),
      webApiDownSince: b ? null : (prev.webApiDownSince || new Date().toISOString()) };
    console.log("ESPN CORS:", "主站", a ? "✔" : "✖", "備站", b ? "✔" : "✖");
  } catch (e) {}
  const out = { updated: new Date().toISOString(), n: Object.keys(sc).length, graded: graded.length, hit, sc, byKey, params, seeded: state.seeded || 0, ...(feed?{feed}:{}), ...(espnCors?{espnCors}:{}) };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`完成:新預測/更新 ${nPred} 場 · 鎖定 ${nLock} 場 · 評分檢查 ${nDone} 場 · 帳本 ${out.n} 筆 · 已評分 ${graded.length}(命中 ${hit})`);
  process.exit(0);
})().catch(e => { console.log("失敗:", e.stack || e.message); process.exit(0); });
