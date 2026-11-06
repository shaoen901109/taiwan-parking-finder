(function () {
  'use strict';

  var SPRITE = 'static/icons/sprite.svg?v=3#';
  var TAIPEI = [25.0478, 121.5170];
  var RADII = [500, 800, 1500];
  var CD_TOTAL = 60;
  var RING_C = 138.23;
  var TIMEOUT_MS = 100000;

  function $(id) { return document.getElementById(id); }
  function icon(name, cls) {
    return '<svg class="ic' + (cls ? ' ' + cls : '') + '"><use href="' + SPRITE + name + '"/></svg>';
  }

  /* ---------- 偏好設定 ---------- */
  function load(k, def) {
    try { var v = localStorage.getItem('pk_' + k); return v === null ? def : v; } catch (e) { return def; }
  }
  function save(k, v) {
    try { localStorage.setItem('pk_' + k, String(v)); } catch (e) { /* ignore */ }
  }

  var state = {
    vehicle: load('vehicle', 'car') === 'scooter' ? 'scooter' : 'car',
    radius: RADII.indexOf(+load('radius', 800)) >= 0 ? +load('radius', 800) : 800,
    sort: load('sort', 'dist') === 'avail' ? 'avail' : 'dist',
    me: null,            // [lat, lon] 使用者位置
    center: TAIPEI,      // 最近一次查詢中心
    items: [],
    spots: [],
    showOcc: load('occ', '1') !== '0',
    following: false,
    hasFix: false,
    lastQueryAt: 0,
    selected: null,
    selNav: null,        // 點到的單一車格座標（導航目標）
    selStub: null,       // 找不到路段資料時的最小卡片
    age: null,
    fetchedAt: 0,
    loading: false
  };

  /* ---------- 地圖 ---------- */
  var map = L.map('map', { zoomControl: false, attributionControl: true }).setView(TAIPEI, 16);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  var dotRenderer = L.canvas({ padding: 0.5, tolerance: 8 });
  var spotLayer = L.layerGroup().addTo(map);
  var markerLayer = L.layerGroup().addTo(map);
  var markers = {};
  var circle = null;
  var meMarker = null;
  var accCircle = null;
  var dotMarkers = [];
  var segDots = {};

  function setCircle() {
    if (circle) circle.remove();
    circle = L.circle(state.center, {
      radius: state.radius, color: '#2563eb', weight: 1.5, opacity: .5,
      fillColor: '#2563eb', fillOpacity: .06, interactive: false
    }).addTo(map);
  }
  function setMe(acc) {
    if (!state.me) return;
    if (acc != null && isFinite(acc)) {
      if (accCircle) { accCircle.setLatLng(state.me); accCircle.setRadius(acc); }
      else accCircle = L.circle(state.me, {
        radius: acc, color: '#2563eb', weight: 1, opacity: .3,
        fillColor: '#2563eb', fillOpacity: .08, interactive: false
      }).addTo(map);
    }
    if (meMarker) { meMarker.setLatLng(state.me); return; }
    meMarker = L.marker(state.me, {
      icon: L.divIcon({ className: 'pk-wrap', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, zIndexOffset: -500, keyboard: false
    }).addTo(map);
  }

  /* ---------- 工具函式 ---------- */
  function hasSpots(it) { return it.kind === 'curb' && it.spots > 0; }
  function shown(it) {
    if (hasSpots(it) && it.vacant != null) return it.vacant;
    return it.avail;
  }
  // 有逐格資料時分母用「有感測的格數」，與空位數同一來源
  function shownTotal(it) { return hasSpots(it) ? it.spots : it.total; }
  function level(it) {
    var n = shown(it);
    if (n == null) return 'na';
    if ((it.full && !hasSpots(it)) || n <= 0) return 'bad';
    if (n >= 10 || (shownTotal(it) && n / shownTotal(it) >= 0.3)) return 'ok';
    return 'warn';
  }
  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }
  function fmtDist(d) {
    if (d == null) return '';
    return d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km';
  }
  function fmtAgo(sec) {
    if (sec == null || isNaN(sec)) return '';
    sec = Math.max(0, sec);
    if (sec < 60) return '剛剛';
    var m = Math.round(sec / 60);
    if (m < 60) return m + ' 分鐘前';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' 小時前' : Math.round(h / 24) + ' 天前';
  }
  function meters(a, b) {
    return map.distance(a, b);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function sortedItems() {
    var a = state.items.slice();
    if (state.sort === 'avail') {
      a.sort(function (x, y) {
        var xa = x.avail == null ? -1 : x.avail, ya = y.avail == null ? -1 : y.avail;
        return ya - xa || x.dist - y.dist;
      });
    } else {
      a.sort(function (x, y) { return x.dist - y.dist; });
    }
    return a;
  }

  /* ---------- 查詢 ---------- */
  var ctrl = null, timer = null, secTimer = null, loadStart = 0;

  function show(id, on) { $(id).hidden = !on; }

  /* 倒數環 */
  var cdLeft = CD_TOTAL;
  function drawRing() {
    $('ringFg').style.strokeDashoffset = (RING_C * (1 - cdLeft / CD_TOTAL)).toFixed(1);
  }
  function resetCountdown() {
    cdLeft = CD_TOTAL;
    var fg = $('ringFg');
    fg.style.transition = 'none';
    drawRing();
    void fg.getBoundingClientRect();
    fg.style.transition = '';
  }
  function refreshNow() {
    var c = (state.following && state.me) ? state.me : state.center;
    query(c, false);
  }
  setInterval(function () {
    if (document.visibilityState !== 'visible' || state.loading || !state.lastQueryAt) return;
    if (cdLeft > 0) { cdLeft--; drawRing(); }
    if (cdLeft <= 0) refreshNow();
  }, 1000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.lastQueryAt && !state.loading &&
        Date.now() - state.lastQueryAt > CD_TOTAL * 1000) {
      refreshNow();
    }
  });

  function setLoading(on) {
    state.loading = on;
    $('btnRefresh').classList.toggle('spinning', on);
    show('chipLoading', on);
    clearInterval(secTimer);
    if (on) {
      loadStart = Date.now();
      $('loadSec').textContent = '';
      secTimer = setInterval(function () {
        var s = Math.floor((Date.now() - loadStart) / 1000);
        $('loadSec').textContent = s >= 3 ? s + 's' : '';
      }, 1000);
    }
  }

  // manual=true：使用者操作，會取消進行中的請求；false：自動更新，進行中就略過
  function query(center, manual) {
    if (state.loading) {
      if (!manual) return;
      if (ctrl) ctrl.abort();
    }
    ctrl = new AbortController();
    var my = ctrl;
    var tid = setTimeout(function () { my.abort(); }, TIMEOUT_MS);
    state.center = center;
    state.lastQueryAt = Date.now();
    resetCountdown();
    setCircle();
    show('chipHere', false);
    show('chipError', false);
    show('chipEmpty', false);
    setLoading(true);

    var url = 'api/nearby?lat=' + center[0].toFixed(6) + '&lon=' + center[1].toFixed(6) +
      '&radius=' + state.radius + '&vehicle=' + state.vehicle;
    fetch(url, { signal: my.signal, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (my !== ctrl) return;
        state.items = data.items || [];
        state.spots = Array.isArray(data.spots) ? data.spots : [];
        state.age = data.age == null ? null : data.age;
        state.fetchedAt = Date.now();
        render();
      })
      .catch(function (err) {
        if (my !== ctrl) return;        // 已被新的請求取代
        show('chipError', true);
      })
      .then(function () {
        clearTimeout(tid);
        if (my === ctrl) setLoading(false);
      });
  }

  /* ---------- 畫面 ---------- */
  function markerIcon(it, sel) {
    var n = shown(it);
    var txt = n == null ? '–' : n;
    var approx = it.kind === 'curb' && it.spots === 0;
    var h = approx ? 26 : 34;
    var w = String(txt).length > 2 ? (approx ? 34 : 42) : (approx ? 26 : 34);
    return L.divIcon({
      className: 'pk-wrap',
      html: '<div class="pk ' + it.kind + (approx ? ' approx ' : ' ') + level(it) + (sel ? ' sel' : '') + '">' + esc(txt) + '</div>',
      iconSize: [w, h], iconAnchor: [w / 2, h / 2]
    });
  }

  function render() {
    markerLayer.clearLayers();
    markers = {};
    var items = sortedItems();
    items.forEach(function (it) {
      if (hasSpots(it)) return;          // 有逐格資料的路段改用圓點表示
      var m = L.marker([it.lat, it.lon], { icon: markerIcon(it, it.id === state.selected), keyboard: false });
      m.on('click', function () { select(it.id, true); });
      m.addTo(markerLayer);
      markers[it.id] = m;
    });
    renderSpots();
    renderList(items);
    renderAge();
    show('chipEmpty', items.length === 0);
    show('sheet', items.length > 0 && !state.selected);
    document.body.classList.toggle('has-sheet', items.length > 0);
    if (state.selected) {
      var cur = findItem(state.selected) || state.selStub;
      if (cur) fillDetail(cur, state.selNav); else closeDetail();
    }
  }

  /* ---------- 車位圓點 ---------- */
  var hlId = null, hlBig = false, hlTimer = null, hlStop = null;
  function baseR() {
    var z = map.getZoom();
    return z >= 17 ? 6 : z >= 15 ? 4 : 3;
  }
  function dotR(m) {
    var r = baseR();
    if (m.spot.st !== 0) return Math.max(2, r * 0.75);
    if (hlId && m.spot.seg === hlId) return r * (hlBig ? 2.2 : 1.6);
    return r;
  }
  function restyleDots() {
    for (var i = 0; i < dotMarkers.length; i++) dotMarkers[i].setRadius(dotR(dotMarkers[i]));
  }
  function renderSpots() {
    spotLayer.clearLayers();
    dotMarkers = [];
    segDots = {};
    var occ = [], vac = [];
    state.spots.forEach(function (s) {
      var spot = { lat: s[0], lon: s[1], st: s[2] ? 1 : 0, seg: String(s[3]) };
      if (spot.st === 1 && !state.showOcc) return;
      var m = L.circleMarker([spot.lat, spot.lon], spot.st === 0 ? {
        renderer: dotRenderer, radius: 5, color: '#fff', weight: 2, opacity: 1,
        fillColor: '#22c55e', fillOpacity: 1, bubblingMouseEvents: false
      } : {
        renderer: dotRenderer, radius: 3, stroke: false,
        fillColor: '#ef4444', fillOpacity: .4, bubblingMouseEvents: false
      });
      m.spot = spot;
      m.on('click', function () { openSpot(spot); });
      (spot.st === 0 ? vac : occ).push(m);
      (segDots[spot.seg] = segDots[spot.seg] || []).push(m);
    });
    occ.concat(vac).forEach(function (m) { m.setRadius(dotR(m)); m.addTo(spotLayer); dotMarkers.push(m); });
  }
  map.on('zoomend', restyleDots);

  function highlight(id) {
    clearInterval(hlTimer); clearTimeout(hlStop);
    if (!segDots[id]) { hlId = null; return; }
    hlId = id; hlBig = true; restyleDots();
    hlTimer = setInterval(function () { hlBig = !hlBig; restyleDots(); }, 350);
    hlStop = setTimeout(function () {
      clearInterval(hlTimer); hlId = null; restyleDots();
    }, 2000);
  }

  function openSpot(sp) {
    var it = findItem(sp.seg);
    var stub = null;
    if (!it) {
      stub = { id: sp.seg, kind: 'curb', name: '路邊停車', lat: sp.lat, lon: sp.lon,
        avail: null, total: null, dist: meters(state.me || state.center, [sp.lat, sp.lon]) };
    }
    select(sp.seg, false, [sp.lat, sp.lon], stub);
  }

  function renderList(items) {
    var ul = $('list');
    ul.innerHTML = items.map(function (it) {
      var lv = level(it);
      var n = shown(it);
      var total = shownTotal(it) != null ? '<small>/ ' + shownTotal(it) + '</small>' : '';
      return '<li class="row" data-id="' + esc(it.id) + '">' +
        '<span class="kind ' + it.kind + '">' + icon(it.kind === 'lot' ? 'circle-parking' : 'signpost') + '</span>' +
        '<div class="r-main"><div class="r-name">' + esc(it.name) + '</div><div class="r-dist">' + fmtDist(it.dist) + '</div></div>' +
        '<div class="r-num c-' + lv + '"><b>' + (n == null ? '–' : n) + '</b>' + total + '</div></li>';
    }).join('');
  }

  function renderAge() {
    var b = $('ageBadge');
    if (state.age == null) { b.hidden = true; return; }
    var s = state.age + Math.max(0, Math.round((Date.now() - state.fetchedAt) / 1000));
    if (s < 60) { b.hidden = true; return; }   // 夠新就不顯示，避免雜訊
    b.hidden = false;
    b.textContent = s < 60 ? s + '秒' : Math.round(s / 60) + '分';
    b.classList.toggle('old', s >= 600);
  }
  setInterval(renderAge, 15000);

  function renderButtons() {
    $('btnVehicle').innerHTML = icon(state.vehicle === 'car' ? 'car' : 'bike');
    $('btnVehicle').setAttribute('aria-label', state.vehicle === 'car' ? '汽車' : '機車');
    $('radiusTxt').textContent = state.radius;
    $('btnSort').innerHTML = icon(state.sort === 'dist' ? 'ruler' : 'arrow-down-wide-narrow');
    $('btnSort').setAttribute('aria-label', state.sort === 'dist' ? '依距離' : '依空位');
    $('btnOcc').innerHTML = icon(state.showOcc ? 'eye' : 'eye-off');
    $('btnOcc').classList.toggle('off', !state.showOcc);
    $('btnOcc').setAttribute('aria-label', state.showOcc ? '隱藏有車格' : '顯示有車格');
  }

  /* ---------- 選取 / 詳細卡 ---------- */
  function select(id, fly, nav, stub) {
    var it = findItem(id) || stub;
    if (!it) return;
    var prev = state.selected;
    state.selected = id;
    state.selNav = nav || null;
    state.selStub = stub || null;
    if (prev && markers[prev]) {
      var p = findItem(prev);
      if (p) markers[prev].setIcon(markerIcon(p, false));
    }
    if (markers[id]) { markers[id].setIcon(markerIcon(it, true)); markers[id].setZIndexOffset(1000); }
    fillDetail(it, state.selNav);
    show('detail', true);
    show('sheet', false);
    if (fly) {
      setFollow(false);
      // 卡片蓋住下方，目標往上偏一點
      var z = it.kind === 'curb' ? 18 : Math.max(map.getZoom(), 17);
      var pt = map.project([it.lat, it.lon], z).add([0, window.innerWidth < 768 ? 90 : 0]);
      map.flyTo(map.unproject(pt, z), z, { duration: .6 });
      if (it.kind === 'curb') highlight(id);
    }
  }

  function fillDetail(it, nav) {
    var lv = level(it);
    var n = shown(it);
    $('dKind').className = 'kind ' + it.kind;
    $('dKind').innerHTML = icon(it.kind === 'lot' ? 'circle-parking' : 'signpost');
    $('dName').textContent = it.name;
    $('dAvail').textContent = n == null ? '–' : n;
    $('dAvail').className = 'c-' + lv;
    $('dTotal').textContent = shownTotal(it) != null ? '/ ' + shownTotal(it) : '';
    $('dDist').textContent = nav ? fmtDist(meters(state.me || state.center, nav)) : fmtDist(it.dist);
    var ago = '';
    if (it.time) {
      var t = Date.parse(it.time);
      if (!isNaN(t)) ago = fmtAgo((Date.now() - t) / 1000);
    }
    $('dTime').innerHTML = ago ? icon('clock', 'sm') + esc(ago) : '';
    var dest = nav || [it.lat, it.lon];
    $('dNav').href = 'https://www.google.com/maps/dir/?api=1&destination=' + dest[0] + ',' + dest[1] + '&travelmode=driving';
    var f = $('dFare');
    f.className = 'fare';
    if (it.fare) { f.hidden = false; f.textContent = it.fare; } else { f.hidden = true; }
  }

  function closeDetail() {
    var prev = state.selected;
    state.selected = null;
    state.selNav = null;
    state.selStub = null;
    if (prev && markers[prev]) {
      var p = findItem(prev);
      if (p) { markers[prev].setIcon(markerIcon(p, false)); markers[prev].setZIndexOffset(0); }
    }
    show('detail', false);
    show('sheet', state.items.length > 0);
  }

  /* ---------- 底部面板（拖曳 / 切換） ---------- */
  var sheet = $('sheet');
  function setExpanded(on) { sheet.classList.toggle('expanded', on); if (!on) $('list').scrollTop = 0; }

  (function () {
    var grab = $('grab'), startY = 0, startH = 0, moved = false, active = false;
    grab.addEventListener('pointerdown', function (e) {
      active = true; moved = false; startY = e.clientY; startH = sheet.getBoundingClientRect().height;
      sheet.classList.add('dragging');
      try { grab.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    grab.addEventListener('pointermove', function (e) {
      if (!active) return;
      var dy = startY - e.clientY;
      if (Math.abs(dy) > 4) moved = true;
      var max = window.innerHeight * 0.68, min = 120;
      sheet.style.height = Math.min(max, Math.max(min, startH + dy)) + 'px';
    });
    function end(e) {
      if (!active) return;
      active = false;
      sheet.classList.remove('dragging');
      var h = parseFloat(sheet.style.height) || startH;
      sheet.style.height = '';
      if (!moved) setExpanded(!sheet.classList.contains('expanded'));
      else setExpanded(h > window.innerHeight * 0.4);
    }
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
    grab.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!sheet.classList.contains('expanded')); }
    });
  })();

  $('list').addEventListener('click', function (e) {
    var li = e.target.closest('.row');
    if (li) { setExpanded(false); select(li.getAttribute('data-id'), true); }
  });

  /* ---------- 按鈕 ---------- */
  $('dClose').addEventListener('click', closeDetail);
  $('dFare').addEventListener('click', function () { this.classList.toggle('open'); });

  $('btnVehicle').addEventListener('click', function () {
    state.vehicle = state.vehicle === 'car' ? 'scooter' : 'car';
    save('vehicle', state.vehicle);
    renderButtons();
    closeDetail();
    query(state.center, true);
  });
  $('btnRadius').addEventListener('click', function () {
    state.radius = RADII[(RADII.indexOf(state.radius) + 1) % RADII.length];
    save('radius', state.radius);
    renderButtons();
    closeDetail();
    query(state.center, true);
  });
  $('btnSort').addEventListener('click', function () {
    state.sort = state.sort === 'dist' ? 'avail' : 'dist';
    save('sort', state.sort);
    renderButtons();
    if (state.items.length) { renderList(sortedItems()); $('list').scrollTop = 0; }
  });
  $('btnRefresh').addEventListener('click', function () {
    query((state.following && state.me) ? state.me : state.center, true);
  });
  $('btnRetry').addEventListener('click', function () { query(state.center, true); });
  $('btnLocate').addEventListener('click', function () { locate(); });
  $('btnOcc').addEventListener('click', function () {
    state.showOcc = !state.showOcc;
    save('occ', state.showOcc ? '1' : '0');
    renderButtons();
    renderSpots();
  });
  $('chipHere').addEventListener('click', function () {
    var c = map.getCenter();
    setFollow(false);
    closeDetail();
    query([c.lat, c.lng], true);
  });

  map.on('dragstart', function () { setFollow(false); });
  map.on('dragend', function () {
    var c = map.getCenter();
    var far = meters([c.lat, c.lng], state.center) > state.radius * 0.3;
    show('chipHere', far);
  });
  map.on('click', function () { if (state.selected) closeDetail(); });
  // 縮放手勢（滾輪、雙擊、雙指、縮放鈕）也關閉跟隨
  (function () {
    var el = map.getContainer();
    el.addEventListener('wheel', function () { setFollow(false); }, { passive: true });
    el.addEventListener('dblclick', function () { setFollow(false); });
    el.addEventListener('touchstart', function (e) { if (e.touches.length > 1) setFollow(false); }, { passive: true });
    var zc = el.querySelector('.leaflet-control-zoom');
    if (zc) zc.addEventListener('click', function () { setFollow(false); });
  })();

  /* ---------- 定位（持續追蹤） ---------- */
  var watchId = null, fellBack = false;
  function setFollow(on) {
    state.following = on;
    $('btnLocate').classList.toggle('active', on);
  }
  function onFix(pos) {
    state.me = [pos.coords.latitude, pos.coords.longitude];
    show('chipNoLoc', false);
    setMe(pos.coords.accuracy);
    if (!state.hasFix) {
      state.hasFix = true;
      setFollow(true);
      closeDetail();
      map.setView(state.me, 16);
      query(state.me, true);
      return;
    }
    if (state.following) {
      map.panTo(state.me, { animate: true, duration: 0.8, easeLinearity: 0.5, noMoveStart: true });
      var thr = Math.max(150, state.radius * 0.3);
      if (!state.loading && meters(state.me, state.center) > thr) query(state.me, false);
    }
  }
  function onGeoErr(err) {
    if (err && err.code === 1) {            // 權限被拒
      stopWatch();
      show('chipNoLoc', true);
      setFollow(false);
    }
    if (!state.hasFix) {
      show('chipNoLoc', true);
      if (!fellBack) fallback();
    }
  }
  function startWatch() {
    if (!navigator.geolocation) { show('chipNoLoc', true); if (!fellBack) fallback(); return; }
    if (watchId != null) return;
    watchId = navigator.geolocation.watchPosition(onFix, onGeoErr,
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  }
  function stopWatch() {
    if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  function locate() {
    closeDetail();
    if (state.me) {
      setFollow(true);
      map.setView(state.me, Math.max(map.getZoom(), 16));
      query(state.me, true);
      if (watchId == null) startWatch();    // 先前被拒或中斷就重試
    } else {
      fellBack = false;
      startWatch();
    }
  }
  function fallback() {
    fellBack = true;
    show('chipNoLoc', true);
    if (!state.me) map.setView(TAIPEI, 16);
    query(state.me || TAIPEI, true);
  }

  /* ---------- 啟動 ---------- */
  renderButtons();
  setCircle();
  startWatch();
})();
