#!/usr/bin/env python3
"""
AppDaemon app — rolling observation history + daily forecast collection.

Pushes one gzip-compressed JSON file to gh-pages:

  obs-history.json.gz  (every 10 min)
    Rolling 24-hour window of 10-min wind observations for every NinJo and
    Trafikkort station in Denmark.  Updated with forecast bias once per day.
    Schema:
      {
        "ninjo:<stationId>": {
          "name": "...", "lat": 55.6, "lon": 12.6, "source": "ninjo",
          "obs":  [{"t": <unix_ms>, "wind": 5.1, "gust": 7.2, "dir": 270}, ...],
          "bias": {"wind": 1.3, "n": 84}   ← added daily, absent until day 1
        },
        "trafikkort:<featureId>": {
          "name": "Trafikkort 1018", "lat": ..., "lon": ..., "source": "trafikkort",
          "obs":  [{"t": <unix_ms>, "wind": 3.0, "dir": 135}, ...]
        }
      }

Local state (never pushed to gh-pages):
  obs-history-local.json.gz   — written next to this file after every obs push
  fcst-history-local.json.gz  — written after every daily forecast ingest

  Both files are restored on startup (disk → gh-pages fallback → empty dict),
  so a crash or AppDaemon restart loses at most one 10-min obs cycle and never
  loses the 7-day forecast window needed for bias computation.

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
from pathlib import Path

import aiohttp
import appdaemon.plugins.hass.hassapi as hass
import pandas as pd

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

# Local state files — persisted next to the app file so crashes / restarts
# don't lose accumulated history.  fcst-history is never pushed to gh-pages
# so local persistence is the only way to survive a restart.
_APP_DIR   = Path(__file__).parent
STATE_FILES = {
    'obs_history':  _APP_DIR / 'obs-history-local.json.gz',
    'fcst_history': _APP_DIR / 'fcst-history-local.json.gz',
}

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



def _resample_hourly(obs, date_str):
    """
    Resample 10-min obs list to hourly buckets for a given UTC date (YYYY-MM-DD).
    Returns list of {h, wind, [gust], [dir]} sorted by h.
    Uses pandas for time-series resampling.
    """
    if not obs:
        return []
    try:
        day_start = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except ValueError:
        return []

    day_ms_start = int(day_start.timestamp() * 1000)
    day_ms_end   = day_ms_start + 24 * 3600 * 1000

    df = pd.DataFrame(obs)
    df = df[(df['t'] >= day_ms_start) & (df['t'] < day_ms_end)].copy()
    if df.empty:
        return []

    df['ts'] = pd.to_datetime(df['t'], unit='ms', utc=True)
    df = df.set_index('ts')

    result = []
    for col in ('wind', 'gust', 'dir'):
        if col not in df.columns:
            df[col] = float('nan')

    # Mean wind, max gust, circular-mean direction — all per hour
    hourly_wind = df['wind'].resample('1h').mean()
    hourly_gust = df['gust'].resample('1h').max()

    # Circular mean for direction per hour
    def _circ_mean(angles):
        valid = angles.dropna()
        if valid.empty:
            return float('nan')
        rad = valid.apply(math.radians)
        return round(math.degrees(math.atan2(rad.apply(math.sin).sum(),
                                             rad.apply(math.cos).sum())) % 360, 1)

    hourly_dir = df['dir'].resample('1h').apply(_circ_mean)

    for ts, wind in hourly_wind.items():
        if pd.isna(wind):
            continue
        h = ts.hour
        entry = {'h': h, 'wind': round(wind, 2)}
        gust = hourly_gust.get(ts)
        if gust is not None and not pd.isna(gust):
            entry['gust'] = round(gust, 2)
        d = hourly_dir.get(ts)
        if d is not None and not pd.isna(d):
            entry['dir'] = d
        result.append(entry)

    return sorted(result, key=lambda x: x['h'])


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

    # ── State persistence (local disk) ────────────────────────────────────────

    def _save_local(self, attr):
        """Persist one history dict to disk as gzip-compressed JSON (atomic write)."""
        path = STATE_FILES[attr]
        data = getattr(self, attr)
        if data is None:
            return
        try:
            tmp = path.with_suffix('.tmp')
            tmp.write_bytes(
                gzip.compress(
                    json.dumps(data, separators=(',', ':')).encode('utf-8'),
                    compresslevel=6,
                )
            )
            tmp.replace(path)   # atomic on POSIX
        except Exception as e:
            self.log(f'WARNING: could not save {path.name}: {e}', level='WARNING')

    def _load_local(self, attr):
        """Try to restore a history dict from the local gzip file. Returns True on success."""
        path = STATE_FILES[attr]
        if not path.exists():
            return False
        try:
            loaded = json.loads(gzip.decompress(path.read_bytes()))
            setattr(self, attr, loaded)
            self.log(f'Restored {path.name} from disk: {len(loaded)} stations')
            return True
        except Exception as e:
            self.log(f'WARNING: could not read {path.name}: {e} — will re-bootstrap',
                     level='WARNING')
            return False

    # ── State bootstrap (remote fallback) ─────────────────────────────────────

    async def _load_state(self, session):
        """
        Populate obs_history and fcst_history.
        Priority:
          1. Local disk (fast, always preferred — survives crashes with no network)
          2. gh-pages raw URL for obs-history (first deploy / disk wiped)
          3. Empty dict (fresh start)
        fcst_history is never on gh-pages, so local disk or empty are the only options.
        """
        for attr, filename in [
            ('obs_history',  'obs-history.json.gz'),
            ('fcst_history', None),   # not on gh-pages
        ]:
            if getattr(self, attr) is not None:
                continue   # already loaded (shouldn't happen, but be safe)

            # 1. Local disk
            if self._load_local(attr):
                continue

            # 2. gh-pages remote (obs-history only)
            if filename:
                url = f'{RAW_BASE}/{filename}'
                try:
                    async with session.get(
                        url, timeout=aiohttp.ClientTimeout(total=30)
                    ) as r:
                        if r.status == 200:
                            raw    = await r.read()
                            loaded = json.loads(gzip.decompress(raw))
                            setattr(self, attr, loaded)
                            self.log(f'Bootstrapped {filename} from gh-pages: {len(loaded)} stations')
                            self._save_local(attr)   # write to disk immediately
                            continue
                        self.log(f'{filename} not on gh-pages (HTTP {r.status}) — starting fresh')
                except Exception as e:
                    self.log(f'Could not fetch {filename} from gh-pages: {e}',
                             level='WARNING')

            # 3. Fresh start
            setattr(self, attr, {})
            self.log(f'{attr} initialised as empty dict')

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
                if self.obs_history is None:
                    await self._load_state(session)

                sha_map = await self._get_sha_map(session, gh_headers)

                ninjo_raw, trafikk_raw = await asyncio.gather(
                    self._fetch_json(session, NINJO_URL,   NINJO_HDRS, 'NinJo'),
                    self._fetch_json(session, TRAFIKK_URL, {},          'Trafikkort'),
                )

                now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
                cutoff = now_ms - OBS_WINDOW_H * 3600 * 1000

                new_frames = []   # new-obs DataFrames from both sources

                # ── NinJo stations ─────────────────────────────────────────────
                if ninjo_raw:
                    df = pd.DataFrame.from_dict(ninjo_raw, orient='index')
                    vals = pd.json_normalize(df['values'].tolist())
                    vals.index = df.index
                    df = df.drop(columns=['values']).join(vals)
                    df = df[df['WindSpeed10m'].notna()].copy()

                    df['key']  = 'ninjo:' + df.index.astype(str)
                    df['t']    = df['time'].apply(_parse_ninjo_time_ms)
                    df['wind'] = df['WindSpeed10m'].astype(float).round(2)

                    # gust: prefer WindGustLast10Min, fallback to WindGust10m
                    gust = df.get('WindGustLast10Min',
                                  pd.Series(float('nan'), index=df.index))
                    if 'WindGust10m' in df.columns:
                        gust = gust.fillna(df['WindGust10m'])
                    df['gust'] = gust.astype(float).round(2)

                    df['dir'] = (df['WindDirection10m'].astype(float).round(1)
                                 if 'WindDirection10m' in df.columns
                                 else float('nan'))

                    # Upsert station metadata (name/lat/lon may change over time)
                    for sid, row in df.iterrows():
                        key = row['key']
                        self.obs_history.setdefault(key, {
                            'name':   row.get('name', sid),
                            'lat':    row.get('latitude'),
                            'lon':    row.get('longitude'),
                            'source': 'ninjo',
                            'obs':    [],
                        })
                        if pd.notna(row.get('name', float('nan'))):
                            self.obs_history[key]['name'] = row['name']

                    new_frames.append(df[['key', 't', 'wind', 'gust', 'dir']])
                    self.log(f'{ts}  NinJo: {len(df)} stations with wind data')

                # ── Trafikkort features ────────────────────────────────────────
                if trafikk_raw:
                    fdf = pd.json_normalize(trafikk_raw.get('features', []))
                    fdf = fdf[
                        fdf['properties.windSpeed'].notna() &
                        fdf['properties.featureId'].notna()
                    ].copy()

                    fdf['key']  = 'trafikkort:' + fdf['properties.featureId'].astype(str)
                    fdf['t']    = now_ms
                    fdf['wind'] = fdf['properties.windSpeed'].astype(float)
                    fdf['dir']  = fdf['properties.windDirection'].map(DIR_DEG)
                    fdf['lat']  = fdf['geometry.coordinates'].apply(
                        lambda c: c[1] if isinstance(c, list) and len(c) >= 2 else None)
                    fdf['lon']  = fdf['geometry.coordinates'].apply(
                        lambda c: c[0] if isinstance(c, list) and len(c) >= 2 else None)

                    for _, row in fdf.iterrows():
                        self.obs_history.setdefault(row['key'], {
                            'name':   f"Trafikkort {row['properties.featureId']}",
                            'lat':    row['lat'],
                            'lon':    row['lon'],
                            'source': 'trafikkort',
                            'obs':    [],
                        })

                    new_frames.append(fdf[['key', 't', 'wind', 'dir']])
                    self.log(f'{ts}  Trafikkort: {len(fdf)} features')

                # ── Merge new obs into history, dedup & prune (all sources) ────
                if new_frames:
                    new_df = pd.concat(new_frames, ignore_index=True)

                    for key, grp in new_df.groupby('key'):
                        info = self.obs_history.get(key)
                        if info is None:
                            continue

                        existing = (pd.DataFrame(info['obs'])
                                    if info['obs']
                                    else pd.DataFrame(columns=['t']))
                        combined = pd.concat(
                            [existing, grp.drop(columns='key')],
                            ignore_index=True,
                        )

                        if key.startswith('trafikkort:'):
                            # Deduplicate within a 60-second bucket
                            combined['_t_min'] = combined['t'] // 60_000
                            combined = (combined
                                        .drop_duplicates(subset=['_t_min'], keep='first')
                                        .drop(columns='_t_min'))
                        else:
                            # NinJo: exact timestamp dedup
                            combined = combined.drop_duplicates(subset=['t'], keep='last')

                        combined = (combined[combined['t'] >= cutoff]
                                    .sort_values('t')
                                    .reset_index(drop=True)
                                    .dropna(axis=1, how='all'))

                        info['obs'] = [
                            {k: v for k, v in rec.items() if pd.notna(v)}
                            for rec in combined.to_dict('records')
                        ]

                await self._push_gz(
                    session, gh_headers, sha_map,
                    'obs-history.json.gz', self.obs_history, ts,
                )
                self._save_local('obs_history')

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
                    await self._load_state(session)

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

                        if not times:
                            continue

                        # Parse all hourly rows at once with pandas
                        df_f = pd.DataFrame({'time': times, 'wind': speeds, 'dir': dirs})
                        df_f['date'] = df_f['time'].str[:10]
                        df_f['h']    = df_f['time'].str[11:13].astype(int)
                        df_f = df_f[df_f['date'] >= cutoff_str][['date', 'h', 'wind', 'dir']]
                        df_f['wind'] = pd.to_numeric(df_f['wind'], errors='coerce').round(2)
                        df_f['dir']  = pd.to_numeric(df_f['dir'],  errors='coerce').round(1)

                        self.fcst_history.setdefault(key, {'days': {}})
                        days = self.fcst_history[key]['days']

                        for date, grp in df_f.groupby('date'):
                            clean   = grp[['h', 'wind', 'dir']].dropna(subset=['wind'])
                            records = [
                                {k: v for k, v in rec.items() if pd.notna(v)}
                                for rec in clean.to_dict('records')
                            ]
                            days.setdefault(date, {'forecast': [], 'obs_hourly': []})
                            days[date]['forecast'] = records

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

                # ── Compute per-station bias and embed into obs-history ─────────
                # bias = mean(forecast_wind − obs_hourly_wind) over all paired hours
                # in the rolling 7-day window.  Requires ≥ 6 paired hours.
                # Stored as obs_history[key]['bias'] = {'wind': float, 'n': int}
                # so the frontend can read it from obs-history.json.gz directly.
                n_bias = 0
                for key, fh_entry in self.fcst_history.items():
                    rows = []
                    for day in fh_entry.get('days', {}).values():
                        fcst = day.get('forecast',   [])
                        obs  = day.get('obs_hourly', [])
                        if not fcst or not obs:
                            continue
                        df_f = pd.DataFrame(fcst)[['h', 'wind']].rename(columns={'wind': 'f_wind'})
                        df_o = pd.DataFrame(obs)[['h', 'wind']].rename(columns={'wind': 'o_wind'})
                        merged = df_f.merge(df_o, on='h').dropna(subset=['f_wind', 'o_wind'])
                        merged['diff'] = merged['f_wind'] - merged['o_wind']
                        rows.append(merged[['diff']])

                    if key in self.obs_history:
                        if rows:
                            combined = pd.concat(rows, ignore_index=True)
                            n = len(combined)
                            if n >= 6:
                                self.obs_history[key]['bias'] = {
                                    'wind': round(float(combined['diff'].mean()), 2),
                                    'n':    n,
                                }
                                n_bias += 1
                            else:
                                self.obs_history[key].pop('bias', None)
                        else:
                            self.obs_history[key].pop('bias', None)

                self.log(f'{ts}  Forecast history: {len(self.fcst_history)} stations · bias computed for {n_bias}')
                # forecast-history is kept in memory for next day's resampling
                # but is NOT pushed to gh-pages — bias lives in obs-history.json.gz.

                # Push updated obs-history (now containing fresh bias values)
                await self._push_gz(
                    session, gh_headers, sha_map,
                    'obs-history.json.gz', self.obs_history, ts,
                )
                # Persist both dicts locally so a crash/restart doesn't lose
                # the 7-day forecast history (which is never on gh-pages).
                self._save_local('obs_history')
                self._save_local('fcst_history')
