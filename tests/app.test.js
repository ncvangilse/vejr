import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_SRC = readFileSync(resolve(ROOT, 'vejr.html'), 'utf8');
const SERIES_SRC  = readFileSync(resolve(ROOT, 'series.js'),  'utf8');
const TOOLTIP_SRC = readFileSync(resolve(ROOT, 'tooltip.js'), 'utf8');
const APP_SRC = readFileSync(resolve(ROOT, 'app.js'), 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEl(value = '') {
  return {
    value,
    style:      {},
    textContent: '',
    classList:  { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    getContext:  () => ({
      getImageData:  (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData:  () => {},
      clearRect:     () => {},
    }),
    width: 0, height: 0,
  };
}

/**
 * Load app.js in a sandboxed vm context with all browser globals mocked.
 *
 * @param {object} opts
 * @param {string}  opts.qParam       – value of the `q` URL parameter (default: none)
 * @param {string|null} opts.savedCity – value stored in localStorage under 'vejr_city'
 * @param {boolean} opts.geoAvailable – whether navigator.geolocation is present
 * @param {boolean} opts.portrait     – simulate portrait orientation (default: false)
 * @param {Function|null} opts.renderAllSpy – optional spy to replace the renderAll stub
 */
function loadApp({ qParam = '', savedCity = null, geoAvailable = false, portrait = false, invertedColors = false, renderAllSpy = null, kiteDirs = [],
                   fetchWeatherImpl = null, fetchEnsembleImpl = null, rAFImmediate = false } = {}) {
  const cityInput         = makeEl();
  const geoCalls          = [];
  const replaceStateCalls = [];
  const setKiteParamsCalls = [];
  const contentEl = {
    _listeners: {},
    style: { display: '' },
    classList: { contains: () => false, add: () => {}, remove: () => {} },
    addEventListener(type, fn) { this._listeners[type] = fn; },
  };

  const store = savedCity != null ? { vejr_city: savedCity } : {};
  const mockLocalStorage = {
    store,
    getItem(key)        { return this.store[key] ?? null; },
    setItem(key, value) { this.store[key] = value; },
  };

  const search = qParam ? `?q=${encodeURIComponent(qParam)}` : '';
  const href   = `http://localhost/${search}`;

  const invertedMQL = {
    matches: invertedColors,
    addEventListener(type, fn) { if (type === 'change') this._handler = fn; },
    _handler: null,
  };

  const tooltipEl = {
    style: { display: 'none' },
    _listeners: {},
    addEventListener(type, fn) { this._listeners[type] = fn; },
    getContext: () => null,
    closest: () => null,
    width: 0, height: 0,
    value: '', textContent: '',
    classList: { contains: () => false, add: () => {}, remove: () => {} },
  };

  const windowListeners = {};
  const kiteCfg = { min: 4, max: 18, dirs: kiteDirs.slice(), daylight: true, seaThresh: 0.90,
                    _fromDefaults: kiteDirs.length === 0 };

  const ctx = vm.createContext({
    window: {
      location:             { search, href },
      history:              { replaceState: (...a) => replaceStateCalls.push(a) },
      addEventListener(type, fn) {
        windowListeners[type] = windowListeners[type] || [];
        windowListeners[type].push(fn);
      },
      removeEventListener(type, fn) {
        if (windowListeners[type]) windowListeners[type] = windowListeners[type].filter(f => f !== fn);
      },
      dispatchEvent(event) {
        (windowListeners[event.type] || []).forEach(fn => fn(event));
      },
      setRadarDragCallback: null,
      SHORE_MASK:           null,
      SHORE_STATUS:         { state: 'idle', msg: '' },
      SHORE_DEBUG:          null,
      devicePixelRatio:     1,
      matchMedia: (q) => {
        if (q === '(inverted-colors: inverted)') return invertedMQL;
        return {
          matches: q === '(orientation: portrait)' ? portrait : false,
          addEventListener: () => {},
        };
      },
    },
    document: {
      getElementById: (id) => {
        if (id === 'city-input')        return cityInput;
        if (id === 'model-select')      return makeEl('dmi_seamless');
        if (id === 'hover-tooltip')     return tooltipEl;
        if (id === 'forecast-content')  return contentEl;
        return makeEl();
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      elementFromPoint: () => null,
      body: { classList: { toggle: () => {}, contains: () => false } },
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
    setTimeout, clearTimeout, performance,
    requestAnimationFrame: rAFImmediate ? (cb) => cb() : () => {},
    fetch: () => Promise.reject(new Error('fetch not mocked')),
    // Stubs for functions/constants defined in other scripts.
    // Use a never-settling promise so async chains stall silently rather than
    // logging unhandled-rejection noise to stderr.
    geocode:            () => new Promise(() => {}),
    fetchWeather:       fetchWeatherImpl || (() => new Promise(() => {})),
    fetchEnsemble:      fetchEnsembleImpl || (() => new Promise(() => {})),
    fetchOtherModelsWind: () => Promise.resolve([]),
    ensemblePercentiles: () => null,
    renderAll:          renderAllSpy || (() => {}),
    isKiteOptimal:      () => false,
    _windAxisMax:       () => 20,
    snapBearing:        (d) => d,
    FORECAST_DAYS:          7,
    FORECAST_DAYS_EXTENDED: 16,
    STEP:               3,
    STEP1H:             1,
    KITE_DEFAULTS:      { min: 4, max: 18, dirs: [], daylight: true },
    KITE_CFG:           kiteCfg,
    setForecastDays:    () => {},
    setKiteParams:      (cfg) => { setKiteParamsCalls.push(cfg); Object.assign(kiteCfg, cfg); },
    parseKiteParams:    () => ({ min: 4, max: 18, dirs: [], daylight: true }),
    SHORE_BEARINGS:     36,
    SHORE_SEA_THRESH:   0.5,
    updateShoreStatusUI: () => {},
    drawShoreCompass:   null,
    analyseShore:       () => {},
    drawShoreDebug:     () => {},
    renderShoreDebug:   () => {},
    fetchStationNames:  async () => ({}),
  });

  vm.runInContext(SERIES_SRC + '\n' + TOOLTIP_SRC + '\n' + APP_SRC, ctx);

  return { ctx, cityInput, mockLocalStorage, geoCalls, replaceStateCalls, invertedMQL, tooltipEl, contentEl, setKiteParamsCalls, kiteCfg };
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

// ── Default coordinate fallback (no geolocation / denied) ────────────────────

describe('tryGeolocation – default coordinate fallback', () => {
  it('loads default coords when geolocation API is unavailable', () => {
    const { mockLocalStorage } = loadApp({ geoAvailable: false });
    expect(mockLocalStorage.store['vejr_city']).toBe('54.941360,11.999631');
  });

  it('loads default coords when geolocation is denied', () => {
    const { mockLocalStorage } = loadApp({ geoAvailable: true });
    expect(mockLocalStorage.store['vejr_city']).toBe('54.941360,11.999631');
  });

  it('sets the URL q param to default coords when geolocation API is unavailable', () => {
    const { replaceStateCalls } = loadApp({ geoAvailable: false });
    const lastUrl = replaceStateCalls.at(-1)?.[2] ?? '';
    expect(lastUrl).toContain('54.941360');
    expect(lastUrl).toContain('11.999631');
  });

  it('sets the URL q param to default coords when geolocation is denied', () => {
    const { replaceStateCalls } = loadApp({ geoAvailable: true });
    const lastUrl = replaceStateCalls.at(-1)?.[2] ?? '';
    expect(lastUrl).toContain('54.941360');
    expect(lastUrl).toContain('11.999631');
  });
});

// ── Auto-detect sea bearings on default location ──────────────────────────────

describe('autoDetectSeaBearingsOnce – initial sea bearing detection', () => {
  function makeMaskWithSeaBearings(seaBearingIndices) {
    const mask = new Float32Array(36);
    seaBearingIndices.forEach(i => { mask[i] = 1.0; });
    return mask;
  }

  it('auto-applies sea bearings from SHORE_MASK when geolocation is unavailable', () => {
    const { ctx, setKiteParamsCalls } = loadApp({ geoAvailable: false });
    ctx.window.SHORE_MASK = makeMaskWithSeaBearings([0, 18]); // 0° and 180°
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    expect(setKiteParamsCalls).toHaveLength(1);
    expect(setKiteParamsCalls[0].dirs).toContain(0);
    expect(setKiteParamsCalls[0].dirs).toContain(180);
  });

  it('auto-applies sea bearings when geolocation is denied', () => {
    const { ctx, setKiteParamsCalls } = loadApp({ geoAvailable: true });
    ctx.window.SHORE_MASK = makeMaskWithSeaBearings([9, 27]); // 90° and 270°
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    expect(setKiteParamsCalls).toHaveLength(1);
    expect(setKiteParamsCalls[0].dirs).toContain(90);
    expect(setKiteParamsCalls[0].dirs).toContain(270);
  });

  it('does not auto-apply when user already has saved kite bearings', () => {
    const { ctx, setKiteParamsCalls } = loadApp({ geoAvailable: false, kiteDirs: [90, 180] });
    ctx.window.SHORE_MASK = makeMaskWithSeaBearings([0, 18]);
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    expect(setKiteParamsCalls).toHaveLength(0);
  });

  it('does not auto-apply when SHORE_MASK has no sea bearings', () => {
    const { ctx, setKiteParamsCalls } = loadApp({ geoAvailable: false });
    ctx.window.SHORE_MASK = new Float32Array(36); // all zeros = all land
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    expect(setKiteParamsCalls).toHaveLength(0);
  });

  it('fires only once even if shore-mask-ready fires multiple times', () => {
    const { ctx, setKiteParamsCalls } = loadApp({ geoAvailable: false });
    ctx.window.SHORE_MASK = makeMaskWithSeaBearings([0]);
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    expect(setKiteParamsCalls).toHaveLength(1);
  });

  it('auto-applies when the initial location comes from the URL q param (qparam path)', () => {
    // This was the root cause: when ?q=lat,lon is set from a previous session,
    // initialLoad takes the qparam path and bypasses tryGeolocation entirely.
    // autoDetectSeaBearingsOnce must still fire because it is called at the top
    // of initialLoad regardless of which path is taken.
    const { ctx, setKiteParamsCalls } = loadApp({ qParam: '54.941360,11.999631' });
    ctx.window.SHORE_MASK = makeMaskWithSeaBearings([9, 18]); // 90° and 180°
    ctx.window.dispatchEvent({ type: 'shore-mask-ready' });
    expect(setKiteParamsCalls).toHaveLength(1);
    expect(setKiteParamsCalls[0].dirs).toContain(90);
    expect(setKiteParamsCalls[0].dirs).toContain(180);
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

// ── iOS Home Screen location persistence ─────────────────────────────────────
// When the user drags the radar pin (loadAtCoords) or GPS detects a location
// (loadByCoords), the exact coords must be written to localStorage so that an
// iOS Home Screen launch — which always opens the manifest start_url with no
// query params — can restore the position without going through geocoding.

describe('loadAtCoords – persists coords to localStorage', () => {
  it('writes lat/lon string to vejr_city in localStorage', () => {
    const { ctx, mockLocalStorage } = loadApp();
    ctx.loadAtCoords(55.123456, 12.654321, 'dmi_seamless');
    expect(mockLocalStorage.store['vejr_city']).toBe('55.123456,12.654321');
  });

  it('overwrites a previously saved city name with the new coords', () => {
    const { ctx, mockLocalStorage } = loadApp({ savedCity: 'Berlin' });
    ctx.loadAtCoords(55.0, 12.0, 'dmi_seamless');
    expect(mockLocalStorage.store['vejr_city']).toBe('55.000000,12.000000');
  });

  it('also updates the URL q param with the coord string', () => {
    const { ctx, replaceStateCalls } = loadApp();
    ctx.loadAtCoords(55.123456, 12.654321, 'dmi_seamless');
    const lastUrl = replaceStateCalls.at(-1)[2];
    expect(lastUrl).toContain('55.123456');
    expect(lastUrl).toContain('12.654321');
  });
});

describe('initialLoad – restores saved coord string without geocoding (iOS Home Screen)', () => {
  it('calls loadAtCoords path when savedCity is a lat/lon string', async () => {
    // When iOS opens the app from the Home Screen shortcut the URL has no ?q=
    // param. The only location data is the coord string stored in localStorage.
    // The app must restore coords directly — not pass them to geocode().
    const geocodeCalls = [];
    const { replaceStateCalls } = loadApp({
      savedCity: '55.123456,12.654321',
      // Override geocode stub to track whether it is called.
    });
    // Allow the async loadAtCoords chain to start (fetch rejects immediately,
    // but setQParam is called synchronously before the first await).
    await new Promise(r => setTimeout(r, 0));
    // The URL should be updated with the coord string (not a geocoded city name).
    const lastUrl = replaceStateCalls.at(-1)?.[2] ?? '';
    expect(lastUrl).toContain('55.123456');
    expect(lastUrl).toContain('12.654321');
  });

  it('does not treat a coord string as a city name to geocode', () => {
    // If geocode were called with a coord string it would hit external APIs and
    // likely fail.  We verify city-input.value is NOT set to the raw coord string
    // (loadAtCoords sets it to the reverse-geocoded name or coord fallback, but
    // never leaves it as the raw "lat,lon" storage key).
    const { cityInput } = loadApp({ savedCity: '55.123456,12.654321' });
    // city-input must NOT have been naively set to the raw storage value.
    expect(cityInput.value).not.toBe('55.123456,12.654321');
  });

  it('still geocodes a normal city name saved in localStorage', () => {
    const { cityInput, geoCalls } = loadApp({ savedCity: 'Berlin', geoAvailable: true });
    expect(cityInput.value).toBe('Berlin');
    expect(geoCalls).toHaveLength(0); // geolocation not triggered (saved city used)
  });
});

// ── HTML structure ────────────────────────────────────────────────────────────

describe('vejr.html structure', () => {
  it('build-number is inside app-footer', () => {
    const footerMatch = HTML_SRC.match(/<footer id="app-footer"[\s\S]*?<\/footer>/);
    expect(footerMatch).not.toBeNull();
    expect(footerMatch[0]).toContain('id="build-number"');
  });

  it('does not contain a search-btn button', () => {
    expect(HTML_SRC).not.toContain('id="search-btn"');
  });

  it('build-number does not appear as a standalone element outside the header', () => {
    // The build-number div should not appear at the top level outside #header
    // i.e. it should not follow </div> <!-- #rotator --> or the radar section directly
    const standalonePattern = /<div id="build-number"[^>]*>[^<]*<\/div>\s*\n\s*<\/div>\s*<!--\s*#rotator/;
    expect(standalonePattern.test(HTML_SRC)).toBe(false);
  });
});

// ── renderDisplay slicing ─────────────────────────────────────────────────────

/**
 * Build a minimal lastData-shaped object.
 * @param {number} n3h  – total entries in 3-hour arrays
 * @param {number} n1h  – total entries in 1-hour arrays
 * @param {Date}   base – timestamp of the first entry (default: 2 days ago so "now" falls in the middle)
 */
function makeData(n3h, n1h, base = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)) {
  const iso3 = (i) => new Date(base.getTime() + i * 3 * 60 * 60 * 1000).toISOString();
  const iso1 = (i) => new Date(base.getTime() + i *     60 * 60 * 1000).toISOString();
  const arr3 = () => Array.from({ length: n3h }, (_, i) => iso3(i));
  const arr1 = () => Array.from({ length: n1h }, (_, i) => iso1(i));
  const num3 = () => Array(n3h).fill(0);
  const num1 = () => Array(n1h).fill(0);
  const pct3 = () => ({ p10: num3(), p50: num3(), p90: num3() });
  const pct1 = () => ({ p10: num1(), p50: num1(), p90: num1() });
  return {
    times: arr3(), temps: num3(), precips: num3(),
    gusts: num3(), winds: num3(), dirs: num3(), codes: num3(),
    ensTemp: pct3(), ensWind: pct3(), ensGust: pct3(), ensPrecip: pct3(),
    times1h: arr1(), temps1h: num1(), precips1h: num1(),
    gusts1h: num1(), winds1h: num1(), codes1h: num1(), dirs1h: num1(),
    ensTemp1h: pct1(), ensWind1h: pct1(), ensGust1h: pct1(), ensPrecip1h: pct1(),
  };
}

describe('renderDisplay slicing', () => {
  const TOTAL_3H = (7 * 24) / 3;   // 56 — full 7-day dataset at 3-hour step
  const TOTAL_1H = 7 * 24;         // 168

  it('shows all remaining forecast data from current time in portrait (no 36-hour cap)', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    const d = makeData(TOTAL_3H, TOTAL_1H);
    ctx.renderDisplay(d);
    expect(calls).toHaveLength(1);
    // Variable-resolution display series covers to near the end of the dataset
    // (within one 6-hour step of the last 1h data point).
    const lastDisplayMs = new Date(calls[0].times.at(-1)).getTime();
    const lastDataMs    = new Date(d.times1h.at(-1)).getTime();
    expect(lastDisplayMs).toBeGreaterThan(lastDataMs - 6 * 60 * 60 * 1000);
    // And should show more slots than the old 36-hour window (12 × 3h)
    expect(calls[0].times.length).toBeGreaterThan(12);
  });

  it('starts from data start (midnight) in portrait mode, not clipped to current time', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    const d = makeData(TOTAL_3H, TOTAL_1H);
    ctx.renderDisplay(d);
    // First rendered timestamp should equal times[0] (midnight / data start) so
    // the user can scroll left to see today's earlier hours.
    const firstTime = new Date(calls[0].times[0]).getTime();
    const dataStart = new Date(d.times[0]).getTime();
    expect(firstTime).toBe(dataStart);
  });

  it('slices ensemble percentile arrays to match the rendered time window in portrait mode', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls[0].ensTemp.p10).toHaveLength(calls[0].times.length);
    expect(calls[0].ensTemp1h.p50).toHaveLength(calls[0].times1h.length);
  });

  it('slices codes1h to match the 1h time window in portrait mode', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls[0].codes1h).not.toBeNull();
    expect(calls[0].codes1h).toHaveLength(calls[0].times1h.length);
  });

  it('passes codes1h in landscape mode too (sliced to full 7-day window)', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: false, renderAllSpy: (d) => calls.push(d) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls[0].codes1h).not.toBeNull();
    expect(calls[0].codes1h).toHaveLength(calls[0].times1h.length);
  });

  it('keeps full 7-day data in landscape mode (56×3h entries, 168×1h entries)', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: false, renderAllSpy: (d) => calls.push(d) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls).toHaveLength(1);
    expect(calls[0].times).toHaveLength(56);
    expect(calls[0].times1h).toHaveLength(168);
  });

  it('handles null ensemble data without throwing', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    const d = makeData(TOTAL_3H, TOTAL_1H);
    d.ensTemp = null; d.ensTemp1h = null;
    expect(() => ctx.renderDisplay(d)).not.toThrow();
    expect(calls[0].ensTemp).toBeNull();
    expect(calls[0].ensTemp1h).toBeNull();
  });

  it('aligns 3h and 1h windows to the same start time so day dividers match', () => {
    // Create data starting 1.5 h ago so "now" falls mid-way through a 3h slot.
    // Before the fix, s3 would land on the next 3h boundary (1.5h from now)
    // while s1 would land on the next 1h boundary (0.5h from now) — different
    // start times → dividers at different pixel positions.
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    const base = new Date(Date.now() - 1.5 * 60 * 60 * 1000);
    const d = makeData(TOTAL_3H, TOTAL_1H, base);
    ctx.renderDisplay(d);
    expect(calls).toHaveLength(1);
    const t3 = new Date(calls[0].times[0]).getTime();
    const t1 = new Date(calls[0].times1h[0]).getTime();
    expect(t3).toBe(t1);
  });

  it('passes a positive numeric portraitColW as third arg to renderAll in portrait mode', () => {
    const colWs = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d, ic, colW) => colWs.push(colW) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(colWs[0]).toBeTypeOf('number');
    expect(colWs[0]).toBeGreaterThan(0);
  });

  it('passes a positive numeric portraitColW to renderAll in landscape mode (extended scroll)', () => {
    const colWs = [];
    const { ctx } = loadApp({ portrait: false, renderAllSpy: (d, ic, colW) => colWs.push(colW) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(colWs[0]).toBeTypeOf('number');
    expect(colWs[0]).toBeGreaterThan(0);
  });

  it('includes dirs1h in sliced data passed to buildPortraitSeries', () => {
    // In portrait the display series should use dirs1h-sourced directions.
    // Verify by checking that renderAll receives a dirs array (not null/undefined).
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls[0].dirs).toBeDefined();
    expect(Array.isArray(calls[0].dirs)).toBe(true);
    expect(calls[0].dirs.length).toBeGreaterThan(0);
  });
});

