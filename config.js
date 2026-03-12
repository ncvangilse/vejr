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
   URL params: kite_min, kite_max, kite_dirs (comma-separated degrees), kite_tol
══════════════════════════════════════════════════ */
const KITE_DEFAULTS = {
  min:  7,
  max:  9,
  dirs: [90, 270],
  tol:  22,
  daylight: true,
};

// Direction preset options shown in the dialog
const DIR_PRESETS = [
  { label: 'N',  deg: 0   },
  { label: 'NE', deg: 45  },
  { label: 'E',  deg: 90  },
  { label: 'SE', deg: 135 },
  { label: 'S',  deg: 180 },
  { label: 'SW', deg: 225 },
  { label: 'W',  deg: 270 },
  { label: 'NW', deg: 315 },
];

function parseKiteParams() {
  const p = new URLSearchParams(window.location.search);
  const cfg = { ...KITE_DEFAULTS };
  if (p.has('kite_min'))     cfg.min     = parseFloat(p.get('kite_min'))  || cfg.min;
  if (p.has('kite_max'))     cfg.max     = parseFloat(p.get('kite_max'))  || cfg.max;
  if (p.has('kite_dirs'))    cfg.dirs    = p.get('kite_dirs').split(',').map(Number).filter(v => !isNaN(v));
  if (p.has('kite_tol'))     cfg.tol     = parseFloat(p.get('kite_tol'))  ?? cfg.tol;
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
  if (cfg.tol  !== def.tol)  url.searchParams.set('kite_tol',  cfg.tol);  else url.searchParams.delete('kite_tol');
  if (cfg.daylight !== def.daylight) url.searchParams.set('kite_at_night', '1');
  else url.searchParams.delete('kite_at_night');
  window.history.replaceState(null, '', url.toString());
}

