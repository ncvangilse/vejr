/* ══════════════════════════════════════════════════
   DMI OPEN DATA — METEOROLOGICAL OBSERVATION API
   API:   https://opendataapi.dmi.dk/v2/metObs
   Docs:  https://www.dmi.dk/friedata/dokumentation/meteorological-observation-api
   No API key required.
   Scope: Only activates for DK / GL / FO (DMI coverage area).
══════════════════════════════════════════════════ */

const DMI_OBS_BASE  = 'https://opendataapi.dmi.dk/v2/metObs';
const DMI_COUNTRIES = ['DK', 'GL', 'FO'];
// Max simultaneous non-nearest station fetches per batch.
const DMI_CONCURRENCY = 2;
// Default ms pause between non-nearest batches.  Override via window.DMI_DELAY_MS in tests.
const DMI_DELAY_MS_DEFAULT = 250;

/* Initialise globals so charts.js / app.js can safely read them before the
   async fetch completes. */
window.DMI_OBS        = null;
window.DMI_OBS_STATUS = { state: 'idle', msg: '' };
/** All active DMI stations in the bbox – populated by loadDmiObservations
 *  so radar.js can show every station on the map, not only the nearest. */
window.DMI_STATIONS   = null;

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

/* ── Find active stations within ~0.5° (≈ 50 km) ──
   Returns { nearest, all } where nearest is the closest active station
   (or null when none found) and all is every active station in the bbox.
   The DMI API may return multiple features for the same stationId (one per
   sensor/observation type) — these are deduplicated so each physical station
   appears only once in `all`.
   Throws 'dmi-http-NNN' on HTTP errors. */
async function _dmiFindStation(lat, lon) {
  const d    = 0.5;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url  = `${DMI_OBS_BASE}/collections/station/items?bbox=${bbox}`;
  const r    = await fetch(url);
  if (!r.ok) throw new Error(`dmi-http-${r.status}`);
  const data = await r.json();
  let best = null, bestDist = Infinity;
  const all  = [];
  const seen = new Set();   // deduplicate by stationId
  for (const f of (data.features || [])) {
    // Skip inactive stations when the status field is present
    if (f.properties && f.properties.status && f.properties.status !== 'Active') continue;
    const stationId = f.properties.stationId;
    if (seen.has(stationId)) continue;   // same physical station listed multiple times
    seen.add(stationId);
    const [sLon, sLat] = f.geometry.coordinates;
    const dist = _dmiHaversine(lat, lon, sLat, sLon);
    const station = {
      id:   stationId,
      name: f.properties.name || stationId,
      lat:  sLat,
      lon:  sLon,
      dist,
    };
    all.push(station);
    if (dist < bestDist) { bestDist = dist; best = station; }
  }
  return { nearest: best, all };
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
  // 400 means the parameter is not available for this station — treat as empty.
  if (r.status === 400) return { features: [] };
  if (!r.ok) throw new Error(`dmi-obs-${r.status}`);
  return r.json();
}

/* ── Fetch observations for multiple parameters in a single request ──
   paramIds is an array of parameterId strings joined with a literal comma
   (OGC Features API convention — the comma must NOT be percent-encoded).
   Returns a GeoJSON FeatureCollection whose features span all requested params. */
async function _dmiObsMultiParam(stationId, paramIds, fromIso, toIso) {
  const url = `${DMI_OBS_BASE}/collections/observation/items`
    + `?stationId=${encodeURIComponent(stationId)}`
    + `&parameterId=${paramIds.join(',')}`
    + `&datetime=${encodeURIComponent(fromIso + '/' + toIso)}`
    + `&limit=10000`;
  const r = await fetch(url);
  if (r.status === 400) return { features: [] };
  if (!r.ok) throw new Error(`dmi-obs-${r.status}`);
  return r.json();
}

/* ── Split a flat feature array into per-parameterId buckets ──
   Returns { [parameterId]: Feature[] }.  Keys are absent (not empty arrays)
   when a parameterId has no entries — callers should use `result[id] || []`. */
