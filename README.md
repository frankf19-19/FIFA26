# 2026 世界盃 · 每日預測與情報

一個可部署到 GitHub Pages 的世界盃平台:每日預測、賽後對比與檢討、模型記分卡(Brier 校準)、
球隊名單、球員強弱項與生涯資料、頭條新聞、球員搜尋。

---

## 檔案結構

| 檔案 | 用途 | 誰來更新 |
|---|---|---|
| `index.html` | 主程式(載入 `data.js`、`results.js`)。**部署用**。 | 幾乎不動 |
| `index_standalone.html` | 單一自包含檔(資料已內嵌),雙擊即可離線預覽或分享。 | 幾乎不動 |
| `data.js` | **你每天要編輯的檔**:比賽、預測、檢討、頭條、球員名單。 | 你(手動) |
| `results.js` | 比賽「結果」,由腳本自動產生並覆蓋 `data.js` 的結果。 | 腳本(自動) |
| `results_state.json` | 累積的完賽紀錄(腳本自動維護,勿手刪)。 | 腳本(自動) |
| `update_matches.py` | 抓最新比分(免金鑰 ESPN)→ 產生 `results.js`。 | — |
| `.github/workflows/daily.yml` | 排程 / 一鍵執行上面的腳本。 | — |

> **分工原則**:比分/晉級 → 自動;預測、檢討、球員名單、先發傷兵 → 手動(沒有免費 API 能供應)。
> 兩者靠比賽 `id` 對應,互不干擾。

---

## 一、部署到 GitHub Pages

1. 建一個 repo,把 `index.html`、`data.js`、`update_matches.py` 放到根目錄。
2. 把 `daily.yml` 放到 `.github/workflows/daily.yml`。
3. Settings → Pages → Source 選 `main` 分支根目錄,存檔。
4. 幾分鐘後即可用 `https://<你的帳號>.github.io/<repo>/` 開啟。

離線預覽:直接雙擊 `index_standalone.html` 即可(不需伺服器)。

### 只想快速上線?只傳一個檔可以嗎?
**可以。** 把 `index_standalone.html` 改名為 `index.html` 上傳即可(單一自包含檔,不需其他檔案)。
- 缺點:資料是內嵌的,**「⟳ 更新結果」按鈕與 GitHub Actions 不會生效**,要更新得直接編輯這個檔裡的資料區。
- 想要**自動更新 + 更新鈕生效** → 請改用模組化版本:`index.html`(原本這個)＋ `data.js` ＋ `update_matches.py` ＋ `daily.yml`。
> 注意:GitHub Pages 首頁一定要叫 `index.html`,兩個版本擇一改名上傳,不要同時放兩個 `index.html`。

---

## 二、讓網頁「自動更新」

自動更新分兩層,**兩層都要有**才會真正無人自動更新:

**① 網頁前端(已內建,免設定)**
打開網頁後,每 **60 秒**會自動抓一次 `results.js` 並刷新畫面,分頁切回前景時也會立即檢查。
標題下方會顯示「🟢 自動更新中」或「自動更新未啟用」。

**② 後端產生資料(需部署一次,免金鑰)** ← 沒有這步,前端就沒有新資料可抓
GitHub Actions 用 **ESPN 公開比分**(免註冊、免 API 金鑰)定時抓 → 產生新的 `results.js`
→ 自動 commit → Pages 重新部署。

設定步驟(只做一次,不用申請任何金鑰):
1. 把 `update_matches.py`、`results.js`、`results_state.json` 放到 repo 根目錄,
   `daily.yml` 放到 `.github/workflows/`。
2. repo → **Settings → Actions → General → Workflow permissions** 選 **Read and write**(讓機器人能提交)。
3. 到 **Actions → 更新世界盃比賽結果 → Run workflow** 手動跑一次測試。
   成功後 `results.js` 會更新,之後**每 15 分鐘自動跑**。
4. 前端每 60 秒會自動抓到新的 `results.js` 並刷新。

