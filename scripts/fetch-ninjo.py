#!/usr/bin/env python3
"""
AppDaemon app — rolling observation history + daily forecast collection.

Pushes two gzip-compressed JSON files to gh-pages:

  obs-history.json.gz  (every 10 min)
    Rolling 24-hour window of 10-min wind observations for every NinJo and
    Trafikkort station in Denmark.
    Schema:
      {
        "ninjo:<stationId>": {
          "name": "...", "lat": 55.6, "lon": 12.6, "source": "ninjo",
          "obs": [{"t": <unix_ms>, "wind": 5.1, "gust": 7.2, "dir": 270}, ...]
        },
        "trafikkort:<featureId>": {
          "name": "Trafikkort 1018", "lat": ..., "lon": ..., "source": "trafikkort",
          "obs": [{"t": <unix_ms>, "wind": 3.0, "dir": 135}, ...]
        }
      }

  forecast-history.json.gz  (daily at 00:05 UTC)
    7-day rolling window of hourly forecast + observed wind pairs per station.
    Schema:
      {
        "ninjo:06060": {
          "days": {
            "2026-04-17": {
              "forecast":   [{"h": 0, "wind": 6.2, "dir": 265}, ...],
              "obs_hourly": [{"h": 0, "wind": 5.8, "dir": 268}, ...]
            }
          }
        }
      }
    obs_hourly = previous day's 10-min obs resampled to hourly averages
    (arithmetic mean wind, max gust, circular mean direction).

Installation (Home Assistant AppDaemon add-on — a0d7b954):
  All paths are under /root/addon_configs/a0d7b954_appdaemon/

  1. App file:  apps/fetch_ninjo.py

  2. apps/apps.yaml:
       fetch_ninjo:
         module:       fetch_ninjo
         class:        FetchNinjo
         log:          fetch_ninjo_log
         github_token: !secret ninjo_github_token

  3. secrets.yaml:
       ninjo_github_token: ghp_YOUR_TOKEN_HERE
       (Fine-grained PAT: Contents = Read+write on ncvangilse/vejr only)

  4. appdaemon.yaml — add under `logs:`:
       logs:
         fetch_ninjo_log:
           name:     FetchNinjo
           filename: /root/addon_configs/a0d7b954_appdaemon/logs/fetch_ninjo.log
           format:   "{asctime} {message}"

  Fix order: add secrets.yaml first, then the log entry, then reload.
"""

import asyncio
import base64
import gzip
import json
import math
from datetime import datetime, timezone, timedelta

import aiohttp
import appdaemon.plugins.hass.hassapi as hass

# ── Source URLs ────────────────────────────────────────────────────────────────
NINJO_URL   = ('https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk'
               '?cmd=obj&south=54.1&north=57.9&west=5.5&east=17.9')
NINJO_HDRS  = {'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36'}
TRAFIKK_URL = ('https://storage.googleapis.com/trafikkort-data'
               '/geojson/wind-speeds.point.json')
OPEN_METEO  = 'https://api.open-meteo.com/v1/forecast'

# Rolling-window settings
OBS_WINDOW_H  = 24   # hours of obs to keep per station
FCST_WINDOW_D = 7    # days of forecast history to keep

# Open-Meteo batch: stations per request (comma-separated lat/lon)
FORECAST_BATCH = 50

# Raw base URL for bootstrapping state on startup
RAW_BASE = 'https://raw.githubusercontent.com/ncvangilse/vejr/gh-pages'

# Cardinal direction → degrees (matches radar.js DIR_DEG)
DIR_DEG = {
    'N': 0,   'NNE': 22,  'NE': 45,  'ENE': 67,
    'E': 90,  'ESE': 112, 'SE': 135, 'SSE': 157,
    'S': 180, 'SSW': 202, 'SW': 225, 'WSW': 247,
    'W': 270, 'WNW': 292, 'NW': 315, 'NNW': 337,
}


# ── Pure helpers ───────────────────────────────────────────────────────────────

def _parse_ninjo_time_ms(s):
    """'20260414103000' → Unix timestamp in milliseconds (UTC)."""
    dt = datetime(
        int(s[0:4]), int(s[4:6]),  int(s[6:8]),
        int(s[8:10]), int(s[10:12]), int(s[12:14]),
        tzinfo=timezone.utc,
    )
    return int(dt.timestamp() * 1000)


def _circular_mean_deg(angles):
    """Average a list of angles (degrees) using vector mean. Returns None if empty."""
    if not angles:
        return None
    sin_sum = sum(math.sin(math.radians(a)) for a in angles)
    cos_sum = sum(math.cos(math.radians(a)) for a in angles)
    return round(math.degrees(math.atan2(sin_sum, cos_sum)) % 360, 1)


