import { describe, it, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal DMI station GeoJSON FeatureCollection. */
function makeStationFC(stations) {
  return {
    features: stations.map(s => ({
      geometry:   { coordinates: [s.lon, s.lat] },
      properties: { stationId: s.id, name: s.name, status: s.status ?? 'Active' },
    })),
  };
}

/** Build a minimal DMI observation GeoJSON FeatureCollection. */
function makeObsFC(observations) {
  return {
    features: observations.map(o => ({
      geometry:   { coordinates: [12.0, 55.0] },
      properties: { parameterId: o.param, value: o.value, observed: o.time },
    })),
  };
}

// ── Load module ───────────────────────────────────────────────────────────────

const ctx = loadScripts('config.js', 'dmi.js');
const { _dmiHaversine, _dmiFindStation, _dmiMergeObs, loadDmiObservations } = ctx;

// ── _dmiHaversine ─────────────────────────────────────────────────────────────

describe('_dmiHaversine', () => {
  it('returns 0 for identical points', () => {
    expect(_dmiHaversine(55.0, 12.0, 55.0, 12.0)).toBe(0);
  });

  it('Copenhagen ↔ Malmö ≈ 26–30 km', () => {
    const dist = _dmiHaversine(55.6761, 12.5683, 55.6059, 13.0007);
    expect(dist).toBeGreaterThan(24);
    expect(dist).toBeLessThan(30);
  });

  it('Copenhagen ↔ Aarhus ≈ 155–165 km', () => {
    const dist = _dmiHaversine(55.6761, 12.5683, 56.1629, 10.2039);
    expect(dist).toBeGreaterThan(155);
    expect(dist).toBeLessThan(165);
  });

  it('is always non-negative', () => {
    expect(_dmiHaversine(0, 0, -10, -10)).toBeGreaterThanOrEqual(0);
  });
});

// ── _dmiFindStation ───────────────────────────────────────────────────────────

describe('_dmiFindStation', () => {
  it('returns null when no features are returned', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result).toBeNull();
  });

  it('picks the closest station', async () => {
    const fc = makeStationFC([
      { id: '1', name: 'Near',  lat: 55.01, lon: 12.01 },
      { id: '2', name: 'Far',   lat: 55.40, lon: 12.50 },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.id).toBe('1');
    expect(result.name).toBe('Near');
  });

  it('skips inactive stations', async () => {
    const fc = makeStationFC([
      { id: '1', name: 'Inactive', lat: 55.01, lon: 12.01, status: 'Inactive' },
      { id: '2', name: 'Active',   lat: 55.05, lon: 12.05, status: 'Active'   },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.id).toBe('2');
  });

  it('throws dmi-http-NNN on HTTP errors', async () => {
    ctx.fetch = () => Promise.resolve({ ok: false, status: 500 });
    await expect(_dmiFindStation(55.0, 12.0)).rejects.toThrow('dmi-http-500');
  });

  it('throws dmi-http-404 on 404', async () => {
    ctx.fetch = () => Promise.resolve({ ok: false, status: 404 });
    await expect(_dmiFindStation(55.0, 12.0)).rejects.toThrow('dmi-http-404');
  });

  it('returns correct dist in km', async () => {
    const fc = makeStationFC([{ id: '1', name: 'S', lat: 55.0, lon: 12.0 }]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.dist).toBeCloseTo(0, 1);
  });
});

// ── _dmiMergeObs ──────────────────────────────────────────────────────────────

describe('_dmiMergeObs', () => {
  it('merges wind and gust features by timestamp', () => {
    const windF = [{ properties: { parameterId: 'wind_speed',             value: 5.2, observed: '2024-01-01T12:00:00Z' } }];
    const gustF = [{ properties: { parameterId: 'wind_gust_always_10min', value: 8.1, observed: '2024-01-01T12:00:00Z' } }];
    const obs = _dmiMergeObs(windF, gustF);
    expect(obs).toHaveLength(1);
    expect(obs[0].wind).toBe(5.2);
    expect(obs[0].gust).toBe(8.1);
  });

  it('handles wind-only observations (no gust match)', () => {
    const windF = [
      { properties: { value: 5.0, observed: '2024-01-01T12:00:00Z' } },
      { properties: { value: 6.0, observed: '2024-01-01T12:10:00Z' } },
    ];
    const obs = _dmiMergeObs(windF, []);
    expect(obs).toHaveLength(2);
    expect(obs[0].gust).toBeNull();
    expect(obs[1].gust).toBeNull();
  });

  it('handles gust-only observations (no wind match)', () => {
    const gustF = [{ properties: { value: 9.0, observed: '2024-01-01T12:00:00Z' } }];
    const obs = _dmiMergeObs([], gustF);
    expect(obs).toHaveLength(1);
    expect(obs[0].wind).toBeNull();
    expect(obs[0].gust).toBe(9.0);
  });

  it('sorts result by time ascending', () => {
    const windF = [
      { properties: { value: 3.0, observed: '2024-01-01T12:20:00Z' } },
      { properties: { value: 5.0, observed: '2024-01-01T12:00:00Z' } },
      { properties: { value: 4.0, observed: '2024-01-01T12:10:00Z' } },
    ];
    const obs = _dmiMergeObs(windF, []);
    expect(obs[0].wind).toBe(5.0);
    expect(obs[1].wind).toBe(4.0);
    expect(obs[2].wind).toBe(3.0);
  });

  it('stores epoch milliseconds in .t', () => {
    const windF = [{ properties: { value: 5.0, observed: '2024-01-01T12:00:00Z' } }];
    const obs = _dmiMergeObs(windF, []);
    expect(obs[0].t).toBe(new Date('2024-01-01T12:00:00Z').getTime());
  });

  it('returns empty array for empty inputs', () => {
    expect(_dmiMergeObs([], [])).toHaveLength(0);
    expect(_dmiMergeObs(null, null)).toHaveLength(0);
  });
});

// ── loadDmiObservations ───────────────────────────────────────────────────────

describe('loadDmiObservations', () => {
  beforeEach(() => {
    ctx.window.DMI_OBS = null;
    ctx.window.DMI_OBS_STATUS = { state: 'idle', msg: '' };
    ctx.fetch = () => Promise.reject(new Error('unexpected fetch'));
  });

  it('sets state=not-dk and returns when country is not DK/GL/FO', async () => {
    await loadDmiObservations(51.5, -0.1, 'GB');
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('not-dk');
    expect(ctx.window.DMI_OBS).toBeNull();
  });

  it('does NOT skip for DK — proceeds to fetch stations', async () => {
    // Resolve to empty station list (no network error)
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    await loadDmiObservations(55.67, 12.57, 'DK');
    // Should have progressed past the country check
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });

  it('accepts GL (Greenland) as valid DMI country', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    await loadDmiObservations(72.0, -24.0, 'GL');
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });

  it('accepts FO (Faroe Islands) as valid DMI country', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    await loadDmiObservations(62.0, -7.0, 'FO');
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });

  it('sets state=no-station when no stations found nearby', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    await loadDmiObservations(55.67, 12.57, 'DK');
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });

  it('sets state=error on HTTP failure', async () => {
    ctx.fetch = () => Promise.resolve({ ok: false, status: 500 });
    await loadDmiObservations(55.67, 12.57, 'DK');
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('error');
  });

  it('populates window.DMI_OBS on success', async () => {
    const stationFC = makeStationFC([{ id: '06180', name: 'Kastrup', lat: 55.63, lon: 12.65 }]);
    const windFC    = makeObsFC([
      { param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' },
      { param: 'wind_speed', value: 6.1, time: '2024-01-01T10:10:00Z' },
    ]);
    const gustFC    = makeObsFC([
      { param: 'wind_gust_always_10min', value: 8.4, time: '2024-01-01T10:00:00Z' },
    ]);

    let fetchCount = 0;
    ctx.fetch = () => {
      fetchCount++;
      // 1st call = station, 2nd = wind_speed, 3rd = wind_gust_always_10min
      const payloads = [stationFC, windFC, gustFC];
      const payload  = payloads[fetchCount - 1] || { features: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    expect(ctx.window.DMI_OBS_STATUS.state).toBe('ok');
    expect(ctx.window.DMI_OBS).not.toBeNull();
    expect(ctx.window.DMI_OBS.stationName).toBe('Kastrup');
    expect(ctx.window.DMI_OBS.obs).toHaveLength(2);
    // First obs should have both wind and gust merged
    const first = ctx.window.DMI_OBS.obs.find(o => o.wind === 5.2);
    expect(first.gust).toBe(8.4);
  });

  it('builds URLs without api-key parameter', async () => {
    const urls = [];
    ctx.fetch = (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    };
    await loadDmiObservations(55.67, 12.57, 'DK');
    // None of the URLs should contain api-key
    expect(urls.every(u => !u.includes('api-key'))).toBe(true);
    // All should use the open data hostname
    expect(urls.every(u => u.startsWith('https://opendataapi.dmi.dk/'))).toBe(true);
  });
});

