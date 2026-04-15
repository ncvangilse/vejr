import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { loadScripts } from './helpers/loader.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ctx = loadScripts('config.js', 'shore.js');
const {
  destPoint, expandBbox,
  buildWmsUrl, classifyWmsPixel, latLonToPixel, processWmsPixels,
  latLonToMercator, bboxToMercator,
} = ctx;

// ── fetchShoreVector context ──────────────────────────────────────────────────
// A separate VM context that includes window.dispatchEvent + CustomEvent so
// we can exercise the async Overpass fetch path.

function makeFetchShoreCtx() {
  const events = [];
  const mockWindow = {
    location:     { search: '', href: 'http://localhost/' },
    history:      { replaceState: () => {} },
    SHORE_MASK:   null,
    SHORE_STATUS: { state: 'idle', msg: '' },
    SHORE_DEBUG:  null,
    SHORE_VECTOR: null,
    dispatchEvent: (e) => events.push(e.type),
  };

  const fctx = vm.createContext({
    window:             mockWindow,
    localStorage:       { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console,
    Math, Date,
    Array, Float32Array, Set, Map,
    Number, String, Boolean, Object,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    URL, URLSearchParams,
    Promise, Error,
    CustomEvent, AbortController,
    setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error('fetch not mocked')),
  });

  const src = ['config.js', 'shore.js'].map(p => readFileSync(resolve(ROOT, p), 'utf8')).join('\n');
  vm.runInContext(src, fctx);

  return { fctx, events, window: mockWindow };
}

// ── destPoint ─────────────────────────────────────────────────────────────

describe('destPoint', () => {
  it('moves north by ~1 km (increases latitude)', () => {
    const result = destPoint(55.0, 12.0, 0, 1);
    expect(result.lat).toBeGreaterThan(55.0);
    expect(result.lon).toBeCloseTo(12.0, 3);
  });

  it('moves east by ~1 km (increases longitude)', () => {
    const result = destPoint(55.0, 12.0, 90, 1);
    expect(result.lon).toBeGreaterThan(12.0);
    expect(result.lat).toBeCloseTo(55.0, 3);
  });

  it('moves south by ~1 km (decreases latitude)', () => {
    const result = destPoint(55.0, 12.0, 180, 1);
    expect(result.lat).toBeLessThan(55.0);
    expect(result.lon).toBeCloseTo(12.0, 3);
  });

  it('1 km north ≈ 0.009° latitude', () => {
    const result = destPoint(55.0, 12.0, 0, 1);
    expect(result.lat - 55.0).toBeCloseTo(1 / 111.32, 3);
  });
});

// ── expandBbox ────────────────────────────────────────────────────────────

describe('expandBbox', () => {
  it('returns correct cardinal bounds for a 1 km pad', () => {
    const bbox = expandBbox(55.0, 12.0, 1);
    const dLat = 1 / 111.32;
    expect(bbox.n).toBeCloseTo(55.0 + dLat, 4);
    expect(bbox.s).toBeCloseTo(55.0 - dLat, 4);
    expect(bbox.n - bbox.s).toBeCloseTo(2 * dLat, 4);
    expect(bbox.e).toBeGreaterThan(12.0);
    expect(bbox.w).toBeLessThan(12.0);
  });

  it('east-west span is wider near the equator than near the poles', () => {
    const bboxEquator = expandBbox(0,  0, 10);
    const bboxPole    = expandBbox(80, 0, 10);
    expect(bboxPole.e - bboxPole.w).toBeGreaterThan(bboxEquator.e - bboxEquator.w);
  });
});

// ── latLonToMercator / bboxToMercator ─────────────────────────────────────

