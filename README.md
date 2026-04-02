# Vejrudsigt 🌤️

A Danish weather forecast web app powered by [DMI](https://www.dmi.dk/) and [Open-Meteo](https://open-meteo.com/) data. Displays hourly forecasts for temperature, precipitation, wind, and more — all in a clean, minimal chart interface.

🔗 **Live app:** https://ncvangilse.github.io/vejr/

---

## Features

- Hourly forecast charts (temperature, precipitation, wind, cloud cover, etc.)
- Multiple DMI model sources selectable from a dropdown
- City search via geocoding
- Works as a **Progressive Web App (PWA)** — installable on your iPhone home screen
- Offline support via Service Worker (app shell is cached after first visit)

---

## Project structure

```
vejr/
├── index.html         # Redirects to vejr.html (required for GitHub Pages root)
├── vejr.html          # Main app (single-page)
├── manifest.json      # Web App Manifest (PWA metadata)
├── sw.js              # Service Worker (caching & offline)
├── .nojekyll          # Disables Jekyll on GitHub Pages
├── icon-assets/
│   ├── icon-120.png   # iPhone home screen icon (120×120)
│   ├── icon-152.png   # iPad home screen icon (152×152)
│   ├── icon-167.png   # iPad Pro home screen icon (167×167)
│   └── icon-180.png   # iPhone home screen icon @3x (180×180)
└── README.md
```

---

## Hosting on GitHub Pages

> ✅ The code is already pushed to GitHub. You just need to **turn on Pages** — that's why you get a 404.

### 1. Enable GitHub Pages (direct link)

👉 **Go directly to:** https://github.com/ncvangilse/vejr/settings/pages

On that page:

1. Under **"Build and deployment"**, open the **Source** dropdown
2. Select **`GitHub Actions`** ← this is important, do NOT use "Deploy from a branch"
3. Click **Save**

> Selecting "GitHub Actions" lets the `deploy.yml` workflow handle the build number injection and deployment automatically on every push.

### 2. Trigger a deployment

The pipeline runs automatically on every push to `main`. To trigger it now:

```
git push
```

You can watch it run live at: https://github.com/ncvangilse/vejr/actions

### 3. Open the app

Once the workflow finishes (usually ~1 minute), the app is live at: **https://ncvangilse.github.io/vejr/**

---

## Adding to your iPhone home screen

> **Important:** You must use **Safari** on iOS — Chrome and Firefox on iPhone do not support "Add to Home Screen" as a proper PWA.

1. Open **Safari** on your iPhone
2. Go to **https://ncvangilse.github.io/vejr/**
3. Tap the **Share** button — the box with an arrow pointing up, at the bottom of the screen
4. Scroll down in the share sheet and tap **"Add to Home Screen"**
5. Optionally edit the name (defaults to **"Vejr"**), then tap **Add**

The app now appears on your home screen with the weather icon. When launched from there, it opens **full-screen** with no browser UI — just like a native app.

---

## Offline support

After the first visit, the app shell (HTML, icons, fonts) is cached by the Service Worker:

- The app **loads instantly** on subsequent visits
- It **works without an internet connection** (live forecast data still needs a connection)
- API calls always bypass the cache to ensure fresh weather data

---

## Build number

The current build number is shown in the top-right corner of the app header (e.g. `build 2026.02.22-3`). Use it to confirm you are running the latest deployed version and not a stale cached copy.

The build number is **injected automatically** by the GitHub Actions pipeline on every push to `main` — you never need to update it manually. The format is `YYYY.MM.DD-N` where `N` is the GitHub Actions run number, incrementing automatically with each deploy.

The pipeline (`.github/workflows/deploy.yml`) does three things on every push:
1. Replaces the `%%BUILD_NUMBER%%` token in `vejr.html` and `sw.js` with the real build number
2. Bumps the Service Worker cache name, forcing clients to download fresh files
3. Deploys the result straight to GitHub Pages

---

## Icon sizes

| File | Size | Used by |
|---|---|---|
| `icon-120.png` | 120×120 | iPhone (2× Retina) |
| `icon-152.png` | 152×152 | iPad (2× Retina) |
| `icon-167.png` | 167×167 | iPad Pro (2× Retina) |
| `icon-180.png` | 180×180 | iPhone (3× Retina) |