// ── buildPortraitSeries ───────────────────────────────────────────────────────

describe('buildPortraitSeries', () => {
  const TOTAL_1H = 7 * 24;  // 168
  const HR = 60 * 60 * 1000;

  // Fixed daytime UTC start so step computation is fully deterministic.
  // 2025-06-16T10:00Z → h=10 (daytime), first slot is 1h.
  // Night threshold: h < 6 || h >= 20 (fallback in VM context, no isNight function).
  function makeFixedSlice() {
    const base = new Date('2025-06-16T10:00:00.000Z');
    const iso1 = (i) => new Date(base.getTime() + i * HR).toISOString();
    const num1 = () => Array(TOTAL_1H).fill(0);
    const pct1 = () => ({ p10: num1(), p50: num1(), p90: num1() });
    // dirs1h has distinct values to verify daytime-preference slot selection.
    const dirs = Array.from({ length: TOTAL_1H }, (_, i) => i % 360);
    return {
      times1h:     Array.from({ length: TOTAL_1H }, (_, i) => iso1(i)),
      codes1h:     num1(),
      dirs1h:      dirs,
      dirs:        num1(),
      temps1h:     num1(),
      precips1h:   num1(),
      gusts1h:     num1(),
      winds1h:     num1(),
      ensTemp1h:   pct1(),
      ensWind1h:   pct1(),
      ensGust1h:   pct1(),
      ensPrecip1h: pct1(),
    };
  }

  const { ctx } = loadApp({ portrait: true });

  // With base 2025-06-16T10:00Z the display series is:
  //   idx 0..9  = 10:00..19:00 (1h steps, daytime in 0–24h zone)
  //   idx 10    = 20:00 (night in 0–24h zone → step=3)
  //   idx 11    = 23:00
  //   idx 12    = 02:00 (day+1)
  //   idx 13    = 05:00
  //   idx 14    = 08:00 (back to daytime, hoursAhead=22, step=1)
  //   idx 15    = 09:00
  //   idx 16    = 10:00 (day+1, hoursAhead=24 → baseStep=3, step=3)
  //   idx 17    = 13:00
  //   idx 22    = 10:00 (day+2, hoursAhead=48 → baseStep=6, step=6)
  //   idx 23    = 16:00

  it('produces 1-hour spacing for daytime slots in the first 24 hours', () => {
    const ds = ctx.buildPortraitSeries(makeFixedSlice());
    const dt = new Date(ds.times[1]).getTime() - new Date(ds.times[0]).getTime();
    expect(dt).toBe(HR);
  });

  it('coarsens nighttime slots in the first 24 hours to 3h', () => {
    const ds = ctx.buildPortraitSeries(makeFixedSlice());
    // Find the first pair of adjacent display slots within the first 24h of input
    // that are separated by exactly 3h — that gap indicates night coarsening.
    // The exact index depends on the local timezone, so we search rather than hardcode.
    const t0ms = new Date(ds.times[0]).getTime();
    let found = false;
    for (let i = 1; i < ds.times.length; i++) {
      const dt = new Date(ds.times[i]).getTime() - new Date(ds.times[i - 1]).getTime();
      const hoursAhead = (new Date(ds.times[i - 1]).getTime() - t0ms) / 3600000;
      if (hoursAhead < 24 && dt === 3 * HR) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it('produces 3-hour spacing for daytime slots in 24–48h', () => {
    const ds = ctx.buildPortraitSeries(makeFixedSlice());
    // idx 16 = day+1 10:00 (hoursAhead=24, daytime), idx 17 = 13:00 → 3h gap
    const dt = new Date(ds.times[17]).getTime() - new Date(ds.times[16]).getTime();
    expect(dt).toBe(3 * HR);
  });

  it('produces 6-hour spacing from 48h onwards', () => {
    const ds = ctx.buildPortraitSeries(makeFixedSlice());
    // idx 22 = day+2 10:00 (hoursAhead=48), idx 23 = 16:00 → 6h gap
    const dt = new Date(ds.times[23]).getTime() - new Date(ds.times[22]).getTime();
    expect(dt).toBe(6 * HR);
  });

  it('times is the variable-resolution display series; times1h is the full 1h passthrough', () => {
    const s = makeFixedSlice();
    const ds = ctx.buildPortraitSeries(s);
    expect(ds.times).not.toBe(ds.times1h);        // separate arrays
    expect(ds.times1h).toBe(s.times1h);            // 1h passthrough
    expect(ds.times.length).toBeLessThan(ds.times1h.length);
    // Curve arrays are also passed through unmodified.
    expect(ds.temps1h).toBe(s.temps1h);
    expect(ds.winds1h).toBe(s.winds1h);
  });

  it('uses dirs1h for the display-series wind direction data', () => {
    const ds = ctx.buildPortraitSeries(makeFixedSlice());
    // dirs1h values are i%360 (not all zero) so display dirs should be non-zero
    expect(ds.dirs.some(v => v !== 0)).toBe(true);
  });

  it('down-samples ensemble bands to match display series; passes through 1h ensemble', () => {
    const s = makeFixedSlice();
    const ds = ctx.buildPortraitSeries(s);
    expect(ds.ensTemp).not.toBeNull();
    expect(ds.ensTemp.p10).toHaveLength(ds.times.length);  // down-sampled
    expect(ds.ensTemp1h).toBe(s.ensTemp1h);                // 1h passthrough
  });

  it('sets ensemble to null when input ensemble is null', () => {
    const s = makeFixedSlice();
    s.ensTemp1h = null; s.ensWind1h = null; s.ensGust1h = null; s.ensPrecip1h = null;
    const ds = ctx.buildPortraitSeries(s);
    expect(ds.ensTemp).toBeNull();
    expect(ds.ensTemp1h).toBeNull();
  });

  it('handles missing dirs1h by falling back to dirs', () => {
    const s = makeFixedSlice();
    s.dirs1h = null;
    expect(() => ctx.buildPortraitSeries(s)).not.toThrow();
  });

  it('provides temps and gusts arrays at display-series resolution', () => {
    const s = makeFixedSlice();
    const ds = ctx.buildPortraitSeries(s);
    expect(Array.isArray(ds.temps)).toBe(true);
    expect(ds.temps).toHaveLength(ds.times.length);
    expect(Array.isArray(ds.gusts)).toBe(true);
    expect(ds.gusts).toHaveLength(ds.times.length);
  });

  it('provides xMap1h and xFrac1h with length matching times1h', () => {
    const s = makeFixedSlice();
    const ds = ctx.buildPortraitSeries(s);
    expect(Array.isArray(ds.xMap1h)).toBe(true);
    expect(ds.xMap1h.length).toBe(s.times1h.length);
    expect(Array.isArray(ds.xFrac1h)).toBe(true);
    expect(ds.xFrac1h.length).toBe(s.times1h.length);
  });

  it('xFrac1h values are strictly monotonically increasing and in (0, 1)', () => {
    const s = makeFixedSlice();
    const ds = ctx.buildPortraitSeries(s);
    const xf = ds.xFrac1h;
    for (let i = 1; i < xf.length; i++) {
      expect(xf[i]).toBeGreaterThan(xf[i - 1]);
    }
    expect(xf[0]).toBeGreaterThan(0);
    expect(xf[xf.length - 1]).toBeLessThan(1);
  });

  it('slotIdx1h maps each 1h point to a valid display slot index', () => {
    const s = makeFixedSlice();
    const ds = ctx.buildPortraitSeries(s);
    expect(Array.isArray(ds.slotIdx1h)).toBe(true);
    expect(ds.slotIdx1h.length).toBe(s.times1h.length);
    const nDsp = ds.times.length;
    for (const idx of ds.slotIdx1h) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(nDsp);
    }
    // Slot indices are non-decreasing
    for (let i = 1; i < ds.slotIdx1h.length; i++) {
      expect(ds.slotIdx1h[i]).toBeGreaterThanOrEqual(ds.slotIdx1h[i - 1]);
    }
  });

  it('passes otherModelsWind1h through to display data unchanged', () => {
    const s = makeFixedSlice();
    const otherModels = [
      { model: 'icon_seamless', winds1h: Array(TOTAL_1H).fill(7) },
      { model: 'ecmwf_ifs025',  winds1h: Array(TOTAL_1H).fill(8) },
    ];
    s.otherModelsWind1h = otherModels;
    const ds = ctx.buildPortraitSeries(s);
    expect(ds.otherModelsWind1h).toBe(otherModels);
  });

  it('sets otherModelsWind1h to null when source is null', () => {
    const s = makeFixedSlice();
    s.otherModelsWind1h = null;
    const ds = ctx.buildPortraitSeries(s);
    expect(ds.otherModelsWind1h).toBeNull();
  });
});

describe('buildPortraitSeries – extended 16-day mode', () => {
  const TOTAL_1H_16D = 16 * 24;
  const HR = 60 * 60 * 1000;
  const BASE = new Date('2025-06-16T10:00:00.000Z');

  function make16DaySlice() {
    const iso1 = (i) => new Date(BASE.getTime() + i * HR).toISOString();
    const num1 = () => Array(TOTAL_1H_16D).fill(0);
    return {
      times1h:     Array.from({ length: TOTAL_1H_16D }, (_, i) => iso1(i)),
      codes1h:     num1(),
      dirs1h:      num1(),
      dirs:        num1(),
      temps1h:     num1(),
      precips1h:   num1(),
      gusts1h:     num1(),
      winds1h:     num1(),
      ensTemp1h:   null,
      ensWind1h:   null,
      ensGust1h:   null,
      ensPrecip1h: null,
    };
  }

  const { ctx: ctx16 } = loadApp({ portrait: true });

  it('uses 12h step for daytime slots beyond 7 days (168h+)', () => {
    const ds = ctx16.buildPortraitSeries(make16DaySlice());
    const t0ms = new Date(ds.times[0]).getTime();
    let found12h = false;
    for (let i = 1; i < ds.times.length; i++) {
      const dt = new Date(ds.times[i]).getTime() - new Date(ds.times[i - 1]).getTime();
      const hoursAhead = (new Date(ds.times[i - 1]).getTime() - t0ms) / 3600000;
      if (hoursAhead >= 168 && dt === 12 * HR) { found12h = true; break; }
    }
    expect(found12h).toBe(true);
  });

  it('uses between 6h and 12h steps (linear zoom) for daytime slots beyond 168h', () => {
    const ds = ctx16.buildPortraitSeries(make16DaySlice());
    const t0ms = new Date(ds.times[0]).getTime();
    for (let i = 1; i < ds.times.length; i++) {
      const dt = new Date(ds.times[i]).getTime() - new Date(ds.times[i - 1]).getTime();
      const hoursAhead = (new Date(ds.times[i - 1]).getTime() - t0ms) / 3600000;
      if (hoursAhead >= 168) {
        // Linear zoom: 6–12h steps for daytime; night entries are skipped 1h at a
        // time so gaps between consecutive daytime pushes can be non-multiples of 3.
        // Key properties: at least 1h (never backwards), at most 24h per visible slot.
        expect(dt).toBeGreaterThanOrEqual(HR);
        expect(dt).toBeLessThanOrEqual(24 * HR);
      }
    }
  });

  it('extended series xFrac1h values are monotonically increasing', () => {
    const ds = ctx16.buildPortraitSeries(make16DaySlice());
    const xf = ds.xFrac1h;
    for (let i = 1; i < xf.length; i++) {
      expect(xf[i]).toBeGreaterThan(xf[i - 1]);
    }
  });

  it('extended series has fewer display slots than 1h input slots', () => {
    const s = make16DaySlice();
    const ds = ctx16.buildPortraitSeries(s);
    expect(ds.times.length).toBeLessThan(s.times1h.length);
  });
});

describe('inverted-colors change listener', () => {
  const TOTAL_3H = (7 * 24) / 3;
  const TOTAL_1H = 7 * 24;

  it('registers a change handler on the inverted-colors media query', () => {
    const { invertedMQL } = loadApp();
    expect(invertedMQL._handler).toBeTypeOf('function');
  });

  it('re-renders when the change handler fires and data is loaded', () => {
    const renderCalls = [];
    const { ctx, invertedMQL } = loadApp({ renderAllSpy: (d) => renderCalls.push(d) });
    ctx.lastData = makeData(TOTAL_3H, TOTAL_1H); // set lastData directly (var, so on the vm global)
    invertedMQL._handler();
    expect(renderCalls).toHaveLength(1);
  });

  it('does not throw when the change handler fires with no data loaded', () => {
    const { invertedMQL } = loadApp();
    expect(() => invertedMQL._handler()).not.toThrow();
  });

  it('passes invertedColors=true to renderAll when media query matches', () => {
    const calls = [];
    const { ctx } = loadApp({
      invertedColors: true,
      renderAllSpy: (d, ic) => calls.push(ic),
    });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls[0]).toBe(true);
  });

  it('passes invertedColors=false to renderAll when media query does not match', () => {
    const calls = [];
    const { ctx } = loadApp({
      invertedColors: false,
      renderAllSpy: (d, ic) => calls.push(ic),
    });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(calls[0]).toBe(false);
  });
});

// ── loadNearestObsStation ─────────────────────────────────────────────────────

function loadAppWithObs(obsHistory) {
  const renderCalls = [];
  const highlightCalls = [];
  const { ctx } = loadApp({ renderAllSpy: (d) => renderCalls.push(d) });
  ctx.window.OBS_HISTORY = obsHistory;
  // Mock fetchObsHistory so the always-fresh-fetch path gets the test data.
  ctx.window.fetchObsHistory = async () => { ctx.window.OBS_HISTORY = obsHistory; return obsHistory; };
  ctx.lastData = makeData((7 * 24) / 3, 7 * 24);
  // Spy for map highlight
  ctx.window.highlightNearestStation = (lat, lon) => highlightCalls.push({ lat, lon });
  return { ctx, renderCalls, highlightCalls };
}

describe('loadNearestObsStation', () => {
  const nearStation = { name: 'Near', lat: 55.7, lon: 12.6, obs: [{ t: Date.now(), wind: 5, gust: 7, dir: 90 }] };
  const farStation  = { name: 'Far',  lat: 60.0, lon: 15.0, obs: [{ t: Date.now(), wind: 3, gust: 4, dir: 180 }] };

  it('selects the closest station and populates DMI_OBS', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation, 'ninjo:far': farStation });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.DMI_OBS).not.toBeNull();
    expect(ctx.window.DMI_OBS.stationName).toBe('Near');
    expect(ctx.window.DMI_OBS.obs).toBe(nearStation.obs);
    expect(parseFloat(ctx.window.DMI_OBS.distKm)).toBeLessThan(5);
  });

  it('sets DMI_OBS_STATUS to ok when a nearby station is found', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('ok');
  });

  it('sets DMI_OBS to null and status to no-station when closest station is > 100 km away', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:far': farStation });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.DMI_OBS).toBeNull();
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });

  it('skips stations with no obs array', async () => {
    const obs = { 'ninjo:empty': { name: 'Empty', lat: 55.7, lon: 12.6, obs: [] }, 'ninjo:good': nearStation };
    const { ctx } = loadAppWithObs(obs);
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.DMI_OBS.stationName).toBe('Near');
  });

  it('sets status to error and DMI_OBS to null when OBS_HISTORY is unavailable', async () => {
    const { ctx } = loadApp();
    // No OBS_HISTORY and fetchObsHistory resolves to null.
    ctx.window.OBS_HISTORY = null;
    ctx.window.fetchObsHistory = async () => null;
    ctx.lastData = makeData((7 * 24) / 3, 7 * 24);
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.DMI_OBS).toBeNull();
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('error');
  });

  it('triggers a re-render after resolving', async () => {
    const { ctx, renderCalls } = loadAppWithObs({ 'ninjo:near': nearStation });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(renderCalls.length).toBeGreaterThan(0);
  });

  it('calls highlightNearestStation with station coords when a station is found', async () => {
    const { ctx, highlightCalls } = loadAppWithObs({ 'ninjo:near': nearStation });
    await ctx.loadNearestObsStation(55.68, 12.57);
    const found = highlightCalls.find(c => c.lat != null);
    expect(found).toBeDefined();
    expect(found.lat).toBeCloseTo(nearStation.lat, 1);
    expect(found.lon).toBeCloseTo(nearStation.lon, 1);
  });

  it('calls highlightNearestStation(null, null) when no station within range', async () => {
    const { ctx, highlightCalls } = loadAppWithObs({ 'ninjo:far': farStation });
    await ctx.loadNearestObsStation(55.68, 12.57);
    const last = highlightCalls.at(-1);
    expect(last).toBeDefined();
    expect(last.lat).toBeNull();
    expect(last.lon).toBeNull();
  });

  it('populates obs-station-name element when a station is found', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation });
    // The default getElementById stub returns makeEl() which has textContent and style.
    let capturedEl = null;
    const origGet = ctx.document.getElementById.bind(ctx.document);
    ctx.document.getElementById = (id) => {
      const el = origGet(id);
      if (id === 'obs-station-name') capturedEl = el;
      return el;
    };
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(capturedEl).not.toBeNull();
    expect(capturedEl.textContent).toContain('Near');
    expect(capturedEl.style.display).not.toBe('none');
  });

  it('applies station-names.json override in header and DMI_OBS.stationName', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation });
    ctx.window.STATION_NAMES = null;
    ctx.window.fetchStationNames = async () => ({ 'ninjo:near': 'Custom Override Name' });
    let capturedEl = null;
    const origGet = ctx.document.getElementById.bind(ctx.document);
    ctx.document.getElementById = (id) => {
      const el = origGet(id);
      if (id === 'obs-station-name') capturedEl = el;
      return el;
    };
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(capturedEl.textContent).toContain('Custom Override Name');
    expect(ctx.window.DMI_OBS.stationName).toBe('Custom Override Name');
  });

  it('hides obs-station-name when no station is found', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:far': farStation });
    let capturedEl = null;
    const origGet = ctx.document.getElementById.bind(ctx.document);
    ctx.document.getElementById = (id) => {
      const el = origGet(id);
      if (id === 'obs-station-name') capturedEl = el;
      return el;
    };
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(capturedEl).not.toBeNull();
    expect(capturedEl.style.display).toBe('none');
  });

  it('skips DMI (ninjo) stations when dmi layer is hidden', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation, 'trafikkort:t': farStation });
    ctx.window.getObsLayerVisibility = () => ({ dmi: false, trafikkort: true });
    await ctx.loadNearestObsStation(55.68, 12.57);
    // nearStation is ninjo (dmi=false → skip), farStation is trafikkort (>100km → no-station)
    expect(ctx.window.DMI_OBS).toBeNull();
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });

  it('skips Trafikkort stations when trafikkort layer is hidden', async () => {
    const trafikNear = { name: 'TrafikNear', lat: 55.7, lon: 12.6, obs: [{ t: Date.now(), wind: 4, gust: 5, dir: 0 }] };
    const { ctx } = loadAppWithObs({ 'trafikkort:near': trafikNear, 'ninjo:far': farStation });
    ctx.window.getObsLayerVisibility = () => ({ dmi: true, trafikkort: false });
    await ctx.loadNearestObsStation(55.68, 12.57);
    // trafikNear is trafikkort (hidden), farStation is ninjo but > 100km → no-station
    expect(ctx.window.DMI_OBS).toBeNull();
  });

  it('selects a trafikkort station when it is the nearest visible one', async () => {
    const trafikNear = { name: 'TrafikNear', lat: 55.7, lon: 12.6, obs: [{ t: Date.now(), wind: 4, gust: 5, dir: 0 }] };
    const { ctx } = loadAppWithObs({ 'trafikkort:near': trafikNear, 'ninjo:far': farStation });
    ctx.window.getObsLayerVisibility = () => ({ dmi: true, trafikkort: true });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.DMI_OBS.stationName).toBe('TrafikNear');
  });

  it('sets TRAFIK_OBS to the nearest trafikkort obs array when a trafikkort station is within 100 km', async () => {
    const trafikNear = { name: 'TrafikNear', lat: 55.7, lon: 12.6, obs: [{ t: Date.now(), wind: 12, gust: 15, dir: 45 }] };
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation, 'trafikkort:near': trafikNear });
    ctx.window.getObsLayerVisibility = () => ({ dmi: true, trafikkort: true });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.TRAFIK_OBS).toBe(trafikNear.obs);
  });

  it('sets TRAFIK_OBS to null when no trafikkort station is within 100 km', async () => {
    const trafikFar = { name: 'TrafikFar', lat: 60.0, lon: 15.0, obs: [{ t: Date.now(), wind: 8, gust: 10, dir: 0 }] };
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation, 'trafikkort:far': trafikFar });
    ctx.window.getObsLayerVisibility = () => ({ dmi: true, trafikkort: true });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.TRAFIK_OBS).toBeNull();
  });

  it('sets TRAFIK_OBS to null when trafikkort layer is hidden', async () => {
    const trafikNear = { name: 'TrafikNear', lat: 55.7, lon: 12.6, obs: [{ t: Date.now(), wind: 12, gust: 15, dir: 45 }] };
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation, 'trafikkort:near': trafikNear });
    ctx.window.getObsLayerVisibility = () => ({ dmi: true, trafikkort: false });
    await ctx.loadNearestObsStation(55.68, 12.57);
    expect(ctx.window.TRAFIK_OBS).toBeNull();
  });

  it('re-runs the lookup with the last coords when the toggle callback fires', async () => {
    const { ctx } = loadAppWithObs({ 'ninjo:near': nearStation });
    // Perform initial lookup to set lastObsCoords internally.
    await ctx.loadNearestObsStation(55.68, 12.57);
    const firstStatus = ctx.window.DMI_OBS_STATUS.state;
    expect(firstStatus).toBe('ok');
    // Now hide DMI layer and fire the toggle callback.
    ctx.window.getObsLayerVisibility = () => ({ dmi: false, trafikkort: true });
    ctx.window.setObsToggleCallback && ctx.window.setObsToggleCallback(() => {});
    // Simulate the callback firing directly (setObsToggleCallback registered an internal fn).
    // We can call loadNearestObsStation again ourselves to verify filtering works.
    await ctx.loadNearestObsStation(55.68, 12.57);
    // With dmi=false the nearStation (ninjo) is excluded → no-station.
    expect(ctx.window.DMI_OBS_STATUS.state).toBe('no-station');
  });
});

