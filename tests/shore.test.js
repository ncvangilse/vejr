import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

const ctx = loadScripts('config.js', 'shore.js');
const {
  destPoint, expandBbox, pointInPoly, signedCrossing, isLandByRayCross, buildOverpassQuery,
  snapToBbox, clockwiseBboxPath, stitchCoastWays, buildClosedCoastRings,
  isInBbox, bboxSegmentCrossing, findBboxEntryCrossing, findBboxExitCrossing,
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

// ── snapToBbox ────────────────────────────────────────────────────────────

describe('snapToBbox', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('snaps a point north of the bbox to the north edge', () => {
    const snapped = snapToBbox({ lat: 11, lon: 12 }, bbox);
    expect(snapped.lat).toBe(9);
    expect(snapped.lon).toBe(12);
  });

  it('snaps a point east of the bbox to the east edge', () => {
    const snapped = snapToBbox({ lat: 7, lon: 20 }, bbox);
    expect(snapped.lon).toBe(14);
    expect(snapped.lat).toBe(7);
  });

  it('snaps a point south of the bbox to the south edge', () => {
    const snapped = snapToBbox({ lat: 2, lon: 12 }, bbox);
    expect(snapped.lat).toBe(5);
    expect(snapped.lon).toBe(12);
  });

  it('snaps a point west of the bbox to the west edge', () => {
    const snapped = snapToBbox({ lat: 7, lon: 5 }, bbox);
    expect(snapped.lon).toBe(10);
    expect(snapped.lat).toBe(7);
  });
});

// ── clockwiseBboxPath ─────────────────────────────────────────────────────

describe('clockwiseBboxPath', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('from north edge to south edge includes NE and SE corners', () => {
    // Exit on north at lon=12, entry on south at lon=12 – going CW means passing NE then SE
    const path = clockwiseBboxPath({ lat: 9, lon: 12 }, { lat: 5, lon: 12 }, bbox);
    const lons = path.map(p => p.lon);
    expect(lons).toContain(14);  // east edge (NE and SE corners)
    expect(lons).not.toContain(10); // west edge corners should not be in path
    // Destination point (south edge) is the last element
    expect(path[path.length - 1]).toEqual({ lat: 5, lon: 12 });
  });

  it('from east edge to west edge includes SE and SW corners', () => {
    // Exit on east at lat=7, entry on west at lat=7 – CW: SE then SW
    const path = clockwiseBboxPath({ lat: 7, lon: 14 }, { lat: 7, lon: 10 }, bbox);
    const lats = path.map(p => p.lat);
    expect(lats).toContain(5);   // south edge (SE and SW corners)
    expect(lats).not.toContain(9); // north corners should not appear
    expect(path[path.length - 1]).toEqual({ lat: 7, lon: 10 });
  });

  it('path endpoint is the snapped `to` point', () => {
    const path = clockwiseBboxPath({ lat: 9, lon: 11 }, { lat: 5, lon: 13 }, bbox);
    expect(path[path.length - 1]).toEqual({ lat: 5, lon: 13 });
  });
});

// ── stitchCoastWays ───────────────────────────────────────────────────────

