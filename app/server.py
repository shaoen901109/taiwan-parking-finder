"""找停車位：TDX 停車資料代理（金鑰只留在伺服器端）。

端點（皆在 BASE_PATH 底下，預設 /parking）：
  GET  /                      前端 static/index.html
  GET  /api/nearby?lat=&lon=&radius=&vehicle=car|scooter
  GET  /api/health            限流與快取狀態（除錯用）
"""
from __future__ import annotations

import asyncio
import json
import math
import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

BASE_PATH = os.environ.get("BASE_PATH", "/parking").rstrip("/")
CLIENT_ID = os.environ.get("API_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("API_CLIENT_SECRET", "")
TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token"
API = "https://tdx.transportdata.tw/api/basic/v1/Parking"

STATIC_TTL = 24 * 3600   # 停車場／路段／格位基本資料
LOT_TTL = 60             # 停車場即時（來源約 1 分鐘更新）
CURB_TTL = 120           # 路邊即時（來源約 5 分鐘更新）
EMPTY_TTL = 6 * 3600     # 回空清單的端點（該縣市沒提供）少問
RATE, WINDOW = 5, 61.0   # TDX 免費方案：每分鐘 5 次（實測 X-RateLimit-Limit-Minute: 5）
SLOT_WAIT = 100          # 排隊最多等這麼久就放棄（回舊資料）
FETCH_TIMEOUT = 120      # 單次下載上限（防止卡死）
MAX_SPOTS = 4000

# 縣市大致中心點：取最近的、且不比最近者遠 15 km 以上的縣市（最多 3 個）
CITIES = {
    "Taipei": (25.05, 121.55), "NewTaipei": (25.01, 121.47), "Keelung": (25.13, 121.74),
    "Taoyuan": (24.99, 121.30), "Hsinchu": (24.80, 120.97), "HsinchuCounty": (24.83, 121.01),
    "MiaoliCounty": (24.56, 120.82), "Taichung": (24.15, 120.67), "ChanghuaCounty": (24.07, 120.54),
    "NantouCounty": (23.91, 120.68), "YunlinCounty": (23.71, 120.43), "Chiayi": (23.48, 120.45),
    "ChiayiCounty": (23.45, 120.25), "Tainan": (23.00, 120.21), "Kaohsiung": (22.63, 120.30),
    "PingtungCounty": (22.67, 120.49), "YilanCounty": (24.75, 121.75), "HualienCounty": (23.98, 121.60),
    "TaitungCounty": (22.76, 121.14), "KinmenCounty": (24.44, 118.32), "PenghuCounty": (23.57, 119.58),
    "LienchiangCounty": (26.16, 119.95),
}


def dist_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def is_empty(data):
    return data is None or (isinstance(data, dict) and not any(
        isinstance(v, list) and v for v in data.values()))


async def safe(coro):
    try:
        return await coro
    except Exception:
        return None


class TDX:
    def __init__(self):
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(30, read=60))
        self.token = None
        self.token_exp = 0.0
        self.calls: list[float] = []
        self.blocked_until = 0.0
        self.user_waiting = 0
        self.cache: dict[str, tuple[float, object]] = {}
        self.inflight: dict[str, asyncio.Task] = {}
        self.last_error = ""

    async def _token(self):
        if self.token and time.time() < self.token_exp - 300:
            return self.token
        r = await self.client.post(TOKEN_URL, data={
            "grant_type": "client_credentials", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET})
        r.raise_for_status()
        j = r.json()
        self.token, self.token_exp = j["access_token"], time.time() + j.get("expires_in", 3600)
        return self.token

    async def _slot(self, bg):
        """滑動視窗限流；背景預載留 1 次額度給使用者，且有人在等就讓路。"""
        deadline = time.time() + (3600 if bg else SLOT_WAIT)
        while time.time() < deadline:
            now = time.time()
            self.calls = [t for t in self.calls if now - t < WINDOW]
            free = RATE - len(self.calls)
            if now >= self.blocked_until and free > (1 if bg else 0) and not (bg and self.user_waiting):
                self.calls.append(now)
                return
            await asyncio.sleep(0.5)
        raise RuntimeError("限流排隊逾時")

    async def _fetch(self, path, bg):
        if not bg:
            self.user_waiting += 1
        try:
            for _ in range(3):
                await self._slot(bg)
                tok = await self._token()
                r = await self.client.get(f"{API}/{path}", params={"$format": "JSON"},
                                          headers={"authorization": f"Bearer {tok}"})
                if r.status_code == 429:
                    try:
                        wait = float(r.headers.get("Retry-After", 10))
                    except ValueError:
                        wait = 10
                    self.blocked_until = time.time() + min(max(wait, 2), 65) + 1  # 上限 65 秒，避免卡死
                    self.last_error = f"429 {path}"
                    continue
                if r.status_code == 404:
                    return None
                r.raise_for_status()
                return r.json()
            raise RuntimeError("TDX 429")
        finally:
            if not bg:
                self.user_waiting -= 1

    async def _refresh(self, path, disk, bg):
        try:
            data = await asyncio.wait_for(self._fetch(path, bg), FETCH_TIMEOUT if not bg else 4000)
            self.cache[path] = (time.time(), data)
            if disk:
                (DATA / (path.replace("/", "_") + ".json")).write_text(
                    json.dumps(data, ensure_ascii=False), "utf-8")
            return data
        except Exception as e:
            self.last_error = f"{type(e).__name__} {path}"
            raise
        finally:
            self.inflight.pop(path, None)

    def _task(self, path, disk, bg):
        t = self.inflight.get(path)
        if t is None:
            t = asyncio.create_task(self._refresh(path, disk, bg))
            t.add_done_callback(lambda x: x.cancelled() or x.exception())  # 標記已讀取
            self.inflight[path] = t  # 也是強參照，避免 task 被回收
        return t

    async def get(self, path, ttl, disk=False, bg=False, stale_ok=False):
        """有新鮮快取就用；過期才抓；抓失敗回舊資料；同一 path 同時只抓一次。
        stale_ok：有舊資料就先回，背景更新（避免使用者等限流）。"""
        hit = self.cache.get(path)
        if hit is None and disk:
            f = DATA / (path.replace("/", "_") + ".json")
            if f.exists():
                hit = (f.stat().st_mtime, json.loads(f.read_text("utf-8")))
                self.cache[path] = hit
        if hit:
            eff = max(ttl, EMPTY_TTL) if is_empty(hit[1]) else ttl
            if time.time() - hit[0] < eff:
                return hit[1]
        t = self._task(path, disk, bg)
        if hit and stale_ok:
            return hit[1]
        try:
            return await asyncio.shield(t)
        except Exception:
            if hit:
                return hit[1]
            raise


