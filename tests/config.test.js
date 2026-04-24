import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

describe('snapBearing', () => {
  const { snapBearing } = loadScripts('config.js');

  it('returns 0 for 0°', () => {
    expect(snapBearing(0)).toBe(0);
  });

  it('rounds down when below midpoint', () => {
    expect(snapBearing(44)).toBe(40);
  });

  it('rounds up when at or above midpoint', () => {
    expect(snapBearing(45)).toBe(50);
    expect(snapBearing(46)).toBe(50);
  });

  it('wraps 360 back to 0', () => {
    expect(snapBearing(360)).toBe(0);
    expect(snapBearing(355)).toBe(0);   // rounds to 360 → 0
    expect(snapBearing(354)).toBe(350);
  });

  it('handles negative degrees', () => {
    expect(snapBearing(-10)).toBe(350);
    expect(snapBearing(-5)).toBe(0);    // rounds to 0
    expect(snapBearing(-6)).toBe(350);
  });

  it('handles values above 360', () => {
    expect(snapBearing(370)).toBe(10);
    expect(snapBearing(720)).toBe(0);
  });
});

describe('kite settings – localStorage persistence (iOS Home Screen fix)', () => {
  it('returns defaults when no URL params and localStorage is empty', () => {
    const ctx = loadScripts('config.js');
    const cfg = ctx.parseKiteParams();
    expect(cfg.min).toBe(7);
    expect(cfg.max).toBe(9);
    expect(cfg.dirs).toEqual([90, 270]);
    expect(cfg.daylight).toBe(true);
  });

  it('parseKiteParams reads from localStorage when no URL params are present', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_kite_cfg', JSON.stringify({ min: 5, max: 11, dirs: [180], daylight: false }));
    const cfg = ctx.parseKiteParams();
    expect(cfg.min).toBe(5);
    expect(cfg.max).toBe(11);
    expect(cfg.dirs).toEqual([180]);
    expect(cfg.daylight).toBe(false);
  });

  it('URL params take priority over localStorage', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_kite_cfg', JSON.stringify({ min: 5, max: 11, dirs: [180], daylight: false }));
    ctx.window.location.search = '?kite_min=8&kite_max=12';
    const cfg = ctx.parseKiteParams();
    expect(cfg.min).toBe(8);
    expect(cfg.max).toBe(12);
  });

  it('parseKiteParams saves URL-provided settings to localStorage', () => {
    const ctx = loadScripts('config.js');
    ctx.window.location.search = '?kite_min=6&kite_max=10&kite_dirs=180,270';
    ctx.parseKiteParams();
    const stored = JSON.parse(ctx.localStorage.getItem('vejr_kite_cfg'));
    expect(stored.min).toBe(6);
    expect(stored.max).toBe(10);
    expect(stored.dirs).toEqual([180, 270]);
  });

  it('setKiteParams saves settings to localStorage', () => {
    const ctx = loadScripts('config.js');
    ctx.setKiteParams({ min: 6, max: 10, dirs: [180], daylight: true });
    const stored = JSON.parse(ctx.localStorage.getItem('vejr_kite_cfg'));
    expect(stored.min).toBe(6);
    expect(stored.max).toBe(10);
    expect(stored.dirs).toEqual([180]);
    expect(stored.daylight).toBe(true);
  });

  it('setKiteParams-saved settings are restored by parseKiteParams on next load', () => {
    // Simulate: user changes settings → closes app → reopens from Home Screen (no URL params)
    const ctx1 = loadScripts('config.js');
    ctx1.setKiteParams({ min: 4, max: 8, dirs: [270], daylight: false });
    const savedValue = ctx1.localStorage.getItem('vejr_kite_cfg');

    // New "session" with the persisted value pre-loaded but no URL params
    const ctx2 = loadScripts('config.js');
    ctx2.localStorage.setItem('vejr_kite_cfg', savedValue);
    const cfg = ctx2.parseKiteParams();
    expect(cfg.min).toBe(4);
    expect(cfg.max).toBe(8);
    expect(cfg.dirs).toEqual([270]);
    expect(cfg.daylight).toBe(false);
  });

  it('ignores corrupt localStorage data and returns defaults', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_kite_cfg', 'not valid json {{{');
    const cfg = ctx.parseKiteParams();
    expect(cfg.min).toBe(7);
    expect(cfg.max).toBe(9);
    expect(cfg.dirs).toEqual([90, 270]);
    expect(cfg.daylight).toBe(true);
  });

  it('parseKiteParams accepts kite_min=0 without falling back to default', () => {
    // Regression: parseFloat('0') is falsy — must use isNaN guard, not || fallback
    const ctx = loadScripts('config.js');
    ctx.window.location.search = '?kite_min=0&kite_max=10';
    const cfg = ctx.parseKiteParams();
    expect(cfg.min).toBe(0);
    expect(cfg.max).toBe(10);
  });

  it('parseKiteParams accepts kite_max=0 without falling back to default', () => {
    const ctx = loadScripts('config.js');
    ctx.window.location.search = '?kite_max=0';
    const cfg = ctx.parseKiteParams();
    expect(cfg.max).toBe(0);
  });

  it('parseKiteParams with kite_min=0 in localStorage restores zero correctly', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_kite_cfg', JSON.stringify({ min: 0, max: 10, dirs: [90], daylight: false }));
    const cfg = ctx.parseKiteParams();
    expect(cfg.min).toBe(0);
    expect(cfg.max).toBe(10);
  });

  it('parseKiteParams with all 36 bearings in kite_dirs preserves every bearing', () => {
    const allDirs = Array.from({ length: 36 }, (_, i) => i * 10);
    const ctx = loadScripts('config.js');
    ctx.window.location.search = '?kite_dirs=' + allDirs.join(',') + '&kite_at_night=1';
    const cfg = ctx.parseKiteParams();
    expect(cfg.dirs).toHaveLength(36);
    expect(cfg.dirs).toContain(0);
    expect(cfg.dirs).toContain(180);
    expect(cfg.dirs).toContain(350);
    expect(cfg.daylight).toBe(false);
  });
});

