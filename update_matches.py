#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
update_matches.py — 更新世界盃比賽結果(免 API 金鑰)
=======================================================
產生 results.js(定義 MATCH_RESULTS),網頁載入後自動覆蓋 data.js 的結果並計分。
結果會累積存進 results_state.json,不會把先前的比賽洗掉。

資料來源(--source):
  espn   (預設,免金鑰)  抓 ESPN 公開比分 JSON,不需註冊、不需 key。
  json   從本地 JSON 讀:--source json --json scores.json
  football-data          需金鑰(環境變數 FOOTBALL_DATA_KEY)

比賽 id 規則:主隊代碼小寫 + "-" + 客隊代碼小寫(與 data.js 完全一致)

用法:
  python update_matches.py                       # 用 ESPN,免金鑰,寫 results.js
  python update_matches.py --source json --json scores.json
"""
import argparse, json, os, sys, datetime, urllib.request

STATE_FILE = "results_state.json"

# ---- 代碼 → 中文隊名(晉級隊要用中文,對應 data.js) ----
CODE_TO_ZH = {
    "NED":"荷蘭","MAR":"摩洛哥","CIV":"象牙海岸","NOR":"挪威","FRA":"法國","SWE":"瑞典",
    "MEX":"墨西哥","ECU":"厄瓜多","ENG":"英格蘭","COD":"剛果","BEL":"比利時","SEN":"塞內加爾",
    "USA":"美國","BIH":"波士尼亞","ESP":"西班牙","AUT":"奧地利","POR":"葡萄牙","CRO":"克羅埃西亞",
    "SUI":"瑞士","DZA":"阿爾及利亞","AUS":"澳洲","EGY":"埃及","ARG":"阿根廷","CPV":"維德角",
    "COL":"哥倫比亞","GHA":"迦納","CAN":"加拿大","PAR":"巴拉圭","BRA":"巴西",
    "GER":"德國","JPN":"日本","URU":"烏拉圭","KSA":"沙烏地阿拉伯","NGA":"奈及利亞","TUN":"突尼西亞",
}
# ESPN 隊名(英文) → 代碼。ESPN 有時用全名,這裡做對應。
NAME_TO_CODE = {
    "netherlands":"NED","morocco":"MAR","ivory coast":"CIV","côte d'ivoire":"CIV","cote d'ivoire":"CIV",
    "norway":"NOR","france":"FRA","sweden":"SWE","mexico":"MEX","ecuador":"ECU","england":"ENG",
    "dr congo":"COD","congo dr":"COD","belgium":"BEL","senegal":"SEN","usa":"USA","united states":"USA",
    "bosnia and herzegovina":"BIH","bosnia & herzegovina":"BIH","spain":"ESP","austria":"AUT",
    "portugal":"POR","croatia":"CRO","switzerland":"SUI","algeria":"DZA","australia":"AUS","egypt":"EGY",
    "argentina":"ARG","cape verde":"CPV","cabo verde":"CPV","colombia":"COL","ghana":"GHA","canada":"CAN",
    "paraguay":"PAR","brazil":"BRA","germany":"GER","japan":"JPN","uruguay":"URU",
}

def team_code(team):
    abbr = (team.get("abbreviation") or "").upper()
    if abbr in CODE_TO_ZH:
        return abbr
    for key in ("displayName","shortDisplayName","name","location"):
        nm = (team.get(key) or "").strip().lower()
        if nm in NAME_TO_CODE:
            return NAME_TO_CODE[nm]
    return abbr or None

def to_int(v):
    try: return int(v)
    except (TypeError, ValueError): return None

# ---------- 來源 A:ESPN 公開比分(免金鑰) ----------
def fetch_espn(days=5, espn_file=None):
    base = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard"
    games, seen = [], set()
    def handle(data):
        for ev in data.get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            comps = comp.get("competitors", [])
            home = next((c for c in comps if c.get("homeAway") == "home"), None)
            away = next((c for c in comps if c.get("homeAway") == "away"), None)
            if not home or not away: continue
            hc, ac = team_code(home.get("team", {})), team_code(away.get("team", {}))
            if not hc or not ac or (hc, ac) in seen: continue
            stype = (comp.get("status", {}).get("type") or ev.get("status", {}).get("type") or {})
            completed = bool(stype.get("completed"))
            pk_winner = hc if home.get("winner") else (ac if away.get("winner") else None)
            games.append({"home": hc, "away": ac, "hs": to_int(home.get("score")),
                          "as": to_int(away.get("score")), "final": completed, "pk_winner": pk_winner})
            seen.add((hc, ac))
    if espn_file:                                   # 測試用:讀本地 ESPN 格式 JSON,不連網
        with open(espn_file, encoding="utf-8") as f: handle(json.load(f))
        return games
    today = datetime.datetime.utcnow().date()
    for delta in range(days):                       # 抓最近幾天,涵蓋剛完賽的比賽
        d = (today - datetime.timedelta(days=delta)).strftime("%Y%m%d")
        try:
            with urllib.request.urlopen(f"{base}?dates={d}", timeout=30) as r:
                handle(json.load(r))
        except Exception as e:
            print(f"  (略過 {d}:{e})")
    return games

# ---------- 來源 B:本地 JSON ----------
def fetch_json(path):
    with open(path, encoding="utf-8") as f: return json.load(f)

# ---------- 來源 C:football-data.org(需金鑰) ----------
def fetch_football_data(api_key):
    url = "https://api.football-data.org/v4/competitions/WC/matches"
    req = urllib.request.Request(url, headers={"X-Auth-Token": api_key})
    with urllib.request.urlopen(req, timeout=30) as r: data = json.load(r)
    games = []
    for m in data.get("matches", []):
        home = (m["homeTeam"].get("tla") or "").upper()
        away = (m["awayTeam"].get("tla") or "").upper()
        ft = m.get("score", {}).get("fullTime", {})
        pens = m.get("score", {}).get("penalties", {})
        winner = m.get("score", {}).get("winner")
        pk = None
        if pens.get("home") is not None and pens.get("home") != pens.get("away"):
            pk = home if pens["home"] > pens["away"] else away
        elif winner in ("HOME_TEAM", "AWAY_TEAM"):
            pk = home if winner == "HOME_TEAM" else away
        games.append({"home": home, "away": away, "hs": ft.get("home"), "as": ft.get("away"),
                      "final": m.get("status") == "FINISHED", "pk_winner": pk})
    return games

# ---------- 由比賽清單 → 結果字典 ----------
def build_results(games):
    out = {}
    for g in games:
        if not g.get("final"): continue
        hs, as_ = g.get("hs"), g.get("as")
        if hs is None or as_ is None: continue
        mid = f'{g["home"].lower()}-{g["away"].lower()}'
        adv = g["home"] if hs > as_ else g["away"] if as_ > hs else g.get("pk_winner")
        e = {"score": [hs, as_], "advanced": CODE_TO_ZH.get(adv, adv or "?")}
        if hs == as_: e["pk"] = True
        out[mid] = e
    return out

def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f: return json.load(f)
    except Exception: return {}

def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)

def write_results_js(state, out_path):
    ts = datetime.datetime.now().strftime("%Y/%m/%d %H:%M")
    lines = [f"/* 由 update_matches.py 自動產生於 {ts} — 請勿手改 */",
             f'const RESULTS_UPDATED = "{ts}";', "const MATCH_RESULTS = {"]
    for mid, e in sorted(state.items()):
        pk = ", pk:true" if e.get("pk") else ""
        lines.append(f'  "{mid}": {{score:[{e["score"][0]},{e["score"][1]}], advanced:"{e["advanced"]}"{pk}}},')
    lines.append("};")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["espn", "json", "football-data"], default="espn")
    ap.add_argument("--json", help="--source json 時的檔案")
    ap.add_argument("--espn-file", help="(測試)讀本地 ESPN 格式 JSON,不連網")
    ap.add_argument("--days", type=int, default=5, help="ESPN 往前抓幾天")
    ap.add_argument("--out", default="results.js")
    ap.add_argument("--api-key", default=os.environ.get("FOOTBALL_DATA_KEY", ""))
    args = ap.parse_args()

    if args.source == "espn":
        games = fetch_espn(days=args.days, espn_file=args.espn_file)
    elif args.source == "json":
        if not args.json: sys.exit("--source json 需搭配 --json")
        games = fetch_json(args.json)
    else:
        if not args.api_key: sys.exit("football-data 需要 FOOTBALL_DATA_KEY")
        games = fetch_football_data(args.api_key)

    state = load_state()                 # 累積:先讀舊的
    new = build_results(games)           # 這次抓到的完賽
    state.update(new)                    # 合併(新的覆蓋)
    save_state(state)
    write_results_js(state, args.out)

    print(f"✅ 本次新增/更新 {len(new)} 場;{args.out} 目前共 {len(state)} 場完賽")
    for mid, e in sorted(new.items()):
        pk = " (PK)" if e.get("pk") else ""
        print(f"   {mid:>10}  {e['score'][0]}-{e['score'][1]}  晉級:{e['advanced']}{pk}")

if __name__ == "__main__":
    main()
