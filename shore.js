/* ══════════════════════════════════════════════════════════════════════════
   SHORE MASK  –  land/sea analysis for kitesurfing direction suitability
   ══════════════════════════════════════════════════════════════════════════
   Algorithm
   ─────────
   For each of 36 bearings (0°, 10°, …, 350°) cast 5 sample points at
   1 km, 2 km, 3 km, 4 km and 5 km from the origin.  A bearing is
   classified as "sea" (steady wind, good for kiting) when the majority
   of its samples fall over open water.

   Data source – Overpass API (OpenStreetMap)
   ──────────────────────────────────────────
   A single bounding-box Overpass query fetches every OSM element that
   encodes water surface within the analysis radius:

     • way / relation   natural=water   (lakes, rivers mapped as areas)
     • way / relation   landuse=reservoir / dock / basin
     • relation         natural=coastline  (maritime coast, assembled into
                        closed rings and then used to determine sea side)
     • way              natural=coastline  (individual coast segments)
     • node/way/rel     place=sea / place=ocean  (named sea areas)

   Coastline handling
   ──────────────────
   OSM coastlines are open ways tagged natural=coastline where the *left*
   side of the way is sea (ways run clockwise around land masses).
   We use the **winding-number** rule with an upward (+lat) ray:
     • upward crossing,   test point left  of edge → +1
     • downward crossing, test point right of edge → -1
   winding ≠ 0 → inside land → land; winding = 0 → sea.
   This is anchor-independent and works correctly near complex coastlines.
   If no coastline ways are fetched we treat all samples as sea (open ocean).

   Point-in-polygon  –  winding-number + ray-casting O(n) per polygon
   ────────────────────────────────────────────────────────────────────
   Coastline classification uses the winding-number rule (see above).
   Explicit water-area polygons (lakes, reservoirs…) use standard ray-casting.

   Result
   ──────
   `window.SHORE_MASK`  – Float32Array(36) where index i covers bearing
   i*10°.  Value is the fraction of samples (0 – 1) that are over sea.
   A threshold of 0.5 means the majority are sea.

   `window.SHORE_STATUS` – object { state, msg }
     state: 'ok' | 'loading' | 'error' | 'inland'
══════════════════════════════════════════════════════════════════════════ */

/* ── constants ─────────────────────────────────────────────────────────── */
const SHORE_BEARINGS    = 36;      // one every 10°
const SHORE_SAMPLES     = 5;       // distances: 1,2,3,4,5 km
const SHORE_MAX_KM      = 5;
const SHORE_SEA_THRESH  = 0.5;    // fraction of samples that must be sea

/* ── public state ──────────────────────────────────────────────────────── */
window.SHORE_MASK   = null;        // Float32Array(36) or null
window.SHORE_STATUS = { state: 'idle', msg: '' };
window.SHORE_DEBUG  = null;        // debug snapshot – set after each analyseShore() run

/* ══════════════════════════════════════════════════════════════════════════
   GEO HELPERS
══════════════════════════════════════════════════════════════════════════ */

/**
 * Move `distKm` km in direction `bearingDeg` from (lat, lon).
 * Returns {lat, lon}.  Uses flat-earth approximation which is accurate
 * to ~0.05 % at 5 km scale.
 */
function destPoint(lat, lon, bearingDeg, distKm) {
  const R   = 6371;
  const b   = bearingDeg * Math.PI / 180;
  const d   = distKm / R;
  const lat1  = lat * Math.PI / 180;
  const lon1  = lon * Math.PI / 180;
  const lat2  = Math.asin( Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(b) );
  const lon2  = lon1 + Math.atan2( Math.sin(b)*Math.sin(d)*Math.cos(lat1),
                                   Math.cos(d) - Math.sin(lat1)*Math.sin(lat2) );
  return { lat: lat2 * 180/Math.PI, lon: lon2 * 180/Math.PI };
}