function _dmiSplitByParam(features) {
  const result = {};
  for (const f of (features || [])) {
    const pid = f.properties.parameterId;
    if (!result[pid]) result[pid] = [];
    result[pid].push(f);
  }
  return result;
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

/* ── Fetch the latest wind speed + direction for a station (last 3 h) ──
   Used to show arrow icons for every in-bbox DMI station on the radar map.
   NOTE: The DMI API returns 400 for comma-separated parameterId values, so
   wind_speed and wind_dir are fetched as two separate concurrent requests.
   Returns { wind, gust, dir, time } or null when no valid data found. ── */
async function _dmiLatestWindObs(stationId) {
  const now     = new Date();
  const fromIso = new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19) + 'Z';
  const toIso   = now.toISOString().slice(0, 19) + 'Z';
  // Two separate requests — the API does not support comma-separated parameterId.
  const [windR, dirR] = await Promise.all([
    _dmiObs(stationId, 'wind_speed', fromIso, toIso).catch(() => null),
    _dmiObs(stationId, 'wind_dir',   fromIso, toIso).catch(() => null),
  ]);
  const merged = _dmiMergeObs(
    windR ? windR.features : [],
    [],
    dirR  ? dirR.features  : [],
  );
  if (!merged.length) return null;
  const latestWind = [...merged].reverse().find(o => o.wind != null && isFinite(o.wind));
  if (!latestWind) return null;
  const dirEntries = merged.filter(o => o.dir != null && isFinite(o.dir));
  let dir = null;
  if (dirEntries.length) {
    const closest = dirEntries.reduce((a, b) =>
      Math.abs(a.t - latestWind.t) <= Math.abs(b.t - latestWind.t) ? a : b);
    if (Math.abs(closest.t - latestWind.t) <= 30 * 60 * 1000) dir = closest.dir;
  }
  return { wind: latestWind.wind, gust: latestWind.gust, dir, time: latestWind.t };
}

