import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

const ctx = loadScripts('config.js', 'shore.js');
const {
  destPoint,
  latLonToTileXY, latLonToPixel,
  decodeTerrariumRGB, sampleElevation, neighbourhoodStdDev,
  classifyFlatFetch,
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

// ── neighbourhoodStdDev ───────────────────────────────────────────────────

describe('neighbourhoodStdDev', () => {
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

  it('returns 0 for a perfectly uniform tile', () => {
    const imgData = makeUniformImageData(5);
    expect(neighbourhoodStdDev(imgData, 128, 128)).toBeCloseTo(0, 3);
  });

  it('returns a positive value for a non-uniform tile', () => {
    // Create a tile with alternating 0 m and 100 m rows
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
    expect(neighbourhoodStdDev({ data }, 128, 128)).toBeGreaterThan(0);
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
});
