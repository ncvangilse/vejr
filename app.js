/* ══════════════════════════════════════════════════
   MAIN APP — load, tooltip, kite dialog, URL sync
══════════════════════════════════════════════════ */
let lastData = null;
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
    requestAnimationFrame(() => requestAnimationFrame(() => renderAll(lastData)));
    // Load RainViewer radar centred on the selected city
    if (window.loadRadar) window.loadRadar(loc.latitude, loc.longitude);
    // Shore mask analysis (fire-and-forget; re-renders when done)
    if (window.analyseShore) {
      window.analyseShore(loc.latitude, loc.longitude, () => {
        updateShoreStatusUI();
        if (lastData) renderAll(lastData);
        if (window.refreshShoreCompassInModal) window.refreshShoreCompassInModal();
      });
    }
  } catch(e) {
    console.error(e);
    document.getElementById('loading').style.display='none';
    document.getElementById('error-msg').style.display='block';
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
  if (!lastData) return;
  const d = lastData;
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
  if (!lastData) return;
  const d = lastData;
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
  const content = document.getElementById('forecast-content');
  content.addEventListener('mousemove', e => {
    if (!lastData) return;
    const wrap = e.target.closest('.chart-canvas-wrap');
    if (!wrap) { hideTooltip(); return; }
    const rect     = wrap.getBoundingClientRect();
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const relX     = portrait ? (e.clientY - rect.top) : (e.clientX - rect.left);
    const span     = portrait ? rect.height : rect.width;
    const fracX    = Math.max(0, Math.min(1, relX / span));
    const n1h      = lastData.times1h.length;
    const n3h      = lastData.times.length;
    const idx1h    = Math.min(n1h - 1, Math.floor(fracX * n1h));
    const idx3h    = Math.min(n3h - 1, Math.floor(fracX * n3h));
    drawCrosshairs(fracX, idx1h, idx3h);
    showTooltip(idx1h, idx3h);
  });
  content.addEventListener('mouseleave', hideTooltip);
}
attachHoverListeners();
function getModel() { return document.getElementById('model-select').value; }
/* ══════════════════════════════════════════════════
   SHORE STATUS UI
══════════════════════════════════════════════════ */
function updateShoreStatusUI() {
  const el = document.getElementById('shore-status');
  if (!el) return;
  const s = window.SHORE_STATUS || { state: 'idle', msg: '' };
  if (s.state === 'loading') {
    el.textContent = '🌊 Fetching coastline…';
    el.style.color = '#778';
  } else if (s.state === 'calculating') {
    el.textContent = '🌊 Calculating sea bearings…';
    el.style.color = '#778';
  } else if (s.state === 'ok') {
    const seaCount = window.SHORE_MASK
      ? Array.from(window.SHORE_MASK).filter(v => v >= 0.5).length : 0;
    el.textContent = `🌊 ${seaCount} sea bearings`;
    el.style.color = seaCount > 0 ? '#00c890' : '#aa8844';
  } else if (s.state === 'inland') {
    el.textContent = '🏔 Inland (no coast)';
    el.style.color = '#aa8844';
  } else if (s.state === 'error') {
    el.textContent = '🌊 Shore: unavailable';
    el.style.color = '#a77';
  } else {
    el.textContent = '';
  }
}