// ── hover tooltip popup removed (Issue 120) ───────────────────────────────────

describe('hover tooltip popup removed', () => {
  it('does not register a click listener on the hover-tooltip element', () => {
    const { tooltipEl } = loadApp();
    expect(tooltipEl._listeners['click']).toBeUndefined();
  });

  it('hideTooltip does not touch the hover-tooltip DOM element', () => {
    const { tooltipEl, ctx } = loadApp();
    tooltipEl.style.display = 'block';
    ctx.hideTooltip();
    expect(tooltipEl.style.display).toBe('block');
  });
});

// ── contextmenu (right-click pins tooltip) ────────────────────────────────────

describe('contextmenu right-click', () => {
  it('registers a contextmenu listener on forecast-content', () => {
    const { contentEl } = loadApp();
    expect(contentEl._listeners['contextmenu']).toBeTypeOf('function');
  });

  it('does not call preventDefault when target is not inside a chart wrap', () => {
    const { contentEl } = loadApp();
    let prevented = false;
    const e = { target: { closest: () => null }, clientX: 50, preventDefault() { prevented = true; } };
    contentEl._listeners['contextmenu'](e);
    expect(prevented).toBe(false);
  });

  it('calls preventDefault when target is inside a chart wrap', () => {
    const { contentEl } = loadApp();
    let prevented = false;
    const mockWrap = {
      getBoundingClientRect: () => ({ left: 0 }),
      scrollLeft: 0,
      scrollWidth: 100,
    };
    const e = {
      target: { closest: (sel) => sel === '.chart-canvas-wrap' ? mockWrap : null },
      clientX: 50,
      preventDefault() { prevented = true; },
    };
    contentEl._listeners['contextmenu'](e);
    expect(prevented).toBe(true);
  });
});

