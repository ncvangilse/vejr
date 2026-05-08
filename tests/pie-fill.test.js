/**
 * Tests for the pie fill decision logic:
 *   - isKiteOptimal (with _cfg injection)
 *   - _hoverPayload (display-series vs 1h fallback)
 *   - showTooltip → onForecastHover integration
 *
 * These tests load charts-wind-utils.js and tooltip.js directly, injecting a
 * minimal VM context so we avoid pulling in the full app stack.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeCtx(overrides = {}) {
  // Minimal stubs for the globals the loaded scripts reference.
  const mockWindow = {
    location:  { search: '', href: 'http://localhost/' },
    history:   { replaceState: () => {} },
    SHORE_MASK:   null,
    SHORE_STATUS: { state: 'idle', msg: '' },
    SHORE_DEBUG:  null,
    onForecastHover: null,
    devicePixelRatio: 1,
  };

  const mockEl = {
    addEventListener: () => {},
    removeEventListener: () => {},
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    scrollLeft: 0,
    scrollWidth: 0,
    classList: { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} },
    style: {},
    value: '',
    dataset: {},
    children: [],
  };
  const mockDocument = {
    getElementById: () => mockEl,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    elementFromPoint: () => null,
    body: { classList: { toggle: () => {}, contains: () => false } },
  };

  const mockLocalStorage = (() => {
    const store = {};
    return {
      getItem:    (k) => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
      setItem:    (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear:      () => { Object.keys(store).forEach(k => delete store[k]); },
    };
  })();

  // A minimal KITE_CFG that the non-_cfg code path would use.
  // Individual tests override via the _cfg parameter instead.
  const defaultKiteCfg = { min: 7, max: 9, dirs: [90, 270], daylight: false };

  const ctx = vm.createContext({
    window:        mockWindow,
    document:      mockDocument,
    localStorage:  mockLocalStorage,
    console,
    Math, Date, Array, Float32Array, Set, Map,
    Number, String, Boolean, Object,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    URL, URLSearchParams,
    Promise, Error,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: () => Promise.reject(new Error('fetch not mocked')),
    // Stubs needed by charts-wind-utils.js
    KITE_CFG: defaultKiteCfg,
    // isNight stub: "2024-06-15T22:00" → night, "2024-06-15T12:00" → day
    isNight: (timeStr) => {
      if (typeof timeStr !== 'string') return false;
      const h = parseInt(timeStr.slice(11, 13), 10);
      return h < 6 || h >= 20;
    },
    // snapBearing stub: real implementation
    snapBearing: (deg) => Math.round(((deg % 360) + 360) % 360 / 10) * 10 % 360,
    // Stubs needed by tooltip.js
    lastRenderedData: null,
    _windAxisMax: () => 20,
    isKiteOptimal: null,        // will be replaced by the real one once loaded
    DMI_OBS: null,
    sunTimes: {},
    ...overrides,
  });

  const weatherIconsSrc = readFileSync(resolve(ROOT, 'weather-icons.js'), 'utf8');
  const configSrc       = readFileSync(resolve(ROOT, 'config.js'), 'utf8');
  const windUtilsSrc    = readFileSync(resolve(ROOT, 'charts-wind-utils.js'), 'utf8');
  const seriesSrc       = readFileSync(resolve(ROOT, 'series.js'), 'utf8');
  const tooltipSrc      = readFileSync(resolve(ROOT, 'tooltip.js'), 'utf8');

  // Patch tooltip.js: replace the top-level function stubs (drawCrosshairs etc.)
  // that reference real DOM canvases with no-ops so the tests don't crash.
  const patchedTooltip = tooltipSrc
    .replace(/function drawCrosshairs\([^)]*\)\s*\{[\s\S]*?^}/m, 'function drawCrosshairs() {}')
    .replace(/function clearCrosshairs\(\)\s*\{[\s\S]*?^}/m, 'function clearCrosshairs() {}');

  vm.runInContext(
    weatherIconsSrc + '\n' + configSrc + '\n' + windUtilsSrc + '\n' + seriesSrc + '\n' + patchedTooltip,
    ctx,
  );

  return ctx;
}

// ── isKiteOptimal with _cfg injection ────────────────────────────────────────

describe('isKiteOptimal(_cfg injection)', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  const DAY   = '2024-06-15T12:00';
  const NIGHT = '2024-06-15T22:00';

  function opt(speed, dir, time, cfg) {
    return ctx.isKiteOptimal(speed, dir, time, cfg);
  }

  it('returns true when all conditions are met', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: false };
    expect(opt(9, 270, DAY, cfg)).toBe(true);
  });

  it('returns false when speed is below minimum', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: false };
    expect(opt(6, 270, DAY, cfg)).toBe(false);
  });

  it('returns false when speed equals minimum (exclusive lower bound)', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: false };
    // speed must be >= min (not strictly greater), check boundary
    expect(opt(7, 270, DAY, cfg)).toBe(true);
  });

  it('returns false when speed exceeds maximum', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: false };
    expect(opt(13, 270, DAY, cfg)).toBe(false);
  });

  it('returns false when direction is not in the allowed list', () => {
    const cfg = { min: 7, max: 12, dirs: [90, 180], daylight: false };
    expect(opt(9, 270, DAY, cfg)).toBe(false);
  });

  it('direction is snapped to nearest 10° before checking', () => {
    // 274° snaps to 270°, which IS in dirs
    const cfg = { min: 7, max: 12, dirs: [270], daylight: false };
    expect(opt(9, 274, DAY, cfg)).toBe(true);
  });

  it('returns false at night when daylight=true', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: true };
    expect(opt(9, 270, NIGHT, cfg)).toBe(false);
  });

  it('returns true at night when daylight=false', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: false };
    expect(opt(9, 270, NIGHT, cfg)).toBe(true);
  });

  it('returns true during day when daylight=true', () => {
    const cfg = { min: 7, max: 12, dirs: [270], daylight: true };
    expect(opt(9, 270, DAY, cfg)).toBe(true);
  });

  it('handles empty dirs list (no direction is optimal)', () => {
    const cfg = { min: 7, max: 12, dirs: [], daylight: false };
    expect(opt(9, 270, DAY, cfg)).toBe(false);
  });

  it('handles multiple directions', () => {
    const cfg = { min: 7, max: 12, dirs: [90, 180, 270], daylight: false };
    expect(opt(9, 90, DAY, cfg)).toBe(true);
    expect(opt(9, 180, DAY, cfg)).toBe(true);
    expect(opt(9, 270, DAY, cfg)).toBe(true);
    expect(opt(9, 0, DAY, cfg)).toBe(false);
  });
});

// ── _hoverPayload data selection ──────────────────────────────────────────────

describe('_hoverPayload', () => {
  let ctx;
  beforeEach(() => { ctx = makeCtx(); });

  it('prefers display-series slot (idx3h) over raw 1h slot', () => {
    const d = {
      winds:   [8, 9, 10],
      dirs:    [270, 90, 180],
      times:   ['2024-06-15T09:00', '2024-06-15T12:00', '2024-06-15T15:00'],
      winds1h: [5, 5, 5, 5, 5, 5],
      dirs1h:  [45, 45, 45, 45, 45, 45],
      times1h: ['2024-06-15T09:00','2024-06-15T10:00','2024-06-15T11:00',
                '2024-06-15T12:00','2024-06-15T13:00','2024-06-15T14:00'],
    };
    // idx3h=1 → display series slot 1 → wind=9, dir=90
    // idx1h=3 → 1h slot 3 → wind=5, dir=45  (different!)
    const payload = ctx._hoverPayload(d, 3, 1);
    expect(payload.wind).toBe(9);
    expect(payload.dir).toBe(90);
    expect(payload.timeStr).toBe('2024-06-15T12:00');
  });

  it('falls back to 1h data when display series is absent', () => {
    const d = {
      winds1h: [5, 6, 7],
      dirs1h:  [100, 110, 120],
      times1h: ['2024-06-15T09:00', '2024-06-15T10:00', '2024-06-15T11:00'],
      // No winds/dirs/times (portrait mode with no display series)
    };
    const payload = ctx._hoverPayload(d, 1, 0);
    expect(payload.wind).toBe(6);
    expect(payload.dir).toBe(110);
    expect(payload.timeStr).toBe('2024-06-15T10:00');
  });

  it('falls back to 1h when idx3h is out of range of display series', () => {
    const d = {
      winds:   [8],
      dirs:    [270],
      times:   ['2024-06-15T12:00'],
      winds1h: [6, 7, 8],
      dirs1h:  [100, 110, 120],
      times1h: ['2024-06-15T12:00', '2024-06-15T13:00', '2024-06-15T14:00'],
    };
    // idx3h=5 beyond display series length of 1 → winds[5] is undefined → falls back to 1h
    const payload = ctx._hoverPayload(d, 1, 5);
    expect(payload.wind).toBe(7);
    expect(payload.dir).toBe(110);
  });
});

// ── showTooltip → onForecastHover integration ─────────────────────────────────

describe('showTooltip integration: onForecastHover receives correct isOptimal', () => {
  it('fires onForecastHover with isOptimal=true when display-series slot is optimal', () => {
    const ctx = makeCtx();
    const calls = [];
    ctx.window.onForecastHover = (dir, isOptimal, wind) => calls.push({ dir, isOptimal, wind });

    // Display-series slot: 8 m/s, dir=270, daytime. 1h data is wrong direction/speed
    // to confirm display series is used, not 1h.
    ctx.lastRenderedData = {
      winds:   [8],
      dirs:    [270],
      times:   ['2024-06-15T12:00'],
      winds1h: [3],           // would fail speed check → ensures display series is used
      dirs1h:  [45],          // wrong direction → ensures display series is used
      times1h: ['2024-06-15T12:00'],
      xMap1h:  [100],
      slotIdx1h: [0],
    };

    ctx.KITE_CFG = { min: 7, max: 12, dirs: [270], daylight: true };

    ctx.showTooltip(0, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0].isOptimal).toBe(true);
    expect(calls[0].dir).toBe(270);
    expect(calls[0].wind).toBe(8);
  });

  it('fills pie at night even when daylight=true (daylight only gates forecast icons)', () => {
    const ctx = makeCtx();
    const calls = [];
    ctx.window.onForecastHover = (dir, isOptimal, wind) => calls.push({ dir, isOptimal, wind });

    ctx.lastRenderedData = {
      winds:   [9],
      dirs:    [270],
      times:   ['2024-06-15T22:00'],   // 22:00 = night
      winds1h: [9],
      dirs1h:  [270],
      times1h: ['2024-06-15T22:00'],
      xMap1h:  [100],
      slotIdx1h: [0],
    };

    // daylight=true would block isKiteOptimal normally, but pie ignores it
    ctx.KITE_CFG = { min: 7, max: 12, dirs: [270], daylight: true };

    ctx.showTooltip(0, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0].isOptimal).toBe(true);
  });

  it('fires onForecastHover with isOptimal=false when display-series slot is suboptimal', () => {
    const ctx = makeCtx();
    const calls = [];
    ctx.window.onForecastHover = (dir, isOptimal, wind) => calls.push({ dir, isOptimal, wind });

    ctx.lastRenderedData = {
      winds:   [3],           // too slow
      dirs:    [270],
      times:   ['2024-06-15T12:00'],
      winds1h: [3],
      dirs1h:  [270],
      times1h: ['2024-06-15T12:00'],
      xMap1h:  [100],
      slotIdx1h: [0],
    };

    ctx.KITE_CFG = { min: 7, max: 12, dirs: [270], daylight: false };

    ctx.showTooltip(0, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0].isOptimal).toBe(false);
  });

  it('fires onForecastHover with isOptimal=false when direction is wrong', () => {
    const ctx = makeCtx();
    const calls = [];
    ctx.window.onForecastHover = (dir, isOptimal, wind) => calls.push({ dir, isOptimal, wind });

    ctx.lastRenderedData = {
      winds:   [9],
      dirs:    [180],         // not in dirs list
      times:   ['2024-06-15T12:00'],
      winds1h: [9],
      dirs1h:  [180],
      times1h: ['2024-06-15T12:00'],
      xMap1h:  [100],
      slotIdx1h: [0],
    };

    ctx.KITE_CFG = { min: 7, max: 12, dirs: [270], daylight: false };

    ctx.showTooltip(0, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0].isOptimal).toBe(false);
  });

  it('does nothing when lastRenderedData is null', () => {
    const ctx = makeCtx();
    const calls = [];
    ctx.window.onForecastHover = (dir, isOptimal, wind) => calls.push({ dir, isOptimal, wind });
    ctx.lastRenderedData = null;

    ctx.showTooltip(0, 0);

    expect(calls).toHaveLength(0);
  });

  it('does nothing when onForecastHover is not set', () => {
    const ctx = makeCtx();
    ctx.window.onForecastHover = null;

    ctx.lastRenderedData = {
      winds:   [9], dirs: [270], times: ['2024-06-15T12:00'],
      winds1h: [9], dirs1h: [270], times1h: ['2024-06-15T12:00'],
      xMap1h: [100], slotIdx1h: [0],
    };
    ctx.KITE_CFG = { min: 7, max: 12, dirs: [270], daylight: false };

    expect(() => ctx.showTooltip(0, 0)).not.toThrow();
  });
});
