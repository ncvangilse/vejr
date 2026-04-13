/* ══════════════════════════════════════════════════════════════════════════
   SHORE MASK  –  land/sea analysis for kitesurfing direction suitability
   ══════════════════════════════════════════════════════════════════════════
   Algorithm
   ─────────
   For each of 36 bearings (0°, 10°, …, 350°) cast 5 sample points at
   1 km, 2 km, 3 km, 4 km and 5 km from the origin.  A bearing is
   classified as "sea" (steady wind, good for kiting) when the majority
   of its samples fall over open water.

   Data source – Terrascope WMS (ESA WorldCover 10 m, 2021 v200)
   ─────────────────────────────────────────────────────────────────────────
   A single WMS 1.1.1 GetMap request fetches a 512 × 512 PNG covering the
   ~12 km × 12 km bounding box around the location, rendered with the
   official ESA WorldCover classification palette.  Each of the 180 bearing
   sample points is mapped to a pixel and its RGB matched against the known
   class colours:

     • Class 80  Permanent water bodies  rgb(  0, 100, 200)  → water
     • Class 90  Herbaceous wetland      rgb(  0, 150, 160)  → water
     • All other classes                                      → land

   A Euclidean RGB distance < WMS_COLOR_TOLERANCE is used to tolerate
   minor nearest-neighbour resampling boundary artefacts.

   To verify / update the WMS layer name:
     https://services.terrascope.be/wms/v2?SERVICE=WMS&REQUEST=GetCapabilities
   (search for "WORLDCOVER" in the XML; confirmed layer: WORLDCOVER_2021_MAP)

   Result
   ──────
   `window.SHORE_MASK`  – Float32Array(36) where index i covers bearing
   i*10°.  Value is the fraction of samples (0–1) that are over water.
   A threshold of 0.5 means the majority are water.

   `window.SHORE_STATUS` – object { state, msg }
     state: 'ok' | 'loading' | 'calculating' | 'error' | 'inland'
══════════════════════════════════════════════════════════════════════════ */

/* ── bearing / sample constants ─────────────────────────────────────────── */
const SHORE_BEARINGS   = 36;     // one every 10°
const SHORE_SAMPLES    = 5;      // distances: 1, 2, 3, 4, 5 km
const SHORE_MAX_KM     = 5;
const SHORE_SEA_THRESH = 0.5;   // fraction of samples that must be water

/* ── WMS constants ──────────────────────────────────────────────────────── */
const WMS_BASE    = 'https://services.terrascope.be/wms/v2';
const WMS_LAYER   = 'WORLDCOVER_2021_MAP';   // verified from GetCapabilities
const WMS_STYLE   = 'worldcover.txt';        // only style listed; omit to use default
const WMS_WIDTH   = 512;
const WMS_HEIGHT  = 512;
const WMS_TIMEOUT = 20_000;  // ms

// Official ESA WorldCover class colours for water detection.
// Source: https://esa-worldcover.org/en/data-access (Product User Manual)
const WMS_WATER_COLORS = [
  { r:   0, g: 100, b: 200 },  // class 80 – Permanent water bodies
  { r:   0, g: 150, b: 160 },  // class 90 – Herbaceous wetland
];
const WMS_COLOR_TOLERANCE = 40;  // max Euclidean RGB distance for a colour match

/* ── public state ───────────────────────────────────────────────────────── */
window.SHORE_MASK   = null;       // Float32Array(36) or null
window.SHORE_STATUS = { state: 'idle', msg: '' };
window.SHORE_DEBUG  = null;       // debug snapshot set after each analyseShore()

/* ══════════════════════════════════════════════════════════════════════════
   GEO HELPERS
══════════════════════════════════════════════════════════════════════════ */

/**
 * Move `distKm` km in direction `bearingDeg` from (lat, lon).
 * Returns {lat, lon}.  Uses flat-earth approximation accurate to ~0.05 % at 5 km.
 */
function destPoint(lat, lon, bearingDeg, distKm) {
  const R    = 6371;
  const b    = bearingDeg * Math.PI / 180;
  const d    = distKm / R;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) +
                          Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1),
                                  Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

/** Expand bounding box by `padKm` km on each side. */
function expandBbox(lat, lon, padKm) {
  const dLat = padKm / 111.32;
  const dLon = padKm / (111.32 * Math.cos(lat * Math.PI / 180));
  return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
}

/* ══════════════════════════════════════════════════════════════════════════
   MERCATOR PROJECTION HELPERS
   ──────────────────────────────────────────────────────────────────────────
   The WORLDCOVER_2021_MAP layer only supports EPSG:3857 (Web Mercator).
   We keep all internal geometry in geographic coordinates (lat/lon) and
   convert to Mercator only when building the WMS URL and mapping pixels.
══════════════════════════════════════════════════════════════════════════ */

