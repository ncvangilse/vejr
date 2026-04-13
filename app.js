/* ══════════════════════════════════════════════════
   MAIN APP — load, tooltip, kite dialog, URL sync
══════════════════════════════════════════════════ */
var lastData        = null;
var lastRenderedData = null; // the sliced data passed to the most recent renderAll call
let lastShoreCoords = null;  // { lat, lon } of the last loaded city

function syncInvertedColorsClass() {
  const on = window.matchMedia('(inverted-colors: inverted)').matches;
  document.body.classList.toggle('inverted-colors', on);
}
/* ══════════════════════════════════════════════════
   LOAD
══════════════════════════════════════════════════ */
async function load(cityName, model) {
  model = model || 'best_match';
  document.getElementById('loading').style.display='block';
  document.getElementById('forecast-content').style.display='none';
  document.getElementById('error-msg').style.display='none';
  try {
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline…' };
    const loc = await geocode(cityName);
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
    // 1-hour resolution arrays for smooth curves (temp, wind speed/gust, precip)
    const times1h=[],temps1h=[],precips1h=[],gusts1h=[],winds1h=[];
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
    const t0=new Date(times[0]),t1=new Date(times[times.length-1]);
    document.getElementById('subtitle').textContent =
      `Forecast from ${DA_DAYS3[t0.getDay()]} at ${t0.getHours()}:00 to ${DA_DAYS3[t1.getDay()]} at ${t1.getHours()}:00`;
    const now=new Date();
    document.getElementById('updated-text').textContent =
      `Updated ${now.getDate()} ${DA_MON[now.getMonth()]} ${now.getFullYear()}`;
    document.getElementById('loading').style.display='none';
    document.getElementById('forecast-content').style.display='block';
    lastData = {
      times, temps, precips, gusts, winds, dirs, codes,
      ensTemp, ensWind, ensGust, ensPrecip,
      times1h, temps1h, precips1h, gusts1h, winds1h,
      ensTemp1h, ensWind1h, ensGust1h, ensPrecip1h,
    };
    // Double rAF ensures layout is complete before measuring canvas width
    requestAnimationFrame(() => requestAnimationFrame(() => renderDisplay(lastData)));
    // Load RainViewer radar centred on the selected city
    if (window.loadRadar) window.loadRadar(loc.latitude, loc.longitude);
    // Store coords for on-demand shore analysis (triggered from the kite modal)
    lastShoreCoords = { lat: loc.latitude, lon: loc.longitude };
    updateShoreStatusUI();
    // DMI observations (fire-and-forget; re-renders when done)
    loadDmiObservations(loc.latitude, loc.longitude, loc.country_code).catch(() => null);
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display='none';
    document.getElementById('error-msg').style.display='block';
  }
}
/* ══════════════════════════════════════════════════
   PORTRAIT-AWARE RENDERING
   In portrait mode the full remaining forecast is shown in a scrollable
   canvas — each 3-hour slot is PORTRAIT_COL_W px wide so one icon fits
   per slot, and the user can swipe to travel through time.
══════════════════════════════════════════════════ */
const PORTRAIT_COL_W = 24; // px per 3-hour slot in portrait scroll mode

function slicePercentilesFrom(obj, start, n) {
  if (!obj) return null;
  return { p10: obj.p10.slice(start, start + n), p50: obj.p50.slice(start, start + n), p90: obj.p90.slice(start, start + n) };
}