describe('?reset=1 clears stored kite config', () => {
  it('removes vejr_kite_cfg from localStorage when ?reset=1 is present', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_kite_cfg', JSON.stringify({ min: 5, dirs: [180] }));
    ctx.window.location.search = '?reset=1';
    ctx.applyResetParam();
    expect(ctx.localStorage.getItem('vejr_kite_cfg')).toBeNull();
  });

  it('removes vejr_city from localStorage when ?reset=1 is present', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_city', '55.123456,12.654321');
    ctx.window.location.search = '?reset=1';
    ctx.applyResetParam();
    expect(ctx.localStorage.getItem('vejr_city')).toBeNull();
  });

  it('strips the reset param from the URL', () => {
    const replaceStateCalls = [];
    const ctx = loadScripts('config.js');
    ctx.window.history.replaceState = (...a) => replaceStateCalls.push(a);
    ctx.window.location.search = '?reset=1';
    ctx.applyResetParam();
    expect(replaceStateCalls).toHaveLength(1);
    expect(replaceStateCalls[0][2]).not.toContain('reset');
  });

  it('preserves other URL params when stripping reset', () => {
    const replaceStateCalls = [];
    const ctx = loadScripts('config.js');
    ctx.window.history.replaceState = (...a) => replaceStateCalls.push(a);
    ctx.window.location.search = '?q=Copenhagen&reset=1';
    ctx.applyResetParam();
    const newUrl = replaceStateCalls[0][2];
    expect(newUrl).toContain('q=Copenhagen');
    expect(newUrl).not.toContain('reset');
  });

  it('does nothing when reset param is absent', () => {
    const ctx = loadScripts('config.js');
    ctx.localStorage.setItem('vejr_kite_cfg', JSON.stringify({ min: 5 }));
    ctx.window.location.search = '?q=Oslo';
    ctx.applyResetParam();
    expect(ctx.localStorage.getItem('vejr_kite_cfg')).not.toBeNull();
  });
});

describe('forecast range', () => {
  it('FORECAST_DAYS is 16 (always shows full 16-day forecast)', () => {
    const ctx = loadScripts('config.js');
    expect(ctx.FORECAST_DAYS).toBe(16);
  });
});
