import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// Load config first so FORECAST_DAYS / STEP constants are in the same scope
const { ensemblePercentiles } = loadScripts('config.js', 'api.js');

// ── Yr helpers ────────────────────────────────────────────────────────────────

describe('yrSymbolToWmo', () => {
  it('maps clearsky_day to WMO 0', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('clearsky_day')).toBe(0);
  });

  it('maps clearsky_night to WMO 0 (strips _night suffix)', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('clearsky_night')).toBe(0);
  });

  it('maps clearsky_polartwilight to WMO 0', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('clearsky_polartwilight')).toBe(0);
  });

  it('maps rain to WMO 63', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('rain')).toBe(63);
  });

  it('maps heavyrainshowers_day to WMO 82', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('heavyrainshowers_day')).toBe(82);
  });

  it('maps snow to WMO 73', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('snow')).toBe(73);
  });

  it('maps heavyrainshowersandthunder_night to WMO 99', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('heavyrainshowersandthunder_night')).toBe(99);
  });

  it('falls back to WMO 3 (cloudy) for unknown symbols', () => {
    const { yrSymbolToWmo } = loadScripts('config.js', 'api.js');
    expect(yrSymbolToWmo('unknowncode')).toBe(3);
    expect(yrSymbolToWmo(null)).toBe(3);
    expect(yrSymbolToWmo(undefined)).toBe(3);
  });
});

