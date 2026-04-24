/* ══════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════ */
var FORECAST_DAYS = 16;
const STEP   = 3; // every 3 hours  (icons, wind arrows)
const STEP1H = 1; // every 1 hour   (temperature, wind speed/gust, precip curves)
const DA_DAYS  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DA_DAYS3 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DA_MON   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ══════════════════════════════════════════════════
   KITE CONFIG  (read from URL, defaults if absent)
   URL params: kite_min, kite_max, kite_dirs (comma-separated degrees, snapped to 10°)
   Settings are also mirrored to localStorage so they survive iOS Home Screen launches,
   where the shortcut always opens the original saved URL (without any replaceState changes).
══════════════════════════════════════════════════ */
const KITE_DEFAULTS = {
  min:  7,
  max:  9,
  dirs: [90, 270],   // exact bearings (snapped to nearest 10°)
  daylight: true,
  seaThresh: 0.90,   // fraction of samples over water required for a sea bearing
};
const KITE_STORAGE_KEY = 'vejr_kite_cfg';

/** Snap any bearing to the nearest 10° slot (0, 10, 20 … 350). */
function snapBearing(deg) {
  return Math.round(((deg % 360) + 360) % 360 / 10) * 10 % 360;
}

function parseKiteParams() {
  const p = new URLSearchParams(window.location.search);
  const cfg = { ...KITE_DEFAULTS };
  const hasUrlParams = p.has('kite_min') || p.has('kite_max') || p.has('kite_dirs')
                     || p.has('kite_at_night') || p.has('kite_sea_thresh');

  if (hasUrlParams) {
    if (p.has('kite_min')) { const v = parseFloat(p.get('kite_min')); if (!isNaN(v)) cfg.min = v; }
    if (p.has('kite_max')) { const v = parseFloat(p.get('kite_max')); if (!isNaN(v)) cfg.max = v; }
    if (p.has('kite_dirs')) cfg.dirs = p.get('kite_dirs').split(',').map(Number).filter(v => !isNaN(v)).map(snapBearing);
    if (p.has('kite_at_night')) cfg.daylight = p.get('kite_at_night') !== '0' ? false : true;
    if (p.has('kite_sea_thresh')) {
      const v = parseFloat(p.get('kite_sea_thresh'));
      if (!isNaN(v) && v >= 0.1 && v <= 1.0) cfg.seaThresh = v;
    }
    // Persist URL-provided settings so they survive future Home Screen launches
    try { localStorage.setItem(KITE_STORAGE_KEY, JSON.stringify(cfg)); } catch(_) {}
  } else {
    // No URL params — fall back to localStorage (used when launched from iOS Home Screen)
    try {
      const stored = localStorage.getItem(KITE_STORAGE_KEY);
      if (stored) {
        const saved = JSON.parse(stored);
        if (typeof saved.min     === 'number')  cfg.min     = saved.min;
        if (typeof saved.max     === 'number')  cfg.max     = saved.max;
        if (Array.isArray(saved.dirs))          cfg.dirs    = saved.dirs;
        if (typeof saved.daylight === 'boolean') cfg.daylight = saved.daylight;
        if (typeof saved.seaThresh === 'number') cfg.seaThresh = saved.seaThresh;
      } else {
        // No stored config: this is a fresh session, safe to auto-detect sea bearings.
        cfg._fromDefaults = true;
      }
    } catch(_) { /* ignore corrupt storage */ }
  }
  return cfg;
}

// ?reset=1 gives a fully fresh first-visit experience: clears the saved
// location and kite config from localStorage, then strips the param from
// the URL so it doesn't linger or get shared accidentally.
function applyResetParam() {
  const p = new URLSearchParams(window.location.search);
  if (p.get('reset') !== '1') return;
  try {
    localStorage.removeItem(KITE_STORAGE_KEY);
    localStorage.removeItem('vejr_city');
  } catch(_) {}
  p.delete('reset');
  const qs = p.toString();
  window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
}
applyResetParam();

let KITE_CFG = parseKiteParams();

function setKiteParams(cfg) {
  KITE_CFG = cfg;
  // Persist to localStorage so settings survive iOS Home Screen launches
  try { localStorage.setItem(KITE_STORAGE_KEY, JSON.stringify(cfg)); } catch(_) {}
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
  if (cfg.seaThresh !== def.seaThresh) url.searchParams.set('kite_sea_thresh', cfg.seaThresh);
  else url.searchParams.delete('kite_sea_thresh');
  window.history.replaceState(null, '', url.toString());
}