> **為什麼要後端?** 靜態網頁(GitHub Pages)基於安全不能直接在瀏覽器抓比分(跨域會被擋)。
> 所以由 GitHub Actions 去抓、產生 `results.js`,前端再讀它。全程免金鑰。
>
> ESPN 是公開但非官方的來源,萬一某天欄位改版導致抓不到,可改用 `--source json` 手動餵比分,
> 或改用 football-data.org(需金鑰,腳本也支援 `--source football-data`)。
>
> `results_state.json` 是累積的完賽紀錄(腳本自動維護),別手動刪,不然會從頭累積。

> 換其他資料來源?`update_matches.py` 也支援 `--source json --json scores.json`,
> JSON 格式:`[{"home":"CAN","away":"MAR","hs":0,"as":2,"final":true,"pk_winner":null}, ...]`
> 平手時 `pk_winner` 填 PK 勝方代碼(如 `"EGY"`)。

---

## 三、每日手動更新(3 分鐘搞定)

打開 `data.js`,依當天狀況修改:

### 1) 新一輪預測
比賽自動變完賽後,幫下一輪填 `pred`:
```js
pred:{ prob:{h:52,d:26,a:22}, score:[2,1], advance:"巴西", conf:"mid", reason:"…" }
```
- `prob` 三者相加約 100;`score` 是 90 分鐘預測比分;`advance` 是看好晉級的**中文隊名**;
- `conf` 為 `hi`/`mid`/`lo`;`reason` 一段話。

### 2) 賽後檢討(讓模型進步)
比賽完後補 `review`,寫「為什麼中/錯、下一步修什麼」。記分卡與 Brier 會自動重算。

### 3) 先發 / 傷兵 / 停賽(影響預測的關鍵)
在 `SQUADS` 對應球員加 `x` 欄位即可,前台會顯示標籤:
```js
P("巴洛根","Balogun","前鋒","key",24,"摩納哥",[...],[...],"…",null,"停賽")
// x 可填:'停賽' / '傷兵' / '存疑' / '先發'
```
記得同步在該場 `reason` 說明「因傷兵/停賽調整勝率」——這正是本站的核心價值。

### 4) 頭條新聞
編輯 `HEADLINES`(最新的放最前面):
```js
{ tag:"injury", t:"標題…", d:"07/06", team:"BRA" }
// tag:injury 傷兵 / upset 爆冷 / result 賽果 / focus 焦點 / adv 晉級
// team 填代碼,點頭條可直接跳該隊名單
```

### 5) 擴充球員名單
`SQUADS` 每隊用 `P(名, 英文, 位置, 角色, 年齡, 球會, [強項], [弱項], 說明, 生涯, 狀態)` 新增。
- 位置:`門將`/`後衛`/`中場`/`前鋒`
- 角色:`key`=⭐重要 / `prospect`=💎潛力 / `""`=一般

### 6) 球員照片(選填)
`P()` 的最後一個參數 `img` 可放照片路徑或網址:
```js
P("梅西","Messi","前鋒","key",39,"國際邁阿密",[...],[...],"…","第6屆世界盃",null,"img/messi.jpg")
```
- **放本機圖**:在 repo 建 `img/` 資料夾放圖檔,`img` 填 `"img/messi.jpg"`。
- **或填網址**:你有權使用的圖片 URL。
- **不填** → 自動顯示以名字首字生成的頭像(⭐/💎 角標),畫面一樣好看。

> ⚠️ **版權提醒**:多數球員照片(Getty、球會、媒體、球員卡)都有版權,請勿直接盜連或嵌入。
> 可用:你自己拍攝/購買授權的圖,或 Wikimedia Commons 上 **CC 授權**的照片(記得依授權標註來源)。

---

## 模型記分卡怎麼看

- **晉級命中 / 方向命中**:比對「看好晉級隊」「90 分鐘勝負和」是否猜對。
- **比分全中**:預測比分與實際完全相同的場次數。
- **Brier 校準**:機率預測的準度(0 最佳,隨機基準約 0.67,**越低越準**)。
  只看命中率會忽略「信心對不對」;Brier 會獎勵校準良好的機率,是判斷模型是否真的進步的關鍵。

> 資料為分析參考;球員俱樂部、年齡、狀態為概估,請以官方名單為準並每日核對。
