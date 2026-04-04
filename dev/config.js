/* ══════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════ */
const FORECAST_DAYS = 7;
const STEP   = 3; // every 3 hours  (icons, wind arrows)
const STEP1H = 1; // every 1 hour   (temperature, wind speed/gust, precip curves)
const DA_DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DA_DAYS3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DA_MON   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ══════════════════════════════════════════════════
   KITE CONFIG  (read from URL, defaults if absent)
   URL params: kite_min, kite_max, kite_dirs (comma-separated degrees, snapped to 10°)
══════════════════════════════════════════════════ */
const KITE_DEFAULTS = {
  min:  7,
  max:  9,
  dirs: [90, 270],   // exact bearings (snapped to nearest 10°)
  daylight: true,
};

/** Snap any bearing to the nearest 10° slot (0, 10, 20 … 350). */
function snapBearing(deg) {
  return Math.round(((deg % 360) + 360) % 360 / 10) * 10 % 360;
}

function parseKiteParams() {
  const p = new URLSearchParams(window.location.search);
  const cfg = { ...KITE_DEFAULTS };
  if (p.has('kite_min'))  cfg.min  = parseFloat(p.get('kite_min'))  || cfg.min;
  if (p.has('kite_max'))  cfg.max  = parseFloat(p.get('kite_max'))  || cfg.max;
  if (p.has('kite_dirs')) cfg.dirs = p.get('kite_dirs').split(',').map(Number).filter(v => !isNaN(v)).map(snapBearing);
  if (p.has('kite_at_night')) cfg.daylight = p.get('kite_at_night') !== '0' ? false : true;
  return cfg;
}

let KITE_CFG = parseKiteParams();

function setKiteParams(cfg) {
  KITE_CFG = cfg;
  const url = new URL(window.location.href);
  const def = KITE_DEFAULTS;
  if (cfg.min  !== def.min)  url.searchParams.set('kite_min',  cfg.min);  else url.searchParams.delete('kite_min');
  if (cfg.max  !== def.max)  url.searchParams.set('kite_max',  cfg.max);  else url.searchParams.delete('kite_max');
  const dirsStr = cfg.dirs.slice().sort((a,b)=>a-b).join(',');
  const defDirs = def.dirs.slice().sort((a,b)=>a-b).join(',');
  if (dirsStr !== defDirs) url.searchParams.set('kite_dirs', dirsStr); else url.searchParams.delete('kite_dirs');
  // kite_tol is no longer used — remove any legacy param
  url.searchParams.delete('kite_tol');
  if (cfg.daylight !== def.daylight) url.searchParams.set('kite_at_night', '1');
  else url.searchParams.delete('kite_at_night');
  window.history.replaceState(null, '', url.toString());
}

