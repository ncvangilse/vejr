/* ══════════════════════════════════════════════════
   MAIN APP — load, tooltip, kite dialog, URL sync
══════════════════════════════════════════════════ */
var lastData        = null;
var lastRenderedData = null; // the sliced data passed to the most recent renderAll call
let lastShoreCoords = null;  // { lat, lon } of the last loaded city
let lastObsCoords   = null;  // { lat, lon } last used for nearest station lookup

/* ══════════════════════════════════════════════════
   KITE SPOT STORAGE
══════════════════════════════════════════════════ */
const KITE_SPOTS_KEY = 'vejr_kite_spots';
let _curatedSpots = [];

async function fetchCuratedKiteSpots() {
  try {
    const r = await fetch('kite-spots.json');
    if (!r.ok) return;
    _curatedSpots = await r.json();
  } catch (_) {}
}

function loadKiteSpots() {
  try { return JSON.parse(localStorage.getItem(KITE_SPOTS_KEY) || '[]'); } catch (_) { return []; }
}
function getAllKiteSpots() {
  return [..._curatedSpots, ...loadKiteSpots()];
}
function saveKiteSpots(spots) {
  try { localStorage.setItem(KITE_SPOTS_KEY, JSON.stringify(spots)); } catch (_) {}
}
function addKiteSpot(spot) {
  const spots = loadKiteSpots();
  spots.push(spot);
  saveKiteSpots(spots);
  if (window.refreshKiteSpotMarkers) window.refreshKiteSpotMarkers(getAllKiteSpots());
}
function deleteKiteSpot(id) {
  const spots = loadKiteSpots().filter(s => s.id !== id);
  saveKiteSpots(spots);
  if (window.refreshKiteSpotMarkers) window.refreshKiteSpotMarkers(getAllKiteSpots());
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const toR  = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearbyKiteSpot(lat, lon, maxDistM = 2000) {
  for (const s of getAllKiteSpots()) {
    if (haversineDistance(lat, lon, s.lat, s.lon) <= maxDistM) return s;
  }
  return null;
}

function syncInvertedColorsClass() {
  const on = window.matchMedia('(inverted-colors: inverted)').matches;
  document.body.classList.toggle('inverted-colors', on);
}
/* ══════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════ */
async function load(cityName, model) {
  model = model || 'best_match';
  const forecastEl = document.getElementById('forecast-content');
  const isReload = lastData !== null;
  if (isReload) {
    forecastEl.classList.add('updating');
  } else {
    document.getElementById('loading').style.display='block';
    forecastEl.style.display='none';
  }
  document.getElementById('error-msg').style.display='none';
  try {
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline…' };
    const loc = await geocode(cityName);
    // Kick off the Overpass vector fetch in parallel with the weather requests —
    // coords are now known so there's no reason to wait.
    lastShoreCoords = { lat: loc.latitude, lon: loc.longitude };
    if (window.fetchShoreVector) window.fetchShoreVector(loc.latitude, loc.longitude).catch(() => null);
    if (window.analyseShore)     window.analyseShore(loc.latitude, loc.longitude).catch(() => null);
    // fetch main forecast + ensemble in parallel; ensemble failure is non-fatal.
    const iconCodeFetch = (model === 'dmi_seamless')
      ? fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&hourly=weathercode&forecast_days=${FORECAST_DAYS}&timezone=auto&models=icon_seamless`)
          .then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);
    const [data, ensData, iconData] = await Promise.all([
      fetchWeather(loc.latitude, loc.longitude, model),
      fetchEnsemble(loc.latitude, loc.longitude, model).catch(() => null),
      iconCodeFetch,
    ]);
    const H = data.hourly;
    const iconCodes = iconData?.hourly?.weathercode || null;
    // Build sunTimes from the API's daily sunrise/sunset
    sunTimes = {};
    if (data.daily?.sunrise && data.daily?.sunset) {
      data.daily.sunrise.forEach((riseStr, i) => {
        const key     = riseStr.slice(0, 10);
        const sunrise = parseFloat(riseStr.slice(11,13)) + parseFloat(riseStr.slice(14,16)) / 60;
        const setStr  = data.daily.sunset[i];
        const sunset  = parseFloat(setStr.slice(11,13))  + parseFloat(setStr.slice(14,16))  / 60;
        sunTimes[key] = { sunrise, sunset };
      });
    }
    const times=[],temps=[],precips=[],gusts=[],winds=[],dirs=[],codes=[];
    // 1-hour resolution arrays for smooth curves (temp, wind speed/gust, precip) and icons
    const times1h=[],temps1h=[],precips1h=[],gusts1h=[],winds1h=[],codes1h=[],dirs1h=[];
    const totalH=FORECAST_DAYS*24;
    for(let i=0;i<Math.min(totalH,H.time.length);i+=STEP){
      times.push(H.time[i]);
      temps.push(H.temperature_2m[i]);
      precips.push(H.precipitation[i] ?? 0);
      winds.push(H.windspeed_10m[i]);
      // Gusts can be null at the far end of some model runs; fall back to wind speed.
      const rawGust = H.windgusts_10m[i];
      gusts.push(rawGust != null ? rawGust : H.windspeed_10m[i]);
      dirs.push(H.winddirection_10m[i]);
      // Prefer ICON weathercode when DMI has shower but ICON says thunder
      const dmiCode  = H.weathercode[i];
      const iconCode = iconCodes ? (iconCodes[i] ?? dmiCode) : dmiCode;
      const code = (iconCodes && dmiCode >= 80 && dmiCode <= 82 && iconCode >= 95)
                   ? iconCode : dmiCode;
      codes.push(code);
    }
    for(let i=0;i<Math.min(totalH,H.time.length);i+=STEP1H){
      times1h.push(H.time[i]);
      temps1h.push(H.temperature_2m[i]);
      precips1h.push(H.precipitation[i] ?? 0);
      winds1h.push(H.windspeed_10m[i]);
      const rawGust1h = H.windgusts_10m[i];
      gusts1h.push(rawGust1h != null ? rawGust1h : H.windspeed_10m[i]);
      // Weather codes at 1h resolution (portrait mode shows finest available icons)
      const dmiCode1h  = H.weathercode[i];
      const iconCode1h = iconCodes ? (iconCodes[i] ?? dmiCode1h) : dmiCode1h;
      codes1h.push((iconCodes && dmiCode1h >= 80 && dmiCode1h <= 82 && iconCode1h >= 95)
        ? iconCode1h : dmiCode1h);
      dirs1h.push(H.winddirection_10m[i]);
    }
    const MODEL_LABEL = {
      'best_match':          'Auto',
      'dmi_seamless':        'DMI HARMONIE',
      'icon_seamless':       'DWD ICON',
      'ecmwf_ifs025':        'ECMWF IFS',
      'meteofrance_seamless':'Météo-France',
      'gfs_seamless':        'NOAA GFS',
    };
    const ENS_LABEL = {
      'best_match':          'ICON-EPS',
      'dmi_seamless':        'ICON-EPS',
      'icon_seamless':       'ICON-EPS',
      'ecmwf_ifs025':        'IFS-EPS',
      'meteofrance_seamless':'ICON-EPS',
      'gfs_seamless':        'GFS-EPS',
    };
    const modelLabel = MODEL_LABEL[model] || model;
    const ensLabel   = ENS_LABEL[model]   || 'ensemble';
    let ensTemp = null, ensWind = null, ensGust = null, ensPrecip = null;
    let ensTemp1h = null, ensWind1h = null, ensGust1h = null, ensPrecip1h = null;
    const ensStatus = document.getElementById('ens-status');
    if (ensData && ensData.hourly) {
      ensTemp   = ensemblePercentiles(ensData.hourly, 'temperature_2m');
      ensWind   = ensemblePercentiles(ensData.hourly, 'windspeed_10m');
      ensGust   = ensemblePercentiles(ensData.hourly, 'windgusts_10m');
      ensPrecip = ensemblePercentiles(ensData.hourly, 'precipitation');
      ensTemp1h   = ensemblePercentiles(ensData.hourly, 'temperature_2m',   STEP1H);
      ensWind1h   = ensemblePercentiles(ensData.hourly, 'windspeed_10m',    STEP1H);
      ensGust1h   = ensemblePercentiles(ensData.hourly, 'windgusts_10m',    STEP1H);
      ensPrecip1h = ensemblePercentiles(ensData.hourly, 'precipitation',    STEP1H);
      // Snapshot the deterministic gusts BEFORE merging ensemble wind into winds[].
      // The ensemble p50 wind is often higher than the deterministic wind; if we let
      // gusts get clamped against it the gust-wind gap collapses to zero.
      const detGusts = gusts.slice();
      const detGusts1h = gusts1h.slice();
      // Replace deterministic slots with ensemble median (p50) where available.
      if (ensTemp)
        for (let i = 0; i < temps.length;   i++) { if (ensTemp.p50[i]   != null) temps[i]   = ensTemp.p50[i];   }
      if (ensWind)
        for (let i = 0; i < winds.length;   i++) { if (ensWind.p50[i]   != null) winds[i]   = ensWind.p50[i];   }
      if (ensPrecip)
        for (let i = 0; i < precips.length; i++) { if (ensPrecip.p50[i] != null) precips[i] = ensPrecip.p50[i]; }
      if (ensTemp1h)
        for (let i = 0; i < temps1h.length;   i++) { if (ensTemp1h.p50[i]   != null) temps1h[i]   = ensTemp1h.p50[i];   }
      if (ensWind1h)
        for (let i = 0; i < winds1h.length;   i++) { if (ensWind1h.p50[i]   != null) winds1h[i]   = ensWind1h.p50[i];   }
      if (ensPrecip1h)
        for (let i = 0; i < precips1h.length; i++) { if (ensPrecip1h.p50[i] != null) precips1h[i] = ensPrecip1h.p50[i]; }
      // Restore deterministic gusts unchanged — they are already >= det wind from the
      // initial data loop, and they must stay above the (now ensemble-merged) wind line.
      for (let i = 0; i < gusts.length;   i++) gusts[i]   = Math.max(detGusts[i],   winds[i]);
      for (let i = 0; i < gusts1h.length; i++) gusts1h[i] = Math.max(detGusts1h[i], winds1h[i]);
      const memberCount = Object.keys(ensData.hourly).filter(k => k.startsWith('temperature_2m_member')).length;
      ensStatus.textContent = `${modelLabel} + ${ensLabel} (${memberCount} mdl) ✓`;
      ensStatus.style.color = '#5a9';
    } else {
      ensStatus.textContent = `${modelLabel} — ensemble not available`;
      ensStatus.style.color = '#a77';
    }
    document.getElementById('city-name').textContent =
      loc.name+(loc.country_code?', '+loc.country_code:'');
    document.getElementById('loading').style.display='none';
    forecastEl.style.display='block';
    forecastEl.classList.remove('updating');
    lastData = {
      times, temps, precips, gusts, winds, dirs, codes,
      ensTemp, ensWind, ensGust, ensPrecip,
      times1h, temps1h, precips1h, gusts1h, winds1h, codes1h, dirs1h,
      ensTemp1h, ensWind1h, ensGust1h, ensPrecip1h,
      otherModelsWind1h: null,
    };
    // Double rAF ensures layout is complete before measuring canvas width
    requestAnimationFrame(() => requestAnimationFrame(() => {
      renderDisplay(lastData, true);
      // Fetch other-model wind lines in the background; re-render on arrival.
      const capturedData = lastData;
      fetchOtherModelsWind(loc.latitude, loc.longitude, model)
        .then(otherModels => {
          if (lastData !== capturedData || !otherModels.length) return;
          lastData.otherModelsWind1h = otherModels;
          renderDisplay(lastData);
        })
        .catch(() => null);
    }));
    // Load RainViewer radar centred on the selected city
    if (window.loadRadar) window.loadRadar(loc.latitude, loc.longitude);
    // Find nearest obs station and overlay its wind history on the wind chart.
    loadNearestObsStation(loc.latitude, loc.longitude).catch(() => null);
    updateShoreStatusUI();
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display='none';
    forecastEl.classList.remove('updating');
    document.getElementById('error-msg').style.display='block';
  }
}
function renderDisplay(d, scrollToNow = false) {
  const portrait       = window.matchMedia('(orientation: portrait)').matches;
  const invertedColors = window.matchMedia('(inverted-colors: inverted)').matches;
  syncInvertedColorsClass();
  const n3h = Math.ceil(FORECAST_DAYS * 24 / STEP);
  const n1h = Math.ceil(FORECAST_DAYS * 24 / STEP1H);
  const s = {
    times:    d.times.slice(0, n3h),    temps:    d.temps.slice(0, n3h),
    precips:  d.precips.slice(0, n3h),  gusts:    d.gusts.slice(0, n3h),
    winds:    d.winds.slice(0, n3h),    dirs:     d.dirs.slice(0, n3h),
    codes:    d.codes.slice(0, n3h),
    ensTemp:  slicePercentilesFrom(d.ensTemp,  0, n3h), ensWind:  slicePercentilesFrom(d.ensWind,  0, n3h),
    ensGust:  slicePercentilesFrom(d.ensGust,  0, n3h), ensPrecip: slicePercentilesFrom(d.ensPrecip, 0, n3h),
    times1h:  d.times1h.slice(0, n1h),  temps1h:  d.temps1h.slice(0, n1h),
    codes1h:  d.codes1h ? d.codes1h.slice(0, n1h) : null,
    precips1h: d.precips1h.slice(0, n1h), gusts1h: d.gusts1h.slice(0, n1h),
    winds1h:  d.winds1h.slice(0, n1h),
    dirs1h:   d.dirs1h ? d.dirs1h.slice(0, n1h) : null,
    ensTemp1h:  slicePercentilesFrom(d.ensTemp1h,  0, n1h), ensWind1h:  slicePercentilesFrom(d.ensWind1h,  0, n1h),
    ensGust1h:  slicePercentilesFrom(d.ensGust1h,  0, n1h), ensPrecip1h: slicePercentilesFrom(d.ensPrecip1h, 0, n1h),
    otherModelsWind1h: d.otherModelsWind1h
      ? d.otherModelsWind1h.map(m => ({ model: m.model, winds1h: m.winds1h.slice(0, n1h) }))
      : null,
  };

  let colW, displayData;
  if (portrait) {
    colW = PORTRAIT_COL_W;
    displayData = buildPortraitSeries(s);
  } else {
    // Landscape: 7 days fills the viewport; days 8–16 are accessible by scrolling.
    // Compute colW from the canvas wrap width (excludes y-axis columns).
    const wrap = document.querySelector ? document.querySelector('.chart-canvas-wrap') : null;
    const viewW = (wrap && wrap.clientWidth > 0) ? wrap.clientWidth : (window.innerWidth || 800);
    colW = viewW / (7 * 24 / STEP);
    displayData = buildLandscapeSeries(s, colW);
  }

  renderAll(displayData, invertedColors, colW);
  lastRenderedData = displayData;
  // Scroll to current time on initial load.
  // Portrait: center "now" in the viewport. Landscape: left-align at "now" so 7 days ahead fills the screen.
  if (scrollToNow && displayData.xMap1h) {
    requestAnimationFrame(() => {
      const nowMs = Date.now();
      const idx = displayData.times1h.findIndex(t => new Date(t).getTime() >= nowMs);
      const xNow = idx >= 0 ? displayData.xMap1h[idx] : displayData.xMap1h[displayData.xMap1h.length - 1];
      const wraps = document.querySelectorAll ? document.querySelectorAll('.chart-canvas-wrap') : [];
      const visW = wraps[0] ? wraps[0].clientWidth : 0;
      const target = portrait ? Math.max(0, xNow - visW / 2) : Math.max(0, xNow);
      wraps.forEach(w => { w.scrollLeft = target; });
    });
  }
  if (invertedColors) {
    ['c-top', 'c-temp', 'c-dir', 'c-wind'].forEach(id => {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const ctx2d = canvas.getContext('2d');
      const img   = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      const px    = img.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i]   = 255 - px[i];
        px[i+1] = 255 - px[i+1];
        px[i+2] = 255 - px[i+2];
      }
      ctx2d.putImageData(img, 0, 0);
    });
  }
}

// Crosshair, tooltip and scroll sync moved to tooltip.js

function getModel() { return document.getElementById('model-select').value; }
/* ══════════════════════════════════════════════════
   SHORE STATUS UI
══════════════════════════════════════════════════ */
function updateShoreStatusUI() {
  const el = document.getElementById('shore-status');
  const modalEl = document.getElementById('shore-modal-status');
  const s = window.SHORE_STATUS || { state: 'idle', msg: '' };

  let text = '', color = '#778';
  if (s.state === 'loading') {
    text = '🌊 Fetching coastline…';
  } else if (s.state === 'calculating') {
    text = '🌊 Calculating sea bearings…';
  } else if (s.state === 'ok') {
    const seaCount = window.SHORE_MASK
      ? Array.from(window.SHORE_MASK).filter(v => v >= SHORE_SEA_THRESH).length : 0;
    text  = `🌊 ${seaCount} sea bearings`;
    color = seaCount > 0 ? '#00c890' : '#aa8844';
  } else if (s.state === 'inland') {    text  = '🏔 Inland (no coast)';
    color = '#aa8844';
  } else if (s.state === 'error') {
    text  = '🌊 Shore: unavailable';
    color = '#a77';
  }

  if (el) { el.textContent = text; el.style.color = color; }
  if (modalEl) {
    // Show richer message in modal: include the SHORE_STATUS.msg if present
    const extra = s.msg ? ` — ${s.msg}` : '';
    modalEl.textContent = text + extra;
    modalEl.style.color = color;
  }
  renderShoreDebug();
}

/* ══════════════════════════════════════════════════
   DMI OBSERVATION STATUS UI
══════════════════════════════════════════════════ */
function updateDmiObsStatusUI() {
  const el = document.getElementById('dmi-obs-status');
  if (!el) return;
  const s = window.DMI_OBS_STATUS || { state: 'idle', msg: '' };
  let text = '', color = '#778';
  if (s.state === 'loading') {
    text  = `📡 DMI: ${s.msg || 'loading…'}`;
    color = '#778';
  } else if (s.state === 'ok') {
    // msg = "StationName · N km" — prefix makes it clear this is the basis for the wind obs dots
    text  = `📡 Obs: ${s.msg}`;
    color = '#5a9';
  } else if (s.state === 'no-station') {
    text  = '📡 DMI: no station nearby';
    color = '#aa8844';
  } else if (s.state === 'error') {
    text  = `📡 DMI: ${s.msg}`;
    color = '#a77';
  }
  // 'idle' and 'not-dk' show nothing
  el.textContent = text;
  el.style.color  = color;
}
window.updateDmiObsStatusUI = updateDmiObsStatusUI;

/* ══════════════════════════════════════════════════
   NEAREST STATION LOOKUP
   Find the closest station in OBS_HISTORY to the given
   lat/lon, populate window.DMI_OBS, and re-render.
══════════════════════════════════════════════════ */
function _setObsStationHeader(name) {
  const el = document.getElementById('obs-station-name');
  if (!el) return;
  if (name) {
    el.textContent = `📡 ${name}`;
    el.style.display = '';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

async function loadNearestObsStation(lat, lon, opts = {}) {
  lastObsCoords = { lat, lon };
  window.DMI_OBS_STATUS = { state: 'loading', msg: 'loading…' };
  // Clear stale station highlight and header immediately so the old info
  // doesn't linger while the new lookup is in-flight.
  _setObsStationHeader(null);
  if (window.highlightNearestStation) window.highlightNearestStation(null, null);
  updateDmiObsStatusUI();
  try {
    let obsHistory = (opts.useCache && window.OBS_HISTORY) ? window.OBS_HISTORY : null;
    if (!obsHistory) {
      const fetchFn = window.fetchObsHistory;
      if (fetchFn) {
        obsHistory = await fetchFn();
      } else {
        const url = window.OBS_HISTORY_URL;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('gzip');
          const text = await new Response(r.body.pipeThrough(ds)).text();
          obsHistory = JSON.parse(text);
        } else {
          obsHistory = await r.json();
        }
        window.OBS_HISTORY = obsHistory;
      }
    }
    if (!obsHistory) throw new Error('obs-history unavailable');

    let stationNames = window.STATION_NAMES;
    if (!stationNames) {
      try {
        const fetchFn = window.fetchStationNames;
        stationNames = fetchFn ? await fetchFn() : {};
      } catch (_) {
        stationNames = {};
      }
      window.STATION_NAMES = stationNames;
    }

    // Haversine distance in km
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    function haversine(lat1, lon1, lat2, lon2) {
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    }

    const vis = window.getObsLayerVisibility
      ? window.getObsLayerVisibility()
      : { dmi: true, trafikkort: true };

    let bestKey = null, bestStation = null, bestDist = Infinity;
    let bestTrafikStation = null, bestTrafikDist = Infinity;
    for (const [key, station] of Object.entries(obsHistory)) {
      if (!station.obs || !station.obs.length) continue;
      if (station.lat == null || station.lon == null) continue;
      const isDmi = key.startsWith('ninjo:');
      if (isDmi && !vis.dmi) continue;
      if (!isDmi && !vis.trafikkort) continue;
      const dist = haversine(lat, lon, station.lat, station.lon);
      if (dist < bestDist) { bestDist = dist; bestKey = key; bestStation = station; }
      if (!isDmi && dist < bestTrafikDist) { bestTrafikDist = dist; bestTrafikStation = station; }
    }

    window.TRAFIK_OBS = (bestTrafikStation && bestTrafikDist <= 100) ? bestTrafikStation.obs : null;

    if (!bestStation || bestDist > 100) {
      window.DMI_OBS        = null;
      window.DMI_OBS_STATUS = { state: 'no-station', msg: '' };
      if (window.highlightNearestStation) window.highlightNearestStation(null, null);
      _setObsStationHeader(null);
    } else {
      const name = stationNames[bestKey] ?? bestStation.name ?? bestKey;
      window.DMI_OBS = {
        obs:         bestStation.obs,
        stationName: name,
        distKm:      bestDist.toFixed(1),
      };
      window.DMI_OBS_STATUS = {
        state: 'ok',
        msg: `${name} · ${bestDist.toFixed(1)} km`,
      };
      if (window.highlightNearestStation) window.highlightNearestStation(bestStation.lat, bestStation.lon);
      _setObsStationHeader(name);
    }
  } catch (e) {
    window.DMI_OBS        = null;
    window.TRAFIK_OBS     = null;
    window.DMI_OBS_STATUS = { state: 'error', msg: e.message || 'failed' };
    if (window.highlightNearestStation) window.highlightNearestStation(null, null);
    _setObsStationHeader(null);
  }
  updateDmiObsStatusUI();
  if (lastData) renderDisplay(lastData);
}

// Shore debug panel moved to shore-debug.js

/* ══════════════════════════════════════════════════
   KITE CONFIG DIALOG
══════════════════════════════════════════════════ */
(function () {
  const overlay          = document.getElementById('kite-modal-overlay');
  const minInput         = document.getElementById('kite-min-input');
  const maxInput         = document.getElementById('kite-max-input');
  const daylightInput    = document.getElementById('kite-at-night-input');
  const seaThreshSlider  = document.getElementById('kite-sea-thresh-input');
  const seaThreshLabel   = document.getElementById('kite-sea-thresh-label');
  const applyBtn         = document.getElementById('kite-modal-apply');
  const cancelBtn        = document.getElementById('kite-modal-cancel');
  const resetBtn         = document.getElementById('kite-modal-reset');
  const cfgBtn           = document.getElementById('kite-cfg-btn');
  const shoreFetchBtn    = document.getElementById('kite-shore-fetch-btn');

  // ── Active bearings state ─────────────────────────────────────────────
  let activeBearings = [];   // array of snapped 10° bearings (numbers)

  // ── Shore compass draw ───────────────────────────────────────────────
  function drawModalCompass() {
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas || !window.drawShoreCompass) return;
    const SIZE = canvas.clientWidth || 210;
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width  = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);

    let windDeg = null, windGood = false;
    if (lastData && lastData.dirs && lastData.dirs.length) {
      const now = Date.now();
      const idx = lastData.times.findIndex(t => new Date(t).getTime() >= now);
      const i   = idx >= 0 ? idx : 0;
      windDeg   = lastData.dirs[i];
      windGood  = lastData.winds && isKiteOptimal(lastData.winds[i], windDeg, lastData.times[i]);
    }

    window.drawShoreCompass(ctx, SIZE / 2, SIZE / 2, SIZE / 2 - 2,
      window.SHORE_MASK, windDeg, windGood, activeBearings,
      seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : null);
  }

  // ── Drag-to-select on the compass canvas ─────────────────────────────
  let dragMode      = null;   // 'add' | 'remove' | null
  let lastDragSlot  = null;   // last bearing slot touched during drag

  function bearingFromPointer(canvas, clientX, clientY) {
    const rect   = canvas.getBoundingClientRect();
    const x      = clientX - rect.left;
    const y      = clientY - rect.top;
    const cx     = rect.width  / 2;
    const cy     = rect.height / 2;
    const dx     = x - cx;
    const dy     = y - cy;
    const dist   = Math.sqrt(dx * dx + dy * dy);
    const innerR = (rect.width / 2) * 0.28;
    if (dist < innerR || dist > rect.width / 2) return null;
    const angle  = Math.atan2(dy, dx) * 180 / Math.PI;  // -180..180, 0=East
    return snapBearing((angle + 90 + 360) % 360);        // 0=North
  }

  function applyDrag(bearing) {
    if (bearing === null || bearing === lastDragSlot) return;
    lastDragSlot = bearing;
    if (dragMode === 'add' && !activeBearings.includes(bearing)) {
      activeBearings.push(bearing);
      drawModalCompass();
    } else if (dragMode === 'remove' && activeBearings.includes(bearing)) {
      activeBearings = activeBearings.filter(b => b !== bearing);
      drawModalCompass();
    }
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // left-button only
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const bearing = bearingFromPointer(canvas, clientX, clientY);
    if (bearing === null) return;
    dragMode     = activeBearings.includes(bearing) ? 'remove' : 'add';
    lastDragSlot = null;
    applyDrag(bearing);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragMode) return;
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    applyDrag(bearingFromPointer(canvas, clientX, clientY));
    e.preventDefault();
  }

  function onPointerUp() { dragMode = null; lastDragSlot = null; }

  const canvas = document.getElementById('shore-compass-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown',  onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('mousemove',  onPointerMove);
    window.addEventListener('touchmove',  onPointerMove, { passive: false });
    window.addEventListener('mouseup',    onPointerUp);
    window.addEventListener('touchend',   onPointerUp);
  }

  // ── Sea-threshold slider: live label, bearing re-select + compass preview ──
  if (seaThreshSlider) {
    seaThreshSlider.addEventListener('input', () => {
      if (seaThreshLabel) seaThreshLabel.textContent = seaThreshSlider.value + '%';
      const thresh = parseInt(seaThreshSlider.value) / 100;
      if (window.setShoreSeaThresh) window.setShoreSeaThresh(thresh);
      if (window.SHORE_MASK) {
        activeBearings = [];
        for (let b = 0; b < SHORE_BEARINGS; b++) {
          if (window.SHORE_MASK[b] >= thresh) activeBearings.push(b * 10);
        }
      }
      drawModalCompass();
      updateShoreStatusUI();
    });
  }

  // ── Sync dialog ↔ config ─────────────────────────────────────────────
  function syncDialogToConfig(cfg) {
    minInput.value        = cfg.min;
    maxInput.value        = cfg.max;
    daylightInput.checked = !cfg.daylight;
    activeBearings        = cfg.dirs.slice();
    const pct = Math.round((cfg.seaThresh ?? KITE_DEFAULTS.seaThresh) * 100);
    if (seaThreshSlider) seaThreshSlider.value = pct;
    if (seaThreshLabel)  seaThreshLabel.textContent = pct + '%';
  }
  function readDialogConfig() {
    const parsedMin = parseFloat(minInput.value);
    const parsedMax = parseFloat(maxInput.value);
    return {
      min:       isNaN(parsedMin) ? KITE_DEFAULTS.min : parsedMin,
      max:       isNaN(parsedMax) ? KITE_DEFAULTS.max : parsedMax,
      dirs:      activeBearings.length ? activeBearings.slice() : KITE_DEFAULTS.dirs,
      daylight:  !daylightInput.checked,
      seaThresh: seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : KITE_DEFAULTS.seaThresh,
    };
  }

  window.refreshShoreCompassInModal = function() {
    if (overlay.classList.contains('open')) drawModalCompass();
    updateShoreStatusUI();
  };

  cfgBtn.addEventListener('click', () => {
    syncDialogToConfig(KITE_CFG);
    overlay.classList.add('open');
    // Ensure raster + vector data is fetched (or retried if a previous attempt failed).
    // Both functions deduplicate in-flight requests, so duplicate calls are free.
    if (lastShoreCoords) {
      if (window.fetchShoreVector) window.fetchShoreVector(lastShoreCoords.lat, lastShoreCoords.lon).catch(() => null);
      if (window.analyseShore)     window.analyseShore(lastShoreCoords.lat, lastShoreCoords.lon).catch(() => null);
    }
    requestAnimationFrame(() => { drawModalCompass(); updateShoreStatusUI(); renderShoreDebug(); });
  });
  cancelBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  resetBtn.addEventListener('click', () => { syncDialogToConfig(KITE_DEFAULTS); drawModalCompass(); });
  applyBtn.addEventListener('click', () => {
    const cfg = readDialogConfig();
    window.setShoreSeaThresh(cfg.seaThresh);   // commit threshold before re-render
    setKiteParams(cfg);
    overlay.classList.remove('open');
    if (lastData) renderDisplay(lastData);
  });

  // Re-render debug panel and compass when the Overpass vector fetch completes.
  // Use requestAnimationFrame so the canvas draw happens after any pending layout
  // (e.g. the modal becoming display:flex) has been committed by the browser.
  window.addEventListener('shore-vector-ready', () => {
    renderShoreDebug();
    requestAnimationFrame(() => drawModalCompass());
  });

  // Update status and compass when the raster analysis (SHORE_MASK) completes.
  // Also auto-populate activeBearings if they haven't been set yet for this load.
  window.addEventListener('shore-mask-ready', () => {
    if (window.SHORE_MASK && activeBearings.length === 0) {
      const thresh = seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : SHORE_SEA_THRESH;
      for (let b = 0; b < SHORE_BEARINGS; b++) {
        if (window.SHORE_MASK[b] >= thresh) activeBearings.push(b * 10);
      }
    }
    updateShoreStatusUI();
    requestAnimationFrame(() => drawModalCompass());
  });

  shoreFetchBtn.addEventListener('click', () => {    if (!lastShoreCoords) {
      const el = document.getElementById('shore-modal-status');
      if (el) { el.textContent = '⚠ Load a city first'; el.style.color = '#aa8844'; }
      return;
    }
    shoreFetchBtn.disabled    = true;
    shoreFetchBtn.textContent = '⏳ Fetching…';
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline data…' };
    updateShoreStatusUI();
    drawModalCompass();
    window.analyseShore(lastShoreCoords.lat, lastShoreCoords.lon, () => {
      // Auto-select all sea bearings, deselect all land bearings
      if (window.SHORE_MASK) {
        const fetchThresh = seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : SHORE_SEA_THRESH;
        activeBearings = [];
        for (let b = 0; b < SHORE_BEARINGS; b++) {
          if (window.SHORE_MASK[b] >= fetchThresh) {
            activeBearings.push(b * 10);
          }
        }
      }
      updateShoreStatusUI();
      drawModalCompass();
      if (lastData) renderDisplay(lastData);
      shoreFetchBtn.disabled    = false;
      shoreFetchBtn.textContent = '🌊 Auto-detect sea bearings';
    });
  });
})();
/* ══════════════════════════════════════════════════
   URL ↔ SEARCH-BAR SYNCHRONISATION
══════════════════════════════════════════════════ */
function getQParam() {
  return new URLSearchParams(window.location.search).get('q') || '';
}
function setQParam(city) {
  const url = new URL(window.location.href);
  if (city) { url.searchParams.set('q', city); } else { url.searchParams.delete('q'); }
  window.history.replaceState(null, '', url.toString());
}
function setLoadingMsg(msg) {
  const el = document.getElementById('loading');
  if (el) el.textContent = msg;
}

/**
 * Load weather for exact coordinates without geocoding and without
 * resetting the radar map (used when the user drags the radar pin).
 */
async function loadAtCoords(lat, lon, model, displayNameOverride) {
  model = model || getModel();

  // Snap to nearby kite spot (within 2 km)
  const nearbySpot = findNearbyKiteSpot(lat, lon);
  if (nearbySpot) {
    lat = nearbySpot.lat;
    lon = nearbySpot.lon;
    displayNameOverride = displayNameOverride || nearbySpot.name;
    setKiteParams({ ...KITE_CFG, dirs: nearbySpot.dirs });
    if (window.moveRadarPin) window.moveRadarPin(lat, lon);
    if (window.showKiteSpotBearingOverlay) window.showKiteSpotBearingOverlay(lat, lon, nearbySpot.dirs);
  } else {
    if (window.hideKiteSpotBearingOverlay) window.hideKiteSpotBearingOverlay();
  }

  const forecastEl = document.getElementById('forecast-content');
  const isReload = lastData !== null;
  if (isReload) {
    forecastEl.classList.add('updating');
  } else {
    document.getElementById('loading').style.display = 'block';
    forecastEl.style.display = 'none';
  }
  document.getElementById('error-msg').style.display = 'none';
  try {
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline…' };
    // Coords are already known — start the Overpass fetch immediately so it
    // runs in parallel with the reverse-geocode and weather requests.
    lastShoreCoords = { lat, lon };
    if (window.fetchShoreVector) window.fetchShoreVector(lat, lon).catch(() => null);
    if (window.analyseShore)     window.analyseShore(lat, lon).catch(() => null);

    // Persist coords before any awaits: both a page reload and an iOS Home
    // Screen launch (which always opens the manifest start_url without query
    // params) must be able to restore the exact position from localStorage.
    const coordStr = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    setQParam(coordStr);
    try { localStorage.setItem('vejr_city', coordStr); } catch(_) {}

    // Reverse-geocode for a human-readable name (best-effort); skip if override provided
    let displayName = displayNameOverride || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    let reverseCountryCode = null;
    if (!displayNameOverride) {
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
          { headers: { 'Accept-Language': 'en' } }
        );
        if (r.ok) {
          const d = await r.json();
          displayName = d.address?.city || d.address?.town || d.address?.village
                        || d.display_name.split(',')[0];
          reverseCountryCode = (d.address?.country_code || '').toUpperCase() || null;
        }
      } catch(_) { /* keep coord string */ }
    }

    document.getElementById('city-input').value = displayName;

    const iconCodeFetch = (model === 'dmi_seamless')
      ? fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=weathercode&forecast_days=${FORECAST_DAYS}&timezone=auto&models=icon_seamless`)
          .then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);
    const [data, ensData, iconData] = await Promise.all([
      fetchWeather(lat, lon, model),
      fetchEnsemble(lat, lon, model).catch(() => null),
      iconCodeFetch,
    ]);
    const H = data.hourly;
    const iconCodes = iconData?.hourly?.weathercode || null;
    sunTimes = {};
    if (data.daily?.sunrise && data.daily?.sunset) {
      data.daily.sunrise.forEach((riseStr, i) => {
        const key     = riseStr.slice(0, 10);
        const sunrise = parseFloat(riseStr.slice(11,13)) + parseFloat(riseStr.slice(14,16)) / 60;
        const setStr  = data.daily.sunset[i];
        const sunset  = parseFloat(setStr.slice(11,13))  + parseFloat(setStr.slice(14,16))  / 60;
        sunTimes[key] = { sunrise, sunset };
      });
    }
    const times=[],temps=[],precips=[],gusts=[],winds=[],dirs=[],codes=[];
    const times1h=[],temps1h=[],precips1h=[],gusts1h=[],winds1h=[],codes1h=[],dirs1h=[];
    const totalH = FORECAST_DAYS * 24;
    for (let i = 0; i < Math.min(totalH, H.time.length); i += STEP) {
      times.push(H.time[i]);
      temps.push(H.temperature_2m[i]);
      precips.push(H.precipitation[i] ?? 0);
      winds.push(H.windspeed_10m[i]);
      const rawGust = H.windgusts_10m[i];
      gusts.push(rawGust != null ? rawGust : H.windspeed_10m[i]);
      dirs.push(H.winddirection_10m[i]);
      const dmiCode  = H.weathercode[i];
      const iconCode = iconCodes ? (iconCodes[i] ?? dmiCode) : dmiCode;
      const code = (iconCodes && dmiCode >= 80 && dmiCode <= 82 && iconCode >= 95)
                   ? iconCode : dmiCode;
      codes.push(code);
    }
    for (let i = 0; i < Math.min(totalH, H.time.length); i += STEP1H) {
      times1h.push(H.time[i]);
      temps1h.push(H.temperature_2m[i]);
      precips1h.push(H.precipitation[i] ?? 0);
      winds1h.push(H.windspeed_10m[i]);
      const rawGust1h = H.windgusts_10m[i];
      gusts1h.push(rawGust1h != null ? rawGust1h : H.windspeed_10m[i]);
      // Weather codes at 1h resolution (portrait mode shows finest available icons)
      const dmiCode1h  = H.weathercode[i];
      const iconCode1h = iconCodes ? (iconCodes[i] ?? dmiCode1h) : dmiCode1h;
      codes1h.push((iconCodes && dmiCode1h >= 80 && dmiCode1h <= 82 && iconCode1h >= 95)
        ? iconCode1h : dmiCode1h);
      dirs1h.push(H.winddirection_10m[i]);
    }
    const MODEL_LABEL = {
      'best_match':          'Auto',      'dmi_seamless':        'DMI HARMONIE',
      'icon_seamless':       'DWD ICON',  'ecmwf_ifs025':        'ECMWF IFS',
      'meteofrance_seamless':'Météo-France', 'gfs_seamless':     'NOAA GFS',
    };
    const ENS_LABEL = {
      'best_match':'ICON-EPS', 'dmi_seamless':'ICON-EPS', 'icon_seamless':'ICON-EPS',
      'ecmwf_ifs025':'IFS-EPS', 'meteofrance_seamless':'ICON-EPS', 'gfs_seamless':'GFS-EPS',
    };
    const modelLabel = MODEL_LABEL[model] || model;
    const ensLabel   = ENS_LABEL[model]   || 'ensemble';
    let ensTemp=null,ensWind=null,ensGust=null,ensPrecip=null;
    let ensTemp1h=null,ensWind1h=null,ensGust1h=null,ensPrecip1h=null;
    const ensStatus = document.getElementById('ens-status');
    if (ensData && ensData.hourly) {
      ensTemp    = ensemblePercentiles(ensData.hourly, 'temperature_2m');
      ensWind    = ensemblePercentiles(ensData.hourly, 'windspeed_10m');
      ensGust    = ensemblePercentiles(ensData.hourly, 'windgusts_10m');
      ensPrecip  = ensemblePercentiles(ensData.hourly, 'precipitation');
      ensTemp1h  = ensemblePercentiles(ensData.hourly, 'temperature_2m',  STEP1H);
      ensWind1h  = ensemblePercentiles(ensData.hourly, 'windspeed_10m',   STEP1H);
      ensGust1h  = ensemblePercentiles(ensData.hourly, 'windgusts_10m',   STEP1H);
      ensPrecip1h= ensemblePercentiles(ensData.hourly, 'precipitation',   STEP1H);
      const detGusts   = gusts.slice();
      const detGusts1h = gusts1h.slice();
      if (ensTemp)    for (let i=0;i<temps.length;  i++) { if (ensTemp.p50[i]   !=null) temps[i]  =ensTemp.p50[i];   }
      if (ensWind)    for (let i=0;i<winds.length;  i++) { if (ensWind.p50[i]   !=null) winds[i]  =ensWind.p50[i];   }
      if (ensPrecip)  for (let i=0;i<precips.length;i++) { if (ensPrecip.p50[i] !=null) precips[i]=ensPrecip.p50[i]; }
      if (ensTemp1h)  for (let i=0;i<temps1h.length;  i++) { if (ensTemp1h.p50[i]  !=null) temps1h[i]  =ensTemp1h.p50[i];   }
      if (ensWind1h)  for (let i=0;i<winds1h.length;  i++) { if (ensWind1h.p50[i]  !=null) winds1h[i]  =ensWind1h.p50[i];   }
      if (ensPrecip1h)for (let i=0;i<precips1h.length;i++) { if (ensPrecip1h.p50[i]!=null) precips1h[i]=ensPrecip1h.p50[i]; }
      for (let i=0;i<gusts.length;  i++) gusts[i]  =Math.max(detGusts[i],   winds[i]);
      for (let i=0;i<gusts1h.length;i++) gusts1h[i]=Math.max(detGusts1h[i], winds1h[i]);
      const memberCount = Object.keys(ensData.hourly).filter(k=>k.startsWith('temperature_2m_member')).length;
      ensStatus.textContent = `${modelLabel} + ${ensLabel} (${memberCount} mdl) ✓`;
      ensStatus.style.color = '#5a9';
    } else {
      ensStatus.textContent = `${modelLabel} — ensemble not available`;
      ensStatus.style.color = '#a77';
    }
    document.getElementById('city-name').textContent = displayName;
    document.getElementById('loading').style.display = 'none';
    forecastEl.style.display = 'block';
    forecastEl.classList.remove('updating');
    const isFirstLoad = !isReload;
    lastData = {
      times, temps, precips, gusts, winds, dirs, codes,
      ensTemp, ensWind, ensGust, ensPrecip,
      times1h, temps1h, precips1h, gusts1h, winds1h, codes1h, dirs1h,
      ensTemp1h, ensWind1h, ensGust1h, ensPrecip1h,
      otherModelsWind1h: null,
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      renderDisplay(lastData, isFirstLoad);
      // Background fetch of other-model wind lines; re-render on arrival.
      const capturedData = lastData;
      fetchOtherModelsWind(lat, lon, model)
        .then(otherModels => {
          if (lastData !== capturedData || !otherModels.length) return;
          lastData.otherModelsWind1h = otherModels;
          renderDisplay(lastData);
        })
        .catch(() => null);
    }));
    // Call loadRadar only when the section is not yet visible (i.e. on a fresh
    // page load restored from a dragged-pin URL).  When called from a live drag
    // the radar is already initialised and correctly positioned, so skip it.
    if (window.loadRadar) {
      const radarSection = document.getElementById('radar-section');
      if (!radarSection || radarSection.style.display !== 'flex') {
        window.loadRadar(lat, lon);
      }
    }
    updateShoreStatusUI();
    loadNearestObsStation(lat, lon).catch(() => null);
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display = 'none';
    forecastEl.classList.remove('updating');
    document.getElementById('error-msg').style.display = 'block';
  }
}

