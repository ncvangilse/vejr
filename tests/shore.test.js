import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

const ctx = loadScripts('config.js', 'shore.js');
const {
  destPoint,
  latLonToTileXY, latLonToPixel,
  decodeTerrariumRGB, sampleElevation, laplacianMagnitude,
  classifyFlatFetch, recomputeShoreFromDebug,
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

// ── latLonToTileXY ────────────────────────────────────────────────────────

describe('latLonToTileXY', () => {
  it('returns non-negative integer tile coordinates', () => {
    const { x, y } = latLonToTileXY(55.676, 12.568, 12);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it('tiles at the same zoom cover the same area for nearby points', () => {
    // Two points 2 km apart should be on the same or adjacent tiles at zoom 12
    const a = latLonToTileXY(55.0, 12.0, 12);
    const b = latLonToTileXY(55.02, 12.02, 12);
    expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
  });

  it('higher zoom yields more tiles (finer granularity)', () => {
    const z10 = latLonToTileXY(55.0, 12.0, 10);
    const z12 = latLonToTileXY(55.0, 12.0, 12);
    // At z12 there are 4× as many tiles per side as z10
    expect(z12.x).toBeGreaterThanOrEqual(z10.x * 4);
    expect(z12.x).toBeLessThanOrEqual(z10.x * 4 + 3);
  });

  it('prime meridian / equator → tile (0, 0) at zoom 0', () => {
    // The entire world is one tile at zoom 0; any point is in tile (0,0)
    const { x, y } = latLonToTileXY(0, 0, 0);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });
});

// ── latLonToPixel ─────────────────────────────────────────────────────────

describe('latLonToPixel', () => {
  it('returns pixel coordinates in [0, 255]', () => {
    const tile = latLonToTileXY(55.0, 12.0, 12);
    const { px, py } = latLonToPixel(55.0, 12.0, tile.x, tile.y, 12);
    expect(px).toBeGreaterThanOrEqual(0);
    expect(px).toBeLessThanOrEqual(255);
    expect(py).toBeGreaterThanOrEqual(0);
    expect(py).toBeLessThanOrEqual(255);
  });

  it('point near NW corner of its tile has small px and py', () => {
    // Find a point that is near the NW corner of its tile by sampling the tile origin
    const zoom = 12;
    const n    = 2 ** zoom;
    // The NW corner of tile (tileX, tileY) corresponds to the top-left pixel
    const tileX = 2200, tileY = 1270;
    const lonNW = tileX / n * 360 - 180;
    // Inverse Mercator for NW lat
    const latNW = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n))) * 180 / Math.PI;
    const { px, py } = latLonToPixel(latNW, lonNW, tileX, tileY, zoom);
    expect(px).toBeLessThan(5);
    expect(py).toBeLessThan(5);
  });
});

// ── decodeTerrariumRGB ────────────────────────────────────────────────────

describe('decodeTerrariumRGB', () => {
  it('decodes sea level (0 m) correctly', () => {
    // 0 m: R=128, G=0, B=0 → 128*256 + 0 + 0 - 32768 = 32768 - 32768 = 0
    expect(decodeTerrariumRGB(128, 0, 0)).toBeCloseTo(0, 3);
  });

  it('decodes a known positive elevation', () => {
    // 100 m: solve R*256 + G + B/256 = 32868
    // R=128, G=100, B=0 → 128*256 + 100 - 32768 = 100
    expect(decodeTerrariumRGB(128, 100, 0)).toBeCloseTo(100, 3);
  });

  it('decodes a negative (ocean) elevation', () => {
    // -50 m: R*256 + G + B/256 = 32718
    // R=127, G=206, B=0 → 127*256 + 206 - 32768 = 32512 + 206 - 32768 = -50
    expect(decodeTerrariumRGB(127, 206, 0)).toBeCloseTo(-50, 3);
  });
});

// ── sampleElevation ───────────────────────────────────────────────────────

