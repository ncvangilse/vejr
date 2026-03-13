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
   side of the way is sea and the *right* side is land (i.e. ways run with
   the sea to their left, which means they go **clockwise** around land
   masses).  We assemble segments into rings and test the winding order to
   classify the interior as land or sea.  In lon/lat (X=lon, Y=lat)
   Cartesian space, clockwise winding yields a **negative** signed area, so
   rings with area < 0 are land rings and rings with area ≥ 0 are sea
   pockets (enclosed bays).  For the area entirely inside open ocean (no
   coastline way crosses the bounding box) we fall back to a "global ocean"
   heuristic: if no coastline was fetched, we treat all samples as sea.

   Point-in-polygon  –  ray-casting algorithm O(n) per polygon
   ─────────────────────────────────────────────────────────────
   Each water-area polygon contributes a boolean "is inside" flag.
   Coastline rings contribute the sea side (left of way direction).

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
 * Test whether a 2-D segment (p1→p2) crosses another segment (p3→p4).
 * All points are {lat, lon}.  Returns true on a proper crossing.
 */
function segmentsCross(p1, p2, p3, p4) {
  const d1x = p2.lon - p1.lon, d1y = p2.lat - p1.lat;
  const d2x = p4.lon - p3.lon, d2y = p4.lat - p3.lat;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-12) return false;  // parallel
  const dx = p3.lon - p1.lon, dy = p3.lat - p1.lat;
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/**
 * Determine whether a point (lat, lon) is on land, using raw OSM coastline
 * segments and the ray-crossing rule:
 *
 *   OSM coastlines run with sea on the LEFT (clockwise around land).
 *   Cast a ray from the test point to a known-sea anchor point.
 *   Count how many coastline segments the ray crosses.
 *   Odd count  → the point is on the opposite side of the coast from the
 *                anchor → LAND.
 *   Even count → same side as anchor → SEA.
 *
 * This completely avoids bbox ring-closure and winding-sign ambiguity.
 *
 * @param {number}                  lat, lon   – test point
 * @param {Array<Array<{lat,lon}>}  coastWays  – raw OSM way segments
 * @param {{ s,n,w,e }}             bbox       – query bbox (used to pick anchor)
 * @param {boolean}                 hasCoast   – whether any coast data exists
 * @returns {boolean}  true = land
 */
function isLandByRayCross(lat, lon, coastWays, bbox, hasCoast) {
  if (!hasCoast) return false;  // no coast data → open sea

  // Anchor: a point well outside the bbox that is guaranteed to be at sea.
  // We pick a point displaced well beyond the bbox in all four directions and
  // choose the one that produces the least-likely-to-be-ambiguous ray.
  // Simple choice: bbox SW corner shifted further SW.
  const anchor = {
    lat: bbox.s - (bbox.n - bbox.s),
    lon: bbox.w - (bbox.e - bbox.w),
  };

  const pt = { lat, lon };
  let crossings = 0;

  for (const way of coastWays) {
    for (let i = 0; i < way.length - 1; i++) {
      if (segmentsCross(pt, anchor, way[i], way[i + 1])) {
        crossings++;
      }
    }
  }

  return (crossings % 2) === 1;
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERPASS QUERY BUILDER + FETCHER
══════════════════════════════════════════════════════════════════════════ */

/**
 * Build an Overpass QL query that fetches, within the bbox:
 *   - water areas (natural=water, landuse=reservoir|dock|basin)
 *   - coastline ways (natural=coastline)
 * Returns geometries as JSON.
 */
const OVERPASS_SERVER_TIMEOUT = 20;   // seconds – sent inside QL query
const OVERPASS_CLIENT_TIMEOUT = 25000; // ms – hard browser-side abort

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

/** Fetch with a manual AbortController timeout (works on all browsers). */
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
      // On a hard HTTP error (4xx/5xx) from this endpoint skip to the next one.
      // On a timeout / network error also try the next endpoint.
    }
  }
  throw lastErr;
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN ANALYSIS FUNCTION
══════════════════════════════════════════════════════════════════════════ */

