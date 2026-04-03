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
      return e.target && e.target.closest && e.target.closest('.radar-loc-wrap');
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
      opacity, tileSize: 256, maxZoom: 10,
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
        maxZoom: 10,
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
})();



