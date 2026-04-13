# Claude Instructions

## Meta: Keeping This File Updated

**Keep CLAUDE.md current.** After adding/removing files, changing architecture, adding dependencies, or making significant structural changes — update the relevant section below. This file is the primary orientation tool for new sessions; stale info wastes tokens.

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
| `dmi.js` | DMI FriData observation API: nearest station lookup, wind obs fetch, chart overlay |
| `shore.js` | Land/sea pixel analysis for kitesurfing (Terrascope WMS / ESA WorldCover) |
| `radar.js` | RainViewer radar map (Leaflet, frame animation, tile rate limiting) |
| `weather-icons.js` | WMO code → canvas icon renderer |
| `sw.js` | Service Worker (app shell cache, offline support) |
| `manifest.json` | PWA manifest |
| `tests/` | Vitest test files + VM loader helper |
| `.github/workflows/` | `deploy-prod.yml` (auto on main push), `deploy-test.yml` (manual) |

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
- **DMI observations** — `dmi.js` fetches real wind measurements from the nearest DMI automatic weather station (within ~50 km). Only activates for DK/GL/FO. Uses the keyless open-data endpoint `https://opendataapi.dmi.dk/v2/metObs` — no registration needed. Observations (10-min intervals, past 48 h) are overlaid as yellow/orange dots on the wind chart. Status shown in the header next to ensemble status. Non-fatal: silently skipped outside Denmark or when the API is unavailable.
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
| `tests/dmi.test.js` | DMI key storage, haversine, station finder, obs merge, load flow |
| `tests/shore.test.js` | WMS URL builder, pixel classifier, coordinate mapping, mask computation |
