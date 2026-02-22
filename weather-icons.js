/* ══════════════════════════════════════════════════
   DMI-STYLE ICON DRAWING
   Each icon is drawn into a square region (x,y,size)
   WMO codes → icon type
══════════════════════════════════════════════════ */

// ── Solar position ────────────────────────────────
// Returns { sunrise, sunset } as decimal hours (local solar time)
// using the NOAA simplified algorithm. Accurate to ±1–2 min.
function sunriseSunsetHours(dateStr, lat, lon) {
  const date   = new Date(dateStr + 'T12:00:00Z');
  const JD     = date.getTime() / 86400000 + 2440587.5;
  const n      = JD - 2451545.0;
  const L      = (280.460 + 0.9856474 * n) % 360;
  const g      = (357.528 + 0.9856003 * n) % 360;
  const gR     = g * Math.PI / 180;
  const lambda = L + 1.915 * Math.sin(gR) + 0.020 * Math.sin(2 * gR);
  const lambdaR = lambda * Math.PI / 180;
  const sinDec = Math.sin(23.439 * Math.PI / 180) * Math.sin(lambdaR);
  const dec    = Math.asin(sinDec);
  const latR   = lat * Math.PI / 180;
  const cosH   = (Math.sin(-0.8333 * Math.PI / 180) - Math.sin(latR) * sinDec)
                 / (Math.cos(latR) * Math.cos(dec));
  if (cosH > 1)  return { sunrise: 12, sunset: 12 };  // polar night
  if (cosH < -1) return { sunrise:  0, sunset: 24 };  // midnight sun
  const H      = Math.acos(cosH) * 180 / Math.PI;
  // equation of time (minutes)
  const f      = (279.575 + 0.9856474 * n) * Math.PI / 180;
  const EqT    = (-104.5 * Math.sin(f) + 596.9 * Math.cos(f)
                  - 4.1 * Math.sin(2*f) - 12.79 * Math.cos(2*f)
                  - 429.3 * Math.sin(3*f) - 2.0  * Math.cos(3*f)
                  + 19.3 * Math.sin(4*f)) / 3600;
  const UTC_off = lon / 15;
  const noon   = 12 - EqT - UTC_off;
  return { sunrise: noon - H / 15, sunset: noon + H / 15 };
}

// Populated by load() with { "YYYY-MM-DD": { sunrise, sunset } }
let sunTimes = {};

function isNight(timeStr) {
  if (typeof timeStr !== 'string') return false;
  const dateKey = timeStr.slice(0, 10);          // "YYYY-MM-DD"
  const h = parseFloat(timeStr.slice(11, 13))    // integer hour
          + parseFloat(timeStr.slice(14, 16)) / 60;
  const st = sunTimes[dateKey];
  if (!st) {
    // fallback if sunTimes not yet populated
    return h < 6 || h >= 20;
  }
  return h < st.sunrise || h >= st.sunset;
}

function wmoType(code, timeStr) {
  const night = timeStr && isNight(timeStr);
  if (code === 0) return night ? 'night_clear' : 'sun';
  if (code === 1) return night ? 'night_partly' : 'sun_cloud';
  if (code === 2) return 'cloud_sun';
  if (code === 3) return 'cloud';
  if (code >= 45 && code <= 48) return 'fog';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code >= 61 && code <= 65) return 'rain';
  if (code >= 71 && code <= 75) return 'snow';
  if (code >= 80 && code <= 82) return 'shower';
  if (code >= 95) return 'thunder';
  return 'cloud';
}

// Minimum cloud darkness (0–1) implied by the WMO code alone,
// independent of actual precipitation amount.
function wmoMinDark(code) {
  if (code >= 95) return 0.70;   // thunderstorm  → very dark
  if (code === 82) return 0.65;  // violent shower → very dark
  if (code === 81) return 0.50;  // moderate shower
  if (code === 80) return 0.35;  // light shower
  if (code === 65) return 0.60;  // heavy rain
  if (code === 63) return 0.45;  // moderate rain
  if (code === 61) return 0.30;  // light rain
  if (code === 55) return 0.30;  // heavy drizzle
  if (code === 53) return 0.20;  // moderate drizzle
  if (code === 51) return 0.12;  // light drizzle
  return 0;
}

