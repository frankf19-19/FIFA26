/* 雲端統一預測 v1(e140)
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
js += "\n;window.__m={predict,parseEvents,gradeFinished,computeTuning,loadInjuries,loadStandFor,espnScore,jget,scGet,scSet,noPredGate,LEAGUES,adjGet,adGet,mktWGet,ymd,isoDate};";
w.eval(js);
const m = w.__m;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

(async () => {
  try { w.CLOUD = JSON.parse(fs.readFileSync("calib.json", "utf8")); } catch (e) { console.log("calib.json 讀取失敗:", e.message); }
  // 雲端模式:關閉本機線上學習器以外的東西都照常;先用上次帳本算出學習參數
  try { m.computeTuning(); } catch (e) { console.log("computeTuning:", e.message); }
  try { await m.loadInjuries(); } catch (e) { console.log("傷停:", e.message); }

  const now = new Date();
  const d0 = new Date(now); d0.setDate(d0.getDate() - 2);
  const d1 = new Date(now); d1.setDate(d1.getDate() + 2);
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
        const pp = m.predict(g.hn, g.an, g.odds, l.id, g.hid, g.aid);
        if (m.noPredGate(pp, l.id) || !((pp.dq || 0) >= 0.2)) continue;
        if (ex && ex.hs != null) continue;              // 已評分不動
        sc[g.id] = { ...(ex || {}),
          pred: { H: pp.H, D: pp.D, A: pp.A, si: pp.si, sj: pp.sj, conf: pp.conf, pick: pp.pick, lh: pp.lh, la: pp.la, prs: pp.prs, pw: pp.pw, pls: pp.pls, plw: pp.plw },
          odds: (g.odds || (ex && ex.odds) || null), odds0: ((ex && ex.odds0) || g.odds || null),
          dq: pp.dq, t: (ex && ex.t) || Date.now(), tU: Date.now(), v: 2, locked: 1, lg: l.id,
          hn: g.hn, an: g.an, hid: g.hid, aid: g.aid, date: g.date, cl: 1 };
        changed = true; nPred++;
      }
      if (changed) m.scSet(sc);
      await sleep(150);
    } catch (e) { console.log("聯賽失敗:", l.id, e.message); }
  }
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
  const out = { updated: new Date().toISOString(), n: Object.keys(sc).length, graded: graded.length, hit, sc, byKey, params, seeded: state.seeded || 0 };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`完成:新預測/更新 ${nPred} 場 · 鎖定 ${nLock} 場 · 評分檢查 ${nDone} 場 · 帳本 ${out.n} 筆 · 已評分 ${graded.length}(命中 ${hit})`);
  process.exit(0);
})().catch(e => { console.log("失敗:", e.stack || e.message); process.exit(0); });
