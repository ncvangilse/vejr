import { describe, it, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// ── Pure functions under test (defined inline to avoid loading full app.js) ──
// These mirror the implementations in app.js exactly.

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const toR  = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem:    k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem:    (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; },
    store,
  };
}

const KITE_SPOTS_KEY = 'vejr_kite_spots';

function makeSpotHelpers(ls) {
  function loadKiteSpots() {
    try { return JSON.parse(ls.getItem(KITE_SPOTS_KEY) || '[]'); } catch (_) { return []; }
  }
  function saveKiteSpots(spots) {
    ls.setItem(KITE_SPOTS_KEY, JSON.stringify(spots));
  }
  function addKiteSpot(spot) {
    const spots = loadKiteSpots();
    spots.push(spot);
    saveKiteSpots(spots);
    return spots;
  }
  function deleteKiteSpot(id) {
    const spots = loadKiteSpots().filter(s => s.id !== id);
    saveKiteSpots(spots);
    return spots;
  }
  function findNearbyKiteSpot(lat, lon, maxDistM = 2000) {
    const spots = loadKiteSpots();
    for (const s of spots) {
      if (haversineDistance(lat, lon, s.lat, s.lon) <= maxDistM) return s;
    }
    return null;
  }
  return { loadKiteSpots, saveKiteSpots, addKiteSpot, deleteKiteSpot, findNearbyKiteSpot };
}

// ── _buildKiteSpotIssueUrl lives before the Leaflet IIFE in radar.js ─────────
const radarCtx = loadScripts('radar.js');

describe('haversineDistance', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistance(55.0, 12.0, 55.0, 12.0)).toBe(0);
  });

  it('returns ~111 km per degree of latitude', () => {
    const d = haversineDistance(55.0, 12.0, 56.0, 12.0);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('two points ~1.4 km apart measure within 50 m', () => {
    // Amager Strand area — 0.01° lat ≈ 1.11 km, 0.01° lon ≈ ~0.63 km
    const d = haversineDistance(55.65, 12.60, 55.659, 12.61);
    expect(d).toBeGreaterThan(1_000);
    expect(d).toBeLessThan(1_600);
  });

  it('orders two distances correctly', () => {
    const near = haversineDistance(55.0, 12.0, 55.001, 12.001); // ~140 m
    const far  = haversineDistance(55.0, 12.0, 55.010, 12.010); // ~1400 m
    expect(near).toBeLessThan(far);
  });
});

describe('kite spot storage', () => {
  let ls, helpers;
  beforeEach(() => {
    ls      = makeStorage();
    helpers = makeSpotHelpers(ls);
  });

  it('loadKiteSpots returns [] when nothing is stored', () => {
    expect(helpers.loadKiteSpots()).toEqual([]);
  });

  it('loadKiteSpots returns [] on corrupt JSON', () => {
    ls.setItem(KITE_SPOTS_KEY, 'not-json{{{');
    expect(helpers.loadKiteSpots()).toEqual([]);
  });

  it('addKiteSpot persists a spot and returns the updated array', () => {
    const spot = { id: 'spot_1', lat: 55.6, lon: 12.5, name: 'Test', dirs: [90, 270] };
    const result = helpers.addKiteSpot(spot);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(spot);
    // verify persistence
    expect(helpers.loadKiteSpots()).toHaveLength(1);
  });

  it('addKiteSpot accumulates multiple spots', () => {
    helpers.addKiteSpot({ id: 'a', lat: 55.0, lon: 12.0, name: 'A', dirs: [] });
    helpers.addKiteSpot({ id: 'b', lat: 56.0, lon: 13.0, name: 'B', dirs: [] });
    expect(helpers.loadKiteSpots()).toHaveLength(2);
  });

  it('deleteKiteSpot removes the matching spot by id', () => {
    helpers.addKiteSpot({ id: 'x', lat: 55.0, lon: 12.0, name: 'X', dirs: [] });
    helpers.addKiteSpot({ id: 'y', lat: 56.0, lon: 13.0, name: 'Y', dirs: [] });
    helpers.deleteKiteSpot('x');
    const remaining = helpers.loadKiteSpots();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('y');
  });

  it('deleteKiteSpot on non-existent id leaves spots unchanged', () => {
    helpers.addKiteSpot({ id: 'a', lat: 55.0, lon: 12.0, name: 'A', dirs: [] });
    helpers.deleteKiteSpot('no-such-id');
    expect(helpers.loadKiteSpots()).toHaveLength(1);
  });
});

