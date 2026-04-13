import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

const ctx = loadScripts('config.js', 'shore.js');
const {
  destPoint, expandBbox,
  buildWmsUrl, classifyWmsPixel, latLonToPixel, processWmsPixels,
  latLonToMercator, bboxToMercator,
} = ctx;

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

