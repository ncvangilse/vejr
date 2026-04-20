/* ══════════════════════════════════════════════════
   RAINVIEWER RADAR
══════════════════════════════════════════════════ */

/** Extract the most local place name from a Nominatim reverse-geocode response. */
function _parseNominatimPlace(d) {
  if (!d) return null;
  const a = d.address || {};
  return a.neighbourhood || a.suburb || a.hamlet || a.village
         || a.town || a.city_district || a.city || a.municipality
         || (d.display_name ? d.display_name.split(',')[0] : null) || null;
}

/** Returns true when d has a usable local address finer than municipality. */
function _nominatimHasLocalDetail(d) {
  if (!d || !d.address) return false;
  const a = d.address;
  return !!(a.neighbourhood || a.suburb || a.hamlet || a.village
            || a.town || a.city_district || a.city);
}

// RPi pushes obs-history.json.gz directly to the gh-pages branch.
// Read from raw.githubusercontent.com so Pages source can be "GitHub Actions"
// without losing live RPi data updates (RPi still pushes to gh-pages).
const OBS_HISTORY_URL = 'https://raw.githubusercontent.com/ncvangilse/vejr/gh-pages/obs-history.json.gz';
window.OBS_HISTORY_URL = OBS_HISTORY_URL;

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

    // Show a brief "use two fingers to pan" hint when a single finger touches the map.
    let hintTimeout = null;
    const hintEl = document.createElement('div');
    hintEl.id = 'radar-pan-hint';
    hintEl.textContent = 'Use two fingers to pan';
    mapEl.appendChild(hintEl);
    function showHint() {
      clearTimeout(hintTimeout);
      hintEl.classList.add('visible');
      hintTimeout = setTimeout(() => hintEl.classList.remove('visible'), 1200);
    }

    // Touch: one finger scrolls the page; two fingers pan the map.
    mapEl.addEventListener('touchstart', e => {
      if (isMarkerTarget(e)) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        const x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        onStart(x, y);
      } else if (e.touches.length === 1) {
        showHint();
      }
    }, { passive: false });
    mapEl.addEventListener('touchmove', e => {
      if (dragging && e.touches.length === 2) {
        e.preventDefault();
        const x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        onMove(x, y);
      }
      // Single finger: no preventDefault — let the page scroll naturally.
    }, { passive: false });
    mapEl.addEventListener('touchend',    onEnd);
    mapEl.addEventListener('touchcancel', onEnd);

    // Mouse: single click-drag still pans (desktop behaviour unchanged).
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
    hideLoadingOverlay();
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

  // Maximum zoom level at which RainViewer has actual radar tiles.
  // Requests above this are upscaled by Leaflet from the native-zoom tiles.
  const RADAR_NATIVE_MAX_ZOOM = 7;

  // ── Safe tile layer: guards _tileOnError against removed tiles,
  //    short-circuits createTile while rate-limited, and hard-caps the
  //    tile URL zoom so the RainViewer CDN never receives z > native max.
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
    // Hard-cap the z value written into the tile URL regardless of what
    // Leaflet's internal _tileZoom resolves to.
    _getZoomForUrl() {
      return Math.min(
        L.TileLayer.prototype._getZoomForUrl.call(this),
        RADAR_NATIVE_MAX_ZOOM
      );
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
      opacity, tileSize: 256, maxNativeZoom: RADAR_NATIVE_MAX_ZOOM, maxZoom: 18,
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
      initOverlayToggles();
    }
    radarMap.setView([lat, lon], 8);
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
      _fitRadarHeight();

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

  // ── Radar height fitting ──────────────────────────────────────────────
  // Size #radar-map so the footer sits just below the fold when the page
  // is at scroll position 0 — i.e. the radar section fills whatever
  // vertical space remains below the forecast charts.
  function _fitRadarHeight() {
    const section    = document.getElementById('radar-section');
    const mapEl      = document.getElementById('radar-map');
    const headerEl   = document.getElementById('radar-header');
    const controlsEl = document.getElementById('radar-controls');
    if (!section || section.style.display === 'none') return;
    const headerH   = headerEl   ? headerEl.offsetHeight   : 34;
    const controlsH = controlsEl ? controlsEl.offsetHeight : 34;
    // section.offsetTop = distance from document top to section border-box.
    // footer has margin-top: 12px.  We want footer-top = window.innerHeight
    // (just below fold) when scrollY = 0, so:
    //   section.offsetTop + sectionHeight + 12 = window.innerHeight
    //   mapHeight = window.innerHeight - section.offsetTop - 12 - headerH - controlsH - 2 (borders)
    const mapH = window.innerHeight - section.offsetTop - 12 - headerH - controlsH - 2;
    mapEl.style.minHeight = Math.max(320, mapH) + 'px';
  }

  // ── Resize / orientation ──────────────────────────────────────────────
  function onOrientationChange() {
    _fitRadarHeight();
    if (!radarMap) return;
    setTimeout(() => { _fitRadarHeight(); radarMap.invalidateSize(); }, 300);
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

  // All stations in obs-history.json.gz now have full 24h history available.
  // Every marker is rendered interactively with a history popup.

  let trafikinfoLayer   = null;
  let dmiLayer          = null;
  let trafikinfoVisible = true;
  let dmiVisible        = true;

  // True when the body has the 'inverted-colors' class set by app.js.
  const _inv = () => document.body.classList.contains('inverted-colors');

  // Pre-invert an "rgb(R,G,B)" colour string so the OS double-inversion
  // round-trip restores the original colour.
  function _preInvRgb(rgb) {
    return rgb.replace(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/, (_, r, g, b) =>
      `rgb(${255 - +r},${255 - +g},${255 - +b})`);
  }

  /**
   * Fetch and decompress obs-history.json.gz.
   * Returns the parsed obs-history dict, or null on failure.
   * Populates window.OBS_HISTORY for use by dmi.js.
   */
  async function fetchObsHistory() {
    try {
      const r = await fetch(OBS_HISTORY_URL, { cache: 'no-store' });
      if (!r.ok) return null;
      let data;
      if (typeof DecompressionStream !== 'undefined') {
        const ds   = new DecompressionStream('gzip');
        const text = await new Response(r.body.pipeThrough(ds)).text();
        data = JSON.parse(text);
      } else {
        // Fallback: some browsers may auto-decompress if Content-Encoding is set;
        // otherwise try parsing the body directly (will fail gracefully).
        data = await r.json();
      }
      window.OBS_HISTORY = data;
      return data;
    } catch (_) {
      return null;
    }
  }

  /**
   * Read pre-computed forecast bias for a station key from window.OBS_HISTORY.
   * Returns { bias: number, n: number } or null when absent / insufficient data.
   */
  function _stationBias(key) {
    const b = window.OBS_HISTORY?.[key]?.bias;
    if (!b || b.n == null || b.wind == null) return null;
    return { bias: b.wind, n: b.n };
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

  /** Build markers from wind-speeds.json GeoJSON and add them to the given layer.
   *  @deprecated — kept for reference; obs-history is now used instead. */
  function _addGeoMarkersToLayer(geo, layer) {
    const inv = _inv();
    (geo.features || []).forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const { windSpeed, windDirection } = f.properties;
      const spd    = parseFloat(windSpeed) || 0;
      const deg    = DIR_DEG[windDirection] ?? 0;
      const rawCol = windColor(spd);
      const col    = inv ? _preInvRgb(rawCol) : rawCol;
      const rot    = (deg - 180 + 360) % 360;
      const halo   = inv ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.8)';

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
        iconSize: [24, 38], iconAnchor: [12, 12], popupAnchor: [0, -14],
      });

      L.marker([lat, lon], { icon, interactive: false })
        .addTo(layer);
    });
  }

  async function refreshWindStations() {
    console.log('[map] refreshWindStations — radarMap:', !!radarMap,
      '| trafikinfoVisible:', trafikinfoVisible, '| dmiVisible:', dmiVisible);
    if (!radarMap) { console.log('[map] skip — radarMap null'); return; }

    dmiMarker = null;
    dmiAllMarkers = [];
    if (trafikinfoLayer) { radarMap.removeLayer(trafikinfoLayer); trafikinfoLayer = null; }
    if (dmiLayer)        { radarMap.removeLayer(dmiLayer);        dmiLayer        = null; }
    trafikinfoLayer = L.layerGroup();
    dmiLayer        = L.layerGroup();

    try {
      const obsHistory = await fetchObsHistory();

      if (!obsHistory) {
        console.log('[map] obs-history unavailable');
      } else {

        const entries = Object.entries(obsHistory);
        const ninjoCount = entries.filter(([k]) => k.startsWith('ninjo:')).length;
        const trafiCount = entries.filter(([k]) => k.startsWith('trafikkort:')).length;
        console.log(`[map · obs-history] ${ninjoCount} NinJo + ${trafiCount} Trafikkort stations`);

        for (const [key, station] of entries) {
          if (!station.obs || !station.obs.length) continue;

          // Latest obs entry (last item — array is time-sorted ascending)
          const latest = station.obs[station.obs.length - 1];
          if (latest.wind == null) continue;

          const inv    = _inv();
          const rawCol = windColor(latest.wind);
          const col    = inv ? _preInvRgb(rawCol) : rawCol;

          const isNinjo = key.startsWith('ninjo:');

          const svgPart = latest.dir != null
            ? _dmiArrowSvg(latest.dir, col)
            : _dmiCircleSvg(col);

          // ── All stations are interactive — popup shows 24h history from obs-history ──
          const iconHtml = `<div class="ws-wrap">${svgPart}<div class="ws-speed" style="color:${col}">${latest.wind.toFixed(1)}</div></div>`;
          const icon = L.divIcon({
            className: '', html: iconHtml,
            iconSize: [24, 38], iconAnchor: [12, 12], popupAnchor: [0, -14],
          });

          const obsTime = new Date(latest.t);
          const sObj = {
            key,
            name:       station.name,
            lat:        station.lat,
            lon:        station.lon,
            source:     isNinjo ? 'DMI' : 'Trafikkort',
            obsTime,
            obsHistory: station.obs,
            latest:     { wind: latest.wind, gust: latest.gust ?? null, dir: latest.dir ?? null, time: latest.t },
          };

          const popupEl = _buildStationPopupEl(sObj);
          const layer   = isNinjo ? dmiLayer : trafikinfoLayer;
          const marker  = L.marker([station.lat, station.lon], {
            icon, interactive: true, zIndexOffset: isNinjo ? 200 : 100,
          }).bindPopup(popupEl, { maxWidth: 300, minWidth: 250 });

          marker.on('popupopen', () => {
            const histEl = popupEl.querySelector('.dmi-hist-container');
            if (histEl && histEl.dataset.loaded !== '1') {
              _renderDmiHistory(histEl, sObj.obsHistory);
              histEl.dataset.loaded = '1';
              marker.getPopup()?.update();
            }
            // Reverse-geocode Trafikkort station name on first open
            if (!isNinjo) {
              const nameEl = popupEl.querySelector('.stn-name');
              if (nameEl && nameEl.dataset.geocoded !== '1') {
                nameEl.dataset.geocoded = '1';
                const _nomFetch = (lat, lon, zoom) => {
                  const z = zoom ? `&zoom=${zoom}` : '';
                  return fetch(
                    `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1${z}`,
                    { headers: { 'Accept-Language': 'da' } }
                  ).then(r => r.ok ? r.json() : null);
                };
                _nomFetch(sObj.lat, sObj.lon)
                  .then(d => _nominatimHasLocalDetail(d)
                    ? _parseNominatimPlace(d)
                    : _nomFetch(sObj.lat, sObj.lon, 14)
                        .then(d2 => _parseNominatimPlace(d2) || _parseNominatimPlace(d))
                  )
                  .then(place => {
                    if (place) {
                      nameEl.textContent = place;
                      marker.getPopup()?.update();
                    }
                  }).catch(() => {});
              }
            }
            // Inject bias row — available synchronously from obs-history
            const biasEl = popupEl.querySelector('.dmi-bias-row');
            if (biasEl && biasEl.dataset.loaded !== '1') {
              biasEl.dataset.loaded = '1';
              const b = _stationBias(key);
              if (b) {
                const sign    = b.bias >= 0 ? '+' : '';
                const absB    = Math.abs(b.bias);
                const biasCol = absB > 2 ? '#e06020' : absB > 1 ? '#e0a020' : '#8899aa';
                biasEl.innerHTML =
                  `<span style="color:#aaa;font-size:10px">Model bias&nbsp;</span>` +
                  `<span style="color:${biasCol};font-size:10px;font-weight:600">${sign}${b.bias.toFixed(1)}&nbsp;m/s</span>` +
                  `<span style="color:#aaa;font-size:10px">&nbsp;·&nbsp;${b.n}h</span>`;
              } else {
                biasEl.style.display = 'none';
              }
            }
          });

          marker.addTo(layer);
        }
      }
    } catch (e) {
      console.warn('[map] error in refreshWindStations:', e);
    }

    if (trafikinfoVisible) trafikinfoLayer.addTo(radarMap);
    if (dmiVisible)        dmiLayer.addTo(radarMap);
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

  /** Build the popup DOM element for a station marker. */
  function _buildStationPopupEl(s) {
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
    const timeStr = s.obsTime
      ? s.obsTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : '';
    const sourceUrl = s.source === 'DMI' ? 'https://www.dmi.dk/vejrdata/maalinger' : 'https://trafikkort.vejdirektoratet.dk';
    const metaHtml = `<a href="${sourceUrl}" target="_blank" rel="noopener noreferrer" style="color:#999;text-decoration:none">${s.source}</a>${timeStr ? `&nbsp;·&nbsp;obs&nbsp;${timeStr}` : ''}`;
    const el = document.createElement('div');
    el.setAttribute('style', 'font-family:"IBM Plex Sans",sans-serif;font-size:12px;line-height:1.6;min-width:170px;max-width:280px');
    el.innerHTML =
      `<div class="stn-name" style="font-size:13px;font-weight:700">${s.name}</div>` +
      `<div style="color:#999;font-size:11px;margin-bottom:4px">${metaHtml}</div>` +
      windHtml +
      `<div class="dmi-bias-row" style="margin:2px 0;min-height:14px"></div>` +
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

    // inv is only used for the pixel pre-inversion at the end (same pattern as
    // the forecast charts: always draw in light-theme colours, then flip pixels
    // so the OS double-inversion round-trip restores the same appearance).
    const inv = _inv();

    // ── Backgrounds ──────────────────────────────────────────────────────
    ctx.fillStyle = inv ? '#1e2a38' : '#f4f6f9';
    ctx.fillRect(0, 0, CSS_W, PAD_T + W_H);
    ctx.fillStyle = inv ? '#162030' : '#eceff5';
    ctx.fillRect(0, PAD_T + W_H, CSS_W, D_H + PAD_B);

    // ── Horizontal grid + Y labels ───────────────────────────────────────
    ctx.font         = `9px 'IBM Plex Mono', monospace`;
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    for (let w = 0; w <= wNice; w += 5) {
      const y = ty(w);
      if (y < PAD_T - 1) continue;
      ctx.strokeStyle = inv ? 'rgba(255,255,255,0.1)' : '#dde2ea';
      ctx.lineWidth   = 0.5;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + CW, y); ctx.stroke();
      if (w > 0) {
        ctx.fillStyle = inv ? '#8899aa' : '#bbb';
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
          ctx.strokeStyle = inv ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
          ctx.lineWidth   = 1;
          ctx.beginPath();
          ctx.moveTo(x, PAD_T);
          ctx.lineTo(x, PAD_T + W_H + D_H);
          ctx.stroke();
          ctx.fillStyle = inv ? '#8899aa' : '#aaa';
          ctx.fillText(String(tick.getHours()).padStart(2, '0'), x, PAD_T + W_H + D_H + 2);
        }
        tick.setHours(tick.getHours() + 6);
      }
    }

    // ── Gust dashed line ─────────────────────────────────────────────────
    if (gustPts.length > 1) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = inv ? 'rgba(255,170,60,0.7)' : 'rgba(190,110,40,0.55)';
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
    ctx.fillStyle = inv ? 'rgba(100,160,220,0.25)' : 'rgba(100,160,220,0.15)';
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
    ctx.strokeStyle = inv ? 'rgba(255,255,255,0.18)' : '#d0d5de';
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
    ctx.fillStyle    = inv ? '#8899aa' : '#bbb';
    ctx.fillText('— wind  ╌ gust  ↑ dir', PAD_L + CW, PAD_T + W_H - 2);

    // Pre-invert all pixels so the OS double-inversion round-trip restores
    // the original wind-speed colour ramp and chart colours.
    if (_inv()) {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = imgData.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i]   = 255 - px[i];
        px[i+1] = 255 - px[i+1];
        px[i+2] = 255 - px[i+2];
      }
      ctx.putImageData(imgData, 0, 0);
    }
  }

  // Rebuild wind-station markers whenever inverted-colours mode is toggled.
  window.matchMedia('(inverted-colors: inverted)').addEventListener('change', () => {
    if (!radarMap) return;
    refreshWindStations();
  });


  function initOverlayToggles() {
    const trafikinfoBtn = document.getElementById('radar-trafikinfo-toggle');
    if (trafikinfoBtn) {
      trafikinfoBtn.addEventListener('click', () => {
        trafikinfoVisible = !trafikinfoVisible;
        trafikinfoBtn.classList.toggle('active', trafikinfoVisible);
        if (!radarMap) return;
        if (trafikinfoVisible) {
          if (trafikinfoLayer) trafikinfoLayer.addTo(radarMap);
          else refreshWindStations();
        } else {
          if (trafikinfoLayer) radarMap.removeLayer(trafikinfoLayer);
        }
      });
    }

    const dmiBtn = document.getElementById('radar-dmi-toggle');
    if (dmiBtn) {
      dmiBtn.addEventListener('click', () => {
        dmiVisible = !dmiVisible;
        dmiBtn.classList.toggle('active', dmiVisible);
        if (!radarMap) return;
        if (dmiVisible) {
          if (dmiLayer) dmiLayer.addTo(radarMap);
          else refreshWindStations();
        } else {
          if (dmiLayer) radarMap.removeLayer(dmiLayer);
        }
      });
    }
  }
})();