describe('latLonToMercator', () => {
  it('maps lon=0 to x=0', () => {
    expect(latLonToMercator(0, 0).x).toBeCloseTo(0, 0);
  });

  it('maps lat=0, lon=180 to x ≈ 20 037 508 m (half circumference)', () => {
    expect(latLonToMercator(0, 180).x).toBeCloseTo(20_037_508, -2);
  });

  it('x increases with longitude', () => {
    expect(latLonToMercator(55, 13).x).toBeGreaterThan(latLonToMercator(55, 12).x);
  });

  it('y increases with latitude', () => {
    expect(latLonToMercator(56, 12).y).toBeGreaterThan(latLonToMercator(55, 12).y);
  });

  it('lat=0 maps to y=0 (equator)', () => {
    expect(latLonToMercator(0, 0).y).toBeCloseTo(0, 0);
  });
});

describe('bboxToMercator', () => {
  it('west < east and south < north in Mercator', () => {
    const mb = bboxToMercator({ s: 54, n: 56, w: 10, e: 14 });
    expect(mb.east).toBeGreaterThan(mb.west);
    expect(mb.north).toBeGreaterThan(mb.south);
  });

  it('wider lon span → wider Mercator x span', () => {
    const narrow = bboxToMercator({ s: 54, n: 56, w: 11, e: 13 });
    const wide   = bboxToMercator({ s: 54, n: 56, w: 10, e: 14 });
    expect(wide.east - wide.west).toBeGreaterThan(narrow.east - narrow.west);
  });
});


describe('buildWmsUrl', () => {
  const bbox = { s: 54.9, n: 55.1, w: 11.8, e: 12.2 };

  it('contains the WMS base URL', () => {
    expect(buildWmsUrl(bbox)).toContain('services.terrascope.be/wms/v2');
  });

  it('requests GetMap with the ESA WorldCover layer', () => {
    const url = buildWmsUrl(bbox);
    expect(url).toContain('REQUEST=GetMap');
    expect(url).toContain('WORLDCOVER_2021_MAP');
  });

  it('uses EPSG:3857 (Web Mercator — only SRS the layer supports)', () => {
    expect(buildWmsUrl(bbox)).toContain('EPSG%3A3857');
  });

  it('requests PNG format', () => {
    expect(buildWmsUrl(bbox)).toContain('image%2Fpng');
  });

  it('BBOX contains Mercator metre values, not lat/lon degree values', () => {
    const url = buildWmsUrl(bbox);
    // Mercator x for lon≈12 is ~1 335 833 m — far above any lat/lon value
    expect(url).toContain('BBOX=');
    expect(url).not.toContain('BBOX=11.8');  // should not be raw lon degrees
  });

  it('encodes the supplied width and height', () => {
    const url = buildWmsUrl(bbox, 256, 256);
    expect(url).toContain('WIDTH=256');
    expect(url).toContain('HEIGHT=256');
  });

  it('uses default 512×512 when no size is given', () => {
    const url = buildWmsUrl(bbox);
    expect(url).toContain('WIDTH=512');
    expect(url).toContain('HEIGHT=512');
  });
});

// ── classifyWmsPixel ──────────────────────────────────────────────────────

describe('classifyWmsPixel', () => {
  it('classifies class-80 water colour rgb(0,100,200) as water', () => {
    expect(classifyWmsPixel(0, 100, 200)).toBe(true);
  });

  it('classifies class-90 wetland colour rgb(0,150,160) as water', () => {
    expect(classifyWmsPixel(0, 150, 160)).toBe(true);
  });

  it('classifies slight variations of class-80 as water (within tolerance)', () => {
    expect(classifyWmsPixel(5,  100, 200)).toBe(true);   // small red shift
    expect(classifyWmsPixel(0,  105, 195)).toBe(true);   // small green/blue shift
  });

  it('classifies class-10 tree cover rgb(0,100,0) as land', () => {
    // Distance to class-80 water = sqrt(0 + 0 + 200²) = 200 → far outside tolerance
    expect(classifyWmsPixel(0, 100, 0)).toBe(false);
  });

  it('classifies class-50 built-up rgb(250,0,0) as land', () => {
    expect(classifyWmsPixel(250, 0, 0)).toBe(false);
  });

  it('classifies class-60 bare soil rgb(180,180,180) as land', () => {
    expect(classifyWmsPixel(180, 180, 180)).toBe(false);
  });

  it('classifies class-30 grassland rgb(255,255,76) as land', () => {
    expect(classifyWmsPixel(255, 255, 76)).toBe(false);
  });

  it('classifies pure black (nodata / outside coverage) as land', () => {
    expect(classifyWmsPixel(0, 0, 0)).toBe(false);
  });
});

