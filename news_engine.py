#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
news_engine.py — 自動產生頭條新聞(免金鑰)
==============================================
不依賴任何新聞 API,直接從既有資料「生成」頭條:
  · 完賽賽果  → 賽果 / 爆冷 / 晉級 頭條
  · 爆冷偵測  → 以當初預測的勝率判斷(低勝率一方獲勝 = 爆冷)
  · 即將開賽  → 焦點對決頭條(取最接近五五波、或含強權的比賽)
輸出 headlines.js(定義 AUTO_HEADLINES),前端會自動載入。

用法:
  python news_engine.py
"""
import json, datetime, urllib.request

RESULTS_FILE = "results_state.json"
PREDLOG_FILE = "predictions_log.json"
PREDS_FILE   = "predictions.js"     # 只讀日期用;解析失敗也無妨
OUT_FILE     = "headlines.js"
ESPN_NEWS    = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news"

def fetch_espn_news(espn_file=None, limit=6):
    """抓 ESPN 公開新聞標題(免金鑰)。回傳 (清單, 診斷字串)。
       解析盡量寬容:標題/連結可能在不同欄位,能抓多少算多少。"""
    data = None
    diag = ""
    if espn_file:
        try:
            with open(espn_file, encoding="utf-8") as f: data = json.load(f)
        except Exception as e:
            return [], f"讀檔失敗:{e}"
    else:
        # ESPN 對無 UA 的請求有時會擋,補上瀏覽器 UA;兩個網域都試
        urls = [
            "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news",
            "https://site.web.api.espn.com/apis/site/v2/sports/soccer/fifa.world/news?region=us&lang=en",
        ]
        for u in urls:
            try:
                req = urllib.request.Request(u, headers={
                    "User-Agent": "Mozilla/5.0 (compatible; WCbot/1.0)",
                    "Accept": "application/json",
                })
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.load(r); diag = f"OK:{u.split('//')[1][:22]}"
                    break
            except Exception as e:
                diag = f"連線失敗:{type(e).__name__}"
        if data is None:
            print(f"  (ESPN 新聞端點無回應:{diag} — 改用自動生成頭條)")
            return [], diag

    # articles 可能在 data['articles'] 或 data['feed'] 或巢狀
    arts = data.get("articles") or data.get("feed") or []
    if isinstance(arts, dict):
        arts = arts.get("results") or arts.get("items") or []

    def dig_link(a):
        # 連結可能藏在 links.web.href / links.mobile.href / link / links[0].href
        L = a.get("links")
        if isinstance(L, dict):
            for k in ("web", "mobile", "self"):
                if isinstance(L.get(k), dict) and L[k].get("href"): return L[k]["href"]
        if isinstance(L, list):
            for it in L:
                if isinstance(it, dict) and it.get("href"): return it["href"]
        return a.get("link") or ""

    out = []
    for a in arts[:limit]:
        if not isinstance(a, dict): continue
        headline = (a.get("headline") or a.get("title") or a.get("description") or "").strip()
        if not headline: continue
        published = (a.get("published") or a.get("lastModified") or a.get("date") or "")[:10]
        out.append({"t": headline, "d": published or "ESPN", "link": dig_link(a)})
    if not out and diag.startswith("OK"):
        diag += f"(articles={len(arts)}但無可用標題)"
    return out, diag

CODE_TO_ZH = {
    "NED":"荷蘭","MAR":"摩洛哥","CIV":"象牙海岸","NOR":"挪威","FRA":"法國","SWE":"瑞典",
    "MEX":"墨西哥","ECU":"厄瓜多","ENG":"英格蘭","COD":"剛果","BEL":"比利時","SEN":"塞內加爾",
    "USA":"美國","BIH":"波士尼亞","ESP":"西班牙","AUT":"奧地利","POR":"葡萄牙","CRO":"克羅埃西亞",
    "SUI":"瑞士","DZA":"阿爾及利亞","AUS":"澳洲","EGY":"埃及","ARG":"阿根廷","CPV":"維德角",
    "COL":"哥倫比亞","GHA":"迦納","CAN":"加拿大","PAR":"巴拉圭","BRA":"巴西",
    "GER":"德國","JPN":"日本","URU":"烏拉圭",
}
POWERS = {"FRA","ESP","ARG","BRA","ENG","POR","NED","GER"}

def load(p, d):
    try:
        with open(p, encoding="utf-8") as f: return json.load(f)
    except Exception: return d

def zh(c): return CODE_TO_ZH.get(c.upper(), c.upper())

def build(espn_file=None):
    results = load(RESULTS_FILE, {})
    predlog = load(PREDLOG_FILE, {})
    news = []

    # ---- 0) 優先:ESPN 真實新聞(免金鑰);抓不到就往下用自動生成 ----
    real, diag = fetch_espn_news(espn_file)
    for a in real:
        news.append({"tag": "news", "t": a["t"], "d": a["d"], "team": "", "link": a.get("link", "")})

    # ---- 1) 完賽頭條(依爆冷程度排序) ----
    scored = []
    for mid, res in results.items():
        hc, ac = [s.upper() for s in mid.split("-")]
        hs, as_ = res["score"]
        adv = res.get("advanced", "")
        pk  = res.get("pk", False)
        pred = predlog.get(mid)

        # 爆冷程度:實際晉級方,當初預測的勝率有多低
        upset = 0.0
        if pred:
            prob = pred["prob"]
            if adv == zh(hc):   upset = 100 - prob["h"]
            elif adv == zh(ac): upset = 100 - prob["a"]

        margin = abs(hs - as_)
        loser = zh(ac) if adv == zh(hc) else zh(hc)
        if upset >= 62:          # 大冷門
            tag = "upset"
            t = f"大爆冷!{adv} 淘汰 {loser},{hs}-{as_}{' (PK)' if pk else ''}寫下驚奇"
        elif pk:
            tag = "adv"
            t = f"{adv} PK 大戰勝出,{hs}-{as_} 驚險晉級"
        elif margin >= 3:
            tag = "result"
            t = f"{adv} {max(hs,as_)}-{min(hs,as_)} 大勝 {loser},展現壓倒性實力"
        else:
            tag = "result"
            t = f"{zh(hc)} {hs}-{as_} {zh(ac)},{adv} 晉級下一輪"

        team = hc if adv == zh(hc) else ac
        scored.append((upset, {"tag": tag, "t": t, "d": "剛結束", "team": team}))

    scored.sort(key=lambda x: -x[0])              # 最冷門的排前面
    news.extend(n for _, n in scored[: max(2, 5 - len(news))])

    # ---- 2) 即將開賽的焦點對決 ----
    focus = []
    for mid, p in predlog.items():
        if mid in results:  continue              # 已完賽
        hc, ac = [s.upper() for s in mid.split("-")]
        prob = p["prob"]
        closeness = 100 - abs(prob["h"] - prob["a"])       # 越接近越五五波
        has_power = hc in POWERS or ac in POWERS
        score = closeness + (12 if has_power else 0)
        if abs(prob["h"] - prob["a"]) < 12:
            t = f"焦點五五波:{zh(hc)} vs {zh(ac)},勝負難分"
        elif has_power:
            fav = zh(hc) if prob["h"] >= prob["a"] else zh(ac)
            t = f"{zh(hc)} 對決 {zh(ac)},模型看好 {fav} 晉級"
        else:
            t = f"{zh(hc)} vs {zh(ac)} 即將登場"
        focus.append((score, {"tag": "focus", "t": t, "d": "即將開賽", "team": hc}))

    focus.sort(key=lambda x: -x[0])
    news.extend(n for _, n in focus[:3])

    if not news:
        news = [{"tag": "info", "t": "賽事資料更新中,稍後將自動載入最新頭條", "d": "系統", "team": ""}]
    return news[:8], diag

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--espn-file")
    args = ap.parse_args()
    news, diag = build(args.espn_file)
    ts = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")
    real_n = sum(1 for x in news if x.get("tag") == "news")
    lines = [f"/* 由 news_engine.py 自動產生於 {ts} — 請勿手改 */",
             f'const HEADLINES_UPDATED = "{ts}";',
             f'const NEWS_DIAG = {{real:{real_n}, note:"{diag}"}};',
             "const AUTO_HEADLINES = ["]
    for it in news:
        t = it["t"].replace('"', "'")
        link = it.get("link", "")
        lines.append(f'  {{tag:"{it["tag"]}", t:"{t}", d:"{it["d"]}", team:"{it["team"]}", link:"{link}"}},')
    lines.append("];")
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    real_n = sum(1 for x in news if x.get("tag") == "news")
    print(f"✅ 已寫入 {OUT_FILE}: {len(news)} 則頭條(其中 ESPN 真實新聞 {real_n} 則;診斷:{diag or '—'})")
    for n in news:
        print(f"   [{n['tag']:>6}] {n['t']}")

if __name__ == "__main__":
    main()
