/* ══════════════════════════════════════════════════
   GEOCODING + WEATHER API
══════════════════════════════════════════════════ */
async function geocode(city) {
  const enc = encodeURIComponent(city);
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${enc}&count=1&language=en&format=json`);
    if (r.ok) {
      const d = await r.json();
      if (d.results?.length) {
        const l = d.results[0];
        return {name:l.name, latitude:l.latitude, longitude:l.longitude, country_code:l.country_code};
      }
    }
  } catch(e){}

  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${enc}&format=json&limit=1&addressdetails=1`, {headers:{'Accept-Language':'en'}});
    if (r.ok) {
      const d = await r.json();
      if (d.length) {
        const l = d[0];
        const name = l.address?.city || l.address?.town || l.address?.village || l.display_name.split(',')[0];
        return {name, latitude:+l.lat, longitude:+l.lon, country_code:(l.address?.country_code||'').toUpperCase()};
      }
    }
  } catch(e){}

  const FB = {
    'kobenhavn':{name:'Copenhagen',latitude:55.6761,longitude:12.5683,country_code:'DK'},
    'copenhagen':{name:'Copenhagen',latitude:55.6761,longitude:12.5683,country_code:'DK'},
    'aarhus':{name:'Aarhus',latitude:56.1629,longitude:10.2039,country_code:'DK'},
    'odense':{name:'Odense',latitude:55.4038,longitude:10.4024,country_code:'DK'},
    'aalborg':{name:'Aalborg',latitude:57.0488,longitude:9.9217,country_code:'DK'},
    'oslo':{name:'Oslo',latitude:59.9139,longitude:10.7522,country_code:'NO'},
    'stockholm':{name:'Stockholm',latitude:59.3293,longitude:18.0686,country_code:'SE'},
    'hamburg':{name:'Hamburg',latitude:53.5753,longitude:10.0153,country_code:'DE'},
    'berlin':{name:'Berlin',latitude:52.5244,longitude:13.4105,country_code:'DE'},
    'london':{name:'London',latitude:51.5085,longitude:-0.1257,country_code:'GB'},
    'paris':{name:'Paris',latitude:48.8534,longitude:2.3488,country_code:'FR'},
    'amsterdam':{name:'Amsterdam',latitude:52.374,longitude:4.8897,country_code:'NL'},
    'new york':{name:'New York',latitude:40.7143,longitude:-74.006,country_code:'US'},
    'tokyo':{name:'Tokyo',latitude:35.6895,longitude:139.6917,country_code:'JP'},
  };
  const key = city.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const hit = FB[key] || Object.entries(FB).find(([k])=>k.includes(key)||key.includes(k))?.[1];
  if (hit) return hit;
  throw new Error('City not found');
}

async function fetchWeather(lat, lon, model) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,precipitation,windspeed_10m,windgusts_10m,winddirection_10m,weathercode`
    + `&daily=sunrise,sunset`
    + `&forecast_days=${FORECAST_DAYS}&timezone=auto&windspeed_unit=ms`
    + (model && model !== 'best_match' ? `&models=${model}` : '');
  const r = await fetch(url);
  if (!r.ok) throw new Error('fetch failed');
  return r.json();
}

async function fetchEnsemble(lat, lon, model) {
  // Map deterministic model to nearest supported ensemble model
  const ENS_MAP = {
    'best_match':          'icon_seamless',
    'dmi_seamless':        'icon_seamless',   // DMI has no ensemble; use ICON (same NWP family)
    'icon_seamless':       'icon_seamless',
    'ecmwf_ifs025':        'ecmwf_ifs04',
    'meteofrance_seamless':'icon_seamless',
    'gfs_seamless':        'gfs025',
  };
  const ensModel = ENS_MAP[model] || 'icon_seamless';
  // Cap forecast_days to each ensemble model's supported maximum
  const ENS_MAX_DAYS = { 'icon_seamless': 7, 'ecmwf_ifs04': 15, 'gfs025': 35 };
  const ensDays = Math.min(FORECAST_DAYS, ENS_MAX_DAYS[ensModel] || 7);
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}`
    + `&hourly=temperature_2m,windspeed_10m,windgusts_10m,precipitation`
    + `&models=${ensModel}`
    + `&forecast_days=${ensDays}&timezone=auto&windspeed_unit=ms`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('ensemble fetch failed');
  return r.json();
}

// All deterministic models available for comparison overlays.
const OTHER_WIND_MODELS = [
  'icon_seamless',
  'ecmwf_ifs025',
  'meteofrance_seamless',
  'gfs_seamless',
  'dmi_seamless',
];

/**
 * Fetch 1-hour wind speed for every model except the currently selected one.
 * Returns [{model, winds1h}] — failures/empty results are silently dropped.
 */
