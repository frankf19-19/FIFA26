/* 自我診斷 v1 —— 每 30 分鐘檢查整個系統的健康狀態,寫進 health.json 讓網站顯示;
   發現異常時自動開 GitHub Issue(同一問題只開一次,修好後自動關閉)。 */
const fs = require("fs");
const _f = globalThis.fetch; globalThis.fetch = (u, o) => { o = o || {}; if (!o.signal) { try { o.signal = AbortSignal.timeout(20000); } catch (e) { } } return _f(u, o); };
const RAW = "https://raw.githubusercontent.com/frankf19-19/FIFA26/main/";
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
const now = new Date();
const R = { t: now.toISOString(), ok: true, checks: {}, problems: [] };
function bad(key, msg, sev) { R.checks[key] = { ok: false, msg }; R.problems.push({ key, msg, sev: sev || "warn" }); if ((sev || "warn") === "error") R.ok = false; }
function good(key, msg) { R.checks[key] = { ok: true, msg }; }
async function j(u) { const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
(async () => {
  try { const d = await j(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${ymd(now)}`); good("espn.day", `單日 OK(${(d.events || []).length} 場)`); }
  catch (e) { bad("espn.day", "ESPN 單日 scoreboard 失敗:" + e.message, "error"); }
  try { const d1 = new Date(now); d1.setDate(d1.getDate() + 1); await j(`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${ymd(now)}-${ymd(d1)}`); good("espn.range", "日期區間已恢復(前端/雲端會自動改回區間模式)"); }
  catch (e) { R.checks["espn.range"] = { ok: true, msg: "區間仍 " + e.message + ",逐日模式運作中(正常)" }; }
  let cloud = null;
  try {
    cloud = await j(RAW + "cloud-pred.json?_=" + Date.now());
    const age = (now - new Date(cloud.updated)) / 60000;
    if (age > 90) bad("cloud.age", `雲端預測 ${Math.round(age)} 分鐘沒更新(應每 30 分鐘)`, "error"); else good("cloud.age", `${Math.round(age)} 分鐘前更新`);
    const sc = cloud.sc || {};
    const pend = Object.values(sc).filter(s => s && s.hs == null && !s.void && s.pred).length;
    const stale = Object.values(sc).filter(s => s && s.hs == null && !s.void && s.pred && s.date && (now - new Date(s.date)) / 3600000 > 6 && (now - new Date(s.date)) / 3600000 < 48).length;
    if (pend === 0) bad("cloud.pending", "未開賽預測 0 場(預測產線可能中斷)", "error"); else good("cloud.pending", `${pend} 場未開賽有預測`);
    if (stale >= 5) bad("grading", `${stale} 場完場超過 6 小時仍未評分`, "warn"); else good("grading", stale ? `${stale} 場待評分(正常延遲)` : "評分同步");
  } catch (e) { bad("cloud.age", "cloud-pred.json 讀取失敗:" + e.message, "error"); }
  try { const c = await j(RAW + "calib.json?_=" + Date.now()); const h = (now - new Date(c.updated)) / 3600000;
    if (h > 36) bad("calib.age", `calib.json ${Math.round(h)} 小時沒更新(每日排程可能失敗)`, "warn"); else good("calib.age", `${Math.round(h)} 小時前校準`);
    const lg = Object.keys(c.leagues || {}).length; if (lg < 12) bad("calib.leagues", `calib 只有 ${lg} 個聯賽`, "warn");
    const nT = Object.values(c.leagues || {}).reduce((s, L) => s + Object.keys((L && L.teams) || {}).filter(k => k[0] === "#").length, 0);
    if ((+c.n || 0) < 500 || nT < 150) bad("calib.n", `calib 內容異常:總場數 ${c.n}、球隊 ${nT}(應 ≥500 / ≥150)—— 校準可能抓到空的`, "error"); else good("calib.n", `總場數 ${c.n}、球隊 ${nT}`);
  } catch (e) { bad("calib.age", "calib.json 讀取失敗:" + e.message, "error"); }
  const y = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const det = `details-${y}-${String(y + 1).slice(2)}.json`;
  for (const f of ["teams.json", "players-00.json", det]) {
    try { const r = await fetch(RAW + f, { method: "HEAD" }); if (!r.ok) throw new Error("HTTP " + r.status); good("file." + f, "存在"); }
    catch (e) { bad("file." + f, `${f} 缺失(${e.message})`, "warn"); }
  }
  R.summary = R.ok ? (R.problems.length ? `運作中,${R.problems.length} 項提醒` : "全部正常") : `${R.problems.filter(p => p.sev === "error").length} 項故障`;
  fs.writeFileSync("health.json", JSON.stringify(R));
  console.log(JSON.stringify(R, null, 1));
  const errs = R.problems.filter(p => p.sev === "error");
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (tok && repo) {
    const api = `https://api.github.com/repos/${repo}/issues`;
    const H = { "Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json", "Content-Type": "application/json" };
    const open = await (await fetch(api + "?state=open&labels=auto-health&per_page=10", { headers: H })).json().catch(() => []);
    const body = (errs.length ? errs : R.problems).map(p => `- **${p.key}**:${p.msg}`).join("\n") + `\n\n_自我診斷於 ${R.t}_`;
    if (errs.length) {
      if (Array.isArray(open) && open.length) { await fetch(`${api}/${open[0].number}/comments`, { method: "POST", headers: H, body: JSON.stringify({ body }) }); }
      else { await fetch(api, { method: "POST", headers: H, body: JSON.stringify({ title: "[自我診斷] " + R.summary, body, labels: ["auto-health"] }) }); }
    } else if (Array.isArray(open) && open.length) {
      for (const is of open) await fetch(`${api}/${is.number}`, { method: "PATCH", headers: H, body: JSON.stringify({ state: "closed", body: (is.body || "") + `\n\n✅ 已自動確認恢復(${R.t})` }) });
    }
  }
})().catch(e => { console.log("health failed:", e.message); process.exit(0); });
