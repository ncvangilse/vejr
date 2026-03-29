import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

const { snapBearing } = loadScripts('config.js');

describe('snapBearing', () => {
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