describe('stitchCoastWays', () => {
  it('stitches two connected ways into a single chain', () => {
    const wayA = [{ lat: 5, lon: 12 }, { lat: 7, lon: 12 }];
    const wayB = [{ lat: 7, lon: 12 }, { lat: 9, lon: 12 }];
    const chains = stitchCoastWays([wayA, wayB]);
    expect(chains.length).toBe(1);
    expect(chains[0].length).toBe(3);
    expect(chains[0][0]).toEqual({ lat: 5, lon: 12 });
    expect(chains[0][2]).toEqual({ lat: 9, lon: 12 });
  });

  it('stitches a reversed second way correctly', () => {
    const wayA = [{ lat: 5, lon: 12 }, { lat: 7, lon: 12 }];
    const wayB = [{ lat: 9, lon: 12 }, { lat: 7, lon: 12 }]; // reversed relative to chain direction
    const chains = stitchCoastWays([wayA, wayB]);
    expect(chains.length).toBe(1);
    expect(chains[0][0]).toEqual({ lat: 5, lon: 12 });
    expect(chains[0][chains[0].length - 1]).toEqual({ lat: 9, lon: 12 });
  });

  it('recognises a closed ring after stitching', () => {
    // Two half-rings that together form a complete closed island ring
    const wayA = [{ lat: 1, lon: -1 }, { lat: 1, lon: 1 }];
    const wayB = [{ lat: 1, lon: 1 }, { lat: -1, lon: 1 }, { lat: -1, lon: -1 }, { lat: 1, lon: -1 }];
    const chains = stitchCoastWays([wayA, wayB]);
    expect(chains.length).toBe(1);
    const c = chains[0];
    // Head and tail should be the same point (closed)
    expect(c[0].lat).toBeCloseTo(c[c.length - 1].lat, 5);
    expect(c[0].lon).toBeCloseTo(c[c.length - 1].lon, 5);
  });

  it('keeps unconnected ways as separate chains', () => {
    const wayA = [{ lat: 5, lon: 12 }, { lat: 7, lon: 12 }];
    const wayB = [{ lat: 1, lon: 0  }, { lat: 2, lon: 0  }];
    const chains = stitchCoastWays([wayA, wayB]);
    expect(chains.length).toBe(2);
  });
});

// ── isInBbox / bboxSegmentCrossing / findBboxEntryCrossing / findBboxExitCrossing ──

describe('isInBbox', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('returns true for a point inside', () => {
    expect(isInBbox({ lat: 7, lon: 12 }, bbox)).toBe(true);
  });

  it('returns false for a point outside', () => {
    expect(isInBbox({ lat: 10, lon: 12 }, bbox)).toBe(false);
    expect(isInBbox({ lat: 7, lon: 15 }, bbox)).toBe(false);
  });

  it('returns true for a point on the boundary', () => {
    expect(isInBbox({ lat: 9, lon: 12 }, bbox)).toBe(true);
  });
});

describe('bboxSegmentCrossing', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('finds east-edge crossing for a segment going right', () => {
    const c = bboxSegmentCrossing({ lat: 7, lon: 12 }, { lat: 7, lon: 16 }, bbox);
    expect(c.lat).toBeCloseTo(7, 5);
    expect(c.lon).toBeCloseTo(14, 5);
  });

  it('finds north-edge crossing for a segment going up', () => {
    const c = bboxSegmentCrossing({ lat: 7, lon: 12 }, { lat: 11, lon: 12 }, bbox);
    expect(c.lat).toBeCloseTo(9, 5);
    expect(c.lon).toBeCloseTo(12, 5);
  });

  it('returns null for a segment that does not cross the bbox', () => {
    // Both outside, does not cross
    expect(bboxSegmentCrossing({ lat: 0, lon: 0 }, { lat: 1, lon: 1 }, bbox)).toBeNull();
  });
});

describe('findBboxEntryCrossing', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('returns first node when chain starts inside bbox', () => {
    const chain = [{ lat: 7, lon: 12 }, { lat: 8, lon: 12 }];
    const c = findBboxEntryCrossing(chain, bbox);
    expect(c.lat).toBe(7);
    expect(c.lon).toBe(12);
  });

  it('finds the crossing when chain starts outside and enters from south', () => {
    const chain = [{ lat: 3, lon: 12 }, { lat: 7, lon: 12 }];
    const c = findBboxEntryCrossing(chain, bbox);
    expect(c.lat).toBeCloseTo(5, 4);
    expect(c.lon).toBeCloseTo(12, 4);
  });
});

describe('findBboxExitCrossing', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('returns last node when chain ends inside bbox', () => {
    const chain = [{ lat: 7, lon: 12 }, { lat: 8, lon: 13 }];
    const c = findBboxExitCrossing(chain, bbox);
    expect(c.lat).toBe(8);
    expect(c.lon).toBe(13);
  });

  it('finds the crossing when chain exits through the north edge', () => {
    const chain = [{ lat: 7, lon: 12 }, { lat: 11, lon: 12 }];
    const c = findBboxExitCrossing(chain, bbox);
    expect(c.lat).toBeCloseTo(9, 4);
    expect(c.lon).toBeCloseTo(12, 4);
  });
});

