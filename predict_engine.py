#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
predict_engine.py — 自動產生下一輪預測(免金鑰)
====================================================
偵測 ESPN 上「尚未開賽」的世界盃比賽,若 data.js / predictions.js 還沒有預測,
就用 Poisson 模型自動算出勝率、比分預測、晉級預測、信心等級,輸出成 predictions.js。

模型:
  以各隊實力評級(RATINGS)推導雙方預期進球(xG),再用 Poisson 分布
  展開所有比分組合 → 得到 主勝/和局/客勝 機率與最可能比分。
  地主(USA/MEX/CAN)對非地主時給予主場加成;其餘視為中立場地。

用法:
  python predict_engine.py                       # 抓 ESPN 未開賽賽程,輸出 predictions.js
  python predict_engine.py --espn-file mock.json # 測試用,讀本地檔
"""
import argparse, json, math, datetime, urllib.request, os

OUT_FILE = "predictions.js"
HOSTS = {"USA", "MEX", "CAN"}          # 2026 地主
COEF, BASE, HOME_ADV = 0.030, 1.30, 0.22

RATINGS_FILE = "ratings.json"
PREDLOG_FILE = "predictions_log.json"
ADJUST_FILE  = "adjust.json"     # 由 injury_engine.py 產生的各隊戰力折扣

def load_adjust():
    try:
        with open(ADJUST_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}
ADJUST = load_adjust()

# ---- 實力評級(基準值;若有 ratings.json 則以其為準,由 review_engine.py 自動校準) ----
BASE_RATINGS = {
    "FRA":92,"ESP":91,"ARG":90,"BRA":86,"ENG":86,"POR":83,"MAR":79,"BEL":78,
    "NOR":77,"COL":75,"SUI":73,"USA":70,"MEX":69,"NED":85,"GER":84,"CRO":78,
    "CAN":66,"EGY":63,"PAR":63,"AUS":60,"SEN":72,"ECU":68,"AUT":70,"SWE":69,
    "DZA":64,"GHA":62,"CIV":65,"CPV":52,"BIH":63,"COD":58,"JPN":72,"URU":76,
}
def load_ratings():
    r = dict(BASE_RATINGS)
    try:
        with open(RATINGS_FILE, encoding="utf-8") as f:
            r.update(json.load(f))          # 校準後的評級覆蓋基準
    except Exception:
        pass
    return r
RATINGS = load_ratings()
CODE_TO_ZH = {
    "NED":"荷蘭","MAR":"摩洛哥","CIV":"象牙海岸","NOR":"挪威","FRA":"法國","SWE":"瑞典",
    "MEX":"墨西哥","ECU":"厄瓜多","ENG":"英格蘭","COD":"剛果","BEL":"比利時","SEN":"塞內加爾",
    "USA":"美國","BIH":"波士尼亞","ESP":"西班牙","AUT":"奧地利","POR":"葡萄牙","CRO":"克羅埃西亞",
    "SUI":"瑞士","DZA":"阿爾及利亞","AUS":"澳洲","EGY":"埃及","ARG":"阿根廷","CPV":"維德角",
    "COL":"哥倫比亞","GHA":"迦納","CAN":"加拿大","PAR":"巴拉圭","BRA":"巴西",
    "GER":"德國","JPN":"日本","URU":"烏拉圭",
}
NAME_TO_CODE = {
    "netherlands":"NED","morocco":"MAR","norway":"NOR","france":"FRA","sweden":"SWE",
    "mexico":"MEX","ecuador":"ECU","england":"ENG","belgium":"BEL","senegal":"SEN",
    "usa":"USA","united states":"USA","spain":"ESP","austria":"AUT","portugal":"POR",
    "croatia":"CRO","switzerland":"SUI","algeria":"DZA","australia":"AUS","egypt":"EGY",
    "argentina":"ARG","cape verde":"CPV","colombia":"COL","ghana":"GHA","canada":"CAN",
    "paraguay":"PAR","brazil":"BRA","germany":"GER","japan":"JPN","uruguay":"URU",
    "dr congo":"COD","bosnia and herzegovina":"BIH","ivory coast":"CIV",
}

def poisson(k, lam):
    return math.exp(-lam) * lam**k / math.factorial(k)

def predict(hc, ac):
    """回傳 (主勝%, 和%, 客勝%, 預測主分, 預測客分, xg_h, xg_a)"""
    rh, ra = RATINGS.get(hc, 65), RATINGS.get(ac, 65)
    d = rh - ra
    if hc in HOSTS and ac not in HOSTS:   adv = HOME_ADV
    elif ac in HOSTS and hc not in HOSTS: adv = -HOME_ADV
    else:                                  adv = 0.0
    lh = BASE * math.exp(COEF*d/2 + adv/2)
    la = BASE * math.exp(-COEF*d/2 - adv/2)
    # 傷停折扣:關鍵球員缺陣 → 該隊預期進球下修(來自 injury_engine.py)
    lh *= ADJUST.get(hc, 1.0)
    la *= ADJUST.get(ac, 1.0)
    lh, la = max(0.2, min(lh, 4.5)), max(0.2, min(la, 4.5))
    H = D = A = 0.0
    for i in range(10):
        for j in range(10):
            p = poisson(i, lh) * poisson(j, la)
            if i > j:   H += p
            elif i == j: D += p
            else:        A += p
    t = H + D + A
    H, D, A = H/t*100, D/t*100, A/t*100
    # 比分:用期望進球四捨五入,並確保與看好的一方一致(避免出現「看好主隊卻預測客隊贏」)
    si, sj = int(round(lh)), int(round(la))
    if la < 0.75: sj = 0                          # 弱隊期望進球極低 → 預測零封
    if lh < 0.75: si = 0
    if H >= A and si <= sj: si = sj + 1           # 看好主勝 → 主隊多一球
    elif A > H and sj <= si: sj = si + 1          # 看好客勝 → 客隊多一球
    if abs(H - A) < 6:                            # 極接近 → 給和局比分
        si = sj = max(1, int(round((lh + la) / 2)))
    return round(H, 1), round(D, 1), round(A, 1), si, sj, lh, la

def confidence(h, d, a):
    """三方機率越集中 → 信心越高"""
    top = max(h, d, a)
    if top >= 60: return "hi"
    if top >= 45: return "mid"
    return "lo"

def make_reason(hc, ac, h, d, a, si, sj):
    hz, az = CODE_TO_ZH.get(hc, hc), CODE_TO_ZH.get(ac, ac)
    fav, fp = (hz, h) if h >= a else (az, a)
    gap = abs(h - a)
    if gap >= 30:
        tone = f"{fav}實力明顯領先({fp}%),預期能穩定掌控。"
    elif gap >= 12:
        tone = f"{fav}略占上風({fp}%),但對手具備一定抵抗力。"
    else:
        tone = f"勢均力敵的硬仗,{fav}僅微幅領先({fp}%),和局機率也達 {d}%,不排除延長賽或 PK。"
    host = ""
    if hc in HOSTS and ac not in HOSTS: host = f"{hz}為地主、享有主場加成,已納入計算。"
    elif ac in HOSTS and hc not in HOSTS: host = f"{az}為地主、享有主場加成,已納入計算。"
    inj = ""
    if ADJUST.get(hc, 1.0) < 0.97: inj += f"{hz}有傷停影響、戰力已下修。"
    if ADJUST.get(ac, 1.0) < 0.97: inj += f"{az}有傷停影響、戰力已下修。"
    return f"（模型自動預測）{tone}{host}{inj}預期比分 {si}-{sj}。實際仍需視當日先發、傷停與狀態調整。"

def team_code(team):
    ab = (team.get("abbreviation") or "").upper()
    if ab in RATINGS or ab in CODE_TO_ZH: return ab
    for k in ("displayName", "shortDisplayName", "name"):
        nm = (team.get(k) or "").strip().lower()
        if nm in NAME_TO_CODE: return NAME_TO_CODE[nm]
    return ab or None

def fetch_upcoming(days_ahead=14, espn_file=None):
    """回傳尚未開賽的比賽 [(home, away, iso_date)]"""
    base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
    out, seen = [], set()
    def handle(data):
        for ev in data.get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            st = (comp.get("status", {}).get("type") or {})
            if st.get("completed"): continue           # 已完賽 → 交給 update_matches.py
            cs = comp.get("competitors", [])
            hm = next((c for c in cs if c.get("homeAway") == "home"), None)
            aw = next((c for c in cs if c.get("homeAway") == "away"), None)
            if not hm or not aw: continue
            hc, ac = team_code(hm.get("team", {})), team_code(aw.get("team", {}))
            if not hc or not ac or (hc, ac) in seen: continue
            # ESPN 對未定隊伍用 W97 / RU101 之類的佔位代碼,需略過
            import re as _re
            if any(_re.fullmatch(r"(W|RU)\d+", x or "") for x in (hc, ac)): continue
            if "TBD" in (hc, ac): continue
            out.append((hc, ac, (ev.get("date") or "")[:10]))
            seen.add((hc, ac))
    if espn_file:
        with open(espn_file, encoding="utf-8") as f: handle(json.load(f))
        return out
    today = datetime.datetime.utcnow().date()
    for i in range(days_ahead):
        d = (today + datetime.timedelta(days=i)).strftime("%Y%m%d")
        try:
            with urllib.request.urlopen(f"{base}?dates={d}", timeout=30) as r:
                handle(json.load(r))
        except Exception as e:
            print(f"  (略過 {d}:{e})")
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--espn-file")
    ap.add_argument("--days", type=int, default=8)
    ap.add_argument("--out", default=OUT_FILE)
    args = ap.parse_args()

    games = fetch_upcoming(args.days, args.espn_file)
    preds = {}
    for hc, ac, date in games:
        h, d, a, si, sj, lh, la = predict(hc, ac)
        adv = CODE_TO_ZH.get(hc if h >= a else ac)
        preds[f"{hc.lower()}-{ac.lower()}"] = {
            "prob": {"h": h, "d": d, "a": a},
            "score": [si, sj],
            "advance": adv,
            "conf": confidence(h, d, a),
            "reason": make_reason(hc, ac, h, d, a, si, sj),
            "date": date,
        }

    ts = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")

    # 記錄預測(供 review_engine.py 日後比對;已存在的不覆蓋,保留「當初的預測」)
    try:
        with open(PREDLOG_FILE, encoding="utf-8") as f: log = json.load(f)
    except Exception:
        log = {}
    added = 0
    for mid, p in preds.items():
        if mid not in log:
            log[mid] = {"prob": p["prob"], "score": p["score"],
                        "advance": p["advance"], "logged_at": ts}
            added += 1
    with open(PREDLOG_FILE, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)

    lines = [f"/* 由 predict_engine.py 自動產生於 {ts} — 請勿手改 */",
             f'const PREDICTIONS_UPDATED = "{ts}";', "const AUTO_PREDICTIONS = {"]
    for mid, p in sorted(preds.items()):
        pr = p["prob"]
        lines.append(
            f'  "{mid}": {{prob:{{h:{pr["h"]},d:{pr["d"]},a:{pr["a"]}}}, '
            f'score:[{p["score"][0]},{p["score"][1]}], advance:"{p["advance"]}", '
            f'conf:"{p["conf"]}", date:"{p["date"]}", reason:"{p["reason"]}"}},'
        )
    lines.append("};")
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"✅ 已寫入 {args.out},自動預測 {len(preds)} 場未開賽比賽(新登錄 {added} 場至 {PREDLOG_FILE})")
    for mid, p in sorted(preds.items()):
        pr = p["prob"]
        print(f"   {mid:>10}  主{pr['h']}% 和{pr['d']}% 客{pr['a']}%  "
              f"{p['score'][0]}-{p['score'][1]}  晉級:{p['advance']}  信心:{p['conf']}")

if __name__ == "__main__":
    main()
