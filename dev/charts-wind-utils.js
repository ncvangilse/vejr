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