describe('fetchYrWeather', () => {
  // All entry times use UTC midnight so the TZ=UTC test env sees no padding.
  function makeYrResponse(timeseries) {
    return { properties: { timeseries } };
  }

  function makeEntry(isoUtc, instDetails, h1Details, h6Details) {
    return {
      time: isoUtc,
      data: {
        instant: { details: instDetails },
        ...(h1Details ? { next_1_hours: { summary: { symbol_code: 'clearsky_day' }, details: h1Details } } : {}),
        ...(h6Details ? { next_6_hours: { summary: { symbol_code: 'rain' }, details: h6Details } } : {}),
      },
    };
  }

  it('extracts temperature, wind, gust, direction and precipitation from 1h entries', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const inst = { air_temperature: 15, wind_speed: 5, wind_speed_of_gust: 8, wind_from_direction: 180 };
    const resp = makeYrResponse([makeEntry('2026-05-10T00:00:00Z', inst, { precipitation_amount: 0.5 }, null)]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    expect(result.hourly.temperature_2m).toEqual([15]);
    expect(result.hourly.windspeed_10m).toEqual([5]);
    expect(result.hourly.windgusts_10m).toEqual([8]);
    expect(result.hourly.winddirection_10m).toEqual([180]);
    expect(result.hourly.precipitation).toEqual([0.5]);
    expect(result.hourly.weathercode).toEqual([0]); // clearsky_day → WMO 0
  });

  it('falls back to wind_speed for gusts when wind_speed_of_gust is absent', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const inst = { air_temperature: 10, wind_speed: 6, wind_from_direction: 90 };
    const resp = makeYrResponse([makeEntry('2026-05-10T00:00:00Z', inst, { precipitation_amount: 0 }, null)]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    expect(result.hourly.windgusts_10m).toEqual([6]);
  });

  it('expands a 6h entry into 6 hourly slots with evenly spread precipitation', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const inst = { air_temperature: 8, wind_speed: 4, wind_speed_of_gust: 7, wind_from_direction: 270 };
    // UTC midnight → no padding in UTC test environment
    const resp = makeYrResponse([makeEntry('2026-05-10T00:00:00Z', inst, null, { precipitation_amount: 6.0 })]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    expect(result.hourly.time).toHaveLength(6);
    expect(result.hourly.precipitation).toEqual([1, 1, 1, 1, 1, 1]);
    // No next entry → constant temperature (no interpolation partner)
    expect(result.hourly.temperature_2m).toEqual([8, 8, 8, 8, 8, 8]);
    expect(result.hourly.weathercode).toEqual([63, 63, 63, 63, 63, 63]); // rain → WMO 63
  });

  it('interpolates temperature and wind linearly across two consecutive 6h entries', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const instA = { air_temperature: 0,  wind_speed: 0,  wind_speed_of_gust: 0,  wind_from_direction: 0 };
    const instB = { air_temperature: 12, wind_speed: 6,  wind_speed_of_gust: 12, wind_from_direction: 90 };
    const resp = makeYrResponse([
      makeEntry('2026-05-10T00:00:00Z', instA, null, { precipitation_amount: 0 }),
      makeEntry('2026-05-10T06:00:00Z', instB, null, { precipitation_amount: 0 }),
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    // Slots 0-5 interpolate from instA toward instB (t = 0/6 .. 5/6)
    // At h=0 (t=0): values equal instA
    expect(result.hourly.temperature_2m[0]).toBeCloseTo(0);
    // At h=3 (t=0.5): midpoint
    expect(result.hourly.temperature_2m[3]).toBeCloseTo(6);
    expect(result.hourly.windspeed_10m[3]).toBeCloseTo(3);
    expect(result.hourly.windgusts_10m[3]).toBeCloseTo(6);
    // Wind direction interpolates through the shortest arc (0° → 90°, t=0.5 → 45°)
    expect(result.hourly.winddirection_10m[3]).toBeCloseTo(45);
    // Slots 6-11 interpolate from instB with no next entry → constant
    expect(result.hourly.temperature_2m[6]).toBeCloseTo(12);
    expect(result.hourly.temperature_2m[11]).toBeCloseTo(12);
  });

  it('interpolates wind direction through the shortest arc (350° → 10°)', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const instA = { air_temperature: 0, wind_speed: 0, wind_from_direction: 350 };
    const instB = { air_temperature: 0, wind_speed: 0, wind_from_direction: 10 };
    const resp = makeYrResponse([
      makeEntry('2026-05-10T00:00:00Z', instA, null, { precipitation_amount: 0 }),
      makeEntry('2026-05-10T06:00:00Z', instB, null, { precipitation_amount: 0 }),
    ]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    // Shortest arc from 350 to 10 is +20°; at t=0.5 → 360° = 0°
    expect(result.hourly.winddirection_10m[3]).toBeCloseTo(0, 0);
  });

  it('pads hours before first data point with first-entry values (zero precip)', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const inst = { air_temperature: 10, wind_speed: 5, wind_speed_of_gust: 8, wind_from_direction: 90 };
    // 06:00 UTC = 06:00 local in TZ=UTC → 6 hours of padding expected
    const resp = makeYrResponse([makeEntry('2026-05-10T06:00:00Z', inst, { precipitation_amount: 1.0 }, null)]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    // First time should be midnight of the same date
    expect(result.hourly.time[0]).toBe('2026-05-10T00:00');
    // 6 padded + 1 data = 7 total
    expect(result.hourly.time).toHaveLength(7);
    // Padded entries carry first temperature, zero precip
    expect(result.hourly.temperature_2m[0]).toBe(10);
    expect(result.hourly.precipitation[0]).toBe(0);
    // The real data entry sits at index 6
    expect(result.hourly.precipitation[6]).toBe(1.0);
  });

  it('prefers next_1_hours over next_6_hours when both are present', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const inst = { air_temperature: 12, wind_speed: 3, wind_from_direction: 0 };
    const entry = makeEntry('2026-05-10T00:00:00Z', inst, { precipitation_amount: 0.2 }, { precipitation_amount: 3.0 });
    const resp = makeYrResponse([entry]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    // Only 1 slot (1h wins), precipitation = 0.2
    expect(result.hourly.time).toHaveLength(1);
    expect(result.hourly.precipitation).toEqual([0.2]);
  });

  it('returns empty daily object (no sunrise/sunset)', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    const inst = { air_temperature: 5, wind_speed: 2, wind_from_direction: 45 };
    const resp = makeYrResponse([makeEntry('2026-05-10T00:00:00Z', inst, { precipitation_amount: 0 }, null)]);
    ctx.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(resp) });
    const result = await ctx.fetchYrWeather(55.0, 12.0);
    expect(result.daily).toEqual({});
  });

  it('throws when the API response is not ok', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    ctx.fetch = () => Promise.resolve({ ok: false });
    await expect(ctx.fetchYrWeather(55.0, 12.0)).rejects.toThrow('Yr fetch failed');
  });
});

// Helper: build a fake ensemble hourly object with `n` members where each
// member's values at index i are: baseVal + (memberIndex * step).
function makeFakeEnsemble(varName, memberCount, hourCount, baseVal = 0, step = 2) {
  const H = {};
  for (let m = 0; m < memberCount; m++) {
    const key = `${varName}_member${String(m + 1).padStart(2, '0')}`;
    H[key] = Array.from({ length: hourCount }, () => baseVal + m * step);
  }
  return H;
}

