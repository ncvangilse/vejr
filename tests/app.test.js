import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_SRC = readFileSync(resolve(ROOT, 'app.js'), 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEl(value = '') {
  return {
    value,
    style:      {},
    textContent: '',
    classList:  { contains: () => false, add: () => {}, remove: () => {} },
    addEventListener: () => {},
  };
}

/**
 * Load app.js in a sandboxed vm context with all browser globals mocked.
 *
 * @param {object} opts
 * @param {string}  opts.qParam       – value of the `q` URL parameter (default: none)
 * @param {string|null} opts.savedCity – value stored in localStorage under 'vejr_city'
 * @param {boolean} opts.geoAvailable – whether navigator.geolocation is present
 */
function loadApp({ qParam = '', savedCity = null, geoAvailable = false } = {}) {
  const cityInput        = makeEl();
  const geoCalls         = [];
  const replaceStateCalls = [];

  const store = savedCity != null ? { vejr_city: savedCity } : {};
  const mockLocalStorage = {
    store,
    getItem(key)        { return this.store[key] ?? null; },
    setItem(key, value) { this.store[key] = value; },
  };

  const search = qParam ? `?q=${encodeURIComponent(qParam)}` : '';
  const href   = `http://localhost/${search}`;

  const ctx = vm.createContext({
    window: {
      location:             { search, href },
      history:              { replaceState: (...a) => replaceStateCalls.push(a) },
      addEventListener:     () => {},
      setRadarDragCallback: null,
      SHORE_MASK:           null,
      SHORE_STATUS:         { state: 'idle', msg: '' },
      SHORE_DEBUG:          null,
      devicePixelRatio:     1,
    },
    document: {
      getElementById: (id) => {
        if (id === 'city-input')   return cityInput;
        if (id === 'model-select') return makeEl('dmi_seamless');
        return makeEl();
      },
    },
    localStorage: mockLocalStorage,
    navigator: geoAvailable
      ? { geolocation: { getCurrentPosition: (ok, err, _opts) => { geoCalls.push(true); err(new Error('denied')); } } }
      : {},
    // Web APIs
    URL, URLSearchParams,
    console, Math,
    Array, Float32Array, Set, Map,
    Number, String, Boolean, Object,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    Promise, Error,
    setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error('fetch not mocked')),
    // Stubs for functions/constants defined in other scripts.
    // Use a never-settling promise so async chains stall silently rather than
    // logging unhandled-rejection noise to stderr.
    geocode:            () => new Promise(() => {}),
    fetchWeather:       () => new Promise(() => {}),
    fetchEnsemble:      () => new Promise(() => {}),
    ensemblePercentiles: () => null,
    renderAll:          () => {},
    isKiteOptimal:      () => false,
    snapBearing:        (d) => d,
    FORECAST_DAYS:      7,
    STEP:               3,
    KITE_DEFAULTS:      { min: 4, max: 18, dirs: [], daylight: true },
    KITE_CFG:           { min: 4, max: 18, dirs: [], daylight: true },
    setKiteParams:      () => {},
    parseKiteParams:    () => ({ min: 4, max: 18, dirs: [], daylight: true }),
    SHORE_BEARINGS:     36,
    SHORE_SEA_THRESH:   0.5,
    updateShoreStatusUI: () => {},
    drawShoreCompass:   null,
    analyseShore:       () => {},
    drawShoreDebug:     () => {},
  });

  vm.runInContext(APP_SRC, ctx);

  return { ctx, cityInput, mockLocalStorage, geoCalls, replaceStateCalls };
}

// ── decideInitialLocation unit tests ─────────────────────────────────────────

describe('decideInitialLocation', () => {
  // Load app once; we'll call ctx.decideInitialLocation() directly.
  const { ctx } = loadApp();

  it('returns qparam when q param is present', () => {
    expect(ctx.decideInitialLocation('Oslo', '', null))
      .toEqual({ type: 'qparam', value: 'Oslo' });
  });

  it('returns typed when typed input is present and no q param', () => {
    expect(ctx.decideInitialLocation('', 'London', null))
      .toEqual({ type: 'typed', value: 'London' });
  });

  it('returns saved when only localStorage has a city', () => {
    expect(ctx.decideInitialLocation('', '', 'Paris'))
      .toEqual({ type: 'saved', value: 'Paris' });
  });

  it('returns geolocation when nothing is available', () => {
    expect(ctx.decideInitialLocation('', '', null))
      .toEqual({ type: 'geolocation' });
  });

  it('q param takes priority over typed input', () => {
    expect(ctx.decideInitialLocation('Oslo', 'London', 'Paris'))
      .toEqual({ type: 'qparam', value: 'Oslo' });
  });

  it('typed input takes priority over saved city', () => {
    expect(ctx.decideInitialLocation('', 'London', 'Paris'))
      .toEqual({ type: 'typed', value: 'London' });
  });
});

// ── initialLoad integration tests ────────────────────────────────────────────

describe('initialLoad – location source selection', () => {
  it('uses q param from URL and populates city input', () => {
    const { cityInput, geoCalls } = loadApp({ qParam: 'Copenhagen' });
    expect(cityInput.value).toBe('Copenhagen');
    expect(geoCalls).toHaveLength(0);
  });

  it('uses saved localStorage city and does not request geolocation', () => {
    const { cityInput, geoCalls } = loadApp({ savedCity: 'Berlin', geoAvailable: true });
    expect(cityInput.value).toBe('Berlin');
    expect(geoCalls).toHaveLength(0);
  });

  it('updates the URL q param when using a saved city', () => {
    const { replaceStateCalls } = loadApp({ savedCity: 'Vienna' });
    expect(replaceStateCalls.length).toBeGreaterThan(0);
    const lastUrl = replaceStateCalls.at(-1)[2];
    expect(lastUrl).toContain('q=Vienna');
  });

  it('requests geolocation when no location source is available', () => {
    const { geoCalls } = loadApp({ geoAvailable: true });
    expect(geoCalls).toHaveLength(1);
  });

  it('q param takes priority over saved localStorage city', () => {
    const { cityInput, geoCalls } = loadApp({ qParam: 'Oslo', savedCity: 'Berlin' });
    expect(cityInput.value).toBe('Oslo');
    expect(geoCalls).toHaveLength(0);
  });
});

// ── loadAndSync persists city to localStorage ─────────────────────────────────

describe('loadAndSync', () => {
  it('saves the city to localStorage', () => {
    const { ctx, mockLocalStorage } = loadApp();
    ctx.loadAndSync('Lisbon', 'dmi_seamless');
    expect(mockLocalStorage.store['vejr_city']).toBe('Lisbon');
  });

  it('overwrites a previously saved city', () => {
    const { ctx, mockLocalStorage } = loadApp({ savedCity: 'Berlin' });
    ctx.loadAndSync('Tokyo', 'dmi_seamless');
    expect(mockLocalStorage.store['vejr_city']).toBe('Tokyo');
  });

  it('updates the URL q param', () => {
    const { ctx, replaceStateCalls } = loadApp();
    ctx.loadAndSync('Madrid', 'dmi_seamless');
    const lastUrl = replaceStateCalls.at(-1)[2];
    expect(lastUrl).toContain('q=Madrid');
  });
});
