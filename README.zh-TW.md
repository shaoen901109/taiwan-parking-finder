# taiwan-parking-finder（台灣找停車位）

[English](README.md) | 繁體中文

> 📖 **圖文教學：** https://shao-en.com/blog/taiwan-parking-finder-guide.html ——如果你不知道該如何操作，請把這篇文章交給你的 Claude 或 ChatGPT。

用交通部 TDX 開放資料做的手機版網頁，顯示附近停車場與路邊停車格的即時空位。手機打開就會在地圖上跟著你的位置走。

## 功能

- 附近路外停車場，以及路邊停車路段與單一車格的即時空位
- 跟隨定位（拖動地圖即停止跟隨，按定位鈕恢復）
- 每 60 秒自動更新；移動夠遠時自動重新查詢
- 汽車、機車
- TDX 金鑰只放在伺服器端，瀏覽器看不到

## 資料來源與限制

- 資料來自 [TDX 運輸資料流通服務](https://tdx.transportdata.tw)（交通部）。
- **TDX 免費方案每分鐘只能呼叫 5 次。** 伺服器端用滑動視窗限流、快取（基本資料 24 小時、停車場即時 60 秒、路邊即時 120 秒），過期時先回舊值再背景更新。某縣市第一次查詢約需 1 分鐘。
- TDX 端的資料缺口：新北路外停車場、台中停車場沒有座標，無法標在地圖上（只剩路邊格）；多數縣市沒有機車位。
- 格位狀態：1、2 分別推定為「有車」「空位」。這是依實際資料觀察的推定（例如台北只會出現這兩個值），實況可能有落差，請當參考。
- `GET /parking/api/health` 可看限流狀態、卡住的請求與各即時資料的更新年齡。

## 申請 TDX 金鑰

1. 到 https://tdx.transportdata.tw 註冊會員。
2. 在會員中心的 API 金鑰區建立金鑰，取得 **Client Id** 與 **Client Secret**。
3. 把 `.env.example` 複製成 `.env`，填入 `API_CLIENT_ID` 與 `API_CLIENT_SECRET`。

每個人請用自己的金鑰，`.env` 不要上傳。

## 本機執行

```bash
pip install -r requirements.txt
# 先把 .env 載入環境變數，再執行：
python -m uvicorn app.server:app --port 8000
```

網址 http://localhost:8000/parking/ （埠號可自選）。

## 用 Docker 執行

```bash
cp .env.example .env   # 填入金鑰
docker compose up -d --build
```

然後開 http://localhost:8000/parking/。`data/` 是執行時的快取資料夾，不在 repo 內。

## 注意事項

- 地圖圖磚來自 OpenStreetMap 公用圖磚伺服器，有[使用政策](https://operations.osmfoundation.org/policies/tiles/)。大量使用請自架圖磚或改用其他供應商。
- Leaflet 由 unpkg 載入（已鎖定版本）。

## 技術來源與致謝

| 用途 | 專案 | 授權 |
|---|---|---|
| 停車資料 | [TDX 運輸資料流通服務](https://tdx.transportdata.tw)（交通部） | 見 TDX 網站 |
| 後端 | [FastAPI](https://fastapi.tiangolo.com/)、[Uvicorn](https://www.uvicorn.org/)、[httpx](https://www.python-httpx.org/) | MIT、BSD-3-Clause、BSD-3-Clause |
| 地圖 | [Leaflet](https://leafletjs.com/) | BSD-2-Clause |
| 地圖圖磚 | OpenStreetMap（© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)） | ODbL |
| 圖示 | [Lucide](https://lucide.dev/) | ISC |

開發過程使用 [Claude Code](https://claude.com/claude-code)（Anthropic）協助。

## 作者

- 網站：https://shaoenstudio.com
- 聯絡信箱：shaoenstudio@gmail.com
- GitHub：[@shaoen901109](https://github.com/shaoen901109)

## 授權

MIT，見 [LICENSE](LICENSE)。