async function loadByCoords(lat, lon, model) {
  model = model || getModel();
  setLoadingMsg('Fetching your location…');
  document.getElementById('loading').style.display         = 'block';
  document.getElementById('forecast-content').style.display = 'none';
  document.getElementById('error-msg').style.display       = 'none';
  let displayName = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { 'Accept-Language': 'en' } }
    );
    if (r.ok) {
      const d = await r.json();
      displayName = d.address?.city || d.address?.town || d.address?.village
                    || d.display_name.split(',')[0];
    }
  } catch(e) { /* keep coordinate fallback */ }
  document.getElementById('city-input').value = displayName;
  // Persist coords (not the display name) so an iOS Home Screen launch restores
  // the exact GPS-detected position instead of re-geocoding a city name.
  const coordStr = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  setQParam(coordStr);
  try { localStorage.setItem('vejr_city', coordStr); } catch(_) {}
  await load(displayName, model);
}
// On the first load where the user has no saved kite config (KITE_CFG._fromDefaults),
// auto-apply sea bearings derived from the shore mask.  Must be called before the
// location load so the listener is registered before analyseShore fires.
function autoDetectSeaBearingsOnce() {
  if (!KITE_CFG._fromDefaults) return;
  function apply() {
    if (!window.SHORE_MASK) return;
    const dirs = [];
    for (let b = 0; b < SHORE_BEARINGS; b++) {
      if (window.SHORE_MASK[b] >= SHORE_SEA_THRESH) dirs.push(b * 10);
    }
    if (dirs.length === 0) return;
    setKiteParams({ ...KITE_CFG, dirs, _fromDefaults: false });
    if (lastData) renderDisplay(lastData);
  }
  if (window.SHORE_MASK) { apply(); return; }
  function onMaskReady() {
    window.removeEventListener('shore-mask-ready', onMaskReady);
    apply();
  }
  window.addEventListener('shore-mask-ready', onMaskReady);
}
async function tryGeolocation(model) {
  if (!navigator.geolocation) { await loadAtCoords(54.941360, 11.999631, model); return; }
  setLoadingMsg('Finding your location…');
  document.getElementById('loading').style.display         = 'block';
  document.getElementById('forecast-content').style.display = 'none';
  document.getElementById('error-msg').style.display       = 'none';
  navigator.geolocation.getCurrentPosition(
    pos => loadByCoords(pos.coords.latitude, pos.coords.longitude, model),
    _err => loadAtCoords(54.941360, 11.999631, model),
    { timeout: 8000, maximumAge: 300000 }
  );
}
async function loadAndSync(city, model) {
  setQParam(city);
  localStorage.setItem('vejr_city', city);
  await load(city, model);
}
function openCitySearch() {
  document.getElementById('header-left').classList.add('search-open');
  const input = document.getElementById('city-input');
  const cityNameText = document.getElementById('city-name').textContent;
  if (cityNameText && cityNameText !== '—') input.value = cityNameText;
  if (input.focus)  input.focus();
  if (input.select) input.select();
}
function closeCitySearch() {
  document.getElementById('header-left').classList.remove('search-open');
}
document.getElementById('search-toggle-btn').addEventListener('click', openCitySearch);
document.getElementById('city-name-wrap').addEventListener('click', openCitySearch);
document.getElementById('city-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v) { closeCitySearch(); loadAndSync(v, getModel()); }
  } else if (e.key === 'Escape') {
    closeCitySearch();
  }
});
/* #model-select is a transparent CSS overlay covering #model-dropdown;
   clicks on #ens-status naturally hit the select, which opens natively. */