// ═══════════════════════════════════════════════════
//  DMI-accurate icon drawing
//  sz = full icon cell height (ICON_H)
//  All proportions derived from studying the real DMI GIFs
// ═══════════════════════════════════════════════════
function dmiIcon(ctx, type, cx, cy, sz, rainAmt, wmoCode) {
  ctx.save();
  ctx.translate(cx, cy);
  const U = sz * 0.5;
  const r = rainAmt || 0;
  // Effective rain: at least as dark as the WMO code implies, regardless of actual mm value
  const minDark = wmoMinDark(wmoCode || 0);
  const er = Math.max(r, minDark * 6);
  switch(type) {
    case 'sun':          _sun(ctx, 0, 0, U); break;
    case 'night_clear':  _stars(ctx, U); break;
    case 'sun_cloud':    _sun(ctx, -U*0.44, -U*0.44, U*0.58); _cloud(ctx, U*0.14, U*0.22, U*0.68, 0); break;
    case 'night_partly': _stars(ctx, U*0.60, -U*0.50, -U*0.40); _cloud(ctx, U*0.14, U*0.24, U*0.68, 0); break;
    case 'cloud_sun':    _sun(ctx, -U*0.46, -U*0.46, U*0.52); _cloud(ctx, U*0.05, U*0.08, U*0.90, 0); break;
    case 'cloud':        _cloud(ctx, 0, 0, U, 0); break;
    case 'drizzle':      _cloud(ctx, 0, -U*0.24, U, er); _rain(ctx, 0, U*0.54, U, 2); break;
    case 'rain':         _cloud(ctx, 0, -U*0.24, U, er); _rain(ctx, 0, U*0.54, U, 3); break;
    case 'shower':       _sun(ctx, -U*0.44, -U*0.52, U*0.50); _cloud(ctx, U*0.05, U*0.02, U*0.88, er); _rain(ctx, U*0.05, U*0.58, U, 3); break;
    case 'snow':         _cloud(ctx, 0, -U*0.24, U, 0); _snow(ctx, 0, U*0.56, U); break;
    case 'thunder':      _cloud(ctx, 0, -U*0.30, U, er); _bolt(ctx, 0, U*0.36, U); break;
    case 'fog':          _cloud(ctx, 0, -U*0.24, U, 0); _fog(ctx, 0, U*0.48, U); break;
    default:             _cloud(ctx, 0, 0, U, 0);
  }
  ctx.restore();
}

// Sun: small yellow disc, 8 straight short rays
function _sun(ctx, ox, oy, U) {
  ctx.save(); ctx.translate(ox, oy);
  const disc = U * 0.36;  // disc radius
  const ri   = disc + U * 0.06;
  const ro   = disc + U * 0.30;
  ctx.strokeStyle = '#e8a000';
  ctx.lineWidth   = Math.max(0.8, U * 0.09);
  ctx.lineCap     = 'butt';
  for (let i=0; i<8; i++) {
    const a = i/8 * Math.PI*2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*ri, Math.sin(a)*ri);
    ctx.lineTo(Math.cos(a)*ro, Math.sin(a)*ro);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(0,0,disc,0,Math.PI*2);
  ctx.fillStyle='#ffd700'; ctx.fill();
  ctx.strokeStyle='#cc8800'; ctx.lineWidth=Math.max(0.5, U*0.05); ctx.stroke();
  ctx.restore();
}

// Cloud: classic silhouette — four overlapping circles, flat bottom, rain-darkened.
function _cloud(ctx, ox, oy, U, rainAmt) {
  ctx.save(); ctx.translate(ox, oy);

  const t = (rainAmt > 0) ? Math.min(1, rainAmt / 6) : 0;
  function lerp(a, b) { return Math.round(a + (b - a) * t); }
  // body: near-white → mid grey
  const br = lerp(0xee, 0x6e), bg = lerp(0xf2, 0x78), bb = lerp(0xf8, 0x80);
  // shadow underside: light grey → dark grey
  const sr = lerp(0xb8, 0x3e), sg = lerp(0xc2, 0x4e), sb = lerp(0xd0, 0x5a);
  // stroke: medium grey → very dark
  const or = lerp(0x88, 0x2e), og = lerp(0x98, 0x3a), ob = lerp(0xa8, 0x44);

  const bodyCol      = `rgb(${br},${bg},${bb})`;
  const undersideCol = `rgb(${sr},${sg},${sb})`;
  const strokeCol    = `rgb(${or},${og},${ob})`;

  const bumps = [
    { x: -U*0.52, y:  U*0.10, r: U*0.25 },
    { x: -U*0.18, y: -U*0.06, r: U*0.37 },
    { x:  U*0.20, y: -U*0.16, r: U*0.43 },
    { x:  U*0.54, y:  U*0.02, r: U*0.31 },
  ];
  const bottom =  U * 0.34;
  const left   = -U * 0.82;
  const right  =  U * 0.88;
  const top    = -U * 0.62;

  // 1. Shadow: filled union of bumps shifted down, clipped so it only shows below body
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, bottom - U*0.12, right - left, U*0.20);
  ctx.clip();
  ctx.fillStyle = undersideCol;
  bumps.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y + U*0.10, b.r, 0, Math.PI*2);
    ctx.fill();
  });
  ctx.restore();

  // 2. Body: filled union of bumps, clipped to flat-bottom rect
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  ctx.fillStyle = bodyCol;
  bumps.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
    ctx.fill();
  });
  ctx.restore();

  // 3. Outline: use compositing to stroke only the outer silhouette.
  //    Draw filled union into an offscreen approach: stroke each circle with
  //    destination-out on a saved layer, then restore. Simpler: just clip
  //    to body rect and stroke each circle — interior strokes will be hidden
  //    by re-filling body colour with a tiny inset.
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top + U*0.04);
  ctx.clip();
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = Math.max(0.8, U * 0.07);
  ctx.lineJoin = 'round';
  bumps.forEach(b => { ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI*2); ctx.stroke(); });
  // erase interior strokes by re-filling body
  ctx.fillStyle = bodyCol;
  bumps.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r - Math.max(0.6, U*0.045), 0, Math.PI*2);
    ctx.fill();
  });
  // bottom edge
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = Math.max(0.8, U * 0.07);
  ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke();
  ctx.restore();

  ctx.restore();
}


