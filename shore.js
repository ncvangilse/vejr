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
 * Approximate area of a polygon's bounding box in m², used for size filtering.
 * Fast but rough — good enough to discard tiny ponds/basins.
 */
function polyBboxAreaM2(ring) {
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const { lat, lon } of ring) {
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
  }
  const latSpanM = (latMax - latMin) * 111_320;
  const lonSpanM = (lonMax - lonMin) * 111_320 * Math.cos((latMin + latMax) * 0.5 * Math.PI / 180);
  return latSpanM * lonSpanM;
}

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
 *   OSM coastlines run with sea on the LEFT (clockwise around land masses).
 *   We cast an upward (+lat) ray and accumulate signed crossings (winding
 *   number).  winding ≠ 0 → point is inside a land ring → land.
 *   winding = 0 → sea.
 *
 *   This is anchor-independent: correctness relies solely on the OSM
 *   winding convention, not on any external reference point being at sea.
 *
 * @param {number}                  lat        – test point latitude
 * @param {number}                  lon        – test point longitude
 * @param {Array<Array<{lat: number, lon: number}>>}  coastWays  – raw OSM way segments
 * @param {{ s,n,w,e }}             bbox       – (unused, kept for API compat)
 * @param {boolean}                 hasCoast   – whether any coast data exists
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
   COASTLINE STITCHING + BBOX CLOSURE
   ──────────────────────────────────────────────────────────────────────────
   OSM coastline ways fetched by Overpass are *partial* slices of the global
   coastline ring.  When a continental coast enters our bbox from one side and
   exits from another, the resulting open chain produces unmatched winding-
   number crossings that misclassify sea points as land (or vice versa).
   The fix is to:
     1. Stitch connected ways into chains (matching shared endpoints).
     2. Close every open chain by travelling clockwise around the bbox
        boundary from the chain tail back to its head.
   This turns the partial OSM data into properly-closed rings that the
   winding-number algorithm can handle correctly.
══════════════════════════════════════════════════════════════════════════ */

/**
 * Snap an arbitrary point to the nearest edge of the bounding box.
 * Used to project open-chain endpoints onto the bbox boundary before closure.
 */
function snapToBbox(pt, bbox) {
  const clampLat = lat => Math.max(bbox.s, Math.min(bbox.n, lat));
  const clampLon = lon => Math.max(bbox.w, Math.min(bbox.e, lon));

  const outsideLat = pt.lat > bbox.n || pt.lat < bbox.s;
  const outsideLon = pt.lon > bbox.e || pt.lon < bbox.w;

  // If the point is outside in exactly one axis, snap to that axis's edge —
  // this avoids false ties when the point is near the corner in the other axis.
  if (outsideLat && !outsideLon) {
    return { lat: pt.lat > bbox.n ? bbox.n : bbox.s, lon: clampLon(pt.lon) };
  }
  if (outsideLon && !outsideLat) {
    return { lat: clampLat(pt.lat), lon: pt.lon > bbox.e ? bbox.e : bbox.w };
  }

  // Outside in both axes (corner region) or already inside: use nearest edge.
  const dE = Math.abs(pt.lon - bbox.e), dW = Math.abs(pt.lon - bbox.w);
  const dN = Math.abs(pt.lat - bbox.n), dS = Math.abs(pt.lat - bbox.s);
  const m  = Math.min(dE, dW, dN, dS);
  if (m === dN) return { lat: bbox.n, lon: clampLon(pt.lon) };
  if (m === dS) return { lat: bbox.s, lon: clampLon(pt.lon) };
  if (m === dE) return { lat: clampLat(pt.lat), lon: bbox.e };
  return                { lat: clampLat(pt.lat), lon: bbox.w };
}

/**
 * Return the intermediate bbox corners plus the snapped `to` point needed to
 * travel *clockwise* around the bbox boundary from `from` to `to`.
 *
 * Clockwise order (north-up): NE(0) → SE(1) → SW(2) → NW(3) → NE …
 *
 * Each boundary point is assigned a clockwise position cpos ∈ [0, 4):
 *   East edge  (lon = bbox.e):  cpos = (bbox.n - lat) / (bbox.n - bbox.s)
 *   South edge (lat = bbox.s):  cpos = 1 + (bbox.e - lon) / (bbox.e - bbox.w)
 *   West edge  (lon = bbox.w):  cpos = 2 + (lat - bbox.s) / (bbox.n - bbox.s)
 *   North edge (lat = bbox.n):  cpos = 3 + (lon - bbox.w) / (bbox.e - bbox.w)
 */