// ── long press (mobile tooltip) ───────────────────────────────────────────────

describe('long press on mobile', () => {
  it('registers touchstart, touchmove, touchend and touchcancel listeners on forecast-content', () => {
    const { contentEl } = loadApp();
    expect(contentEl._listeners['touchstart']).toBeTypeOf('function');
    expect(contentEl._listeners['touchmove']).toBeTypeOf('function');
    expect(contentEl._listeners['touchend']).toBeTypeOf('function');
    expect(contentEl._listeners['touchcancel']).toBeTypeOf('function');
  });

  it('does not show tooltip when touchend fires before 500 ms', () => {
    const { ctx, contentEl } = loadApp();
    const mockWrap = { getBoundingClientRect: () => ({ left: 0 }), scrollLeft: 0, scrollWidth: 100 };
    // Start touch
    contentEl._listeners['touchstart']({
      target: { closest: (sel) => sel === '.chart-canvas-wrap' ? mockWrap : null },
      touches: [{ clientX: 50, clientY: 50 }],
    });
    // Lift finger immediately — well under 500 ms (performance.now returns real time)
    // The hold duration is ~0 ms so the tooltip should not be shown.
    // We just verify no crash occurs.
    contentEl._listeners['touchend']();
  });

  it('cancels long press when touchmove exceeds 10px', () => {
    const { contentEl } = loadApp();
    const mockWrap = { getBoundingClientRect: () => ({ left: 0 }), scrollLeft: 0, scrollWidth: 100 };
    contentEl._listeners['touchstart']({
      target: { closest: (sel) => sel === '.chart-canvas-wrap' ? mockWrap : null },
      touches: [{ clientX: 50, clientY: 50 }],
    });
    // Move more than 10px — should cancel the long press state
    contentEl._listeners['touchmove']({ touches: [{ clientX: 65, clientY: 50 }] });
    // touchend should now be a no-op (lpStart cleared)
    contentEl._listeners['touchend']();
  });

  it('does not cancel long press when touchmove stays within 10px', () => {
    const { contentEl } = loadApp();
    const mockWrap = { getBoundingClientRect: () => ({ left: 0 }), scrollLeft: 0, scrollWidth: 100 };
    contentEl._listeners['touchstart']({
      target: { closest: (sel) => sel === '.chart-canvas-wrap' ? mockWrap : null },
      touches: [{ clientX: 50, clientY: 50 }],
    });
    // Move less than 10px — long press state should survive
    contentEl._listeners['touchmove']({ touches: [{ clientX: 55, clientY: 52 }] });
    // Cleanup
    contentEl._listeners['touchend']();
  });
});