tdx = TDX()

# 大型清單轉成查詢表很花時間：依資料物件記住結果
_index: dict[str, tuple[int, object]] = {}


def indexed(name, data, build):
    k = _index.get(name)
    if k and k[0] == id(data):
        return k[1]
    v = build(data)
    _index[name] = (id(data), v)
    return v


def space(avails, vehicle, total, avail):
    """回傳 (總數, 剩餘)；vehicle: car→SpaceType 1、scooter→SpaceType 2。負數＝未知。"""
    want = 1 if vehicle == "car" else 2
    for a in avails or []:
        if a.get("SpaceType") == want:
            t, v = a.get("NumberOfSpaces"), a.get("AvailableSpaces")
            return (t if t is not None and t >= 0 else None, v if v is not None and v >= 0 else None)
    if vehicle == "car" and not avails:
        return (total if total is not None and total >= 0 else None,
                avail if avail is not None and avail >= 0 else None)
    return (None, None)


def nearby_cities(lat, lon):
    ds = sorted((dist_m(lat, lon, *c), k) for k, c in CITIES.items())
    return [k for d, k in ds[:3] if d <= ds[0][0] + 15000]


def live_paths(city):
    return (f"OffStreet/ParkingAvailability/City/{city}",
            f"OnStreet/ParkingSegmentAvailability/City/{city}",
            f"OnStreet/ParkingSpotAvailability/City/{city}")


