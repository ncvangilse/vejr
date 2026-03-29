import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

const ctx = loadScripts('config.js', 'shore.js');
const { destPoint, expandBbox, pointInPoly, signedCrossing, isLandByRayCross, buildOverpassQuery } = ctx;

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
    const spanEquator = bboxEquator.e - bboxEquator.w;
    const spanPole    = bboxPole.e    - bboxPole.w;
    expect(spanPole).toBeGreaterThan(spanEquator);
  });
});

// ── pointInPoly ───────────────────────────────────────────────────────────

describe('pointInPoly', () => {
  // Unit square centred on origin
  const square = [
    { lat: -1, lon: -1 },
    { lat:  1, lon: -1 },
    { lat:  1, lon:  1 },
    { lat: -1, lon:  1 },
  ];

  it('returns true for a point inside the polygon', () => {
    expect(pointInPoly(0, 0, square)).toBe(true);
  });

  it('returns false for a point outside the polygon', () => {
    expect(pointInPoly(5, 5, square)).toBe(false);
    expect(pointInPoly(-2, 0, square)).toBe(false);
  });

  it('handles a triangle', () => {
    const tri = [
      { lat: 0, lon: 0 },
      { lat: 2, lon: 0 },
      { lat: 1, lon: 2 },
    ];
    expect(pointInPoly(1, 0.5, tri)).toBe(true);
    expect(pointInPoly(0, 2,   tri)).toBe(false);
  });
});

// ── signedCrossing ────────────────────────────────────────────────────────

describe('signedCrossing', () => {
  // Horizontal segment at lat=10, running west→east (left side is north = sea in OSM coastline convention)
  const p3 = { lat: 10, lon: 0 };
  const p4 = { lat: 10, lon: 5 };

  it('returns 0 when test point is above the segment (no crossing)', () => {
    expect(signedCrossing(11, 2, p3, p4)).toBe(0);
  });

  it('returns 0 when test point is below the segment (no crossing)', () => {
    expect(signedCrossing(9, 2, p3, p4)).toBe(0);
  });

  it('returns 0 when test point longitude is outside segment x-range', () => {
    expect(signedCrossing(9.5, 10, p3, p4)).toBe(0);
  });
});

// ── isLandByRayCross ──────────────────────────────────────────────────────

describe('isLandByRayCross', () => {
  it('returns false (sea) when hasCoast is false', () => {
    expect(isLandByRayCross(55, 12, [], null, false)).toBe(false);
  });

  it('returns false (sea) for an empty coast ways array with hasCoast=true', () => {
    // No segments to cross → winding = 0 → sea
    expect(isLandByRayCross(55, 12, [], null, true)).toBe(false);
  });

  it('classifies a point inside a clockwise land ring as land', () => {
    // Simple clockwise square around (0,0) – OSM convention: sea is LEFT, so
    // a clockwise ring encircles land.
    const landRing = [
      { lat: -1, lon: -1 },
      { lat:  1, lon: -1 },
      { lat:  1, lon:  1 },
      { lat: -1, lon:  1 },
      { lat: -1, lon: -1 }, // close
    ];
    const isLand = isLandByRayCross(0, 0, [landRing], null, true);
    expect(isLand).toBe(true);
  });

  it('classifies a point outside the ring as sea', () => {
    const landRing = [
      { lat: -1, lon: -1 },
      { lat:  1, lon: -1 },
      { lat:  1, lon:  1 },
      { lat: -1, lon:  1 },
      { lat: -1, lon: -1 },
    ];
    const isLand = isLandByRayCross(5, 5, [landRing], null, true);
    expect(isLand).toBe(false);
  });
});

// ── buildOverpassQuery ────────────────────────────────────────────────────

describe('buildOverpassQuery', () => {
  it('includes all four bbox coordinates in the query string', () => {
    const bbox = { s: 54.0, w: 11.0, n: 56.0, e: 13.0 };
    const query = buildOverpassQuery(bbox);
    expect(query).toContain('54,11,56,13');
  });

  it('requests geometry output', () => {
    const query = buildOverpassQuery({ s: 0, w: 0, n: 1, e: 1 });
    expect(query).toContain('out geom');
  });

  it('fetches coastline ways', () => {
    const query = buildOverpassQuery({ s: 0, w: 0, n: 1, e: 1 });
    expect(query).toContain('natural"="coastline');
  });
});
