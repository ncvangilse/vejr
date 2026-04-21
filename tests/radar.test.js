import { describe, it, expect } from 'vitest';
import { loadScripts } from './helpers/loader.js';

// radar.js is an IIFE that requires Leaflet (L). Without it the IIFE returns
// early, but module-level helpers defined before the IIFE are still available.
const ctx = loadScripts('radar.js');
const { _parseNominatimPlace, _nominatimHasLocalDetail } = ctx;

describe('OBS_HISTORY_URL', () => {
  it('points to raw.githubusercontent.com data branch', () => {
    expect(ctx.window.OBS_HISTORY_URL).toBe(
      'https://raw.githubusercontent.com/ncvangilse/vejr/data/obs-history.json.gz',
    );
  });
});

describe('_parseNominatimPlace', () => {
  it('returns null for null input', () => {
    expect(_parseNominatimPlace(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(_parseNominatimPlace(undefined)).toBeNull();
  });

  it('prefers neighbourhood over larger areas', () => {
    const d = { address: { neighbourhood: 'Vesterbro', suburb: 'Indre By', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Vesterbro');
  });

  it('prefers suburb over hamlet/village when no neighbourhood', () => {
    const d = { address: { suburb: 'Sundbyøster', village: 'Dragør', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Sundbyøster');
  });

  it('prefers hamlet over village', () => {
    const d = { address: { hamlet: 'Lille Skensved', village: 'Skensved' } };
    expect(_parseNominatimPlace(d)).toBe('Lille Skensved');
  });

  it('prefers village over town', () => {
    const d = { address: { village: 'Dragør', town: 'Tårnby' } };
    expect(_parseNominatimPlace(d)).toBe('Dragør');
  });

  it('prefers town over city_district/city', () => {
    const d = { address: { town: 'Roskilde', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Roskilde');
  });

  it('falls back to city_district before city', () => {
    const d = { address: { city_district: 'Østerbro', city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Østerbro');
  });

  it('falls back to city when no smaller area available', () => {
    const d = { address: { city: 'Copenhagen' } };
    expect(_parseNominatimPlace(d)).toBe('Copenhagen');
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

describe('_nominatimHasLocalDetail', () => {
  it('returns false for null', () => {
    expect(_nominatimHasLocalDetail(null)).toBe(false);
  });

  it('returns false when only municipality is present', () => {
    expect(_nominatimHasLocalDetail({ address: { municipality: 'Vordingborg Kommune' } })).toBe(false);
  });

  it('returns false when address is missing entirely', () => {
    expect(_nominatimHasLocalDetail({ display_name: 'Somewhere' })).toBe(false);
  });

  it('returns true when city is present', () => {
    expect(_nominatimHasLocalDetail({ address: { city: 'Copenhagen', municipality: 'Copenhagen Kommune' } })).toBe(true);
  });

  it('returns true when village is present', () => {
    expect(_nominatimHasLocalDetail({ address: { village: 'Dragør', municipality: 'Tårnby Kommune' } })).toBe(true);
  });

  it('returns true when neighbourhood is present', () => {
    expect(_nominatimHasLocalDetail({ address: { neighbourhood: 'Vesterbro' } })).toBe(true);
  });

  it('returns true when hamlet is present', () => {
    expect(_nominatimHasLocalDetail({ address: { hamlet: 'Lille Skensved' } })).toBe(true);
  });
});