// ── latLonToPixel ─────────────────────────────────────────────────────────

describe('latLonToPixel', () => {
  // Bbox: lon 10–14 (4° wide), lat 54–56 (2° tall), 512×512 image
  const bbox = { s: 54, n: 56, w: 10, e: 14 };

  it('north-west corner maps to pixel (0, 0)', () => {
    const { px, py } = latLonToPixel(56, 10, bbox, 512, 512);
    expect(px).toBe(0);
    expect(py).toBe(0);
  });

  it('centre longitude maps to px = 256 (Mercator x is linear in lon)', () => {
    const { px } = latLonToPixel(55, 12, bbox, 512, 512);
    expect(px).toBe(256);
  });

  it('centre latitude maps to py near 256 (slight Mercator nonlinearity)', () => {
    // Mercator y is nonlinear in lat, so the geographic midpoint doesn't land
    // exactly on the image midline, but it is very close for a 2° range.
    const { py } = latLonToPixel(55, 12, bbox, 512, 512);
    expect(py).toBeGreaterThan(250);
    expect(py).toBeLessThan(265);
  });

  it('south edge maps to py = height (at or past the bottom)', () => {
    // floor(1.0 * 512) = 512 — caller treats this as out-of-bounds
    const { py } = latLonToPixel(54, 12, bbox, 512, 512);
    expect(py).toBeGreaterThanOrEqual(511);
  });

  it('east edge maps to px = width (at or past the right)', () => {
    const { px } = latLonToPixel(55, 14, bbox, 512, 512);
    expect(px).toBeGreaterThanOrEqual(511);
  });

  it('point outside bbox (west) gives negative px', () => {
    const { px } = latLonToPixel(55, 8, bbox, 512, 512);
    expect(px).toBeLessThan(0);
  });

  it('increasing lon → increasing px', () => {
    const a = latLonToPixel(55, 11, bbox, 512, 512);
    const b = latLonToPixel(55, 13, bbox, 512, 512);
    expect(b.px).toBeGreaterThan(a.px);
  });

  it('increasing lat → decreasing py (north-up image)', () => {
    const a = latLonToPixel(54.5, 12, bbox, 512, 512);  // south → larger py
    const b = latLonToPixel(55.5, 12, bbox, 512, 512);  // north → smaller py
    expect(b.py).toBeLessThan(a.py);
  });
});

// ── processWmsPixels ──────────────────────────────────────────────────────