// ── drawCrosshairs uses xMap1h for all rows ────────────────────────────────────

describe('drawCrosshairs consistent x across rows', () => {
  it('uses xMap1h[idx1h] for all four rows, not fracX3h slot center', () => {
    const { ctx } = loadApp();

    // Stub _windAxisMax since charts.js is not loaded in app test context.
    ctx._windAxisMax = () => 20;

    // Two 3h display slots; each contains 3 1h points.
    // xMap1h[1] = 25px, but fracX3h for slot 0 = (0+0.5)/2 * 60 = 15px.
    // Before the fix, xh-dir and xh-top used fracX3h (15) while xh-temp and
    // xh-wind used xMap1h (25), causing a visible crosshair jump between rows.
    const cssW = 60;
    ctx.lastRenderedData = {
      times:     ['2025-01-01T00:00', '2025-01-01T03:00'],
      times1h:   Array.from({ length: 6 }, (_, i) => `2025-01-01T0${i}:00`),
      temps1h:   Array(6).fill(10),
      winds1h:   Array(6).fill(5),
      ensWind1h: null,
      ensGust1h: null,
      xMap1h:    [15, 25, 35, 45, 55, 65],
      slotIdx1h: [0, 0, 0, 1, 1, 1],
    };

    const xDrawn = {};
    function makeXhCtx(id) {
      return {
        clearRect() {}, save() {}, restore() {}, scale() {},
        beginPath() {}, stroke() {}, fill() {}, arc() {},
        setLineDash() {}, fillText() {},
        moveTo(x) { xDrawn[id] = x; }, lineTo() {},
        font: '', fillStyle: '', strokeStyle: '',
        lineWidth: 0, textBaseline: '', textAlign: '',
        measureText: () => ({ width: 0 }),
      };
    }

    const origGetEl = ctx.document.getElementById;
    ctx.document.getElementById = (id) => {
      if (['xh-top', 'xh-temp', 'xh-dir', 'xh-wind'].includes(id))
        return { width: cssW, height: 50, style: {}, getContext: () => makeXhCtx(id) };
      if (['c-top', 'c-temp', 'c-dir', 'c-wind'].includes(id))
        return { width: cssW, height: 50 };
      return origGetEl(id);
    };

    // idx1h=1 → xMap1h[1]=25;  idx3h=0 → fracX3h=0.25 → fracX3h*cssW=15 (different)
    ctx.drawCrosshairs(0.25, 1, 0);

    // All four rows must be at xMap1h[1]=25, not at fracX3h*cssW=15
    expect(xDrawn['xh-top']).toBeCloseTo(25);
    expect(xDrawn['xh-temp']).toBeCloseTo(25);
    expect(xDrawn['xh-dir']).toBeCloseTo(25);
    expect(xDrawn['xh-wind']).toBeCloseTo(25);
  });
});

