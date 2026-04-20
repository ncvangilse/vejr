import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// radar.js is an IIFE that requires Leaflet (L). Without it the IIFE returns
// early, but module-level helpers defined before the IIFE are still available.
const ctx = loadScripts('radar.js');
const { _parseNominatimPlace } = ctx;

describe('_parseNominatimPlace', () => {
  it('returns null for null input', () => {
    expect(_parseNominatimPlace(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(_parseNominatimPlace(undefined)).toBeNull();
  });

  it('prefers city over town/village', () => {
    const d = { address: { city: 'Copenhagen', town: 'Rødovre', village: 'Hvidovre' } };
    expect(_parseNominatimPlace(d)).toBe('Copenhagen');
  });

  it('falls back to town when no city', () => {
    const d = { address: { town: 'Roskilde', village: 'Lejre' } };
    expect(_parseNominatimPlace(d)).toBe('Roskilde');
  });

  it('falls back to village when no city/town', () => {
    const d = { address: { village: 'Dragør' } };
    expect(_parseNominatimPlace(d)).toBe('Dragør');
  });

  it('falls back to municipality when no city/town/village', () => {
    const d = { address: { municipality: 'Tårnby Kommune' } };
    expect(_parseNominatimPlace(d)).toBe('Tårnby Kommune');
  });

  it('falls back to first segment of display_name', () => {
    const d = { address: {}, display_name: 'Amager Strand, Sundbyøster, Copenhagen, Capital Region, 2300, Denmark' };
    expect(_parseNominatimPlace(d)).toBe('Amager Strand');
  });

  it('returns null when all fields are absent', () => {
    expect(_parseNominatimPlace({ address: {} })).toBeNull();
  });

  it('handles missing address key gracefully', () => {
    const d = { display_name: 'Somewhere, Denmark' };
    expect(_parseNominatimPlace(d)).toBe('Somewhere');
  });
});