describe('processWmsPixels', () => {
  const bbox = expandBbox(55.0, 12.0, 6);
  const W = 512, H = 512;

  it('returns a Float32Array of length 36', () => {
    const { mask } = processWmsPixels(55.0, 12.0, bbox, W, H, () => ({ r: 0, g: 0, b: 0 }));
    expect(mask).toBeInstanceOf(Float32Array);
    expect(mask.length).toBe(36);
  });

  it('all-water pixelReader → all mask values = 1', () => {
    const waterPixel = () => ({ r: 0, g: 100, b: 200 });  // class 80
    const { mask } = processWmsPixels(55.0, 12.0, bbox, W, H, waterPixel);
    expect(Array.from(mask).every(v => v === 1)).toBe(true);
  });

  it('all-land pixelReader → all mask values = 0', () => {
    const landPixel = () => ({ r: 0, g: 100, b: 0 });  // class 10 tree cover
    const { mask } = processWmsPixels(55.0, 12.0, bbox, W, H, landPixel);
    expect(Array.from(mask).every(v => v === 0)).toBe(true);
  });

  it('N–S coast at centre lon: west = water, east = land', () => {
    // Pixels west of centre column are water, east are land
    const midPx = Math.floor(W / 2);
    const splitPixel = (px) => px < midPx
      ? { r: 0, g: 100, b: 200 }   // water
      : { r: 0, g: 100, b: 0 };    // land
    const { mask } = processWmsPixels(55.0, 12.0, bbox, W, H, splitPixel);
    // Bearing 270° (west, index 27) → all samples over water → 1.0
    expect(mask[27]).toBe(1);
    // Bearing 90° (east, index 9) → all samples over land → 0.0
    expect(mask[9]).toBe(0);
  });

  it('E–W coast at centre row: north = water, south = land', () => {
    // Pixels above the centre row are water, below are land
    const midPy = Math.floor(H / 2);
    const splitPixel = (_, py) => py < midPy
      ? { r: 0, g: 100, b: 200 }   // water (north = small py)
      : { r: 0, g: 100, b: 0 };    // land  (south = large py)
    const { mask } = processWmsPixels(55.0, 12.0, bbox, W, H, splitPixel);
    // Bearing 0° (north, index 0) → water → 1.0
    expect(mask[0]).toBe(1);
    // Bearing 180° (south, index 18) → land → 0.0
    expect(mask[18]).toBe(0);
  });

  it('bearings array has 36 entries each with bearing, seaFrac and samples', () => {
    const { bearings } = processWmsPixels(55.0, 12.0, bbox, W, H, () => ({ r: 0, g: 0, b: 0 }));
    expect(bearings.length).toBe(36);
    expect(bearings[0].bearing).toBe(0);
    expect(bearings[0]).toHaveProperty('seaFrac');
    expect(bearings[0].samples.length).toBe(5);
  });

  it('wetland pixels (class 90) are counted as water', () => {
    const wetlandPixel = () => ({ r: 0, g: 150, b: 160 });  // class 90
    const { mask } = processWmsPixels(55.0, 12.0, bbox, W, H, wetlandPixel);
    expect(Array.from(mask).every(v => v === 1)).toBe(true);
  });
});

// ── fetchShoreVector ──────────────────────────────────────────────────────────