async function fetchOtherModelsWind(lat, lon, selectedModel) {
  // For best_match we still show all named models (best_match is not a named run).
  const toFetch = OTHER_WIND_MODELS.filter(m => m !== selectedModel);
  const results = await Promise.all(toFetch.map(async model => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
        + `&hourly=windspeed_10m`
        + `&forecast_days=${FORECAST_DAYS}&timezone=auto&windspeed_unit=ms`
        + `&models=${model}`;
      const r = await fetch(url);
      if (!r.ok) return null;
      const d = await r.json();
      const winds = d.hourly?.windspeed_10m;
      if (!winds || !winds.length) return null;
      return { model, winds1h: winds };
    } catch (_) { return null; }
  }));
  return results.filter(Boolean);
}

/* ══════════════════════════════════════════════════
   YR / MET NORWAY  (api.met.no)
══════════════════════════════════════════════════ */
const YR_SYMBOL_WMO = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3,
  fog: 45,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightsleet: 66, sleet: 67, heavysleet: 67,
  lightsleetshowers: 66, sleetshowers: 67, heavysleetshowers: 67,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
  thunder: 95, rainandthunder: 95, sleetandthunder: 95,
  snowandthunder: 95, lightsnowandthunder: 95, heavysnowandthunder: 95,
  lightrainandthunder: 95, heavyrainandthunder: 95,
  lightsleetshowersandthunder: 96, sleetshowersandthunder: 96, heavysleetshowersandthunder: 96,
  lightsnowshowersandthunder: 95, snowshowersandthunder: 95, heavysnowshowersandthunder: 95,
  lightrainshowersandthunder: 95, rainshowersandthunder: 95, heavyrainshowersandthunder: 99,
};

function yrSymbolToWmo(sym) {
  if (!sym) return 3;
  return YR_SYMBOL_WMO[sym.replace(/_(day|night|polartwilight)$/, '')] ?? 3;
}

// Convert Met.no UTC ISO string → local-time string without Z (matches Open-Meteo format)
function yrUtcToLocal(isoUtc) {
  const d = new Date(isoUtc);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function yrLerp(a, b, t) { return a + t * (b - a); }
function yrLerpDir(a, b, t) {
  // JS % keeps the sign of the dividend, so add 360 to ensure positive before final mod
  const diff = ((b - a + 180) % 360 + 360) % 360 - 180;
  return ((a + t * diff) % 360 + 360) % 360;
}
function yrCatmullRom(p0, p1, p2, p3, t) {
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2*p0 - 5*p1 + 4*p2 - p3) * t * t +
    (-p0 + 3*p1 - 3*p2 + p3) * t * t * t
  );
}

// Build p10/p50/p90 precipitation bands from Yr's per-hour min/expected/max arrays,
// sampled at `step` intervals (matching the shape of ensemblePercentiles output).
function yrPrecipBands(precip, precip_min, precip_max, step) {
  step = step || STEP;
  const p10 = [], p50 = [], p90 = [];
  const len = Math.min(precip.length, precip_min.length, precip_max.length);
  for (let i = 0; i < len; i += step) {
    p10.push(precip_min[i] ?? 0);
    p50.push(precip[i]     ?? 0);
    p90.push(precip_max[i] ?? 0);
  }
  return { p10, p50, p90 };
}

