/* ══════════════════════════════════════════════════
   RAINVIEWER RADAR
══════════════════════════════════════════════════ */
(function () {
  // Leaflet is loaded from CDN; bail out gracefully if it failed (offline / blocked).
  if (typeof L === 'undefined') {
    console.warn('[Radar] Leaflet not loaded — radar map disabled');
    return;
  }
  let radarMap      = null;
  let radarFrames   = [];
  let radarIdx      = 0;
  let radarPlaying  = false;
  let playTimeout   = null;
  let markerDragging = false;   // true while the location pin is being dragged
  const PLAY_INTERVAL = 600;

  // One single tile layer — URL is swapped per frame.
  // We keep a second "staging" layer that pre-loads the next frame
  // while the current one is displayed.
  let currentLayer  = null;
  let stagingLayer  = null;
  let stagingIdx    = -1;
  let stagingReady  = false;

  const slider    = document.getElementById('radar-slider');
  const playBtn   = document.getElementById('radar-play-btn');
  const timeLabel = document.getElementById('radar-time-label');
  const zoomIn    = document.getElementById('radar-zoom-in');
  const zoomOut   = document.getElementById('radar-zoom-out');

  // ── Map drag ──────────────────────────────────────────────────────────
  function attachMapDrag(mapEl) {
    let dragging = false, lastX = 0, lastY = 0;
    function isMarkerTarget(e) {
      const t = e.target;
      if (!t || !t.closest) return false;
      return t.closest('.radar-loc-wrap') ||
             t.closest('.ws-wrap') ||
             t.closest('.leaflet-popup-content-wrapper') ||
             t.closest('.leaflet-popup-close-button');
    }
    function onStart(x, y) { dragging = true; lastX = x; lastY = y; }
    function onMove(x, y) {
      if (!dragging || !radarMap || markerDragging) return;
      const dx = x - lastX, dy = y - lastY;
      lastX = x; lastY = y;
      radarMap.panBy([-dx, -dy], { animate: false });
    }
    function onEnd() { dragging = false; }
    mapEl.addEventListener('touchstart',  e => { if (isMarkerTarget(e)) return; e.preventDefault(); onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: false });
    mapEl.addEventListener('touchmove',   e => { e.preventDefault(); onMove(e.touches[0].clientX,  e.touches[0].clientY); }, { passive: false });
    mapEl.addEventListener('touchend',    onEnd);
    mapEl.addEventListener('touchcancel', onEnd);
    mapEl.addEventListener('mousedown',   e => { if (isMarkerTarget(e)) return; e.preventDefault(); onStart(e.clientX, e.clientY); });
    window.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
    window.addEventListener('mouseup',    onEnd);
  }

  // ── Daily tile-request counter (persisted in localStorage) ───────────
  const COUNTER_KEY = 'rvTileCount';
  const DATE_KEY    = 'rvTileDate';
  const LIMIT       = 1000;
  const _seenTiles  = new Set();

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function getCount() {
    if (localStorage.getItem(DATE_KEY) !== todayStr()) {
      localStorage.setItem(DATE_KEY, todayStr());
      localStorage.setItem(COUNTER_KEY, '0');
    }
    return parseInt(localStorage.getItem(COUNTER_KEY) || '0', 10);
  }
  function bumpCountIfNew(url) {
    if (_seenTiles.has(url)) return;
    _seenTiles.add(url);
    const n = getCount() + 1;
    localStorage.setItem(COUNTER_KEY, String(n));
    updateCounterDisplay(n);
  }
  function updateCounterDisplay(n) {
    const el = document.getElementById('radar-tile-counter');
    if (!el) return;
    el.textContent = `${n} / ${LIMIT} tiles`;
    el.className = n >= LIMIT ? 'limit' : n >= LIMIT * 0.8 ? 'warn' : '';
  }
  updateCounterDisplay(getCount());

  // ── Tile URL for a frame ──────────────────────────────────────────────
  function frameUrl(frame) {
    return `https://tilecache.rainviewer.com${frame.path}/256/{z}/{x}/{y}/6/0_1.png`;
  }

  // ── Load-generation counter: incremented on every loadRadar call ─────
  // Any async callback that captured an older generation is silently dropped.
  let loadGen = 0;

  // ── Rate-limit state ──────────────────────────────────────────────────
  let rateLimited    = false;
  let rateLimitTimer = null;

  function setRateLimited() {
    if (rateLimited) return;
    rateLimited = true;
    dropStaging();
    clearTimeout(playTimeout);
    clearTimeout(rateLimitTimer);
    const el = document.getElementById('radar-tile-counter');
    if (el) { el.textContent = '429 – wait 60s'; el.className = 'limit'; }
    const genAtLimit = loadGen;
    rateLimitTimer = setTimeout(() => {
      rateLimited = false;
      const el2 = document.getElementById('radar-tile-counter');
      if (el2) updateCounterDisplay(getCount());
      // Only resume if no newer loadRadar call has taken over.
      if (radarPlaying && loadGen === genAtLimit) goToFrame(radarIdx);
    }, 60000);
  }

  // ── Transparent 1×1 placeholder — returned instead of making an HTTP
  //    request when we know the tile would 429 (or just to fill gaps).
  const TRANSPARENT_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // ── Safe tile layer: guards _tileOnError against removed tiles, and
  //    short-circuits createTile while rate-limited so no new 429s are fired.
  const SafeTileLayer = L.TileLayer.extend({
    createTile(coords, done) {
      // While rate-limited, return a transparent placeholder immediately —
      // no HTTP request, no browser console noise.
      if (rateLimited) {
        const img = document.createElement('img');
        img.setAttribute('role', 'presentation');
        img.setAttribute('alt', '');
        img.src = TRANSPARENT_TILE;
        setTimeout(() => done(null, img), 0);
        return img;
      }
      return L.TileLayer.prototype.createTile.call(this, coords, done);
    },
    _tileOnError(done, tile, e) {
      if (!tile || !tile.el) return;
      try { L.TileLayer.prototype._tileOnError.call(this, done, tile, e); }
      catch (_) {}
    },
  });

  // ── Probe a single tile URL to detect 429 ────────────────────────────
  let _probing = false;
  let _everLoadedTile = false;
  function probe429(url) {
    if (_probing || rateLimited) return;
    _probing = true;
    fetch(url, { cache: 'no-store', mode: 'cors' })
      .then(r => {
        _probing = false;
        if (r.status === 429) setRateLimited();
      })
      .catch(() => {
        _probing = false;
        // RainViewer omits CORS headers on 429 — treat network error as 429
        // only if we've successfully loaded tiles before (rules out plain offline)
        if (_everLoadedTile) setRateLimited();
      });
  }

  // ── Create a tile layer, fire onReady() when all viewport tiles loaded
  function makeLayer(frame, opacity, onReady) {
    const l = new SafeTileLayer(frameUrl(frame), {
      opacity, tileSize: 256, maxZoom: 12,
      keepBuffer: 0, updateWhenIdle: true,
    });
    let pending = 0, errors = 0, probeUrl = null;
    l.on('tileloadstart', (e) => {
      pending++;
      if (!probeUrl && e.coords) {
        try { probeUrl = l.getTileUrl(e.coords); } catch (_) {}
      }
    });
    l.on('tileload', (e) => {
      errors = 0;
      _everLoadedTile = true;
      if (e.tile && e.tile.src && e.tile.src.startsWith('http'))
        bumpCountIfNew(e.tile.src.split('?')[0]);
      if (--pending === 0 && onReady) { onReady(); onReady = null; }
    });
    l.on('tileerror', (e) => {
      errors++;
      if (errors === 3 && probeUrl) probe429(probeUrl);
      if (--pending === 0 && onReady) { onReady(); onReady = null; }
    });
    return l;
  }

  // ── Discard the staging layer cleanly ────────────────────────────────
  function dropStaging() {
    if (stagingLayer) { radarMap.removeLayer(stagingLayer); stagingLayer = null; }
    stagingIdx = -1; stagingReady = false;
  }

  let locationMarker  = null;
  let onMarkerDragEnd = null;   // callback(lat, lon) – set by window.setRadarDragCallback

  function placeLocationMarkers(lat, lon) {
    if (locationMarker) {
      locationMarker.setLatLng([lat, lon]);
      return;
    }
    const icon = L.divIcon({
      className: '',
      html: `<div class="radar-loc-wrap">
               <div class="radar-loc-pulse"></div>
               <div class="radar-loc-dot" style="cursor:grab;"></div>
             </div>`,
      iconSize:   [30, 30],
      iconAnchor: [15, 15],
    });
    locationMarker = L.marker([lat, lon], {
      icon,
      draggable:    true,
      interactive:  true,
      zIndexOffset: 1000,
    }).addTo(radarMap);

    locationMarker.on('dragstart', () => {
      markerDragging = true;
    });

    locationMarker.on('drag', () => {
      const dotEl = locationMarker.getElement()?.querySelector('.radar-loc-dot');
      if (dotEl) dotEl.style.cursor = 'grabbing';
    });

    locationMarker.on('dragend', () => {
      markerDragging = false;
      const dotEl = locationMarker.getElement()?.querySelector('.radar-loc-dot');
      if (dotEl) dotEl.style.cursor = 'grab';

      const { lat: newLat, lng: newLon } = locationMarker.getLatLng();
      if (onMarkerDragEnd) onMarkerDragEnd(newLat, newLon);
    });
  }

  // ── Map init ──────────────────────────────────────────────────────────
  function initMap(lat, lon) {
    if (!radarMap) {
      radarMap = L.map('radar-map', {
        zoomControl: false, attributionControl: false,
        dragging: false, inertia: false,
      });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
      }).addTo(radarMap);
      zoomIn.addEventListener('click',  () => radarMap.zoomIn());
      zoomOut.addEventListener('click', () => radarMap.zoomOut());
      attachMapDrag(document.getElementById('radar-map'));

      let moveDebounce = null;
      radarMap.on('movestart', () => {
        dropStaging();
        clearTimeout(moveDebounce);
      });
      radarMap.on('moveend', () => {
        clearTimeout(moveDebounce);
        moveDebounce = setTimeout(() => {
          if (radarFrames.length && currentLayer)
            stageFrame((radarIdx + 1) % radarFrames.length, false);
        }, 400);
      });

      // First-time init: load wind stations and start auto-refresh
      refreshWindStations();
      setInterval(refreshWindStations, 10 * 60 * 1000);
      initWindToggle();
    }
    radarMap.setView([lat, lon], 7);
  }

  // ── Loading overlay ───────────────────────────────────────────────────
  function hideLoadingOverlay() {
    const el = document.getElementById('radar-loading');
    if (el) { el.classList.add('hidden'); setTimeout(() => el.remove(), 500); }
  }

  // ── Update label + slider ─────────────────────────────────────────────
  function updateLabel(idx) {
    const d   = new Date(radarFrames[idx].time * 1000);
    const pad = n => String(n).padStart(2, '0');
    timeLabel.textContent = `${d.getDate()} ${DA_MON[d.getMonth()]} ${d.getHours()}:${pad(d.getMinutes())}`;
    slider.value = idx;
  }

  // ── Commit staged frame → current, then pre-stage next ───────────────
  let autoStartOnFirstCommit = false;

  function commitStaged() {
    if (stagingIdx !== radarIdx) return;
    if (currentLayer) {
      currentLayer.setOpacity(0);
      const old = currentLayer;
      setTimeout(() => radarMap.removeLayer(old), 50);
    }
    stagingLayer.setOpacity(0.65);
    currentLayer = stagingLayer;
    stagingLayer = null; stagingIdx = -1; stagingReady = false;
    hideLoadingOverlay();

    if (autoStartOnFirstCommit) {
      autoStartOnFirstCommit = false;
      radarPlaying = true;
      playBtn.textContent = '⏸ Pause';
    }
    if (radarPlaying) playTimeout = setTimeout(() => advanceFrame(), PLAY_INTERVAL);
    stageFrame((radarIdx + 1) % radarFrames.length, false);
  }

  function stageFrame(idx, urgent) {
    if (rateLimited) return;
    if (stagingIdx === idx) {
      if (urgent && stagingReady) commitStaged();
      return;
    }
    dropStaging();
    stagingIdx = idx;
    const genAtStage = loadGen;
    stagingLayer = makeLayer(radarFrames[idx], 0, () => {
      // Discard if a newer loadRadar call has replaced the frame list.
      if (loadGen !== genAtStage) return;
      stagingReady = true;
      if (urgent && stagingIdx === idx) commitStaged();
    });
    stagingLayer.addTo(radarMap);
  }

  function advanceFrame() { goToFrame((radarIdx + 1) % radarFrames.length); }

  function goToFrame(idx) {
    if (rateLimited) return;
    radarIdx = idx;
    updateLabel(idx);
    clearTimeout(playTimeout);
    if (stagingIdx === idx && stagingReady) commitStaged();
    else stageFrame(idx, true);
  }

  function togglePlay() {
    radarPlaying = !radarPlaying;
    playBtn.textContent = radarPlaying ? '⏸ Pause' : '▶ Play';
    if (radarPlaying) { clearTimeout(playTimeout); advanceFrame(); }
    else              { clearTimeout(playTimeout); }
  }

  slider.addEventListener('input', () => { clearTimeout(playTimeout); goToFrame(+slider.value); });
  playBtn.addEventListener('click', togglePlay);

  // ── Main load ─────────────────────────────────────────────────────────
  async function loadRadar(lat, lon) {
    const myGen = ++loadGen;
    try {
      const r = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' });
      if (myGen !== loadGen) return;  // superseded
      if (!r.ok) return;
      const data    = await r.json();
      if (myGen !== loadGen) return;  // superseded
      const past    = data.radar?.past    || [];
      const nowcast = data.radar?.nowcast || [];
      radarFrames = [...past, ...nowcast];
      if (!radarFrames.length) return;

      _seenTiles.clear();
      document.getElementById('radar-section').style.display = 'flex';

      // initMap must run after the section is visible so Leaflet can
      // measure the container dimensions correctly on first init.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (myGen !== loadGen) return;  // superseded during rAF delay
      initMap(lat, lon);

      clearTimeout(playTimeout);
      radarPlaying = false;
      playBtn.textContent = '▶ Play';
      if (currentLayer) { radarMap.removeLayer(currentLayer); currentLayer = null; }
      if (stagingLayer) { radarMap.removeLayer(stagingLayer); stagingLayer = null; }
      stagingIdx = -1; stagingReady = false;

      slider.max = radarFrames.length - 1;
      radarIdx   = past.length - 1;
      updateLabel(radarIdx);

      radarMap.invalidateSize();
      placeLocationMarkers(lat, lon);
      autoStartOnFirstCommit = true;
      stageFrame(radarIdx, true);

    } catch (e) {
      console.warn('Radar load failed', e);
    }
  }

  // ── Resize / orientation ──────────────────────────────────────────────
  function onOrientationChange() {
    if (!radarMap) return;
    setTimeout(() => radarMap.invalidateSize(), 300);
  }
  window.addEventListener('resize', onOrientationChange);
  screen.orientation?.addEventListener('change', onOrientationChange);

  window.loadRadar = loadRadar;

  /**
   * Register a callback that fires whenever the user drags the location
   * pin to a new position on the radar map.
   * @param {function(lat: number, lon: number): void} cb
   */
  window.setRadarDragCallback = function (cb) { onMarkerDragEnd = cb; };

  // ── Wind station overlay ──────────────────────────────────────────────
  // Primary source: same-origin ninjo-stations.json, fetched server-side by CI every 15 min.
  // Fallback: direct NinJo API (works on dmi.dk), then CORS proxies for other origins.
  const NINJO_SAME_ORIGIN = './ninjo-stations.json';
  const NINJO_URL     = 'https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk?cmd=obj&south=54.1&north=57.9&west=5.5&east=17.9';
  const NINJO_PROXIES = [
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(NINJO_URL),
    'https://corsproxy.io/?url='          + encodeURIComponent(NINJO_URL),
  ];
  let windLayer   = null;
  let windVisible = true;

  async function fetchNinjoStations() {
    // 1. Same-origin cached file — written by CI at deploy time and refreshed every 15 min.
    //    Fast, reliable, no CORS. Falls through only if the file doesn't exist (404).
    try {
      const r = await fetch(NINJO_SAME_ORIGIN, { cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (_) {}
    // 2. Direct fetch — succeeds on dmi.dk-hosted deploys.
    try {
      const r = await fetch(NINJO_URL, { cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (_) {}
    // 3. CORS proxies — last-resort fallback for cross-origin environments.
    for (const url of NINJO_PROXIES) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) return r.json();
      } catch (_) {}
    }
    return null;
  }

  /** Parse a NinJo timestamp "YYYYMMDDHHmmss" → Unix ms (UTC). */
  function _parseNinjoTime(s) {
    if (!s || s.length < 14) return null;
    return Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8),
                    +s.slice(8,10), +s.slice(10,12), +s.slice(12,14));
  }

  // charts.js exposes windColor() returning [r,g,b,a] and windColorStr() returning a CSS string.
  // Inside this IIFE we always need a solid CSS colour, so alias windColorStr(ms,1).
  const windColor = ms => windColorStr(ms, 1);

  async function refreshWindStations() {
    if (!radarMap) return;

    if (windLayer) { radarMap.removeLayer(windLayer); windLayer = null; }
    windLayer = L.layerGroup();

    try {
      const data = await fetchNinjoStations();
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [stationId, st] of Object.entries(data)) {
          if (!st || typeof st !== 'object') continue;
          const vals = st.values || {};
          const wind = vals.WindSpeed10m;
          if (wind == null) continue;

          const dir  = vals.WindDirection10m  ?? null;
          const gust = vals.WindGustLast10Min ?? null;
          const lat  = st.latitude;
          const lon  = st.longitude;
          if (lat == null || lon == null) continue;

          const col      = windColor(wind);
          const svgPart  = dir != null ? _dmiArrowSvg(dir, col) : _dmiCircleSvg(col);
          const iconHtml = `<div class="ws-wrap">${svgPart}<div class="ws-speed" style="color:${col}">${Math.round(wind)}</div></div>`;
          const icon = L.divIcon({
            className: '', html: iconHtml,
            iconSize: [24, 38], iconAnchor: [12, 12], popupAnchor: [0, -14],
          });

          const stationObj = {
            id:         stationId,
            name:       st.name || stationId,
            lat, lon,
            latest:     { wind, gust, dir, time: _parseNinjoTime(st.time) },
            obsHistory: null,
          };

          const popupEl = _buildNinjoPopupEl(stationObj);
          const marker  = L.marker([lat, lon], { icon, interactive: true })
            .bindPopup(popupEl, { maxWidth: 300, minWidth: 250 });

          marker.on('popupopen', () => {
            const histEl = popupEl.querySelector('.dmi-hist-container');
            if (!histEl || histEl.dataset.loaded === '1') return;
            if (typeof window.dmiLoadStationHistory !== 'function') return;
            window.dmiLoadStationHistory(stationObj)
              .then(obs => {
                _renderDmiHistory(histEl, obs);
                histEl.dataset.loaded = '1';
                marker.getPopup()?.update();
              })
              .catch(() => {
                histEl.innerHTML = '<span style="color:#aaa;font-size:11px">History unavailable</span>';
                histEl.dataset.loaded = '1';
                marker.getPopup()?.update();
              });
          });

          marker.addTo(windLayer);
        }
      }
    } catch (e) {
      console.warn('[NinJo] refreshWindStations error:', e);
    }

    if (windVisible) windLayer.addTo(radarMap);
  }

  // ── DMI station markers ───────────────────────────────────────────────────
  //
  //  All active DMI stations in the bbox appear as wind-speed arrows matching
  //  the style of the wind-speeds.json markers when observation data is available.
  //  Stations without recent obs fall back to a small teal circle.
  //  Clicking any station opens a popup with the latest readings and a scrollable
  //  24-hour history table (lazy-loaded from the DMI API on first open).

  const _COMPASS_PTS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  function _degToCompass(deg) { return _COMPASS_PTS[Math.round(deg / 22.5) % 16]; }

  function _dmiArrowSvg(dir, col) {
    const halo = 'rgba(255,255,255,0.8)';
    const rot  = (dir - 180 + 360) % 360;
    return `<svg width="24" height="24" viewBox="-12 -12 24 24" style="display:block;overflow:visible">` +
      `<g transform="rotate(${rot})">` +
        `<line x1="0" y1="8" x2="0" y2="-3" stroke="${halo}" stroke-width="5" stroke-linecap="round"/>` +
        `<polygon points="0,-12 -6,-3 6,-3" fill="${halo}"/>` +
        `<line x1="0" y1="8" x2="0" y2="-3" stroke="${col}" stroke-width="3" stroke-linecap="round"/>` +
        `<polygon points="0,-12 -6,-3 6,-3" fill="${col}"/>` +
      `</g>` +
      `</svg>`;
  }

  function _dmiCircleSvg(col) {
    const halo = 'rgba(255,255,255,0.8)';
    return `<svg width="24" height="24" viewBox="-12 -12 24 24" style="display:block;overflow:visible">` +
      `<circle r="7" fill="${halo}"/><circle r="6" fill="${col}" opacity="0.9"/>` +
      `</svg>`;
  }

  /** Build the popup DOM element for a NinJo station marker. */
  function _buildNinjoPopupEl(s) {
    const latest = s.latest;
    const col    = latest && latest.wind != null ? windColor(latest.wind) : '#50bed7';
    let windHtml = '<div style="color:#aaa;font-size:11px;margin:2px 0">No recent wind data</div>';
    if (latest && latest.wind != null) {
      windHtml =
        `<div style="margin:3px 0">` +
          `<span style="font-size:15px;font-weight:700;color:${col}">${latest.wind.toFixed(1)}&nbsp;m/s</span>` +
          (latest.gust != null
            ? `<span style="color:#999;font-size:11px;margin-left:7px">gust&nbsp;${latest.gust.toFixed(1)}</span>`
            : '') +
        `</div>` +
        (latest.dir != null
          ? `<div style="color:#666;font-size:11px">From&nbsp;<b>${_degToCompass(latest.dir)}</b>&nbsp;(${Math.round(latest.dir)}°)</div>`
          : '');
    }
    const el = document.createElement('div');
    el.setAttribute('style', 'font-family:"IBM Plex Sans",sans-serif;font-size:12px;line-height:1.6;min-width:170px;max-width:280px');
    el.innerHTML =
      `<div style="font-size:13px;font-weight:700">${s.name}</div>` +
      `<div style="color:#999;font-size:11px;margin-bottom:4px">DMI observation</div>` +
      windHtml +
      `<div class="dmi-hist-container" style="margin-top:6px;border-top:1px solid #e8e8e8;padding-top:5px">` +
        `<span style="color:#bbb;font-size:11px">Loading 24h history…</span>` +
      `</div>`;
    return el;
  }

  /** Render a canvas mini-chart into the popup's .dmi-hist-container.
   *  Shows the last 24 h of wind speed (filled area, colour-coded line),
   *  gust (dashed orange line) and wind direction (arrow strip below). */
  function _renderDmiHistory(histEl, obs) {
    histEl.innerHTML = '';

    const cutoff  = Date.now() - 24 * 3600 * 1000;
    const src     = (obs || []).filter(o => o.t >= cutoff);
    const entries = src.filter(o => o.wind != null && isFinite(o.wind));

    if (!entries.length) {
      histEl.innerHTML = '<span style="color:#aaa;font-size:11px">No observations available</span>';
      return;
    }

    // ── Layout ────────────────────────────────────────────────────────
    const CSS_W = 234;
    const PAD_L = 22;   // left margin — y-axis labels
    const PAD_R = 4;
    const PAD_T = 4;
    const W_H   = 72;   // wind-speed chart height
    const D_H   = 22;   // direction arrows strip
    const PAD_B = 14;   // time-label row
    const CSS_H = PAD_T + W_H + D_H + PAD_B;
    const CW    = CSS_W - PAD_L - PAD_R;

    const canvas = document.createElement('canvas');
    const dpr    = window.devicePixelRatio || 1;
    canvas.width        = CSS_W * dpr;
    canvas.height       = CSS_H * dpr;
    canvas.style.cssText = `width:${CSS_W}px;height:${CSS_H}px;display:block;margin-top:4px;border-radius:3px;`;
    histEl.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // ── Data extents ────────────────────────────────────────────────────
    const tMin  = entries[0].t;
    const tMax  = entries[entries.length - 1].t;
    const tSpan = Math.max(tMax - tMin, 1);

    const gustPts = entries.filter(o => o.gust != null && isFinite(o.gust));
    const wMax    = Math.max(
      ...entries.map(o => o.wind),
      ...gustPts.map(o => o.gust),
      5
    );
    const wNice = Math.ceil(wMax / 5) * 5;

    const tx = t => PAD_L + ((t - tMin) / tSpan) * CW;
    const ty = w => PAD_T + W_H - (w / wNice) * W_H;

    // ── Backgrounds ──────────────────────────────────────────────────────
    ctx.fillStyle = '#f4f6f9';
    ctx.fillRect(0, 0, CSS_W, PAD_T + W_H);
    ctx.fillStyle = '#eceff5';
    ctx.fillRect(0, PAD_T + W_H, CSS_W, D_H + PAD_B);

    // ── Horizontal grid + Y labels ───────────────────────────────────────
    ctx.font         = `9px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let w = 0; w <= wNice; w += 5) {
      const y = ty(w);
      if (y < PAD_T - 1) continue;
      ctx.strokeStyle = '#dde2ea';
      ctx.lineWidth   = 0.5;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + CW, y); ctx.stroke();
      if (w > 0) {
        ctx.fillStyle = '#bbb';
        ctx.fillText(String(w), PAD_L - 2, y);
      }
    }

    // ── Vertical time grid + labels ──────────────────────────────────────
    ctx.font         = `9px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    {
      const tick = new Date(tMin);
      tick.setMinutes(0, 0, 0);
      tick.setHours(Math.ceil(tick.getHours() / 6) * 6);
      while (tick.getTime() <= tMax) {
        const x = tx(tick.getTime());
        if (x >= PAD_L + 3 && x <= PAD_L + CW - 3) {
          ctx.strokeStyle = 'rgba(0,0,0,0.07)';
          ctx.lineWidth   = 1;
          ctx.beginPath();
          ctx.moveTo(x, PAD_T);
          ctx.lineTo(x, PAD_T + W_H + D_H);
          ctx.stroke();
          ctx.fillStyle = '#aaa';
          ctx.fillText(String(tick.getHours()).padStart(2, '0'), x, PAD_T + W_H + D_H + 2);
        }
        tick.setHours(tick.getHours() + 6);
      }
    }

    // ── Gust dashed line ─────────────────────────────────────────────────
    if (gustPts.length > 1) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(190,110,40,0.55)';
      ctx.lineWidth   = 1.2;
      ctx.beginPath();
      gustPts.forEach((o, i) => {
        i === 0 ? ctx.moveTo(tx(o.t), ty(o.gust)) : ctx.lineTo(tx(o.t), ty(o.gust));
      });
      ctx.stroke();
      ctx.restore();
    }

    // ── Wind speed: filled area + colour-coded line ───────────────────────
    ctx.beginPath();
    ctx.moveTo(tx(entries[0].t), ty(0));
    for (const o of entries) ctx.lineTo(tx(o.t), ty(o.wind));
    ctx.lineTo(tx(entries[entries.length - 1].t), ty(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(100,160,220,0.15)';
    ctx.fill();

    ctx.lineWidth  = 2;
    ctx.lineCap    = 'round';
    ctx.lineJoin   = 'round';
    for (let i = 1; i < entries.length; i++) {
      const a = entries[i - 1], b = entries[i];
      ctx.strokeStyle = windColor((a.wind + b.wind) / 2);
      ctx.beginPath();
      ctx.moveTo(tx(a.t), ty(a.wind));
      ctx.lineTo(tx(b.t), ty(b.wind));
      ctx.stroke();
    }

    // ── Direction arrows strip ────────────────────────────────────────────
    const DY     = PAD_T + W_H + D_H / 2;
    const dirPts = entries.filter(o => o.dir != null && isFinite(o.dir));
    let lastArrowX = -Infinity;
    for (const o of dirPts) {
      const x = tx(o.t);
      if (x - lastArrowX < 10) continue;   // subsample — min 10 px spacing
      lastArrowX = x;
      const col = windColor(o.wind);
      const rot = ((o.dir - 180 + 360) % 360) * Math.PI / 180;
      ctx.save();
      ctx.translate(x, DY);
      ctx.rotate(rot);
      // halo + shaft
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth   = 3.5;
      ctx.lineCap     = 'round';
      ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(0, -2); ctx.stroke();
      ctx.strokeStyle = col;
      ctx.lineWidth   = 2;
      ctx.beginPath(); ctx.moveTo(0, 5); ctx.lineTo(0, -2); ctx.stroke();
      // halo + arrowhead
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-4, -2); ctx.lineTo(4, -2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-3.5, -2); ctx.lineTo(3.5, -2); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // ── Axes / dividers ───────────────────────────────────────────────────
    ctx.strokeStyle = '#d0d5de';
    ctx.lineWidth   = 0.5;
    // wind / direction separator
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + W_H);
    ctx.lineTo(PAD_L + CW, PAD_T + W_H);
    ctx.stroke();
    // y-axis border
    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T);
    ctx.lineTo(PAD_L, PAD_T + W_H);
    ctx.stroke();

    // ── Legend (bottom-right, inside chart) ──────────────────────────────
    ctx.font         = `8px 'IBM Plex Sans', sans-serif`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle    = '#bbb';
    ctx.fillText('— wind  ╌ gust  ↑ dir', PAD_L + CW, PAD_T + W_H - 2);
  }

  // ── _refreshDmiMarker kept as no-op ──────────────────────────────────────
  //  NinJo stations are now the sole source of radar map wind markers.
  //  dmi.js still calls window.refreshDmiMarker() after loading observations
  //  (used for the chart overlay dots); the map itself is refreshed by the
  //  NinJo 10-minute interval in refreshWindStations().
  function _refreshDmiMarker() {}
  window.refreshDmiMarker = _refreshDmiMarker;

  function initWindToggle() {
    const btn = document.getElementById('radar-wind-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      windVisible = !windVisible;
      btn.classList.toggle('active', windVisible);
      if (!radarMap) return;
      if (windVisible) {
        if (windLayer) { windLayer.addTo(radarMap); _refreshDmiMarker(); }
        else refreshWindStations();
      } else {
        if (windLayer) radarMap.removeLayer(windLayer);
      }
    });
  }
})();






