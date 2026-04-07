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

function loadChartLogic({ kiteCfg = null, shoreMask = null } = {}) {
  const src = [
    readFileSync(resolve(ROOT, 'config.js'),        'utf8'),
    readFileSync(resolve(ROOT, 'weather-icons.js'), 'utf8'),
    readFileSync(resolve(ROOT, 'charts.js'),        'utf8'),
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