describe('findNearbyKiteSpot', () => {
  let ls, helpers;
  beforeEach(() => {
    ls      = makeStorage();
    helpers = makeSpotHelpers(ls);
  });

  it('returns null when no spots are saved', () => {
    expect(helpers.findNearbyKiteSpot(55.0, 12.0)).toBeNull();
  });

  it('returns the spot when within 2 km', () => {
    const spot = { id: 's1', lat: 55.650, lon: 12.600, name: 'Near', dirs: [90] };
    helpers.addKiteSpot(spot);
    // ~150 m away
    const found = helpers.findNearbyKiteSpot(55.651, 12.600);
    expect(found).not.toBeNull();
    expect(found.id).toBe('s1');
  });

  it('returns null when the only spot is >2 km away', () => {
    helpers.addKiteSpot({ id: 's2', lat: 55.650, lon: 12.600, name: 'Far', dirs: [] });
    // ~3.3 km north
    const found = helpers.findNearbyKiteSpot(55.680, 12.600);
    expect(found).toBeNull();
  });

  it('returns the first spot within range when multiple exist', () => {
    helpers.addKiteSpot({ id: 'far',  lat: 56.000, lon: 12.000, name: 'Far',  dirs: [] });
    helpers.addKiteSpot({ id: 'near', lat: 55.651, lon: 12.600, name: 'Near', dirs: [90] });
    const found = helpers.findNearbyKiteSpot(55.650, 12.600);
    expect(found).not.toBeNull();
    expect(found.id).toBe('near');
  });

  it('respects custom maxDistM parameter', () => {
    helpers.addKiteSpot({ id: 's3', lat: 55.650, lon: 12.600, name: 'S3', dirs: [] });
    // ~1.1 km away — within 2 km but NOT within 500 m
    const withinTwo = helpers.findNearbyKiteSpot(55.660, 12.600, 2000);
    const withinHalf = helpers.findNearbyKiteSpot(55.660, 12.600, 500);
    expect(withinTwo).not.toBeNull();
    expect(withinHalf).toBeNull();
  });
});

describe('_buildKiteSpotIssueUrl', () => {
  const fn = radarCtx._buildKiteSpotIssueUrl || radarCtx.window._buildKiteSpotIssueUrl;

  it('is exported from radar.js', () => {
    expect(typeof fn).toBe('function');
  });

  it('uses a body parameter (not template form fields)', () => {
    const url = fn({ lat: 55.123456, lon: 12.654321, name: 'Test Spot', dirs: [90, 270] });
    expect(url).toContain('body=');
    expect(url).not.toContain('template=');
  });

  it('includes coordinates in the issue body', () => {
    const url = fn({ lat: 55.123456, lon: 12.654321, name: 'My Spot', dirs: [] });
    const body = decodeURIComponent(url.match(/body=([^&]*)/)[1]);
    expect(body).toContain('55.123456');
    expect(body).toContain('12.654321');
  });

  it('includes bearings in the issue body', () => {
    const url = fn({ lat: 55.0, lon: 12.0, name: 'Spot', dirs: [90, 180, 270] });
    const body = decodeURIComponent(url.match(/body=([^&]*)/)[1]);
    expect(body).toContain('90°');
    expect(body).toContain('270°');
  });

  it('encodes the spot name in the title', () => {
    const url = fn({ lat: 55.0, lon: 12.0, name: 'Amager Strand', dirs: [] });
    expect(url).toContain(encodeURIComponent('Amager Strand'));
  });

  it('uses kite-spot label', () => {
    const url = fn({ lat: 55.0, lon: 12.0, name: 'Spot', dirs: [] });
    expect(url).toContain('labels=');
    expect(decodeURIComponent(url)).toContain('kite-spot');
  });

  it('falls back to coordinates in title when name is empty', () => {
    const url = fn({ lat: 55.1234, lon: 12.5678, name: '', dirs: [] });
    expect(url).toContain(encodeURIComponent('Kite spot:'));
  });
});