document.getElementById('model-select').addEventListener('change', () => {
  const city = document.getElementById('city-input').value.trim()
            || localStorage.getItem('vejr_city') || '';
  if (city) loadAndSync(city, getModel());
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastData) renderDisplay(lastData); }, 100);
});
window.matchMedia('(inverted-colors: inverted)').addEventListener('change', () => {
  syncInvertedColorsClass();
  if (lastData) renderDisplay(lastData);
});
// ── Radar pin drag → update location ────────────────────────────────────
if (window.setRadarDragCallback) {
  window.setRadarDragCallback((lat, lon) => {
    loadAtCoords(lat, lon, getModel());
  });
}
if (window.setObsToggleCallback) {
  window.setObsToggleCallback(() => {
    if (lastObsCoords) loadNearestObsStation(lastObsCoords.lat, lastObsCoords.lon).catch(() => null);
  });
}

// ── Kite spot callbacks ───────────────────────────────────────────────────
if (window.setCreateKiteSpotCallback) {
  window.setCreateKiteSpotCallback((lat, lon) => {
    if (window.openKiteSpotDialog) window.openKiteSpotDialog(lat, lon);
  });
}
if (window.setKiteSpotClickCallback) {
  window.setKiteSpotClickCallback(spotId => {
    const spot = getAllKiteSpots().find(s => s.id === spotId);
    if (!spot) return;
    setKiteParams({ ...KITE_CFG, dirs: spot.dirs });
    loadAtCoords(spot.lat, spot.lon, getModel(), spot.name);
  });
}
window._onDeleteKiteSpot = id => deleteKiteSpot(id);