describe('fetchShoreVector', () => {
  // Each test gets a fresh VM context so module-level dedup state is clean.

  it('sets SHORE_VECTOR to loading state then ok after a successful fetch', async () => {
    const { fctx, window } = makeFetchShoreCtx();
    const overpassResponse = {
      elements: [
        { type: 'way', tags: { natural: 'coastline' },
          geometry: [{ lat: 55.01, lon: 12.01 }, { lat: 55.02, lon: 12.02 }] },
      ],
    };
    fctx.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(overpassResponse),
    });

    await fctx.fetchShoreVector(55.0, 12.0);

    expect(window.SHORE_VECTOR.state).toBe('ok');
    expect(window.SHORE_VECTOR.lat).toBeCloseTo(55.0);
    expect(window.SHORE_VECTOR.lon).toBeCloseTo(12.0);
    expect(window.SHORE_VECTOR.coastWays.length).toBe(1);
    expect(window.SHORE_VECTOR.waterPolys.length).toBe(0);
  });

  it('dispatches shore-vector-ready when the fetch completes', async () => {
    const { fctx, events } = makeFetchShoreCtx();
    fctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: [] }) });

    await fctx.fetchShoreVector(55.0, 12.0);

    expect(events).toContain('shore-vector-ready');
  });

  it('sets state to error and dispatches shore-vector-ready when all endpoints fail', async () => {
    const { fctx, events, window } = makeFetchShoreCtx();
    fctx.fetch = () => Promise.reject(new Error('network error'));

    await fctx.fetchShoreVector(55.0, 12.0);

    expect(window.SHORE_VECTOR.state).toBe('error');
    expect(events).toContain('shore-vector-ready');
  });

  it('deduplicates: only one fetch call is made when called twice for the same coords', async () => {
    const { fctx, window } = makeFetchShoreCtx();
    let fetchCallCount = 0;
    fctx.fetch = () => {
      fetchCallCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: [] }) });
    };

    await Promise.all([
      fctx.fetchShoreVector(55.0, 12.0),
      fctx.fetchShoreVector(55.0, 12.0),
    ]);

    // Both calls resolve with valid data; only one Overpass request was sent
    expect(fetchCallCount).toBe(1);
    expect(window.SHORE_VECTOR.state).toBe('ok');
  });

  it('dispatches immediately when valid data already cached for same coords', async () => {
    const { fctx, events, window } = makeFetchShoreCtx();
    fctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: [] }) });

    await fctx.fetchShoreVector(55.0, 12.0);
    const countAfterFirst = events.length;

    // Second call — should reuse cached data and dispatch again
    await fctx.fetchShoreVector(55.0, 12.0);

    expect(events.length).toBe(countAfterFirst + 1);
    expect(window.SHORE_VECTOR.state).toBe('ok');
  });

  it('back-fills SHORE_DEBUG when it has matching coords', async () => {
    const { fctx, window } = makeFetchShoreCtx();
    const overpassResponse = {
      elements: [
        { type: 'way', tags: { natural: 'water' },
          geometry: [{ lat: 55.01, lon: 12.01 }, { lat: 55.02, lon: 12.02 }, { lat: 55.01, lon: 12.03 }] },
      ],
    };
    fctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(overpassResponse) });

    // Pre-set SHORE_DEBUG as if analyseShore ran first
    window.SHORE_DEBUG = { lat: 55.0, lon: 12.0, vectorState: 'loading', coastWays: [], waterPolys: [] };

    await fctx.fetchShoreVector(55.0, 12.0);

    expect(window.SHORE_DEBUG.vectorState).toBe('ok');
    expect(window.SHORE_DEBUG.waterPolys.length).toBe(1);
  });

  it('does not back-fill SHORE_DEBUG when coords differ', async () => {
    const { fctx, window } = makeFetchShoreCtx();
    fctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: [] }) });

    window.SHORE_DEBUG = { lat: 56.0, lon: 13.0, vectorState: 'loading', coastWays: [], waterPolys: [] };

    await fctx.fetchShoreVector(55.0, 12.0);

    // SHORE_DEBUG belongs to a different location — must not be touched
    expect(window.SHORE_DEBUG.vectorState).toBe('loading');
  });
});

// ── analyseShore ──────────────────────────────────────────────────────────────

/**
 * Like makeFetchShoreCtx but also provides OffscreenCanvas + createImageBitmap
 * so that fetchWmsImageData can decode the mock image blob.
 * All fetch calls to WMS URLs return a synthetic land-only image (no water pixels).
 * Overpass fetches return an empty elements array.
 */
function makeAnalyseShoreCtx() {
  const events = [];
  const mockWindow = {
    location:     { search: '', href: 'http://localhost/' },
    history:      { replaceState: () => {} },
    SHORE_MASK:   null,
    SHORE_STATUS: { state: 'idle', msg: '' },
    SHORE_DEBUG:  null,
    SHORE_VECTOR: null,
    dispatchEvent: (e) => events.push(e.type),
  };

  // Synthetic 4×4 land-only image (rgb 100,100,100 — does not match any water class).
  const W = 4, H = 4;
  const landPixels = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < landPixels.length; i += 4) {
    landPixels[i] = 100; landPixels[i + 1] = 100; landPixels[i + 2] = 100; landPixels[i + 3] = 255;
  }

  class MockOffscreenCanvas {
    constructor() {}
    getContext() {
      return {
        drawImage: () => {},
        getImageData: () => ({ data: landPixels, width: W, height: H }),
      };
    }
  }

  const fctx = vm.createContext({
    window:             mockWindow,
    localStorage:       { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    console,
    Math, Date,
    Array, Float32Array, Set, Map,
    Number, String, Boolean, Object,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    URL, URLSearchParams,
    Promise, Error,
    CustomEvent, AbortController,
    setTimeout, clearTimeout,
    OffscreenCanvas:     MockOffscreenCanvas,
    createImageBitmap:   () => Promise.resolve({}),
    fetch: (url) => {
      if (String(url).includes('overpass')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ elements: [] }) });
      }
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'image/png' },
        blob:    () => Promise.resolve({}),
      });
    },
  });

  const src = ['config.js', 'shore.js'].map(p => readFileSync(resolve(ROOT, p), 'utf8')).join('\n');
  vm.runInContext(src, fctx);

  return { fctx, events, window: mockWindow };
}

