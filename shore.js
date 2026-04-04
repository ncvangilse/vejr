/* ══════════════════════════════════════════════════════════════════════════
   SHORE MASK  –  flat-fetch terrain analysis for kitesurfing suitability
   ══════════════════════════════════════════════════════════════════════════
   Algorithm
   ─────────
   For each of 36 bearings (0°, 10°, …, 350°) cast 5 sample points at
   1 km, 2 km, 3 km, 4 km and 5 km from the origin.  A bearing is
   classified as "flat-fetch" (steady wind, good for kiting) when the
   majority of its samples land over open water OR very flat low terrain.

   Data source – AWS Terrain Tiles (Terrarium format)
   ───────────────────────────────────────────────────
   URL pattern:
     https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png

   Each pixel encodes elevation as:
     elevation (m) = R×256 + G + B/256 − 32768

   Ocean areas use ETOPO1 bathymetry (negative elevations).
   Land areas use SRTM (a DSM that captures buildings and vegetation).
   No API key required.

   At zoom 12 each tile covers ~10 km × ~10 km at 55°N (~40 m/pixel),
   so the entire 5 km analysis radius fits in 1–4 tiles.

   Flat-fetch classification per sample point
   ──────────────────────────────────────────
   elevation < 0                                       → flat-fetch (open ocean)
   elevation ≥ 0 AND std_dev(3×3 neighbourhood) < 5 m
               AND elevation < 25 m                   → flat-fetch (flat low land)
   otherwise                                           → not flat-fetch

   Result
   ──────
   `window.SHORE_MASK`  – Float32Array(36) where index i covers bearing
   i*10°.  Value is the fraction of samples (0 – 1) that are flat-fetch.
   A threshold of 0.5 means the majority are flat-fetch.

   `window.SHORE_STATUS` – object { state, msg }
     state: 'ok' | 'loading' | 'error' | 'inland'
══════════════════════════════════════════════════════════════════════════ */

/* ── constants ─────────────────────────────────────────────────────────── */
const SHORE_BEARINGS      = 36;      // one every 10°
const SHORE_SAMPLES       = 5;       // distances: 1,2,3,4,5 km
const SHORE_MAX_KM        = 5;
const SHORE_SEA_THRESH    = 0.5;    // fraction of samples that must be flat-fetch

const TERRAIN_TILE_ZOOM   = 12;      // ~40 m/px at 55°N; covers ~10 km per tile
const FLAT_STD_THRESH     = 5;       // m — DSM std dev threshold for flat land
const FLAT_ELEV_MAX       = 25;      // m — max elevation for flat-land classification
const TERRAIN_TILE_URL    = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_FETCH_TIMEOUT  = 15000;   // ms

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

/* ══════════════════════════════════════════════════════════════════════════
   TILE COORDINATE MATH  (Web Mercator / EPSG:3857)
══════════════════════════════════════════════════════════════════════════ */

/**
 * Convert (lat, lon) to Slippy Map tile coordinates at the given zoom level.
 * Returns integer {x, y} tile indices.
 */
function latLonToTileXY(lat, lon, zoom) {
  const n      = 2 ** zoom;
  const x      = Math.floor((lon + 180) / 360 * n);
  const sinLat = Math.sin(lat * Math.PI / 180);
  const y      = Math.floor(
    (1 - Math.log((1 + sinLat) / (1 - sinLat)) / (2 * Math.PI)) / 2 * n
  );
  return { x, y };
}

/**
 * Convert (lat, lon) to pixel coordinates (0–255) within tile (tileX, tileY)
 * at the given zoom level.  Clamps to [0, 255].
 */
