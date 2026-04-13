/* ══════════════════════════════════════════════════
   RAINVIEWER RADAR
══════════════════════════════════════════════════ */
(function () {
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

  // ── Safe tile layer: guards _tileOnError against removed tiles ────────
  const SafeTileLayer = L.TileLayer.extend({
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
      if (e.tile && e.tile.src) bumpCountIfNew(e.tile.src.split('?')[0]);
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
  const WIND_DIRECT = 'https://storage.googleapis.com/trafikkort-data/geojson/wind-speeds.point.json';
  // On GitHub Pages a scheduled workflow writes this file to the same origin
  // (no CORS). On localhost it 404s and we fall back to proxy.
  const WIND_SAME_ORIGIN = './wind-speeds.json';
  // Public CORS proxies – fallback for local development only.
  const WIND_PROXIES = [
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(WIND_DIRECT),
    'https://corsproxy.io/?url='          + encodeURIComponent(WIND_DIRECT),
  ];
  let windLayer   = null;
  let windVisible = true;

  async function fetchWindJson() {
    // 1. Same-origin (GitHub Pages) – no CORS, no console noise on 404
    try {
      const r = await fetch(WIND_SAME_ORIGIN, { cache: 'no-store' });
      if (r.ok) return r.json();
    } catch (_) {}
    // 2. CORS proxies (local dev fallback)
    for (const url of WIND_PROXIES) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) return r.json();
      } catch (_) {}
    }
    return null;
  }

  const DIR_DEG = {
    N:0, NNE:22, NE:45, ENE:67, E:90, ESE:112, SE:135, SSE:157,
    S:180, SSW:202, SW:225, WSW:247, W:270, WNW:292, NW:315, NNW:337,
  };

  function windColor(mps) {
    // Same ramp as WINDY_RAMP in charts.js – alpha forced to 1 for solid badge.
    const r = [
      [ 0, 130, 190, 255],
      [ 2, 130, 190, 255],
      [ 4, 100, 180, 255],
      [ 7,  50, 200,  80],
      [10, 255, 160,  20],
      [13, 220,  30,  30],
      [16, 160,  30, 220],
      [19,  60,  10, 180],
      [22,  20,  40, 160],
      [27, 140, 180, 240],
      [32, 220, 235, 255],
    ];
    const s = parseFloat(mps) || 0;
    if (s <= r[0][0]) return `rgb(${r[0][1]},${r[0][2]},${r[0][3]})`;
    for (let i = 1; i < r.length; i++) {
      if (s <= r[i][0]) {
        const t = (s - r[i-1][0]) / (r[i][0] - r[i-1][0]);
        const lerp = (a, b) => Math.round(a + (b - a) * t);
        return `rgb(${lerp(r[i-1][1],r[i][1])},${lerp(r[i-1][2],r[i][2])},${lerp(r[i-1][3],r[i][3])})`;
      }
    }
    const last = r[r.length-1];
    return `rgb(${last[1]},${last[2]},${last[3]})`;
  }

  async function refreshWindStations() {
    if (!radarMap) return;
    try {
      const geo = await fetchWindJson();
      if (!geo) return;

      if (windLayer) { radarMap.removeLayer(windLayer); windLayer = null; }
      windLayer = L.layerGroup();

      (geo.features || []).forEach(f => {
        const [lon, lat] = f.geometry.coordinates;
        const { windSpeed, windDirection, windDirectionDanish } = f.properties;
        const spd = parseFloat(windSpeed) || 0;
        const deg = DIR_DEG[windDirection] ?? 0;
        const col = windColor(spd);
        // Arrow points WHERE wind goes (same convention as forecast chart)
        const rot = (deg - 180 + 360) % 360;

        // SVG arrow matching drawWindArrow() in charts.js (size=16):
        //   shaftTop=-3, shaftBot=8, tip=-12, base half-width=6
        // viewBox centred at (0,0) so SVG transform="rotate(rot)" spins around
        // the arrow's own centre.  overflow:visible prevents clipping.
        const halo  = 'rgba(255,255,255,0.8)';
        const arrow =
          `<svg width="24" height="24" viewBox="-12 -12 24 24" ` +
               `style="display:block;overflow:visible">` +
            `<g transform="rotate(${rot})">` +
              `<line x1="0" y1="8" x2="0" y2="-3" stroke="${halo}" stroke-width="5" stroke-linecap="round"/>` +
              `<polygon points="0,-12 -6,-3 6,-3" fill="${halo}"/>` +
              `<line x1="0" y1="8" x2="0" y2="-3" stroke="${col}" stroke-width="3" stroke-linecap="round"/>` +
              `<polygon points="0,-12 -6,-3 6,-3" fill="${col}"/>` +
            `</g>` +
          `</svg>`;

        const icon = L.divIcon({
          className: '',
          html: `<div class="ws-wrap">${arrow}<div class="ws-speed" style="color:${col}">${spd}</div></div>`,
          iconSize:    [24, 38],
          iconAnchor:  [12, 12],
          popupAnchor: [0, -14],
        });

        L.marker([lat, lon], { icon, interactive: true })
          .bindPopup(
            `<div style="font-family:'IBM Plex Sans',sans-serif;font-size:12px;line-height:1.8;min-width:120px">` +
            `<b style="font-size:14px">${spd} m/s</b><br>` +
            `From <b>${windDirection}</b> (${windDirectionDanish || ''})` +
            `</div>`,
            { maxWidth: 200 }
          )
          .addTo(windLayer);
      });

      if (windVisible) windLayer.addTo(radarMap);
    } catch (e) {
      console.warn('Wind stations load failed', e);
    }
  }

  function initWindToggle() {
    const btn = document.getElementById('radar-wind-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      windVisible = !windVisible;
      btn.classList.toggle('active', windVisible);
      if (!radarMap) return;
      if (windVisible) {
        if (windLayer) windLayer.addTo(radarMap);
        else refreshWindStations();
      } else {
        if (windLayer) radarMap.removeLayer(windLayer);
      }
    });
  }
})();



