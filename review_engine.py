#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
review_engine.py — 自動賽後檢討 + 評級自我校準(免金鑰)
==========================================================
讀取 results_state.json(實際結果)與 predictions_log.json(當初的預測),
自動比對並產生:
  reviews.js   每場「檢討分析」文字(方向/晉級/比分是否命中、誤差在哪、該修什麼)
  ratings.json 依賽果自動微調各隊實力評級 → 下一輪預測會更準(模型自我進化)

校準邏輯(簡化版 Elo/梯度):
  預測 xG 與實際進球的差 → 微調攻防評級。
  贏得比預期多 → 評級上調;輸得比預期慘 → 評級下修。
  每場調整幅度上限 ±2.0,避免單場過度反應。

用法:
  python review_engine.py            # 產生 reviews.js 與更新 ratings.json
"""
import json, os, math, datetime

RESULTS_FILE = "results_state.json"
PREDLOG_FILE = "predictions_log.json"   # 由 predict_engine.py 累積寫入
RATINGS_FILE = "ratings.json"
OUT_REVIEWS  = "reviews.js"

K_RATING   = 1.6     # 每場評級調整強度
MAX_ADJUST = 2.0     # 單場評級調整上限

# 基準評級(需與 predict_engine.py 一致;ratings.json 不存在時作為起點)
BASE_RATINGS = {
    "FRA":92,"ESP":91,"ARG":90,"BRA":86,"ENG":86,"POR":83,"MAR":79,"BEL":78,
    "NOR":77,"COL":75,"SUI":73,"USA":70,"MEX":69,"NED":85,"GER":84,"CRO":78,
    "CAN":66,"EGY":63,"PAR":63,"AUS":60,"SEN":72,"ECU":68,"AUT":70,"SWE":69,
    "DZA":64,"GHA":62,"CIV":65,"CPV":52,"BIH":63,"COD":58,"JPN":72,"URU":76,
}

CODE_TO_ZH = {
    "NED":"荷蘭","MAR":"摩洛哥","CIV":"象牙海岸","NOR":"挪威","FRA":"法國","SWE":"瑞典",
    "MEX":"墨西哥","ECU":"厄瓜多","ENG":"英格蘭","COD":"剛果","BEL":"比利時","SEN":"塞內加爾",
    "USA":"美國","BIH":"波士尼亞","ESP":"西班牙","AUT":"奧地利","POR":"葡萄牙","CRO":"克羅埃西亞",
    "SUI":"瑞士","DZA":"阿爾及利亞","AUS":"澳洲","EGY":"埃及","ARG":"阿根廷","CPV":"維德角",
    "COL":"哥倫比亞","GHA":"迦納","CAN":"加拿大","PAR":"巴拉圭","BRA":"巴西",
    "GER":"德國","JPN":"日本","URU":"烏拉圭",
}

def load(path, default):
    try:
        with open(path, encoding="utf-8") as f: return json.load(f)
    except Exception: return default

def save(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def outcome(hs, as_):
    return "h" if hs > as_ else ("a" if as_ > hs else "d")

def brier(prob, actual):
    y = {"h":0.0, "d":0.0, "a":0.0}; y[actual] = 1.0
    return sum((prob[k]/100.0 - y[k])**2 for k in ("h","d","a"))

def make_review(hc, ac, pred, res):
    """產生檢討文字 + 命中旗標"""
    hz, az = CODE_TO_ZH.get(hc, hc), CODE_TO_ZH.get(ac, ac)
    ps, rs = pred["score"], res["score"]
    po, ao = outcome(ps[0], ps[1]), outcome(rs[0], rs[1])
    dir_hit   = po == ao
    adv_hit   = pred.get("advance") == res.get("advanced")
    score_hit = ps == rs
    b = brier(pred["prob"], ao)

    parts = []
    # 1) 總評
    if score_hit:
        parts.append("方向、晉級、比分全中,模型校準精準。")
    elif dir_hit and adv_hit:
        parts.append("方向與晉級命中,僅比分有誤差。")
    elif adv_hit:
        parts.append(f"晉級預測正確({res['advanced']}),但 90 分鐘走勢與預期不同。")
    elif dir_hit:
        parts.append("勝負方向正確,但晉級判斷失準。")
    else:
        parts.append(f"預測失準:原看好 {pred.get('advance')},實際由 {res.get('advanced')} 晉級。")

    # 2) 比分誤差分析
    gd_pred = ps[0] - ps[1]
    gd_real = rs[0] - rs[1]
    total_pred, total_real = sum(ps), sum(rs)
    if not score_hit:
        if abs(gd_real) > abs(gd_pred):
            parts.append(f"實際差距({rs[0]}-{rs[1]})比預測({ps[0]}-{ps[1]})更懸殊,勝方壓制力被低估。")
        elif abs(gd_real) < abs(gd_pred):
            parts.append(f"實際比預測膠著({rs[0]}-{rs[1]} vs {ps[0]}-{ps[1]}),弱方抵抗力被低估。")
        if total_real > total_pred + 1:
            parts.append("雙方防線比預期鬆散,總進球高於模型預期。")
        elif total_real + 1 < total_pred:
            parts.append("比賽比預期保守,進球數低於模型預期。")
    if res.get("pk"):
        parts.append("90 分鐘平手、由 PK 分勝負——高機率和局的賽事應提高 PK 韌性權重。")

    # 3) 機率校準評語(和局的 Brier 天然偏高,需分開判斷,避免與「命中」自相矛盾)
    if not (dir_hit or adv_hit) and b > 0.7:
        parts.append(f"本場 Brier {b:.2f}(偏高),屬明顯誤判,已據此調整雙方評級。")
    elif b < 0.35:
        parts.append(f"本場 Brier {b:.2f},機率校準良好。")
    elif ao == "d" and (dir_hit or adv_hit):
        parts.append(f"本場 Brier {b:.2f}——和局賽事的機率天然分散,能抓中走勢已屬不易。")
    elif b > 0.7:
        parts.append(f"本場 Brier {b:.2f}(偏高),雖抓中結果,但信心分配仍可再收斂。")

    return {
        "text": "（模型自動檢討）" + "".join(parts),
        "dir_hit": dir_hit, "adv_hit": adv_hit, "score_hit": score_hit, "brier": round(b, 3),
    }

def calibrate(ratings, hc, ac, pred, res):
    """依實際 vs 預期進球微調評級(有界)"""
    ps, rs = pred["score"], res["score"]
    # 以「淨勝球誤差」為梯度訊號
    err = (rs[0] - rs[1]) - (ps[0] - ps[1])     # >0 表示主隊表現優於預期
    adj = max(-MAX_ADJUST, min(MAX_ADJUST, K_RATING * math.tanh(err / 2.0)))
    ratings[hc] = round(ratings.get(hc, BASE_RATINGS.get(hc, 65)) + adj, 1)
    ratings[ac] = round(ratings.get(ac, BASE_RATINGS.get(ac, 65)) - adj, 1)
    # 合理範圍夾住
    for c in (hc, ac):
        ratings[c] = max(40.0, min(97.0, ratings[c]))
    return adj

def main():
    results  = load(RESULTS_FILE, {})
    predlog  = load(PREDLOG_FILE, {})
    ratings  = dict(BASE_RATINGS)                # 以基準為起點
    ratings.update(load(RATINGS_FILE, {}))       # 已校準的值覆蓋
    reviewed = load("reviewed_state.json", {})   # 已檢討過的比賽(避免重複調評級)

    reviews, new_count = {}, 0
    for mid, res in results.items():
        pred = predlog.get(mid)
        if not pred:                      # 沒有當初的預測 → 無法檢討(例如手寫預測未記錄)
            continue
        hc, ac = [s.upper() for s in mid.split("-")]
        r = make_review(hc, ac, pred, res)
        reviews[mid] = r
        if mid not in reviewed:           # 只在第一次檢討時調整評級
            adj = calibrate(ratings, hc, ac, pred, res)
            reviewed[mid] = {"at": datetime.datetime.now().isoformat(timespec="seconds"), "adj": adj}
            new_count += 1

    save(RATINGS_FILE, ratings)
    save("reviewed_state.json", reviewed)

    # 統計整體表現
    n = len(reviews)
    if n:
        d = sum(1 for r in reviews.values() if r["dir_hit"])
        a = sum(1 for r in reviews.values() if r["adv_hit"])
        s = sum(1 for r in reviews.values() if r["score_hit"])
        bb = sum(r["brier"] for r in reviews.values()) / n
    else:
        d = a = s = 0; bb = 0.0

    ts = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")
    lines = [f"/* 由 review_engine.py 自動產生於 {ts} — 請勿手改 */",
             f'const REVIEWS_UPDATED = "{ts}";',
             f'const MODEL_STATS = {{n:{n}, dir:{d}, adv:{a}, score:{s}, brier:{bb:.3f}}};',
             "const AUTO_REVIEWS = {"]
    for mid, r in sorted(reviews.items()):
        txt = r["text"].replace('"', "'")
        lines.append(f'  "{mid}": {{text:"{txt}", brier:{r["brier"]}}},')
    lines.append("};")
    with open(OUT_REVIEWS, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    print(f"✅ {OUT_REVIEWS}:{n} 場檢討(本次新增 {new_count} 場並校準評級)")
    if n:
        print(f"   方向 {d}/{n} · 晉級 {a}/{n} · 比分 {s}/{n} · 平均 Brier {bb:.3f}")
    if new_count:
        print("   評級已更新 → ratings.json(下一輪預測會採用)")

if __name__ == "__main__":
    main()
