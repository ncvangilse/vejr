/* ══════════════════════════════════════════════════
   MAIN APP — load, tooltip, kite dialog, URL sync
══════════════════════════════════════════════════ */
var lastData        = null;
var lastRenderedData = null; // the sliced data passed to the most recent renderAll call
let lastShoreCoords = null;  // { lat, lon } of the last loaded city
let lastObsCoords   = null;  // { lat, lon } last used for nearest station lookup

function syncInvertedColorsClass() {
  const on = window.matchMedia('(inverted-colors: inverted)').matches;
  document.body.classList.toggle('inverted-colors', on);
}
/* ══════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════ */
async function load(cityName, model) {
  model = model || 'best_match';
  const forecastEl = document.getElementById('forecast-content');
  const isReload = lastData !== null;
  if (isReload) {
    forecastEl.classList.add('updating');
  } else {
    document.getElementById('loading').style.display='block';
    forecastEl.style.display='none';
  }
  document.getElementById('error-msg').style.display='none';
  try {
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline…' };
    const loc = await geocode(cityName);
    // Kick off the Overpass vector fetch in parallel with the weather requests —
    // coords are now known so there's no reason to wait.
    lastShoreCoords = { lat: loc.latitude, lon: loc.longitude };
    if (window.fetchShoreVector) window.fetchShoreVector(loc.latitude, loc.longitude).catch(() => null);
    if (window.analyseShore)     window.analyseShore(loc.latitude, loc.longitude).catch(() => null);
    // fetch main forecast + ensemble in parallel; ensemble failure is non-fatal.
    const iconCodeFetch = (model === 'dmi_seamless')
      ? fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&hourly=weathercode&forecast_days=${FORECAST_DAYS}&timezone=auto&models=icon_seamless`)
          .then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);
    const [data, ensData, iconData] = await Promise.all([
      fetchWeather(loc.latitude, loc.longitude, model),
      fetchEnsemble(loc.latitude, loc.longitude, model).catch(() => null),
      iconCodeFetch,
    ]);
    const H = data.hourly;
    const iconCodes = iconData?.hourly?.weathercode || null;
    // Build sunTimes from the API's daily sunrise/sunset
    sunTimes = {};
    if (data.daily?.sunrise && data.daily?.sunset) {
      data.daily.sunrise.forEach((riseStr, i) => {
        const key     = riseStr.slice(0, 10);
        const sunrise = parseFloat(riseStr.slice(11,13)) + parseFloat(riseStr.slice(14,16)) / 60;
        const setStr  = data.daily.sunset[i];
        const sunset  = parseFloat(setStr.slice(11,13))  + parseFloat(setStr.slice(14,16))  / 60;
        sunTimes[key] = { sunrise, sunset };
      });
    }
    const times=[],temps=[],precips=[],gusts=[],winds=[],dirs=[],codes=[];
    // 1-hour resolution arrays for smooth curves (temp, wind speed/gust, precip) and icons
    const times1h=[],temps1h=[],precips1h=[],gusts1h=[],winds1h=[],codes1h=[],dirs1h=[];
    const totalH=FORECAST_DAYS*24;
    for(let i=0;i<Math.min(totalH,H.time.length);i+=STEP){
      times.push(H.time[i]);
      temps.push(H.temperature_2m[i]);
      precips.push(H.precipitation[i] ?? 0);
      winds.push(H.windspeed_10m[i]);
      // Gusts can be null at the far end of some model runs; fall back to wind speed.
      const rawGust = H.windgusts_10m[i];
      gusts.push(rawGust != null ? rawGust : H.windspeed_10m[i]);
      dirs.push(H.winddirection_10m[i]);
      // Prefer ICON weathercode when DMI has shower but ICON says thunder
      const dmiCode  = H.weathercode[i];
      const iconCode = iconCodes ? (iconCodes[i] ?? dmiCode) : dmiCode;
      const code = (iconCodes && dmiCode >= 80 && dmiCode <= 82 && iconCode >= 95)
                   ? iconCode : dmiCode;
      codes.push(code);
    }
    for(let i=0;i<Math.min(totalH,H.time.length);i+=STEP1H){
      times1h.push(H.time[i]);
      temps1h.push(H.temperature_2m[i]);
      precips1h.push(H.precipitation[i] ?? 0);
      winds1h.push(H.windspeed_10m[i]);
      const rawGust1h = H.windgusts_10m[i];
      gusts1h.push(rawGust1h != null ? rawGust1h : H.windspeed_10m[i]);
      // Weather codes at 1h resolution (portrait mode shows finest available icons)
      const dmiCode1h  = H.weathercode[i];
      const iconCode1h = iconCodes ? (iconCodes[i] ?? dmiCode1h) : dmiCode1h;
      codes1h.push((iconCodes && dmiCode1h >= 80 && dmiCode1h <= 82 && iconCode1h >= 95)
        ? iconCode1h : dmiCode1h);
      dirs1h.push(H.winddirection_10m[i]);
    }
    const MODEL_LABEL = {
      'best_match':          'Auto',
      'dmi_seamless':        'DMI HARMONIE',
      'icon_seamless':       'DWD ICON',
      'ecmwf_ifs025':        'ECMWF IFS',
      'meteofrance_seamless':'Météo-France',
      'gfs_seamless':        'NOAA GFS',
    };
    const ENS_LABEL = {
      'best_match':          'ICON-EPS',
      'dmi_seamless':        'ICON-EPS',
      'icon_seamless':       'ICON-EPS',
      'ecmwf_ifs025':        'IFS-EPS',
      'meteofrance_seamless':'ICON-EPS',
      'gfs_seamless':        'GFS-EPS',
    };
    const modelLabel = MODEL_LABEL[model] || model;
    const ensLabel   = ENS_LABEL[model]   || 'ensemble';
    let ensTemp = null, ensWind = null, ensGust = null, ensPrecip = null;
    let ensTemp1h = null, ensWind1h = null, ensGust1h = null, ensPrecip1h = null;
    const ensStatus = document.getElementById('ens-status');
    if (ensData && ensData.hourly) {
      ensTemp   = ensemblePercentiles(ensData.hourly, 'temperature_2m');
      ensWind   = ensemblePercentiles(ensData.hourly, 'windspeed_10m');
      ensGust   = ensemblePercentiles(ensData.hourly, 'windgusts_10m');
      ensPrecip = ensemblePercentiles(ensData.hourly, 'precipitation');
      ensTemp1h   = ensemblePercentiles(ensData.hourly, 'temperature_2m',   STEP1H);
      ensWind1h   = ensemblePercentiles(ensData.hourly, 'windspeed_10m',    STEP1H);
      ensGust1h   = ensemblePercentiles(ensData.hourly, 'windgusts_10m',    STEP1H);
      ensPrecip1h = ensemblePercentiles(ensData.hourly, 'precipitation',    STEP1H);
      // Snapshot the deterministic gusts BEFORE merging ensemble wind into winds[].
      // The ensemble p50 wind is often higher than the deterministic wind; if we let
      // gusts get clamped against it the gust-wind gap collapses to zero.
      const detGusts = gusts.slice();
      const detGusts1h = gusts1h.slice();
      // Replace deterministic slots with ensemble median (p50) where available.
      if (ensTemp)
        for (let i = 0; i < temps.length;   i++) { if (ensTemp.p50[i]   != null) temps[i]   = ensTemp.p50[i];   }
      if (ensWind)
        for (let i = 0; i < winds.length;   i++) { if (ensWind.p50[i]   != null) winds[i]   = ensWind.p50[i];   }
      if (ensPrecip)
        for (let i = 0; i < precips.length; i++) { if (ensPrecip.p50[i] != null) precips[i] = ensPrecip.p50[i]; }
      if (ensTemp1h)
        for (let i = 0; i < temps1h.length;   i++) { if (ensTemp1h.p50[i]   != null) temps1h[i]   = ensTemp1h.p50[i];   }
      if (ensWind1h)
        for (let i = 0; i < winds1h.length;   i++) { if (ensWind1h.p50[i]   != null) winds1h[i]   = ensWind1h.p50[i];   }
      if (ensPrecip1h)
        for (let i = 0; i < precips1h.length; i++) { if (ensPrecip1h.p50[i] != null) precips1h[i] = ensPrecip1h.p50[i]; }
      // Restore deterministic gusts unchanged — they are already >= det wind from the
      // initial data loop, and they must stay above the (now ensemble-merged) wind line.
      for (let i = 0; i < gusts.length;   i++) gusts[i]   = Math.max(detGusts[i],   winds[i]);
      for (let i = 0; i < gusts1h.length; i++) gusts1h[i] = Math.max(detGusts1h[i], winds1h[i]);
      const memberCount = Object.keys(ensData.hourly).filter(k => k.startsWith('temperature_2m_member')).length;
      ensStatus.textContent = `${modelLabel} + ${ensLabel} (${memberCount} mdl) ✓`;
      ensStatus.style.color = '#5a9';
    } else {
      ensStatus.textContent = `${modelLabel} — ensemble not available`;
      ensStatus.style.color = '#a77';
    }
    document.getElementById('city-name').textContent =
      loc.name+(loc.country_code?', '+loc.country_code:'');
    document.getElementById('loading').style.display='none';
    forecastEl.style.display='block';
    forecastEl.classList.remove('updating');
    lastData = {
      times, temps, precips, gusts, winds, dirs, codes,
      ensTemp, ensWind, ensGust, ensPrecip,
      times1h, temps1h, precips1h, gusts1h, winds1h, codes1h, dirs1h,
      ensTemp1h, ensWind1h, ensGust1h, ensPrecip1h,
      otherModelsWind1h: null,
    };
    // Double rAF ensures layout is complete before measuring canvas width
    requestAnimationFrame(() => requestAnimationFrame(() => {
      renderDisplay(lastData, true);
      // Fetch other-model wind lines in the background; re-render on arrival.
      const capturedData = lastData;
      fetchOtherModelsWind(loc.latitude, loc.longitude, model)
        .then(otherModels => {
          if (lastData !== capturedData || !otherModels.length) return;
          lastData.otherModelsWind1h = otherModels;
          renderDisplay(lastData);
        })
        .catch(() => null);
    }));
    // Load RainViewer radar centred on the selected city
    if (window.loadRadar) window.loadRadar(loc.latitude, loc.longitude);
    // Find nearest obs station and overlay its wind history on the wind chart.
    loadNearestObsStation(loc.latitude, loc.longitude).catch(() => null);
    updateShoreStatusUI();
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display='none';
    forecastEl.classList.remove('updating');
    document.getElementById('error-msg').style.display='block';
  }
}
/* ══════════════════════════════════════════════════
   PORTRAIT-AWARE RENDERING
   In portrait mode the full remaining forecast is shown in a scrollable
   canvas — each 1-hour slot is PORTRAIT_COL_W px wide (one icon per slot)
   so the current day is shown at the finest available time resolution,
   and the user can swipe to travel through time.
══════════════════════════════════════════════════ */
const PORTRAIT_COL_W = 30; // px per slot in portrait scroll mode (ICON_H=36, visible content ~24px fits with ~6px gap)

function slicePercentilesFrom(obj, start, n) {
  if (!obj) return null;
  return { p10: obj.p10.slice(start, start + n), p50: obj.p50.slice(start, start + n), p90: obj.p90.slice(start, start + n) };
}

/**
 * Compute CSS x-center positions for each 1h data point on the variable-resolution
 * display grid.  Each display slot has width portraitColW px; a 1h point that falls
 * at offset t within a slot of duration D gets centered at:
 *   x = (slotIndex + 0.5 + t / D) * portraitColW
 * The +0.5 shifts the slot-start time to the slot centre, matching where icons,
 * wind arrows and tick marks are drawn, so all chart rows align on the same x axis.
 * Returns { xMap1h, xFrac1h, slotIdx1h } — parallel arrays of length times1h.length.
 */
function computeXMap1h(times1h, displayTimes, portraitColW) {
  const n1h  = times1h.length;
  const nDsp = displayTimes.length;
  const dspMs = displayTimes.map(t => new Date(t).getTime());
  // Use (nDsp + 1) slots as denominator so xFrac stays in (0, 1) even when late
  // points in the final coarse slot extend slightly past the canvas edge.
  const fracDenom = (nDsp + 1) * portraitColW;
  const xMap = [], xFrac = [], slotIdx = [];
  let j = 0;
  for (let k = 0; k < n1h; k++) {
    const tk = new Date(times1h[k]).getTime();
    while (j < nDsp - 1 && dspMs[j + 1] <= tk) j++;
    const slotDur = j < nDsp - 1
      ? dspMs[j + 1] - dspMs[j]
      : (j > 0 ? dspMs[j] - dspMs[j - 1] : 3600000);
    const x = (j + 0.5 + (tk - dspMs[j]) / slotDur) * portraitColW;
    xMap.push(x);
    xFrac.push(x / fracDenom);
    slotIdx.push(j);
  }
  return { xMap1h: xMap, xFrac1h: xFrac, slotIdx1h: slotIdx };
}

/**
 * Build a variable-resolution display series for portrait mode.
 * Resolution decreases with distance from now; nighttime is compressed:
 *   0–24 h  daytime  → 1h  |  nighttime → 3h
 *   24–48 h daytime  → 3h  |  nighttime → 6h
 *   48–168 h         → 6h  (always)
 *   168 h+  daytime only, step increases linearly from 6h→12h (nighttime skipped)
 *
 * For coarse slots the icon/direction is picked from whichever hour in the
 * window is most "daytime" (prefers midday, avoids night).
 *
 * The returned object keeps the display series (times/codes/dirs/precips/winds,
 * length = N_display) separate from the full 1h arrays (times1h/temps1h/etc.,
 * length = N_1h).  xMap1h / xFrac1h map each 1h point to its CSS x-center on
 * the display grid so curves can be drawn at full resolution.
 */
function buildPortraitSeries(s) {
  const t0 = new Date(s.times1h[0]).getTime();
  const times = [], codes = [], dirs = [];
  const precips = [], winds = [], temps = [], gusts = [];
  const hasEns = s.ensTemp1h != null;
  const ensTemp = { p10: [], p50: [], p90: [] };
  const ensWind = { p10: [], p50: [], p90: [] };
  const ensGust = { p10: [], p50: [], p90: [] };
  const ensPrecip = { p10: [], p50: [], p90: [] };

  let i = 0;
  while (i < s.times1h.length) {
    const hoursAhead = (new Date(s.times1h[i]).getTime() - t0) / 3600000;
    const h = new Date(s.times1h[i]).getHours();
    const night = typeof isNight === 'function' ? isNight(s.times1h[i]) : (h < 6 || h >= 20);

    let step;
    if (hoursAhead >= 168) {
      // Extended zone: skip nighttime icons entirely (req #4)
      if (night) { i += 1; continue; }
      // Linear zoom: step increases from 6h at day 7 to 12h at day 16
      const ratio = Math.min(1, (hoursAhead - 168) / 216);
      step = Math.ceil((6 + 6 * ratio) / 3) * 3; // snaps to 6, 9, or 12
    } else {
      const baseStep = hoursAhead < 24 ? 1 : hoursAhead < 48 ? 3 : 6;
      step = Math.min(6, night ? baseStep * 3 : baseStep);
    }

    // For coarse steps pick the slot in [i, i+step) that is most daytime.
    let best = i;
    if (step > 1) {
      let bestScore = -Infinity;
      const end = Math.min(i + step, s.times1h.length);
      for (let j = i; j < end; j++) {
        const hj = new Date(s.times1h[j]).getHours();
        const nj = typeof isNight === 'function' ? isNight(s.times1h[j]) : (hj < 6 || hj >= 20);
        const score = (nj ? 0 : 100) - Math.abs(hj - 12);
        if (score > bestScore) { bestScore = score; best = j; }
      }
    }

    // Time label: step-aligned start (so day boundaries land on exact midnight).
    times.push(s.times1h[i]);
    // Icon/direction: from the most-daytime slot.
    codes.push(s.codes1h ? s.codes1h[best] : null);
    dirs.push(s.dirs1h ? s.dirs1h[best]
                       : s.dirs[Math.min(Math.round(best / 3), s.dirs.length - 1)]);
    precips.push(s.precips1h[best]);
    winds.push(s.winds1h[best]);
    temps.push(s.temps1h[best]);
    gusts.push(s.gusts1h[best]);
    // Down-sample ensemble percentile bands by picking the best-slot value.
    if (hasEns) {
      ['p10', 'p50', 'p90'].forEach(k => {
        ensTemp[k].push(s.ensTemp1h[k][best]);
        ensWind[k].push(s.ensWind1h[k][best]);
        ensGust[k].push(s.ensGust1h[k][best]);
        ensPrecip[k].push(s.ensPrecip1h[k][best]);
      });
    }

    i += step;
  }

  // Compute x-positions mapping each 1h point onto the variable-resolution grid.
  const { xMap1h, xFrac1h, slotIdx1h } = computeXMap1h(s.times1h, times, PORTRAIT_COL_W);

  return {
    // Display series (N_display): icons, arrows, axis ticks, kite highlights, curves.
    times, codes, dirs,
    temps,    // representative temperature per display slot (for temp curve in portrait)
    precips,  // representative precip per display slot (for bars in drawTemp)
    gusts,    // representative gust per display slot (for wind curve in portrait)
    winds,    // representative wind per display slot (for kite highlights in drawWind)
    ensTemp:   hasEns ? ensTemp   : null,
    ensWind:   hasEns ? ensWind   : null,
    ensGust:   hasEns ? ensGust   : null,
    ensPrecip: hasEns ? ensPrecip : null,

    // Full 1h arrays (N_1h): smooth curves and precise tooltip values.
    times1h:     s.times1h,
    temps1h:     s.temps1h,
    precips1h:   s.precips1h,
    gusts1h:     s.gusts1h,
    winds1h:     s.winds1h,
    codes1h:     s.codes1h,
    dirs1h:      s.dirs1h,
    ensTemp1h:   s.ensTemp1h,
    ensWind1h:   s.ensWind1h,
    ensGust1h:   s.ensGust1h,
    ensPrecip1h: s.ensPrecip1h,
    // Other model wind lines: passed through at 1h resolution for rendering
    // with xMap1h providing correct x-positions on the variable-res display grid.
    otherModelsWind1h: s.otherModelsWind1h || null,

    // x-position mapping: each 1h point → CSS x-center on the display grid.
    xMap1h, xFrac1h, slotIdx1h,
    isPortraitMode: true,
  };
}

/**
 * Build a display series for landscape mode.
 * Days 1–7: uniform 3h slots so exactly 7 days fills the viewport at baseColW.
 * Days 7–16: daytime only (nighttime skipped); step increases linearly from
 *             6h at day 7 to 12h at day 16 (linear zoom, req #3/#4).
 * colW is the base column width (= viewportWidth / 56) so days 1–7 fill the
 * screen and days 8–16 extend beyond, accessible by scrolling.
 */
function buildLandscapeSeries(s, colW) {
  const t0 = new Date(s.times1h[0]).getTime();
  const times = [], codes = [], dirs = [];
  const precips = [], winds = [], temps = [], gusts = [];
  const hasEns = s.ensTemp1h != null;
  const ensTemp = { p10: [], p50: [], p90: [] };
  const ensWind = { p10: [], p50: [], p90: [] };
  const ensGust = { p10: [], p50: [], p90: [] };
  const ensPrecip = { p10: [], p50: [], p90: [] };

  let i = 0;
  while (i < s.times1h.length) {
    const hoursAhead = (new Date(s.times1h[i]).getTime() - t0) / 3600000;
    const h = new Date(s.times1h[i]).getHours();
    const night = typeof isNight === 'function' ? isNight(s.times1h[i]) : (h < 6 || h >= 20);

    let step;
    if (hoursAhead < 168) {
      step = STEP; // 3h uniform — first 7 days fill viewport exactly
    } else {
      // Extended zone: skip nighttime icons (req #4)
      if (night) { i += 1; continue; }
      // Linear zoom: step increases from 6h at day 7 to 12h at day 16
      const ratio = Math.min(1, (hoursAhead - 168) / 216);
      step = Math.ceil((6 + 6 * ratio) / 3) * 3; // snaps to 6, 9, or 12
    }

    // For coarse steps pick the slot in [i, i+step) that is most daytime.
    let best = i;
    if (step > 1) {
      let bestScore = -Infinity;
      const end = Math.min(i + step, s.times1h.length);
      for (let j = i; j < end; j++) {
        const hj = new Date(s.times1h[j]).getHours();
        const nj = typeof isNight === 'function' ? isNight(s.times1h[j]) : (hj < 6 || hj >= 20);
        const score = (nj ? 0 : 100) - Math.abs(hj - 12);
        if (score > bestScore) { bestScore = score; best = j; }
      }
    }

    times.push(s.times1h[i]);
    codes.push(s.codes1h ? s.codes1h[best] : null);
    dirs.push(s.dirs1h ? s.dirs1h[best]
                       : s.dirs[Math.min(Math.round(best / 3), s.dirs.length - 1)]);
    precips.push(s.precips1h[best]);
    winds.push(s.winds1h[best]);
    temps.push(s.temps1h[best]);
    gusts.push(s.gusts1h[best]);
    if (hasEns) {
      ['p10', 'p50', 'p90'].forEach(k => {
        ensTemp[k].push(s.ensTemp1h[k][best]);
        ensWind[k].push(s.ensWind1h[k][best]);
        ensGust[k].push(s.ensGust1h[k][best]);
        ensPrecip[k].push(s.ensPrecip1h[k][best]);
      });
    }

    i += step;
  }

  const { xMap1h, xFrac1h, slotIdx1h } = computeXMap1h(s.times1h, times, colW);

  return {
    times, codes, dirs, temps, precips, gusts, winds,
    ensTemp:   hasEns ? ensTemp   : null,
    ensWind:   hasEns ? ensWind   : null,
    ensGust:   hasEns ? ensGust   : null,
    ensPrecip: hasEns ? ensPrecip : null,
    times1h:     s.times1h,   temps1h:   s.temps1h,
    precips1h:   s.precips1h, gusts1h:   s.gusts1h,
    winds1h:     s.winds1h,   codes1h:   s.codes1h,
    dirs1h:      s.dirs1h,
    ensTemp1h:   s.ensTemp1h, ensWind1h:  s.ensWind1h,
    ensGust1h:   s.ensGust1h, ensPrecip1h: s.ensPrecip1h,
    otherModelsWind1h: s.otherModelsWind1h || null,
    xMap1h, xFrac1h, slotIdx1h,
    isPortraitMode: false,
  };
}

function renderDisplay(d, scrollToNow = false) {
  const portrait       = window.matchMedia('(orientation: portrait)').matches;
  const invertedColors = window.matchMedia('(inverted-colors: inverted)').matches;
  syncInvertedColorsClass();
  const n3h = Math.ceil(FORECAST_DAYS * 24 / STEP);
  const n1h = Math.ceil(FORECAST_DAYS * 24 / STEP1H);
  const s = {
    times:    d.times.slice(0, n3h),    temps:    d.temps.slice(0, n3h),
    precips:  d.precips.slice(0, n3h),  gusts:    d.gusts.slice(0, n3h),
    winds:    d.winds.slice(0, n3h),    dirs:     d.dirs.slice(0, n3h),
    codes:    d.codes.slice(0, n3h),
    ensTemp:  slicePercentilesFrom(d.ensTemp,  0, n3h), ensWind:  slicePercentilesFrom(d.ensWind,  0, n3h),
    ensGust:  slicePercentilesFrom(d.ensGust,  0, n3h), ensPrecip: slicePercentilesFrom(d.ensPrecip, 0, n3h),
    times1h:  d.times1h.slice(0, n1h),  temps1h:  d.temps1h.slice(0, n1h),
    codes1h:  d.codes1h ? d.codes1h.slice(0, n1h) : null,
    precips1h: d.precips1h.slice(0, n1h), gusts1h: d.gusts1h.slice(0, n1h),
    winds1h:  d.winds1h.slice(0, n1h),
    dirs1h:   d.dirs1h ? d.dirs1h.slice(0, n1h) : null,
    ensTemp1h:  slicePercentilesFrom(d.ensTemp1h,  0, n1h), ensWind1h:  slicePercentilesFrom(d.ensWind1h,  0, n1h),
    ensGust1h:  slicePercentilesFrom(d.ensGust1h,  0, n1h), ensPrecip1h: slicePercentilesFrom(d.ensPrecip1h, 0, n1h),
    otherModelsWind1h: d.otherModelsWind1h
      ? d.otherModelsWind1h.map(m => ({ model: m.model, winds1h: m.winds1h.slice(0, n1h) }))
      : null,
  };

  let colW, displayData;
  if (portrait) {
    colW = PORTRAIT_COL_W;
    displayData = buildPortraitSeries(s);
  } else {
    // Landscape: 7 days fills the viewport; days 8–16 are accessible by scrolling.
    // Compute colW from the canvas wrap width (excludes y-axis columns).
    const wrap = document.querySelector ? document.querySelector('.chart-canvas-wrap') : null;
    const viewW = (wrap && wrap.clientWidth > 0) ? wrap.clientWidth : (window.innerWidth || 800);
    colW = viewW / (7 * 24 / STEP);
    displayData = buildLandscapeSeries(s, colW);
  }

  renderAll(displayData, invertedColors, colW);
  lastRenderedData = displayData;
  // Scroll to current time on initial load.
  // Portrait: center "now" in the viewport. Landscape: left-align at "now" so 7 days ahead fills the screen.
  if (scrollToNow && displayData.xMap1h) {
    requestAnimationFrame(() => {
      const nowMs = Date.now();
      const idx = displayData.times1h.findIndex(t => new Date(t).getTime() >= nowMs);
      const xNow = idx >= 0 ? displayData.xMap1h[idx] : displayData.xMap1h[displayData.xMap1h.length - 1];
      const wraps = document.querySelectorAll ? document.querySelectorAll('.chart-canvas-wrap') : [];
      const visW = wraps[0] ? wraps[0].clientWidth : 0;
      const target = portrait ? Math.max(0, xNow - visW / 2) : Math.max(0, xNow);
      wraps.forEach(w => { w.scrollLeft = target; });
    });
  }
  if (invertedColors) {
    ['c-top', 'c-temp', 'c-dir', 'c-wind'].forEach(id => {
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const ctx2d = canvas.getContext('2d');
      const img   = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      const px    = img.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i]   = 255 - px[i];
        px[i+1] = 255 - px[i+1];
        px[i+2] = 255 - px[i+2];
      }
      ctx2d.putImageData(img, 0, 0);
    });
  }
}

/* ══════════════════════════════════════════════════
   HOVER CROSSHAIR + TOOLTIP
══════════════════════════════════════════════════ */
const XH_CANVASES = ['xh-top','xh-temp','xh-dir','xh-wind'];
const XH_PAIR     = { 'xh-top':'c-top', 'xh-temp':'c-temp', 'xh-dir':'c-dir', 'xh-wind':'c-wind' };
function clearCrosshairs() {
  XH_CANVASES.forEach(id => {
    const c = document.getElementById(id);
    if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  });
}
function drawCrosshairs(fracX, idx1h, idx3h) {
  if (!lastRenderedData) return;
  const d = lastRenderedData;
  // renderAll always fires the portrait branch (colW is always non-null), so:
  //   drawTemp  uses d.temps1h + d.xMap1h  → temp dot tracks xMap1h[idx1h]
  //   drawWind  uses d.winds/d.gusts (3h)  → wind dot tracks fracX3h
  const TEMP_cssH = 130, TEMP_padT = 8, TEMP_padB = 8;
  const TEMP_ch   = TEMP_cssH - TEMP_padT - TEMP_padB;
  const validTemps = d.temps1h.filter(v => v != null);
  let tmin = Math.floor(Math.min(...validTemps) / 5) * 5;
  let tmax = Math.ceil( Math.max(...validTemps) / 5) * 5;
  if (tmax - tmin < 15) { const mid = (tmin + tmax) / 2; tmin = Math.floor((mid - 7.5) / 5) * 5; tmax = tmin + 15; }
  const tRange  = tmax - tmin;
  const tempVal = d.temps1h[idx1h];
  const tempDotY = tempVal != null ? TEMP_padT + (1 - (tempVal - tmin) / tRange) * TEMP_ch : null;
  const WIND_H = 130;
  const t0Ms   = d.times.length > 0 ? new Date(d.times[0]).getTime() : 0;
  const ext7d  = t0Ms + 7 * 24 * 3600 * 1000;
  const n7d    = d.times.findIndex(t => new Date(t).getTime() >= ext7d);
  const nAx    = n7d > 0 ? n7d : d.times.length;
  const maxW   = _windAxisMax(
    d.winds.slice(0, nAx),
    d.ensWind ? { p90: d.ensWind.p90.slice(0, nAx) } : null
  );
  const windVal    = d.winds[idx3h];
  const windDotY   = windVal != null ? (1 - windVal / maxW) * WIND_H : null;
  const fracX3h    = (idx3h + 0.5) / d.times.length;
  // xMap1h[idx1h] is the CSS x-centre of the 1h point as drawn by drawTemp.
  const tempXabs   = d.xMap1h ? d.xMap1h[idx1h] : fracX3h;
  const DOT_Y = { 'xh-top': null, 'xh-temp': tempDotY, 'xh-dir': null, 'xh-wind': windDotY };
  const FRAC  = { 'xh-top': fracX3h, 'xh-temp': null, 'xh-dir': fracX3h, 'xh-wind': fracX3h };
  XH_CANVASES.forEach(id => {
    const c   = document.getElementById(id);
    const ref = document.getElementById(XH_PAIR[id]);
    if (!c || !ref) return;
    const dpr  = window.devicePixelRatio || 1;
    const cssW = ref.width  / dpr;
    const cssH = ref.height / dpr;
    if (cssW === 0 || cssH === 0) return;
    c.width  = ref.width;
    c.height = ref.height;
    c.style.width  = cssW + 'px';
    c.style.height = cssH + 'px';
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    const x = (id === 'xh-temp') ? tempXabs : (FRAC[id] * cssW);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
    ctx.setLineDash([]);
    const dotY = DOT_Y[id];
    if (dotY !== null) {
      const dotCol = (id === 'xh-temp') ? (tempVal >= 0 ? '#cc2200' : '#4488ff') : '#fff';
      ctx.fillStyle   = dotCol;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.arc(x, dotY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // inline label next to the dot
      ctx.font         = 'bold 10px monospace';
      ctx.fillStyle    = '#000';
      ctx.textBaseline = 'middle';
      const nearRight  = x + 52 > cssW;
      ctx.textAlign    = nearRight ? 'right' : 'left';
      const labelX     = nearRight ? x - 8 : x + 8;
      if (id === 'xh-temp' && tempVal != null) {
        ctx.fillText(`${tempVal >= 0 ? '+' : ''}${tempVal.toFixed(1)}°`, labelX, dotY);
      } else if (id === 'xh-wind' && windVal != null) {
        ctx.fillText(windVal.toFixed(1), labelX, dotY);
      }
    }
    // time label at the bottom of the top-row overlay
    if (id === 'xh-top') {
      const t  = new Date(d.times[idx3h]);
      const hh = t.getHours().toString().padStart(2, '0');
      ctx.font         = 'bold 10px sans-serif';
      ctx.fillStyle    = '#000';
      ctx.textBaseline = 'bottom';
      ctx.textAlign    = 'center';
      ctx.fillText(`${hh}:00`, x, cssH);
    }
    ctx.restore();
  });
}
const WMO_DESC = {
  0:'Clear',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
  45:'Fog',48:'Rime fog',
  51:'Light drizzle',53:'Drizzle',55:'Dense drizzle',
  61:'Light rain',63:'Rain',65:'Heavy rain',
  71:'Light snow',73:'Snow',75:'Heavy snow',77:'Snow grains',
  80:'Rain showers',81:'Heavy rain showers',82:'Violent rain showers',
  85:'Snow showers',86:'Heavy snow showers',
  95:'Thunderstorm',96:'Thunderstorm w/ hail',99:'Thunderstorm w/ heavy hail',
};
function showTooltip(idx1h, idx3h) {
  if (!lastRenderedData) return;
  const d = lastRenderedData;
  const tip = document.getElementById('hover-tooltip');
  const portrait = !!d.isPortraitMode;
  let timeStr, temp, prec, wind, gust, dir, code, tp10, tp90, wp10, wp90, gp10, gp90, pp10, pp90;
  if (portrait) {
    // Portrait: all values from display series (same zoom as icon row).
    timeStr = d.times[idx3h];
    temp    = d.temps[idx3h];
    prec    = d.precips[idx3h];
    wind    = d.winds[idx3h];
    gust    = Math.max(d.gusts[idx3h], wind);
    dir     = d.dirs[idx3h];
    code    = d.codes[idx3h];
    tp10    = d.ensTemp   ? d.ensTemp.p10[idx3h]   : null;
    tp90    = d.ensTemp   ? d.ensTemp.p90[idx3h]   : null;
    wp10    = d.ensWind   ? d.ensWind.p10[idx3h]   : null;
    wp90    = d.ensWind   ? d.ensWind.p90[idx3h]   : null;
    gp10    = d.ensGust   ? (d.ensGust.p10[idx3h]  ?? null) : null;
    gp90    = d.ensGust   ? (d.ensGust.p90[idx3h]  ?? null) : null;
    pp10    = d.ensPrecip ? d.ensPrecip.p10[idx3h] : null;
    pp90    = d.ensPrecip ? d.ensPrecip.p90[idx3h] : null;
  } else {
    // Landscape: full 1h resolution.
    timeStr = d.times1h[idx1h];
    temp    = d.temps1h[idx1h];
    prec    = d.precips1h[idx1h];
    wind    = d.winds1h[idx1h];
    gust    = Math.max(d.gusts1h[idx1h], wind);
    dir     = d.dirs1h ? d.dirs1h[idx1h] : d.dirs[idx3h];
    code    = d.codes1h ? d.codes1h[idx1h] : d.codes[idx3h];
    tp10    = d.ensTemp1h   ? d.ensTemp1h.p10[idx1h]   : null;
    tp90    = d.ensTemp1h   ? d.ensTemp1h.p90[idx1h]   : null;
    wp10    = d.ensWind1h   ? d.ensWind1h.p10[idx1h]   : null;
    wp90    = d.ensWind1h   ? d.ensWind1h.p90[idx1h]   : null;
    gp10    = d.ensGust1h   ? (d.ensGust1h.p10[idx1h]  ?? null) : null;
    gp90    = d.ensGust1h   ? (d.ensGust1h.p90[idx1h]  ?? null) : null;
    pp10    = d.ensPrecip1h ? d.ensPrecip1h.p10[idx1h] : null;
    pp90    = d.ensPrecip1h ? d.ensPrecip1h.p90[idx1h] : null;
  }
  const t   = new Date(timeStr);
  const day = DA_DAYS[t.getDay()];
  const h   = t.getHours().toString().padStart(2,'0');
  const windCol = windColorStr(wind, 1);
  const gustCol = windColorStr(gust, 1);
  const fmt  = (v, deg) => (v >= 0 ? '+' : '') + v.toFixed(1) + (deg ? '°C' : ' m/s');
  const tempUncRow   = (tp10 != null && tp90 != null)
    ? `<div class="tt-row"><span class="tt-label">P10–P90</span><span class="tt-val" style="color:#bb8866;font-size:10px">${fmt(tp10,true)} → ${fmt(tp90,true)}</span></div>` : '';
  const windUncRow   = (wp10 != null && wp90 != null)
    ? `<div class="tt-row"><span class="tt-label">P10–P90</span><span class="tt-val" style="color:#aaa;font-size:10px">${fmt(wp10,false)} → ${fmt(wp90,false)}</span></div>` : '';
  const gustUncRow   = (gp10 != null && gp90 != null)
    ? `<div class="tt-row"><span class="tt-label">P10–P90</span><span class="tt-val" style="color:#cc9966;font-size:10px">${fmt(gp10,false)} → ${fmt(gp90,false)}</span></div>` : '';
  const precipUncRow = (pp10 != null && pp90 != null)
    ? `<div class="tt-row"><span class="tt-label">P10–P90</span><span class="tt-val" style="color:#6aaee8;font-size:10px">${pp10.toFixed(1)} → ${pp90.toFixed(1)} mm</span></div>` : '';
  const desc    = WMO_DESC[code] || 'Unknown';
  const kiteRow = isKiteOptimal(wind, dir, timeStr)
    ? `<div style="color:#00c8a0;font-size:10px;font-weight:700;margin-bottom:4px;letter-spacing:0.3px;">🪁 Optimal kitesurfing wind</div>` : '';
  // DMI observed wind nearest to this time slot (within 30 min)
  let obsRow = '';
  if (window.DMI_OBS && window.DMI_OBS.obs && window.DMI_OBS.obs.length) {
    const hoverT = new Date(d.times1h[idx1h]).getTime();
    const nearest = window.DMI_OBS.obs.reduce((a, b) =>
      Math.abs(a.t - hoverT) < Math.abs(b.t - hoverT) ? a : b
    );
    if (Math.abs(nearest.t - hoverT) < 30 * 60 * 1000) {
      const wStr = nearest.wind != null ? `${nearest.wind.toFixed(1)} m/s` : '—';
      const gStr = nearest.gust != null
        ? `<span style="color:rgba(255,150,50,1)"> / gust ${nearest.gust.toFixed(1)} m/s</span>`
        : '';
      obsRow = `<div class="tt-row">`
             + `<span class="tt-label" title="DMI ${window.DMI_OBS.stationName} · ${window.DMI_OBS.distKm} km">Obs (DMI)</span>`
             + `<span class="tt-val" style="color:#ffe040;font-size:10px">${wStr}${gStr}</span>`
             + `</div>`;
    }
  }
  tip.innerHTML = `
    <div class="tt-time">${day} at ${h}:00</div>
    ${kiteRow}
    <div class="tt-row" style="margin-bottom:4px;align-items:center;">
      <div style="position:relative;flex:0 0 32px;width:32px;height:32px;">
        <canvas id="tt-icon-canvas" width="32" height="32" style="display:block;"></canvas>
        ${isKiteOptimal(wind, dir, timeStr) ? '<span style="position:absolute;bottom:-3px;right:-5px;font-size:14px;line-height:1;">🪁</span>' : ''}
      </div>
      <span class="tt-val" style="font-size:11px;color:#cde">${desc}</span>
    </div>
    <div class="tt-row">
      <span class="tt-label">Temp</span>
      <span class="tt-val" style="color:${temp>=0?'#ff8866':'#88aaff'}">${temp>=0?'+':''}${temp.toFixed(1)}°C</span>
    </div>
    ${tempUncRow}
    <div class="tt-row">
      <span class="tt-label">Precip</span>
      <span class="tt-val" style="color:#4466aa">${prec.toFixed(1)} mm</span>
    </div>
    ${precipUncRow}
    <div class="tt-row">
      <span class="tt-label">Wind</span>
      <span class="tt-val" style="color:${windCol}">${wind.toFixed(1)} m/s</span>
    </div>
    ${windUncRow}
    <div class="tt-row">
      <span class="tt-label">Gusts</span>
      <span class="tt-val" style="color:${gustCol}">${gust.toFixed(1)} m/s</span>
    </div>
    ${gustUncRow}
    ${obsRow}
    <div class="tt-row">
      <span class="tt-label">Direction</span>
      <span class="tt-val">${degToCompass(dir)} (${Math.round(dir)}°)</span>
    </div>`;
  tip.style.display = 'block';
  const iconCanvas = document.getElementById('tt-icon-canvas');
  if (iconCanvas) {
    const sz = 32;
    const dpr = window.devicePixelRatio || 1;
    iconCanvas.width  = sz * dpr;
    iconCanvas.height = sz * dpr;
    iconCanvas.style.width  = sz + 'px';
    iconCanvas.style.height = sz + 'px';
    const ictx = iconCanvas.getContext('2d');
    ictx.scale(dpr, dpr);
    dmiIcon(ictx, wmoType(code, timeStr), sz / 2, sz / 2, sz, prec, code);
  }
}
function hideTooltip() {
  document.getElementById('hover-tooltip').style.display = 'none';
  clearCrosshairs();
}
var _chartDragging = false;
function attachHoverListeners() {
  document.getElementById('hover-tooltip').addEventListener('click', hideTooltip);
  const content = document.getElementById('forecast-content');

  function showTooltipAtX(clientX, target) {
    if (!lastRenderedData) return;
    const wrap = target && target.closest ? target.closest('.chart-canvas-wrap') : null;
    if (!wrap) { hideTooltip(); return; }
    const rect  = wrap.getBoundingClientRect();
    const relX  = clientX - rect.left + (wrap.scrollLeft || 0);
    const span  = wrap.scrollWidth || rect.width;
    const fracX = Math.max(0, Math.min(1, relX / span));
    const n1h   = lastRenderedData.times1h.length;
    const n3h   = lastRenderedData.times.length;
    let idx1h, idx3h;
    if (lastRenderedData.xMap1h) {
      // Binary search on xMap1h (monotonically increasing) for the nearest 1h slot.
      const xMap = lastRenderedData.xMap1h;
      let lo = 0, hi = xMap.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xMap[mid] < relX) lo = mid + 1; else hi = mid;
      }
      idx1h = lo;
      idx3h = lastRenderedData.slotIdx1h
        ? Math.min(n3h - 1, lastRenderedData.slotIdx1h[idx1h])
        : Math.min(n3h - 1, Math.floor(fracX * n3h));
    } else {
      idx3h = Math.min(n3h - 1, Math.floor(fracX * n3h));
      idx1h = Math.min(n1h - 1, Math.floor(fracX * n1h));
    }
    drawCrosshairs(fracX, idx1h, idx3h);
    showTooltip(idx1h, idx3h);
  }

  content.addEventListener('mousemove', e => {
    if (_chartDragging || !lastRenderedData) return;
    const wrap = e.target.closest('.chart-canvas-wrap');
    if (!wrap) { hideTooltip(); return; }
    showTooltipAtX(e.clientX, e.target);
  });
  content.addEventListener('mouseleave', hideTooltip);

  // Long press state — declared before contextmenu so cancelLp is available there.
  let lpStart = 0, lpX = 0, lpY = 0, lpEl = null;
  function cancelLp() { lpStart = 0; }

  // Right-click pins the tooltip without the browser context menu.
  // On Android, long press also fires contextmenu — cancel the lp state here
  // so the touchend handler doesn't fire a second time.
  content.addEventListener('contextmenu', e => {
    if (!e.target.closest('.chart-canvas-wrap')) return;
    e.preventDefault();
    cancelLp();
    showTooltipAtX(e.clientX, e.target);
  });

  // Long press on iOS: measure hold duration at touchend to avoid triggering
  // the browser's native "held touch" detection (which causes text selection).
  content.addEventListener('touchstart', e => {
    const wrap = e.target.closest('.chart-canvas-wrap');
    if (!wrap) { lpStart = 0; return; }
    lpStart = performance.now();
    lpX = e.touches[0].clientX;
    lpY = e.touches[0].clientY;
    lpEl  = e.target;
  }, { passive: true });
  content.addEventListener('touchmove', e => {
    if (!lpStart) return;
    const dx = e.touches[0].clientX - lpX;
    const dy = e.touches[0].clientY - lpY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) lpStart = 0;
  }, { passive: true });
  content.addEventListener('touchend', () => {
    if (!lpStart) return;
    const dt = performance.now() - lpStart;
    const el = lpEl;
    cancelLp();
    if (dt >= 500) showTooltipAtX(lpX, el);
  }, { passive: true });
  content.addEventListener('touchcancel', cancelLp, { passive: true });
}
attachHoverListeners();

/* ══════════════════════════════════════════════════
   PORTRAIT SCROLL SYNC
   Keep all four .chart-canvas-wrap scroll containers in step so that
   scrolling any one of them moves the others to the same position.
══════════════════════════════════════════════════ */
function initPortraitScrollSync() {
  const wraps = document.querySelectorAll ? [...document.querySelectorAll('.chart-canvas-wrap')] : [];
  if (!wraps.length) return;

  let syncing = false;

  function syncAll(left) {
    syncing = true;
    const max = wraps[0].scrollWidth - wraps[0].clientWidth;
    const clamped = Math.max(0, Math.min(max, left));
    wraps.forEach(w => { w.scrollLeft = clamped; });
    syncing = false;
  }

  // Keep all wraps in step on native scroll (mouse wheel, keyboard, trackpad).
  wraps.forEach(wrap => {
    wrap.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const left = wrap.scrollLeft;
      wraps.forEach(w => { if (w !== wrap) w.scrollLeft = left; });
      syncing = false;
    }, { passive: true });
  });

  // Touch momentum: intercept horizontal swipes, apply velocity after lift.
  let rafId = null;
  let velX = 0, lastX = 0, lastT = 0, startY = 0;
  let horizontal = null;
  const DECEL = 0.975;

  wraps.forEach(wrap => {
    wrap.addEventListener('touchstart', e => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      velX = 0; horizontal = null;
      lastX = e.touches[0].clientX;
      lastT = performance.now();
      startY = e.touches[0].clientY;
    }, { passive: true });

    wrap.addEventListener('touchmove', e => {
      const cx = e.touches[0].clientX;
      const cy = e.touches[0].clientY;
      const dx = cx - lastX;
      const dy = cy - startY;
      if (horizontal === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5))
        horizontal = Math.abs(dx) >= Math.abs(dy);
      if (!horizontal) return;
      e.preventDefault();
      const now = performance.now();
      const dt  = Math.max(1, now - lastT);
      // velX is pixels-per-16ms-frame; positive = scrolling right (scrollLeft increases).
      velX = -(dx / dt) * 16;
      syncAll(wrap.scrollLeft - dx);
      lastX = cx; lastT = now;
    }, { passive: false });

    wrap.addEventListener('touchend', () => {
      if (!horizontal) return;
      (function step() {
        velX *= DECEL;
        if (Math.abs(velX) < 0.5) { rafId = null; return; }
        syncAll(wraps[0].scrollLeft + velX);
        rafId = requestAnimationFrame(step);
      })();
    }, { passive: true });

    wrap.addEventListener('touchcancel', () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      velX = 0; horizontal = null;
    }, { passive: true });
  });

  // Mouse drag: enables panning on desktop. Listeners are on document so the
  // drag continues even when the mouse leaves the wrap element.
  let mouseDown = false, mouseLastX = 0, mouseLastT = 0, mouseVelX = 0;

  function onDocMouseMove(e) {
    const cx  = e.clientX;
    const dx  = cx - mouseLastX;
    const now = performance.now();
    const dt  = Math.max(1, now - mouseLastT);
    mouseVelX = -(dx / dt) * 16;
    syncAll(wraps[0].scrollLeft - dx);
    mouseLastX = cx;
    mouseLastT = now;
  }

  function stopMouseDrag() {
    if (!mouseDown) return;
    mouseDown = false;
    _chartDragging = false;
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup',   stopMouseDrag);
    if (Math.abs(mouseVelX) >= 0.5) {
      (function step() {
        mouseVelX *= DECEL;
        if (Math.abs(mouseVelX) < 0.5) { rafId = null; return; }
        syncAll(wraps[0].scrollLeft + mouseVelX);
        rafId = requestAnimationFrame(step);
      })();
    }
  }

  wraps.forEach(wrap => {
    wrap.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      mouseDown = true;
      _chartDragging = true;
      mouseVelX = 0;
      mouseLastX = e.clientX;
      mouseLastT = performance.now();
      document.body.style.cursor = 'grabbing';
      hideTooltip();
      document.addEventListener('mousemove', onDocMouseMove);
      document.addEventListener('mouseup',   stopMouseDrag);
      e.preventDefault();
    });
  });
}
initPortraitScrollSync();

function getModel() { return document.getElementById('model-select').value; }
/* ══════════════════════════════════════════════════
   SHORE STATUS UI
══════════════════════════════════════════════════ */
function updateShoreStatusUI() {
  const el = document.getElementById('shore-status');
  const modalEl = document.getElementById('shore-modal-status');
  const s = window.SHORE_STATUS || { state: 'idle', msg: '' };

  let text = '', color = '#778';
  if (s.state === 'loading') {
    text = '🌊 Fetching coastline…';
  } else if (s.state === 'calculating') {
    text = '🌊 Calculating sea bearings…';
  } else if (s.state === 'ok') {
    const seaCount = window.SHORE_MASK
      ? Array.from(window.SHORE_MASK).filter(v => v >= SHORE_SEA_THRESH).length : 0;
    text  = `🌊 ${seaCount} sea bearings`;
    color = seaCount > 0 ? '#00c890' : '#aa8844';
  } else if (s.state === 'inland') {    text  = '🏔 Inland (no coast)';
    color = '#aa8844';
  } else if (s.state === 'error') {
    text  = '🌊 Shore: unavailable';
    color = '#a77';
  }

  if (el) { el.textContent = text; el.style.color = color; }
  if (modalEl) {
    // Show richer message in modal: include the SHORE_STATUS.msg if present
    const extra = s.msg ? ` — ${s.msg}` : '';
    modalEl.textContent = text + extra;
    modalEl.style.color = color;
  }
  renderShoreDebug();
}

/* ══════════════════════════════════════════════════
   DMI OBSERVATION STATUS UI
══════════════════════════════════════════════════ */
function updateDmiObsStatusUI() {
  const el = document.getElementById('dmi-obs-status');
  if (!el) return;
  const s = window.DMI_OBS_STATUS || { state: 'idle', msg: '' };
  let text = '', color = '#778';
  if (s.state === 'loading') {
    text  = `📡 DMI: ${s.msg || 'loading…'}`;
    color = '#778';
  } else if (s.state === 'ok') {
    // msg = "StationName · N km" — prefix makes it clear this is the basis for the wind obs dots
    text  = `📡 Obs: ${s.msg}`;
    color = '#5a9';
  } else if (s.state === 'no-station') {
    text  = '📡 DMI: no station nearby';
    color = '#aa8844';
  } else if (s.state === 'error') {
    text  = `📡 DMI: ${s.msg}`;
    color = '#a77';
  }
  // 'idle' and 'not-dk' show nothing
  el.textContent = text;
  el.style.color  = color;
}
window.updateDmiObsStatusUI = updateDmiObsStatusUI;

/* ══════════════════════════════════════════════════
   NEAREST STATION LOOKUP
   Find the closest station in OBS_HISTORY to the given
   lat/lon, populate window.DMI_OBS, and re-render.
══════════════════════════════════════════════════ */
function _setObsStationHeader(name) {
  const el = document.getElementById('obs-station-name');
  if (!el) return;
  if (name) {
    el.textContent = `📡 ${name}`;
    el.style.display = '';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

async function loadNearestObsStation(lat, lon) {
  lastObsCoords = { lat, lon };
  window.DMI_OBS_STATUS = { state: 'loading', msg: 'loading…' };
  // Clear stale station highlight and header immediately so the old info
  // doesn't linger while the new lookup is in-flight.
  _setObsStationHeader(null);
  if (window.highlightNearestStation) window.highlightNearestStation(null, null);
  updateDmiObsStatusUI();
  try {
    let obsHistory = window.OBS_HISTORY;
    if (!obsHistory) {
      const fetchFn = window.fetchObsHistory;
      if (fetchFn) {
        obsHistory = await fetchFn();
      } else {
        const url = window.OBS_HISTORY_URL;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('gzip');
          const text = await new Response(r.body.pipeThrough(ds)).text();
          obsHistory = JSON.parse(text);
        } else {
          obsHistory = await r.json();
        }
        window.OBS_HISTORY = obsHistory;
      }
    }
    if (!obsHistory) throw new Error('obs-history unavailable');

    let stationNames = window.STATION_NAMES;
    if (!stationNames) {
      try {
        const fetchFn = window.fetchStationNames;
        stationNames = fetchFn ? await fetchFn() : {};
      } catch (_) {
        stationNames = {};
      }
      window.STATION_NAMES = stationNames;
    }

    // Haversine distance in km
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    function haversine(lat1, lon1, lat2, lon2) {
      const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    }

    const vis = window.getObsLayerVisibility
      ? window.getObsLayerVisibility()
      : { dmi: true, trafikkort: true };

    let bestKey = null, bestStation = null, bestDist = Infinity;
    for (const [key, station] of Object.entries(obsHistory)) {
      if (!station.obs || !station.obs.length) continue;
      if (station.lat == null || station.lon == null) continue;
      const isDmi = key.startsWith('ninjo:');
      if (isDmi && !vis.dmi) continue;
      if (!isDmi && !vis.trafikkort) continue;
      const dist = haversine(lat, lon, station.lat, station.lon);
      if (dist < bestDist) { bestDist = dist; bestKey = key; bestStation = station; }
    }

    if (!bestStation || bestDist > 100) {
      window.DMI_OBS        = null;
      window.DMI_OBS_STATUS = { state: 'no-station', msg: '' };
      if (window.highlightNearestStation) window.highlightNearestStation(null, null);
      _setObsStationHeader(null);
    } else {
      const name = stationNames[bestKey] ?? bestStation.name ?? bestKey;
      window.DMI_OBS = {
        obs:         bestStation.obs,
        stationName: name,
        distKm:      bestDist.toFixed(1),
      };
      window.DMI_OBS_STATUS = {
        state: 'ok',
        msg: `${name} · ${bestDist.toFixed(1)} km`,
      };
      if (window.highlightNearestStation) window.highlightNearestStation(bestStation.lat, bestStation.lon);
      _setObsStationHeader(name);
    }
  } catch (e) {
    window.DMI_OBS        = null;
    window.DMI_OBS_STATUS = { state: 'error', msg: e.message || 'failed' };
    if (window.highlightNearestStation) window.highlightNearestStation(null, null);
    _setObsStationHeader(null);
  }
  updateDmiObsStatusUI();
  if (lastData) renderDisplay(lastData);
}

/* ══════════════════════════════════════════════════
   SHORE DEBUG PANEL
══════════════════════════════════════════════════ */

/* ── Minimap ── */
function drawShoreDebugMap(d) {
  const canvas = document.getElementById('shore-debug-map');
  if (!canvas) return;

  const SIZE = canvas.clientWidth || 200;
  const dpr  = window.devicePixelRatio || 1;
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD  = 6;
  const mapW = SIZE - PAD * 2;
  const mapH = mapW;           // square map
  const offX = PAD, offY = PAD;

  // ── Background ──
  ctx.fillStyle = '#141e2a';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = 'rgba(80,100,130,0.5)';
  ctx.lineWidth   = 0.5;
  ctx.strokeRect(offX, offY, mapW, mapH);

  // ── Image-pixel → canvas coordinate helper ──
  const imgToCanvas = (px, py) => [
    offX + (px / d.width)  * mapW,
    offY + (py / d.height) * mapH,
  ];

  // ── Lat/lon → canvas via Mercator (same math as latLonToPixel in shore.js) ──
  const mb = d.mercatorBbox;
  const latLonToCanvas = (lat, lon) => {
    const R  = 6378137;
    const x  = lon * Math.PI / 180 * R;
    const y  = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
    const nx = (x - mb.west)  / (mb.east  - mb.west);
    const ny = (mb.north - y) / (mb.north - mb.south);
    return [offX + nx * mapW, offY + ny * mapH];
  };

  // ── Water-area polygons (from Overpass, viz only) ──
  (d.waterPolys || []).forEach(poly => {
    if (!poly || poly.length < 2) return;
    ctx.beginPath();
    poly.forEach((p, i) => {
      const [x, y] = latLonToCanvas(p.lat, p.lon);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle   = 'rgba(30,100,180,0.35)';  ctx.fill();
    ctx.strokeStyle = 'rgba(60,140,220,0.6)';   ctx.lineWidth = 0.8; ctx.stroke();
  });

  // ── Coastline ways (from Overpass, viz only) ──
  (d.coastWays || []).forEach(way => {
    if (!way || way.length < 2) return;
    ctx.beginPath();
    way.forEach((p, i) => {
      const [x, y] = latLonToCanvas(p.lat, p.lon);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(220,140,50,0.9)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  });

  // ── Ray lines from origin to farthest sample in each bearing ──
  const [ox, oy] = d.originPx
    ? imgToCanvas(d.originPx.px, d.originPx.py)
    : latLonToCanvas(d.lat, d.lon);

  ctx.lineWidth = 0.5;
  (d.bearings || []).forEach(row => {
    if (!row.samples.length) return;
    const last = row.samples[row.samples.length - 1];
    const [lx, ly] = last.px != null
      ? imgToCanvas(last.px, last.py)
      : latLonToCanvas(last.lat, last.lon);
    ctx.strokeStyle = row.seaFrac >= SHORE_SEA_THRESH
      ? 'rgba(0,200,160,0.22)'
      : 'rgba(220,140,50,0.18)';
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(lx, ly);
    ctx.stroke();
  });

  // ── Sample dots ──
  (d.bearings || []).forEach(row => {
    row.samples.forEach(s => {
      const [x, y] = s.px != null
        ? imgToCanvas(s.px, s.py)
        : latLonToCanvas(s.lat, s.lon);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = s.reason === 'oob:sea'  ? 'rgba(180,180,180,0.7)'
                    : s.isSea                 ? '#00c8a0'
                    :                           '#e06020';
      ctx.fill();
    });
  });

  // ── Origin crosshair ──
  const CH = 6;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.moveTo(ox - CH, oy); ctx.lineTo(ox + CH, oy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, oy - CH); ctx.lineTo(ox, oy + CH); ctx.stroke();
  ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();

  // ── Scale bar (1 km) ──
  const metersW  = mb.east - mb.west;
  const barPxW   = (1000 / metersW) * mapW;
  const barX = offX + 5, barY = offY + mapH - 7;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(barX, barY);         ctx.lineTo(barX + barPxW, barY);
  ctx.moveTo(barX, barY - 3);     ctx.lineTo(barX, barY + 3);
  ctx.moveTo(barX + barPxW, barY - 3); ctx.lineTo(barX + barPxW, barY + 3);
  ctx.stroke();
  ctx.font = '9px IBM Plex Mono, monospace';
  ctx.fillStyle = '#ccc'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('1 km', barX + barPxW + 3, barY + 4);

  // ── N arrow ──
  const narX = offX + mapW - 10, narY = offY + 18;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(narX, narY - 10); ctx.lineTo(narX - 4, narY + 2);
  ctx.lineTo(narX, narY - 2);  ctx.lineTo(narX + 4, narY + 2);
  ctx.closePath(); ctx.fill();
  ctx.font = 'bold 9px IBM Plex Sans, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('N', narX, narY + 4);

  // ── Legend ──
  const LEG = [
    { color: 'rgba(30,100,180,0.6)',      label: 'water polygon'  },
    { color: 'rgba(220,140,50,0.9)',      label: 'coastline way'  },
    { color: '#00c8a0',                   label: 'sample – water' },
    { color: '#e06020',                   label: 'sample – land'  },
    { color: 'rgba(180,180,180,0.7)',     label: 'sample – out of bbox' },
  ];
  ctx.font = '8px IBM Plex Mono, monospace';
  ctx.textBaseline = 'middle';
  let legY = offY + 4;
  LEG.forEach(({ color, label }) => {
    ctx.fillStyle = color;
    ctx.fillRect(offX + 4, legY - 4, 8, 8);
    ctx.fillStyle = 'rgba(200,210,220,0.9)';
    ctx.textAlign = 'left';
    ctx.fillText(label, offX + 15, legY);
    legY += 12;
  });
}

function renderShoreDebug() {
  const d = window.SHORE_DEBUG;

  const mapCanvas = document.getElementById('shore-debug-map');
  const metaEl   = document.getElementById('shore-debug-meta');
  const ringsTb  = document.querySelector('#shore-debug-rings-table tbody');
  const bearTb   = document.querySelector('#shore-debug-bearings-table tbody');
  if (!metaEl || !ringsTb || !bearTb) return;

  if (!d) {
    metaEl.textContent = 'No debug data yet — fetch sea bearings first.';
    ringsTb.innerHTML  = '';
    bearTb.innerHTML   = '';
    if (mapCanvas) {
      const ctx = mapCanvas.getContext('2d');
      ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    }
    return;
  }

  drawShoreDebugMap(d);

  const seaCount = Array.from(window.SHORE_MASK || []).filter(v => v >= SHORE_SEA_THRESH).length;
  metaEl.innerHTML = `
    <span class="sdd-key">Location:</span>
    <span class="sdd-val">${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}</span>
    <span class="sdd-key">Image:</span>
    <span class="sdd-val">${d.width} × ${d.height} px</span>
    <span class="sdd-key">Resolution:</span>
    <span class="sdd-val">~${d.metersPerPixel.toFixed(1)} m/px</span>
    <span class="sdd-key">Sea bearings:</span>
    <span class="sdd-val">${seaCount} / 36</span>
    <span class="sdd-key">Origin:</span>
    <span class="sdd-val">${d.originIsWater ? 'on water' : 'on land'}</span>
  `;

  // ── WMS request details table ──
  const urlShort = d.wmsUrl.replace(/^https?:\/\//, '');
  const vecStatus = d.vectorState === 'loading' ? '<span class="sdd-warn">loading…</span>'
                  : d.vectorState === 'error'   ? '<span class="sdd-warn">unavailable</span>'
                  : `${(d.coastWays||[]).length} coast ways, ${(d.waterPolys||[]).length} water polys`;
  ringsTb.innerHTML = `
    <tr>
      <td class="sdd-key">URL</td>
      <td colspan="2" style="word-break:break-all;font-size:9px">
        <a href="${d.wmsUrl}" target="_blank" style="color:#5af;text-decoration:none">
          open ↗</a>
        <span class="sdd-sub" style="display:block">${urlShort.slice(0, 100)}…</span>
      </td>
    </tr>
    <tr>
      <td class="sdd-key">Mercator W/E</td>
      <td colspan="2" class="sdd-val" style="font-size:9px">
        ${d.mercatorBbox.west.toFixed(0)} / ${d.mercatorBbox.east.toFixed(0)} m
      </td>
    </tr>
    <tr>
      <td class="sdd-key">Mercator S/N</td>
      <td colspan="2" class="sdd-val" style="font-size:9px">
        ${d.mercatorBbox.south.toFixed(0)} / ${d.mercatorBbox.north.toFixed(0)} m
      </td>
    </tr>
    <tr>
      <td class="sdd-key">Vector (viz)</td>
      <td colspan="2" class="sdd-val" style="font-size:9px">${vecStatus}</td>
    </tr>
  `;

  // ── Bearings table ──
  const REASON_ABBR = {
    // WMS pixel-based reasons (current)
    'wms:water': 'WW',
    'wms:land':  'WL',
    'oob:sea':   'OB',
    // Legacy Overpass reasons (kept for any cached SHORE_DEBUG snapshots)
    'coast:land':       'CL',
    'coast:sea':        'CS',
    waterArea:          'WA',
    'fallback:sea':     'FS',
    'fallback:noCoast': 'NC',
  };
  bearTb.innerHTML = d.bearings.map(row => {
    const pct   = Math.round(row.seaFrac * 100);
    const isSea = row.seaFrac >= SHORE_SEA_THRESH;
    const cells = row.samples.map(s => {
      const abbr = REASON_ABBR[s.reason] ?? s.reason;

      const cls  = s.isSea ? 'sdd-sea-cell' : 'sdd-land-cell';
      return `<td class="${cls}" title="${s.reason}">${s.isSea ? '~' : '▲'}${abbr}</td>`;
    }).join('');
    return `<tr class="${isSea ? 'sdd-sea-row' : 'sdd-land-row'}">
      <td>${row.bearing}°</td>
      <td>${pct}%</td>
      ${cells}
    </tr>`;
  }).join('');
}

/* ══════════════════════════════════════════════════
   KITE CONFIG DIALOG
══════════════════════════════════════════════════ */
(function () {
  const overlay          = document.getElementById('kite-modal-overlay');
  const minInput         = document.getElementById('kite-min-input');
  const maxInput         = document.getElementById('kite-max-input');
  const daylightInput    = document.getElementById('kite-at-night-input');
  const seaThreshSlider  = document.getElementById('kite-sea-thresh-input');
  const seaThreshLabel   = document.getElementById('kite-sea-thresh-label');
  const applyBtn         = document.getElementById('kite-modal-apply');
  const cancelBtn        = document.getElementById('kite-modal-cancel');
  const resetBtn         = document.getElementById('kite-modal-reset');
  const cfgBtn           = document.getElementById('kite-cfg-btn');
  const shoreFetchBtn    = document.getElementById('kite-shore-fetch-btn');

  // ── Active bearings state ─────────────────────────────────────────────
  let activeBearings = [];   // array of snapped 10° bearings (numbers)

  // ── Shore compass draw ───────────────────────────────────────────────
  function drawModalCompass() {
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas || !window.drawShoreCompass) return;
    const SIZE = canvas.clientWidth || 210;
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width  = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);

    let windDeg = null, windGood = false;
    if (lastData && lastData.dirs && lastData.dirs.length) {
      const now = Date.now();
      const idx = lastData.times.findIndex(t => new Date(t).getTime() >= now);
      const i   = idx >= 0 ? idx : 0;
      windDeg   = lastData.dirs[i];
      windGood  = lastData.winds && isKiteOptimal(lastData.winds[i], windDeg, lastData.times[i]);
    }

    window.drawShoreCompass(ctx, SIZE / 2, SIZE / 2, SIZE / 2 - 2,
      window.SHORE_MASK, windDeg, windGood, activeBearings,
      seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : null);
  }

  // ── Drag-to-select on the compass canvas ─────────────────────────────
  let dragMode      = null;   // 'add' | 'remove' | null
  let lastDragSlot  = null;   // last bearing slot touched during drag

  function bearingFromPointer(canvas, clientX, clientY) {
    const rect   = canvas.getBoundingClientRect();
    const x      = clientX - rect.left;
    const y      = clientY - rect.top;
    const cx     = rect.width  / 2;
    const cy     = rect.height / 2;
    const dx     = x - cx;
    const dy     = y - cy;
    const dist   = Math.sqrt(dx * dx + dy * dy);
    const innerR = (rect.width / 2) * 0.28;
    if (dist < innerR || dist > rect.width / 2) return null;
    const angle  = Math.atan2(dy, dx) * 180 / Math.PI;  // -180..180, 0=East
    return snapBearing((angle + 90 + 360) % 360);        // 0=North
  }

  function applyDrag(bearing) {
    if (bearing === null || bearing === lastDragSlot) return;
    lastDragSlot = bearing;
    if (dragMode === 'add' && !activeBearings.includes(bearing)) {
      activeBearings.push(bearing);
      drawModalCompass();
    } else if (dragMode === 'remove' && activeBearings.includes(bearing)) {
      activeBearings = activeBearings.filter(b => b !== bearing);
      drawModalCompass();
    }
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return; // left-button only
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const bearing = bearingFromPointer(canvas, clientX, clientY);
    if (bearing === null) return;
    dragMode     = activeBearings.includes(bearing) ? 'remove' : 'add';
    lastDragSlot = null;
    applyDrag(bearing);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragMode) return;
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    applyDrag(bearingFromPointer(canvas, clientX, clientY));
    e.preventDefault();
  }

  function onPointerUp() { dragMode = null; lastDragSlot = null; }

  const canvas = document.getElementById('shore-compass-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown',  onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    window.addEventListener('mousemove',  onPointerMove);
    window.addEventListener('touchmove',  onPointerMove, { passive: false });
    window.addEventListener('mouseup',    onPointerUp);
    window.addEventListener('touchend',   onPointerUp);
  }

  // ── Sea-threshold slider: live label, bearing re-select + compass preview ──
  if (seaThreshSlider) {
    seaThreshSlider.addEventListener('input', () => {
      if (seaThreshLabel) seaThreshLabel.textContent = seaThreshSlider.value + '%';
      const thresh = parseInt(seaThreshSlider.value) / 100;
      if (window.setShoreSeaThresh) window.setShoreSeaThresh(thresh);
      if (window.SHORE_MASK) {
        activeBearings = [];
        for (let b = 0; b < SHORE_BEARINGS; b++) {
          if (window.SHORE_MASK[b] >= thresh) activeBearings.push(b * 10);
        }
      }
      drawModalCompass();
      updateShoreStatusUI();
    });
  }

  // ── Sync dialog ↔ config ─────────────────────────────────────────────
  function syncDialogToConfig(cfg) {
    minInput.value        = cfg.min;
    maxInput.value        = cfg.max;
    daylightInput.checked = !cfg.daylight;
    activeBearings        = cfg.dirs.slice();
    const pct = Math.round((cfg.seaThresh ?? KITE_DEFAULTS.seaThresh) * 100);
    if (seaThreshSlider) seaThreshSlider.value = pct;
    if (seaThreshLabel)  seaThreshLabel.textContent = pct + '%';
  }
  function readDialogConfig() {
    const parsedMin = parseFloat(minInput.value);
    const parsedMax = parseFloat(maxInput.value);
    return {
      min:       isNaN(parsedMin) ? KITE_DEFAULTS.min : parsedMin,
      max:       isNaN(parsedMax) ? KITE_DEFAULTS.max : parsedMax,
      dirs:      activeBearings.length ? activeBearings.slice() : KITE_DEFAULTS.dirs,
      daylight:  !daylightInput.checked,
      seaThresh: seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : KITE_DEFAULTS.seaThresh,
    };
  }

  window.refreshShoreCompassInModal = function() {
    if (overlay.classList.contains('open')) drawModalCompass();
    updateShoreStatusUI();
  };

  cfgBtn.addEventListener('click', () => {
    syncDialogToConfig(KITE_CFG);
    overlay.classList.add('open');
    // Ensure raster + vector data is fetched (or retried if a previous attempt failed).
    // Both functions deduplicate in-flight requests, so duplicate calls are free.
    if (lastShoreCoords) {
      if (window.fetchShoreVector) window.fetchShoreVector(lastShoreCoords.lat, lastShoreCoords.lon).catch(() => null);
      if (window.analyseShore)     window.analyseShore(lastShoreCoords.lat, lastShoreCoords.lon).catch(() => null);
    }
    requestAnimationFrame(() => { drawModalCompass(); updateShoreStatusUI(); renderShoreDebug(); });
  });
  cancelBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  resetBtn.addEventListener('click', () => { syncDialogToConfig(KITE_DEFAULTS); drawModalCompass(); });
  applyBtn.addEventListener('click', () => {
    const cfg = readDialogConfig();
    window.setShoreSeaThresh(cfg.seaThresh);   // commit threshold before re-render
    setKiteParams(cfg);
    overlay.classList.remove('open');
    if (lastData) renderDisplay(lastData);
  });

  // Re-render debug panel and compass when the Overpass vector fetch completes.
  // Use requestAnimationFrame so the canvas draw happens after any pending layout
  // (e.g. the modal becoming display:flex) has been committed by the browser.
  window.addEventListener('shore-vector-ready', () => {
    renderShoreDebug();
    requestAnimationFrame(() => drawModalCompass());
  });

  // Update status and compass when the raster analysis (SHORE_MASK) completes.
  // Also auto-populate activeBearings if they haven't been set yet for this load.
  window.addEventListener('shore-mask-ready', () => {
    if (window.SHORE_MASK && activeBearings.length === 0) {
      const thresh = seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : SHORE_SEA_THRESH;
      for (let b = 0; b < SHORE_BEARINGS; b++) {
        if (window.SHORE_MASK[b] >= thresh) activeBearings.push(b * 10);
      }
    }
    updateShoreStatusUI();
    requestAnimationFrame(() => drawModalCompass());
  });

  shoreFetchBtn.addEventListener('click', () => {    if (!lastShoreCoords) {
      const el = document.getElementById('shore-modal-status');
      if (el) { el.textContent = '⚠ Load a city first'; el.style.color = '#aa8844'; }
      return;
    }
    shoreFetchBtn.disabled    = true;
    shoreFetchBtn.textContent = '⏳ Fetching…';
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline data…' };
    updateShoreStatusUI();
    drawModalCompass();
    window.analyseShore(lastShoreCoords.lat, lastShoreCoords.lon, () => {
      // Auto-select all sea bearings, deselect all land bearings
      if (window.SHORE_MASK) {
        const fetchThresh = seaThreshSlider ? parseInt(seaThreshSlider.value) / 100 : SHORE_SEA_THRESH;
        activeBearings = [];
        for (let b = 0; b < SHORE_BEARINGS; b++) {
          if (window.SHORE_MASK[b] >= fetchThresh) {
            activeBearings.push(b * 10);
          }
        }
      }
      updateShoreStatusUI();
      drawModalCompass();
      if (lastData) renderDisplay(lastData);
      shoreFetchBtn.disabled    = false;
      shoreFetchBtn.textContent = '🌊 Auto-detect sea bearings';
    });
  });
})();
/* ══════════════════════════════════════════════════
   URL ↔ SEARCH-BAR SYNCHRONISATION
══════════════════════════════════════════════════ */
function getQParam() {
  return new URLSearchParams(window.location.search).get('q') || '';
}
function setQParam(city) {
  const url = new URL(window.location.href);
  if (city) { url.searchParams.set('q', city); } else { url.searchParams.delete('q'); }
  window.history.replaceState(null, '', url.toString());
}
function setLoadingMsg(msg) {
  const el = document.getElementById('loading');
  if (el) el.textContent = msg;
}

/**
 * Load weather for exact coordinates without geocoding and without
 * resetting the radar map (used when the user drags the radar pin).
 */
async function loadAtCoords(lat, lon, model) {
  model = model || getModel();
  const forecastEl = document.getElementById('forecast-content');
  const isReload = lastData !== null;
  if (isReload) {
    forecastEl.classList.add('updating');
  } else {
    document.getElementById('loading').style.display = 'block';
    forecastEl.style.display = 'none';
  }
  document.getElementById('error-msg').style.display = 'none';
  try {
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline…' };
    // Coords are already known — start the Overpass fetch immediately so it
    // runs in parallel with the reverse-geocode and weather requests.
    lastShoreCoords = { lat, lon };
    if (window.fetchShoreVector) window.fetchShoreVector(lat, lon).catch(() => null);
    if (window.analyseShore)     window.analyseShore(lat, lon).catch(() => null);

    // Persist coords before any awaits: both a page reload and an iOS Home
    // Screen launch (which always opens the manifest start_url without query
    // params) must be able to restore the exact position from localStorage.
    const coordStr = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    setQParam(coordStr);
    try { localStorage.setItem('vejr_city', coordStr); } catch(_) {}

    // Reverse-geocode for a human-readable name (best-effort)
    let displayName = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    let reverseCountryCode = null;
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
        { headers: { 'Accept-Language': 'en' } }
      );
      if (r.ok) {
        const d = await r.json();
        displayName = d.address?.city || d.address?.town || d.address?.village
                      || d.display_name.split(',')[0];
        reverseCountryCode = (d.address?.country_code || '').toUpperCase() || null;
      }
    } catch(_) { /* keep coord string */ }

    document.getElementById('city-input').value = displayName;

    const iconCodeFetch = (model === 'dmi_seamless')
      ? fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=weathercode&forecast_days=${FORECAST_DAYS}&timezone=auto&models=icon_seamless`)
          .then(r => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null);
    const [data, ensData, iconData] = await Promise.all([
      fetchWeather(lat, lon, model),
      fetchEnsemble(lat, lon, model).catch(() => null),
      iconCodeFetch,
    ]);
    const H = data.hourly;
    const iconCodes = iconData?.hourly?.weathercode || null;
    sunTimes = {};
    if (data.daily?.sunrise && data.daily?.sunset) {
      data.daily.sunrise.forEach((riseStr, i) => {
        const key     = riseStr.slice(0, 10);
        const sunrise = parseFloat(riseStr.slice(11,13)) + parseFloat(riseStr.slice(14,16)) / 60;
        const setStr  = data.daily.sunset[i];
        const sunset  = parseFloat(setStr.slice(11,13))  + parseFloat(setStr.slice(14,16))  / 60;
        sunTimes[key] = { sunrise, sunset };
      });
    }
    const times=[],temps=[],precips=[],gusts=[],winds=[],dirs=[],codes=[];
    const times1h=[],temps1h=[],precips1h=[],gusts1h=[],winds1h=[],codes1h=[],dirs1h=[];
    const totalH = FORECAST_DAYS * 24;
    for (let i = 0; i < Math.min(totalH, H.time.length); i += STEP) {
      times.push(H.time[i]);
      temps.push(H.temperature_2m[i]);
      precips.push(H.precipitation[i] ?? 0);
      winds.push(H.windspeed_10m[i]);
      const rawGust = H.windgusts_10m[i];
      gusts.push(rawGust != null ? rawGust : H.windspeed_10m[i]);
      dirs.push(H.winddirection_10m[i]);
      const dmiCode  = H.weathercode[i];
      const iconCode = iconCodes ? (iconCodes[i] ?? dmiCode) : dmiCode;
      const code = (iconCodes && dmiCode >= 80 && dmiCode <= 82 && iconCode >= 95)
                   ? iconCode : dmiCode;
      codes.push(code);
    }
    for (let i = 0; i < Math.min(totalH, H.time.length); i += STEP1H) {
      times1h.push(H.time[i]);
      temps1h.push(H.temperature_2m[i]);
      precips1h.push(H.precipitation[i] ?? 0);
      winds1h.push(H.windspeed_10m[i]);
      const rawGust1h = H.windgusts_10m[i];
      gusts1h.push(rawGust1h != null ? rawGust1h : H.windspeed_10m[i]);
      // Weather codes at 1h resolution (portrait mode shows finest available icons)
      const dmiCode1h  = H.weathercode[i];
      const iconCode1h = iconCodes ? (iconCodes[i] ?? dmiCode1h) : dmiCode1h;
      codes1h.push((iconCodes && dmiCode1h >= 80 && dmiCode1h <= 82 && iconCode1h >= 95)
        ? iconCode1h : dmiCode1h);
      dirs1h.push(H.winddirection_10m[i]);
    }
    const MODEL_LABEL = {
      'best_match':          'Auto',      'dmi_seamless':        'DMI HARMONIE',
      'icon_seamless':       'DWD ICON',  'ecmwf_ifs025':        'ECMWF IFS',
      'meteofrance_seamless':'Météo-France', 'gfs_seamless':     'NOAA GFS',
    };
    const ENS_LABEL = {
      'best_match':'ICON-EPS', 'dmi_seamless':'ICON-EPS', 'icon_seamless':'ICON-EPS',
      'ecmwf_ifs025':'IFS-EPS', 'meteofrance_seamless':'ICON-EPS', 'gfs_seamless':'GFS-EPS',
    };
    const modelLabel = MODEL_LABEL[model] || model;
    const ensLabel   = ENS_LABEL[model]   || 'ensemble';
    let ensTemp=null,ensWind=null,ensGust=null,ensPrecip=null;
    let ensTemp1h=null,ensWind1h=null,ensGust1h=null,ensPrecip1h=null;
    const ensStatus = document.getElementById('ens-status');
    if (ensData && ensData.hourly) {
      ensTemp    = ensemblePercentiles(ensData.hourly, 'temperature_2m');
      ensWind    = ensemblePercentiles(ensData.hourly, 'windspeed_10m');
      ensGust    = ensemblePercentiles(ensData.hourly, 'windgusts_10m');
      ensPrecip  = ensemblePercentiles(ensData.hourly, 'precipitation');
      ensTemp1h  = ensemblePercentiles(ensData.hourly, 'temperature_2m',  STEP1H);
      ensWind1h  = ensemblePercentiles(ensData.hourly, 'windspeed_10m',   STEP1H);
      ensGust1h  = ensemblePercentiles(ensData.hourly, 'windgusts_10m',   STEP1H);
      ensPrecip1h= ensemblePercentiles(ensData.hourly, 'precipitation',   STEP1H);
      const detGusts   = gusts.slice();
      const detGusts1h = gusts1h.slice();
      if (ensTemp)    for (let i=0;i<temps.length;  i++) { if (ensTemp.p50[i]   !=null) temps[i]  =ensTemp.p50[i];   }
      if (ensWind)    for (let i=0;i<winds.length;  i++) { if (ensWind.p50[i]   !=null) winds[i]  =ensWind.p50[i];   }
      if (ensPrecip)  for (let i=0;i<precips.length;i++) { if (ensPrecip.p50[i] !=null) precips[i]=ensPrecip.p50[i]; }
      if (ensTemp1h)  for (let i=0;i<temps1h.length;  i++) { if (ensTemp1h.p50[i]  !=null) temps1h[i]  =ensTemp1h.p50[i];   }
      if (ensWind1h)  for (let i=0;i<winds1h.length;  i++) { if (ensWind1h.p50[i]  !=null) winds1h[i]  =ensWind1h.p50[i];   }
      if (ensPrecip1h)for (let i=0;i<precips1h.length;i++) { if (ensPrecip1h.p50[i]!=null) precips1h[i]=ensPrecip1h.p50[i]; }
      for (let i=0;i<gusts.length;  i++) gusts[i]  =Math.max(detGusts[i],   winds[i]);
      for (let i=0;i<gusts1h.length;i++) gusts1h[i]=Math.max(detGusts1h[i], winds1h[i]);
      const memberCount = Object.keys(ensData.hourly).filter(k=>k.startsWith('temperature_2m_member')).length;
      ensStatus.textContent = `${modelLabel} + ${ensLabel} (${memberCount} mdl) ✓`;
      ensStatus.style.color = '#5a9';
    } else {
      ensStatus.textContent = `${modelLabel} — ensemble not available`;
      ensStatus.style.color = '#a77';
    }
    document.getElementById('city-name').textContent = displayName;
    document.getElementById('loading').style.display = 'none';
    forecastEl.style.display = 'block';
    forecastEl.classList.remove('updating');
    const isFirstLoad = !isReload;
    lastData = {
      times, temps, precips, gusts, winds, dirs, codes,
      ensTemp, ensWind, ensGust, ensPrecip,
      times1h, temps1h, precips1h, gusts1h, winds1h, codes1h, dirs1h,
      ensTemp1h, ensWind1h, ensGust1h, ensPrecip1h,
      otherModelsWind1h: null,
    };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      renderDisplay(lastData, isFirstLoad);
      // Background fetch of other-model wind lines; re-render on arrival.
      const capturedData = lastData;
      fetchOtherModelsWind(lat, lon, model)
        .then(otherModels => {
          if (lastData !== capturedData || !otherModels.length) return;
          lastData.otherModelsWind1h = otherModels;
          renderDisplay(lastData);
        })
        .catch(() => null);
    }));
    // Call loadRadar only when the section is not yet visible (i.e. on a fresh
    // page load restored from a dragged-pin URL).  When called from a live drag
    // the radar is already initialised and correctly positioned, so skip it.
    if (window.loadRadar) {
      const radarSection = document.getElementById('radar-section');
      if (!radarSection || radarSection.style.display !== 'flex') {
        window.loadRadar(lat, lon);
      }
    }
    updateShoreStatusUI();
    loadNearestObsStation(lat, lon).catch(() => null);
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display = 'none';
    forecastEl.classList.remove('updating');
    document.getElementById('error-msg').style.display = 'block';
  }
}