/* ══════════════════════════════════════════════════
   MAIN ENTRY POINT
   Called from app.js after geocode() — fire and forget.
   Populates window.DMI_OBS and triggers a re-render when done.
══════════════════════════════════════════════════ */
async function loadDmiObservations(lat, lon, countryCode) {
  console.log('[obs · DMI] loadDmiObservations called — lat:', lat, 'lon:', lon, 'countryCode:', countryCode);
  window.DMI_OBS        = null;
  window.DMI_OBS_STATUS = { state: 'idle', msg: '' };
  window.DMI_STATIONS   = null;
  if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

  if (!DMI_COUNTRIES.includes(countryCode)) {
    console.log('[obs · DMI] country', countryCode, 'not in DMI coverage — skipping');
    window.DMI_OBS_STATUS = { state: 'not-dk', msg: '' };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
    return;
  }

  try {
    window.DMI_OBS_STATUS = { state: 'loading', msg: 'Finding station…' };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

    const result = await _dmiFindStation(lat, lon);

    // NinJo snapshot (ninjo-stations.json) covers the same stations with fresher
    // data — no point fetching from the open DMI API on top of that.
    if (window.ninjoActive) {
      console.log('[obs · DMI] NinJo is active — skipping DMI obs fetch');
      window.DMI_OBS_STATUS = { state: 'idle', msg: '' };
      if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
      return;
    }

    const allStations = result.all;

    // Store ALL active stations so the radar map can show them immediately,
    // even before observation data has been fetched.
    window.DMI_STATIONS = allStations;
    if (window.refreshDmiMarker) window.refreshDmiMarker();

    if (!allStations.length) {
      console.log('[obs · DMI] no active station found within 0.5° of', lat, lon);
      window.DMI_OBS_STATUS = { state: 'no-station', msg: 'No station nearby' };
      if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
      return;
    }
    console.log('[obs · DMI] all stations in bbox:', allStations.map(s => `${s.name}(${s.dist.toFixed(1)}km)`).join(', '));

    // Fetch the past 48 hours (covers the visible portion of the forecast chart)
    const now     = new Date();
    const fromMs  = now.getTime() - 48 * 3600 * 1000;
    const fromIso = new Date(fromMs).toISOString().slice(0, 19) + 'Z';
    const toIso   = now.toISOString().slice(0, 19) + 'Z';

    // Try stations in distance order — use the first one that has actual wind data.
    // This skips stations that are online but haven't reported recently.
    const sortedStations = [...allStations].sort((a, b) => a.dist - b.dist);
    let station = null, windResp = null, gustResp = null, dirResp = null, obs = [];
    for (const candidate of sortedStations) {
      window.DMI_OBS_STATUS = { state: 'loading', msg: `Loading ${candidate.name}…` };
      if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
      console.log('[obs · DMI] trying station:', candidate.name, '— id:', candidate.id, '— dist:', candidate.dist.toFixed(1), 'km');
      let wR, gR, dR;
      try {
        [wR, gR, dR] = await Promise.all([
          _dmiObs(candidate.id, 'wind_speed',             fromIso, toIso),
          _dmiObs(candidate.id, 'wind_gust_always_10min', fromIso, toIso).catch(() => null),
          _dmiObs(candidate.id, 'wind_dir',               fromIso, toIso).catch(() => null),
        ]);
      } catch (fetchErr) {
        console.warn('[obs · DMI] fetch failed for', candidate.name, fetchErr.message || fetchErr);
        continue;
      }
      console.log('[obs · DMI] wind_speed features:', wR.features?.length,
                  '| wind_gust features:', gR?.features?.length ?? 'err',
                  '| wind_dir features:', dR?.features?.length ?? 'err');
      const merged = _dmiMergeObs(
        wR.features || [],
        (gR && gR.features) || [],
        (dR && dR.features) || [],
      );
      if (merged.length > 0) {
        station   = candidate;
        windResp  = wR;
        gustResp  = gR;
        dirResp   = dR;
        obs       = merged;
        console.log('[obs · DMI] selected station:', station.name, '— obs count:', obs.length);
        break;
      }
      console.log('[obs · DMI] station', candidate.name, 'has no wind data — trying next');
    }

    if (!station) {
      console.log('[obs · DMI] no station with wind data found within bbox');
      window.DMI_OBS_STATUS = { state: 'no-station', msg: 'No wind data nearby' };
      if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
      return;
    }

    // Compute the latest snapshot for the nearest station's arrow marker.
    const latestObs = [...obs].reverse().find(o => o.wind != null && isFinite(o.wind));
    let latestDir = null;
    if (latestObs) {
      const dirObs = obs.filter(o => o.dir != null && isFinite(o.dir));
      if (dirObs.length) {
        const closest = dirObs.reduce((a, b) =>
          Math.abs(a.t - latestObs.t) <= Math.abs(b.t - latestObs.t) ? a : b);
        if (Math.abs(closest.t - latestObs.t) <= 30 * 60 * 1000) latestDir = closest.dir;
      }
    }
    // .latest  – used by the radar map for the arrow icon (shared shape with wind-speeds.json markers).
    // .obsHistory – pre-cached so the popup does not need to re-fetch for the nearest station.
    station.latest     = { wind: latestObs ? latestObs.wind : null,
                           gust: latestObs ? latestObs.gust : null,
                           dir:  latestDir,
                           time: latestObs ? latestObs.t    : null };
    station.obsHistory = obs;

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
      // Concise: station name + distance — this is shown verbatim in the header
      msg:   `${station.name} · ${Math.round(station.dist)} km`,
    };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();

    console.log('[obs · DMI] window.DMI_OBS set — stationName:', window.DMI_OBS.stationName,
      '| obs.length:', obs.length,
      '| lat:', window.DMI_OBS.lat, 'lon:', window.DMI_OBS.lon);

    // Show the nearest-station arrow and re-render the forecast chart immediately.
    if (window.refreshDmiMarker) window.refreshDmiMarker();
    if (window.lastData && window.renderDisplay) {
      requestAnimationFrame(() => requestAnimationFrame(() => window.renderDisplay(window.lastData)));
    }

    // Fetch non-nearest stations in batches of DMI_CONCURRENCY, with a configurable
    // pause between batches, to stay well under the DMI API rate limit.
    // Each station fires 2 requests (wind_speed + wind_dir) concurrently inside
    // _dmiLatestWindObs — the API returns 400 for comma-separated parameterId so a
    // single combined request is not possible.  With CONCURRENCY=2, each batch fires
    // at most 4 requests simultaneously.
    // Markers are updated after every batch so arrows appear progressively.
    const delayMs    = typeof window.DMI_DELAY_MS === 'number' ? window.DMI_DELAY_MS : DMI_DELAY_MS_DEFAULT;
    const nonNearest = allStations.filter(s => s.id !== station.id);
    for (let i = 0; i < nonNearest.length; i += DMI_CONCURRENCY) {
      if (i > 0 && delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      const batch = nonNearest.slice(i, i + DMI_CONCURRENCY);
      await Promise.all(batch.map(s =>
        _dmiLatestWindObs(s.id)
          .then(latest => { s.latest = latest; })
          .catch(e => {
            const msg = (e && e.message) || '';
            if (msg.includes('429')) console.warn('[DMI] rate-limited for station', s.id);
            else console.warn('[DMI] obs fetch failed for station', s.id, msg ? ': ' + msg : '');
          })
      ));
      // Progressive update: refresh markers after each batch so arrows appear as data arrives.
      if (window.refreshDmiMarker) window.refreshDmiMarker();
    }

  } catch (e) {
    console.error('[DMI] loadDmiObservations error:', e);
    window.DMI_OBS_STATUS = { state: 'error', msg: e.message || 'unavailable' };
    if (window.updateDmiObsStatusUI) window.updateDmiObsStatusUI();
  }
}

/* ── Fetch and cache the last-24h observation history for a station ──
   Used by the radar map popup to display a scrollable history table.
   Caches result on station.obsHistory to avoid repeated API calls.
   Public: exposed as window.dmiLoadStationHistory for radar.js. ── */
window.dmiLoadStationHistory = async function (station) {
  if (station.obsHistory != null) return station.obsHistory;
  const now     = new Date();
  const fromIso = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 19) + 'Z';
  const toIso   = now.toISOString().slice(0, 19) + 'Z';
  const [windR, gustR, dirR] = await Promise.all([
    _dmiObs(station.id, 'wind_speed',             fromIso, toIso),
    _dmiObs(station.id, 'wind_gust_always_10min', fromIso, toIso).catch(() => ({ features: [] })),
    _dmiObs(station.id, 'wind_dir',               fromIso, toIso).catch(() => ({ features: [] })),
  ]);
  station.obsHistory = _dmiMergeObs(
    windR.features || [],
    gustR.features || [],
    dirR.features  || [],
  );
  return station.obsHistory;
};