function latLonToPixel(lat, lon, tileX, tileY, zoom) {
  const n      = 2 ** zoom;
  const sinLat = Math.sin(lat * Math.PI / 180);
  const px = ((lon + 180) / 360 * n - tileX) * 256;
  const py = (
    (1 - Math.log((1 + sinLat) / (1 - sinLat)) / (2 * Math.PI)) / 2 * n - tileY
  ) * 256;
  return {
    px: Math.max(0, Math.min(255, Math.floor(px))),
    py: Math.max(0, Math.min(255, Math.floor(py))),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   TERRARIUM ELEVATION DECODING
══════════════════════════════════════════════════════════════════════════ */

/**
 * Decode a Terrarium-format RGB pixel to metres.
 * elevation = R×256 + G + B/256 − 32768
 */
function decodeTerrariumRGB(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

/* ══════════════════════════════════════════════════════════════════════════
   TILE FETCHING
══════════════════════════════════════════════════════════════════════════ */

/**
 * Fetch a single Terrarium PNG tile and return its ImageData (256×256 RGBA).
 * Uses a hidden <img> + <canvas> — no external libraries needed.
 */
function fetchTerrainTile(tileX, tileY, zoom) {
  return new Promise((resolve, reject) => {
    const url   = `${TERRAIN_TILE_URL}/${zoom}/${tileX}/${tileY}.png`;
    const img   = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(
      () => reject(new Error(`Tile ${zoom}/${tileX}/${tileY} timed out`)),
      TILE_FETCH_TIMEOUT
    );
    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, 256, 256));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Tile ${zoom}/${tileX}/${tileY} failed to load`));
    };
    img.src = url;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   ELEVATION SAMPLING
══════════════════════════════════════════════════════════════════════════ */

/**
 * Read the elevation (m) at pixel (px, py) from a decoded tile ImageData.
 * Clamps coordinates to [0, 255].
 */
function sampleElevation(imageData, px, py) {
  const cPx = Math.max(0, Math.min(255, px));
  const cPy = Math.max(0, Math.min(255, py));
  const i   = (cPy * 256 + cPx) * 4;
  return decodeTerrariumRGB(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
}

/**
 * Compute the standard deviation of elevations in a 3×3 pixel neighbourhood
 * centred on (px, py).  Neighbours outside tile bounds are clamped.
 */
function neighbourhoodStdDev(imageData, px, py) {
  const elevs = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      elevs.push(sampleElevation(imageData, px + dx, py + dy));
    }
  }
  const mean     = elevs.reduce((s, e) => s + e, 0) / elevs.length;
  const variance = elevs.reduce((s, e) => s + (e - mean) ** 2, 0) / elevs.length;
  return Math.sqrt(variance);
}

/* ══════════════════════════════════════════════════════════════════════════
   FLAT-FETCH CLASSIFICATION
══════════════════════════════════════════════════════════════════════════ */

/**
 * Classify a sample point as flat-fetch (returns true) or not (returns false).
 *
 * The std-dev threshold is read from `window.SHORE_FLAT_STD_THRESH` at call
 * time so the UI slider can change it without re-fetching tiles.
 *
 * @param {number} elevation  Centre pixel elevation in metres
 * @param {number} stdDev     Standard deviation of 3×3 neighbourhood in metres
 */
function classifyFlatFetch(elevation, stdDev) {
  const stdThresh = (typeof window !== 'undefined' && window.SHORE_FLAT_STD_THRESH != null)
    ? window.SHORE_FLAT_STD_THRESH
    : FLAT_STD_THRESH;
  if (elevation < 0) return true;                                     // open ocean
  if (stdThresh > 0 && elevation < FLAT_ELEV_MAX && stdDev < stdThresh) return true; // flat low land
  return false;
}

/**
 * Re-classify all sample points in SHORE_DEBUG using the current
 * `window.SHORE_FLAT_STD_THRESH` and update SHORE_MASK in-place.
 * Returns true if debug data was available and the mask was updated.
 * This lets the sensitivity slider take effect without re-fetching tiles.
 */
function recomputeShoreFromDebug() {
  const d = window.SHORE_DEBUG;
  if (!d || !d.bearings) return false;

  const mask = new Float32Array(SHORE_BEARINGS);
  for (let b = 0; b < SHORE_BEARINGS; b++) {
    const row = d.bearings[b];
    if (!row) continue;
    let flatFetchCount = 0;
    for (const s of row.samples) {
      const isFlatFetch = classifyFlatFetch(s.elevation, s.stdDev);
      s.isFlatFetch = isFlatFetch;
      s.isSea       = isFlatFetch;
      s.reason      = s.elevation < 0 ? 'sea' : isFlatFetch ? 'flat-land' : 'hilly';
      if (isFlatFetch) flatFetchCount++;
    }
    mask[b] = flatFetchCount / SHORE_SAMPLES;
    row.seaFrac = mask[b];
  }

  window.SHORE_MASK = mask;

  const anyFlatFetch = Array.from(mask).some(v => v >= SHORE_SEA_THRESH);
  const anySea       = d.bearings.some(row => row.samples.some(s => s.elevation < 0));
  if (!anyFlatFetch && !anySea) {
    window.SHORE_STATUS = {
      state: 'inland',
      msg:   'No open water or flat terrain within 5 km – location appears inland',
    };
  } else {
    window.SHORE_STATUS = { state: 'ok', msg: '' };
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN ANALYSIS FUNCTION
══════════════════════════════════════════════════════════════════════════ */

/**
 * Analyse the terrain around (lat, lon) within SHORE_MAX_KM using
 * Terrarium elevation tiles.
 * Populates window.SHORE_MASK and window.SHORE_STATUS, then calls onDone().
 *
 * @param {number}   lat
 * @param {number}   lon
 * @param {function} onDone  – called when the mask is ready (or on error)
 */
async function analyseShore(lat, lon, onDone) {
  window.SHORE_STATUS = { state: 'loading', msg: 'Fetching elevation tiles…' };
  window.SHORE_MASK   = null;
  if (onDone) onDone();

  try {
    /* ── Determine which tiles cover the analysis area ── */
    // Generate all sample points to find their tiles
    const tileSet = new Map(); // key: "z/x/y" → {x, y}
    for (let b = 0; b < SHORE_BEARINGS; b++) {
      for (let s = 1; s <= SHORE_SAMPLES; s++) {
        const distKm = (s / SHORE_SAMPLES) * SHORE_MAX_KM;
        const pt     = destPoint(lat, lon, b * 10, distKm);
        const { x, y } = latLonToTileXY(pt.lat, pt.lon, TERRAIN_TILE_ZOOM);
        tileSet.set(`${TERRAIN_TILE_ZOOM}/${x}/${y}`, { x, y });
      }
    }
    // Also include the tile containing the origin
    const originTile = latLonToTileXY(lat, lon, TERRAIN_TILE_ZOOM);
    tileSet.set(`${TERRAIN_TILE_ZOOM}/${originTile.x}/${originTile.y}`, originTile);

    const tileKeys   = [...tileSet.keys()];
    const tileCoords = [...tileSet.values()];
    console.debug(`[shore] Fetching ${tileKeys.length} tile(s):`, tileKeys.join(', '));

    /* ── Fetch all tiles in parallel ── */
    const tileImages = await Promise.all(
      tileCoords.map(({ x, y }) => fetchTerrainTile(x, y, TERRAIN_TILE_ZOOM))
    );

    // Build a lookup map: "x/y" → ImageData
    const tileMap = new Map();
    tileCoords.forEach(({ x, y }, i) => tileMap.set(`${x}/${y}`, tileImages[i]));

    window.SHORE_STATUS = { state: 'calculating', msg: 'Calculating flat-fetch bearings…' };
    if (onDone) onDone();

    /* ── Classify each sample point ── */
    const mask          = new Float32Array(SHORE_BEARINGS);
    const debugBearings = [];

    for (let b = 0; b < SHORE_BEARINGS; b++) {
      const bearing       = b * 10;
      let flatFetchCount  = 0;
      const debugSamples  = [];

      for (let s = 1; s <= SHORE_SAMPLES; s++) {
        const distKm        = (s / SHORE_SAMPLES) * SHORE_MAX_KM;
        const pt            = destPoint(lat, lon, bearing, distKm);
        const { x: tx, y: ty } = latLonToTileXY(pt.lat, pt.lon, TERRAIN_TILE_ZOOM);
        const imageData     = tileMap.get(`${tx}/${ty}`);

        let elevation, stdDev, isFlatFetch, reason;

        if (!imageData) {
          // Tile failed to load — treat as unknown (conservative: not flat-fetch)
          elevation   = NaN;
          stdDev      = NaN;
          isFlatFetch = false;
          reason      = 'tile-missing';
        } else {
          const { px, py } = latLonToPixel(pt.lat, pt.lon, tx, ty, TERRAIN_TILE_ZOOM);
          elevation         = sampleElevation(imageData, px, py);
          stdDev            = neighbourhoodStdDev(imageData, px, py);
          isFlatFetch       = classifyFlatFetch(elevation, stdDev);
          reason            = elevation < 0
            ? 'sea'
            : isFlatFetch ? 'flat-land' : 'hilly';
        }

        if (isFlatFetch) flatFetchCount++;
        debugSamples.push({
          distKm, lat: pt.lat, lon: pt.lon,
          elevation, stdDev, isFlatFetch,
          isSea: isFlatFetch, // alias for debug-map compatibility
          reason,
        });
      }

      mask[b] = flatFetchCount / SHORE_SAMPLES;
      debugBearings.push({ bearing, seaFrac: mask[b], samples: debugSamples });
      console.debug(
        `[shore] ${String(bearing).padStart(3)}°: ` +
        `${(mask[b] * 100).toFixed(0).padStart(3)}% flat-fetch | ` +
        debugSamples.map(s => `${s.distKm.toFixed(1)}km→${s.isFlatFetch ? 'FF' : 'LND'}(${s.reason})`).join('  ')
      );
    }

    const flatFetchCount = Array.from(mask).filter(v => v >= SHORE_SEA_THRESH).length;
    console.debug(`[shore] Summary: ${flatFetchCount}/${SHORE_BEARINGS} bearings ≥ ${SHORE_SEA_THRESH * 100}% flat-fetch`);

    // Bounding box for the debug map (same concept as before — 6 km pad around origin)
    const dLat = 6 / 111.32;
    const dLon = 6 / (111.32 * Math.cos(lat * Math.PI / 180));
    const bbox = { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };

    window.SHORE_MASK  = mask;
    window.SHORE_DEBUG = {
      lat, lon,
      bbox,
      zoom:      TERRAIN_TILE_ZOOM,
      tilesUsed: tileCoords,
      bearings:  debugBearings,
    };

    const anyFlatFetch = Array.from(mask).some(v => v >= SHORE_SEA_THRESH);
    const anySea       = debugBearings.some(row => row.samples.some(s => s.elevation < 0));

    if (!anyFlatFetch && !anySea) {
      window.SHORE_STATUS = {
        state: 'inland',
        msg:   'No open water or flat terrain within 5 km – location appears inland',
      };
    } else {
      window.SHORE_STATUS = { state: 'ok', msg: '' };
    }
  } catch (e) {
    console.warn('[shore] analysis failed:', e);
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = {
      state: 'error',
      msg:   'Elevation tile fetch failed',
    };
  }

  if (onDone) onDone();
}

/* ══════════════════════════════════════════════════════════════════════════
   SHORE COMPASS WIDGET  –  draws a small polar rose showing flat-fetch bearings
══════════════════════════════════════════════════════════════════════════ */

/**
 * Draw the shore-mask compass into a <canvas> element.
 * Sectors coloured teal = flat-fetch, sand = land/hilly, grey = unknown.
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

    // ── Rim band: sea/flat = blue, land = brown, no mask = dark grey ──
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
   Returns true if bearing `deg` is flat-fetch (wind blows from sea/flat land).
   Used to gate kite-optimal highlighting.
══════════════════════════════════════════════════════════════════════════ */
function isSeaBearing(deg) {
  if (!window.SHORE_MASK) return true; // no data → don't restrict
  const idx = Math.round(((deg % 360) + 360) % 360 / 10) % SHORE_BEARINGS;
  return window.SHORE_MASK[idx] >= SHORE_SEA_THRESH;
}

/* ── Public API ── */
window.analyseShore            = analyseShore;
window.drawShoreCompass        = drawShoreCompass;
window.isSeaBearing            = isSeaBearing;
window.recomputeShoreFromDebug = recomputeShoreFromDebug;
