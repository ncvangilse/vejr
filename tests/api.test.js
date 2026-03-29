import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// Load config first so FORECAST_DAYS / STEP constants are in the same scope
const { ensemblePercentiles } = loadScripts('config.js', 'api.js');

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