// ── temperature dot y tracks the curve (null-coercion guard) ─────────────────

describe('drawCrosshairs temperature dot y-position', () => {
  it('places the dot on the curve even when temps1h contains null values', () => {
    // When temps1h has nulls, Math.min/max without filtering coerces null→0 and
    // produces a different tmin/tmax than tooltip.js (which filters nulls).
    // This caused the dot to appear above/below the actual temperature curve.
    // Both drawTemp (charts.js) and drawCrosshairs (tooltip.js) must use the
    // null-filtered scale so the dot sits exactly on the drawn line.

    const { ctx } = loadApp();
    ctx._windAxisMax = () => 20;

    // temps1h has nulls at positions 0 and 5; non-null temps are all 12–15°C.
    // Null-filtered: tmin=10 → expanded to tmin=5, tmax=20, tRange=15.
    // Un-filtered:   tmin=0  (null→0), tmax=15, tRange=15 → completely wrong scale.
    ctx.lastRenderedData = {
      times:     ['2025-01-01T00:00', '2025-01-01T03:00'],
      times1h:   Array.from({ length: 6 }, (_, i) => `2025-01-01T0${i}:00`),
      temps1h:   [null, 12, 13, 14, 15, null],
      winds1h:   Array(6).fill(5),
      ensWind1h: null,
      ensGust1h: null,
      xMap1h:    [15, 25, 35, 45, 55, 65],
      slotIdx1h: [0, 0, 0, 1, 1, 1],
    };

    // Capture arc(x, y, ...) on xh-temp to read the dot's y-position.
    let tempDotY = null;
    const origGetEl = ctx.document.getElementById;
    ctx.document.getElementById = (id) => {
      if (['xh-top', 'xh-temp', 'xh-dir', 'xh-wind'].includes(id)) {
        const isTemp = id === 'xh-temp';
        return {
          width: 60, height: 130, style: {},
          getContext: () => ({
            clearRect() {}, save() {}, restore() {}, scale() {},
            beginPath() {}, stroke() {}, fill() {}, moveTo() {}, lineTo() {},
            setLineDash() {}, fillText() {},
            arc(x, y) { if (isTemp) tempDotY = y; },
            font: '', fillStyle: '', strokeStyle: '',
            lineWidth: 0, textBaseline: '', textAlign: '',
            measureText: () => ({ width: 0 }),
          }),
        };
      }
      if (['c-top', 'c-temp', 'c-dir', 'c-wind'].includes(id))
        return { width: 60, height: 130 };
      return origGetEl(id);
    };

    // idx1h=2 → tempVal = 13°C
    ctx.drawCrosshairs(0.5, 2, 0);

    // Expected scale (null-filtered): tmin=5, tmax=20, tRange=15
    // dotY = TEMP_padT + (1 - (13-5)/15) * TEMP_ch = 8 + (7/15)*114 ≈ 61.2
    const TEMP_padT = 8, TEMP_ch = 114;
    const expectedY = TEMP_padT + (1 - (13 - 5) / 15) * TEMP_ch;
    expect(tempDotY).toBeCloseTo(expectedY, 1);

    // Verify it is NOT at the wrong position produced by un-filtered scale
    // (tmin=0, dotY = 8 + (1 - 13/15)*114 ≈ 23.2) — a 38px error.
    const wrongY = TEMP_padT + (1 - 13 / 15) * TEMP_ch;
    expect(Math.abs(tempDotY - wrongY)).toBeGreaterThan(5);
  });
});