// ── buildClosedCoastRings ─────────────────────────────────────────────────

describe('buildClosedCoastRings', () => {
  const bbox = { s: 5, n: 9, w: 10, e: 14 };

  it('regression: open N–S coast at lon=12 (sea to the west) – sea west and land east', () => {
    // Before the fix, the winding number from this open chain gave +1 for the sea
    // point at (7, 11), misclassifying it as land.
    const openCoastWay = [
      { lat: 5, lon: 12 },  // south entry on bbox boundary
      { lat: 9, lon: 12 },  // north exit on bbox boundary
    ];
    const rings = buildClosedCoastRings([openCoastWay], bbox);
    expect(isLandByRayCross(7, 11, rings, bbox, true)).toBe(false);  // west = SEA
    expect(isLandByRayCross(7, 13, rings, bbox, true)).toBe(true);   // east = LAND
  });

  it('closed island ring (two stitched ways) stays closed and classifies correctly', () => {
    const wayA = [{ lat:  1, lon: -1 }, { lat: 1, lon: 1 }];
    const wayB = [{ lat:  1, lon:  1 }, { lat: -1, lon: 1 }, { lat: -1, lon: -1 }, { lat: 1, lon: -1 }];
    const islandBbox = { s: -2, n: 2, w: -2, e: 2 };
    const rings = buildClosedCoastRings([wayA, wayB], islandBbox);
    expect(rings.length).toBe(1);
    // Interior of island = land
    expect(isLandByRayCross(0, 0, rings, islandBbox, true)).toBe(true);
    // Exterior of island = sea
    expect(isLandByRayCross(5, 5, rings, islandBbox, true)).toBe(false);
  });

  it('regression (Vordingborg): E–W coast whose raw endpoints lie far NE/NW of bbox', () => {
    // The chain represents a coast running west across the bbox (sea to south).
    // Its OSM-way endpoints are far outside the bbox — one to the NE, one to the NW.
    // Before the bbox-crossing fix, both endpoints snapped to the north edge;
    // the CW closure then went the long way round (via SE/SW corners) and
    // enclosed the southern sea area as land.
    // After the fix, actual crossing points on the east/west edges are used,
    // and the closure correctly goes via the NW/NE corners (land to the north).
    const bbox = { s: 5, n: 9, w: 10, e: 14 };
    // Chain: starts far NE (lat=12, lon=16), crosses east bbox edge, runs west
    // through the bbox at lat=7, crosses west bbox edge, ends far NW (lat=12, lon=8).
    const chain = [
      { lat: 12, lon: 16 },  // far NE, outside bbox
      { lat:  7, lon: 14 },  // east bbox boundary crossing area
      { lat:  7, lon: 10 },  // west bbox boundary crossing area
      { lat: 12, lon:  8 },  // far NW, outside bbox
    ];
    const rings = buildClosedCoastRings([chain], bbox);
    // Points south of the chain (lat < 7) should be SEA
    expect(isLandByRayCross(6, 12, rings, bbox, true)).toBe(false);
    expect(isLandByRayCross(5.5, 11, rings, bbox, true)).toBe(false);
    // Points north of the chain (lat > 7) should be LAND
    expect(isLandByRayCross(8, 12, rings, bbox, true)).toBe(true);
  });

  it('two stitchable N–S ways give the same result as one combined way', () => {
    const combined = [{ lat: 5, lon: 12 }, { lat: 7, lon: 12 }, { lat: 9, lon: 12 }];
    const split    = [
      [{ lat: 5, lon: 12 }, { lat: 7, lon: 12 }],
      [{ lat: 7, lon: 12 }, { lat: 9, lon: 12 }],
    ];
    const ringsCombined = buildClosedCoastRings([combined], bbox);
    const ringsSplit    = buildClosedCoastRings(split,      bbox);
    // Both should classify the same test points identically
    for (const [lat, lon] of [[7, 11], [7, 13], [6, 11.5], [8, 12.5]]) {
      expect(isLandByRayCross(lat, lon, ringsCombined, bbox, true))
        .toBe(isLandByRayCross(lat, lon, ringsSplit, bbox, true));
    }
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