// Load curated spots then seed map markers (fire-and-forget; location loading
// is independent and does not need to wait for this)
fetchCuratedKiteSpots().then(() => {
  if (window.refreshKiteSpotMarkers) window.refreshKiteSpotMarkers(getAllKiteSpots());
});

// Forward forecast hover events to the radar bearing overlay
window.onForecastHover = (windDeg, isOptimal) => {
  if (window.updateKiteSpotBearingHover) window.updateKiteSpotBearingHover(windDeg, isOptimal);
};

// ── Initial load ──────────────────────────────────────────────────────────
// Pure decision function: given the three possible location sources, returns
// which one to use.  Tested directly in tests/app.test.js.
function decideInitialLocation(qParam, typedInput, savedCity) {
  if (qParam)     return { type: 'qparam', value: qParam };
  if (typedInput) return { type: 'typed',  value: typedInput };
  if (savedCity)  return { type: 'saved',  value: savedCity };
  return            { type: 'geolocation' };
}

(function initialLoad() {
  syncInvertedColorsClass();  // apply before data loads so button is correct immediately
  const model    = getModel();
  const qParam   = getQParam();
  const typed    = document.getElementById('city-input').value.trim();
  const saved    = localStorage.getItem('vejr_city');
  const decision = decideInitialLocation(qParam, typed, saved);
  // Register auto-detection before any location load fires, regardless of which
  // path is taken below (qparam, saved, geolocation, typed).
  autoDetectSeaBearingsOnce();

  if (decision.type === 'qparam') {
    // If q looks like "lat,lon" (stored when the user dragged the pin), restore
    // the exact coordinates without going through geocoding.
    const coordMatch = decision.value.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      loadAtCoords(parseFloat(coordMatch[1]), parseFloat(coordMatch[2]), model);
    } else {
      document.getElementById('city-input').value = decision.value;
      load(decision.value, model);
    }
  } else if (decision.type === 'geolocation') {
    tryGeolocation(model);
  } else {
    // saved or typed — if the stored value is a "lat,lon" coord string (written
    // by loadAtCoords / loadByCoords to survive iOS Home Screen launches), restore
    // the exact coordinates instead of sending them through geocoding.
    const coordMatch = decision.value.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      loadAtCoords(parseFloat(coordMatch[1]), parseFloat(coordMatch[2]), model);
    } else {
      document.getElementById('city-input').value = decision.value;
      setQParam(decision.value);
      load(decision.value, model);
    }
  }
})();
/* ══════════════════════════════════════════════════
   KITE SPOT CREATION DIALOG
══════════════════════════════════════════════════ */
(function () {
  const overlay    = document.getElementById('kite-spot-modal-overlay');
  const applyBtn   = document.getElementById('kite-spot-apply');
  const cancelBtn  = document.getElementById('kite-spot-cancel');
  const nameInput  = document.getElementById('kite-spot-name-input');
  const statusEl   = document.getElementById('kite-spot-status');
  if (!overlay) return;

  let pendingLat   = null;
  let pendingLon   = null;
  let spotBearings = [];    // currently selected bearings
  let spotMask     = null;  // Float32Array[36] from analyseShore for this spot
  let spotDragMode = null;  // 'add' | 'remove'
  let spotLastSlot = null;

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }

  function getCanvas() { return document.getElementById('kite-spot-compass-canvas'); }

  function drawSpotCompass() {
    const canvas = getCanvas();
    if (!canvas || !window.drawShoreCompass) return;
    const SIZE = canvas.clientWidth || 210;
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width  = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);
    window.drawShoreCompass(ctx, SIZE / 2, SIZE / 2, SIZE / 2 - 2,
      spotMask, null, false, spotBearings, KITE_CFG.seaThresh);
  }

  function bearingFromPointer(canvas, clientX, clientY) {
    const rect   = canvas.getBoundingClientRect();
    const dx     = clientX - rect.left - rect.width  / 2;
    const dy     = clientY - rect.top  - rect.height / 2;
    const dist   = Math.sqrt(dx * dx + dy * dy);
    const innerR = (rect.width / 2) * 0.28;
    if (dist < innerR || dist > rect.width / 2) return null;
    const angle  = Math.atan2(dy, dx) * 180 / Math.PI;
    return snapBearing((angle + 90 + 360) % 360);
  }

  function applySpotDrag(bearing) {
    if (bearing === null || bearing === spotLastSlot) return;
    spotLastSlot = bearing;
    if (spotDragMode === 'add' && !spotBearings.includes(bearing)) {
      spotBearings.push(bearing);
      drawSpotCompass();
    } else if (spotDragMode === 'remove' && spotBearings.includes(bearing)) {
      spotBearings = spotBearings.filter(b => b !== bearing);
      drawSpotCompass();
    }
  }

  function onSpotPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const canvas = getCanvas();
    if (!canvas) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const bearing = bearingFromPointer(canvas, clientX, clientY);
    if (bearing === null) return;
    spotDragMode = spotBearings.includes(bearing) ? 'remove' : 'add';
    spotLastSlot = null;
    applySpotDrag(bearing);
    e.preventDefault();
  }

  function onSpotPointerMove(e) {
    if (!spotDragMode) return;
    const canvas = getCanvas();
    if (!canvas) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    applySpotDrag(bearingFromPointer(canvas, clientX, clientY));
    e.preventDefault();
  }

  function onSpotPointerUp() { spotDragMode = null; spotLastSlot = null; }

  const canvas = document.getElementById('kite-spot-compass-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown',  onSpotPointerDown);
    canvas.addEventListener('touchstart', onSpotPointerDown, { passive: false });
    window.addEventListener('mousemove',  onSpotPointerMove);
    window.addEventListener('touchmove',  onSpotPointerMove, { passive: false });
    window.addEventListener('mouseup',    onSpotPointerUp);
    window.addEventListener('touchend',   onSpotPointerUp);
  }

  cancelBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });

  applyBtn.addEventListener('click', () => {
    if (pendingLat == null) return;
    const name = nameInput.value.trim();
    const spot = {
      id:   `spot_${Date.now()}`,
      lat:  pendingLat,
      lon:  pendingLon,
      name: name || `${pendingLat.toFixed(4)}, ${pendingLon.toFixed(4)}`,
      dirs: spotBearings.slice(),
    };
    addKiteSpot(spot);
    overlay.classList.remove('open');
    // Open pre-filled GitHub issue so the spot can be proposed for inclusion
    if (window._buildKiteSpotIssueUrl) {
      const url = window._buildKiteSpotIssueUrl({ lat: spot.lat, lon: spot.lon, name: spot.name, dirs: spot.dirs });
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  });

  window.openKiteSpotDialog = function (lat, lon) {
    pendingLat   = lat;
    pendingLon   = lon;
    spotBearings = [];
    spotMask     = null;
    if (nameInput) nameInput.value = '';
    overlay.classList.add('open');
    setStatus('🌊 Detecting sea bearings…');
    requestAnimationFrame(() => drawSpotCompass());

    if (window.analyseShore) {
      window.analyseShore(lat, lon, () => {
        spotMask = window.SHORE_MASK;
        if (spotMask) {
          const thresh = KITE_CFG.seaThresh;
          spotBearings = [];
          for (let b = 0; b < SHORE_BEARINGS; b++) {
            if (spotMask[b] >= thresh) spotBearings.push(b * 10);
          }
          setStatus('');
        } else {
          setStatus('⚠ Could not detect sea bearings — select manually');
        }
        drawSpotCompass();
      }).catch(() => {
        setStatus('⚠ Could not detect sea bearings — select manually');
      });
    } else {
      setStatus('');
    }
  };
})();