async function loadByCoords(lat, lon, model) {
  model = model || getModel();
  setLoadingMsg('Fetching your location…');
  document.getElementById('loading').style.display         = 'block';
  document.getElementById('forecast-content').style.display = 'none';
  document.getElementById('error-msg').style.display       = 'none';
  let displayName = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
      { headers: { 'Accept-Language': 'en' } }
    );
    if (r.ok) {
      const d = await r.json();
      displayName = d.address?.city || d.address?.town || d.address?.village
                    || d.display_name.split(',')[0];
    }
  } catch(e) { /* keep coordinate fallback */ }
  document.getElementById('city-input').value = displayName;
  // Persist coords (not the display name) so an iOS Home Screen launch restores
  // the exact GPS-detected position instead of re-geocoding a city name.
  const coordStr = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  setQParam(coordStr);
  try { localStorage.setItem('vejr_city', coordStr); } catch(_) {}
  await load(displayName, model);
}
// On the first load where the user has no saved kite config (KITE_CFG._fromDefaults),
// auto-apply sea bearings derived from the shore mask.  Must be called before the
// location load so the listener is registered before analyseShore fires.
function autoDetectSeaBearingsOnce() {
  if (!KITE_CFG._fromDefaults) return;
  function apply() {
    if (!window.SHORE_MASK) return;
    const dirs = [];
    for (let b = 0; b < SHORE_BEARINGS; b++) {
      if (window.SHORE_MASK[b] >= SHORE_SEA_THRESH) dirs.push(b * 10);
    }
    if (dirs.length === 0) return;
    setKiteParams({ ...KITE_CFG, dirs, _fromDefaults: false });
    if (lastData) renderDisplay(lastData);
  }
  if (window.SHORE_MASK) { apply(); return; }
  function onMaskReady() {
    window.removeEventListener('shore-mask-ready', onMaskReady);
    apply();
  }
  window.addEventListener('shore-mask-ready', onMaskReady);
}
async function tryGeolocation(model) {
  if (!navigator.geolocation) { await loadAtCoords(54.941360, 11.999631, model); return; }
  setLoadingMsg('Finding your location…');
  document.getElementById('loading').style.display         = 'block';
  document.getElementById('forecast-content').style.display = 'none';
  document.getElementById('error-msg').style.display       = 'none';
  navigator.geolocation.getCurrentPosition(
    pos => loadByCoords(pos.coords.latitude, pos.coords.longitude, model),
    _err => loadAtCoords(54.941360, 11.999631, model),
    { timeout: 8000, maximumAge: 300000 }
  );
}
async function loadAndSync(city, model) {
  setQParam(city);
  localStorage.setItem('vejr_city', city);
  await load(city, model);
}
function openCitySearch() {
  document.getElementById('header-left').classList.add('search-open');
  const input = document.getElementById('city-input');
  const cityNameText = document.getElementById('city-name').textContent;
  if (cityNameText && cityNameText !== '—') input.value = cityNameText;
  if (input.focus)  input.focus();
  if (input.select) input.select();
}
function closeCitySearch() {
  document.getElementById('header-left').classList.remove('search-open');
}
document.getElementById('search-toggle-btn').addEventListener('click', openCitySearch);
document.getElementById('city-name-wrap').addEventListener('click', openCitySearch);
document.getElementById('city-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = e.target.value.trim();
    if (v) { closeCitySearch(); loadAndSync(v, getModel()); }
  } else if (e.key === 'Escape') {
    closeCitySearch();
  }
});
/* #model-select is a transparent CSS overlay covering #model-dropdown;
   clicks on #ens-status naturally hit the select, which opens natively. */
