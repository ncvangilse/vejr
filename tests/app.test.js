import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT    = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_SRC = readFileSync(resolve(ROOT, 'vejr.html'), 'utf8');
const APP_SRC = readFileSync(resolve(ROOT, 'app.js'), 'utf8');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEl(value = '') {
  return {
    value,
    style:      {},
    textContent: '',
    classList:  { contains: () => false, add: () => {}, remove: () => {} },
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
function loadApp({ qParam = '', savedCity = null, geoAvailable = false, portrait = false, invertedColors = false, renderAllSpy = null } = {}) {
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
        if (id === 'city-input')      return cityInput;
        if (id === 'model-select')    return makeEl('dmi_seamless');
        if (id === 'hover-tooltip')   return tooltipEl;
        return makeEl();
      },
      querySelectorAll: () => [],
      querySelector: () => null,
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
    setTimeout, clearTimeout,
    fetch: () => Promise.reject(new Error('fetch not mocked')),
    // Stubs for functions/constants defined in other scripts.
    // Use a never-settling promise so async chains stall silently rather than
    // logging unhandled-rejection noise to stderr.
    geocode:            () => new Promise(() => {}),
    fetchWeather:       () => new Promise(() => {}),
    fetchEnsemble:      () => new Promise(() => {}),
    ensemblePercentiles: () => null,
    renderAll:          renderAllSpy || (() => {}),
    isKiteOptimal:      () => false,
    snapBearing:        (d) => d,
    FORECAST_DAYS:      7,
    STEP:               3,
    STEP1H:             1,
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

  return { ctx, cityInput, mockLocalStorage, geoCalls, replaceStateCalls, invertedMQL, tooltipEl };
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

// ── HTML structure ────────────────────────────────────────────────────────────

describe('vejr.html structure', () => {
  it('build-number is inside header-right', () => {
    const headerRightMatch = HTML_SRC.match(/<div id="header-right"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
    expect(headerRightMatch).not.toBeNull();
    expect(headerRightMatch[0]).toContain('id="build-number"');
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

  it('starts from current time, not midnight, in portrait mode', () => {
    const calls = [];
    const { ctx } = loadApp({ portrait: true, renderAllSpy: (d) => calls.push(d) });
    const d = makeData(TOTAL_3H, TOTAL_1H);
    ctx.renderDisplay(d);
    // First rendered timestamp should be >= now (within one 3h slot)
    const firstTime = new Date(calls[0].times[0]).getTime();
    expect(firstTime).toBeGreaterThanOrEqual(Date.now() - 3 * 60 * 60 * 1000);
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

  it('passes null portraitColW to renderAll in landscape mode', () => {
    const colWs = [];
    const { ctx } = loadApp({ portrait: false, renderAllSpy: (d, ic, colW) => colWs.push(colW) });
    ctx.renderDisplay(makeData(TOTAL_3H, TOTAL_1H));
    expect(colWs[0]).toBeNull();
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
    // idx 10 = 20:00 (night), idx 11 = 23:00 → 3h gap
    expect(new Date(ds.times[10]).getUTCHours()).toBe(20);
    const dt = new Date(ds.times[11]).getTime() - new Date(ds.times[10]).getTime();
    expect(dt).toBe(3 * HR);
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

// ── tooltip close-on-tap ──────────────────────────────────────────────────────

describe('tooltip close-on-tap', () => {
  it('registers a click listener on the tooltip element at startup', () => {
    const { tooltipEl } = loadApp();
    expect(tooltipEl._listeners['click']).toBeTypeOf('function');
  });

  it('hides the tooltip when the click listener is invoked', () => {
    const { tooltipEl } = loadApp();
    tooltipEl.style.display = 'block';
    tooltipEl._listeners['click']();
    expect(tooltipEl.style.display).toBe('none');
  });
});

// ── loadAtCoords — DMI country-code wiring ────────────────────────────────────

/**
 * Minimal hourly weather response suitable for loadAtCoords to complete.
 */
function makeWeatherResponse(nHours = 72) {
  const base  = new Date('2026-04-13T00:00:00Z');
  const times = Array.from({ length: nHours }, (_, i) =>
    new Date(base.getTime() + i * 3_600_000).toISOString().slice(0, 16));
  const fill  = (v = 0) => times.map(() => v);
  return {
    hourly: {
      time:              times,
      temperature_2m:    fill(10),
      precipitation:     fill(0),
      windspeed_10m:     fill(5),
      windgusts_10m:     fill(8),
      winddirection_10m: fill(180),
      weathercode:       fill(1),
    },
    daily: {
      sunrise: ['2026-04-13T06:00'],
      sunset:  ['2026-04-13T20:00'],
    },
  };
}

/**
 * Like loadApp() but adds the extra globals required for loadAtCoords to
 * run to completion (DA_DAYS3, DA_MON, requestAnimationFrame, loadDmiObservations).
 */
function loadAppForCoords(extraCtx = {}) {
  const base = loadApp();
  const { ctx } = base;
  ctx.DA_DAYS3              = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  ctx.DA_MON                = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  ctx.requestAnimationFrame = (fn) => { try { fn(); } catch (_) {} };
  ctx.loadDmiObservations   = () => Promise.resolve();   // default no-op spy
  Object.assign(ctx, extraCtx);
  return base;
}

describe('loadAtCoords — DMI country-code wiring', () => {
  it('calls loadDmiObservations with uppercased country_code from reverse geocode', async () => {
    const weather  = makeWeatherResponse();
    const dmiCalls = [];
    const { ctx }  = loadAppForCoords();

    ctx.loadDmiObservations = (lat, lon, cc) => { dmiCalls.push({ lat, lon, cc }); return Promise.resolve(); };
    ctx.fetchWeather        = () => Promise.resolve(weather);
    ctx.fetchEnsemble       = () => Promise.resolve(null);
    // ctx.fetch is used only for the Nominatim reverse-geocode inside loadAtCoords
    ctx.fetch = (url) => {
      if (url.includes('nominatim')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            display_name: 'Copenhagen, Denmark',
            address: { city: 'Copenhagen', country_code: 'dk' },
          }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };

    await ctx.loadAtCoords(55.67, 12.57, 'best_match');

    expect(dmiCalls).toHaveLength(1);
    expect(dmiCalls[0].lat).toBe(55.67);
    expect(dmiCalls[0].lon).toBe(12.57);
    expect(dmiCalls[0].cc).toBe('DK');   // must be uppercased
  });

  it('does NOT call loadDmiObservations when reverse geocode fails (network error)', async () => {
    const weather  = makeWeatherResponse();
    const dmiCalls = [];
    const { ctx }  = loadAppForCoords();

    ctx.loadDmiObservations = (lat, lon, cc) => { dmiCalls.push({ lat, lon, cc }); return Promise.resolve(); };
    ctx.fetchWeather        = () => Promise.resolve(weather);
    ctx.fetchEnsemble       = () => Promise.resolve(null);
    ctx.fetch               = () => Promise.reject(new Error('network'));  // Nominatim fails

    await ctx.loadAtCoords(55.67, 12.57, 'best_match');

    expect(dmiCalls).toHaveLength(0);   // reverseCountryCode is null → no DMI call
  });

  it('does NOT call loadDmiObservations when reverse geocode returns no country_code', async () => {
    const weather  = makeWeatherResponse();
    const dmiCalls = [];
    const { ctx }  = loadAppForCoords();

    ctx.loadDmiObservations = (lat, lon, cc) => { dmiCalls.push({ lat, lon, cc }); return Promise.resolve(); };
    ctx.fetchWeather        = () => Promise.resolve(weather);
    ctx.fetchEnsemble       = () => Promise.resolve(null);
    ctx.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ display_name: 'Unknown', address: {} }),  // no country_code field
    });

    await ctx.loadAtCoords(55.67, 12.57, 'best_match');

    expect(dmiCalls).toHaveLength(0);
  });
});