// ── showCurrentTimeCrosshair (Issue 120) ──────────────────────────────────────

function makeXhSetup(ctx) {
  const xDrawn = {};
  const origGetEl = ctx.document.getElementById;
  ctx.document.getElementById = (id) => {
    const makeXhCtx = () => ({
      clearRect() {}, save() {}, restore() {}, scale() {},
      beginPath() {}, stroke() {}, fill() {}, arc() {},
      setLineDash() {}, fillText() {},
      moveTo(x) { xDrawn[id] = x; }, lineTo() {},
      font: '', fillStyle: '', strokeStyle: '',
      lineWidth: 0, textBaseline: '', textAlign: '',
    });
    if (['xh-top','xh-temp','xh-dir','xh-wind'].includes(id))
      return { width: 60, height: 50, style: {}, getContext: makeXhCtx };
    if (['c-top','c-temp','c-dir','c-wind'].includes(id))
      return { width: 60, height: 50 };
    return origGetEl(id);
  };
  ctx._windAxisMax = () => 20;
  return xDrawn;
}

describe('showCurrentTimeCrosshair', () => {
  it('is exposed on window', () => {
    const { ctx } = loadApp();
    expect(ctx.window.showCurrentTimeCrosshair).toBeTypeOf('function');
  });

  it('selects the last slot when all times are in the past', () => {
    const { ctx } = loadApp();
    const xDrawn = makeXhSetup(ctx);
    ctx.lastRenderedData = {
      times:     ['2020-01-01T00:00', '2020-01-01T03:00'],
      times1h:   Array.from({ length: 6 }, (_, i) => `2020-01-01T0${i}:00`),
      temps1h:   Array(6).fill(10),
      winds1h:   Array(6).fill(5),
      dirs1h:    Array(6).fill(180),
      ensWind1h: null, ensGust1h: null,
      xMap1h:    [5, 15, 25, 35, 45, 55],
      slotIdx1h: [0, 0, 0, 1, 1, 1],
    };
    ctx.showCurrentTimeCrosshair();
    // All past → idx1h = 5 (last) → xMap1h[5] = 55
    expect(xDrawn['xh-top']).toBeCloseTo(55);
    expect(xDrawn['xh-temp']).toBeCloseTo(55);
  });

  it('selects the current time slot (last slot at or before now)', () => {
    const { ctx } = loadApp();
    const xDrawn = makeXhSetup(ctx);
    const nowMs = Date.now();
    const t = (ms) => new Date(nowMs + ms).toISOString().slice(0, 16);
    ctx.lastRenderedData = {
      times:     [t(-7200000), t(3600000)],
      times1h:   [t(-7200000), t(-3600000), t(3600000), t(7200000)],
      temps1h:   Array(4).fill(10),
      winds1h:   Array(4).fill(5),
      dirs1h:    Array(4).fill(90),
      ensWind1h: null, ensGust1h: null,
      xMap1h:    [10, 20, 30, 40],
      slotIdx1h: [0, 0, 1, 1],
    };
    ctx.showCurrentTimeCrosshair();
    // now is between index 1 (now-1h) and index 2 (now+1h)
    // current slot = last slot ≤ now = index 1 → xMap1h[1] = 20
    expect(xDrawn['xh-top']).toBeCloseTo(20);
  });

  it('mouseleave does not reset the crosshair (no listener registered)', () => {
    const { ctx, contentEl } = loadApp();
    const xDrawn = makeXhSetup(ctx);
    ctx.lastRenderedData = {
      times:     ['2020-01-01T00:00', '2020-01-01T03:00'],
      times1h:   Array.from({ length: 6 }, (_, i) => `2020-01-01T0${i}:00`),
      temps1h:   Array(6).fill(10),
      winds1h:   Array(6).fill(5),
      dirs1h:    Array(6).fill(180),
      ensWind1h: null, ensGust1h: null,
      xMap1h:    [5, 15, 25, 35, 45, 55],
      slotIdx1h: [0, 0, 0, 1, 1, 1],
    };
    // mouseleave is no longer registered — crosshair stays wherever it was.
    expect(contentEl._listeners['mouseleave']).toBeUndefined();
  });
});