async def city_items(city, lat, lon, radius, vehicle):
    lp_lot, lp_seg, lp_spot = live_paths(city)
    lots_s, segs_s, spots_s, lots_l, segs_l = await asyncio.gather(
        safe(tdx.get(f"OffStreet/CarPark/City/{city}", STATIC_TTL, disk=True, stale_ok=True)),
        safe(tdx.get(f"OnStreet/ParkingSegment/City/{city}", STATIC_TTL, disk=True, stale_ok=True)),
        safe(tdx.get(f"OnStreet/ParkingSpot/City/{city}", STATIC_TTL, disk=True, stale_ok=True)),
        safe(tdx.get(lp_lot, LOT_TTL, disk=True, stale_ok=True)),
        safe(tdx.get(lp_seg, CURB_TTL, disk=True, stale_ok=True)),
    )
    # 格位即時只在該縣市有格位座標時才問（省額度）
    spots_l = None
    if vehicle == "car" and not is_empty(spots_s):
        spots_l = await safe(tdx.get(lp_spot, CURB_TTL, disk=True, stale_ok=True))  # 即時也存檔：重啟後先回舊值

    # 粗略外框先篩，再算距離
    dlat = radius / 111000
    dlon = radius / (111000 * math.cos(math.radians(lat)))

    def near(la, lo):
        if la is None or lo is None or abs(la - lat) > dlat or abs(lo - lon) > dlon:
            return None
        d = dist_m(lat, lon, la, lo)
        return d if d <= radius else None

    items, spots = [], []
    live = indexed(lp_lot, lots_l, lambda d: {a["CarParkID"]: a for a in (d or {}).get("ParkingAvailabilities", [])})
    for p in (lots_s or {}).get("CarParks", []):
        pos = p.get("CarParkPosition") or {}
        la, lo = pos.get("PositionLat"), pos.get("PositionLon")
        d = near(la, lo)
        if d is None:
            continue
        if vehicle == "car" and p.get("IsMotorcycle") == 1:
            continue
        a = live.get(p["CarParkID"])
        total, avail = space(a.get("Availabilities") if a else None, vehicle,
                             a.get("TotalSpaces") if a else None,
                             a.get("AvailableSpaces") if a else None)
        if vehicle == "scooter" and total is None and avail is None and p.get("IsMotorcycle") != 1:
            continue
        items.append({
            "id": p["CarParkID"], "kind": "lot", "city": city,
            "name": (p.get("CarParkName") or {}).get("Zh_tw", ""),
            "lat": la, "lon": lo, "dist": round(d),
            "total": total, "avail": avail,
            "full": bool(a and a.get("FullStatus") == 1),
            "open": None if not a else a.get("ServiceStatus") == 1,
            "fare": p.get("FareDescription") or "",
            "address": p.get("Address") or "",
            "time": a.get("DataCollectTime") if a else None,
        })

    # 單格位：SpotStatus 1＝有車、2＝空位（台北實測只有這兩種值，約七成為 1）
    seg_spots: dict[str, list[int]] = {}
    if spots_l:
        st = indexed(lp_spot, spots_l, lambda d: {
            a["ParkingSpotID"]: a.get("SpotStatus") for a in (d or {}).get("CurbSpotParkingAvailabilities", [])
            if a.get("ServiceStatus", 1) == 1 and a.get("DeviceStatus", 1) == 1})
        for s in (spots_s or {}).get("ParkingSegmentSpots", []):
            status = st.get(s.get("ParkingSpotID"))
            if status not in (1, 2) or s.get("SpaceType", 1) != 1:
                continue
            pos = s.get("Position") or {}
            la, lo = pos.get("PositionLat"), pos.get("PositionLon")
            if near(la, lo) is None:
                continue
            vacant = status == 2
            seg = s.get("ParkingSegmentID", "")
            c = seg_spots.setdefault(seg, [0, 0])
            c[0] += 1
            c[1] += vacant
            spots.append([la, lo, 0 if vacant else 1, seg])

    seglive = indexed(lp_seg, segs_l, lambda d: {
        a["ParkingSegmentID"]: a for a in (d or {}).get("CurbParkingSegmentAvailabilities", [])})
    for s in (segs_s or {}).get("ParkingSegments", []):
        pos = s.get("ParkingSegmentPosition") or {}
        la, lo = pos.get("PositionLat"), pos.get("PositionLon")
        d = near(la, lo)
        sid = s["ParkingSegmentID"]
        c = seg_spots.get(sid)
        if d is None and not c:
            continue
        if d is None:  # 路段中心在範圍外、但有格位在範圍內
            d = dist_m(lat, lon, la, lo) if la is not None else radius
        a = seglive.get(sid)
        if not a and not c:
            continue  # 路邊格只列有即時資料的
        total, avail = space(a.get("Availabilities"), vehicle, a.get("TotalSpaces"),
                             a.get("AvailableSpaces")) if a else (None, None)
        if total is None and avail is None and not c:
            continue
        items.append({
            "id": sid, "kind": "curb", "city": city,
            "name": (s.get("ParkingSegmentName") or {}).get("Zh_tw", ""),
            "lat": la, "lon": lo, "dist": round(d),
            "total": total, "avail": avail,
            "full": bool(a and a.get("FullStatus") == 1),
            "open": None if not a else a.get("ServiceStatus") == 1,
            "fare": s.get("FareDescription") or "",
            "address": s.get("Description") or "",
            "time": a.get("DataCollectTime") if a else None,
            "spots": c[0] if c else 0, "vacant": c[1] if c else None,
        })
    return items, spots


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get(BASE_PATH + "/api/health")
async def health():
    now = time.time()
    return {"ok": True, "key": bool(CLIENT_ID and CLIENT_SECRET),
            "calls_last_min": len([t for t in tdx.calls if now - t < WINDOW]),
            "blocked_for": max(0, round(tdx.blocked_until - now)), "user_waiting": tdx.user_waiting,
            "inflight": list(tdx.inflight), "last_error": tdx.last_error,
            "live_age": {p: round(now - v[0]) for p, v in tdx.cache.items() if "Availability" in p}}


