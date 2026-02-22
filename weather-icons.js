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

// ═══════════════════════════════════════════════════
//  DMI-accurate icon drawing
//  sz = full icon cell height (ICON_H)
//  All proportions derived from studying the real DMI GIFs
// ═══════════════════════════════════════════════════
function dmiIcon(ctx, type, cx, cy, sz, rainAmt) {
  ctx.save();
  ctx.translate(cx, cy);
  // DMI icons sit in a small box — sun radius ~35% of half-height
  const U = sz * 0.5; // unit = half cell height
  const r = rainAmt || 0;
  switch(type) {
    case 'sun':          _sun(ctx, 0, 0, U); break;
    case 'night_clear':  _stars(ctx, U); break;
    case 'sun_cloud':    _sun(ctx, -U*0.45, -U*0.42, U*0.60); _cloud(ctx, U*0.10, U*0.18, U, 0); break;
    case 'night_partly': _stars(ctx, U*0.55, -U*0.50, -U*0.38); _cloud(ctx, U*0.10, U*0.20, U, 0); break;
    case 'cloud_sun':    _sun(ctx, -U*0.48, -U*0.44, U*0.52); _cloud(ctx, U*0.05, U*0.10, U*1.02, 0); break;
    case 'cloud':        _cloud(ctx, 0, 0, U*1.02, 0); break;
    case 'drizzle':      _cloud(ctx, 0, -U*0.22, U, r); _rain(ctx, 0, U*0.52, U, 2); break;
    case 'rain':         _cloud(ctx, 0, -U*0.22, U, r); _rain(ctx, 0, U*0.52, U, 3); break;
    case 'shower':       _sun(ctx, -U*0.44, -U*0.52, U*0.50); _cloud(ctx, U*0.05, U*0.02, U, r); _rain(ctx, U*0.05, U*0.56, U, 3); break;
    case 'snow':         _cloud(ctx, 0, -U*0.22, U, 0); _snow(ctx, 0, U*0.54, U); break;
    case 'thunder':      _cloud(ctx, 0, -U*0.22, U*1.02, r); _bolt(ctx, 0, U*0.38, U); break;
    case 'fog':          _cloud(ctx, 0, -U*0.22, U, 0); _fog(ctx, 0, U*0.46, U); break;
    default:             _cloud(ctx, 0, 0, U*1.02, 0);
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

// Cloud: DMI flat blob — wide, low, grey bottom, white top
// Key: TWO rounded bumps on top, very flat aspect ratio (~2.2:1 w/h)
// rainAmt (mm per 3h): 0 = default light grey, scales to fully dark grey at ~6 mm
function _cloud(ctx, ox, oy, U, rainAmt) {
  ctx.save(); ctx.translate(ox, oy);
  const w = U * 1.50, h = U * 0.62;
  // Map rain amount to a 0–1 darkness factor
  // 0 mm → 0, ~1 mm → ~0.17, ~3 mm → ~0.50, ≥6 mm → 1.0
  const t = (rainAmt > 0) ? Math.min(1, rainAmt / 6) : 0;
  // Interpolate cloud colours towards dark storm grey as rain increases
  function lerpHex(a, b) {
    return '#' + [0,2,4].map(i =>
      Math.round(parseInt(a.slice(i+1,i+3),16) * (1-t) + parseInt(b.slice(i+1,i+3),16) * t)
        .toString(16).padStart(2,'0')
    ).join('');
  }
  const bodyCol      = lerpHex('#edf1f6', '#6e7880');  // light → dark grey
  const undersideCol = lerpHex('#b0b8c2', '#3e4e5a');  // grey bottom → dark
  const strokeCol    = lerpHex('#8898a8', '#2e3a44');   // outline → very dark
  // grey underside
  ctx.beginPath(); _cloudShape(ctx, 0, h*0.10, w, h);
  ctx.fillStyle = undersideCol; ctx.fill();
  // body
  ctx.beginPath(); _cloudShape(ctx, 0, 0, w, h);
  ctx.fillStyle = bodyCol; ctx.fill();
  ctx.strokeStyle = strokeCol; ctx.lineWidth = Math.max(0.5, U*0.05); ctx.stroke();
  ctx.restore();
}

function _cloudShape(ctx, ox, oy, w, h) {
  const x = ox-w/2, y = oy-h/2;
  const bR = h*0.24;  // bottom-corner radius
  const lR = h*0.46;  // left top bump
  const rR = h*0.34;  // right top bump
  ctx.moveTo(x+bR, y+h);
  ctx.lineTo(x+w-bR, y+h);
  ctx.arcTo(x+w,    y+h,    x+w,    y+h-bR, bR);
  ctx.arcTo(x+w,    y+rR*0.3, x+w-rR, y+rR*0.3, rR);
  ctx.arcTo(x+w*0.58, y,    x+w*0.58-lR*0.4, y+lR*0.5, lR*0.92);
  ctx.arcTo(x+bR,   y+h*0.1, x+bR,   y+h-bR, bR*0.9);
  ctx.arcTo(x,      y+h-bR,  x+bR,   y+h,    bR);
  ctx.closePath();
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

// Lightning bolt
function _bolt(ctx, ox, oy, U) {
  ctx.save(); ctx.translate(ox, oy);
  ctx.beginPath();
  ctx.moveTo(U*0.10,0); ctx.lineTo(-U*0.05,U*0.20); ctx.lineTo(U*0.05,U*0.20); ctx.lineTo(-U*0.10,U*0.42);
  ctx.strokeStyle='#f0c000'; ctx.lineWidth=Math.max(1.2,U*0.12); ctx.lineJoin='round'; ctx.lineCap='round'; ctx.stroke();
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
