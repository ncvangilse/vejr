/* ══════════════════════════════════════════════════
   DMI OPEN DATA — METEOROLOGICAL OBSERVATION API
   API:   https://opendataapi.dmi.dk/v2/metObs
   Docs:  https://www.dmi.dk/friedata/dokumentation/meteorological-observation-api
   No API key required.
   Scope: Only activates for DK / GL / FO (DMI coverage area).
══════════════════════════════════════════════════ */

const DMI_OBS_BASE  = 'https://opendataapi.dmi.dk/v2/metObs';
const DMI_COUNTRIES = ['DK', 'GL', 'FO'];

/* Initialise globals so charts.js / app.js can safely read them before the
   async fetch completes. */
window.DMI_OBS        = null;
window.DMI_OBS_STATUS = { state: 'idle', msg: '' };

/* ── Haversine distance in km ── */
function _dmiHaversine(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) * Math.sin(dLat / 2)
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── Find nearest active station within ~0.5° (≈ 50 km) ──
   Returns { id, name, lat, lon, dist } or null.
   Throws 'dmi-http-NNN' on HTTP errors. */
async function _dmiFindStation(lat, lon) {
  const d    = 0.5;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url  = `${DMI_OBS_BASE}/collections/station/items?bbox=${bbox}`;
  const r    = await fetch(url);
  if (!r.ok) throw new Error(`dmi-http-${r.status}`);
  const data = await r.json();
  let best = null, bestDist = Infinity;
  for (const f of (data.features || [])) {
    // Skip inactive stations when the status field is present
    if (f.properties && f.properties.status && f.properties.status !== 'Active') continue;
    const [sLon, sLat] = f.geometry.coordinates;
    const dist = _dmiHaversine(lat, lon, sLat, sLon);
    if (dist < bestDist) {
      bestDist = dist;
      best = {
        id:   f.properties.stationId,
        name: f.properties.name || f.properties.stationId,
        lat:  sLat,
        lon:  sLon,
        dist,
      };
    }
  }
  return best;
}

/* ── Fetch observations for one parameter in a time range ──
   Returns a GeoJSON FeatureCollection. */
async function _dmiObs(stationId, paramId, fromIso, toIso) {
  const url = `${DMI_OBS_BASE}/collections/observation/items`
    + `?stationId=${encodeURIComponent(stationId)}`
    + `&parameterId=${encodeURIComponent(paramId)}`
    + `&datetime=${encodeURIComponent(fromIso + '/' + toIso)}`
    + `&limit=10000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`dmi-obs-${r.status}`);
  return r.json();
}

/* ── Merge wind-speed, wind-gust, and wind-direction feature arrays into a
   single time-sorted observation array.  Public for testing. ── */
function _dmiMergeObs(windFeatures, gustFeatures, dirFeatures) {
  const byTime = {};
  for (const f of (windFeatures || [])) {
    const t = new Date(f.properties.observed).getTime();
    byTime[t] = { t, wind: f.properties.value, gust: null, dir: null };
  }
  for (const f of (gustFeatures || [])) {
    const t = new Date(f.properties.observed).getTime();
    if (byTime[t]) byTime[t].gust = f.properties.value;
    else           byTime[t] = { t, wind: null, gust: f.properties.value, dir: null };
  }
  for (const f of (dirFeatures || [])) {
    const t = new Date(f.properties.observed).getTime();
    if (byTime[t]) byTime[t].dir = f.properties.value;
    else           byTime[t] = { t, wind: null, gust: null, dir: f.properties.value };
  }
  return Object.values(byTime).sort((a, b) => a.t - b.t);
}

/* ══════════════════════════════════════════════════
   MAIN ENTRY POINT
   Called from app.js after geocode() — fire and forget.
   Populates window.DMI_OBS and triggers a re-render when done.
══════════════════════════════════════════════════ */
async function loadDmiObservations(lat, lon, countryCode) {
  console.log('[DMI] loadDmiObservations called — lat:', lat, 'lon:', lon, 'countryCode:', countryCode);
  window.DMI_OBS        = null;
  window.DMI_OBS_STATUS = { state: 'idle', msg: '' };
  if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

  if (!DMI_COUNTRIES.includes(countryCode)) {
    console.log('[DMI] country', countryCode, 'not in DMI coverage — skipping');
    window.DMI_OBS_STATUS = { state: 'not-dk', msg: '' };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
    return;
  }

  try {
    window.DMI_OBS_STATUS = { state: 'loading', msg: 'Finding station…' };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

    const station = await _dmiFindStation(lat, lon);
    if (!station) {
      console.log('[DMI] no active station found within 0.5° of', lat, lon);
      window.DMI_OBS_STATUS = { state: 'no-station', msg: 'No station nearby' };
      if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
      return;
    }
    console.log('[DMI] nearest station:', station.name, '— id:', station.id, '— dist:', station.dist.toFixed(1), 'km');

    window.DMI_OBS_STATUS = { state: 'loading', msg: `Loading ${station.name}…` };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

    // Fetch the past 48 hours (covers the visible portion of the forecast chart)
    const now     = new Date();
    const fromMs  = now.getTime() - 48 * 3600 * 1000;
    const fromIso = new Date(fromMs).toISOString().slice(0, 19) + 'Z';
    const toIso   = now.toISOString().slice(0, 19) + 'Z';

    const [windResp, gustResp, dirResp] = await Promise.all([
      _dmiObs(station.id, 'wind_speed',             fromIso, toIso),
      _dmiObs(station.id, 'wind_gust_always_10min', fromIso, toIso).catch(() => null),
      _dmiObs(station.id, 'wind_dir',               fromIso, toIso).catch(() => null),
    ]);
    console.log('[DMI] wind_speed features:', windResp.features?.length,
                '| wind_gust features:', gustResp?.features?.length ?? 'err',
                '| wind_dir features:', dirResp?.features?.length ?? 'err');

    const obs = _dmiMergeObs(
      windResp.features,
      (gustResp && gustResp.features) || [],
      (dirResp  && dirResp.features)  || [],
    );

    window.DMI_OBS = {
      stationId:   station.id,
      stationName: station.name,
      lat:         station.lat,
      lon:         station.lon,
      distKm:      Math.round(station.dist),
      obs,
    };
    window.DMI_OBS_STATUS = {
      state: 'ok',
      msg:   `${station.name} (${Math.round(station.dist)} km, ${obs.length} obs)`,
    };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

    // Update the radar map marker for the nearest DMI station.
    console.log('[DMI] window.DMI_OBS set — stationName:', window.DMI_OBS.stationName,
      '| obs.length:', obs.length,
      '| lat:', window.DMI_OBS.lat, 'lon:', window.DMI_OBS.lon);
    console.log('[DMI] window.refreshDmiMarker defined:', !!window.refreshDmiMarker,
      '| window.radarMap (if exposed):', !!(window.radarMap));
    if (window.refreshDmiMarker) {
      window.refreshDmiMarker();
    } else {
      console.warn('[DMI] window.refreshDmiMarker is NOT defined — marker will not be placed until next wind refresh');
    }

    // Re-render the charts now that observations are available.
    // Double rAF ensures lastData has been set by the time renderDisplay runs.
    if (window.lastData && window.renderDisplay) {
      requestAnimationFrame(() => requestAnimationFrame(() => window.renderDisplay(window.lastData)));
    }

  } catch (e) {
    console.error('[DMI] loadDmiObservations error:', e);
    window.DMI_OBS_STATUS = { state: 'error', msg: e.message || 'unavailable' };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
  }
}