async function fetchYrWeather(lat, lon) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete`
    + `?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Yr fetch failed');
  const json = await r.json();
  const timeseries = json.properties.timeseries;

  const time = [], temperature_2m = [], precipitation = [], precip_min = [], precip_max = [],
        windspeed_10m = [], windgusts_10m = [], winddirection_10m = [], weathercode = [];

  for (let i = 0; i < timeseries.length; i++) {
    const entry = timeseries[i];
    const inst  = entry.data.instant.details;
    const h1    = entry.data.next_1_hours;
    const h6    = entry.data.next_6_hours;

    if (h1) {
      const d = h1.details;
      time.push(yrUtcToLocal(entry.time));
      temperature_2m.push(inst.air_temperature);
      windspeed_10m.push(inst.wind_speed);
      windgusts_10m.push(inst.wind_speed_of_gust ?? inst.wind_speed);
      winddirection_10m.push(inst.wind_from_direction);
      precipitation.push(d.precipitation_amount ?? 0);
      precip_min.push(d.precipitation_amount_min ?? d.precipitation_amount ?? 0);
      precip_max.push(d.precipitation_amount_max ?? d.precipitation_amount ?? 0);
      weathercode.push(yrSymbolToWmo(h1.summary?.symbol_code));
    } else if (h6) {
      // Expand 6-hour block into 6 hourly slots.
      // Cubic Catmull-Rom interpolation for smooth scalar fields; linear shortest-arc for direction.
      // p0 is clamped to p1 at the 1h→6h boundary (where spacing changes) to avoid overshoot.
      const prevEntry  = timeseries[i - 1];
      const prevIs6h   = prevEntry && prevEntry.data.next_6_hours && !prevEntry.data.next_1_hours;
      const p0i = prevIs6h ? prevEntry.data.instant.details : inst;
      const p2i = timeseries[i + 1]?.data.instant.details;
      const p3i = timeseries[i + 2]?.data.instant.details ?? p2i;

      const baseMs    = new Date(entry.time).getTime();
      const d         = h6.details;
      const precip1h  = (d.precipitation_amount ?? 0) / 6;
      const pmin1h    = (d.precipitation_amount_min ?? d.precipitation_amount ?? 0) / 6;
      const pmax1h    = (d.precipitation_amount_max ?? d.precipitation_amount ?? 0) / 6;
      const wmo       = yrSymbolToWmo(h6.summary?.symbol_code);
      const gust0     = p0i.wind_speed_of_gust ?? p0i.wind_speed;
      const gust1     = inst.wind_speed_of_gust ?? inst.wind_speed;
      const gust2     = p2i ? (p2i.wind_speed_of_gust ?? p2i.wind_speed) : gust1;
      const gust3     = p3i ? (p3i.wind_speed_of_gust ?? p3i.wind_speed) : gust2;

      for (let h = 0; h < 6; h++) {
        const t = h / 6;
        time.push(yrUtcToLocal(new Date(baseMs + h * 3600000).toISOString()));
        if (p2i) {
          temperature_2m.push(yrCatmullRom(p0i.air_temperature, inst.air_temperature, p2i.air_temperature, p3i ? p3i.air_temperature : p2i.air_temperature, t));
          windspeed_10m.push(Math.max(0, yrCatmullRom(p0i.wind_speed, inst.wind_speed, p2i.wind_speed, p3i ? p3i.wind_speed : p2i.wind_speed, t)));
          windgusts_10m.push(Math.max(0, yrCatmullRom(gust0, gust1, gust2, gust3, t)));
          winddirection_10m.push(yrLerpDir(inst.wind_from_direction, p2i.wind_from_direction, t));
        } else {
          temperature_2m.push(inst.air_temperature);
          windspeed_10m.push(inst.wind_speed);
          windgusts_10m.push(gust1);
          winddirection_10m.push(inst.wind_from_direction);
        }
        precipitation.push(precip1h);
        precip_min.push(pmin1h);
        precip_max.push(pmax1h);
        weathercode.push(wmo);
      }
    }
  }

  // Pad to local midnight of the first day so the chart starts at the same
  // point as Open-Meteo (which always starts at local midnight via timezone=auto).
  if (time.length > 0) {
    const firstMidnight = time[0].slice(0, 10) + 'T00:00';
    if (time[0] > firstMidnight) {
      const firstH = parseInt(time[0].slice(11, 13), 10);
      const date   = time[0].slice(0, 10);
      const n      = firstH;
      const padTimes = Array.from({ length: n }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
      time.unshift(...padTimes);
      temperature_2m.unshift(...Array(n).fill(null));
      windspeed_10m.unshift(...Array(n).fill(null));
      windgusts_10m.unshift(...Array(n).fill(null));
      winddirection_10m.unshift(...Array(n).fill(null));
      weathercode.unshift(...Array(n).fill(null));
      precipitation.unshift(...Array(n).fill(0));
      precip_min.unshift(...Array(n).fill(0));
      precip_max.unshift(...Array(n).fill(0));
    }
  }

  return {
    hourly: { time, temperature_2m, precipitation, windspeed_10m, windgusts_10m, winddirection_10m, weathercode },
    daily: {},
    precip_uncertainty: { precip_min, precip_max },
  };
}

// Given the ensemble hourly object, extract p10/p50/p90 arrays for a variable, sampled at step (default STEP)
function ensemblePercentiles(H, varPrefix, step) {
  step = step || STEP;
  const memberKeys = Object.keys(H).filter(k => k.startsWith(varPrefix + '_member'));
  if (!memberKeys.length) return null;

  const p10 = [], p50 = [], p90 = [];
  const totalH = FORECAST_DAYS * 24;
  // Use the longest member length as the bound so no data from any member is dropped.
  const maxLen = Math.max(...memberKeys.map(k => H[k].length));
  for (let i = 0; i < Math.min(totalH, maxLen); i += step) {
    const vals = memberKeys.map(k => H[k][i]).filter(v => v != null).sort((a,b) => a-b);
    if (!vals.length) { p10.push(null); p50.push(null); p90.push(null); continue; }
    p10.push(vals[Math.floor(vals.length * 0.10)]);
    p50.push(vals[Math.floor(vals.length * 0.50)]);
    p90.push(vals[Math.floor(vals.length * 0.90)]);
  }
  return { p10, p50, p90 };
}