@app.get(BASE_PATH + "/api/nearby")
async def nearby(lat: float = Query(..., ge=21, le=27), lon: float = Query(..., ge=117, le=123),
                 radius: int = Query(800, ge=100, le=5000), vehicle: str = Query("car", pattern="^(car|scooter)$")):
    cities = nearby_cities(lat, lon)
    tasks = [asyncio.create_task(city_items(c, lat, lon, radius, vehicle)) for c in cities]
    for t in tasks:
        _bg.add(t)
        t.add_done_callback(lambda x: (_bg.discard(x), x.cancelled() or x.exception()))
    # 主要縣市最多等 110 秒；鄰近縣市沒好就先跳過（背景繼續抓，下一輪就有）
    try:
        await asyncio.wait_for(asyncio.shield(tasks[0]), 110)
    except asyncio.TimeoutError:
        raise HTTPException(504, "TDX 逾時")
    if len(tasks) > 1:
        await asyncio.wait(tasks[1:], timeout=5)
    groups = [t.result() for t in tasks if t.done() and not t.cancelled() and t.exception() is None]
    seen, items, spots = set(), [], []
    for i in sorted((i for g, _ in groups for i in g), key=lambda i: i["dist"]):
        if (i["kind"], i["id"]) not in seen:
            seen.add((i["kind"], i["id"]))
            items.append(i)
    for _, s in groups:
        spots.extend(s)
    spots.sort(key=lambda s: (s[0] - lat) ** 2 + (s[1] - lon) ** 2)
    now = time.time()
    ts = [tdx.cache[p][0] for c in cities for p in live_paths(c)
          if p in tdx.cache and not is_empty(tdx.cache[p][1])]
    return JSONResponse({"cities": cities, "count": len(items), "items": items[:200],
                         "spots": spots[:MAX_SPOTS],
                         "age": round(now - min(ts)) if ts else None},
                        headers={"cache-control": "no-store"})


@app.get(BASE_PATH)
async def root_redirect():
    return RedirectResponse(BASE_PATH + "/")


@app.get(BASE_PATH + "/")
async def index():
    return FileResponse(STATIC / "index.html", headers={"cache-control": "no-cache"})


app.mount(BASE_PATH + "/static", StaticFiles(directory=STATIC), name="static")

_bg: set = set()


@app.on_event("startup")
async def warm():
    async def run():  # 背景預載各縣市基本資料（存檔，重啟免重抓），每 6 小時檢查一次
        while True:
            for c in CITIES:
                for p in (f"OffStreet/CarPark/City/{c}", f"OnStreet/ParkingSegment/City/{c}",
                          f"OnStreet/ParkingSpot/City/{c}"):
                    await safe(tdx.get(p, STATIC_TTL, disk=True, bg=True))
            await asyncio.sleep(6 * 3600)
    t = asyncio.create_task(run())
    _bg.add(t)
