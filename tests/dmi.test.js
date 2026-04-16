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
const { _dmiHaversine, _dmiFindStation, _dmiMergeObs, _dmiSplitByParam,
        _dmiObsMultiParam, _dmiLatestWindObs, loadDmiObservations } = ctx;

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
  it('returns { nearest: null, all: [] } when no features are returned', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.nearest).toBeNull();
    expect(result.all).toHaveLength(0);
  });

  it('picks the closest station as nearest', async () => {
    const fc = makeStationFC([
      { id: '1', name: 'Near',  lat: 55.01, lon: 12.01 },
      { id: '2', name: 'Far',   lat: 55.40, lon: 12.50 },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.nearest.id).toBe('1');
    expect(result.nearest.name).toBe('Near');
  });

  it('includes ALL active stations in result.all', async () => {
    const fc = makeStationFC([
      { id: '1', name: 'Near',  lat: 55.01, lon: 12.01 },
      { id: '2', name: 'Far',   lat: 55.40, lon: 12.50 },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.all).toHaveLength(2);
    expect(result.all.map(s => s.id)).toContain('1');
    expect(result.all.map(s => s.id)).toContain('2');
  });

  it('skips inactive stations', async () => {
    const fc = makeStationFC([
      { id: '1', name: 'Inactive', lat: 55.01, lon: 12.01, status: 'Inactive' },
      { id: '2', name: 'Active',   lat: 55.05, lon: 12.05, status: 'Active'   },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.nearest.id).toBe('2');
    expect(result.all).toHaveLength(1);
    expect(result.all[0].id).toBe('2');
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
    expect(result.nearest.dist).toBeCloseTo(0, 1);
  });

  it('deduplicates features with the same stationId (DMI returns multiple features per station)', async () => {
    // Simulate the DMI API returning 3 features for the same physical station
    const fc = makeStationFC([
      { id: '1', name: 'Mulstrup', lat: 55.01, lon: 12.01 },
      { id: '1', name: 'Mulstrup', lat: 55.01, lon: 12.01 },
      { id: '1', name: 'Mulstrup', lat: 55.01, lon: 12.01 },
      { id: '2', name: 'Far',      lat: 55.40, lon: 12.50 },
      { id: '2', name: 'Far',      lat: 55.40, lon: 12.50 },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiFindStation(55.0, 12.0);
    expect(result.all).toHaveLength(2);           // 5 features → 2 unique stations
    expect(result.nearest.id).toBe('1');
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

  it('merges wind direction by timestamp', () => {
    const windF = [{ properties: { value: 5.2, observed: '2024-01-01T12:00:00Z' } }];
    const gustF = [{ properties: { value: 8.1, observed: '2024-01-01T12:00:00Z' } }];
    const dirF  = [{ properties: { value: 270,  observed: '2024-01-01T12:00:00Z' } }];
    const obs = _dmiMergeObs(windF, gustF, dirF);
    expect(obs).toHaveLength(1);
    expect(obs[0].dir).toBe(270);
  });

  it('sets dir=null when no direction features provided', () => {
    const windF = [{ properties: { value: 5.2, observed: '2024-01-01T12:00:00Z' } }];
    const obs = _dmiMergeObs(windF, []);
    expect(obs[0].dir).toBeNull();
  });

  it('creates standalone dir-only entry when no wind/gust match', () => {
    const dirF = [{ properties: { value: 90, observed: '2024-01-01T12:00:00Z' } }];
    const obs  = _dmiMergeObs([], [], dirF);
    expect(obs).toHaveLength(1);
    expect(obs[0].wind).toBeNull();
    expect(obs[0].gust).toBeNull();
    expect(obs[0].dir).toBe(90);
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
    ctx.window.DMI_DELAY_MS = 0;  // suppress inter-batch delays in unit tests
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
    const dirFC     = makeObsFC([
      { param: 'wind_dir', value: 270, time: '2024-01-01T10:00:00Z' },
      { param: 'wind_dir', value: 265, time: '2024-01-01T10:10:00Z' },
    ]);

    let fetchCount = 0;
    ctx.fetch = () => {
      fetchCount++;
      // 1st call = station, 2nd = wind_speed, 3rd = wind_gust_always_10min, 4th = wind_dir
      const payloads = [stationFC, windFC, gustFC, dirFC];
      const payload  = payloads[fetchCount - 1] || { features: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    expect(ctx.window.DMI_OBS_STATUS.state).toBe('ok');
    expect(ctx.window.DMI_OBS).not.toBeNull();
    expect(ctx.window.DMI_OBS.stationName).toBe('Kastrup');
    expect(ctx.window.DMI_OBS.obs).toHaveLength(2);
    // First obs should have wind, gust and direction merged
    const first = ctx.window.DMI_OBS.obs.find(o => o.wind === 5.2);
    expect(first.gust).toBe(8.4);
    expect(first.dir).toBe(270);
  });

  it('sets window.DMI_STATIONS to all active stations after successful load', async () => {
    const stationFC = makeStationFC([
      { id: '06180', name: 'Kastrup',    lat: 55.63, lon: 12.65 },
      { id: '06096', name: 'Roskilde',   lat: 55.58, lon: 12.13 },
    ]);
    const windFC = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    let fetchCount = 0;
    ctx.fetch = () => {
      fetchCount++;
      if (fetchCount === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve(stationFC) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fetchCount === 2 ? windFC : { features: [] }) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    expect(ctx.window.DMI_STATIONS).toHaveLength(2);
    expect(ctx.window.DMI_STATIONS.map(s => s.id)).toContain('06180');
    expect(ctx.window.DMI_STATIONS.map(s => s.id)).toContain('06096');
  });

  it('sets window.DMI_STATIONS to empty array when no stations found', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    await loadDmiObservations(55.67, 12.57, 'DK');
    expect(ctx.window.DMI_STATIONS).toHaveLength(0);
  });

  it('status msg uses "name · dist km" format without obs count', async () => {
    const stationFC = makeStationFC([{ id: '06180', name: 'Kastrup', lat: 55.63, lon: 12.65 }]);
    const windFC    = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    // Use eager-capture pattern: capture payload BEFORE incrementing so concurrent
    // Promise.all fetches don't overwrite the index before json() is called.
    const payloads = [stationFC, windFC, { features: [] }, { features: [] }];
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = payloads[fetchCount] || { features: [] };
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
    await loadDmiObservations(55.67, 12.57, 'DK');
    const msg = ctx.window.DMI_OBS_STATUS.msg;
    expect(msg).toMatch(/Kastrup/);
    expect(msg).toMatch(/km/);
    // Should NOT contain obs count in parens
    expect(msg).not.toMatch(/obs/);
  });

  it('calls window.refreshDmiMarker after a successful load', async () => {
    const stationFC = makeStationFC([{ id: '06180', name: 'Kastrup', lat: 55.63, lon: 12.65 }]);
    const windFC    = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    let fetchCount = 0;
    ctx.fetch = () => {
      fetchCount++;
      const payloads = [stationFC, windFC, { features: [] }, { features: [] }];
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payloads[fetchCount - 1] || { features: [] }) });
    };

    let markerRefreshCalled = false;
    ctx.window.refreshDmiMarker = () => { markerRefreshCalled = true; };

    await loadDmiObservations(55.67, 12.57, 'DK');

    expect(markerRefreshCalled).toBe(true);
  });

  it('does NOT call window.refreshDmiMarker for non-DK locations', async () => {
    let markerRefreshCalled = false;
    ctx.window.refreshDmiMarker = () => { markerRefreshCalled = true; };

    await loadDmiObservations(51.5, -0.1, 'GB');

    expect(markerRefreshCalled).toBe(false);
  });

  it('calls window.refreshDmiMarker even when no station is found (to clear stale markers)', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    let markerRefreshCalled = false;
    ctx.window.refreshDmiMarker = () => { markerRefreshCalled = true; };

    await loadDmiObservations(55.67, 12.57, 'DK');

    // refreshDmiMarker is called after setting DMI_STATIONS (even when empty) so the
    // radar map can remove any stale station markers from a previous location.
    expect(markerRefreshCalled).toBe(true);
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

  it('sets station.latest on nearest station after successful load', async () => {
    const stationFC = makeStationFC([{ id: '06180', name: 'Kastrup', lat: 55.63, lon: 12.65 }]);
    const windFC    = makeObsFC([{ param: 'wind_speed', value: 7.2, time: '2024-01-01T12:00:00Z' }]);
    const dirFC     = makeObsFC([{ param: 'wind_dir',   value: 225, time: '2024-01-01T12:00:00Z' }]);
    // payloads[0]=station, [1]=wind_speed, [2]=gust(empty), [3]=dir
    const payloads  = [stationFC, windFC, { features: [] }, dirFC];
    let fetchCount  = 0;
    ctx.fetch = () => {
      const payload = payloads[fetchCount] || { features: [] };   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    const nearest = ctx.window.DMI_STATIONS.find(s => s.id === '06180');
    expect(nearest).toBeTruthy();
    expect(nearest.latest).toBeTruthy();
    expect(nearest.latest.wind).toBe(7.2);
    expect(nearest.latest.dir).toBe(225);
  });

  it('sets state=no-station when all stations have wind obs data absent', async () => {
    // With the fallback logic, if every station in bbox returns empty wind obs,
    // no station is selected and state must be no-station (not ok).
    const stationFC = makeStationFC([{ id: '06180', name: 'Kastrup', lat: 55.63, lon: 12.65 }]);
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = fetchCount === 0 ? stationFC : { features: [] };  // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    // Nearest station Kastrup was found but had no wind data → state=no-station
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
    expect(ctx.window.DMI_OBS).toBeNull();
    // DMI_STATIONS is still populated (stations were found, just had no obs)
    const nearest = ctx.window.DMI_STATIONS.find(s => s.id === '06180');
    expect(nearest).toBeTruthy();
    // station.latest is NOT set when no obs found (station was never selected)
    expect(nearest.latest).toBeUndefined();
  });

  it('pre-caches station.obsHistory on nearest station after successful load', async () => {
    const stationFC = makeStationFC([{ id: '06180', name: 'Kastrup', lat: 55.63, lon: 12.65 }]);
    const windFC    = makeObsFC([
      { param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' },
      { param: 'wind_speed', value: 6.1, time: '2024-01-01T10:10:00Z' },
    ]);
    // payloads[0]=station, [1]=wind_speed, [2]=gust(empty), [3]=dir(empty)
    const payloads  = [stationFC, windFC, { features: [] }, { features: [] }];
    let fetchCount  = 0;
    ctx.fetch = () => {
      const payload = payloads[fetchCount] || { features: [] };   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    const nearest = ctx.window.DMI_STATIONS.find(s => s.id === '06180');
    expect(nearest.obsHistory).toBeTruthy();
    expect(nearest.obsHistory.length).toBe(2);
  });

  it('falls back to next-closest station when nearest has no wind data (regression: Vindebæk→Systofte)', async () => {
    // Regression: geographically nearest station may be online but have no recent
    // obs. The loader must skip it and use the next closest station with actual data.
    const stationFC = makeStationFC([
      { id: 'ST_NEAR',  name: 'NearStation',  lat: 55.10, lon: 12.10 },  // closer, no data
      { id: 'ST_FAR',   name: 'FarStation',   lat: 55.50, lon: 12.50 },  // farther, has data
    ]);
    const farWindFC = makeObsFC([{ param: 'wind_speed', value: 7.0, time: '2024-06-01T12:00:00Z' }]);
    ctx.fetch = (url) => {
      let payload;
      if (url.includes('/station/')) {
        payload = stationFC;
      } else if (url.includes('ST_NEAR')) {
        payload = { features: [] };   // nearest station: no wind data
      } else if (url.includes('ST_FAR') && url.includes('wind_speed')) {
        payload = farWindFC;          // second station: has wind data
      } else {
        payload = { features: [] };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.0, 12.0, 'DK');

    expect(ctx.window.DMI_OBS_STATUS.state).toBe('ok');
    expect(ctx.window.DMI_OBS).not.toBeNull();
    // Must have selected the farther station because it has wind data
    expect(ctx.window.DMI_OBS.stationName).toBe('FarStation');
    expect(ctx.window.DMI_OBS.obs.length).toBeGreaterThan(0);
  });

  // ── Batching / rate-limit tests ─────────────────────────────────────────────

  it('populates .latest on non-nearest station from a combined obs request', async () => {
    const stationFC = makeStationFC([
      { id: '06180', name: 'Kastrup',  lat: 55.63, lon: 12.65 },  // nearest
      { id: '06096', name: 'Roskilde', lat: 55.58, lon: 12.13 },  // non-nearest
    ]);
    const windFC        = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    const roskildeWindFC = makeObsFC([{ param: 'wind_speed', value: 8.0, time: '2024-01-01T10:00:00Z' }]);
    const roskildeDirFC  = makeObsFC([{ param: 'wind_dir',   value: 180, time: '2024-01-01T10:00:00Z' }]);
    // fetch sequence: [0]=station, [1]=wind_speed(nearest), [2]=gust(nearest), [3]=dir(nearest),
    //                 [4]=wind_speed(Roskilde), [5]=wind_dir(Roskilde)
    const payloads = [stationFC, windFC, { features: [] }, { features: [] },
                      roskildeWindFC, roskildeDirFC];
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = payloads[fetchCount] || { features: [] };   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    const roskilde = ctx.window.DMI_STATIONS.find(s => s.id === '06096');
    expect(roskilde).toBeTruthy();
    expect(roskilde.latest).toBeTruthy();
    expect(roskilde.latest.wind).toBe(8.0);
    expect(roskilde.latest.dir).toBe(180);
  });

  it('uses two separate requests (wind_speed + wind_dir) per non-nearest station', async () => {
    // DMI API returns 400 for comma-separated parameterId, so no combined requests.
    const stationFC = makeStationFC([
      { id: '06180', name: 'Kastrup',  lat: 55.63, lon: 12.65 },  // nearest
      { id: '06096', name: 'Roskilde', lat: 55.58, lon: 12.13 },  // non-nearest 1
      { id: '06041', name: 'Thyborøn', lat: 56.70, lon:  8.22 },  // non-nearest 2
    ]);
    const kastrupWindFC = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    const urls = [];
    ctx.fetch = (url) => {
      urls.push(url);
      let payload;
      if (url.includes('/station/')) {
        payload = stationFC;
      } else if (url.includes('stationId=06180') && url.includes('wind_speed')) {
        // Nearest station has wind data so it gets selected
        payload = kastrupWindFC;
      } else {
        payload = { features: [] };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    // 1 station list + 3 nearest obs (wind, gust, dir) + 2 per non-nearest = 1+3+4 = 8 total
    expect(urls).toHaveLength(8);
    // Each non-nearest station gets its own wind_speed and wind_dir URL
    const roskildeUrls = urls.filter(u => u.includes('stationId=06096'));
    expect(roskildeUrls).toHaveLength(2);
    const thyboUrls = urls.filter(u => u.includes('stationId=06041'));
    expect(thyboUrls).toHaveLength(2);
    // No comma-separated parameterId — DMI API returns 400 for that format
    expect(urls.every(u => !u.includes('wind_speed,wind_dir'))).toBe(true);
  });

  it('handles 429 on a non-nearest station gracefully without breaking others', async () => {
    const stationFC = makeStationFC([
      { id: '06180', name: 'Kastrup',  lat: 55.63, lon: 12.65 },  // nearest
      { id: '06096', name: 'Roskilde', lat: 55.58, lon: 12.13 },  // non-nearest batch 1a
      { id: '06041', name: 'Thyborøn', lat: 56.70, lon:  8.22 },  // non-nearest batch 1b
    ]);
    const windFC  = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    const thyboFC = makeObsFC([{ param: 'wind_speed', value: 9.0, time: '2024-01-01T10:00:00Z' }]);
    let fetchCount = 0;
    ctx.fetch = () => {
      const count = ++fetchCount;
      if (count === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve(stationFC) });
      if (count === 2) return Promise.resolve({ ok: true, json: () => Promise.resolve(windFC) });
      if (count <= 4)  return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
      // Roskilde fires 2 concurrent requests (wind_speed=5, wind_dir=6) → both 429
      if (count === 5 || count === 6) return Promise.resolve({ ok: false, status: 429 });
      // Thyborøn fires 2 concurrent requests (wind_speed=7, wind_dir=8) → success
      if (count === 7) return Promise.resolve({ ok: true, json: () => Promise.resolve(thyboFC) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    };

    await loadDmiObservations(55.67, 12.57, 'DK');

    // Overall load must succeed
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('ok');
    // Roskilde: both requests 429 → _dmiLatestWindObs returns null
    const roskilde = ctx.window.DMI_STATIONS.find(s => s.id === '06096');
    expect(roskilde.latest).toBeNull();
    // Thyborøn: should still get its data despite Roskilde's failure
    const thybo = ctx.window.DMI_STATIONS.find(s => s.id === '06041');
    expect(thybo.latest).toBeTruthy();
    expect(thybo.latest.wind).toBe(9.0);
  });

  it('calls refreshDmiMarker after each non-nearest batch (progressive updates)', async () => {
    // 1 nearest + 3 non-nearest → 2 batches (batch1: 2 stations, batch2: 1 station)
    const stationFC = makeStationFC([
      { id: '06180', name: 'Kastrup',  lat: 55.63, lon: 12.65 },
      { id: '06096', name: 'Roskilde', lat: 55.58, lon: 12.13 },
      { id: '06041', name: 'Thyborøn', lat: 56.70, lon:  8.22 },
      { id: '06022', name: 'Tønder',   lat: 54.93, lon:  8.85 },
    ]);
    const kastrupWindFC = makeObsFC([{ param: 'wind_speed', value: 5.2, time: '2024-01-01T10:00:00Z' }]);
    ctx.fetch = (url) => {
      let payload;
      if (url.includes('/station/')) {
        payload = stationFC;
      } else if (url.includes('stationId=06180') && url.includes('wind_speed')) {
        // Nearest station has wind data so it gets selected and non-nearest batch runs
        payload = kastrupWindFC;
      } else {
        payload = { features: [] };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
    let refreshCount = 0;
    ctx.window.refreshDmiMarker = () => { refreshCount++; };

    await loadDmiObservations(55.67, 12.57, 'DK');

    // Call 1: after station list stored in DMI_STATIONS
    // Call 2: after nearest data arrives
    // Call 3: after batch 1 (Roskilde + Thyborøn)
    // Call 4: after batch 2 (Tønder)
    expect(refreshCount).toBe(4);
  });
});

// ── _dmiLatestWindObs ─────────────────────────────────────────────────────────

describe('_dmiLatestWindObs', () => {
  it('returns null when API returns no features', async () => {
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    const result = await _dmiLatestWindObs('99999');
    expect(result).toBeNull();
  });

  it('returns { wind, gust, dir, time } when obs are available', async () => {
    // _dmiLatestWindObs makes two separate requests: wind_speed then wind_dir
    const windFC = makeObsFC([{ param: 'wind_speed', value: 6.5, time: '2024-01-01T12:00:00Z' }]);
    const dirFC  = makeObsFC([{ param: 'wind_dir',   value: 180, time: '2024-01-01T12:00:00Z' }]);
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = fetchCount === 0 ? windFC : dirFC;   // eager: fetch #0=wind, #1=dir
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
    const result = await _dmiLatestWindObs('06180');
    expect(result).not.toBeNull();
    expect(result.wind).toBe(6.5);
    expect(result.dir).toBe(180);
    expect(typeof result.time).toBe('number');
  });

  it('returns null when all obs lack valid wind values', async () => {
    const dirOnlyFC = makeObsFC([{ param: 'wind_dir', value: 90, time: '2024-01-01T12:00:00Z' }]);
    // wind_speed fetch returns empty, dir fetch returns dirOnlyFC
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = fetchCount === 0 ? { features: [] } : dirOnlyFC;   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
    const result = await _dmiLatestWindObs('06180');
    expect(result).toBeNull();
  });

  it('sets dir=null when direction obs are more than 30 min apart from latest wind', async () => {
    const windFC = makeObsFC([{ param: 'wind_speed', value: 5.0, time: '2024-01-01T12:00:00Z' }]);
    const dirFC  = makeObsFC([{ param: 'wind_dir',   value: 90,  time: '2024-01-01T10:00:00Z' }]); // 2h apart
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = fetchCount === 0 ? windFC : dirFC;   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
    const result = await _dmiLatestWindObs('06180');
    expect(result).not.toBeNull();
    expect(result.wind).toBe(5.0);
    expect(result.dir).toBeNull();
  });

  it('handles fetch errors gracefully (returns null)', async () => {
    ctx.fetch = () => Promise.reject(new Error('network error'));
    const result = await _dmiLatestWindObs('06180').catch(() => null);
    expect(result).toBeNull();
  });

  it('picks the most recent valid wind entry', async () => {
    const windFC = makeObsFC([
      { param: 'wind_speed', value: 3.0, time: '2024-01-01T10:00:00Z' },
      { param: 'wind_speed', value: 8.5, time: '2024-01-01T11:50:00Z' },
      { param: 'wind_speed', value: 5.0, time: '2024-01-01T11:00:00Z' },
    ]);
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = fetchCount === 0 ? windFC : { features: [] };   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
    const result = await _dmiLatestWindObs('06180');
    expect(result.wind).toBe(8.5); // most recent
  });
});

// ── _dmiObsMultiParam ─────────────────────────────────────────────────────────
// NOTE: The live DMI API returns 400 Bad Request for comma-separated parameterId
// (e.g. wind_speed,wind_dir), so _dmiLatestWindObs does NOT use this function.
// _dmiObsMultiParam is retained as a utility; these tests verify its URL
// construction and error handling independently of whether the API supports it.

describe('_dmiObsMultiParam', () => {
  it('builds URL with literal comma-separated parameterId (not percent-encoded)', async () => {
    let capturedUrl = null;
    ctx.fetch = (url) => {
      capturedUrl = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    };
    await _dmiObsMultiParam('06180', ['wind_speed', 'wind_dir'],
      '2024-01-01T00:00:00Z', '2024-01-01T03:00:00Z');
    expect(capturedUrl).toContain('parameterId=wind_speed,wind_dir');
    expect(capturedUrl).not.toContain('%2C');  // comma must NOT be URL-encoded
  });

  it('throws dmi-obs-429 on 429 response', async () => {
    ctx.fetch = () => Promise.resolve({ ok: false, status: 429 });
    await expect(
      _dmiObsMultiParam('06180', ['wind_speed', 'wind_dir'],
        '2024-01-01T00:00:00Z', '2024-01-01T03:00:00Z')
    ).rejects.toThrow('dmi-obs-429');
  });

  it('throws dmi-obs-500 on 500 response', async () => {
    ctx.fetch = () => Promise.resolve({ ok: false, status: 500 });
    await expect(
      _dmiObsMultiParam('06180', ['wind_speed', 'wind_dir'],
        '2024-01-01T00:00:00Z', '2024-01-01T03:00:00Z')
    ).rejects.toThrow('dmi-obs-500');
  });

  it('returns FeatureCollection with features for all requested parameters', async () => {
    const fc = makeObsFC([
      { param: 'wind_speed', value: 5.0, time: '2024-01-01T12:00:00Z' },
      { param: 'wind_dir',   value: 270, time: '2024-01-01T12:00:00Z' },
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fc) });
    const result = await _dmiObsMultiParam('06180', ['wind_speed', 'wind_dir'],
      '2024-01-01T00:00:00Z', '2024-01-01T03:00:00Z');
    expect(result.features).toHaveLength(2);
  });

  it('encodes stationId in the URL but not the comma in parameterId', async () => {
    const urls = [];
    ctx.fetch = (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    };
    await _dmiObsMultiParam('station/with spaces', ['wind_speed', 'wind_dir'],
      '2024-01-01T00:00:00Z', '2024-01-01T03:00:00Z');
    expect(urls[0]).toContain('stationId=station%2Fwith%20spaces');
    expect(urls[0]).toContain('parameterId=wind_speed,wind_dir');
  });
});

// ── _dmiSplitByParam ──────────────────────────────────────────────────────────

describe('_dmiSplitByParam', () => {
  it('returns empty object for empty array', () => {
    expect(_dmiSplitByParam([])).toEqual({});
  });

  it('returns empty object for null input', () => {
    expect(_dmiSplitByParam(null)).toEqual({});
  });

  it('splits features into per-parameterId buckets', () => {
    const features = [
      { properties: { parameterId: 'wind_speed', value: 5.0, observed: '2024-01-01T12:00:00Z' } },
      { properties: { parameterId: 'wind_dir',   value: 270, observed: '2024-01-01T12:00:00Z' } },
      { properties: { parameterId: 'wind_speed', value: 6.0, observed: '2024-01-01T12:10:00Z' } },
    ];
    const result = _dmiSplitByParam(features);
    expect(result['wind_speed']).toHaveLength(2);
    expect(result['wind_dir']).toHaveLength(1);
    expect(result['wind_speed'][0].properties.value).toBe(5.0);
    expect(result['wind_speed'][1].properties.value).toBe(6.0);
  });

  it('returns absent key (not empty array) for missing parameterId', () => {
    const features = [
      { properties: { parameterId: 'wind_speed', value: 5.0, observed: '2024-01-01T12:00:00Z' } },
    ];
    const result = _dmiSplitByParam(features);
    expect(result['wind_dir']).toBeUndefined();
  });

  it('handles single-parameter input correctly', () => {
    const features = [
      { properties: { parameterId: 'wind_speed', value: 4.0, observed: '2024-01-01T10:00:00Z' } },
      { properties: { parameterId: 'wind_speed', value: 5.0, observed: '2024-01-01T11:00:00Z' } },
    ];
    const result = _dmiSplitByParam(features);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['wind_speed']).toHaveLength(2);
  });

  it('preserves feature objects by reference', () => {
    const f = { properties: { parameterId: 'wind_speed', value: 5.0, observed: '2024-01-01T12:00:00Z' } };
    const result = _dmiSplitByParam([f]);
    expect(result['wind_speed'][0]).toBe(f);
  });
});

// ── window.dmiLoadStationHistory ──────────────────────────────────────────────

describe('window.dmiLoadStationHistory', () => {
  beforeEach(() => {
    ctx.fetch = () => Promise.reject(new Error('fetch not mocked'));
  });

  it('returns cached obsHistory without fetching if already populated', async () => {
    const station = { id: '06180', obsHistory: [{ t: 1, wind: 5.0, gust: null, dir: null }] };
    let fetchCalled = false;
    ctx.fetch = () => { fetchCalled = true; return Promise.reject(new Error('should not fetch')); };

    const result = await ctx.window.dmiLoadStationHistory(station);

    expect(fetchCalled).toBe(false);
    expect(result).toBe(station.obsHistory);
  });

  it('fetches 24h history, caches on station.obsHistory and returns it', async () => {
    const station = { id: '06180' };
    const windFC  = makeObsFC([
      { param: 'wind_speed', value: 6.0, time: '2024-01-01T10:00:00Z' },
      { param: 'wind_speed', value: 7.0, time: '2024-01-01T11:00:00Z' },
    ]);
    // payloads: [0]=wind_speed, [1]=wind_gust(empty), [2]=wind_dir(empty)
    const payloads = [windFC, { features: [] }, { features: [] }];
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = payloads[fetchCount] || { features: [] };   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    const result = await ctx.window.dmiLoadStationHistory(station);

    expect(result).toBeTruthy();
    expect(result.length).toBe(2);
    expect(station.obsHistory).toBe(result);  // cached
  });

  it('returns empty array when API returns no features', async () => {
    const station = { id: '06180' };
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });

    const result = await ctx.window.dmiLoadStationHistory(station);

    expect(result).toHaveLength(0);
    expect(station.obsHistory).toHaveLength(0);
  });

  it('does not re-fetch on second call (returns cached)', async () => {
    const station = { id: '06180' };
    const windFC  = makeObsFC([{ param: 'wind_speed', value: 5.0, time: '2024-01-01T10:00:00Z' }]);
    // payloads: [0]=wind_speed, [1]=gust(empty), [2]=dir(empty)
    const payloads = [windFC, { features: [] }, { features: [] }];
    let fetchCount = 0;
    ctx.fetch = () => {
      const payload = payloads[fetchCount] || { features: [] };   // eager capture
      fetchCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };

    await ctx.window.dmiLoadStationHistory(station);
    fetchCount = 0; // reset counter

    await ctx.window.dmiLoadStationHistory(station);
    expect(fetchCount).toBe(0); // no new fetches
  });

  it('fetches from the opendataapi.dmi.dk hostname', async () => {
    const station = { id: '06180' };
    const urls = [];
    ctx.fetch = (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [] }) });
    };

    await ctx.window.dmiLoadStationHistory(station);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every(u => u.startsWith('https://opendataapi.dmi.dk/'))).toBe(true);
  });
});