// Rain: short diagonal lines
function _rain(ctx, ox, oy, U, n) {
  ctx.save(); ctx.translate(ox, oy);
  ctx.strokeStyle='#2255aa'; ctx.lineWidth=Math.max(0.8,U*0.08); ctx.lineCap='round';
  const sp=U*0.28, x0=-(n-1)/2*sp;
  for(let i=0;i<n;i++){const x=x0+i*sp;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x-U*0.07,U*0.30);ctx.stroke();}
  ctx.restore();
}

// Snow
function _snow(ctx, ox, oy, U) {
  ctx.save(); ctx.translate(ox, oy);
  ctx.strokeStyle='#6699cc'; ctx.lineWidth=Math.max(0.8,U*0.08); ctx.lineCap='round';
  for(let i=0;i<3;i++){
    const x=(i-1)*U*0.30;
    ctx.beginPath();ctx.moveTo(x,-U*0.20);ctx.lineTo(x,U*0.20);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x-U*0.12,-U*0.10);ctx.lineTo(x,0);ctx.lineTo(x+U*0.12,-U*0.10);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x-U*0.12,U*0.10);ctx.lineTo(x,0);ctx.lineTo(x+U*0.12,U*0.10);ctx.stroke();
  }
  ctx.restore();
}

// Lightning bolt — filled zigzag, large enough to be clearly visible
function _bolt(ctx, ox, oy, U) {
  ctx.save(); ctx.translate(ox, oy);
  // Filled bold bolt: top-right → mid-left notch → mid-right → bottom-left
  ctx.beginPath();
  ctx.moveTo( U*0.14, -U*0.02);
  ctx.lineTo(-U*0.04,  U*0.22);
  ctx.lineTo( U*0.06,  U*0.22);
  ctx.lineTo(-U*0.14,  U*0.50);
  ctx.lineTo( U*0.04,  U*0.24);
  ctx.lineTo(-U*0.06,  U*0.24);
  ctx.closePath();
  ctx.fillStyle = '#ffe000';
  ctx.fill();
  ctx.strokeStyle = '#c89000';
  ctx.lineWidth = Math.max(0.6, U * 0.05);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

// Fog
function _fog(ctx, ox, oy, U) {
  ctx.save(); ctx.translate(ox, oy);
  ctx.strokeStyle='#aab4be'; ctx.lineWidth=Math.max(0.8,U*0.09); ctx.lineCap='round';
  for(let i=0;i<2;i++){const y=i*U*0.24;ctx.beginPath();ctx.moveTo(-U*0.42,y);ctx.lineTo(U*0.42,y);ctx.stroke();}
  ctx.restore();
}

// Night stars: scattered 4-pt sparkle stars, gold, no moon
function _stars(ctx, U, ox=0, oy=0) {
  ctx.save(); ctx.translate(ox, oy);
  // 4 stars of varying size — matches DMI scattered star pattern
  [
    {x:-U*0.40, y:-U*0.44, r:U*0.26},
    {x: U*0.36, y:-U*0.24, r:U*0.19},
    {x: U*0.08, y: U*0.40, r:U*0.15},
    {x:-U*0.16, y: U*0.10, r:U*0.12},
  ].forEach(({x,y,r})=>{
    ctx.save(); ctx.translate(x,y);
    ctx.beginPath();
    for(let i=0;i<8;i++){
      const a=i/8*Math.PI*2-Math.PI/2;
      const rr=i%2===0?r:r*0.25;  // very sharp inner = very pointy tips
      i===0?ctx.moveTo(Math.cos(a)*rr,Math.sin(a)*rr):ctx.lineTo(Math.cos(a)*rr,Math.sin(a)*rr);
    }
    ctx.closePath();
    ctx.fillStyle='#f8d400'; ctx.fill();
    ctx.strokeStyle='#c89400'; ctx.lineWidth=Math.max(0.4,r*0.08); ctx.stroke();
    ctx.restore();
  });
  ctx.restore();
}