/**
 * Convert geographic coordinates to Web Mercator (EPSG:3857) metres.
 * @param {number} lat  – decimal degrees
 * @param {number} lon  – decimal degrees
 * @returns {{ x: number, y: number }}  metres
 */
function latLonToMercator(lat, lon) {
  const R = 6378137;  // WGS84 equatorial radius
  const x = lon * Math.PI / 180 * R;
  const y = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
  return { x, y };
}

/**
 * Convert a geographic bounding box to a Web Mercator bounding box.
 * @param {{ s, n, w, e }} bbox  – decimal degrees
 * @returns {{ west, south, east, north }}  metres
 */
function bboxToMercator(bbox) {
  const sw = latLonToMercator(bbox.s, bbox.w);
  const ne = latLonToMercator(bbox.n, bbox.e);
  return { west: sw.x, south: sw.y, east: ne.x, north: ne.y };
}

/* ══════════════════════════════════════════════════════════════════════════
   WMS URL BUILDER
══════════════════════════════════════════════════════════════════════════ */

/**
 * Build a WMS 1.1.1 GetMap URL for the ESA WorldCover classification layer.
 * Uses EPSG:3857 (Web Mercator) — the only projection the layer supports.
 * BBOX order for WMS 1.1.1: minx,miny,maxx,maxy (= west,south,east,north in metres).
 *
 * @param {{ s, n, w, e }} bbox  geographic bounding box (lat/lon degrees)
 * @param {number} [width]       defaults to WMS_WIDTH
 * @param {number} [height]      defaults to WMS_HEIGHT
 * @returns {string}
 */
