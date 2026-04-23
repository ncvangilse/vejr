/* ══════════════════════════════════════════════════
   CANVAS DRAWING HELPERS
══════════════════════════════════════════════════ */
function dayDivs(times) {
  const d=[];
  for(let i=1;i<times.length;i++)
    if(new Date(times[i]).getDate()!==new Date(times[i-1]).getDate()) d.push(i);
  return d;
}

function drawDayDividers(ctx, divs, n, W, H, drawLabel, times) {
  const colW = W/n;
  ctx.save();
  ctx.strokeStyle = '#667788';
  ctx.lineWidth = 1;
  divs.forEach(i => {
    const x = i * colW;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    if (drawLabel && times) {
      const segs = [0,...divs,times.length];
      // handled outside
    }
  });
  ctx.restore();
}

function resolveDPI(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

/* ══════════════════════════════════════════════════
   DRAW TOP ROW (time axis + icons + UV + wind dirs)
══════════════════════════════════════════════════ */
function drawTopRow(times, codes, precips, invertedColors, totalCssW = null) {
  const canvas = document.getElementById('c-top');
  const wrap   = canvas.parentElement;
  const n      = times.length;
  const cssW   = totalCssW != null ? totalCssW : wrap.clientWidth;
  const colW   = cssW / n;

  const ICON_H   = 36;
  const TIME_H   = 18;
  const cssH     = TIME_H + ICON_H;

  const ctx = resolveDPI(canvas, cssW, cssH);
  ctx.clearRect(0,0,cssW,cssH);
  const divs = dayDivs(times);

  // When inverted colors is active, the canvas is pre-inverted by JS so that
  // the OS double-inversion restores the drawn color. Use dark fills so the
  // result is dark after the double-inversion round-trip.
  const timeBg  = invertedColors ? '#1e2a38' : '#d8dfe8';
  const iconBg  = invertedColors ? '#1e2a38' : '#dde3eb';
  const timeSep = invertedColors ? '#3a4f62' : '#c0c8d0';
  const textDay = invertedColors ? '#c8d4e0' : '#222';
  const textHr  = invertedColors ? '#8899aa' : '#556';
  const divCol  = invertedColors ? 'rgba(255,255,255,0.18)' : '#667788';

  /* ---- time axis ---- */
  ctx.fillStyle = timeBg;
  ctx.fillRect(0, 0, cssW, TIME_H);
  ctx.strokeStyle = timeSep;
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0,TIME_H); ctx.lineTo(cssW,TIME_H); ctx.stroke();

  // 7-day threshold: slots beyond this get day-of-month labels and no dividers
  const extThreshMs = times.length > 0
    ? new Date(times[0]).getTime() + 7 * 24 * 3600 * 1000
    : Infinity;

  // day segments & names
  const segs = [0,...divs,n];
  ctx.font = `700 11px 'IBM Plex Sans', sans-serif`;
  const dayLabels = [];
  for(let s=0;s<segs.length-1;s++){
    const midX = ((segs[s]+segs[s+1])/2) * colW;
    const segDate = new Date(times[segs[s]]);
    const isExtended = segDate.getTime() >= extThreshMs;
    const name = isExtended ? DA_DAYS3[segDate.getDay()] : DA_DAYS[segDate.getDay()];
    dayLabels.push({ midX, halfW: ctx.measureText(name).width / 2 });
    ctx.fillStyle = isExtended ? (invertedColors ? '#7a8a9a' : '#778899') : textDay;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, midX, TIME_H/2);
  }

  // Hour tick marks (suppressed in extended zone where coarse slots make them misleading)
  const stepHours = times.length >= 2
    ? (new Date(times[1]).getTime() - new Date(times[0]).getTime()) / 3600000
    : 3;
  const tickEvery = stepHours <= 1 ? 3 : 6;
  times.forEach((t,i)=>{
    if (new Date(t).getTime() >= extThreshMs) return; // no ticks in extended zone
    const h = new Date(t).getHours();
    if(h===0||h%tickEvery!==0) return;
    const x = (i+0.5)*colW;
    if(dayLabels.some(dl => Math.abs(x - dl.midX) < dl.halfW + 4)) return;
    ctx.fillStyle = textHr;
    ctx.font = `10px 'IBM Plex Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(h, x, TIME_H/2);
  });

  /* ---- day dividers through time axis (first 7 days only) ---- */
  ctx.strokeStyle = divCol; ctx.lineWidth = 1;
  divs.forEach(i=>{
    if (new Date(times[i]).getTime() >= extThreshMs) return;
    const x = i*colW;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,TIME_H); ctx.stroke();
  });

  /* ---- icon row ---- */
  const iconY = TIME_H;
  ctx.fillStyle = iconBg;
  ctx.fillRect(0, iconY, cssW, ICON_H);

  // day dividers (first 7 days only)
  divs.forEach(i=>{
    if (new Date(times[i]).getTime() >= extThreshMs) return;
    const x = i*colW;
    ctx.strokeStyle=divCol; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,iconY); ctx.lineTo(x,iconY+ICON_H); ctx.stroke();
  });

  // night tint
  times.forEach((t,i)=>{
    if(isNight(t)){
      ctx.fillStyle='rgba(20,40,90,0.07)';
      ctx.fillRect(i*colW, iconY, colW, ICON_H);
    }
  });

  // icons — drawn on canvas
  // Stride is a continuous float: MIN_ICON_PX / colW, clamped to [1, 4].
  // stride=1 → one icon per slot (1h in portrait, 3h in landscape); higher
  // values skip slots smoothly as the viewport narrows.
  const MIN_ICON_PX = ICON_H * 0.65;
  const iconStride  = Math.min(4, Math.max(1, MIN_ICON_PX / colW));
  if (iconStride !== drawTopRow._lastStride) {
    drawTopRow._lastStride = iconStride;
  }

  // Walk through slots in stride-sized float steps so spacing is always even.
  // At each step, prefer a daytime slot within ±stride/2 of the ideal position
  // (falling back to the nearest slot if the whole window is nighttime).
  for (let pos = 0; pos < n; pos += iconStride) {
    const lo = Math.max(0,   Math.round(pos - iconStride / 2));
    const hi = Math.min(n-1, Math.round(pos + iconStride / 2));

    // find closest daytime slot within the window
    let best = -1, bestDist = Infinity;
    for (let j = lo; j <= hi; j++) {
      if (!isNight(times[j])) {
        const dist = Math.abs(j - pos);
        if (dist < bestDist) { bestDist = dist; best = j; }
      }
    }
    const i = best >= 0 ? best : Math.round(pos);  // fall back to nearest if all night
    if (i >= n) break;

    const c = codes[i];
    const centreX = (pos + iconStride / 2) * colW;
    dmiIcon(ctx, wmoType(c, times[i]), centreX, iconY + ICON_H/2, ICON_H, precips ? precips[i] : 0, c);
  }

  // set axis label
  document.getElementById('ax-top').textContent = '';
}

/* ══════════════════════════════════════════════════
   DRAW TEMP + PRECIP
══════════════════════════════════════════════════ */
function drawTemp(times, temps, precips, ensTemp, ensPrecip, times3h, precips3h, ensPrecip3h, invertedColors = false, totalCssW = null, xMap = null, divXs = null) {
  const canvas = document.getElementById('c-temp');
  const wrap   = canvas.parentElement;
  const n      = times.length;
  const cssW   = totalCssW != null ? totalCssW : wrap.clientWidth;
  const colW   = cssW / n;
  const cssH   = 130;
  const ctx    = resolveDPI(canvas, cssW, cssH);
  ctx.clearRect(0,0,cssW,cssH);
  if (invertedColors) {
    ctx.fillStyle = '#1e2a38';
    ctx.fillRect(0, 0, cssW, cssH);
  }
  const padT=8, padB=8, ch=cssH-padT-padB;
  let tmin=Math.floor(Math.min(...temps)/5)*5;
  let tmax=Math.ceil( Math.max(...temps)/5)*5;
  if (tmax-tmin < 15) { const mid=(tmin+tmax)/2; tmin=Math.floor((mid-7.5)/5)*5; tmax=tmin+15; }
  const tRange=tmax-tmin;
  const ty=t=>padT+(1-(t-tmin)/tRange)*ch;
  const cx2 = xMap ? (i => xMap[i]) : (i => (i + 0.5) * colW);

  // 3hr precip geometry
  const pTimes = times3h || times;
  const pPrecips = precips3h || precips;
  const pEns = ensPrecip3h || ensPrecip;
  const n3h  = pTimes.length;
  const colW3h = cssW / n3h;
  const cx2_3h = i => (i + 0.5) * colW3h;

  const levels=[]; for(let t=tmin;t<=tmax;t+=5) levels.push(t);

  // grid
  levels.forEach(t=>{
    const y=ty(t);
    ctx.strokeStyle=t===0?'#99aacc':'#c4cad2';
    ctx.lineWidth=t===0?1:0.5;
    ctx.setLineDash(t===0?[4,4]:[]);
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cssW,y); ctx.stroke();
  });
  ctx.setLineDash([]);

  // day dividers — use pre-computed display-series positions when provided (portrait)
  // so all chart rows share the same divider x regardless of curve time resolution.
  const divPositions = divXs != null
    ? divXs
    : dayDivs(times).map(i => xMap ? (xMap[i - 1] + xMap[i]) / 2 : i * colW);
  divPositions.forEach(x => {
    ctx.strokeStyle='#667788'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cssH); ctx.stroke();
  });

  // ensemble uncertainty band — drawn before precip bars and temp line
  if (ensTemp) {
    const pts90 = ensTemp.p90.map((v,i) => v != null ? {x: cx2(i), y: ty(v)} : null).filter(Boolean);
    const pts10 = ensTemp.p10.map((v,i) => v != null ? {x: cx2(i), y: ty(v)} : null).filter(Boolean);
    if (pts90.length > 1 && pts10.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts90[0].x, pts90[0].y);
      pts90.forEach(p => ctx.lineTo(p.x, p.y));
      for (let i = pts10.length - 1; i >= 0; i--) ctx.lineTo(pts10[i].x, pts10[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(180,60,20,0.18)';
      ctx.fill();
      ctx.restore();
    }
  }

  // precip bars — drawn at 3hr resolution
  const maxP = Math.max(...pPrecips, pEns ? Math.max(...pEns.p90.filter(v=>v!=null)) : 0, 2);
  const bw = colW3h * 0.55;
  const bh = (p) => Math.max(2, (p / maxP) * ch * 0.45);

  // p90 uncertainty bar
  if (pEns) {
    pEns.p90.forEach((p90val, i) => {
      if (!p90val || p90val < 0.05) return;
      ctx.fillStyle = 'rgba(100,160,255,0.30)';
      ctx.fillRect(cx2_3h(i) - bw/2, cssH - padB - bh(p90val), bw, bh(p90val));
    });
  }

  // p50 bar — light blue solid
  pPrecips.forEach((p, i) => {
    if (p < 0.05) return;
    ctx.fillStyle = '#4466aa';
    ctx.fillRect(cx2_3h(i) - bw/2, cssH - padB - bh(p), bw, bh(p));
  });

  // temp line — red above 0°C, blue below, split exactly at zero crossings
  ctx.lineWidth = 2; ctx.setLineDash([]);
  const TEMP_ABOVE = '#cc2200';
  const TEMP_BELOW = '#4488ff';
  const y0 = ty(0); // pixel y of the zero line

  for (let i = 0; i < temps.length - 1; i++) {
    const t0 = temps[i], t1 = temps[i+1];
    if (t0 == null || t1 == null) continue;
    const x0 = cx2(i),   x1 = cx2(i+1);
    const py0 = ty(t0),  py1 = ty(t1);

    if ((t0 >= 0 && t1 >= 0) || (t0 < 0 && t1 < 0)) {
      ctx.strokeStyle = t0 >= 0 ? TEMP_ABOVE : TEMP_BELOW;
      ctx.beginPath(); ctx.moveTo(x0, py0); ctx.lineTo(x1, py1); ctx.stroke();
    } else {
      // zero crossing — split at the interpolated x,y
      const frac = t0 / (t0 - t1);
      const xMid = x0 + frac * (x1 - x0);
      ctx.strokeStyle = t0 >= 0 ? TEMP_ABOVE : TEMP_BELOW;
      ctx.beginPath(); ctx.moveTo(x0, py0); ctx.lineTo(xMid, y0); ctx.stroke();
      ctx.strokeStyle = t1 >= 0 ? TEMP_ABOVE : TEMP_BELOW;
      ctx.beginPath(); ctx.moveTo(xMid, y0); ctx.lineTo(x1, py1); ctx.stroke();
    }
  }

  // temp axis labels (left)
  const ax=document.getElementById('ax-temp');
  ax.innerHTML='';
  [...levels].reverse().forEach(t=>{
    const sp=document.createElement('span');
    sp.textContent=(t>=0?'+':'')+t+'°C';
    sp.style.color=t===0?'#7799cc':'#444';
    ax.appendChild(sp);
  });

  // precip axis labels (right) — scale matches bar height mapping: maxP → ch*0.45
  const axP = document.getElementById('ax-precip');
  axP.innerHTML = '';
  // choose a round step: 1mm steps up to 5, then 2mm, then 5mm
  const pStep = maxP > 10 ? 5 : maxP > 4 ? 2 : 1;
  const pMax  = Math.ceil(maxP / pStep) * pStep;
  // precip bar top pixel for a given mm value (same formula as bar drawing)
  const py = p => cssH - padB - (p / maxP) * ch * 0.45;
  // build levels from pMax down to 0
  const pLevels = [];
  for (let p = pMax; p >= 0; p -= pStep) pLevels.push(p);
  pLevels.forEach(p => {
    const sp = document.createElement('span');
    sp.textContent = p + (p === pMax ? 'mm' : '');
    sp.style.color = '#4466aa';
    // position absolutely so it aligns with the bar scale
    sp.style.position = 'absolute';
    sp.style.top = (py(p) / cssH * 100).toFixed(1) + '%';
    sp.style.transform = 'translateY(-50%)';
    sp.style.left = '3px';
    sp.style.lineHeight = '1';
    axP.appendChild(sp);
  });
  axP.style.position = 'relative';
}

/* ══════════════════════════════════════════════════
   WINDY-STYLE WIND COLOUR HELPERS
══════════════════════════════════════════════════ */
// Custom wind colour scale: [speed m/s, r, g, b, alpha]
const WINDY_RAMP = [
  [ 0, 130, 190, 255, 0.00],  //  0 m/s → fully transparent
  [ 2, 130, 190, 255, 0.00],  //  2 m/s → still transparent
  [ 4, 100, 180, 255, 0.85],  //  4 m/s → light blue
  [ 7,  50, 200,  80, 1.00],  //  7 m/s → green
  [10, 255, 160,  20, 1.00],  // 10 m/s → orange
  [13, 220,  30,  30, 1.00],  // 13 m/s → red
  [16, 160,  30, 220, 1.00],  // 16 m/s → purple
  [19,  60,  10, 180, 1.00],  // 19 m/s → deep purple → transitioning blue
  [22,  20,  40, 160, 1.00],  // 22 m/s → dark blue
  [27, 140, 180, 240, 1.00],  // 27 m/s → light blue
  [32, 220, 235, 255, 1.00],  // 32 m/s → white-blue (extreme)
];
function windColor(ms) {
  const r = WINDY_RAMP;
  if (ms <= r[0][0]) return [r[0][1], r[0][2], r[0][3], r[0][4]];
  for (let i = 1; i < r.length; i++) {
    if (ms <= r[i][0]) {
      const t = (ms - r[i-1][0]) / (r[i][0] - r[i-1][0]);
      return [
        Math.round(r[i-1][1] + (r[i][1] - r[i-1][1]) * t),
        Math.round(r[i-1][2] + (r[i][2] - r[i-1][2]) * t),
        Math.round(r[i-1][3] + (r[i][3] - r[i-1][3]) * t),
        +(r[i-1][4]          + (r[i][4] - r[i-1][4]) * t).toFixed(3),
      ];
    }
  }
  const last = r[r.length-1]; return [last[1], last[2], last[3], last[4]];
}
// alpha param overrides the ramp alpha only when explicitly passed
function windColorStr(ms, alphaOverride) {
  const [r, g, b, a] = windColor(ms);
  const alpha = alphaOverride !== undefined ? alphaOverride : a;
  return `rgba(${r},${g},${b},${alpha})`;
}

// Compass label from degrees
function degToCompass(d){
  const pts=['N','NE','E','SE','S','SW','W','NW'];
  return pts[Math.round(d/45)%8];
}

// Draw a wind direction arrow (from-direction → going-to direction)
function drawWindArrow(ctx, cx, cy, deg, speed, size) {
  const col = windColorStr(speed, 1);
  const rad = (deg - 180) * Math.PI / 180; // arrow points in the direction the wind is GOING TO
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);

  // shaft — thicker for readability
  const shaftTop = -size * 0.18;
  const shaftBot =  size * 0.50;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1.5, size * 0.20);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, shaftBot);
  ctx.lineTo(0, shaftTop);
  ctx.stroke();

  // arrowhead — big filled triangle (wide base, long tip)
  const aw = size * 0.72;   // base width
  const ah = size * 0.58;   // height
  ctx.beginPath();
  ctx.moveTo(0,      -size * 0.18 - ah);   // tip
  ctx.lineTo(-aw/2,  -size * 0.18);         // base left
  ctx.lineTo( aw/2,  -size * 0.18);         // base right
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  ctx.restore();
}

/* ══════════════════════════════════════════════════
   KITESURFING OPTIMAL WINDOW
══════════════════════════════════════════════════ */
function isKiteDir(deg) {
  const slot = snapBearing(deg);
  return KITE_CFG.dirs.includes(slot);
}
function isKiteOptimal(speed, deg, timeStr) {
  if (KITE_CFG.daylight && isNight(timeStr)) return false;
  if (!isKiteDir(deg)) return false;
  if (speed < KITE_CFG.min || speed > KITE_CFG.max) return false;
  return true;
}
/** Direction and daylight match but speed may be outside the kite window. */
function isKiteDirOnly(deg, timeStr) {
  if (KITE_CFG.daylight && isNight(timeStr)) return false;
  if (!isKiteDir(deg)) return false;
  return true;
}

/* ══════════════════════════════════════════════════
   DRAW WIND DIRECTION ROW
══════════════════════════════════════════════════ */
function drawWindDir(times, winds, dirs, totalCssW = null) {
  const canvas = document.getElementById('c-dir');
  const wrap   = canvas.parentElement;
  const n      = times.length;
  const cssW   = totalCssW != null ? totalCssW : wrap.clientWidth;
  const colW   = cssW / n;
  // Compress row height when columns are narrow so arrows always fit snugly.
  // Arrow geometry: tip is size*0.76 above cy, shaft bottom is size*0.50 below cy → total span = size*1.26
  const arrowSize = Math.min(colW * 0.72, 22);
  const DIR_H  = Math.round(Math.max(20, arrowSize * 1.26 + 6));
  const ctx    = resolveDPI(canvas, cssW, DIR_H);
  ctx.clearRect(0, 0, cssW, DIR_H);

  // Force the DOM row to match the computed height so it compresses vertically
  wrap.style.height = DIR_H + 'px';
  wrap.parentElement.style.height = DIR_H + 'px';

  const divs  = dayDivs(times);
  const extThreshMsDir = times.length > 0
    ? new Date(times[0]).getTime() + 7 * 24 * 3600 * 1000
    : Infinity;

  // dark background
  ctx.fillStyle = '#1e2a38';
  ctx.fillRect(0, 0, cssW, DIR_H);

  // day dividers (first 7 days only — req #3)
  divs.forEach(i => {
    if (new Date(times[i]).getTime() >= extThreshMsDir) return;
    const x = i * colW;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, DIR_H); ctx.stroke();
  });

  // KITE highlight — bright teal on all columns where direction matches
  dirs.forEach((deg, i) => {
    if (!isKiteDirOnly(deg, times[i])) return;
    ctx.fillStyle = 'rgba(0,220,180,0.28)';
    ctx.fillRect(i * colW, 0, colW, DIR_H);
  });

  // arrows + compass labels
  dirs.forEach((deg, i) => {
    const cx = (i + 0.5) * colW;
    // Arrow tip is size*0.76 above cy, shaft-bottom size*0.50 below → shift cy down by the half-difference to optically centre
    const cy = DIR_H / 2 + arrowSize * 0.13;
    drawWindArrow(ctx, cx, cy, deg, winds[i], arrowSize);
  });
}

/* ══════════════════════════════════════════════════
   DRAW WIND — private helpers
══════════════════════════════════════════════════ */

/** Clamps each gust so it is always >= the corresponding mean wind. */
function _safeClampGusts(gusts, winds) {
  return gusts.map((g, i) =>
    (g != null && isFinite(g)) ? Math.max(g, winds[i]) : winds[i]
  );
}

/** Draws kite-optimal column highlights behind all chart content. */
function _drawWindKiteColumns(ctx, winds, times, dirs, colW, cY, WIND_H) {
  if (!lastData) return;
  winds.forEach((w, i) => {
    if (!isKiteOptimal(w, dirs[i], times[i])) return;
    ctx.fillStyle = 'rgba(0,220,180,0.18)';
    ctx.fillRect(i * colW, cY, colW, WIND_H);
  });
}

/** Draws horizontal speed grid lines. */
function _drawWindGrid(ctx, wLevels, wy, cssW) {
  wLevels.forEach(v => {
    ctx.strokeStyle = 'rgba(180,190,200,0.7)';
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(0, wy(v)); ctx.lineTo(cssW, wy(v)); ctx.stroke();
  });
  ctx.setLineDash([]);
}

/**
 * Builds extended p90/p10 arrays for the full-width gust ensemble band,
 * extrapolating beyond the ensemble data cutoff using the average half-spread.
 * Returns null when the band should not be drawn.
 */
function _buildExtendedGustBand(ensGust, safeGusts, winds) {
  const lastValidIdx = ensGust.p90.reduce((acc, v, i) => v != null ? i : acc, -1);
  if (lastValidIdx < 1) return null;

  let sumSpread = 0, spreadCount = 0;
  for (let i = 0; i <= lastValidIdx; i++) {
    if (ensGust.p90[i] != null && ensGust.p10[i] != null) {
      sumSpread += (ensGust.p90[i] - ensGust.p10[i]) / 2;
      spreadCount++;
    }
  }
  const avgHalfSpread = spreadCount ? sumSpread / spreadCount : 0;
  if (avgHalfSpread < 0.3) return null;  // spread not meaningful

  const allP90 = safeGusts.map((g, i) =>
    ensGust.p90[i] != null ? Math.max(ensGust.p90[i], winds[i]) : g + avgHalfSpread
  );
  const allP10 = safeGusts.map((g, i) =>
    ensGust.p10[i] != null
      ? Math.max(ensGust.p10[i], winds[i] * 0.5)
      : Math.max(g - avgHalfSpread, winds[i] * 0.5)
  );
  return { allP90, allP10 };
}

/**
 * Draws the full-width ensemble gust band, clipped so its bottom never goes
 * below the ensemble wind p90 line (falling back to deterministic wind).
 * The band is coloured by the mean gust speed using the wind colour ramp.
 */
function _drawEnsGustExtendedBand(ctx, ensGust, ensWind, safeGusts, winds, n, cx2, wy, chartTop, cssW) {
  if (!ensGust) return;
  const band = _buildExtendedGustBand(ensGust, safeGusts, winds);
  if (!band) return;
  const { allP90, allP10 } = band;

  // Bottom clip boundary: ens wind p90 where available, else deterministic wind
  const clipBottom = winds.map((w, i) =>
    (ensWind && ensWind.p90[i] != null) ? ensWind.p90[i] : w
  );

  ctx.save();
  // Clip region: from chartTop down to clipBottom, full canvas width.
  ctx.beginPath();
  ctx.moveTo(0,    chartTop);
  ctx.lineTo(cssW, chartTop);
  ctx.lineTo(cssW, wy(clipBottom[n - 1]));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(cx2(i), wy(clipBottom[i]));
  ctx.lineTo(0, wy(clipBottom[0]));
  ctx.closePath();
  ctx.clip();

  // Build a horizontal gradient coloured by the p90 gust speed (top edge of the band).
  const grad = ctx.createLinearGradient(0, 0, cssW, 0);
  allP90.forEach((g, i) => grad.addColorStop(cx2(i) / cssW, windColorStr(g, 0.2)));

  ctx.beginPath();
  ctx.moveTo(cx2(0), wy(allP90[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(cx2(i), wy(allP90[i]));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(cx2(i), wy(allP10[i]));
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
}

/**
 * Draws the ensemble wind band — completely unclipped.
 */
function _drawEnsWindBand(ctx, ensWind, cx2, wy, fillStyle) {
  if (!ensWind) return;
  const validIdxs = ensWind.p90
    .map((v, i) => (v != null && ensWind.p10[i] != null) ? i : null)
    .filter(i => i !== null);
  if (validIdxs.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(cx2(validIdxs[0]), wy(ensWind.p90[validIdxs[0]]));
  validIdxs.forEach(i => ctx.lineTo(cx2(i), wy(ensWind.p90[i])));
  for (let k = validIdxs.length - 1; k >= 0; k--) ctx.lineTo(cx2(validIdxs[k]), wy(ensWind.p10[validIdxs[k]]));
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/** Draws a simple polyline over a series of values. */
function _drawWindLine(ctx, values, cx2, wy, strokeStyle, lineWidth) {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth   = lineWidth;
  ctx.setLineDash([]);
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v == null) { started = false; return; }
    if (!started) { ctx.moveTo(cx2(i), wy(v)); started = true; }
    else ctx.lineTo(cx2(i), wy(v));
  });
  ctx.stroke();
}

/** Draws kite pill badges in the reserved top strip. */
function _drawKiteIcons(ctx, winds, times, dirs, cx2, cY, KITE_H) {
  if (!lastData) return;
  const ICON_SIZE = 14;
  const PILL_H    = KITE_H - 4;
  const PILL_W    = PILL_H + 4;
  const PILL_Y    = cY + 2;
  const iconCY    = PILL_Y + PILL_H / 2;

  ctx.font         = `${ICON_SIZE}px sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  winds.forEach((w, i) => {
    if (!isKiteOptimal(w, dirs[i], times[i])) return;
    const x  = cx2(i);
    const px = x - PILL_W / 2;
    const r  = PILL_H / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0,180,140,0.82)';
    ctx.beginPath();
    ctx.moveTo(px + r, PILL_Y);
    ctx.arcTo(px + PILL_W, PILL_Y,          px + PILL_W, PILL_Y + PILL_H, r);
    ctx.arcTo(px + PILL_W, PILL_Y + PILL_H, px,          PILL_Y + PILL_H, r);
    ctx.arcTo(px,          PILL_Y + PILL_H, px,          PILL_Y,          r);
    ctx.arcTo(px,          PILL_Y,          px + PILL_W, PILL_Y,          r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillText('🪁', x, iconCY);
  });
}

/** Populates the wind axis element with speed ticks coloured by the wind ramp.
 *  Labels are positioned absolutely so they align with the canvas grid lines.
 *  @param {number[]} wLevels  - speed values at which grid lines are drawn
 *  @param {function} wy       - same mapping function used by the canvas: v → pixel y
 *  @param {number}   WIND_H   - total canvas CSS height (used to convert px → %)
 */
function _drawWindAxisLabels(wLevels, wy, WIND_H) {
  const ax = document.getElementById('ax-wind');
  ax.innerHTML = '';
  ax.style.position = 'relative';
  ax.style.display  = 'block';   // replace flex so absolute children work

  wLevels.forEach(v => {
    const sp = document.createElement('span');
    sp.textContent      = v;
    sp.style.color      = windColorStr(v, 1);
    sp.style.fontWeight = '600';
    if (v === KITE_CFG.max || v === KITE_CFG.min) {
      sp.style.color = '#00c8a0';
      sp.title = v === KITE_CFG.max ? `Kite max ${KITE_CFG.max} m/s` : `Kite min ${KITE_CFG.min} m/s`;
    }
    sp.style.position   = 'absolute';
    sp.style.right      = '3px';
    sp.style.top        = (wy(v) / WIND_H * 100).toFixed(2) + '%';
    sp.style.transform  = 'translateY(-50%)';
    sp.style.lineHeight = '1';
    ax.appendChild(sp);
  });
}

/* ══════════════════════════════════════════════════
   DRAW WIND  (Windy-style)
══════════════════════════════════════════════════ */
// times/gusts/winds are the display series (variable-res in portrait, 1h in landscape);
// dirs / times3h / winds3h are used for kite highlights & pills.
// otherModelsWind  – [{model, winds1h}] array drawn as faint comparison lines.
// otherModelsXMap  – parallel x-position array for otherModelsWind (portrait 1h→display grid);
//                   when null, lines are drawn at their array index using cx2().

/**
 * Stroke colour used for non-selected model comparison lines.
 * Dark on light background (normal mode) / light on dark background (inverted mode)
 * so lines remain visible in both colour schemes without dominating the chart.
 */
function _otherModelLineColor(invertedColors) {
  return invertedColors ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)';
}

