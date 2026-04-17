#!/usr/bin/env python3
"""
AppDaemon app — fetches DMI NinJo station data and Trafikkort wind-speeds every
15 min and pushes both to the vejr GitHub Pages (gh-pages branch).

Installation (Home Assistant AppDaemon add-on — a0d7b954):
  All paths are under /root/addon_configs/a0d7b954_appdaemon/

  1. App file (already done if you see it reloading):
       apps/fetch_ninjo.py

  2. apps/apps.yaml entry (already done):
       fetch_ninjo:
         module:       fetch_ninjo
         class:        FetchNinjo
         log:          fetch_ninjo_log
         github_token: !secret ninjo_github_token

  3. secrets.yaml  ← required for !secret to resolve:
       ninjo_github_token: ghp_YOUR_TOKEN_HERE

     (Fine-grained PAT: Contents = Read+write on ncvangilse/vejr only)
     If this file is missing, AppDaemon silently drops the whole app entry
     and logs "No app description found".

  4. appdaemon.yaml — add under the top-level `logs:` key:
       logs:
         fetch_ninjo_log:
           name:     FetchNinjo
           filename: /root/addon_configs/a0d7b954_appdaemon/logs/fetch_ninjo.log
           format:   "{asctime} {message}"

     If fetch_ninjo_log is not defined here, the log: key in apps.yaml
     will also prevent the app from loading.

  Fix order: add secrets.yaml first, then the log entry, then reload.
"""

import asyncio
import base64
from datetime import datetime, timezone

import aiohttp
import appdaemon.plugins.hass.hassapi as hass

SOURCES = [
    {
        'url':  ('https://www.dmi.dk/NinJo2DmiDk/ninjo2dmidk'
                 '?cmd=obj&south=54.1&north=57.9&west=5.5&east=17.9'),
        'file': 'ninjo-stations.json',
        'headers': {'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36'},
    },
    {
        'url':  ('https://storage.googleapis.com/trafikkort-data'
                 '/geojson/wind-speeds.point.json'),
        'file': 'wind-speeds.json',
        'headers': {},
    },
]


class FetchNinjo(hass.Hass):

    REPO   = 'ncvangilse/vejr'
    BRANCH = 'gh-pages'

    def initialize(self):
        self.token = self.args['github_token']
        # Fire immediately, then repeat every 15 minutes.
        self.run_every(self.fetch_and_push, 'now', 15 * 60)
        self.log('FetchNinjo initialised — will push every 15 min')

    async def _get_sha_map(self, session, gh_headers):
        """Return {filename: sha} for all blobs at the root of BRANCH."""
        try:
            async with session.get(
                f'https://api.github.com/repos/{self.REPO}/git/trees/{self.BRANCH}',
                headers=gh_headers,
            ) as r:
                if r.status == 200:
                    return {e['path']: e['sha'] for e in (await r.json()).get('tree', [])}
                self.log(f'WARNING: git/trees returned HTTP {r.status}', level='WARNING')
        except Exception as e:
            self.log(f'WARNING: git/trees fetch failed: {e}', level='WARNING')
        return {}

    async def fetch_and_push(self, kwargs):
        ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ')

        gh_headers = {
            'Authorization':        f'Bearer {self.token}',
            'Accept':               'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        }

        async with aiohttp.ClientSession() as session:
            sha_map = await self._get_sha_map(session, gh_headers)
            await asyncio.gather(*(
                self._update_file(session, gh_headers, src, ts, sha_map)
                for src in SOURCES
            ))

    async def _update_file(self, session, gh_headers, src, ts, sha_map):
        url      = src['url']
        filename = src['file']

        # 1. Fetch source data ─────────────────────────────────────────────────
        try:
            async with session.get(
                url,
                headers=src['headers'],
                timeout=aiohttp.ClientTimeout(total=30),
            ) as r:
                r.raise_for_status()
                raw = await r.read()
        except Exception as e:
            self.log(f'ERROR fetching {filename}: {e}', level='ERROR')
            return

        self.log(f'{ts}  {filename}  {len(raw):,} bytes')

        # 2+3. Push to gh-pages, retrying once on 409 with a fresh SHA ─────────
        content = base64.b64encode(raw).decode()
        sha     = sha_map.get(filename)          # from pre-fetched tree (no size limit)
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
                        # Re-fetch SHA in case another process committed in between
                        self.log(f'409 on {filename} — re-fetching SHA and retrying', level='WARNING')
                        fresh = await self._get_sha_map(session, gh_headers)
                        sha   = fresh.get(filename)
                        continue
                    r.raise_for_status()
                    self.log(f'{ts}  pushed → {self.REPO}/{filename}@{self.BRANCH}')
                    return
            except Exception as e:
                self.log(f'ERROR pushing {filename}: {e}', level='ERROR')
                return