function buildWmsUrl(bbox, width, height) {
  if (width  === undefined) width  = WMS_WIDTH;
  if (height === undefined) height = WMS_HEIGHT;
  const mb = bboxToMercator(bbox);
  const params = new URLSearchParams({
    SERVICE:     'WMS',
    VERSION:     '1.1.1',
    REQUEST:     'GetMap',
    LAYERS:      WMS_LAYER,
    STYLES:      WMS_STYLE,
    FORMAT:      'image/png',
    TRANSPARENT: 'FALSE',
    SRS:         'EPSG:3857',
    BBOX:        `${mb.west},${mb.south},${mb.east},${mb.north}`,
    WIDTH:       String(width),
    HEIGHT:      String(height),
  });
  return `${WMS_BASE}?${params}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   PIXEL CLASSIFICATION
══════════════════════════════════════════════════════════════════════════ */

/**
 * Return true if the RGB pixel matches any ESA WorldCover water class
 * within WMS_COLOR_TOLERANCE Euclidean distance.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {boolean}
 */
function classifyWmsPixel(r, g, b) {
  for (const c of WMS_WATER_COLORS) {
    const dist = Math.sqrt((r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2);
    if (dist < WMS_COLOR_TOLERANCE) return true;
  }
  return false;
}

/**
 * Convert geographic (lat, lon) to integer pixel column/row within the WMS
 * image for the given bounding box.
 *
 * The WMS image is in EPSG:3857 (Web Mercator), so both the point and the
 * bbox are projected to Mercator before computing pixel coordinates.
 * WMS images are north-up: row 0 = north edge, row height−1 = south edge.
 *
 * Returned px/py may lie outside [0, width) × [0, height) for points outside
 * the bbox — callers must bounds-check before reading pixels.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {{ s, n, w, e }} bbox  geographic bbox (lat/lon degrees)
 * @param {number} width
 * @param {number} height
 * @returns {{ px: number, py: number }}
 */
function latLonToPixel(lat, lon, bbox, width, height) {
  const mb      = bboxToMercator(bbox);
  const { x, y } = latLonToMercator(lat, lon);
  const px = (x - mb.west)  / (mb.east  - mb.west)  * width;
  const py = (mb.north - y) / (mb.north - mb.south) * height;
  return { px: Math.floor(px), py: Math.floor(py) };
}

/* ══════════════════════════════════════════════════════════════════════════
   CORE MASK COMPUTATION
══════════════════════════════════════════════════════════════════════════ */

/**
 * Compute the 36-bearing water mask by reading pixels from the WMS image at
 * each bearing sample point.
 *
 * `pixelReader(px, py)` must return `{ r, g, b }` for in-bounds pixels.
 * Points outside the image are treated as water (open sea beyond the bbox).
 *
 * @param {number}   lat
 * @param {number}   lon
 * @param {{ s, n, w, e }} bbox
 * @param {number}   width        image width in pixels
 * @param {number}   height       image height in pixels
 * @param {function} pixelReader  (px: number, py: number) => { r, g, b }
 * @returns {{ mask: Float32Array, bearings: Array }}
 */
function processWmsPixels(lat, lon, bbox, width, height, pixelReader) {
  const mask     = new Float32Array(SHORE_BEARINGS);
  const bearings = [];

  for (let b = 0; b < SHORE_BEARINGS; b++) {
    const bearing  = b * 10;
    let   seaCount = 0;
    const sampleLog    = [];
    const debugSamples = [];

    for (let s = 1; s <= SHORE_SAMPLES; s++) {
      const distKm     = (s / SHORE_SAMPLES) * SHORE_MAX_KM;
      const pt         = destPoint(lat, lon, bearing, distKm);
      const { px, py } = latLonToPixel(pt.lat, pt.lon, bbox, width, height);

      let isSea, reason;
      if (px < 0 || px >= width || py < 0 || py >= height) {
        isSea  = true;
        reason = 'oob:sea';  // outside image → open water
      } else {
        const { r, g, b: blue } = pixelReader(px, py);
        isSea  = classifyWmsPixel(r, g, blue);
        reason = isSea ? 'wms:water' : 'wms:land';
      }

      sampleLog.push(`${distKm.toFixed(1)}km→${isSea ? 'SEA' : 'LND'}(${reason})`);
      debugSamples.push({ distKm, lat: pt.lat, lon: pt.lon, px, py, isSea, reason });
      if (isSea) seaCount++;
    }

    mask[b] = seaCount / SHORE_SAMPLES;
    bearings.push({ bearing, seaFrac: mask[b], samples: debugSamples });
    console.debug(`[shore] ${String(bearing).padStart(3)}°: ` +
      `${(mask[b] * 100).toFixed(0).padStart(3)}% sea | ${sampleLog.join('  ')}`);
  }

  const seaBearingCount = Array.from(mask).filter(v => v >= SHORE_SEA_THRESH).length;
  console.debug(`[shore] Summary: ${seaBearingCount}/${SHORE_BEARINGS} ` +
    `bearings ≥ ${SHORE_SEA_THRESH * 100}% sea`);
  console.debug('[shore] Full mask (% water per 10°):',
    Array.from(mask).map((v, i) => `${i * 10}°:${(v * 100).toFixed(0)}%`).join(' '));

  return { mask, bearings };
}

/* ══════════════════════════════════════════════════════════════════════════
   FETCH HELPER
══════════════════════════════════════════════════════════════════════════ */

/** Fetch with a manual AbortController timeout (works on all browsers). */
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the WMS PNG tile and decode it to an ImageData object.
 *
 * Prefers OffscreenCanvas + createImageBitmap (no DOM required).
 * Falls back to Image + document canvas on older browsers.
 *
 * @param {{ s, n, w, e }} bbox
 * @param {number} width
 * @param {number} height
 * @returns {Promise<ImageData>}
 */
async function fetchWmsImageData(bbox, width, height) {
  const url = buildWmsUrl(bbox, width, height);
  console.debug('[shore] WMS request:', url);

  const response = await fetchWithTimeout(url, { mode: 'cors' }, WMS_TIMEOUT);
  if (!response.ok) throw new Error(`WMS HTTP ${response.status}`);

  // Guard against WMS exception documents returned with HTTP 200
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('image/')) {
    const text = await response.text();
    throw new Error(`WMS returned non-image response: ${text.slice(0, 300)}`);
  }

  const blob = await response.blob();

  // ── OffscreenCanvas path (Chrome 69+, Firefox 105+, Safari 16.4+) ──────
  if (typeof OffscreenCanvas !== 'undefined' &&
      typeof createImageBitmap !== 'undefined') {
    const bitmap    = await createImageBitmap(blob);
    const offscreen = new OffscreenCanvas(width, height);
    const ctx       = offscreen.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }

  // ── Fallback: blob URL → Image → document canvas ─────────────────────
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(blob);
    const img     = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      const canvas  = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const ctx     = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      try {
        resolve(ctx.getImageData(0, 0, width, height));
      } catch (e) {
        reject(new Error('Canvas tainted – WMS CORS headers missing'));
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('WMS image load failed'));
    };
    img.src = blobUrl;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   OVERPASS VECTOR DATA  –  for debug visualisation only
   ──────────────────────────────────────────────────────────────────────────
   Fetched in parallel with the WMS request and stored in SHORE_DEBUG.
   Never used for the actual sea-bearing classification.
══════════════════════════════════════════════════════════════════════════ */

const OVERPASS_VIZ_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_VIZ_TIMEOUT = 20_000;  // ms

function buildOverpassVizQuery(bbox) {
  const b = `${bbox.s},${bbox.w},${bbox.n},${bbox.e}`;
  return `[out:json][timeout:15];
(
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["natural"="coastline"](${b});
);
out geom;`;
}

async function fetchOverpassViz(bbox) {
  const body = 'data=' + encodeURIComponent(buildOverpassVizQuery(bbox));
  const opts = {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  };
  for (const endpoint of OVERPASS_VIZ_ENDPOINTS) {
    try {
      const r = await fetchWithTimeout(endpoint, opts, OVERPASS_VIZ_TIMEOUT);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      console.debug('[shore] overpass-viz', endpoint, e.message ?? e);
    }
  }
  return null;
}

function parseOverpassViz(data) {
  if (!data) return { coastWays: [], waterPolys: [] };
  const coastWays = [], waterPolys = [];
  for (const el of data.elements) {
    if (el.type === 'way' && el.geometry?.length >= 2) {
      const ring = el.geometry.map(g => ({ lat: g.lat, lon: g.lon }));
      if (el.tags?.natural === 'coastline') coastWays.push(ring);
      else if (ring.length >= 3) waterPolys.push(ring);
    } else if (el.type === 'relation' && el.members) {
      for (const m of el.members) {
        if (m.type === 'way' && m.role === 'outer' && m.geometry?.length >= 3)
          waterPolys.push(m.geometry.map(g => ({ lat: g.lat, lon: g.lon })));
      }
    }
  }
  return { coastWays, waterPolys };
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
  window.SHORE_STATUS = { state: 'loading', msg: 'Fetching land cover data…' };
  window.SHORE_MASK   = null;
  if (onDone) onDone();

  try {
    const bbox      = expandBbox(lat, lon, SHORE_MAX_KM + 1);
    const imageData = await fetchWmsImageData(bbox, WMS_WIDTH, WMS_HEIGHT);
    const { width, height } = imageData;

    window.SHORE_STATUS = { state: 'calculating', msg: 'Calculating sea bearings…' };
    if (onDone) onDone();

    const pixelReader = (px, py) => {
      const i = (py * width + px) * 4;
      return {
        r: imageData.data[i],
        g: imageData.data[i + 1],
        b: imageData.data[i + 2],
      };
    };

    const { mask, bearings } = processWmsPixels(lat, lon, bbox, width, height, pixelReader);

    // Classify origin pixel for debug display
    const originPx = latLonToPixel(lat, lon, bbox, width, height);
    let originIsWater = false;
    if (originPx.px >= 0 && originPx.px < width &&
        originPx.py >= 0 && originPx.py < height) {
      const oi = (originPx.py * width + originPx.px) * 4;
      originIsWater = classifyWmsPixel(
        imageData.data[oi], imageData.data[oi + 1], imageData.data[oi + 2]);
    }

    const mb = bboxToMercator(bbox);
    window.SHORE_MASK  = mask;
    window.SHORE_DEBUG = {
      lat, lon, bbox,
      mercatorBbox:   mb,
      metersPerPixel: (mb.east - mb.west) / width,
      wmsUrl:         buildWmsUrl(bbox, WMS_WIDTH, WMS_HEIGHT),
      originPx,
      originIsWater,
      width, height,
      imageData,
      bearings,
      // Vector fields populated asynchronously below
      vectorState: 'loading',
      coastWays:   [],
      waterPolys:  [],
    };

    // Fire-and-forget: fetch Overpass vector data for debug visualisation only.
    // Does not block the mask result or onDone callback.
    fetchOverpassViz(bbox).then(raw => {
      if (!window.SHORE_DEBUG) return;
      const { coastWays, waterPolys } = parseOverpassViz(raw);
      window.SHORE_DEBUG.coastWays   = coastWays;
      window.SHORE_DEBUG.waterPolys  = waterPolys;
      window.SHORE_DEBUG.vectorState = raw ? 'ok' : 'error';
      console.debug(`[shore] vector viz: ${coastWays.length} coast ways, ${waterPolys.length} water polys`);
      window.dispatchEvent(new CustomEvent('shore-vector-ready'));
    }).catch(() => {
      if (window.SHORE_DEBUG) window.SHORE_DEBUG.vectorState = 'error';
      window.dispatchEvent(new CustomEvent('shore-vector-ready'));
    });

    const hasAnyWater   = Array.from(mask).some(v => v > 0);
    const anySeaBearing = Array.from(mask).some(v => v >= SHORE_SEA_THRESH);

    window.SHORE_STATUS = !hasAnyWater
      ? { state: 'inland', msg: 'No water within 5 km – location appears inland' }
      : !anySeaBearing
        ? { state: 'ok', msg: 'Coast nearby but no open-sea bearing found' }
        : { state: 'ok', msg: '' };

  } catch (e) {
    console.warn('[shore] WMS analysis failed:', e);
    window.SHORE_MASK = null;
    const isTimeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError'
                            || /timeout/i.test(e.message));
    window.SHORE_STATUS = {
      state: 'error',
      msg:   isTimeout ? 'Land cover fetch timed out' : 'Land cover fetch failed',
    };
  }

  if (onDone) onDone();
}

/* ══════════════════════════════════════════════════════════════════════════
   SHORE COMPASS WIDGET  –  draws a small polar rose showing sea bearings
══════════════════════════════════════════════════════════════════════════ */

/**
 * Draw the shore-mask compass into a <canvas> element.
 * Sectors coloured blue = water, sand = land, grey = unknown.
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
  const step    = TWO_PI / sectors;
  const selSet  = new Set((selectedBearings || []).map(d => snapBearing(d)));

  ctx.save();

  // ── Background ring ──
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.fillStyle = 'rgba(30,42,56,0.88)';
  ctx.fill();

  // ── Sectors ──
  const rimW  = Math.max(3, radius * 0.10);
  const rimR  = radius - 1;
  const fillR = rimR - rimW;

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
      const isWater = mask[b] >= SHORE_SEA_THRESH;
      ctx.beginPath();
      ctx.arc(cx, cy, rimR,  startAngle, endAngle);
      ctx.arc(cx, cy, fillR, endAngle,   startAngle, true);
      ctx.closePath();
      ctx.fillStyle = isWater ? 'rgba(60,160,255,0.80)' : 'rgba(180,110,40,0.80)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(startAngle) * rimR, cy + Math.sin(startAngle) * rimR);
    ctx.strokeStyle = 'rgba(10,18,28,0.7)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // ── Inner hub ──
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, TWO_PI);
  ctx.fillStyle = '#1a2430';
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,160,200,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Cardinal labels ──
  const CARDS = [
    { label: 'N', deg:   0 }, { label: 'E', deg:  90 },
    { label: 'S', deg: 180 }, { label: 'W', deg: 270 },
  ];
  ctx.font         = `600 ${Math.max(7, radius * 0.13)}px 'IBM Plex Sans', sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  CARDS.forEach(({ label, deg }) => {
    const angle = (deg - 90) * DEG2RAD;
    ctx.fillStyle = '#c8d8e8';
    ctx.fillText(label, cx + Math.cos(angle) * radius * 0.80,
                        cy + Math.sin(angle) * radius * 0.80);
  });

  // ── Wind direction arrow ──
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
    ctx.lineTo(tipX - headLen * Math.cos(headAngle - Math.PI / 6),
               tipY - headLen * Math.sin(headAngle - Math.PI / 6));
    ctx.lineTo(tipX - headLen * Math.cos(headAngle + Math.PI / 6),
               tipY - headLen * Math.sin(headAngle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();

    if (isGood) {
      ctx.shadowColor = '#00e8b0';
      ctx.shadowBlur  = 8;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }
  }

  // ── Status overlay when no mask ──
  if (!mask) {
    ctx.fillStyle    = 'rgba(180,190,200,0.7)';
    ctx.font         = `${Math.max(8, radius * 0.12)}px 'IBM Plex Sans', sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const state = window.SHORE_STATUS?.state;
    const msg = state === 'loading'     ? 'Fetching…'
              : state === 'calculating' ? 'Calculating…'
              : state === 'error'       ? 'Unavailable'
              : '';
    if (msg) ctx.fillText(msg, cx, cy);
  }

  // ── Outer border ──
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TWO_PI);
  ctx.strokeStyle = 'rgba(120,160,200,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

/* ══════════════════════════════════════════════════════════════════════════
   KITE-DIRECTION INTEGRATION
══════════════════════════════════════════════════════════════════════════ */

/** Returns true if bearing `deg` faces water. No data → don't restrict. */
function isSeaBearing(deg) {
  if (!window.SHORE_MASK) return true;
  const idx = Math.round(((deg % 360) + 360) % 360 / 10) % SHORE_BEARINGS;
  return window.SHORE_MASK[idx] >= SHORE_SEA_THRESH;
}

/* ── Public API ─────────────────────────────────────────────────────────── */
window.analyseShore     = analyseShore;
window.drawShoreCompass = drawShoreCompass;
window.isSeaBearing     = isSeaBearing;