/** Returns the wind Y-axis maximum: max ensemble wind p90 (or mean wind when no ensemble) rounded up to nearest 5 m/s. Gusts are clipped above this. */
function _windAxisMax(winds, ensWind) {
  const base = ensWind
    ? Math.max(...ensWind.p90.filter(v => v != null))
    : Math.max(...winds.filter(v => v != null));
  return Math.ceil(Math.max(base, 5) / 5) * 5;
}
function drawWind(times, gusts, winds, dirs, ensWind, ensGust, times3h, winds3h, invertedColors, totalCssW = null, xMap = null, otherModelsWind = null, otherModelsXMap = null) {
  // --- canvas setup ---
  const canvas = document.getElementById('c-wind');
  const n      = times.length;
  const cssW   = totalCssW != null ? totalCssW : canvas.parentElement.clientWidth;
  const colW   = cssW / n;
  const WIND_H = 130;
  const ctx    = resolveDPI(canvas, cssW, WIND_H);
  ctx.clearRect(0, 0, cssW, WIND_H);
  const divs = dayDivs(times);
  const extThreshMsWind = times.length > 0
    ? new Date(times[0]).getTime() + 7 * 24 * 3600 * 1000
    : Infinity;
  const cx2  = xMap ? (i => xMap[i]) : (i => (i + 0.5) * colW);

  // 3hr kite data (dirs align with times3h)
  const n3h    = (times3h || times).length;
  const colW3h = cssW / n3h;
  const cx2_3h = i => (i + 0.5) * colW3h;
  const kiteWinds = winds3h || winds;
  const kiteTimes = times3h || times;

  // --- scale ---
  const safeGusts = _safeClampGusts(gusts, winds);
  const cY        = 0;
  const KITE_H    = 24;                   // reserved strip for kite pill icons
  const padT      = KITE_H + 4;
  const chartH    = WIND_H - padT;
  const maxW      = _windAxisMax(winds, ensWind);
  const wy        = v => cY + padT + (1 - v / maxW) * chartH;
  const base      = wy(0);
  const wLevels   = []; for (let v = 0; v <= maxW; v += 5) wLevels.push(v);

  // --- background ---
  ctx.fillStyle = invertedColors ? '#1e2a38' : '#dde3eb';
  ctx.fillRect(0, cY, cssW, WIND_H);

  // --- kite column highlights (behind everything) — drawn at 3hr width ---
  if (lastData) {
    kiteWinds.forEach((w, i) => {
      if (!isKiteOptimal(w, dirs[i], kiteTimes[i])) return;
      ctx.fillStyle = 'rgba(0,220,180,0.18)';
      ctx.fillRect(i * colW3h, cY, colW3h, WIND_H);
    });
  }

  // --- grid & day dividers (first 7 days only — req #3) ---
  _drawWindGrid(ctx, wLevels, wy, cssW);
  divs.forEach(i => {
    if (new Date(times[i]).getTime() >= extThreshMsWind) return;
    const x = xMap ? (xMap[i - 1] + xMap[i]) / 2 : i * colW;
    ctx.strokeStyle = '#667788'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, cY); ctx.lineTo(x, cY + WIND_H); ctx.stroke();
  });

  // --- ensemble gust band (clipped above ens-wind p90) ---
  _drawEnsGustExtendedBand(ctx, ensGust, ensWind, safeGusts, winds, n, cx2, wy, cY + padT, cssW);

  // --- ensemble wind band (unclipped) ---
  _drawEnsWindBand(ctx, ensWind, cx2, wy, 'rgba(0,0,0,0.22)');


  // --- wind fill (colour-mapped gradient below wind line) ---
  // Only fill up to the last non-null wind value; null entries (unavailable
  // model data) are left blank rather than drawn as flat zero.
  const lastNonNull = (() => { for (let i = n - 1; i >= 0; i--) if (winds[i] != null) return i; return -1; })();
  if (n > 1 && lastNonNull > 0) {
    const grad = ctx.createLinearGradient(0, 0, cssW, 0);
    winds.forEach((v, i) => { if (v != null) grad.addColorStop(cx2(i) / cssW, windColorStr(v, 0.72)); });
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx2(0), wy(winds[0] ?? 0));
    for (let i = 1; i <= lastNonNull; i++) ctx.lineTo(cx2(i), wy(winds[i] ?? winds[i - 1] ?? 0));
    ctx.lineTo(cx2(lastNonNull), base);
    ctx.lineTo(cx2(0), base);
    ctx.closePath();
    ctx.fill();
  }

  // --- other model wind lines (drawn on top of the fill, below the main line) ---
  // All non-selected models share a single dark (light mode) or light (dark mode)
  // semi-transparent stroke so they read as background context without competing
  // with the selected model's prominent coloured line.
  // otherModelsXMap provides per-point x-positions (portrait 1h→display grid);
  // when absent the standard cx2() mapping is used.
  if (otherModelsWind && otherModelsWind.length) {
    ctx.save();
    otherModelsWind.forEach(({ winds1h: omWinds }) => {
      if (!omWinds || omWinds.length < 2) return;
      ctx.strokeStyle = _otherModelLineColor(invertedColors);
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < omWinds.length; i++) {
        const v = omWinds[i];
        if (v == null) { started = false; continue; }
        const x = otherModelsXMap ? otherModelsXMap[i] : cx2(i);
        const y = wy(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  // --- wind line ---
  _drawWindLine(ctx, winds, cx2, wy, 'rgba(255,255,255,0.95)', 2);

  // --- kite pill icons (top strip) — drawn at 3hr positions ---
  if (lastData) {
    const ICON_SIZE = 14;
    const PILL_H    = KITE_H - 4;
    const PILL_W    = PILL_H + 4;
    const PILL_Y    = cY + 2;
    const iconCY    = PILL_Y + PILL_H / 2;
    ctx.font         = `${ICON_SIZE}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    kiteWinds.forEach((w, i) => {
      if (!isKiteOptimal(w, dirs[i], kiteTimes[i])) return;
      const x  = cx2_3h(i);
      const px = x - PILL_W / 2;
      const r  = PILL_H / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(0,180,140,0.82)';
      ctx.beginPath();
      ctx.moveTo(px + r, PILL_Y);
      ctx.arcTo(px + PILL_W, PILL_Y,          px + PILL_W, PILL_Y + PILL_H, r);
      ctx.arcTo(px + PILL_W, PILL_Y + PILL_H, px,          PILL_Y + PILL_H, r);
      ctx.arcTo(px,          PILL_Y + PILL_H, px,          PILL_Y,          r);
      ctx.arcTo(px,          PILL_Y,          px + PILL_W, PILL_Y,          r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.fillText('🪁', x, iconCY);
    });
  }

  // --- DMI observed wind dots ---
  // Yellow dots  = 10-min mean wind speed from the nearest DMI station.
  // Orange dots  = 10-min gust (wind_gust_always_10min) — faint, drawn first so
  //                the wind dots appear on top.
  // x-mapping: slot-aware position so portrait variable-resolution slots align.
  if (window.DMI_OBS && window.DMI_OBS.obs && window.DMI_OBS.obs.length) {
    const displayMs = times.map(t => new Date(t).getTime());
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, cY + padT, cssW, chartH);
    ctx.clip();
    for (const ob of window.DMI_OBS.obs) {
      // Find which display slot ob.t falls into and compute the fractional offset
      // within that slot.  For 1-hour uniform slots this reduces to (fracH+0.5)*colW.
      let j = 0;
      while (j < displayMs.length - 1 && displayMs[j + 1] <= ob.t) j++;
      const slotDur = j < displayMs.length - 1
        ? displayMs[j + 1] - displayMs[j]
        : (j > 0 ? displayMs[j] - displayMs[j - 1] : 3600000);
      const slotFrac = (ob.t - displayMs[j]) / slotDur;
      const x = (j + slotFrac + 0.5) * colW;
      if (x < -8 || x > cssW + 8) continue;
      // gust dot (faint orange — drawn first so wind dot appears on top)
      if (ob.gust != null && isFinite(ob.gust)) {
        ctx.beginPath();
        ctx.arc(x, wy(ob.gust), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,150,50,0.65)';
        ctx.fill();
      }
      // wind dot (yellow, slightly larger and more opaque)
      if (ob.wind != null && isFinite(ob.wind)) {
        ctx.beginPath();
        ctx.arc(x, wy(ob.wind), 2.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,240,80,0.9)';
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 0.5;
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // --- axis labels ---
  _drawWindAxisLabels(wLevels, wy, WIND_H);
}

/* ══════════════════════════════════════════════════
   RENDER ALL
══════════════════════════════════════════════════ */
function renderAll(d, invertedColors, portraitColW = null) {
  // In portrait mode anchor the canvas width to the DISPLAY series slot count
  // (N_display × portraitColW) and draw curves at that same resolution so the
  // graph time zoom matches the icon row.  In landscape use full 1h curves.
  const portrait = portraitColW != null;
  const totalCssW = portrait ? d.times.length * portraitColW : null;
  // Pre-compute day-divider pixel positions from the display series so every
  // chart row (icon row, temp, wind) places its divider at exactly the same x.
  const extThreshMsAll = d.times.length > 0
    ? new Date(d.times[0]).getTime() + 7 * 24 * 3600 * 1000
    : Infinity;
  const divXs = portrait ? dayDivs(d.times)
    .filter(i => new Date(d.times[i]).getTime() < extThreshMsAll)
    .map(i => i * portraitColW) : null;

  drawTopRow(d.times, d.codes, d.precips, invertedColors, totalCssW);
  drawWindDir(d.times, d.winds, d.dirs, totalCssW);
  if (portrait) {
    // Portrait: temp curve uses 1h data + xMap1h for smooth rendering across
    // the variable-resolution display grid. Precip bars use the display series.
    // divXs ensures day dividers align with the icon row regardless of curve resolution.
    drawTemp(d.times1h, d.temps1h, d.precips1h, d.ensTemp1h || null, d.ensPrecip1h || null,
             d.times, d.precips, d.ensPrecip || null, invertedColors, totalCssW, d.xMap1h || null, divXs);
    drawWind(d.times, d.gusts, d.winds, d.dirs, d.ensWind || null, d.ensGust || null,
             null, null, invertedColors, totalCssW, null,
             d.otherModelsWind1h || null, d.xMap1h || null);
  } else {
    // Landscape: smooth 1h curves with display-series for precip bars / kite highlights.
    drawTemp(d.times1h, d.temps1h, d.precips1h, d.ensTemp1h || null, d.ensPrecip1h || null,
             d.times, d.precips, d.ensPrecip || null, invertedColors, totalCssW, null);
    drawWind(d.times1h, d.gusts1h, d.winds1h, d.dirs, d.ensWind1h || null, d.ensGust1h || null,
             d.times, d.winds, invertedColors, totalCssW, null,
             d.otherModelsWind1h || null, null);
  }
}

