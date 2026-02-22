/* ══════════════════════════════════════════════════
   DMI-STYLE ICON DRAWING
   Each icon is drawn into a square region (x,y,size)
   WMO codes → icon type
══════════════════════════════════════════════════ */

// Populated by load() with { "YYYY-MM-DD": { sunrise, sunset } } in local decimal hours.
// Sourced directly from open-meteo daily sunrise/sunset — no manual solar calculation needed.
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

// Cloud: classic multi-bump silhouette with flat bottom, rain-darkened fill.
function _cloud(ctx, ox, oy, U, rainAmt) {
  ctx.save(); ctx.translate(ox, oy);

  const t = (rainAmt > 0) ? Math.min(1, rainAmt / 6) : 0;
  function lerp(a, b) { return Math.round(a + (b - a) * t); }
  const bodyCol      = `rgb(${lerp(0xee,0x62)},${lerp(0xf2,0x6a)},${lerp(0xf8,0x72)})`;
  const undersideCol = `rgb(${lerp(0xa8,0x32)},${lerp(0xb4,0x3e)},${lerp(0xc4,0x4a)})`;
  const strokeCol    = `rgb(${lerp(0x78,0x24)},${lerp(0x88,0x2e)},${lerp(0x98,0x38)})`;

  // Four bumps: far-left small, left-centre medium, right-centre large (peak), far-right medium
  const bumps = [
    { x: -U*0.50, y:  U*0.08, r: U*0.26 },
    { x: -U*0.14, y: -U*0.08, r: U*0.38 },
    { x:  U*0.22, y: -U*0.18, r: U*0.44 },
    { x:  U*0.56, y:  U*0.00, r: U*0.32 },
  ];
  const n      = bumps.length;
  const bottom = U * 0.36;

  // For each bump compute the angular range of its exposed top arc.
  // The hand-off between bump[i] and bump[i+1] happens at the angle
  // FROM bump[i]'s centre TOWARD bump[i+1]'s centre (the circles overlap
  // so the silhouette crosses near that direction).
  // We sweep each arc CLOCKWISE (anticlockwise=false) from endAngle back
  // to startAngle — i.e. over the top — by using anticlockwise=true and
  // swapping start/end so we always go over the peak.
  const sa = [], ea = [];
  for (let i = 0; i < n; i++) {
    // angle FROM this bump TOWARD right neighbour = end of this bump's arc
    ea[i] = (i < n-1)
      ? Math.atan2(bumps[i+1].y - bumps[i].y, bumps[i+1].x - bumps[i].x)
      : 0;                           // rightmost: end at 3 o'clock
    // angle FROM this bump TOWARD left neighbour = start of this bump's arc
    sa[i] = (i > 0)
      ? Math.atan2(bumps[i-1].y - bumps[i].y, bumps[i-1].x - bumps[i].x)
      : Math.PI;                     // leftmost: start at 9 o'clock
  }

  // Trace silhouette: moveTo flat-bottom left, then arc each bump over its top,
  // then line to flat-bottom right and close.
  const flatLeft  = bumps[0].x - bumps[0].r * 0.7;
  const flatRight = bumps[n-1].x + bumps[n-1].r * 0.7;

  ctx.beginPath();
  ctx.moveTo(flatLeft, bottom);
  for (let i = 0; i < n; i++) {
    // Arc from sa[i] to ea[i] going anticlockwise = over the top of the bump
    ctx.arc(bumps[i].x, bumps[i].y, bumps[i].r, sa[i], ea[i], true);
  }
  ctx.lineTo(flatRight, bottom);
  ctx.closePath();

  // Shadow: same path shifted down
  ctx.save();
  ctx.translate(0, U * 0.10);
  ctx.fillStyle = undersideCol;
  ctx.fill();
  ctx.restore();

  // Body fill
  ctx.fillStyle = bodyCol;
  ctx.fill();

  // Outline
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth   = Math.max(0.8, U * 0.07);
  ctx.lineJoin    = 'round';
  ctx.stroke();

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
