#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
injury_engine.py — 自動抓取傷兵/停賽 + 產生勝率調整(免金鑰)
==============================================================
從 ESPN 公開的球隊 roster/injuries 端點抓取傷停名單,輸出:
  injuries.js  各隊傷兵/停賽清單(前端在球員與比賽卡顯示)
  adjust.json  各隊「戰力折扣」→ predict_engine.py 會據此自動下修該隊預期進球

誠實原則:
  · ESPN 免費資料未必即時/完整。抓到就標示,抓不到就標「資料未確認」,絕不假裝。
  · 每位傷停球員的權重依角色(key/一般)與狀態(out/doubtful)計算。

用法:
  python injury_engine.py                    # 線上抓
  python injury_engine.py --espn-file m.json # 測試用
"""
import argparse, json, datetime, urllib.request

OUT_JS = "injuries.js"
OUT_ADJ = "adjust.json"

# ESPN 世界盃隊伍代碼 → 我方代碼(需要時擴充)
CODE_TO_ZH = {
    "FRA":"法國","ESP":"西班牙","ARG":"阿根廷","BRA":"巴西","ENG":"英格蘭","POR":"葡萄牙",
    "MAR":"摩洛哥","BEL":"比利時","NOR":"挪威","COL":"哥倫比亞","SUI":"瑞士","USA":"美國",
    "MEX":"墨西哥","EGY":"埃及","CAN":"加拿大","NED":"荷蘭","GER":"德國","CRO":"克羅埃西亞",
}
# 各隊關鍵球員(停賽/傷缺影響最大)。可持續補充。
KEY_PLAYERS = {
    "FRA":["Mbappé","Dembélé"],"ESP":["Yamal","Pedri","Rodri"],"ARG":["Messi","Martínez"],
    "BRA":["Vinícius","Raphinha","Neymar"],"ENG":["Kane","Bellingham","Saka"],
    "POR":["Ronaldo","Fernandes"],"MAR":["Hakimi","Bounou"],"BEL":["De Bruyne","Lukaku"],
    "NOR":["Haaland","Ødegaard"],"COL":["Díaz","James"],"SUI":["Xhaka","Akanji"],
    "USA":["Pulisic","Balogun"],"MEX":["Jiménez","Lozano"],"EGY":["Salah"],
}

# 傷停戰力折扣(對「預期進球」的乘數影響,越低影響越大)
W_KEY_OUT      = 0.10   # 關鍵球員缺陣
W_KEY_DOUBT    = 0.05
W_NORMAL_OUT   = 0.03
W_NORMAL_DOUBT = 0.015

def is_key(code, name):
    for kn in KEY_PLAYERS.get(code, []):
        if kn.lower() in (name or "").lower():
            return True
    return False

def status_bucket(s):
    s = (s or "").lower()
    if any(w in s for w in ("out", "suspend", "red card", "injured reserve")): return "out"
    if any(w in s for w in ("doubt", "questionable", "day-to-day", "game-time")): return "doubt"
    return "doubt"   # 未知狀態保守當「存疑」

# ---------- 抓 ESPN 傷停 ----------
def fetch_espn_injuries(espn_file=None):
    """回傳 {code: [ {name, pos, status, key} ]}"""
    url = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/injuries"
    data = None
    if espn_file:
        with open(espn_file, encoding="utf-8") as f: data = json.load(f)
    else:
        try:
            with urllib.request.urlopen(url, timeout=30) as r: data = json.load(r)
        except Exception as e:
            print(f"  (傷停端點連線失敗:{e} — 標記為資料未確認)")
            return None
    result = {}
    for team in data.get("injuries", []):
        code = (team.get("team", {}).get("abbreviation") or "").upper()
        if code not in CODE_TO_ZH: continue
        lst = []
        for it in team.get("injuries", []):
            ath = it.get("athlete", {}) or {}
            name = ath.get("displayName") or ath.get("shortName") or "?"
            pos = (ath.get("position", {}) or {}).get("abbreviation", "")
            status = it.get("status") or (it.get("type", {}) or {}).get("description", "")
            lst.append({"name": name, "pos": pos, "status": status, "key": is_key(code, name)})
        if lst:
            result[code] = lst
    return result

def compute_adjust(injuries):
    """各隊戰力折扣:1.0=無影響,越低影響越大"""
    adj = {}
    for code, lst in injuries.items():
        mult = 1.0
        for p in lst:
            b = status_bucket(p["status"])
            if p["key"]:
                mult -= W_KEY_OUT if b == "out" else W_KEY_DOUBT
            else:
                mult -= W_NORMAL_OUT if b == "out" else W_NORMAL_DOUBT
        adj[code] = round(max(0.62, mult), 3)   # 最多折到 0.62,避免過度
    return adj

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--espn-file")
    ap.add_argument("--out-js", default=OUT_JS)
    ap.add_argument("--out-adj", default=OUT_ADJ)
    args = ap.parse_args()

    injuries = fetch_espn_injuries(args.espn_file)
    ts = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")
    confirmed = injuries is not None

    if not confirmed:
        injuries = {}
    adj = compute_adjust(injuries)

    with open(args.out_adj, "w", encoding="utf-8") as f:
        json.dump(adj, f, ensure_ascii=False, indent=2)

    # 產生 injuries.js
    lines = [f"/* 由 injury_engine.py 自動產生於 {ts} — 請勿手改 */",
             f'const INJURIES_UPDATED = "{ts}";',
             f'const INJURIES_CONFIRMED = {str(confirmed).lower()};',
             "const INJURIES = {"]
    for code, lst in sorted(injuries.items()):
        items = ", ".join(
            '{name:"%s", pos:"%s", status:"%s", key:%s}' %
            (p["name"].replace('"', "'"), p["pos"], p["status"].replace('"', "'"), str(p["key"]).lower())
            for p in lst)
        lines.append(f'  "{code}": [{items}],')
    lines.append("};")
    with open(args.out_js, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    total = sum(len(v) for v in injuries.values())
    if confirmed:
        print(f"✅ {args.out_js}:{len(injuries)} 隊、{total} 名傷停球員;{args.out_adj} 已更新戰力折扣")
        for code, lst in sorted(injuries.items()):
            tag = f"×{adj[code]}"
            names = ", ".join(("⭐" if p["key"] else "") + p["name"] + f"({p['status']})" for p in lst)
            print(f"   {code} {tag}: {names}")
    else:
        print(f"⚠️ 傷停資料未確認(端點無回應),已標記 INJURIES_CONFIRMED=false,不影響其他預測。")

if __name__ == "__main__":
    main()