/** Expand bounding box by `padKm` km on each side. */
function expandBbox(lat, lon, padKm) {
  const dLat = padKm / 111.32;
  const dLon = padKm / (111.32 * Math.cos(lat * Math.PI / 180));
  return {
    s: lat - dLat, n: lat + dLat,
    w: lon - dLon, e: lon + dLon,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   POINT-IN-POLYGON  (ray-casting, geographic coordinates)
══════════════════════════════════════════════════════════════════════════ */

/**
 * Standard 2-D ray-casting PIP.
 * `poly` is an array of {lat, lon} objects forming a closed ring.
 * Returns true if (lat, lon) is strictly inside the polygon.
 */
function pointInPoly(lat, lon, poly) {
  let inside = false;
  const n = poly.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const xi = poly[i].lon, yi = poly[i].lat;
    const xj = poly[j].lon, yj = poly[j].lat;
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

/**
 * Compute the signed crossing contribution of one coastline segment (p3→p4)
 * for a +lat (upward) ray cast from (lat, lon).
 *
 *   OSM coastlines run with sea on the LEFT (clockwise around land masses).
 *   Upward-ray winding number:
 *     upward crossing   (p3.lat ≤ lat < p4.lat): point left  of edge → +1
 *     downward crossing (p4.lat ≤ lat < p3.lat): point right of edge → -1
 *
 *   winding ≠ 0 after summing all segments → inside a land ring → land.
 *   winding = 0 → sea.
 *
 * The cross-product sign test (cx > 0 / cx < 0) directly encodes the OSM
 * left=sea convention so no external "known-sea" anchor point is needed.
 */
function signedCrossing(lat, lon, p3, p4) {
  const y1 = p3.lat, x1 = p3.lon;
  const y2 = p4.lat, x2 = p4.lon;
  // cx > 0  ↔  test point is to the LEFT of the directed edge p3→p4
  const cx = (x2 - x1) * (lat - y1) - (y2 - y1) * (lon - x1);
  if (y1 <= lat && y2 > lat) {
    if (cx > 0) return +1;   // upward crossing, point left → entering land
  } else if (y2 <= lat && y1 > lat) {
    if (cx < 0) return -1;   // downward crossing, point right → leaving land
  }
  return 0;
}

/**
 * Determine whether a point (lat, lon) is on land, using raw OSM coastline
 * segments and the winding-number rule.
 *
 * @param {number}   lat
 * @param {number}   lon
 * @param {Array}    coastWays  – raw OSM way segments (arrays of {lat,lon})
 * @param {object}   bbox       – (unused, kept for API compat)
 * @param {boolean}  hasCoast   – whether any coast data exists
 * @returns {boolean}  true = land
 */
function isLandByRayCross(lat, lon, coastWays, bbox, hasCoast) {
  if (!hasCoast) return false;  // no coast data → open sea

  let winding = 0;
  for (const way of coastWays) {
    for (let i = 0; i < way.length - 1; i++) {
      winding += signedCrossing(lat, lon, way[i], way[i + 1]);
    }
  }

  return winding !== 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERPASS QUERY BUILDER + FETCHER
══════════════════════════════════════════════════════════════════════════ */

const OVERPASS_SERVER_TIMEOUT = 20;
const OVERPASS_CLIENT_TIMEOUT = 25000;

function buildOverpassQuery(bbox) {
  const b = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  return `[out:json][timeout:${OVERPASS_SERVER_TIMEOUT}];
(
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["landuse"~"^(reservoir|basin|dock)$"](${b});
  relation["landuse"~"^(reservoir|basin|dock)$"](${b});
  way["natural"="coastline"](${b});
);
out geom;`;
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOverpass(query) {
  const body = 'data=' + encodeURIComponent(query);
  const opts  = {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };

  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetchWithTimeout(endpoint, opts, OVERPASS_CLIENT_TIMEOUT);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      console.warn(`[shore] ${endpoint} failed:`, e.message ?? e);
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN ANALYSIS FUNCTION
══════════════════════════════════════════════════════════════════════════ */

/**
 * Pure data-processing core: parse a raw Overpass response and compute the
 * sea-bearing mask.  No side-effects — suitable for unit tests with fixture
 * data captured from `window.SHORE_DEBUG.rawOverpassData`.
 *
 * @param {number}      lat
 * @param {number}      lon
 * @param {object}      data  Raw Overpass JSON ({ elements: [...] })
 * @param {{ s,n,w,e }} bbox
 * @returns {{ mask, coastWays, waterPolys, hasCoastData, originInWater, originIsLand, bearings }}
 */
function processShoreData(lat, lon, data, bbox) {
  console.debug(`[shore] Overpass returned ${data.elements.length} elements for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);

  const waterPolys = [];
  const coastWays  = [];

  for (const el of data.elements) {
    if (el.type === 'way') {
      if (!el.geometry || el.geometry.length < 3) continue;
      const ring = el.geometry.map(g => ({ lat: g.lat, lon: g.lon }));
      if (el.tags?.natural === 'coastline') {
        coastWays.push(ring);
      } else {
        waterPolys.push(ring);
      }
    } else if (el.type === 'relation') {
      if (!el.members) continue;
      for (const m of el.members) {
        if (m.type === 'way' && m.role === 'outer' && m.geometry?.length >= 3) {
          waterPolys.push(m.geometry.map(g => ({ lat: g.lat, lon: g.lon })));
        }
      }
    }
  }

  console.debug(`[shore] Parsed: ${coastWays.length} coastline ways, ${waterPolys.length} water-area polygons`);

  const hasCoastData = coastWays.length > 0;
  const originInWater = waterPolys.some(p => pointInPoly(lat, lon, p));
  const originIsLand  = isLandByRayCross(lat, lon, coastWays, bbox, hasCoastData);

  console.debug(`[shore] Origin (${lat.toFixed(5)}, ${lon.toFixed(5)}): inWaterPoly=${originInWater}, isLand=${originIsLand}, hasCoastData=${hasCoastData}`);

  const mask = new Float32Array(SHORE_BEARINGS);
  const bearings = [];

  for (let b = 0; b < SHORE_BEARINGS; b++) {
    const bearing = b * 10;
    let seaCount  = 0;
    const sampleLog = [];
    const debugSamples = [];

    for (let s = 1; s <= SHORE_SAMPLES; s++) {
      const distKm = (s / SHORE_SAMPLES) * SHORE_MAX_KM;
      const pt     = destPoint(lat, lon, bearing, distKm);
      const { lat: pLat, lon: pLon } = pt;

      const isLandCoast = isLandByRayCross(pLat, pLon, coastWays, bbox, hasCoastData);
      const inWaterArea = isLandCoast && waterPolys.some(p => pointInPoly(pLat, pLon, p));

      let isSea, reason;
      if (!hasCoastData) {
        isSea = true;  reason = 'fallback:noCoast';
      } else if (inWaterArea) {
        isSea = true;  reason = 'waterArea';
      } else if (isLandCoast) {
        isSea = false; reason = 'coast:land';
      } else {
        isSea = true;  reason = 'coast:sea';
      }

      sampleLog.push(`${distKm.toFixed(1)}km→${isSea ? 'SEA' : 'LND'}(${reason})`);
      debugSamples.push({ distKm, lat: pLat, lon: pLon, isSea, reason });
      if (isSea) seaCount++;
    }

    mask[b] = seaCount / SHORE_SAMPLES;
    bearings.push({ bearing, seaFrac: mask[b], samples: debugSamples });
    console.debug(`[shore] ${String(bearing).padStart(3, ' ')}°: ${(mask[b]*100).toFixed(0).padStart(3)}% sea | ${sampleLog.join('  ')}`);
  }

  const seaBearingCount = Array.from(mask).filter(v => v >= SHORE_SEA_THRESH).length;
  console.debug(`[shore] Summary: ${seaBearingCount}/${SHORE_BEARINGS} bearings ≥ ${SHORE_SEA_THRESH*100}% sea`);

  return { mask, coastWays, waterPolys, hasCoastData, originInWater, originIsLand, bearings };
}

async function analyseShore(lat, lon, onDone) {
  window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline data…' };
  window.SHORE_MASK   = null;
  if (onDone) onDone();

  try {
    const bbox  = expandBbox(lat, lon, SHORE_MAX_KM + 1);
    const query = buildOverpassQuery(bbox);
    const data  = await fetchOverpass(query);

    window.SHORE_STATUS = { state: 'calculating', msg: 'Calculating sea bearings…' };
    if (onDone) onDone();

    const { mask, coastWays, waterPolys, hasCoastData,
            originInWater, originIsLand, bearings } = processShoreData(lat, lon, data, bbox);

    window.SHORE_MASK  = mask;
    window.SHORE_DEBUG = {
      lat, lon, bbox,
      rawOverpassData: data,
      elementCount:   data.elements.length,
      coastWayCount:  coastWays.length,
      waterPolyCount: waterPolys.length,
      hasCoastData,
      originInWater,
      originIsLand,
      coastWays,
      waterPolys,
      bearings,
    };

    const anySeaBearing = Array.from(mask).some(v => v >= SHORE_SEA_THRESH);
    if (!hasCoastData) {
      window.SHORE_STATUS = { state: 'inland', msg: 'No coastline within 5 km – location appears inland' };
    } else if (!anySeaBearing) {
      window.SHORE_STATUS = { state: 'ok', msg: 'Coast nearby but no open-sea bearing found' };
    } else {
      window.SHORE_STATUS = { state: 'ok', msg: '' };
    }
  } catch (e) {
    console.warn('[shore] analysis failed:', e);
    window.SHORE_MASK   = null;
    const isTimeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError'
                            || /timeout/i.test(e.message));
    window.SHORE_STATUS = {
      state: 'error',
      msg:   isTimeout ? 'Coastline fetch timed out (all mirrors busy)' : 'Coastline fetch failed',
    };
  }

  if (onDone) onDone();
}

/* ══════════════════════════════════════════════════════════════════════════
   SHORE COMPASS WIDGET
══════════════════════════════════════════════════════════════════════════ */

function drawShoreCompass(ctx, cx, cy, radius, mask, windDeg, isGood, selectedBearings) {
  const TWO_PI  = Math.PI * 2;
  const DEG2RAD = Math.PI / 180;
  const innerR  = radius * 0.28;
  const sectors = SHORE_BEARINGS;
  const step    = TWO_PI / sectors;
  const selSet  = new Set((selectedBearings || []).map(d => snapBearing(d)));

  ctx.save();

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.fillStyle = 'rgba(30,42,56,0.88)';
  ctx.fill();

  const rimW    = Math.max(3, radius * 0.10);
  const rimR    = radius - 1;
  const fillR   = rimR - rimW;

  for (let b = 0; b < sectors; b++) {
    const bearing    = b * 10;
    const startAngle = (bearing - 5 - 90) * DEG2RAD;
    const endAngle   = startAngle + step;
    const isSelected = selSet.has(bearing);

    const fillColor = isSelected ? 'rgba(0,220,160,0.88)' : 'rgba(22,34,48,0.92)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, fillR, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    if (mask) {
      const isSea = mask[b] >= SHORE_SEA_THRESH;
      ctx.beginPath();
      ctx.arc(cx, cy, rimR,  startAngle, endAngle);
      ctx.arc(cx, cy, fillR, endAngle,   startAngle, true);
      ctx.closePath();
      ctx.fillStyle = isSea ? 'rgba(60,160,255,0.80)' : 'rgba(180,110,40,0.80)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const dx = Math.cos(startAngle) * rimR;
    const dy = Math.sin(startAngle) * rimR;
    ctx.lineTo(cx + dx, cy + dy);
    ctx.strokeStyle = 'rgba(10,18,28,0.7)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, TWO_PI);
  ctx.fillStyle = '#1a2430';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,160,200,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  const CARDS = [
    { label: 'N', deg:   0 },
    { label: 'E', deg:  90 },
    { label: 'S', deg: 180 },
    { label: 'W', deg: 270 },
  ];
  ctx.font      = `600 ${Math.max(7, radius * 0.13)}px 'IBM Plex Sans', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  CARDS.forEach(({ label, deg }) => {
    const angle = (deg - 90) * DEG2RAD;
    const r     = radius * 0.80;
    const x     = cx + Math.cos(angle) * r;
    const y     = cy + Math.sin(angle) * r;
    ctx.fillStyle = '#c8d8e8';
    ctx.fillText(label, x, y);
  });

  if (windDeg != null) {
    const arrowAngle = (windDeg - 90) * DEG2RAD;
    const arrowLen   = radius * 0.62;
    const tailX = cx + Math.cos(arrowAngle) * arrowLen;
    const tailY = cy + Math.sin(arrowAngle) * arrowLen;
    const tipX  = cx - Math.cos(arrowAngle) * (innerR + 2);
    const tipY  = cy - Math.sin(arrowAngle) * (innerR + 2);

    const arrowColor = isGood ? '#00e8b0' : 'rgba(255,255,255,0.75)';
    ctx.strokeStyle = arrowColor;
    ctx.fillStyle   = arrowColor;
    ctx.lineWidth   = isGood ? 2.5 : 1.8;

    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    const headLen   = radius * 0.12;
    const headAngle = Math.atan2(tipY - tailY, tipX - tailX);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - headLen * Math.cos(headAngle - Math.PI / 6),
      tipY - headLen * Math.sin(headAngle - Math.PI / 6)
    );
    ctx.lineTo(
      tipX - headLen * Math.cos(headAngle + Math.PI / 6),
      tipY - headLen * Math.sin(headAngle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();

    if (isGood) {
      ctx.shadowColor = '#00e8b0';
      ctx.shadowBlur  = 8;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }
  }

  if (!mask) {
    ctx.fillStyle = 'rgba(180,190,200,0.7)';
    ctx.font      = `${Math.max(8, radius * 0.12)}px 'IBM Plex Sans', sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const state = window.SHORE_STATUS?.state;
    const statusMsg = state === 'loading'     ? 'Fetching…'
                    : state === 'calculating' ? 'Calculating…'
                    : state === 'error'       ? 'Unavailable'
                    : '';
    if (statusMsg) ctx.fillText(statusMsg, cx, cy);
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.strokeStyle = 'rgba(120,160,200,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

function isSeaBearing(deg) {
  if (!window.SHORE_MASK) return true;
  const idx = Math.round(((deg % 360) + 360) % 360 / 10) % SHORE_BEARINGS;
  return window.SHORE_MASK[idx] >= SHORE_SEA_THRESH;
}

/* ── Public API ── */
window.analyseShore     = analyseShore;
window.drawShoreCompass = drawShoreCompass;
window.isSeaBearing     = isSeaBearing;
