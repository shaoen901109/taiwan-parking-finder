# taiwan-parking-finder

English | [繁體中文](README.zh-TW.md)

> 📖 **Step-by-step tutorial (Traditional Chinese):** https://shao-en.com/blog/taiwan-parking-finder-guide.html — not sure how to set it up? Hand the article to Claude or ChatGPT and let it walk you through.

A mobile-friendly web page that shows nearby parking lots and live on-street parking-space availability in Taiwan, using the TDX open data platform. Open it on your phone, and it follows your position on a map.

## Features

- Nearby off-street car parks plus on-street segments and individual space markers with live availability
- Follows your location (drag the map to stop following; tap the locate button to resume)
- Auto refresh every 60 seconds; re-queries automatically when you move far enough
- Cars and scooters
- Your TDX credentials stay on the server; the browser never sees them

## Data sources and limits

- Data comes from [TDX](https://tdx.transportdata.tw) (Transport Data eXchange, Ministry of Transportation and Communications, Taiwan).
- **The free TDX plan allows only 5 requests per minute.** The server uses a sliding-window limiter, caches responses (base data 24 h, car-park live data 60 s, on-street live data 120 s) and serves stale values while refreshing in the background. The first query for a city can take about a minute.
- Data gaps on the TDX side: New Taipei off-street car parks and Taichung car parks have no coordinates, so they cannot be placed on the map (only on-street spaces appear). Most cities have no scooter spaces.
- Space status: values 1 and 2 are interpreted as occupied and vacant. This is an inference from observed data (e.g. Taipei only returns these two values); real-world availability can differ, so treat it as a hint.
- `GET /parking/api/health` shows rate-limit state, stuck requests and the age of each live dataset.

## Get TDX credentials

1. Register a member account at https://tdx.transportdata.tw.
2. In the member dashboard, open the API key section and create a key to get a **Client Id** and **Client Secret**.
3. Copy `.env.example` to `.env` and fill in `API_CLIENT_ID` and `API_CLIENT_SECRET`.

Everyone should use their own key. Never commit `.env`.

## Run locally

```bash
pip install -r requirements.txt
# load .env into the environment, then:
python -m uvicorn app.server:app --port 8000
```

Open http://localhost:8000/parking/ (pick any port you like).

## Run with Docker

```bash
cp .env.example .env   # fill in your credentials
docker compose up -d --build
```

Then open http://localhost:8000/parking/. The `data/` folder holds runtime caches and is not part of the repo.

## Notes

- Map tiles come from the OpenStreetMap public tile server, which has a [usage policy](https://operations.osmfoundation.org/policies/tiles/). For heavy use, self-host tiles or switch to another tile provider.
- Leaflet is loaded from unpkg (pinned version).

## Credits

| Purpose | Project | License |
|---|---|---|
| Parking data | [TDX](https://tdx.transportdata.tw) (Ministry of Transportation and Communications) | see the TDX website |
| Backend | [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn](https://www.uvicorn.org/), [httpx](https://www.python-httpx.org/) | MIT, BSD-3-Clause, BSD-3-Clause |
| Map | [Leaflet](https://leafletjs.com/) | BSD-2-Clause |
| Map tiles | OpenStreetMap (© [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)) | ODbL |
| Icons | [Lucide](https://lucide.dev/) | ISC |

Developed with the help of [Claude Code](https://claude.com/claude-code) (Anthropic).

## Author

- Website: https://shaoenstudio.com
- Email: shaoenstudio@gmail.com
- GitHub: [@shaoen901109](https://github.com/shaoen901109)

## License

MIT, see [LICENSE](LICENSE).
