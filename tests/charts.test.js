/**
 * Unit tests for pure logic functions in charts.js.
 * Loads config.js + weather-icons.js + charts.js in a VM context so that
 * functions like isKiteOptimal / isKiteDirOnly can be tested without a browser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── canvas mock helper ───────────────────────────────────────────────────────

function makeTrackingCanvas() {
  const calls = [];
  let _fillStyle = '', _strokeStyle = '', _lineWidth = 1;
  const ctx2d = {
    calls,
    get fillStyle()    { return _fillStyle; },
    set fillStyle(v)   { _fillStyle = v; },
    get strokeStyle()  { return _strokeStyle; },
    set strokeStyle(v) { _strokeStyle = v; },
    get lineWidth()    { return _lineWidth; },
    set lineWidth(v)   { _lineWidth = v; },
    font: '', textAlign: '', textBaseline: '', globalAlpha: 1,
    setLineDash: () => {},
    beginPath:   () => calls.push({ op: 'beginPath' }),
    closePath:   () => calls.push({ op: 'closePath' }),
    arc:   (x, y, r, s, e) => calls.push({ op: 'arc', r }),
    arcTo: ()  => {},
    moveTo: (x, y) => calls.push({ op: 'moveTo', x, y }),
    lineTo: (x, y) => calls.push({ op: 'lineTo', x, y }),
    rect:        () => calls.push({ op: 'rect' }),
    clip:        () => calls.push({ op: 'clip' }),
    fill:        () => calls.push({ op: 'fill' }),
    stroke:      () => calls.push({ op: 'stroke' }),
    clearRect:   () => {},
    fillRect:    () => {},
    strokeRect:  () => {},
    fillText:    () => {},
    measureText: () => ({ width: 10 }),
    scale:       () => {},
    translate:   () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    save:    () => calls.push({ op: 'save' }),
    restore: () => calls.push({ op: 'restore' }),
  };
  const canvas = {
    getContext: () => ctx2d,
    style: {},
    width: 0, height: 0,
    parentElement: { clientWidth: 400 },
  };
  return { ctx2d, canvas };
}

function loadChartLogic({ kiteCfg = null, shoreMask = null } = {}) {
  const src = [
    readFileSync(resolve(ROOT, 'config.js'),             'utf8'),
    readFileSync(resolve(ROOT, 'weather-icons.js'),      'utf8'),
    readFileSync(resolve(ROOT, 'charts-wind-utils.js'),  'utf8'),
    readFileSync(resolve(ROOT, 'charts.js'),             'utf8'),
  ].join('\n');

  const ctx = vm.createContext({
    window: {
      location:  { search: '', href: 'http://localhost/' },
      history:   { replaceState: () => {} },
      SHORE_MASK: shoreMask,
      devicePixelRatio: 1,
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    // document is not accessed at module level — no stub needed for logic tests
    console, Math, Array, Float32Array, Set, Map,
    Number, String, Boolean, Object,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    URL, URLSearchParams,
    Promise, Error,
  });

  vm.runInContext(src, ctx);

  if (kiteCfg) {
    // Override the parsed KITE_CFG with the test-supplied config
    vm.runInContext(`KITE_CFG = ${JSON.stringify(kiteCfg)};`, ctx);
  }

  return ctx;
}

// ── isKiteOptimal ────────────────────────────────────────────────────────────

describe('isKiteOptimal', () => {
  let ctx;
  beforeEach(() => {
    ctx = loadChartLogic({
      kiteCfg: { min: 7, max: 9, dirs: [90, 270], daylight: false },
    });
  });

  it('returns true when speed and direction are both in range', () => {
    expect(ctx.isKiteOptimal(8, 90, '2024-06-15T12:00')).toBe(true);
  });

  it('returns false when speed is below minimum', () => {
    expect(ctx.isKiteOptimal(6, 90, '2024-06-15T12:00')).toBe(false);
  });

  it('returns false when speed is above maximum', () => {
    expect(ctx.isKiteOptimal(10, 90, '2024-06-15T12:00')).toBe(false);
  });

  it('returns false when direction does not match', () => {
    expect(ctx.isKiteOptimal(8, 180, '2024-06-15T12:00')).toBe(false);
  });
});

// ── isKiteDirOnly ────────────────────────────────────────────────────────────

describe('isKiteDirOnly', () => {
  let ctx;
  beforeEach(() => {
    ctx = loadChartLogic({
      kiteCfg: { min: 7, max: 9, dirs: [90, 270], daylight: false },
    });
  });

  it('returns true when direction matches regardless of speed', () => {
    // Any speed — direction match is all that matters
    expect(ctx.isKiteDirOnly(90,  '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteDirOnly(270, '2024-06-15T12:00')).toBe(true);
  });

  it('returns false when direction does not match', () => {
    expect(ctx.isKiteDirOnly(180, '2024-06-15T12:00')).toBe(false);
    expect(ctx.isKiteDirOnly(0,   '2024-06-15T12:00')).toBe(false);
  });

  it('snaps bearing to nearest 10° before matching', () => {
    // 92° snaps to 90° → should match
    expect(ctx.isKiteDirOnly(92, '2024-06-15T12:00')).toBe(true);
    // 275° snaps to 280° → should NOT match (270 is in dirs, 280 is not)
    expect(ctx.isKiteDirOnly(275, '2024-06-15T12:00')).toBe(false);
  });

  it('respects daylight setting — returns false at night when daylight=true', () => {
    const nightCtx = loadChartLogic({
      kiteCfg: { min: 7, max: 9, dirs: [90], daylight: true },
    });
    // Hour 02 is night (fallback: h < 6)
    expect(nightCtx.isKiteDirOnly(90, '2024-06-15T02:00')).toBe(false);
  });

  it('returns true at night when daylight=false', () => {
    expect(ctx.isKiteDirOnly(90, '2024-06-15T02:00')).toBe(true);
  });
});

// ── _otherModelLineColor ─────────────────────────────────────────────────────

describe('_otherModelLineColor', () => {
  let ctx;
  beforeEach(() => { ctx = loadChartLogic(); });

  it('returns a dark semi-transparent colour in normal (non-inverted) mode', () => {
    const colour = ctx._otherModelLineColor(false);
    // Should contain 0,0,0 (black base) and a low alpha
    expect(colour).toMatch(/rgba?\(0\s*,\s*0\s*,\s*0/);
  });

  it('returns a light semi-transparent colour in inverted (dark-bg) mode', () => {
    const colour = ctx._otherModelLineColor(true);
    // Should contain 255,255,255 (white base)
    expect(colour).toMatch(/rgba?\(255\s*,\s*255\s*,\s*255/);
  });

  it('returns different colours for normal vs inverted mode', () => {
    expect(ctx._otherModelLineColor(false)).not.toBe(ctx._otherModelLineColor(true));
  });
});

// ── windColorStr ─────────────────────────────────────────────────────────────

describe('windColorStr', () => {
  let ctx;
  beforeEach(() => { ctx = loadChartLogic(); });

  it('returns an rgba() string', () => {
    expect(ctx.windColorStr(10)).toMatch(/^rgba\(\d+,\d+,\d+,[\d.]+\)$/);
  });

  it('without alphaOverride, calm wind (0 m/s) has alpha 0 (speed-based)', () => {
    // WINDY_RAMP has alpha 0.00 at 0 m/s
    expect(ctx.windColorStr(0)).toBe('rgba(130,190,255,0)');
  });

  it('alphaOverride=1 forces fully opaque even for calm wind', () => {
    expect(ctx.windColorStr(0, 1)).toBe('rgba(130,190,255,1)');
  });

  it('alphaOverride=0 forces fully transparent regardless of speed', () => {
    const result = ctx.windColorStr(10, 0);
    expect(result).toMatch(/rgba\(\d+,\d+,\d+,0\)/);
  });

  it('alphaOverride=0.5 sets a custom alpha', () => {
    const result = ctx.windColorStr(10, 0.5);
    expect(result).toMatch(/rgba\(\d+,\d+,\d+,0\.5\)/);
  });

  it('high wind speed (10 m/s) has alpha 1 even without override', () => {
    // WINDY_RAMP has alpha 1.00 at 10 m/s
    expect(ctx.windColorStr(10)).toMatch(/rgba\(\d+,\d+,\d+,1\)/);
  });
});

// ── SHORE_MASK must not override KITE_CFG.dirs ──────────────────────────────

describe('isKiteOptimal – SHORE_MASK does not gate bearings already in dirs', () => {
  it('returns true for a "land" bearing when it is explicitly in KITE_CFG.dirs', () => {
    // SHORE_MASK marks bearing 0 as 0% sea (pure land), but user has 0 in dirs.
    const mask = new Float32Array(36); // all zeros → 0% sea for every bearing
    const ctx = loadChartLogic({
      kiteCfg: { min: 0, max: 15, dirs: [0, 90, 180, 270], daylight: false },
      shoreMask: mask,
    });
    expect(ctx.isKiteOptimal(8, 0,   '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(8, 90,  '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(8, 180, '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(8, 270, '2024-06-15T12:00')).toBe(true);
  });

  it('returns true for all 36 bearings with SHORE_MASK fully populated as land', () => {
    const mask = new Float32Array(36); // all 0% sea
    const ctx = loadChartLogic({
      kiteCfg: { min: 0, max: 15, dirs: ALL_DIRS, daylight: false },
      shoreMask: mask,
    });
    for (let deg = 0; deg < 360; deg += 10) {
      expect(ctx.isKiteOptimal(5, deg, '2024-06-15T12:00')).toBe(true);
    }
  });

  it('still returns false for a bearing not in KITE_CFG.dirs regardless of SHORE_MASK', () => {
    const mask = new Float32Array(36).fill(1); // all 100% sea
    const ctx = loadChartLogic({
      kiteCfg: { min: 0, max: 15, dirs: [90, 270], daylight: false },
      shoreMask: mask,
    });
    expect(ctx.isKiteOptimal(8, 0,   '2024-06-15T12:00')).toBe(false);
    expect(ctx.isKiteOptimal(8, 180, '2024-06-15T12:00')).toBe(false);
  });
});

describe('isKiteDirOnly – SHORE_MASK does not gate bearings already in dirs', () => {
  it('returns true for "land" bearings that are in KITE_CFG.dirs', () => {
    const mask = new Float32Array(36); // all 0% sea
    const ctx = loadChartLogic({
      kiteCfg: { min: 0, max: 15, dirs: ALL_DIRS, daylight: false },
      shoreMask: mask,
    });
    for (let deg = 0; deg < 360; deg += 10) {
      expect(ctx.isKiteDirOnly(deg, '2024-06-15T12:00')).toBe(true);
    }
  });
});

// ── all-directions + night mode + range 0–10 (regression for falsy-zero bug) ─

const ALL_DIRS = Array.from({ length: 36 }, (_, i) => i * 10);

describe('isKiteOptimal – all directions, kite-at-night, range 0–10', () => {
  let ctx;
  beforeEach(() => {
    ctx = loadChartLogic({
      kiteCfg: { min: 0, max: 10, dirs: ALL_DIRS, daylight: false },
    });
  });

  it('returns true for minimum edge speed (0 m/s) with any direction', () => {
    expect(ctx.isKiteOptimal(0, 90,  '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(0, 0,   '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(0, 270, '2024-06-15T12:00')).toBe(true);
  });

  it('returns true for mid-range speed (5 m/s) with any direction', () => {
    expect(ctx.isKiteOptimal(5, 0,   '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(5, 90,  '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(5, 180, '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(5, 270, '2024-06-15T12:00')).toBe(true);
    expect(ctx.isKiteOptimal(5, 350, '2024-06-15T12:00')).toBe(true);
  });

  it('returns true for maximum edge speed (10 m/s) with any direction', () => {
    expect(ctx.isKiteOptimal(10, 90, '2024-06-15T12:00')).toBe(true);
  });

  it('returns false for speed just above maximum (11 m/s)', () => {
    expect(ctx.isKiteOptimal(11, 90, '2024-06-15T12:00')).toBe(false);
  });

  it('returns true at night when kite-at-night is active (daylight=false)', () => {
    expect(ctx.isKiteOptimal(5, 90, '2024-06-15T02:00')).toBe(true);
    expect(ctx.isKiteOptimal(5, 90, '2024-06-15T23:00')).toBe(true);
  });

  it('highlights every compass bearing — no direction is excluded', () => {
    for (let deg = 0; deg < 360; deg += 10) {
      expect(ctx.isKiteOptimal(5, deg, '2024-06-15T12:00')).toBe(true);
    }
  });
});

describe('isKiteDirOnly – all directions, kite-at-night', () => {
  let ctx;
  beforeEach(() => {
    ctx = loadChartLogic({
      kiteCfg: { min: 0, max: 10, dirs: ALL_DIRS, daylight: false },
    });
  });

  it('returns true for every 10° bearing in daylight', () => {
    for (let deg = 0; deg < 360; deg += 10) {
      expect(ctx.isKiteDirOnly(deg, '2024-06-15T12:00')).toBe(true);
    }
  });

  it('returns true at night when daylight=false (night mode on)', () => {
    expect(ctx.isKiteDirOnly(0,   '2024-06-15T02:00')).toBe(true);
    expect(ctx.isKiteDirOnly(90,  '2024-06-15T02:00')).toBe(true);
    expect(ctx.isKiteDirOnly(270, '2024-06-15T23:00')).toBe(true);
  });

  it('returns false at night when daylight=true (night mode off)', () => {
    const dayCtx = loadChartLogic({
      kiteCfg: { min: 0, max: 10, dirs: ALL_DIRS, daylight: true },
    });
    expect(dayCtx.isKiteDirOnly(90,  '2024-06-15T02:00')).toBe(false);
    expect(dayCtx.isKiteDirOnly(270, '2024-06-15T23:00')).toBe(false);
  });

  it('direction row is highlighted for all bearings whenever isKiteOptimal is true', () => {
    const cases = [0, 5, 10].flatMap(speed =>
      ALL_DIRS.map(deg => [speed, deg])
    );
    for (const [speed, deg] of cases) {
      const t = '2024-06-15T12:00';
      if (ctx.isKiteOptimal(speed, deg, t)) {
        expect(ctx.isKiteDirOnly(deg, t)).toBe(true);
      }
    }
  });
});

// ── isKiteDirOnly vs isKiteOptimal relationship ──────────────────────────────

describe('isKiteDirOnly is a superset of isKiteOptimal', () => {
  it('whenever isKiteOptimal is true, isKiteDirOnly is also true', () => {
    const ctx = loadChartLogic({
      kiteCfg: { min: 7, max: 9, dirs: [90, 270], daylight: false },
    });
    const cases = [
      [8, 90],  [8, 270],
      [6, 90],  [10, 90],   // speed outside range
      [8, 180],             // direction mismatch
    ];
    for (const [speed, deg] of cases) {
      const t = '2024-06-15T12:00';
      if (ctx.isKiteOptimal(speed, deg, t)) {
        expect(ctx.isKiteDirOnly(deg, t)).toBe(true);
      }
    }
  });
});

// ── _windAxisMax ─────────────────────────────────────────────────────────────

describe('_windAxisMax', () => {
  let ctx;
  beforeEach(() => { ctx = loadChartLogic(); });

  it('returns minimum 5 when all winds are calm', () => {
    expect(ctx._windAxisMax([0, 0, 0], null)).toBe(5);
  });

  it('rounds up to the nearest 5', () => {
    expect(ctx._windAxisMax([7, 8, 6], null)).toBe(10);
    expect(ctx._windAxisMax([10, 11, 9], null)).toBe(15);
    expect(ctx._windAxisMax([5, 5, 5], null)).toBe(5);
  });

  it('uses mean wind as fallback when no ensemble data', () => {
    expect(ctx._windAxisMax([5, 8, 6], null)).toBe(10);
  });

  it('uses ensemble wind p90 as the axis ceiling when ensemble is present', () => {
    const ensWind = { p90: [10, 13, 11], p10: [5, 6, 5] };
    expect(ctx._windAxisMax([5, 8, 6], ensWind)).toBe(15);
  });

  it('uses p90 exclusively when ensemble is present, ignoring mean winds', () => {
    // mean winds reach 17 but p90 only 13 → axis is 15, not 20
    const ensWind = { p90: [10, 13, 11], p10: [5, 6, 5] };
    expect(ctx._windAxisMax([5, 17, 6], ensWind)).toBe(15);
  });

  it('caller-sliced arrays exclude extended-forecast high values', () => {
    // Full 10-slot p90 has a distant storm (22 m/s) in slots 7-9; caller passes
    // only the first 7 slots so the axis stays at 15 instead of 25.
    const full    = [10, 12, 11, 9, 10, 11, 12, 22, 22, 22];
    const ensWind = { p90: full };
    expect(ctx._windAxisMax([5, 5, 5], { p90: full.slice(0, 7) })).toBe(15);
    // Confirm without slicing the storm pushes it to 25.
    expect(ctx._windAxisMax([5, 5, 5], ensWind)).toBe(25);
  });

  it('filters null values in winds array', () => {
    expect(ctx._windAxisMax([null, 12, null], null)).toBe(15);
  });

  it('filters null values in ensWind.p90', () => {
    const ensWind = { p90: [null, 14, null], p10: [null, 7, null] };
    expect(ctx._windAxisMax([5, 5, 5], ensWind)).toBe(15);
  });

  it('raises axis to include obsMax when observed wind exceeds forecast', () => {
    // forecast max 8 → rounds to 10, but observed 17 → raises to 20
    expect(ctx._windAxisMax([6, 8, 7], null, 17)).toBe(20);
  });

  it('obsMax does not lower axis when forecast is already higher', () => {
    expect(ctx._windAxisMax([6, 12, 7], null, 5)).toBe(15);
  });

  it('obsMax=0 (default) preserves existing behaviour', () => {
    expect(ctx._windAxisMax([6, 8, 7], null, 0)).toBe(10);
    expect(ctx._windAxisMax([6, 8, 7], null)).toBe(10);
  });
});

// ── drawWind: gust dashes vs wind dots ───────────────────────────────────────

describe('drawWind observed overlay — gust dash vs wind dot', () => {
  // Build a minimal 3-slot time series starting in the past so the observation
  // falls inside the display window.
  const T0 = new Date('2024-06-15T10:00:00Z').getTime();
  const times = [
    new Date(T0).toISOString(),
    new Date(T0 + 3600000).toISOString(),
    new Date(T0 + 7200000).toISOString(),
  ];
  const winds = [5, 5, 5];
  const gusts = [8, 8, 8];
  const dirs  = [90, 90, 90];
  // Observation falls in the first slot
  const obsT = T0 + 1000;

  function makeDomEl() {
    const el = { style: {}, innerHTML: '', textContent: '', title: '', appendChild: () => {} };
    return el;
  }

  function runDrawWind(obs) {
    const { ctx2d, canvas } = makeTrackingCanvas();
    const vmCtx = loadChartLogic();
    vmCtx.lastData = null;  // app.js global; null disables kite pills and other lastData-gated sections
    vmCtx.document = {
      getElementById: (id) => id === 'c-wind' ? canvas : makeDomEl(),
      createElement: () => makeDomEl(),
    };
    vmCtx.window.DMI_OBS = { obs };
    vmCtx.drawWind(times, gusts, winds, dirs, null, null, null, null, false, 400, null);
    return ctx2d.calls;
  }

  it('gust dash uses moveTo+lineTo with same y (horizontal), followed by stroke not fill', () => {
    const calls = runDrawWind([{ t: obsT, gust: 10, wind: null, dir: 90 }]);
    // Find the horizontal dash: a moveTo immediately followed by a lineTo at the same y
    const dashIdx = calls.findIndex((c, i) =>
      c.op === 'moveTo' && calls[i + 1]?.op === 'lineTo' && calls[i + 1].y === c.y
    );
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    // stroke appears in the same beginPath block (between this moveTo and the next beginPath)
    const nextBegin = calls.findIndex((c, i) => i > dashIdx && c.op === 'beginPath');
    const slice = nextBegin >= 0 ? calls.slice(dashIdx, nextBegin) : calls.slice(dashIdx);
    expect(slice.some(c => c.op === 'stroke')).toBe(true);
    expect(slice.some(c => c.op === 'fill')).toBe(false);
    // no arc at all for gust-only observation (not a circle)
    expect(calls.some(c => c.op === 'arc')).toBe(false);
  });

  it('wind dot uses arc+fill — fill() appears after arc(r=2.5)', () => {
    const calls = runDrawWind([{ t: obsT, gust: null, wind: 5, dir: 90 }]);
    const arcIdx = calls.findIndex(c => c.op === 'arc' && c.r === 2.5);
    expect(arcIdx).toBeGreaterThanOrEqual(0);
    const nextArc = calls.findIndex((c, i) => i > arcIdx && c.op === 'arc');
    const slice = nextArc >= 0 ? calls.slice(arcIdx + 1, nextArc) : calls.slice(arcIdx + 1);
    expect(slice.some(c => c.op === 'fill')).toBe(true);
  });

  it('with both gust and wind: horizontal dash precedes wind arc(r=2.5)', () => {
    const calls = runDrawWind([{ t: obsT, gust: 10, wind: 5, dir: 90 }]);
    const gustIdx = calls.findIndex((c, i) =>
      c.op === 'moveTo' && calls[i + 1]?.op === 'lineTo' && calls[i + 1].y === c.y
    );
    const windIdx = calls.findIndex(c => c.op === 'arc' && c.r === 2.5);
    expect(gustIdx).toBeGreaterThanOrEqual(0);
    expect(windIdx).toBeGreaterThan(gustIdx);
  });
});