document.getElementById('model-select').addEventListener('change', () => {
  const city = document.getElementById('city-input').value.trim()
            || localStorage.getItem('vejr_city') || '';
  if (city) loadAndSync(city, getModel());
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastData) renderDisplay(lastData); }, 100);
});
window.matchMedia('(inverted-colors: inverted)').addEventListener('change', () => {
  syncInvertedColorsClass();
  if (lastData) renderDisplay(lastData);
});
// ── Radar pin drag → update location ────────────────────────────────────
if (window.setRadarDragCallback) {
  window.setRadarDragCallback((lat, lon) => {
    loadAtCoords(lat, lon, getModel());
  });
}
if (window.setObsToggleCallback) {
  window.setObsToggleCallback(() => {
    if (lastObsCoords) loadNearestObsStation(lastObsCoords.lat, lastObsCoords.lon).catch(() => null);
  });
}

// ── Initial load ──────────────────────────────────────────────────────────
// Pure decision function: given the three possible location sources, returns
// which one to use.  Tested directly in tests/app.test.js.
function decideInitialLocation(qParam, typedInput, savedCity) {
  if (qParam)     return { type: 'qparam', value: qParam };
  if (typedInput) return { type: 'typed',  value: typedInput };
  if (savedCity)  return { type: 'saved',  value: savedCity };
  return            { type: 'geolocation' };
}

