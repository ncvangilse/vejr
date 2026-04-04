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
});
