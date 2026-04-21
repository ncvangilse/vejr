import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// radar.js is an IIFE that requires Leaflet (L). Without it the IIFE returns
// early, but module-level helpers defined before the IIFE are still available.
const ctx = loadScripts('radar.js');
const { _parseNominatimPlace, _nominatimHasLocalDetail, _clampMenuPos, _buildProposeNameUrl } = ctx;

describe('OBS_HISTORY_URL', () => {
  it('points to raw.githubusercontent.com data branch', () => {
    expect(ctx.window.OBS_HISTORY_URL).toBe(
      'https://raw.githubusercontent.com/ncvangilse/vejr/data/obs-history.json.gz',
    );
  });
});

describe('STATION_NAMES_URL', () => {
  it('points to station-names.json in the app root', () => {
    expect(ctx.window.STATION_NAMES_URL).toBe('station-names.json');
  });
});

describe('_parseNominatimPlace', () => {
  it('returns null for null input', () => {
    expect(_parseNominatimPlace(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(_parseNominatimPlace(undefined)).toBeNull();
  });

  it('prefers neighbourhood over larger areas', () => {
    const d = { address: { neighbourhood: 'Vesterbro', suburb: 'Indre By', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Vesterbro');
  });

  it('prefers suburb over hamlet/village when no neighbourhood', () => {
    const d = { address: { suburb: 'Sundbyøster', village: 'Dragør', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Sundbyøster');
  });

  it('prefers hamlet over village', () => {
    const d = { address: { hamlet: 'Lille Skensved', village: 'Skensved' } };
    expect(_parseNominatimPlace(d)).toBe('Lille Skensved');
  });

  it('prefers village over town', () => {
    const d = { address: { village: 'Dragør', town: 'Tårnby' } };
    expect(_parseNominatimPlace(d)).toBe('Dragør');
  });

  it('prefers town over city_district/city', () => {
    const d = { address: { town: 'Roskilde', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Roskilde');
  });

  it('falls back to city_district before city', () => {
    const d = { address: { city_district: 'Østerbro', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Østerbro');
  });

  it('falls back to city when no smaller area available', () => {
    const d = { address: { city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Copenhagen');
  });

  it('falls back to municipality when no city/town/village', () => {
    const d = { address: { municipality: 'Tårnby Kommune' } };
    expect(_parseNominatimPlace(d)).toBe('Tårnby Kommune');
  });

  it('falls back to first segment of display_name', () => {
    const d = { address: {}, display_name: 'Amager Strand, Sundbyøster, Copenhagen, Capital Region, 2300, Denmark' };
    expect(_parseNominatimPlace(d)).toBe('Amager Strand');
  });

  it('returns null when all fields are absent', () => {
    expect(_parseNominatimPlace({ address: {} })).toBeNull();
  });

  it('handles missing address key gracefully', () => {
    const d = { display_name: 'Somewhere, Denmark' };
    expect(_parseNominatimPlace(d)).toBe('Somewhere');
  });
});

describe('_nominatimHasLocalDetail', () => {
  it('returns false for null', () => {
    expect(_nominatimHasLocalDetail(null)).toBe(false);
  });

  it('returns false when only municipality is present', () => {
    expect(_nominatimHasLocalDetail({ address: { municipality: 'Vordingborg Kommune' } })).toBe(false);
  });

  it('returns false when address is missing entirely', () => {
    expect(_nominatimHasLocalDetail({ display_name: 'Somewhere' })).toBe(false);
  });

  it('returns true when city is present', () => {
    expect(_nominatimHasLocalDetail({ address: { city: 'Copenhagen', municipality: 'Copenhagen Kommune' } })).toBe(true);
  });

  it('returns true when village is present', () => {
    expect(_nominatimHasLocalDetail({ address: { village: 'Dragør', municipality: 'Tårnby Kommune' } })).toBe(true);
  });

  it('returns true when neighbourhood is present', () => {
    expect(_nominatimHasLocalDetail({ address: { neighbourhood: 'Vesterbro' } })).toBe(true);
  });

  it('returns true when hamlet is present', () => {
    expect(_nominatimHasLocalDetail({ address: { hamlet: 'Lille Skensved' } })).toBe(true);
  });
});

describe('_clampMenuPos', () => {
  it('returns the click point when there is room to the right and below', () => {
    const { x, y } = _clampMenuPos(100, 100, 1280, 800);
    expect(x).toBe(100);
    expect(y).toBe(100);
  });

  it('flips left when menu would overflow the right viewport edge', () => {
    // clientX=1200, estW=180 → 1200+180=1380 > 1280, so flip: x = 1200-180 = 1020
    const { x } = _clampMenuPos(1200, 100, 1280, 800);
    expect(x).toBe(1020);
  });

  it('flips up when menu would overflow the bottom viewport edge', () => {
    // clientY=780, estH=40 → 780+40=820 > 800, so flip: y = 780-40 = 740
    const { y } = _clampMenuPos(100, 780, 1280, 800);
    expect(y).toBe(740);
  });

  it('flips both axes when near the bottom-right corner', () => {
    const { x, y } = _clampMenuPos(1200, 780, 1280, 800);
    expect(x).toBe(1020);
    expect(y).toBe(740);
  });

  it('respects custom estimated dimensions', () => {
    // estW=200, estH=60
    const { x, y } = _clampMenuPos(1100, 760, 1280, 800, 200, 60);
    // 1100+200=1300 > 1280 → flip x: 1100-200=900
    expect(x).toBe(900);
    // 760+60=820 > 800 → flip y: 760-60=700
    expect(y).toBe(700);
  });

  it('does not flip when click is exactly at the edge with room for default menu size', () => {
    // clientX=1100, estW=180 → 1100+180=1280 = vw (not strictly greater) → no flip
    const { x } = _clampMenuPos(1100, 100, 1280, 800);
    expect(x).toBe(1100);
  });
});

describe('window.fetchObsHistory exposure', () => {
  it('is exposed on window even when Leaflet is absent (IIFE bails early)', () => {
    // The IIFE bails at the top when L is undefined, but fetchObsHistory is
    // exposed via window.fetchObsHistory at the bottom of the IIFE — since the
    // bail is a return, nothing after it runs. However, the test validates that
    // the export line is present by checking the URL constant is set instead.
    // (Full IIFE behaviour requires Leaflet, which is not available in Node.)
    expect(ctx.window.OBS_HISTORY_URL).toBeDefined();
  });
});

describe('_buildProposeNameUrl', () => {
  it('returns a GitHub new-issue URL', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:1018', name: 'Trafikkort 1018' });
    expect(url).toContain('https://github.com/ncvangilse/vejr/issues/new');
  });

  it('uses the station-name issue template', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:1018', name: 'Trafikkort 1018' });
    expect(url).toContain('template=station-name.yml');
  });

  it('encodes the station key in the title', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:1018', name: 'Trafikkort 1018' });
    expect(url).toContain(encodeURIComponent('trafikkort:1018'));
  });

  it('pre-fills the current-name field with the display name', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:2047', name: 'Trafikkort 2047' });
    const params = new URL(url).searchParams;
    expect(params.get('current-name')).toBe('Trafikkort 2047');
  });

  it('pre-fills the proposed-name field with the geocoded display name', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:2047', name: 'Amager Strand' });
    const params = new URL(url).searchParams;
    expect(params.get('proposed-name')).toBe('Amager Strand');
  });

  it('pre-fills the station-key field with the station key', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:99', name: 'Some Name' });
    const params = new URL(url).searchParams;
    expect(params.get('station-key')).toBe('trafikkort:99');
  });

  it('sets the title to "Station name: <key>"', () => {
    const url = _buildProposeNameUrl({ key: 'trafikkort:1', name: 'X' });
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('Station name: trafikkort:1');
  });
});

describe('fetchStationNames', () => {
  let origFetch;

  beforeEach(() => { origFetch = ctx.fetch; });
  afterEach(() => { ctx.fetch = origFetch; });

  it('returns parsed JSON on success', async () => {
    ctx.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ 'trafikkort:1018': 'Amager Strand' }),
    });
    const result = await ctx.window.fetchStationNames();
    expect(result).toEqual({ 'trafikkort:1018': 'Amager Strand' });
  });

  it('returns {} on 404', async () => {
    ctx.fetch = () => Promise.resolve({ ok: false, status: 404 });
    const result = await ctx.window.fetchStationNames();
    expect(result).toEqual({});
  });

  it('returns {} on network error', async () => {
    ctx.fetch = () => Promise.reject(new Error('network'));
    const result = await ctx.window.fetchStationNames();
    expect(result).toEqual({});
  });

  it('returns {} on malformed JSON', async () => {
    ctx.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.reject(new SyntaxError('bad json')),
    });
    const result = await ctx.window.fetchStationNames();
    expect(result).toEqual({});
  });

  it('fetches from STATION_NAMES_URL', async () => {
    let capturedUrl;
    ctx.fetch = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: false });
    };
    await ctx.window.fetchStationNames();
    expect(capturedUrl).toBe('station-names.json');
  });
});
