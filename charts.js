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
function drawTopRow(times, codes, precips) {
  const canvas = document.getElementById('c-top');
  const wrap   = canvas.parentElement;
  const cssW   = wrap.clientWidth;
  const n      = times.length;

  const ICON_H   = 36;
  const TIME_H   = 18;
  const cssH     = TIME_H + ICON_H;

  const ctx = resolveDPI(canvas, cssW, cssH);
  ctx.clearRect(0,0,cssW,cssH);

  const colW = cssW / n;
  const divs = dayDivs(times);

  /* ---- time axis ---- */
  ctx.fillStyle = '#d8dfe8';
  ctx.fillRect(0, 0, cssW, TIME_H);
  ctx.strokeStyle = '#c0c8d0';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0,TIME_H); ctx.lineTo(cssW,TIME_H); ctx.stroke();

  // day segments & names
  const segs = [0,...divs,n];
  for(let s=0;s<segs.length-1;s++){
    const midX = ((segs[s]+segs[s+1])/2) * colW;
    ctx.fillStyle = '#222';
    ctx.font = `700 11px 'IBM Plex Sans', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(DA_DAYS[new Date(times[segs[s]]).getDay()], midX, TIME_H/2);
  }

  // hour ticks 6,12,18
  times.forEach((t,i)=>{
    const h = new Date(t).getHours();
    if(h===0||h%6!==0) return;
    const x = (i+0.5)*colW;
    ctx.fillStyle = '#556';
    ctx.font = `10px 'IBM Plex Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(h, x, TIME_H/2);
  });

  /* ---- day dividers through time axis ---- */
  ctx.strokeStyle = '#667788'; ctx.lineWidth = 1;
  divs.forEach(i=>{
    const x = i*colW;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,TIME_H); ctx.stroke();
  });

  /* ---- icon row ---- */
  const iconY = TIME_H;
  ctx.fillStyle = '#dde3eb';
  ctx.fillRect(0, iconY, cssW, ICON_H);

  // day dividers
  divs.forEach(i=>{
    const x = i*colW;
    ctx.strokeStyle='#667788'; ctx.lineWidth=1;
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
  codes.forEach((c,i)=>{
    dmiIcon(ctx, wmoType(c, times[i]), (i+0.5)*colW, iconY + ICON_H/2, ICON_H, precips ? precips[i] : 0, c);
  });

  // set axis label
  document.getElementById('ax-top').textContent = '';
}

/* ══════════════════════════════════════════════════
   DRAW TEMP + PRECIP
══════════════════════════════════════════════════ */
function drawTemp(times, temps, precips, ensTemp, ensPrecip) {
  const canvas = document.getElementById('c-temp');
  const wrap   = canvas.parentElement;
  const cssW   = wrap.clientWidth;
  const cssH   = 130;
  const ctx    = resolveDPI(canvas, cssW, cssH);
  ctx.clearRect(0,0,cssW,cssH);

  const n = times.length;
  const colW = cssW / n;
  const padT=8, padB=8, ch=cssH-padT-padB;
  let tmin=Math.floor(Math.min(...temps)/5)*5;
  let tmax=Math.ceil( Math.max(...temps)/5)*5;
  if (tmax-tmin < 15) { const mid=(tmin+tmax)/2; tmin=Math.floor((mid-7.5)/5)*5; tmax=tmin+15; }
  const tRange=tmax-tmin;
  const ty=t=>padT+(1-(t-tmin)/tRange)*ch;
  const cx2=i=>(i+0.5)*colW;

  const divs=dayDivs(times);
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

  // day dividers
  divs.forEach(i=>{
    const x=i*colW;
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

  // precip bars
  const maxP = Math.max(...precips, ensPrecip ? Math.max(...ensPrecip.p90.filter(v=>v!=null)) : 0, 2);
  const bw = colW * 0.55;
  const bh = (p) => Math.max(2, (p / maxP) * ch * 0.45);

  // p90 uncertainty bar — same width as p50 bar, very light blue, behind p50 bar
  if (ensPrecip) {
    ensPrecip.p90.forEach((p90val, i) => {
      if (!p90val || p90val < 0.05) return;
      ctx.fillStyle = 'rgba(100,160,255,0.30)';
      ctx.fillRect(cx2(i) - bw/2, cssH - padB - bh(p90val), bw, bh(p90val));
    });
  }

  // p50 bar — light blue solid
  precips.forEach((p, i) => {
    if (p < 0.05) return;
    ctx.fillStyle = '#4466aa';
    ctx.fillRect(cx2(i) - bw/2, cssH - padB - bh(p), bw, bh(p));
  });

  // temp line — red above 0°C, blue below, split exactly at zero crossings
  ctx.lineWidth = 2; ctx.setLineDash([]);
  const TEMP_ABOVE = '#cc2200';
  const TEMP_BELOW = '#4488ff';
  const y0 = ty(0); // pixel y of the zero line

  for (let i = 0; i < temps.length - 1; i++) {
    const t0 = temps[i], t1 = temps[i+1];
    const x0 = cx2(i),   x1 = cx2(i+1);
    const py0 = ty(t0),  py1 = ty(t1);

    if ((t0 >= 0 && t1 >= 0) || (t0 < 0 && t1 < 0)) {
      // no crossing — single colour
      ctx.strokeStyle = t0 >= 0 ? TEMP_ABOVE : TEMP_BELOW;
      ctx.beginPath(); ctx.moveTo(x0, py0); ctx.lineTo(x1, py1); ctx.stroke();
    } else {
      // zero crossing — split at the interpolated x,y
      const frac = t0 / (t0 - t1);           // fraction along segment where temp=0
      const xMid = x0 + frac * (x1 - x0);

      // first half
      ctx.strokeStyle = t0 >= 0 ? TEMP_ABOVE : TEMP_BELOW;
      ctx.beginPath(); ctx.moveTo(x0, py0); ctx.lineTo(xMid, y0); ctx.stroke();
      // second half
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
  [30, 120,   0, 180, 1.00],  // 30 m/s → deep purple (extreme)
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
  const d = ((deg % 360) + 360) % 360;
  return KITE_CFG.dirs.some(centre => {
    const diff = Math.abs(((d - centre + 540) % 360) - 180);
    return diff <= KITE_CFG.tol;
  });
}
function isKiteOptimal(speed, deg, timeStr) {
  if (KITE_CFG.daylight && isNight(timeStr)) return false;
  return speed >= KITE_CFG.min && speed <= KITE_CFG.max && isKiteDir(deg);
}

/* ══════════════════════════════════════════════════
   DRAW WIND DIRECTION ROW
══════════════════════════════════════════════════ */
function drawWindDir(times, winds, dirs) {
  const canvas = document.getElementById('c-dir');
  const wrap   = canvas.parentElement;
  const cssW   = wrap.clientWidth;
  const DIR_H  = 46;
  const ctx    = resolveDPI(canvas, cssW, DIR_H);
  ctx.clearRect(0, 0, cssW, DIR_H);

  const n     = times.length;
  const colW  = cssW / n;
  const divs  = dayDivs(times);

  // dark background
  ctx.fillStyle = '#1e2a38';
  ctx.fillRect(0, 0, cssW, DIR_H);

  // day dividers
  divs.forEach(i => {
    const x = i * colW;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, DIR_H); ctx.stroke();
  });

  // KITE highlight — teal glow on columns where speed AND direction are optimal AND daylight
  dirs.forEach((deg, i) => {
    if (!isKiteOptimal(winds[i], deg, times[i])) return;
    ctx.fillStyle = 'rgba(0,220,180,0.28)';
    ctx.fillRect(i * colW, 0, colW, DIR_H);
  });

  // arrows + compass labels
  const arrowSize = Math.min(colW * 0.72, 22);
  dirs.forEach((deg, i) => {
    const cx = (i + 0.5) * colW;
    const cy = DIR_H / 2 - 3;
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
 * Draws the full-width ensemble gust band, clipped to the gust fill area
 * so it never spills above the gust line.
 */
function _drawEnsGustExtendedBand(ctx, ensGust, safeGusts, winds, n, cx2, wy, chartTop) {
  if (!ensGust) return;
  const band = _buildExtendedGustBand(ensGust, safeGusts, winds);
  if (!band) return;
  const { allP90, allP10 } = band;

  ctx.save();
  // Clip to the area between the wind line and the top of the chart,
  // so the band can freely extend above the gust line.
  ctx.beginPath();
  ctx.moveTo(cx2(0), chartTop);
  ctx.lineTo(cx2(n - 1), chartTop);
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(cx2(i), wy(winds[i]));
  ctx.closePath();
  ctx.clip();

  ctx.beginPath();
  ctx.moveTo(cx2(0), wy(allP90[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(cx2(i), wy(allP90[i]));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(cx2(i), wy(allP10[i]));
  ctx.closePath();
  ctx.fillStyle = 'rgba(180,100,20,0.22)';
  ctx.fill();
  ctx.restore();
}

/** Draws the coloured gust-gap polygon (strip between gust line and wind line). */
function _drawGustGapFill(ctx, safeGusts, winds, n, cssW, cx2, wy) {
  const grad = n > 1 ? ctx.createLinearGradient(0, 0, cssW, 0) : null;
  if (grad) safeGusts.forEach((g, i) => grad.addColorStop(i / (n - 1), windColorStr(g, 0.45)));
  ctx.fillStyle = grad || windColorStr(safeGusts[0], 0.45);
  ctx.beginPath();
  ctx.moveTo(cx2(0), wy(safeGusts[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(cx2(i), wy(safeGusts[i]));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(cx2(i), wy(winds[i]));
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws a percentile uncertainty band for an ensemble series, clipped to a
 * polygon defined by clipPts (array of {x, y}).
 */
function _drawEnsBand(ctx, ens, cx2, wy, clipPts, fillStyle) {
  if (!ens) return;
  const validIdxs = ens.p90
    .map((v, i) => (v != null && ens.p10[i] != null) ? i : null)
    .filter(i => i !== null);
  if (validIdxs.length < 2) return;

  ctx.save();
  ctx.beginPath();
  clipPts.forEach(({ x, y }, k) => k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.closePath();
  ctx.clip();

  ctx.beginPath();
  ctx.moveTo(cx2(validIdxs[0]), wy(ens.p90[validIdxs[0]]));
  validIdxs.forEach(i => ctx.lineTo(cx2(i), wy(ens.p90[i])));
  for (let k = validIdxs.length - 1; k >= 0; k--) ctx.lineTo(cx2(validIdxs[k]), wy(ens.p10[validIdxs[k]]));
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  ctx.restore();
}

/** Draws a simple polyline over a series of values. */
function _drawWindLine(ctx, values, cx2, wy, strokeStyle, lineWidth) {
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth   = lineWidth;
  ctx.setLineDash([]);
  ctx.beginPath();
  values.forEach((v, i) => i === 0 ? ctx.moveTo(cx2(i), wy(v)) : ctx.lineTo(cx2(i), wy(v)));
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

/** Populates the wind axis element with speed ticks coloured by the wind ramp. */
function _drawWindAxisLabels(wLevels) {
  const ax = document.getElementById('ax-wind');
  ax.innerHTML = '';
  [...wLevels].reverse().forEach(v => {
    const sp = document.createElement('span');
    sp.textContent      = v;
    sp.style.color      = windColorStr(v, 1);
    sp.style.fontWeight = '600';
    if (v === KITE_CFG.max || v === KITE_CFG.min) {
      sp.style.color = '#00c8a0';
      sp.title = v === KITE_CFG.max ? `Kite max ${KITE_CFG.max} m/s` : `Kite min ${KITE_CFG.min} m/s`;
    }
    ax.appendChild(sp);
  });
}

/* ══════════════════════════════════════════════════
   DRAW WIND  (Windy-style)
══════════════════════════════════════════════════ */
function drawWind(times, gusts, winds, dirs, ensWind, ensGust) {
  // --- canvas setup ---
  const canvas = document.getElementById('c-wind');
  const cssW   = canvas.parentElement.clientWidth;
  const WIND_H = 130;
  const ctx    = resolveDPI(canvas, cssW, WIND_H);
  ctx.clearRect(0, 0, cssW, WIND_H);

  const n    = times.length;
  const colW = cssW / n;
  const divs = dayDivs(times);
  const cx2  = i => (i + 0.5) * colW;

  // --- scale ---
  const safeGusts = _safeClampGusts(gusts, winds);
  const cY        = 0;
  const KITE_H    = 24;                   // reserved strip for kite pill icons
  const padT      = KITE_H + 4;
  const chartH    = WIND_H - padT;
  const maxW      = Math.ceil(Math.max(...safeGusts, 5) / 5) * 5;
  const wy        = v => cY + padT + (1 - v / maxW) * chartH;
  const base      = wy(0);
  const wLevels   = []; for (let v = 0; v <= maxW; v += 5) wLevels.push(v);

  // --- background ---
  ctx.fillStyle = '#dde3eb';
  ctx.fillRect(0, cY, cssW, WIND_H);

  // --- kite column highlights (behind everything) ---
  _drawWindKiteColumns(ctx, winds, times, dirs, colW, cY, WIND_H);

  // --- grid & day dividers ---
  _drawWindGrid(ctx, wLevels, wy, cssW);
  divs.forEach(i => {
    const x = i * colW;
    ctx.strokeStyle = '#667788'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, cY); ctx.lineTo(x, cY + WIND_H); ctx.stroke();
  });

  // --- ensemble gust band (extended full-width, clipped above wind line) ---
  _drawEnsGustExtendedBand(ctx, ensGust, safeGusts, winds, n, cx2, wy, cY + padT);

  // --- ensemble wind band (clipped to wind fill area) ---
  const windFillClip = [
    { x: cx2(0),     y: base },
    ...winds.map((v, i) => ({ x: cx2(i), y: wy(v) })),
    { x: cx2(n - 1), y: base },
  ];
  _drawEnsBand(ctx, ensWind, cx2, wy, windFillClip, 'rgba(0,0,0,0.22)');


  // --- wind line ---
  _drawWindLine(ctx, winds, cx2, wy, 'rgba(255,255,255,0.95)', 2);

  // --- kite pill icons (top strip) ---
  _drawKiteIcons(ctx, winds, times, dirs, cx2, cY, KITE_H);

  // --- axis labels ---
  _drawWindAxisLabels(wLevels);
}

/* ══════════════════════════════════════════════════
   RENDER ALL
══════════════════════════════════════════════════ */
function renderAll(d) {
  drawTopRow(d.times, d.codes, d.precips);
  drawTemp(d.times, d.temps, d.precips, d.ensTemp || null, d.ensPrecip || null);
  drawWindDir(d.times, d.winds, d.dirs);
  drawWind(d.times, d.gusts, d.winds, d.dirs, d.ensWind || null, d.ensGust || null);
}