function clockwiseBboxPath(from, to, bbox) {
  const { s, n, w, e } = bbox;
  const CORNERS = [
    { lat: n, lon: e },   // 0 = NE
    { lat: s, lon: e },   // 1 = SE
    { lat: s, lon: w },   // 2 = SW
    { lat: n, lon: w },   // 3 = NW
  ];
  const TOL = 1e-5;

  const cpos = pt => {
    if (Math.abs(pt.lon - e) < TOL) return       (n - pt.lat) / (n - s);
    if (Math.abs(pt.lat - s) < TOL) return 1.0 + (e - pt.lon) / (e - w);
    if (Math.abs(pt.lon - w) < TOL) return 2.0 + (pt.lat - s) / (n - s);
    return                                 3.0 + (pt.lon - w) / (e - w);
  };

  const fromSnap = snapToBbox(from, bbox);
  const toSnap   = snapToBbox(to,   bbox);

  const fromPos   = cpos(fromSnap);
  const origToPos = cpos(toSnap);
  let   toPos     = origToPos;

  if (toPos <= fromPos) {
    // The clockwise path would wrap past the origin.  If from and to land on
    // the same bbox edge (same integer band of cpos), the chain forms a
    // U-shape that enters and exits through one edge.  Going all the way
    // around the perimeter in that case wrongly encloses the entire bbox as
    // land; instead close directly along that edge (short path, no corners).
    if (Math.floor(fromPos) === Math.floor(origToPos)) {
      return [toSnap];
    }
    toPos += 4.0;   // different edges — proceed with full clockwise advance
  }

  // Collect corners that fall in (fromPos, toPos), sorted by clockwise position.
  // We must sort by the shifted cp value — not by ci — because when fromPos > some
  // native corner cpos values, those corners get shifted by +4 and must appear
  // AFTER the unshifted corners in the clockwise traversal.
  const corners = [];
  for (let ci = 0; ci < 4; ci++) {
    let cp = ci;
    while (cp <= fromPos) cp += 4;       // shift corner into (fromPos, ...]
    if (cp < toPos) corners.push({ cp, pt: CORNERS[ci] });
  }
  corners.sort((a, b) => a.cp - b.cp);
  return [...corners.map(c => c.pt), toSnap];
}

/**
 * Stitch individual OSM coastline way-arrays into continuous chains by
 * matching shared endpoints (within ENDPOINT_TOL degrees ≈ 1 m).
 *
 * Each way in `coastWays` is an array of {lat, lon} nodes.
 *
 * IMPORTANT: ways are NEVER reversed during stitching.  OSM coastlines
 * carry a directional sea-left convention; reversing a way swaps its
 * winding-number contribution sign and misclassifies land/sea.  For
 * well-formed OSM data ways always connect end→start (head of next = tail
 * of current), so no reversal is ever required.  If a bad connection
 * (end→end or start→start) is encountered the two ways are left as
 * separate chains — they still contribute with the correct sign.
 *
 * Returns an array of chains (each an array of {lat, lon} nodes).
 */
function stitchCoastWays(coastWays) {
  if (coastWays.length === 0) return [];

  const ENDPOINT_TOL = 1e-5;
  const ptKey = pt => `${pt.lat.toFixed(5)},${pt.lon.toFixed(5)}`;

  // index: key → [{wayIdx, side: 'start'|'end'}]
  const index = new Map();
  const addToIndex = (pt, wayIdx, side) => {
    const k = ptKey(pt);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push({ wayIdx, side });
  };
  for (let i = 0; i < coastWays.length; i++) {
    const w = coastWays[i];
    addToIndex(w[0],          i, 'start');
    addToIndex(w[w.length-1], i, 'end');
  }

  const used   = new Set();
  const chains = [];

  for (let i = 0; i < coastWays.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let chain = [...coastWays[i]];

    // Extend forward from tail: only when next way starts where chain ends
    // (side==='start').  side==='end' would require reversing the way, which
    // flips its winding contribution — skip it and leave as a separate chain.
    for (;;) {
      const k       = ptKey(chain[chain.length - 1]);
      const matches = (index.get(k) || []).filter(m => !used.has(m.wayIdx) && m.side === 'start');
      if (!matches.length) break;
      const { wayIdx } = matches[0];
      used.add(wayIdx);
      chain = chain.concat(coastWays[wayIdx].slice(1));
    }

    // Extend backward from head: only when previous way ends where chain starts
    // (side==='end').  side==='start' would require reversal — skip it.
    for (;;) {
      const k       = ptKey(chain[0]);
      const matches = (index.get(k) || []).filter(m => !used.has(m.wayIdx) && m.side === 'end');
      if (!matches.length) break;
      const { wayIdx } = matches[0];
      used.add(wayIdx);
      chain = coastWays[wayIdx].slice(0, -1).concat(chain);
    }

    chains.push(chain);
  }
  return chains;
}