def _resample_hourly(obs, date_str):
    """
    Resample 10-min obs list to hourly buckets for a given UTC date (YYYY-MM-DD).
    Returns list of {h, wind, [gust], [dir]} sorted by h.
    """
    try:
        day_start = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except ValueError:
        return []

    day_ms_start = int(day_start.timestamp() * 1000)
    day_ms_end   = day_ms_start + 24 * 3600 * 1000

    buckets = {h: {'wind': [], 'gust': [], 'dir': []} for h in range(24)}
    for o in obs:
        t = o.get('t', 0)
        if not (day_ms_start <= t < day_ms_end):
            continue
        h = int((t - day_ms_start) // (3600 * 1000))
        if o.get('wind') is not None:
            buckets[h]['wind'].append(o['wind'])
        if o.get('gust') is not None:
            buckets[h]['gust'].append(o['gust'])
        if o.get('dir') is not None:
            buckets[h]['dir'].append(o['dir'])

    result = []
    for h in range(24):
        b = buckets[h]
        if not b['wind']:
            continue
        entry = {'h': h, 'wind': round(sum(b['wind']) / len(b['wind']), 2)}
        if b['gust']:
            entry['gust'] = round(max(b['gust']), 2)
        cm = _circular_mean_deg(b['dir'])
        if cm is not None:
            entry['dir'] = cm
        result.append(entry)
    return result


# ── AppDaemon app ──────────────────────────────────────────────────────────────

class FetchNinjo(hass.Hass):

    REPO   = 'ncvangilse/vejr'
    BRANCH = 'gh-pages'

    def initialize(self):
        self.token        = self.args['github_token']
        self.obs_history  = None   # dict; loaded lazily on first run
        self.fcst_history = None   # dict; loaded lazily on first forecast run
        self._lock        = asyncio.Lock()

        # Obs ingestion: every 10 minutes, starting immediately
        self.run_every(self._ingest_obs_cb, 'now', 10 * 60)
        # Forecast collection: once daily at 00:05 UTC
        self.run_daily(self._ingest_forecasts_cb, '00:05:00')
        self.log('FetchNinjo initialised — obs every 10 min · forecasts daily 00:05 UTC')

    # ── AppDaemon callback shims (support async) ───────────────────────────────

    async def _ingest_obs_cb(self, kwargs):
        await self._ingest_obs()

    async def _ingest_forecasts_cb(self, kwargs):
        await self._ingest_forecasts()

    # ── GitHub helpers ─────────────────────────────────────────────────────────

    async def _get_sha_map(self, session, gh_headers):
        """Return {filename: sha} for all blobs at the root of BRANCH."""
        try:
            async with session.get(
                f'https://api.github.com/repos/{self.REPO}/git/trees/{self.BRANCH}',
                headers=gh_headers,
            ) as r:
                if r.status == 200:
                    return {e['path']: e['sha']
                            for e in (await r.json()).get('tree', [])}
                self.log(f'WARNING: git/trees returned HTTP {r.status}', level='WARNING')
        except Exception as e:
            self.log(f'WARNING: git/trees fetch failed: {e}', level='WARNING')
        return {}

    async def _push_gz(self, session, gh_headers, sha_map, filename, data, ts):
        """Serialize dict → gzip → base64 → PUT to gh-pages with 409-retry."""
        raw     = gzip.compress(
            json.dumps(data, separators=(',', ':')).encode('utf-8'),
            compresslevel=9,
        )
        content = base64.b64encode(raw).decode()
        sha     = sha_map.get(filename)
        for attempt in range(2):
            payload = {
                'message': f'chore: refresh {filename} {ts} [skip ci]',
                'content': content,
                'branch':  self.BRANCH,
            }
            if sha:
                payload['sha'] = sha
            try:
                async with session.put(
                    f'https://api.github.com/repos/{self.REPO}/contents/{filename}',
                    headers=gh_headers,
                    json=payload,
                ) as r:
                    if r.status == 409 and attempt == 0:
                        self.log(f'409 on {filename} — re-fetching SHA and retrying',
                                 level='WARNING')
                        fresh = await self._get_sha_map(session, gh_headers)
                        sha   = fresh.get(filename)
                        continue
                    r.raise_for_status()
                    self.log(f'{ts}  pushed {filename}  ({len(raw):,} bytes gz)')
                    return
            except Exception as e:
                self.log(f'ERROR pushing {filename}: {e}', level='ERROR')
                return

    # ── State bootstrap ────────────────────────────────────────────────────────

    async def _load_state(self, session):
        """Download and decompress existing history files from gh-pages."""
        for attr, filename in [
            ('obs_history',  'obs-history.json.gz'),
            ('fcst_history', 'forecast-history.json.gz'),
        ]:
            url = f'{RAW_BASE}/{filename}'
            try:
                async with session.get(
                    url, timeout=aiohttp.ClientTimeout(total=30)
                ) as r:
                    if r.status == 200:
                        raw    = await r.read()
                        loaded = json.loads(gzip.decompress(raw))
                        setattr(self, attr, loaded)
                        self.log(f'Loaded {filename}: {len(loaded)} stations')
                    else:
                        setattr(self, attr, {})
                        self.log(f'{filename} not found (HTTP {r.status}) — starting fresh')
            except Exception as e:
                setattr(self, attr, {})
                self.log(f'Could not load {filename}: {e} — starting fresh',
                         level='WARNING')

    # ── Generic JSON fetch ─────────────────────────────────────────────────────

    async def _fetch_json(self, session, url, headers, name):
        try:
            async with session.get(
                url,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as r:
                r.raise_for_status()
                return await r.json(content_type=None)
        except Exception as e:
            self.log(f'ERROR fetching {name}: {e}', level='ERROR')
            return None

    # ── Observation ingestion (every 10 min) ───────────────────────────────────

    async def _ingest_obs(self):
        async with self._lock:
            ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
            gh_headers = {
                'Authorization':        f'Bearer {self.token}',
                'Accept':               'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            }

            async with aiohttp.ClientSession() as session:
                # Bootstrap state on the very first run
                if self.obs_history is None:
                    await self._load_state(session)

                sha_map = await self._get_sha_map(session, gh_headers)

                # Fetch NinJo + Trafikkort in parallel
                ninjo_raw, trafikk_raw = await asyncio.gather(
                    self._fetch_json(session, NINJO_URL,   NINJO_HDRS, 'NinJo'),
                    self._fetch_json(session, TRAFIKK_URL, {},          'Trafikkort'),
                )

                now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
                cutoff = now_ms - OBS_WINDOW_H * 3600 * 1000

                # ── NinJo stations ─────────────────────────────────────────────
                n_ninjo = 0
                if ninjo_raw:
                    for station_id, entry in ninjo_raw.items():
                        vals = entry.get('values', {})
                        wind = vals.get('WindSpeed10m')
                        if wind is None:
                            continue

                        key = f'ninjo:{station_id}'
                        if key not in self.obs_history:
                            self.obs_history[key] = {
                                'name':   entry.get('name', station_id),
                                'lat':    entry.get('latitude'),
                                'lon':    entry.get('longitude'),
                                'source': 'ninjo',
                                'obs':    [],
                            }
                        info = self.obs_history[key]
                        # Refresh name/coords in case they change
                        if entry.get('name'):
                            info['name'] = entry['name']

                        t_ms      = _parse_ninjo_time_ms(entry['time'])
                        obs_entry = {'t': t_ms, 'wind': round(float(wind), 2)}

                        gust = vals.get('WindGustLast10Min') or vals.get('WindGust10m')
                        if gust is not None:
                            obs_entry['gust'] = round(float(gust), 2)
                        direction = vals.get('WindDirection10m')
                        if direction is not None:
                            obs_entry['dir'] = round(float(direction), 1)

                        # Deduplicate by NinJo timestamp
                        obs_list = info['obs']
                        if not obs_list or obs_list[-1]['t'] != t_ms:
                            obs_list.append(obs_entry)
                        n_ninjo += 1

                    # Prune entries older than the rolling window
                    for key, info in self.obs_history.items():
                        if key.startswith('ninjo:'):
                            info['obs'] = [o for o in info['obs'] if o['t'] >= cutoff]

                    self.log(f'{ts}  NinJo: {n_ninjo} stations with wind data')

                # ── Trafikkort features ────────────────────────────────────────
                n_trafikk = 0
                if trafikk_raw:
                    for feature in trafikk_raw.get('features', []):
                        props    = feature.get('properties', {})
                        fid      = props.get('featureId')
                        wind_str = props.get('windSpeed')
                        if not fid or wind_str is None:
                            continue

                        key    = f'trafikkort:{fid}'
                        coords = feature.get('geometry', {}).get('coordinates', [None, None])
                        if key not in self.obs_history:
                            self.obs_history[key] = {
                                'name':   f'Trafikkort {fid}',
                                'lat':    coords[1],
                                'lon':    coords[0],
                                'source': 'trafikkort',
                                'obs':    [],
                            }

                        obs_entry = {'t': now_ms, 'wind': float(wind_str)}
                        dir_str = props.get('windDirection')
                        if dir_str and dir_str in DIR_DEG:
                            obs_entry['dir'] = DIR_DEG[dir_str]

                        # Avoid duplicates within the same fetch minute
                        obs_list = self.obs_history[key]['obs']
                        if not obs_list or abs(obs_list[-1]['t'] - now_ms) > 60_000:
                            obs_list.append(obs_entry)
                        n_trafikk += 1

                    # Prune
                    for key, info in self.obs_history.items():
                        if key.startswith('trafikkort:'):
                            info['obs'] = [o for o in info['obs'] if o['t'] >= cutoff]

                    self.log(f'{ts}  Trafikkort: {n_trafikk} features')

                await self._push_gz(
                    session, gh_headers, sha_map,
                    'obs-history.json.gz', self.obs_history, ts,
                )

    # ── Forecast ingestion (daily at 00:05 UTC) ────────────────────────────────

    async def _ingest_forecasts(self):
        async with self._lock:
            ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
            gh_headers = {
                'Authorization':        f'Bearer {self.token}',
                'Accept':               'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            }

            async with aiohttp.ClientSession() as session:
                if self.obs_history is None:
                    await self._load_state(session)
                if self.fcst_history is None:
                    self.fcst_history = {}

                sha_map = await self._get_sha_map(session, gh_headers)

                yesterday_str = (datetime.now(timezone.utc) - timedelta(days=1)).strftime('%Y-%m-%d')
                cutoff_str    = (datetime.now(timezone.utc) - timedelta(days=FCST_WINDOW_D)).strftime('%Y-%m-%d')

                stations = [
                    (key, info)
                    for key, info in self.obs_history.items()
                    if info.get('lat') is not None and info.get('lon') is not None
                ]
                self.log(f'{ts}  Forecast ingest: {len(stations)} stations')

                # ── Fetch Open-Meteo forecasts in batches ──────────────────────
                for batch_start in range(0, len(stations), FORECAST_BATCH):
                    batch = stations[batch_start:batch_start + FORECAST_BATCH]
                    lats  = ','.join(str(info['lat']) for _, info in batch)
                    lons  = ','.join(str(info['lon']) for _, info in batch)
                    url   = (
                        f'{OPEN_METEO}?latitude={lats}&longitude={lons}'
                        f'&hourly=windspeed_10m,winddirection_10m'
                        f'&forecast_days=2&timezone=UTC&windspeed_unit=ms'
                    )
                    try:
                        async with session.get(
                            url, timeout=aiohttp.ClientTimeout(total=90)
                        ) as r:
                            r.raise_for_status()
                            result = await r.json(content_type=None)
                    except Exception as e:
                        self.log(
                            f'ERROR fetching forecasts batch {batch_start}: {e}',
                            level='ERROR',
                        )
                        await asyncio.sleep(3)
                        continue

                    # Open-Meteo returns a list for multiple coords, single dict for one
                    results = result if isinstance(result, list) else [result]

                    for i, (key, _info) in enumerate(batch):
                        if i >= len(results):
                            break
                        hourly = results[i].get('hourly', {})
                        times  = hourly.get('time', [])
                        speeds = hourly.get('windspeed_10m', [])
                        dirs   = hourly.get('winddirection_10m', [])

                        if key not in self.fcst_history:
                            self.fcst_history[key] = {'days': {}}
                        days = self.fcst_history[key]['days']

                        # Bucket hourly values by calendar date
                        day_fcst = {}
                        for t_str, spd, d in zip(times, speeds, dirs):
                            d_str = t_str[:10]   # "YYYY-MM-DD"
                            if d_str < cutoff_str:
                                continue
                            h = int(t_str[11:13])
                            if d_str not in day_fcst:
                                day_fcst[d_str] = []
                            entry = {'h': h}
                            if spd is not None:
                                entry['wind'] = round(float(spd), 2)
                            if d is not None:
                                entry['dir'] = round(float(d), 1)
                            day_fcst[d_str].append(entry)

                        for d_str, fcst_list in day_fcst.items():
                            if d_str not in days:
                                days[d_str] = {'forecast': [], 'obs_hourly': []}
                            days[d_str]['forecast'] = fcst_list

                    # Polite pause between batches
                    if batch_start + FORECAST_BATCH < len(stations):
                        await asyncio.sleep(1)

                # ── Resample yesterday's obs → hourly and attach ───────────────
                for key, info in self.obs_history.items():
                    if key not in self.fcst_history:
                        self.fcst_history[key] = {'days': {}}
                    days = self.fcst_history[key]['days']
                    if yesterday_str not in days:
                        days[yesterday_str] = {'forecast': [], 'obs_hourly': []}
                    days[yesterday_str]['obs_hourly'] = _resample_hourly(
                        info.get('obs', []), yesterday_str,
                    )

                # ── Prune days outside the 7-day rolling window ────────────────
                for key in self.fcst_history:
                    self.fcst_history[key]['days'] = {
                        d: v
                        for d, v in self.fcst_history[key]['days'].items()
                        if d >= cutoff_str
                    }

                await self._push_gz(
                    session, gh_headers, sha_map,
                    'forecast-history.json.gz', self.fcst_history, ts,
                )
                self.log(f'{ts}  Forecast history: {len(self.fcst_history)} stations · pushed')