/* ══════════════════════════════════════════════════
   KITE CONFIG DIALOG
══════════════════════════════════════════════════ */
(function () {
  const overlay       = document.getElementById('kite-modal-overlay');
  const minInput      = document.getElementById('kite-min-input');
  const maxInput      = document.getElementById('kite-max-input');
  const tolInput      = document.getElementById('kite-tol-input');
  const daylightInput = document.getElementById('kite-at-night-input');
  const dirGrid       = document.getElementById('kite-dir-grid');
  const applyBtn      = document.getElementById('kite-modal-apply');
  const cancelBtn     = document.getElementById('kite-modal-cancel');
  const resetBtn      = document.getElementById('kite-modal-reset');
  const cfgBtn        = document.getElementById('kite-cfg-btn');

  DIR_PRESETS.forEach(({ label, deg }) => {
    const btn = document.createElement('button');
    btn.className   = 'kite-dir-btn';
    btn.dataset.deg = deg;
    btn.textContent = label;
    btn.addEventListener('click', () => { btn.classList.toggle('active'); drawModalCompass(); });
    dirGrid.appendChild(btn);
  });

  function syncDialogToConfig(cfg) {
    minInput.value        = cfg.min;
    maxInput.value        = cfg.max;
    tolInput.value        = cfg.tol;
    daylightInput.checked = !cfg.daylight;
    dirGrid.querySelectorAll('.kite-dir-btn').forEach(btn => {
      btn.classList.toggle('active', cfg.dirs.includes(+btn.dataset.deg));
    });
  }
  function readDialogConfig() {
    const dirs = [...dirGrid.querySelectorAll('.kite-dir-btn.active')].map(b => +b.dataset.deg);
    return {
      min:      parseFloat(minInput.value) || KITE_DEFAULTS.min,
      max:      parseFloat(maxInput.value) || KITE_DEFAULTS.max,
      dirs:     dirs.length ? dirs : KITE_DEFAULTS.dirs,
      tol:      parseFloat(tolInput.value) ?? KITE_DEFAULTS.tol,
      daylight: !daylightInput.checked,
    };
  }

  // ── Shore compass in modal ──
  function drawModalCompass() {
    const canvas = document.getElementById('shore-compass-canvas');
    if (!canvas || !window.drawShoreCompass) return;
    const SIZE = canvas.clientWidth || 180;
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width  = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Overlay the currently selected direction buttons
    const activeDirs = [...dirGrid.querySelectorAll('.kite-dir-btn.active')].map(b => +b.dataset.deg);
    const tol = parseFloat(tolInput.value) ?? KITE_DEFAULTS.tol;

    // Current wind direction (from lastData if available)
    let windDeg = null, windGood = false;
    if (lastData && lastData.dirs && lastData.dirs.length) {
      // Use the first future hour's direction as representative
      const now  = Date.now();
      const idx  = lastData.times.findIndex(t => new Date(t).getTime() >= now);
      const i    = idx >= 0 ? idx : 0;
      windDeg    = lastData.dirs[i];
      windGood   = lastData.winds && isKiteOptimal(lastData.winds[i], windDeg, lastData.times[i]);
    }

    window.drawShoreCompass(ctx, SIZE / 2, SIZE / 2, SIZE / 2 - 2,
      window.SHORE_MASK, windDeg, windGood);

    // Overlay selected direction arcs
    if (activeDirs.length) {
      const DEG2RAD = Math.PI / 180;
      activeDirs.forEach(d => {
        const startA = (d - tol - 90) * DEG2RAD;
        const endA   = (d + tol - 90) * DEG2RAD;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(SIZE / 2, SIZE / 2);
        ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, startA, endA);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(0,232,176,0.7)';
        ctx.lineWidth   = 2;
        ctx.stroke();
        ctx.restore();
      });
    }
  }

  window.refreshShoreCompassInModal = function() {
    if (overlay.classList.contains('open')) drawModalCompass();
    updateShoreStatusUI();
  };

  cfgBtn.addEventListener('click', () => {
    syncDialogToConfig(KITE_CFG);
    overlay.classList.add('open');
    requestAnimationFrame(drawModalCompass);
  });
  cancelBtn.addEventListener('click', () => overlay.classList.remove('open'));
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  resetBtn.addEventListener('click', () => { syncDialogToConfig(KITE_DEFAULTS); drawModalCompass(); });
  applyBtn.addEventListener('click', () => {
    const cfg = readDialogConfig();
    setKiteParams(cfg);
    overlay.classList.remove('open');
    if (lastData) renderAll(lastData);
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
  await load(city, model);
}
document.getElementById('search-btn').addEventListener('click', () => {
  const v = document.getElementById('city-input').value.trim();
  if (v) loadAndSync(v, getModel());
});
document.getElementById('city-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('search-btn').click();
});
document.getElementById('model-select').addEventListener('change', () => {
  const v = document.getElementById('city-input').value.trim();
  if (v) loadAndSync(v, getModel());
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastData) renderAll(lastData); }, 100);
});
// ── Initial load ──────────────────────────────────────────────────────────
(function initialLoad() {
  const model  = getModel();
  const qParam = getQParam();
  if (qParam) {
    document.getElementById('city-input').value = qParam;
    load(qParam, model);
  } else {
    const typed = document.getElementById('city-input').value.trim();
    if (typed) { setQParam(typed); load(typed, model); }
    else        { tryGeolocation(model); }
  }
})();
// Register service worker for PWA / offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