/** True if the point lies within (or on the boundary of) the bounding box. */
function isInBbox(pt, bbox) {
  return pt.lat >= bbox.s && pt.lat <= bbox.n &&
         pt.lon >= bbox.w && pt.lon <= bbox.e;
}

/**
 * Find where segment p1→p2 first crosses the bbox boundary (t ∈ (0, 1]).
 * Tests all four edges and returns the crossing with the smallest t > 0
 * whose intersection point lies on the bbox edge.  Returns null if none.
 */
function bboxSegmentCrossing(p1, p2, bbox) {
  const dLat = p2.lat - p1.lat;
  const dLon = p2.lon - p1.lon;
  const EPS  = 1e-9;
  const candidates = [];

  const tryEdge = (t, lat, lon) => {
    if (t > EPS && t <= 1 + EPS &&
        lat >= bbox.s - EPS && lat <= bbox.n + EPS &&
        lon >= bbox.w - EPS && lon <= bbox.e + EPS) {
      candidates.push({ t,
        lat: Math.max(bbox.s, Math.min(bbox.n, lat)),
        lon: Math.max(bbox.w, Math.min(bbox.e, lon)) });
    }
  };

  if (Math.abs(dLon) > EPS) {
    const tE = (bbox.e - p1.lon) / dLon;
    tryEdge(tE, p1.lat + tE * dLat, bbox.e);
    const tW = (bbox.w - p1.lon) / dLon;
    tryEdge(tW, p1.lat + tW * dLat, bbox.w);
  }
  if (Math.abs(dLat) > EPS) {
    const tN = (bbox.n - p1.lat) / dLat;
    tryEdge(tN, bbox.n, p1.lon + tN * dLon);
    const tS = (bbox.s - p1.lat) / dLat;
    tryEdge(tS, bbox.s, p1.lon + tS * dLon);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.t - b.t);
  return candidates[0];
}

/**
 * Walk the chain from its *head* (index 0) and return the point where the
 * chain first enters the bbox boundary.  If the first node is already inside,
 * the first node itself is returned.
 */
function findBboxEntryCrossing(chain, bbox) {
  if (isInBbox(chain[0], bbox)) return chain[0];
  for (let i = 0; i < chain.length - 1; i++) {
    if (!isInBbox(chain[i], bbox) && isInBbox(chain[i + 1], bbox)) {
      return bboxSegmentCrossing(chain[i], chain[i + 1], bbox) ?? chain[i + 1];
    }
  }
  return null;
}

/**
 * Walk the chain from its *tail* (last index) and return the point where the
 * chain last exits the bbox boundary.  If the last node is already inside,
 * the last node itself is returned.
 */
function findBboxExitCrossing(chain, bbox) {
  const last = chain[chain.length - 1];
  if (isInBbox(last, bbox)) return last;
  for (let i = chain.length - 1; i > 0; i--) {
    if (isInBbox(chain[i - 1], bbox) && !isInBbox(chain[i], bbox)) {
      return bboxSegmentCrossing(chain[i - 1], chain[i], bbox) ?? chain[i - 1];
    }
  }
  return null;
}

/**
 * Stitch OSM coastline ways into chains, then close every open chain by
 * appending a clockwise bbox-boundary path from the chain's *actual* exit
 * crossing back to its *actual* entry crossing.
 *
 * Using the exact bbox-boundary crossing points (rather than snapping the
 * chain's raw endpoints) is critical for long coastal ways whose endpoints
 * lie far outside the bbox: the endpoint's nearest bbox edge may differ from
 * the edge the chain actually crosses, sending the closure the wrong way
 * around the bbox and enclosing sea as land.
 *
 * Chains that are already closed (islands) are returned unchanged.
 *
 * @param {Array<Array<{lat,lon}>>} coastWays
 * @param {{ s,n,w,e }}             bbox
 * @returns {Array<Array<{lat,lon}>>}  closed rings
 */