describe('analyseShore', () => {
  it('sets SHORE_MASK and dispatches shore-mask-ready on a successful WMS fetch', async () => {
    const { fctx, events, window } = makeAnalyseShoreCtx();

    await fctx.analyseShore(55.0, 12.0);

    // SHORE_MASK must be a Float32Array with one entry per bearing bucket
    expect(window.SHORE_MASK).toBeInstanceOf(Float32Array);
    expect(window.SHORE_MASK.length).toBe(36);
    expect(events).toContain('shore-mask-ready');
    expect(['ok', 'inland'].includes(window.SHORE_STATUS.state)).toBe(true);
  });

  it('calls onDone, leaves SHORE_MASK null, and sets state to error when fetch fails', async () => {
    const { fctx, window } = makeAnalyseShoreCtx();
    fctx.fetch = () => Promise.reject(new Error('network error'));

    let doneCalled = false;
    await fctx.analyseShore(55.0, 12.0, () => { doneCalled = true; });

    expect(doneCalled).toBe(true);
    expect(window.SHORE_MASK).toBeNull();
    expect(window.SHORE_STATUS.state).toBe('error');
  });

  it('deduplicates: only one WMS fetch when called twice concurrently for the same coords', async () => {
    const { fctx, window } = makeAnalyseShoreCtx();
    let fetchCallCount = 0;
    const origFetch = fctx.fetch;
    fctx.fetch = (url) => { fetchCallCount++; return origFetch(url); };

    await Promise.all([
      fctx.analyseShore(55.0, 12.0),
      fctx.analyseShore(55.0, 12.0),
    ]);

    expect(window.SHORE_MASK).not.toBeNull();
    // At most 2 requests: 1 WMS + 1 Overpass. Second analyseShore call must chain, not re-fetch.
    expect(fetchCallCount).toBeLessThanOrEqual(2);
  });

  it('fast path: returns immediately without a WMS fetch when SHORE_MASK already set', async () => {
    const { fctx, window } = makeAnalyseShoreCtx();

    // Prime the module-level dedup state via a real first fetch.
    await fctx.analyseShore(55.0, 12.0);
    expect(window.SHORE_MASK).not.toBeNull();

    let fetchCallCount = 0;
    fctx.fetch = () => { fetchCallCount++; return Promise.resolve({ ok: true }); };
    let doneCalled = false;

    await fctx.analyseShore(55.0, 12.0, () => { doneCalled = true; });

    expect(fetchCallCount).toBe(0);   // no WMS round-trip
    expect(doneCalled).toBe(true);    // onDone still called
  });

  it('forces a new WMS fetch when SHORE_MASK is nulled before calling (button re-fetch pattern)', async () => {
    const { fctx, window } = makeAnalyseShoreCtx();

    await fctx.analyseShore(55.0, 12.0);

    let fetchCallCount = 0;
    const origFetch = fctx.fetch;
    fctx.fetch = (url) => { fetchCallCount++; return origFetch(url); };

    // Simulate the "Auto-detect sea bearings" button: null the mask before re-calling.
    window.SHORE_MASK = null;
    await fctx.analyseShore(55.0, 12.0);

    expect(fetchCallCount).toBeGreaterThanOrEqual(1);  // at least 1 WMS request issued
    expect(window.SHORE_MASK).not.toBeNull();
  });
});