describe('sampleElevation', () => {
  // Build a fake 256×256 ImageData where all pixels encode a known elevation
  function makeUniformImageData(elevM) {
    // Encode elevation to Terrarium RGB
    const raw   = elevM + 32768;
    const r     = Math.floor(raw / 256);
    const g     = Math.floor(raw % 256);
    const b     = Math.round((raw - Math.floor(raw)) * 256);
    const data  = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) {
      data[i * 4]     = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
    }
    return { data };
  }

  it('reads the correct elevation from a uniform tile', () => {
    const imgData = makeUniformImageData(42);
    expect(sampleElevation(imgData, 100, 100)).toBeCloseTo(42, 2);
  });

  it('reads a negative (ocean) elevation', () => {
    const imgData = makeUniformImageData(-200);
    expect(sampleElevation(imgData, 50, 50)).toBeCloseTo(-200, 2);
  });

  it('clamps out-of-bounds pixel coordinates', () => {
    const imgData = makeUniformImageData(10);
    // Should not throw for out-of-bounds access
    expect(() => sampleElevation(imgData, -5, 300)).not.toThrow();
    expect(sampleElevation(imgData, -5, 300)).toBeCloseTo(10, 2);
  });
});

// ── laplacianMagnitude ────────────────────────────────────────────────────

describe('laplacianMagnitude', () => {
  function makeUniformImageData(elevM) {
    const raw  = elevM + 32768;
    const r    = Math.floor(raw / 256);
    const g    = Math.floor(raw % 256);
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) {
      data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
    }
    return { data };
  }

  it('returns 0 for a perfectly flat (uniform) tile', () => {
    const imgData = makeUniformImageData(5);
    expect(laplacianMagnitude(imgData, 128, 128)).toBeCloseTo(0, 3);
  });

  it('returns near-zero for a smooth linear slope', () => {
    // A uniform slope: elevation = px (one metre per pixel).
    // Centre px=128 → 128 m. Neighbours span 127–129 m → mean = 128 m.
    // Laplacian = |128 − 128| ≈ 0 (the slope is linear).
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const elevM = px;  // elevation equals x coordinate (pure E-W slope)
        const raw   = elevM + 32768;
        const r = Math.floor(raw / 256), g = Math.floor(raw % 256);
        const i = (py * 256 + px) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = 0; data[i + 3] = 255;
      }
    }
    expect(laplacianMagnitude({ data }, 128, 128)).toBeCloseTo(0, 1);
  });

  it('returns a positive value for a local bump (centre higher than surroundings)', () => {
    // Create a tile with alternating 0 m and 100 m rows — high roughness
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) {
      const elevM = py % 2 === 0 ? 0 : 100;
      const raw   = elevM + 32768;
      const r = Math.floor(raw / 256), g = Math.floor(raw % 256);
      for (let px = 0; px < 256; px++) {
        const i = (py * 256 + px) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = 0; data[i + 3] = 255;
      }
    }
    expect(laplacianMagnitude({ data }, 128, 128)).toBeGreaterThan(0);
  });
});

// ── classifyFlatFetch ─────────────────────────────────────────────────────

describe('classifyFlatFetch', () => {
  it('returns true for negative elevation (open ocean)', () => {
    expect(classifyFlatFetch(-200, 50)).toBe(true);
    expect(classifyFlatFetch(-1,   0)).toBe(true);
  });

  it('returns true for flat low land (low elevation, low std dev)', () => {
    expect(classifyFlatFetch(5,  2)).toBe(true);   // 5 m, σ=2 m
    expect(classifyFlatFetch(0,  0)).toBe(true);   // sea level, flat
    expect(classifyFlatFetch(24, 4)).toBe(true);   // just under thresholds
  });

  it('returns false when elevation is too high', () => {
    expect(classifyFlatFetch(30, 2)).toBe(false);  // > FLAT_ELEV_MAX (25 m)
  });

  it('returns false when std dev is too high (hilly)', () => {
    expect(classifyFlatFetch(10, 10)).toBe(false); // > FLAT_STD_THRESH (5 m)
  });

  it('returns false when both thresholds are exceeded', () => {
    expect(classifyFlatFetch(50, 20)).toBe(false);
  });

  it('is exactly at thresholds — FLAT_ELEV_MAX and FLAT_STD_THRESH are exclusive', () => {
    // elevation === FLAT_ELEV_MAX (25) → false (not strictly less than)
    expect(classifyFlatFetch(25, 2)).toBe(false);
    // stdDev === FLAT_STD_THRESH (5) → false (not strictly less than)
    expect(classifyFlatFetch(10, 5)).toBe(false);
  });

  it('respects window.SHORE_FLAT_ROUGHNESS_THRESH override — stricter', () => {
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = 2;
    // σ=3 would pass at default 5, but fails at override 2
    expect(classifyFlatFetch(10, 3)).toBe(false);
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = null;
  });

  it('respects window.SHORE_FLAT_ROUGHNESS_THRESH override — sea-only mode (0)', () => {
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = 0;
    // σ=1 would normally pass, but stdThresh=0 disables flat-land
    expect(classifyFlatFetch(5, 1)).toBe(false);
    // Ocean still passes
    expect(classifyFlatFetch(-10, 0)).toBe(true);
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = null;
  });
});