/**
 * Analyse the land/sea environment around (lat, lon) within SHORE_MAX_KM.
 * Populates window.SHORE_MASK and window.SHORE_STATUS, then calls onDone().
 *
 * @param {number}   lat
 * @param {number}   lon
 * @param {function} onDone  – called when the mask is ready (or on error)
 */
async function analyseShore(lat, lon, onDone) {
  window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline data…' };
  window.SHORE_MASK   = null;
  if (onDone) onDone();

  try {
    const bbox  = expandBbox(lat, lon, SHORE_MAX_KM + 1);
    const query = buildOverpassQuery(bbox);
    const data  = await fetchOverpass(query);

    // Data received — notify UI before the CPU-bound PIP loop
    window.SHORE_STATUS = { state: 'calculating', msg: 'Calculating sea bearings…' };
    if (onDone) onDone();

    console.debug(`[shore] Overpass returned ${data.elements.length} elements for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);

    /* ── Parse elements into polygons and coastline ways ── */

    // Closed water-area polygons (ways and relation outer rings)
    const waterPolys = [];

    // Raw coastline way node arrays
    const coastWays  = [];

    // Collect nodes from way/relation geometries (Overpass `out geom` includes coords)
    for (const el of data.elements) {
      if (el.type === 'way') {
        if (!el.geometry || el.geometry.length < 3) continue;
        const ring = el.geometry.map(g => ({ lat: g.lat, lon: g.lon }));

        if (el.tags?.natural === 'coastline') {
          coastWays.push(ring);
        } else {
          // water area or reservoir
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

    // ── Origin classification (for debug / inland detection) ──
    const originInWater = waterPolys.some(p => pointInPoly(lat, lon, p));
    const originIsLand  = isLandByRayCross(lat, lon, coastWays, bbox, hasCoastData);
    console.debug(`[shore] Origin (${lat.toFixed(5)}, ${lon.toFixed(5)}): inWaterPoly=${originInWater}, isLand=${originIsLand}, hasCoastData=${hasCoastData}`);

    const mask = new Float32Array(SHORE_BEARINGS);
    const debugBearings = [];

    for (let b = 0; b < SHORE_BEARINGS; b++) {
      const bearing = b * 10;
      let seaCount  = 0;
      const sampleLog = [];
      const debugSamples = [];

      for (let s = 1; s <= SHORE_SAMPLES; s++) {
        const distKm = (s / SHORE_SAMPLES) * SHORE_MAX_KM;
        const pt     = destPoint(lat, lon, bearing, distKm);
        const { lat: pLat, lon: pLon } = pt;

        /* Is this sample point over water?
           Priority order:
           1. Raw-segment ray-crossing against coastline ways → land or sea
           2. Inside an explicit water-area polygon (lake, reservoir…) → sea
              (overrides coastline "land" only for tagged inland water bodies)
           3. No coastline data → open sea (fallback)                        */
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
      debugBearings.push({ bearing, seaFrac: mask[b], samples: debugSamples });
      console.debug(`[shore] ${String(bearing).padStart(3, ' ')}°: ${(mask[b]*100).toFixed(0).padStart(3)}% sea | ${sampleLog.join('  ')}`);
    }

    const seaBearingCount = Array.from(mask).filter(v => v >= SHORE_SEA_THRESH).length;
    console.debug(`[shore] Summary: ${seaBearingCount}/${SHORE_BEARINGS} bearings ≥ ${SHORE_SEA_THRESH*100}% sea`);
    console.debug('[shore] Full mask (% sea per 10°):', Array.from(mask).map((v,i) => `${i*10}°:${(v*100).toFixed(0)}%`).join(' '));

    window.SHORE_MASK  = mask;
    window.SHORE_DEBUG = {
      lat, lon,
      bbox,
      elementCount:   data.elements.length,
      coastWayCount:  coastWays.length,
      waterPolyCount: waterPolys.length,
      hasCoastData,
      originInWater,
      originIsLand,
      coastWays,                         // raw ways for debug-map drawing
      waterPolys,                        // water-area polys for debug-map drawing
      bearings: debugBearings,
    };

    // Determine overall status message
    const anySeaBearing = Array.from(mask).some(v => v >= SHORE_SEA_THRESH);
    if (!hasCoastData) {
      window.SHORE_STATUS = {
        state: 'inland',
        msg:   'No coastline within 5 km – location appears inland',
      };
    } else if (!anySeaBearing) {
      window.SHORE_STATUS = {
        state: 'ok',
        msg:   'Coast nearby but no open-sea bearing found',
      };
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
   SHORE COMPASS WIDGET  –  draws a small polar rose showing sea bearings
══════════════════════════════════════════════════════════════════════════ */

/**
 * Draw the shore-mask compass into a <canvas> element.
 * Sectors coloured teal = sea, sand = land, grey = unknown.
 * The current wind direction arrow is overlaid if `windDeg` is provided.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx      centre X (CSS px)
 * @param {number} cy      centre Y (CSS px)
 * @param {number} radius  outer radius (CSS px)
 * @param {Float32Array|null} mask  SHORE_MASK
 * @param {number|null} windDeg  current wind direction (meteorological, from)
 * @param {boolean} isGood       whether current wind is kite-optimal
 */
function drawShoreCompass(ctx, cx, cy, radius, mask, windDeg, isGood) {
  const TWO_PI  = Math.PI * 2;
  const DEG2RAD = Math.PI / 180;
  const innerR  = radius * 0.28;
  const sectors = SHORE_BEARINGS;
  const step    = TWO_PI / sectors;        // radians per sector

  ctx.save();

  // ── Background ring ──
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.fillStyle = 'rgba(30,42,56,0.88)';
  ctx.fill();

  // ── Sectors ──
  for (let b = 0; b < sectors; b++) {
    // Canvas 0° = right (East), compass 0° = up (North) → subtract 90°
    const startAngle = (b * 10 - 5 - 90) * DEG2RAD;
    const endAngle   = startAngle + step;

    let fill;
    if (!mask) {
      fill = 'rgba(100,110,120,0.55)';
    } else {
      const v = mask[b];
      if (v >= SHORE_SEA_THRESH) {
        // Sea – teal, intensity by fraction
        const alpha = 0.45 + v * 0.45;
        fill = `rgba(0,200,160,${alpha.toFixed(2)})`;
      } else {
        // Land – warm sand/amber
        const alpha = 0.35 + (1 - v) * 0.40;
        fill = `rgba(200,150,60,${alpha.toFixed(2)})`;
      }
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius - 1, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();

    // Thin sector dividers
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const dx = Math.cos(startAngle) * (radius - 1);
    const dy = Math.sin(startAngle) * (radius - 1);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.strokeStyle = 'rgba(18,26,38,0.5)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // ── Inner blank circle (centre hub) ──
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, TWO_PI);
  ctx.fillStyle = '#1a2430';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,160,200,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Cardinal labels ──
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

  // ── Wind direction arrow ──
  if (windDeg != null) {
    // Wind direction is "from" — arrow points FROM that direction TOWARD centre
    // i.e. the arrow tip is at the centre and the tail is at windDeg
    const arrowAngle = (windDeg - 90) * DEG2RAD; // canvas angle of the "from" direction
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

    // Arrowhead
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

    // Glow for optimal
    if (isGood) {
      ctx.shadowColor = '#00e8b0';
      ctx.shadowBlur  = 8;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }
  }

  // ── Status overlay if no data ──
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

  // ── Outer ring border ──
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.strokeStyle = 'rgba(120,160,200,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

/* ══════════════════════════════════════════════════════════════════════════
   KITE-DIRECTION INTEGRATION
   ──────────────────────────────────────────────────────────────────────────
   Returns true if bearing `deg` faces the sea (wind blows from sea to land).
   Used to gate kite-optimal highlighting.
══════════════════════════════════════════════════════════════════════════ */
function isSeaBearing(deg) {
  if (!window.SHORE_MASK) return true; // no data → don't restrict
  const idx = Math.round(((deg % 360) + 360) % 360 / 10) % SHORE_BEARINGS;
  return window.SHORE_MASK[idx] >= SHORE_SEA_THRESH;
}

/* ── Public API ── */
window.analyseShore    = analyseShore;
window.drawShoreCompass = drawShoreCompass;
window.isSeaBearing    = isSeaBearing;