function buildClosedCoastRings(coastWays, bbox) {
  const TOL    = 1e-5;
  const chains = stitchCoastWays(coastWays);

  // Second-pass fuzzy stitch: some OSM harbours / bridge gaps leave a chain's
  // tail ~10–100 m from the next chain's head.  The exact-match pass misses
  // these; here we connect interior-endpoint pairs within FUZZY_TOL degrees
  // (~100 m) so that each coast crossing the bbox becomes one continuous chain.
  const FUZZY_TOL = 0.001;
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < chains.length; i++) {
      const tail = chains[i][chains[i].length - 1];
      if (!isInBbox(tail, bbox)) continue;            // only fuzzy-stitch interior tails
      for (let j = 0; j < chains.length; j++) {
        if (j === i) continue;
        const head = chains[j][0];
        if (!isInBbox(head, bbox)) continue;          // only fuzzy-stitch interior heads
        if (Math.abs(tail.lat - head.lat) < FUZZY_TOL &&
            Math.abs(tail.lon - head.lon) < FUZZY_TOL) {
          console.debug(
            `[shore] fuzzy-stitch chain[${i}].tail=(${tail.lat.toFixed(4)},${tail.lon.toFixed(4)}) ` +
            `→ chain[${j}].head=(${head.lat.toFixed(4)},${head.lon.toFixed(4)}) ` +
            `gap=${(Math.hypot(tail.lat-head.lat, tail.lon-head.lon)*111000).toFixed(0)}m`,
          );
          chains[i] = chains[i].concat(chains[j].slice(1));
          chains.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  console.debug(`[shore] stitchCoastWays: ${coastWays.length} ways → ${chains.length} chains (after fuzzy-stitch)`);
  return chains.map((chain, ci) => {
    const head = chain[0];
    const tail = chain[chain.length - 1];
    const closed =
      Math.abs(head.lat - tail.lat) < TOL &&
      Math.abs(head.lon - tail.lon) < TOL;
    if (closed) {
      console.debug(`[shore] chain[${ci}]: already closed (${chain.length} nodes)`);
      return chain;
    }

    // Find the exact points where the chain enters/exits the bbox
    const entryCrossing = findBboxEntryCrossing(chain, bbox);
    const exitCrossing  = findBboxExitCrossing(chain, bbox);

    // Fall back to snapping endpoints if crossing detection fails
    const from = exitCrossing  ?? snapToBbox(tail, bbox);
    const to   = entryCrossing ?? snapToBbox(head, bbox);

    const closure = clockwiseBboxPath(from, to, bbox);
    console.debug(
      `[shore] chain[${ci}]: ${chain.length} nodes, ` +
      `head=(${head.lat.toFixed(4)},${head.lon.toFixed(4)}) ` +
      `tail=(${tail.lat.toFixed(4)},${tail.lon.toFixed(4)})`,
    );
    console.debug(
      `[shore] chain[${ci}]: entry=(${to.lat.toFixed(4)},${to.lon.toFixed(4)}) ` +
      `exit=(${from.lat.toFixed(4)},${from.lon.toFixed(4)}) ` +
      `closure_pts=${closure.length}: ` +
      closure.map(p => `(${p.lat.toFixed(4)},${p.lon.toFixed(4)})`).join(' → '),
    );

    return chain.concat(closure);
  });
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
 * Pure data-processing core: parse a raw Overpass response, build closed rings,
 * and compute the sea-bearing mask.  No side-effects — suitable for unit tests
 * with fixture data captured from `window.SHORE_DEBUG.rawOverpassData`.
 *
 * @param {number}      lat
 * @param {number}      lon
 * @param {object}      data  Raw Overpass JSON ({ elements: [...] })
 * @param {{ s,n,w,e }} bbox  The bounding box used for the query
 * @returns {{
 *   mask:             Float32Array,
 *   coastWays:        Array,
 *   closedCoastRings: Array,
 *   waterPolys:       Array,
 *   hasCoastData:     boolean,
 *   originInWater:    boolean,
 *   originIsLand:     boolean,
 *   bearings:         Array,
 * }}
 */
function processShoreData(lat, lon, data, bbox) {
  console.debug(`[shore] Overpass returned ${data.elements.length} elements for (${lat.toFixed(4)}, ${lon.toFixed(4)})`);

  /* ── Parse elements into polygons and coastline ways ── */

  const waterPolys = [];
  const coastWays  = [];

  for (const el of data.elements) {
    if (el.type === 'way') {
      if (!el.geometry || el.geometry.length < 2) continue;
      const ring = el.geometry.map(g => ({ lat: g.lat, lon: g.lon }));

      if (el.tags?.natural === 'coastline') {
        coastWays.push(ring);
      } else if (ring.length >= 3) {
        // Water-area polygons need ≥ 3 nodes to be a valid polygon
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

  // Drop water polygons whose bounding-box area is < 10 000 m²  (~100 m × 100 m).
  const MIN_WATER_POLY_AREA_M2 = 10_000;
  const waterPolysFiltered = waterPolys.filter(ring => polyBboxAreaM2(ring) >= MIN_WATER_POLY_AREA_M2);

  console.debug(`[shore] Parsed: ${coastWays.length} coastline ways, ${waterPolys.length} water-area polygons (${waterPolys.length - waterPolysFiltered.length} tiny dropped)`);

  const hasCoastData = coastWays.length > 0;

  const closedCoastRings = hasCoastData
    ? buildClosedCoastRings(coastWays, bbox)
    : [];

  const originInWater = waterPolysFiltered.some(p => pointInPoly(lat, lon, p));
  const originIsLand  = isLandByRayCross(lat, lon, closedCoastRings, bbox, hasCoastData);
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

      const isLandCoast = isLandByRayCross(pLat, pLon, closedCoastRings, bbox, hasCoastData);
      const inWaterArea = isLandCoast && waterPolysFiltered.some(p => pointInPoly(pLat, pLon, p));

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
  console.debug('[shore] Full mask (% sea per 10°):', Array.from(mask).map((v,i) => `${i*10}°:${(v*100).toFixed(0)}%`).join(' '));

  return {
    mask,
    coastWays,
    closedCoastRings,
    waterPolys: waterPolysFiltered,
    hasCoastData,
    originInWater,
    originIsLand,
    bearings,
  };
}

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

    const result = processShoreData(lat, lon, data, bbox);
    const { mask, coastWays, closedCoastRings, waterPolys, hasCoastData,
            originInWater, originIsLand, bearings } = result;

    window.SHORE_MASK  = mask;
    window.SHORE_DEBUG = {
      lat, lon,
      bbox,
      rawOverpassData: data,              // capture for fixture-based testing
      elementCount:   data.elements.length,
      coastWayCount:  coastWays.length,
      waterPolyCount: waterPolys.length,
      hasCoastData,
      originInWater,
      originIsLand,
      coastWays,                          // raw ways for debug-map drawing
      closedCoastRings,                   // stitched + closed rings used for classification
      waterPolys,                         // water-area polys for debug-map drawing (tiny ones dropped)
      bearings,
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
 * @param {number[]} [selectedBearings]  bearings currently selected in the dialog (snapped to 10°)
 */
function drawShoreCompass(ctx, cx, cy, radius, mask, windDeg, isGood, selectedBearings) {
  const TWO_PI  = Math.PI * 2;
  const DEG2RAD = Math.PI / 180;
  const innerR  = radius * 0.28;
  const sectors = SHORE_BEARINGS;
  const step    = TWO_PI / sectors;        // radians per sector
  const selSet  = new Set((selectedBearings || []).map(d => snapBearing(d)));

  ctx.save();

  // ── Background ring ──
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.fillStyle = 'rgba(30,42,56,0.88)';
  ctx.fill();

  // ── Sectors ──
  const rimW    = Math.max(3, radius * 0.10);   // width of the sea/land rim band
  const rimR    = radius - 1;                   // outer edge of rim
  const fillR   = rimR - rimW;                  // inner edge of rim = outer edge of fill

  for (let b = 0; b < sectors; b++) {
    const bearing    = b * 10;
    // Canvas 0° = right (East), compass 0° = up (North) → subtract 90°
    const startAngle = (bearing - 5 - 90) * DEG2RAD;
    const endAngle   = startAngle + step;
    const isSelected = selSet.has(bearing);

    // ── Fill: bright green if selected, dark otherwise ──
    const fillColor = isSelected ? 'rgba(0,220,160,0.88)' : 'rgba(22,34,48,0.92)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, fillR, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // ── Rim band: sea = blue, land = brown, no mask = dark grey ──
    if (mask) {
      const isSea = mask[b] >= SHORE_SEA_THRESH;
      ctx.beginPath();
      ctx.arc(cx, cy, rimR,  startAngle, endAngle);
      ctx.arc(cx, cy, fillR, endAngle,   startAngle, true);  // inner arc reversed
      ctx.closePath();
      ctx.fillStyle = isSea ? 'rgba(60,160,255,0.80)' : 'rgba(180,110,40,0.80)';
      ctx.fill();
    }

    // ── Thin sector dividers ──
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const dx = Math.cos(startAngle) * rimR;
    const dy = Math.sin(startAngle) * rimR;
    ctx.lineTo(cx + dx, cy + dy);
    ctx.strokeStyle = 'rgba(10,18,28,0.7)';
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