describe('fetchEnsemble – forecast_days capped per model', () => {
  it('caps forecast_days to 7 for icon_seamless even when FORECAST_DAYS=16', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    ctx.FORECAST_DAYS = 16;
    let capturedUrl = '';
    ctx.fetch = (url) => { capturedUrl = url; return Promise.reject(new Error('stop')); };
    await ctx.fetchEnsemble(55.0, 12.0, 'dmi_seamless').catch(() => {});
    expect(capturedUrl).toContain('forecast_days=7');
    expect(capturedUrl).not.toContain('forecast_days=16');
  });

  it('caps forecast_days to 15 for ecmwf_ifs04 when FORECAST_DAYS=16', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    ctx.FORECAST_DAYS = 16;
    let capturedUrl = '';
    ctx.fetch = (url) => { capturedUrl = url; return Promise.reject(new Error('stop')); };
    await ctx.fetchEnsemble(55.0, 12.0, 'ecmwf_ifs025').catch(() => {});
    expect(capturedUrl).toContain('forecast_days=15');
  });

  it('uses full FORECAST_DAYS for gfs025 which supports 35 days', async () => {
    const ctx = loadScripts('config.js', 'api.js');
    ctx.FORECAST_DAYS = 16;
    let capturedUrl = '';
    ctx.fetch = (url) => { capturedUrl = url; return Promise.reject(new Error('stop')); };
    await ctx.fetchEnsemble(55.0, 12.0, 'gfs_seamless').catch(() => {});
    expect(capturedUrl).toContain('forecast_days=16');
  });
});

describe('ensemblePercentiles', () => {
  it('returns null when no matching members exist', () => {
    expect(ensemblePercentiles({}, 'nonexistent', 3)).toBeNull();
  });

  it('returns p10 ≤ p50 ≤ p90 for all slots', () => {
    const H = makeFakeEnsemble('temperature_2m', 10, 168);
    const result = ensemblePercentiles(H, 'temperature_2m', 3);
    expect(result).not.toBeNull();
    for (let i = 0; i < result.p10.length; i++) {
      expect(result.p10[i]).toBeLessThanOrEqual(result.p50[i]);
      expect(result.p50[i]).toBeLessThanOrEqual(result.p90[i]);
    }
  });

  it('computes correct percentile indices for 10 members', () => {
    // 10 members with values 0, 2, 4, 6, 8, 10, 12, 14, 16, 18
    const H = makeFakeEnsemble('windspeed_10m', 10, 168, 0, 2);
    const result = ensemblePercentiles(H, 'windspeed_10m', 3);
    // sorted: [0,2,4,6,8,10,12,14,16,18]
    // p10 = vals[floor(10 * 0.10)] = vals[1] = 2
    // p50 = vals[floor(10 * 0.50)] = vals[5] = 10
    // p90 = vals[floor(10 * 0.90)] = vals[9] = 18
    expect(result.p10[0]).toBe(2);
    expect(result.p50[0]).toBe(10);
    expect(result.p90[0]).toBe(18);
  });

  it('skips null values in member arrays', () => {
    const H = {
      temp_member01: [10, null, 30],
      temp_member02: [20, null, 40],
    };
    const result = ensemblePercentiles(H, 'temp', 1);
    // At index 1, both members are null → all percentiles should be null
    expect(result.p50[1]).toBeNull();
    // At index 0 we have [10, 20] → p50 = vals[1] = 20
    expect(result.p50[0]).toBe(20);
  });

  it('returns arrays with length = ceil(hours / step)', () => {
    const hours = 168;
    const step  = 3;
    const H = makeFakeEnsemble('temperature_2m', 5, hours);
    const result = ensemblePercentiles(H, 'temperature_2m', step);
    expect(result.p10.length).toBe(Math.floor(hours / step));
    expect(result.p50.length).toBe(result.p10.length);
    expect(result.p90.length).toBe(result.p10.length);
  });

  it('uses the step parameter to subsample', () => {
    const H = makeFakeEnsemble('precipitation', 5, 168);
    const r1 = ensemblePercentiles(H, 'precipitation', 1);
    const r3 = ensemblePercentiles(H, 'precipitation', 3);
    expect(r1.p50.length).toBeGreaterThan(r3.p50.length);
  });
});