(function initialLoad() {
  syncInvertedColorsClass();  // apply before data loads so button is correct immediately
  const model    = getModel();
  const qParam   = getQParam();
  const typed    = document.getElementById('city-input').value.trim();
  const saved    = localStorage.getItem('vejr_city');
  const decision = decideInitialLocation(qParam, typed, saved);
  // Register auto-detection before any location load fires, regardless of which
  // path is taken below (qparam, saved, geolocation, typed).
  autoDetectSeaBearingsOnce();

  if (decision.type === 'qparam') {
    // If q looks like "lat,lon" (stored when the user dragged the pin), restore
    // the exact coordinates without going through geocoding.
    const coordMatch = decision.value.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      loadAtCoords(parseFloat(coordMatch[1]), parseFloat(coordMatch[2]), model);
    } else {
      document.getElementById('city-input').value = decision.value;
      load(decision.value, model);
    }
  } else if (decision.type === 'geolocation') {
    tryGeolocation(model);
  } else {
    // saved or typed — if the stored value is a "lat,lon" coord string (written
    // by loadAtCoords / loadByCoords to survive iOS Home Screen launches), restore
    // the exact coordinates instead of sending them through geocoding.
    const coordMatch = decision.value.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (coordMatch) {
      loadAtCoords(parseFloat(coordMatch[1]), parseFloat(coordMatch[2]), model);
    } else {
      document.getElementById('city-input').value = decision.value;
      setQParam(decision.value);
      load(decision.value, model);
    }
  }
})();
/* ══════════════════════════════════════════════════
   HELP MODAL
══════════════════════════════════════════════════ */
(function () {
  const overlay  = document.getElementById('help-modal-overlay');
  const body     = document.getElementById('help-modal-body');
  const closeBtn = document.getElementById('help-modal-close');
  const openBtn  = document.getElementById('help-btn');

  function inlineFmt(s) {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function parseMd(md) {
    const lines = md.split('\n');
    let html = '';
    let inList = false;
    let buf = [];

    function flushPara() {
      const text = buf.join(' ').trim();
      if (text) html += `<p>${inlineFmt(text)}</p>\n`;
      buf = [];
    }

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.startsWith('## ')) {
        flushPara();
        if (inList) { html += '</ul>\n'; inList = false; }
        html += `<h2>${inlineFmt(line.slice(3))}</h2>\n`;
      } else if (line.startsWith('### ')) {
        flushPara();
        if (inList) { html += '</ul>\n'; inList = false; }
        html += `<h3>${inlineFmt(line.slice(4))}</h3>\n`;
      } else if (line.startsWith('- ')) {
        flushPara();
        if (!inList) { html += '<ul>\n'; inList = true; }
        html += `<li>${inlineFmt(line.slice(2))}</li>\n`;
      } else if (line === '') {
        flushPara();
        if (inList) { html += '</ul>\n'; inList = false; }
      } else {
        buf.push(line);
      }
    }
    flushPara();
    if (inList) html += '</ul>\n';
    return html;
  }

  let loaded = false;
  function open() {
    overlay.classList.add('open');
    if (!loaded) {
      const src = document.getElementById('help-md');
      body.innerHTML = src ? parseMd(src.textContent) : '<p>Help content missing.</p>';
      loaded = true;
    }
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.classList.remove('open');
  });
})();

/* ══════════════════════════════════════════════════
   CREDITS MODAL
══════════════════════════════════════════════════ */
(function () {
  const overlay  = document.getElementById('credits-modal-overlay');
  const closeBtn = document.getElementById('credits-modal-close');
  const openBtn  = document.getElementById('credits-btn');

  openBtn.addEventListener('click', () => overlay.classList.add('open'));
  closeBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') overlay.classList.remove('open');
  });
})();

// Register service worker for PWA / offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
