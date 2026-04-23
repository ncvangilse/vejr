# Claude Instructions

## Meta: Keeping This File Updated

**Keep CLAUDE.md current.** After adding/removing files, changing architecture, adding dependencies, or making significant structural changes — update the relevant section below. This file is the primary orientation tool for new sessions; stale info wastes tokens.

---

## CSS Version Bump

**Always bump the CSS version when editing `vejr.css`.** The service worker caches `vejr.css` by URL, so changes won't reach users without a version bump. Update the query string in `vejr.html`:

```html
<link rel="stylesheet" href="vejr.css?v=N">  →  <link rel="stylesheet" href="vejr.css?v=N+1">
```

---

## Testing

Every time a new bug is fixed or a new feature is implemented, write good tests that cover the new behavior or reproduce and confirm the fix.

---

## Repository Overview

**Vejr** is a Danish weather forecast PWA ("vejr" = "weather"). Single-page vanilla JS app with canvas-based charts, ensemble uncertainty visualization, and a kitesurfing suitability analyzer.

### Tech Stack
- **Frontend:** Vanilla JS (ES6 modules), HTML5, CSS3 — no framework, no bundler
- **Charts:** Canvas 2D (no SVG/DOM charting library)
- **Maps:** Leaflet (CDN) for RainViewer radar overlay
- **Testing:** Vitest 2.0 (VM-based, simulates browser globals without JSDOM)
- **Deployment:** GitHub Pages via GitHub Actions CI/CD
- **Data APIs:** Open-Meteo (forecast + ensemble), Nominatim (geocoding), Terrascope WMS (ESA WorldCover land/sea), RainViewer (radar)

### File Map

| File | Purpose |
|---|---|
| `vejr.html` | Single-page app entry point |
| `index.html` | Redirect to vejr.html (GitHub Pages root) |
| `vejr.css` | All styles (responsive, PWA-aware) |
| `app.js` | Main orchestration: load pipeline, render, tooltips, kite dialog |
| `api.js` | Weather/ensemble/geocoding API calls + ensemble percentile math |
| `config.js` | Constants, kite settings, URL↔localStorage sync |
| `charts.js` | Canvas drawing: temp, precip, wind, cloud, kite highlights |
| ~~`dmi.js`~~ | **Removed** — replaced by obs-history.json.gz; file is now an empty stub |
| `shore.js` | Land/sea pixel analysis for kitesurfing (Terrascope WMS / ESA WorldCover) |
| `radar.js` | RainViewer radar map (Leaflet, frame animation, tile rate limiting) |
| `weather-icons.js` | WMO code → canvas icon renderer |
| `sw.js` | Service Worker (app shell cache, offline support) |
| `manifest.json` | PWA manifest |
| `tests/` | Vitest test files + VM loader helper |
| `scripts/fetch-ninjo.py` | AppDaemon app (Home Assistant RPi): builds rolling `obs-history.json.gz` (every 10 min) and `forecast-history.json.gz` (daily) → gzip-compresses and pushes to gh-pages |
| `station-names.json` | Curated Trafikkort station name overrides; keyed by `"trafikkort:<id>"` |
| `.github/workflows/` | `deploy-prod.yml` (auto on main push), `deploy-test.yml` (non-main branches) |
| `.github/ISSUE_TEMPLATE/station-name.yml` | Structured GitHub issue form for proposing Trafikkort station names |

### Data Flow

1. User enters city → `geocode()` → coordinates
2. `fetchWeather()` + `fetchEnsemble()` fire in parallel
3. Time series extracted (3h step for most charts, 1h for precip)
4. Ensemble p10/p50/p90 merged into deterministic data
5. `renderDisplay()` → all canvas charts redrawn
6. `analyseShore()` runs in parallel → fetches ESA WorldCover WMS tile → pixel-classifies 180 bearing sample points

### Key Architectural Decisions

- **No build step** — files served directly; `%%BUILD_NUMBER%%` placeholder replaced by CI (`sed`) before deploy
- **Canvas charts** — all rendered to `<canvas>`, crosshair overlay for tooltips (zero layout reflow)
- **Ensemble bands** — temperature/wind show p10–p90 shaded confidence regions
- **Kite config** — URL params + localStorage bidirectional sync (shareable links + iOS Home Screen survival)
- **Land/sea threshold** — `SHORE_SEA_THRESH` (default 0.75) is a `let` in shore.js, initialised from `KITE_CFG.seaThresh` (config.js loads first). Persisted as `kite_sea_thresh` URL param. Exposed via `window.setShoreSeaThresh` / `window.getShoreSeaThresh`. The kite dialog has a range slider (10–100 %, step 5) that previews the threshold live on the compass and commits it on Apply.
- **DMI observations** — `dmi.js` is an empty stub; the DMI open-data API is no longer called. All wind observation history comes from `obs-history.json.gz` (pushed every 10 min by the RPi). Every marker on the radar map (both NinJo and Trafikkort) is fully interactive: clicking opens a popup with the station name, latest wind/gust/direction, model bias (if available), and a 24 h canvas mini-chart rendered directly from `obs-history.json.gz`. No DMI API key or network call is needed.
- **Radar map wind stations** — `radar.js` fetches `obs-history.json.gz` (RPi-uploaded, same-origin) via `fetchObsHistory()` using `DecompressionStream('gzip')`. All stations (NinJo and Trafikkort) get fully interactive markers with a popup containing a 24 h canvas mini-chart and a forecast bias row. Bias is pre-computed by the RPi and embedded as `station.bias = { wind, n }` in `obs-history.json.gz`. `ninjo-stations.json` and `wind-speeds.json` are no longer pushed.
- **Trafikkort name overrides** — `station-names.json` in the repo root maps station keys (`"trafikkort:<id>"`) to curated display names, fetched in parallel with `obs-history.json.gz`. When an override exists it supersedes Nominatim reverse-geocoding. Users can propose names via a ✏ pencil link in the popup (opens a pre-filled GitHub issue); the owner accepts by adding the entry to `station-names.json` via commit/PR.
- **Land/sea analysis** — single Terrascope WMS `GetMap` request (512×512 PNG) for a ~12 km bbox; pixel RGB matched against ESA WorldCover official class colours (class 80 water = rgb(0,100,200), class 90 wetland = rgb(0,150,160)); no new library required
- **iOS inverted colors** — canvas pixels pre-inverted in JS to survive OS double-inversion
- **Service Worker strategy** — network-only for all API calls, network-first for app files, cache-first for static assets

### Running Locally

```bash
npm ci          # install Vitest (only dependency)
npm test        # run tests once
npm run test:watch  # watch mode
```

Open `vejr.html` directly in browser (no dev server needed; SW requires localhost or HTTPS).

### Test Structure

Tests use a VM-based loader (`tests/helpers/loader.js`) that concatenates source files and runs them in a Node VM with mocked browser globals (`fetch`, `localStorage`, `window`, `document`).

| Test file | Covers |
|---|---|
| `tests/app.test.js` | Load pipeline, render, kite settings |
| `tests/api.test.js` | Ensemble percentile calculations |
| `tests/config.test.js` | Kite config parsing, URL sync |
| ~~`tests/dmi.test.js`~~ | DMI API removed — file now contains a single no-op stub test |
| `tests/shore.test.js` | WMS URL builder, pixel classifier, coordinate mapping, mask computation |
| `tests/radar.test.js` | Nominatim name parsing, station name URL builder, `fetchStationNames` |