/* ══════════════════════════════════════════════════
   HELP MODAL
══════════════════════════════════════════════════ */
(function () {
  const overlay  = document.getElementById('help-modal-overlay');
  const body     = document.getElementById('help-modal-body');
  const closeBtn = document.getElementById('help-modal-close');
  const openBtn  = document.getElementById('help-btn');

  function inlineFmt(s) {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function parseMd(md) {
    const lines = md.split('\n');
    let html = '';
    let inList = false;
    let buf = [];

    function flushPara() {
      const text = buf.join(' ').trim();
      if (text) html += `<p>${inlineFmt(text)}</p>\n`;
      buf = [];
    }

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.startsWith('## ')) {
        flushPara();
        if (inList) { html += '</ul>\n'; inList = false; }
        html += `<h2>${inlineFmt(line.slice(3))}</h2>\n`;
      } else if (line.startsWith('### ')) {
        flushPara();
        if (inList) { html += '</ul>\n'; inList = false; }
        html += `<h3>${inlineFmt(line.slice(4))}</h3>\n`;
      } else if (line.startsWith('- ')) {
        flushPara();
        if (!inList) { html += '<ul>\n'; inList = true; }
        html += `<li>${inlineFmt(line.slice(2))}</li>\n`;
      } else if (line === '') {
        flushPara();
        if (inList) { html += '</ul>\n'; inList = false; }
      } else {
        buf.push(line);
      }
    }
    flushPara();
    if (inList) html += '</ul>\n';
    return html;
  }

  let loaded = false;
  function open() {
    overlay.classList.add('open');
    if (!loaded) {
      const src = document.getElementById('help-md');
      body.innerHTML = src ? parseMd(src.textContent) : '<p>Help content missing.</p>';
      loaded = true;
    }
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.classList.remove('open');
  });
})();

/* ══════════════════════════════════════════════════
   CREDITS MODAL
══════════════════════════════════════════════════ */
(function () {
  const overlay  = document.getElementById('credits-modal-overlay');
  const closeBtn = document.getElementById('credits-modal-close');
  const openBtn  = document.getElementById('credits-btn');

  openBtn.addEventListener('click', () => overlay.classList.add('open'));
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.classList.remove('open');
  });
})();

// When the radar map's obs-history refresh fires, re-run nearest-station lookup
// using the freshly populated window.OBS_HISTORY (no extra network request).
window.onObsHistoryRefreshed = () => {
  if (lastObsCoords) loadNearestObsStation(lastObsCoords.lat, lastObsCoords.lon, { useCache: true }).catch(() => null);
};

// Register service worker for PWA / offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
