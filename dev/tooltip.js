/* ══════════════════════════════════════════════════
   HOVER CROSSHAIR
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
  const obsMax  = (window.DMI_OBS?.obs)
    ? Math.max(0, ...window.DMI_OBS.obs.map(ob => (ob.wind != null && isFinite(ob.wind) ? ob.wind : 0)))
    : 0;
  const maxW    = _windAxisMax(winds1h, obsMax);
  const windVal    = winds1h[idx1h];
  const windDotY   = windVal != null ? (1 - windVal / maxW) * WIND_H : null;
  const fracX3h    = (idx3h + 0.5) / d.times.length;
  // All rows use xMap1h[idx1h] so the crosshair is at the same x in every row.
  // This prevents the visible jump that occurred when moving between rows in
  // coarse (3h/6h) display slots where fracX3h * cssW ≠ xMap1h[idx1h].
  const absX1h     = d.xMap1h ? d.xMap1h[idx1h] : fracX3h;
  const DOT_Y = { 'xh-top': null, 'xh-temp': tempDotY, 'xh-dir': null, 'xh-wind': windDotY };
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
    const x = d.xMap1h ? d.xMap1h[idx1h] : fracX3h * cssW;
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
      const t  = new Date(d.times1h ? d.times1h[idx1h] : d.times[idx3h]);
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

let _lastHoverIdx1h = null, _lastHoverIdx3h = null;

function showTooltip(idx1h, idx3h) {
  if (!lastRenderedData) return;
  _lastHoverIdx1h = idx1h;
  _lastHoverIdx3h = idx3h;
  const d = lastRenderedData;
  // Use the 1h-resolution values at the crosshair position so the pie fill
  // reflects the exact moment the crosshair points to — same scale as the
  // temp and wind values shown in the crosshair labels.
  // Fall back to the 3h display-series slot when 1h arrays are absent.
  const wind    = d.winds1h?.[idx1h] ?? d.winds?.[idx3h];
  const dir     = d.dirs1h?.[idx1h]  ?? d.dirs?.[idx3h];
  const timeStr = d.times1h?.[idx1h] ?? d.times?.[idx3h];
  if (window.onForecastHover) window.onForecastHover(dir, isKiteOptimal(wind, dir, timeStr), wind);
}

window.refireHoverIndicator = function () {
  if (_lastHoverIdx1h != null) showTooltip(_lastHoverIdx1h, _lastHoverIdx3h);
  else showCurrentTimeCrosshair();
};

function showCurrentTimeCrosshair() {
  if (!lastRenderedData) { clearCrosshairs(); return; }
  const d = lastRenderedData;
  const nowMs = Date.now();
  const times1h = d.times1h;
  const afterIdx = times1h.findIndex(t => new Date(t).getTime() > nowMs);
  let idx1h = afterIdx < 0 ? times1h.length - 1 : Math.max(0, afterIdx - 1);
  const n3h = d.times.length;
  const idx3h = d.slotIdx1h
    ? Math.min(n3h - 1, d.slotIdx1h[idx1h])
    : Math.min(n3h - 1, Math.round(idx1h * n3h / times1h.length));
  drawCrosshairs(0, idx1h, idx3h);
  showTooltip(idx1h, idx3h);
}
window.showCurrentTimeCrosshair = showCurrentTimeCrosshair;

function hideTooltip() {}

var _chartDragging = false;
function attachHoverListeners() {
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
  // No mouseleave handler — crosshair stays at last hover position.

  // Long press state — declared before contextmenu so cancelLp is available there.
  let lpStart = 0, lpX = 0, lpY = 0, lpEl = null;
  function cancelLp() { lpStart = 0; }

  // Right-click pins the crosshair at that position without the browser context menu.
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