function renderDisplay(d) {
  const portrait       = window.matchMedia('(orientation: portrait)').matches;
  const invertedColors = window.matchMedia('(inverted-colors: inverted)').matches;
  syncInvertedColorsClass();
  // In portrait, start from the current time and show the full remaining forecast
  // (scrollable). In landscape show the full 7-day window from midnight.
  let s3 = 0, s1 = 0;
  if (portrait) {
    const now = Date.now();
    const i = d.times.findIndex(t => new Date(t).getTime() >= now);
    s3 = i >= 0 ? i : 0;
    // Align the 1h window to the same start time as the 3h window so that
    // day dividers fall at the same pixel position in the icon row and graphs.
    const startTime = new Date(d.times[s3]).getTime();
    const i1 = d.times1h.findIndex(t => new Date(t).getTime() >= startTime);
    s1 = i1 >= 0 ? i1 : 0;
  }
  const n3h = portrait ? d.times.length - s3 : Math.ceil(FORECAST_DAYS * 24 / STEP);
  const n1h = portrait ? d.times1h.length - s1 : Math.ceil(FORECAST_DAYS * 24 / STEP1H);
  const s = {
    times:    d.times.slice(s3, s3 + n3h),    temps:    d.temps.slice(s3, s3 + n3h),
    precips:  d.precips.slice(s3, s3 + n3h),  gusts:    d.gusts.slice(s3, s3 + n3h),
    winds:    d.winds.slice(s3, s3 + n3h),    dirs:     d.dirs.slice(s3, s3 + n3h),
    codes:    d.codes.slice(s3, s3 + n3h),
    ensTemp:  slicePercentilesFrom(d.ensTemp,  s3, n3h), ensWind:  slicePercentilesFrom(d.ensWind,  s3, n3h),
    ensGust:  slicePercentilesFrom(d.ensGust,  s3, n3h), ensPrecip: slicePercentilesFrom(d.ensPrecip, s3, n3h),
    times1h:  d.times1h.slice(s1, s1 + n1h),  temps1h:  d.temps1h.slice(s1, s1 + n1h),
    precips1h: d.precips1h.slice(s1, s1 + n1h), gusts1h: d.gusts1h.slice(s1, s1 + n1h),
    winds1h:  d.winds1h.slice(s1, s1 + n1h),
    ensTemp1h:  slicePercentilesFrom(d.ensTemp1h,  s1, n1h), ensWind1h:  slicePercentilesFrom(d.ensWind1h,  s1, n1h),
    ensGust1h:  slicePercentilesFrom(d.ensGust1h,  s1, n1h), ensPrecip1h: slicePercentilesFrom(d.ensPrecip1h, s1, n1h),
  };
  const colW = portrait ? PORTRAIT_COL_W : null;
  renderAll(s, invertedColors, colW);
  lastRenderedData = s;
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
  // Re-derive the same y-mappings used by the draw functions
  const TEMP_cssH = 130, TEMP_padT = 8, TEMP_padB = 8;
  const TEMP_ch   = TEMP_cssH - TEMP_padT - TEMP_padB;
  let tmin = Math.floor(Math.min(...d.temps1h) / 5) * 5;
  let tmax = Math.ceil( Math.max(...d.temps1h) / 5) * 5;
  if (tmax - tmin < 15) { const mid = (tmin + tmax) / 2; tmin = Math.floor((mid - 7.5) / 5) * 5; tmax = tmin + 15; }
  const tRange   = tmax - tmin;
  const tempDotY = TEMP_padT + (1 - (d.temps1h[idx1h] - tmin) / tRange) * TEMP_ch;
  const WIND_H = 130, WIND_KITE_H = 24, WIND_padT = WIND_KITE_H + 4;
  const WIND_chartH   = WIND_H - WIND_padT;
  const safeGusts     = d.gusts1h.map((g, i) => Math.max(g, d.winds1h[i]));
  const ensGustMax    = d.ensGust1h ? Math.max(...d.ensGust1h.p90.filter(v => v != null)) : 0;
  const maxW          = Math.ceil(Math.max(...safeGusts, ensGustMax, 5) / 5) * 5;
  const windDotY      = WIND_padT + (1 - d.winds1h[idx1h] / maxW) * WIND_chartH;
  // xh-top and xh-dir snap to 3hr columns; xh-temp and xh-wind snap to 1hr columns
  const fracX3h = (idx3h + 0.5) / d.times.length;
  const fracX1h = (idx1h + 0.5) / d.times1h.length;
  const DOT_Y   = { 'xh-top': null, 'xh-temp': tempDotY, 'xh-dir': null, 'xh-wind': windDotY };
  const FRAC    = { 'xh-top': fracX3h, 'xh-temp': fracX1h, 'xh-dir': fracX3h, 'xh-wind': fracX1h };
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
    const x = FRAC[id] * cssW;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
    ctx.setLineDash([]);
    const dotY = DOT_Y[id];
    if (dotY !== null) {
      const dotCol = (id === 'xh-temp') ? (d.temps1h[idx1h] >= 0 ? '#cc2200' : '#4488ff') : '#fff';
      ctx.fillStyle   = dotCol;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.arc(x, dotY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
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
  // Time label from 1hr array for precision
  const t    = new Date(d.times1h[idx1h]);
  const day  = DA_DAYS[t.getDay()];
  const h    = t.getHours().toString().padStart(2,'0');
  // Curve values from 1hr arrays
  const temp = d.temps1h[idx1h];
  const prec = d.precips1h[idx1h];
  const wind = d.winds1h[idx1h];
  const gust = Math.max(d.gusts1h[idx1h], wind);
  // Icon/direction from 3hr arrays
  const dir  = d.dirs[idx3h];
  const code = d.codes[idx3h];
  const windCol = windColorStr(wind);
  const gustCol = windColorStr(gust);
  const tp10 = d.ensTemp1h   ? d.ensTemp1h.p10[idx1h]   : null;
  const tp90 = d.ensTemp1h   ? d.ensTemp1h.p90[idx1h]   : null;
  const wp10 = d.ensWind1h   ? d.ensWind1h.p10[idx1h]   : null;
  const wp90 = d.ensWind1h   ? d.ensWind1h.p90[idx1h]   : null;
  const gp10 = d.ensGust1h   ? (d.ensGust1h.p10[idx1h]   ?? null) : null;
  const gp90 = d.ensGust1h   ? (d.ensGust1h.p90[idx1h]   ?? null) : null;
  const pp10 = d.ensPrecip1h ? d.ensPrecip1h.p10[idx1h] : null;
  const pp90 = d.ensPrecip1h ? d.ensPrecip1h.p90[idx1h] : null;
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
  const kiteRow = isKiteOptimal(wind, dir, d.times1h[idx1h])
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
        ${isKiteOptimal(wind, dir, d.times1h[idx1h]) ? '<span style="position:absolute;bottom:-3px;right:-5px;font-size:14px;line-height:1;">🪁</span>' : ''}
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
    dmiIcon(ictx, wmoType(code, d.times1h[idx1h]), sz / 2, sz / 2, sz, prec, code);
  }
}
function hideTooltip() {
  document.getElementById('hover-tooltip').style.display = 'none';
  clearCrosshairs();
}
function attachHoverListeners() {
  document.getElementById('hover-tooltip').addEventListener('click', hideTooltip);
  const content = document.getElementById('forecast-content');
  content.addEventListener('mousemove', e => {
    if (!lastRenderedData) return;
    const wrap = e.target.closest('.chart-canvas-wrap');
    if (!wrap) { hideTooltip(); return; }
    const rect  = wrap.getBoundingClientRect();
    // In portrait the wrap scrolls horizontally; add scrollLeft so relX is
    // measured in canvas coordinates, not visible-viewport coordinates.
    const relX  = e.clientX - rect.left + (wrap.scrollLeft || 0);
    const span  = wrap.scrollWidth || rect.width;
    const fracX    = Math.max(0, Math.min(1, relX / span));
    const n1h      = lastRenderedData.times1h.length;
    const n3h      = lastRenderedData.times.length;
    const idx1h    = Math.min(n1h - 1, Math.floor(fracX * n1h));
    const idx3h    = Math.min(n3h - 1, Math.floor(fracX * n3h));
    drawCrosshairs(fracX, idx1h, idx3h);
    showTooltip(idx1h, idx3h);
  });
  content.addEventListener('mouseleave', hideTooltip);
}
attachHoverListeners();

/* ══════════════════════════════════════════════════
   PORTRAIT SCROLL SYNC
   Keep all four .chart-canvas-wrap scroll containers in step so that
   scrolling any one of them moves the others to the same position.
══════════════════════════════════════════════════ */
function initPortraitScrollSync() {
  const wraps = document.querySelectorAll ? [...document.querySelectorAll('.chart-canvas-wrap')] : [];
  let syncing = false;
  wraps.forEach(wrap => {
    wrap.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const left = wrap.scrollLeft;
      wraps.forEach(w => { if (w !== wrap) w.scrollLeft = left; });
      syncing = false;
    }, { passive: true });
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

  // ── Sea-threshold slider: live label + compass preview ───────────────────
  if (seaThreshSlider) {
    seaThreshSlider.addEventListener('input', () => {
      if (seaThreshLabel) seaThreshLabel.textContent = seaThreshSlider.value + '%';
      drawModalCompass();
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
    return {
      min:       parseFloat(minInput.value) || KITE_DEFAULTS.min,
      max:       parseFloat(maxInput.value) || KITE_DEFAULTS.max,
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

  // Re-render debug panel when the background Overpass vector fetch completes
  window.addEventListener('shore-vector-ready', () => renderShoreDebug());

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
      shoreFetchBtn.textContent = '🌊 Fetch sea bearings';
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
  document.getElementById('loading').style.display          = 'block';
  document.getElementById('forecast-content').style.display = 'none';
  document.getElementById('error-msg').style.display        = 'none';
  try {
    window.SHORE_MASK   = null;
    window.SHORE_STATUS = { state: 'loading', msg: 'Fetching coastline…' };

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
    // Store coords in the URL so a page reload restores the exact dragged position
    setQParam(`${lat.toFixed(6)},${lon.toFixed(6)}`);

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
    const times1h=[],temps1h=[],precips1h=[],gusts1h=[],winds1h=[];
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
    const t0=new Date(times[0]), t1=new Date(times[times.length-1]);
    document.getElementById('subtitle').textContent =
      `Forecast from ${DA_DAYS3[t0.getDay()]} at ${t0.getHours()}:00 to ${DA_DAYS3[t1.getDay()]} at ${t1.getHours()}:00`;
    const now=new Date();
    document.getElementById('updated-text').textContent =
      `Updated ${now.getDate()} ${DA_MON[now.getMonth()]} ${now.getFullYear()}`;
    document.getElementById('loading').style.display          = 'none';
    document.getElementById('forecast-content').style.display = 'block';
    lastData = {
      times, temps, precips, gusts, winds, dirs, codes,
      ensTemp, ensWind, ensGust, ensPrecip,
      times1h, temps1h, precips1h, gusts1h, winds1h,
      ensTemp1h, ensWind1h, ensGust1h, ensPrecip1h,
    };
    requestAnimationFrame(() => requestAnimationFrame(() => renderDisplay(lastData)));
    // Call loadRadar only when the section is not yet visible (i.e. on a fresh
    // page load restored from a dragged-pin URL).  When called from a live drag
    // the radar is already initialised and correctly positioned, so skip it.
    if (window.loadRadar) {
      const radarSection = document.getElementById('radar-section');
      if (!radarSection || radarSection.style.display !== 'flex') {
        window.loadRadar(lat, lon);
      }
    }
    lastShoreCoords = { lat, lon };
    updateShoreStatusUI();
    // DMI observations (fire-and-forget; re-renders when done)
    if (reverseCountryCode) {
      loadDmiObservations(lat, lon, reverseCountryCode).catch(() => null);
    }
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display          = 'none';
    document.getElementById('error-msg').style.display        = 'block';
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
  setQParam(displayName);
  await load(displayName, model);
}
async function tryGeolocation(model) {
  if (!navigator.geolocation) { await load('Bogø', model); return; }
  setLoadingMsg('Finding your location…');
  document.getElementById('loading').style.display         = 'block';
  document.getElementById('forecast-content').style.display = 'none';
  document.getElementById('error-msg').style.display       = 'none';
  navigator.geolocation.getCurrentPosition(
    pos => loadByCoords(pos.coords.latitude, pos.coords.longitude, model),
    _err => load('Bogø', model),
    { timeout: 8000, maximumAge: 300000 }
  );
}
async function loadAndSync(city, model) {
  setQParam(city);
  localStorage.setItem('vejr_city', city);
  await load(city, model);
}
document.getElementById('city-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) loadAndSync(v, getModel()); }
});
document.getElementById('model-select').addEventListener('change', () => {
  const v = document.getElementById('city-input').value.trim();
  if (v) loadAndSync(v, getModel());
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
    document.getElementById('city-input').value = decision.value;
    setQParam(decision.value);
    load(decision.value, model);
  }
})();
// Register service worker for PWA / offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