// ── recomputeShoreFromDebug ───────────────────────────────────────────────

describe('recomputeShoreFromDebug', () => {
  function makeFakeDebug(sampleElevations) {
    // sampleElevations: [[elev0, elev1, …], …] — one array per bearing
    return {
      bearings: sampleElevations.map((elevs, b) => ({
        bearing: b * 10,
        seaFrac: 0,
        samples: elevs.map((elevation, s) => ({
          distKm: s + 1,
          lat: 55 + s * 0.01,
          lon: 12 + s * 0.01,
          elevation,
          roughness: 0,     // zero roughness so flat-land logic fires on elevation
          isFlatFetch: false,
          isSea:       false,
          reason:      'hilly',
        })),
      })),
    };
  }

  it('returns false when SHORE_DEBUG is null', () => {
    ctx.window.SHORE_DEBUG = null;
    expect(recomputeShoreFromDebug()).toBe(false);
  });

  it('updates SHORE_MASK and bearing seaFrac from debug data', () => {
    // 36 bearings: bearing 0 has all ocean samples, bearing 1 has all land samples
    const bearingElevations = Array.from({ length: 36 }, (_, b) =>
      Array.from({ length: 5 }, () => (b === 0 ? -100 : 100))
    );
    ctx.window.SHORE_DEBUG           = makeFakeDebug(bearingElevations);
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = null; // use default

    const result = recomputeShoreFromDebug();
    expect(result).toBe(true);
    expect(ctx.window.SHORE_MASK[0]).toBe(1);   // bearing 0 — all ocean → 100%
    expect(ctx.window.SHORE_MASK[1]).toBe(0);   // bearing 1 — high land → 0%
  });

  it('re-classifies when threshold changes — reduces flat-land bearings', () => {
    // All samples at elevation=5 m, stdDev=0 → flat land at default threshold
    const bearingElevations = Array.from({ length: 36 }, () =>
      Array.from({ length: 5 }, () => 5)
    );
    const debug = makeFakeDebug(bearingElevations);
    ctx.window.SHORE_DEBUG = debug;

    // At default threshold (5), σ=0 < 5 AND elev=5 < 25 → all flat-fetch
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = null;
    recomputeShoreFromDebug();
    expect(ctx.window.SHORE_MASK[0]).toBe(1);

    // At threshold 0 (sea-only), none qualify
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = 0;
    recomputeShoreFromDebug();
    expect(ctx.window.SHORE_MASK[0]).toBe(0);

    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = null;
  });

  it('sets SHORE_STATUS to inland when no flat-fetch bearings remain', () => {
    const bearingElevations = Array.from({ length: 36 }, () =>
      Array.from({ length: 5 }, () => 100)  // high land, no flat-fetch possible
    );
    ctx.window.SHORE_DEBUG           = makeFakeDebug(bearingElevations);
    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = 0;  // sea-only mode

    recomputeShoreFromDebug();
    expect(ctx.window.SHORE_STATUS.state).toBe('inland');

    ctx.window.SHORE_FLAT_ROUGHNESS_THRESH = null;
  });
});
