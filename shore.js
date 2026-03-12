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
   the sea to their left, which in practice means counter-clockwise around
   land masses).  We assemble segments into rings and test the winding
   order to classify the interior as land or sea.  For the area entirely
   inside open ocean (no coastline way crosses the bounding box) we fall
   back to a "global ocean" heuristic: if every land-area test returns
   false and no coastline was fetched, we treat all samples as sea.

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
 * `poly` is an array of {lat, lon} objects forming a closed ring
 * (first ≠ last; the function closes it automatically).
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
 * Signed area of a polygon ring (positive = CCW in standard math axes,
 * i.e. lat as Y and lon as X).
 */
function signedArea(ring) {
  let area = 0;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (ring[j].lon + ring[i].lon) * (ring[j].lat - ring[i].lat);
  }
  return area / 2;
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
function buildOverpassQuery(bbox) {
  const b = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  return `[out:json][timeout:12];
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
];

async function fetchOverpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ══════════════════════════════════════════════════════════════════════════
   COASTLINE RING ASSEMBLY
══════════════════════════════════════════════════════════════════════════ */

/**
 * Assemble a list of OSM coastline ways (each an array of {lat,lon} nodes)
 * into closed rings by chaining them end-to-start.
 *
 * OSM convention: natural=coastline ways run with the sea on the LEFT.
 * In geographic coordinates this means land masses are CCW rings and the
 * sea is "outside" them.
 *
 * For our PIP test: a point is "sea" if it is NOT inside any land ring.
 * A land ring is a CCW ring in lat/lon space (signedArea < 0 because
 * lat grows northward, lon grows eastward – right-hand coord system).
 * Actually in lat/lon Cartesian: CCW area is positive in standard math,
 * but OSM coastlines go CCW around land, so signed area of a land ring
 * is POSITIVE in standard (lat=Y, lon=X) convention.
 *
 * We keep all assembled rings and for each ring:
 *   area > 0  →  land ring   →  point inside means LAND
 *   area < 0  →  sea ring    →  point inside means SEA (enclosed water body
 *                                won't happen for ocean but guards edge cases)
 */
function assembleCoastlineRings(ways) {
  if (!ways.length) return [];

  // Build adjacency: map from node-id-string of end point → way index
  const byStart = new Map();
  const byEnd   = new Map();
  ways.forEach((way, i) => {
    if (way.length < 2) return;
    byStart.set(nodeKey(way[0]),   i);
    byEnd  .set(nodeKey(way[way.length - 1]), i);
  });

  const used  = new Uint8Array(ways.length);
  const rings = [];

  for (let seed = 0; seed < ways.length; seed++) {
    if (used[seed] || ways[seed].length < 2) continue;
    const ring  = ways[seed].slice();
    used[seed]  = 1;
    let iter    = 0;

    while (iter++ < ways.length) {
      const tail = nodeKey(ring[ring.length - 1]);
      // Check if closed
      if (tail === nodeKey(ring[0])) break;

      // Try to extend
      const nextI = byStart.get(tail);
      if (nextI !== undefined && !used[nextI]) {
        ring.push(...ways[nextI].slice(1));
        used[nextI] = 1;
        continue;
      }
      // Try reversed way
      const revI = byEnd.get(tail);
      if (revI !== undefined && !used[revI]) {
        ring.push(...ways[revI].slice(0, -1).reverse());
        used[revI] = 1;
        continue;
      }
      break; // open chain – keep as partial
    }
    rings.push(ring);
  }
  return rings;
}

function nodeKey(pt) {
  return `${pt.lat.toFixed(7)},${pt.lon.toFixed(7)}`;
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

    /* ── Assemble coastline into rings and build "land rings" ── */
    const coastRings = assembleCoastlineRings(coastWays);

    // Classify each ring: positive signed area → land
    const landRings = coastRings.filter(r => signedArea(r) >= 0);
    // Negative area rings are enclosed sea pockets (e.g. bays traced CCW)
    const seaRings  = coastRings.filter(r => signedArea(r) < 0);

    const hasCoastData = coastWays.length > 0;

    /* ── Determine "is inland" heuristic ───────────────────────────────
       If origin itself is inside a water-area polygon → it's a lake/river,
       treat as inland (no useful sea wind).
       If no coastline data at all and origin is not in a water area → inland.
    ── */
    const mask = new Float32Array(SHORE_BEARINGS);

    for (let b = 0; b < SHORE_BEARINGS; b++) {
      const bearing = b * 10;
      let seaCount  = 0;

      for (let s = 1; s <= SHORE_SAMPLES; s++) {
        const distKm = (s / SHORE_SAMPLES) * SHORE_MAX_KM;
        const pt     = destPoint(lat, lon, bearing, distKm);
        const { lat: pLat, lon: pLon } = pt;

        /* Is this sample point over water?
           Priority:
           1. Inside an explicit water-area polygon         → water (lake/river/reservoir)
           2. Inside a coastline sea-ring (enclosed bay)    → sea
           3. Inside a coastline land-ring                  → land
           4. No coastline data present in bbox             → assume inland/lake (no coast)
           5. Not inside any land-ring but coast data exists → sea                          */
        const inWaterArea = waterPolys.some(p => pointInPoly(pLat, pLon, p));
        const inSeaRing   = seaRings.some(r   => pointInPoly(pLat, pLon, r));
        const inLandRing  = landRings.some(r  => pointInPoly(pLat, pLon, r));

        let isSea;
        if (inWaterArea) {
          // Explicitly tagged water area (lake etc.) – counts as water body but NOT ocean
          // Only count as "sea" if it's a large body with place=sea/ocean tag
          // (we don't have that tag here, so treat generic water areas as non-sea/inland)
          isSea = false;
        } else if (inSeaRing) {
          isSea = true;
        } else if (inLandRing) {
          isSea = false;
        } else {
          // No polygon contains this point
          isSea = hasCoastData; // coast data exists → outside all land rings → open sea
        }

        if (isSea) seaCount++;
      }

      mask[b] = seaCount / SHORE_SAMPLES;
    }

    window.SHORE_MASK   = mask;

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
    window.SHORE_STATUS = { state: 'error', msg: 'Coastline fetch failed' };
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