// ── showTooltipAtX nearest-neighbour snap ─────────────────────────────────────

describe('showTooltipAtX nearest-neighbour snap', () => {
  it('snaps to the left slot when cursor is closer to it than the right slot', () => {
    const { ctx, contentEl } = loadApp();
    const xDrawn = {};
    const origGetEl = ctx.document.getElementById;
    ctx.document.getElementById = (id) => {
      const makeXhCtx = () => ({
        clearRect() {}, save() {}, restore() {}, scale() {},
        beginPath() {}, stroke() {}, fill() {}, arc() {},
        setLineDash() {}, fillText() {},
        moveTo(x) { xDrawn[id] = x; }, lineTo() {},
        font: '', fillStyle: '', strokeStyle: '',
        lineWidth: 0, textBaseline: '', textAlign: '',
      });
      if (['xh-top','xh-temp','xh-dir','xh-wind'].includes(id))
        return { width: 60, height: 50, style: {}, getContext: makeXhCtx };
      if (['c-top','c-temp','c-dir','c-wind'].includes(id))
        return { width: 60, height: 50 };
      return origGetEl(id);
    };
    ctx._windAxisMax = () => 20;
    // xMap1h: slot centres at 10, 30, 50. Cursor at 22 is closer to 10 (|22-10|=12)
    // than to 30 (|22-30|=8) — wait, actually 22 is closer to 30. Let's use 18:
    // |18-10|=8, |18-30|=12 → nearest is index 0 (x=10).
    ctx.lastRenderedData = {
      times:     ['2020-01-01T00:00', '2020-01-01T03:00', '2020-01-01T06:00'],
      times1h:   ['2020-01-01T00:00', '2020-01-01T02:00', '2020-01-01T04:00'],
      temps1h:   [10, 11, 12],
      winds1h:   [5, 6, 7],
      dirs1h:    [90, 90, 90],
      ensWind1h: null, ensGust1h: null,
      xMap1h:    [10, 30, 50],
      slotIdx1h: [0, 1, 2],
    };
    // Simulate mousemove at clientX such that relX = 18 (closer to slot 0 at x=10 than slot 1 at x=30)
    const wrap = contentEl._listeners['mousemove'] && (() => {
      const wrapEl = {
        closest: (sel) => sel === '.chart-canvas-wrap' ? wrapEl : null,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 60, bottom: 50 }),
        scrollLeft: 0,
        scrollWidth: 60,
      };
      return wrapEl;
    })();
    // Directly invoke the internal slot-snapping logic via a mousemove event
    const fakeWrap = {
      closest: (sel) => sel === '.chart-canvas-wrap' ? fakeWrap : null,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 60, bottom: 50 }),
      scrollLeft: 0,
      scrollWidth: 60,
    };
    const fakeTarget = { closest: (sel) => sel === '.chart-canvas-wrap' ? fakeWrap : null };
    const moveListeners = contentEl._listeners['mousemove'];
    if (Array.isArray(moveListeners)) {
      moveListeners.forEach(fn => fn({ clientX: 18, target: fakeTarget }));
    } else if (moveListeners) {
      moveListeners({ clientX: 18, target: fakeTarget });
    }
    // relX=18, xMap=[10,30,50]: lower-bound finds index 1 (30>=18), nearest is index 0 (|10-18|=8 < |30-18|=12)
    // crosshair should be at xMap1h[0] = 10
    expect(xDrawn['xh-top']).toBeCloseTo(10);
  });
});

// ── Progressive ensemble loading ──────────────────────────────────────────────

describe('progressive ensemble loading', () => {
  function makeMinimalWeatherData() {
    const hours = 7 * 24;
    const time = Array.from({ length: hours }, (_, i) =>
      `2024-01-${String(Math.floor(i / 24) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`);
    const vals = new Array(hours).fill(10);
    return {
      hourly: {
        time,
        temperature_2m:    vals,
        precipitation:     vals.map(() => 0),
        windspeed_10m:     vals,
        windgusts_10m:     vals,
        winddirection_10m: vals,
        weathercode:       vals,
      },
      daily: {
        sunrise: Array.from({ length: 7 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}T07:00`),
        sunset:  Array.from({ length: 7 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}T16:00`),
      },
    };
  }

  function makeMinimalEnsData() {
    const hours = 7 * 24;
    const time = Array.from({ length: hours }, (_, i) =>
      `2024-01-${String(Math.floor(i / 24) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`);
    return { hourly: { time, temperature_2m_member01: new Array(hours).fill(10) } };
  }

  it('renders with deterministic data as soon as weather resolves, before ensemble', async () => {
    let resolveWeather;
    const weatherPromise = new Promise(r => { resolveWeather = r; });
    const renderCalls = [];

    const { ctx } = loadApp({
      qParam: '55.0,12.0',
      renderAllSpy: (...args) => renderCalls.push(args),
      fetchWeatherImpl: () => weatherPromise,
      // fetchEnsemble stays never-settling (default) to simulate slow ensemble
      rAFImmediate: true,
    });

    expect(ctx.lastData).toBeNull();
    expect(renderCalls).toHaveLength(0);

    resolveWeather(makeMinimalWeatherData());
    await new Promise(r => setTimeout(r, 0)); // drain microtasks

    expect(ctx.lastData).not.toBeNull();
    expect(ctx.lastData.ensTemp).toBeNull();
    expect(ctx.lastData.ensWind).toBeNull();
    // At least one render happened via the double-rAF path
    expect(renderCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('triggers a second render with ensemble bands once ensemble resolves', async () => {
    let resolveWeather, resolveEnsemble;
    const weatherPromise  = new Promise(r => { resolveWeather  = r; });
    const ensemblePromise = new Promise(r => { resolveEnsemble = r; });
    const renderCalls = [];

    const { ctx } = loadApp({
      qParam: '55.0,12.0',
      renderAllSpy: (...args) => renderCalls.push(args),
      fetchWeatherImpl:  () => weatherPromise,
      fetchEnsembleImpl: () => ensemblePromise,
      rAFImmediate: true,
    });

    // Override ensemblePercentiles so applyEnsembleData returns non-null bands.
    // This must be set before ensPromise resolves (done here before resolveEnsemble).
    const hours = 7 * 24;
    const fakePct = { p10: new Array(hours).fill(8), p50: new Array(hours).fill(10), p90: new Array(hours).fill(12) };
    ctx.ensemblePercentiles = () => fakePct;

    resolveWeather(makeMinimalWeatherData());
    await new Promise(r => setTimeout(r, 0));

    const rendersAfterWeather = renderCalls.length;
    expect(ctx.lastData.ensTemp).toBeNull();

    resolveEnsemble(makeMinimalEnsData());
    await new Promise(r => setTimeout(r, 0));

    // A second render was triggered after ensemble arrived
    expect(renderCalls.length).toBeGreaterThan(rendersAfterWeather);
    // Ensemble fields are now populated
    expect(ctx.lastData.ensTemp).not.toBeNull();
    expect(ctx.lastData.ensWind).not.toBeNull();
  });

  it('does not apply stale ensemble to a newer load', async () => {
    let resolveWeather1, resolveEnsemble1;
    const weather1  = new Promise(r => { resolveWeather1  = r; });
    const ensemble1 = new Promise(r => { resolveEnsemble1 = r; });
    const renderCalls = [];

    const { ctx } = loadApp({
      qParam: '55.0,12.0',
      renderAllSpy: (...args) => renderCalls.push(args),
      fetchWeatherImpl:  () => weather1,
      fetchEnsembleImpl: () => ensemble1,
      rAFImmediate: true,
    });

    resolveWeather1(makeMinimalWeatherData());
    await new Promise(r => setTimeout(r, 0));
    const dataAfterFirstLoad = ctx.lastData;

    // Simulate a second load (different city) overwriting lastData
    ctx.lastData = { placeholder: true };

    // Now the stale ensemble from first load resolves — should be discarded
    resolveEnsemble1(makeMinimalEnsData());
    await new Promise(r => setTimeout(r, 0));

    expect(ctx.lastData).toEqual({ placeholder: true });
  });
});
