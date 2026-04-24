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
  // Both temp and wind charts use 1h data + xMap1h for smooth rendering.
  // Kite icons / top row / direction row snap to 3h columns (fracX3h).
  const TEMP_cssH = 130, TEMP_padT = 8, TEMP_padB = 8;
  const TEMP_ch   = TEMP_cssH - TEMP_padT - TEMP_padB;
  const validTemps = d.temps1h.filter(v => v != null);
  let tmin = Math.floor(Math.min(...validTemps) / 5) * 5;
  let tmax = Math.ceil( Math.max(...validTemps) / 5) * 5;
  if (tmax - tmin < 15) { const mid = (tmin + tmax) / 2; tmin = Math.floor((mid - 7.5) / 5) * 5; tmax = tmin + 15; }
  const tRange  = tmax - tmin;
  const tempVal = d.temps1h[idx1h];
  const tempDotY = tempVal != null ? TEMP_padT + (1 - (tempVal - tmin) / tRange) * TEMP_ch : null;
  const WIND_H  = 130;
  const winds1h = d.winds1h || d.winds;
  const ens1h   = d.ensWind1h || d.ensWind;
  const times1h = d.times1h || d.times;
  const t0Ms    = times1h.length > 0 ? new Date(times1h[0]).getTime() : 0;
  const ext7d   = t0Ms + 7 * 24 * 3600 * 1000;
  const n7d     = times1h.findIndex(t => new Date(t).getTime() >= ext7d);
  const nAx     = n7d > 0 ? n7d : winds1h.length;
  const maxW    = _windAxisMax(
    winds1h.slice(0, nAx),
    ens1h ? { p90: ens1h.p90.slice(0, nAx) } : null
  );
  const windVal    = winds1h[idx1h];
  const windDotY   = windVal != null ? (1 - windVal / maxW) * WIND_H : null;
  const fracX3h    = (idx3h + 0.5) / d.times.length;
  // xMap1h[idx1h] gives the CSS x-centre as drawn by both drawTemp and drawWind.
  const absX1h     = d.xMap1h ? d.xMap1h[idx1h] : fracX3h;
  const DOT_Y = { 'xh-top': null, 'xh-temp': tempDotY, 'xh-dir': null, 'xh-wind': windDotY };
  const FRAC  = { 'xh-top': fracX3h, 'xh-temp': null, 'xh-dir': fracX3h, 'xh-wind': null };
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
    const x = (id === 'xh-temp' || id === 'xh-wind') ? absX1h : (FRAC[id] * cssW);
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
