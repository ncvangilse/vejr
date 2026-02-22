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

1. Under **"Build and deployment"**, find the **Source** dropdown
2. Change it from `Deploy from a branch` (it should already say this) — make sure it's set
3. Under **Branch**, open the first dropdown and select **`main`**
4. Leave the second dropdown as **`/ (root)`**
5. Click **Save**

> If you see **"GitHub Pages is currently disabled"** or the branch dropdown is set to `None`, that's the problem — just set it to `main` and save.

### 2. Wait for deployment

- GitHub will run a short deployment (usually 1–2 minutes)
- Refresh the same Settings → Pages page after a minute
- You will see a box at the top saying:

  > **"Your site is live at https://ncvangilse.github.io/vejr/"**

  with a **"Visit site"** button next to it. That's how you know it worked.

### 3. Open the app

Once live, the app is at: **https://ncvangilse.github.io/vejr/**

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

The current build number is shown in the top-right corner of the app header (e.g. `build 2026.02.22-1`). Use it to confirm you are running the latest deployed version and not a stale cached copy.

When making a new deployment, update **both** of these to the same value:

| File | What to change |
|---|---|
| `vejr.html` | The text inside `<div id="build-number">` |
| `sw.js` | The `CACHE_NAME` constant on line 1 |

Format: `YYYY.MM.DD-N` where `N` increments if there are multiple deploys on the same day (e.g. `2026.02.22-2`).

---

## Icon sizes

| File | Size | Used by |
|---|---|---|
| `icon-120.png` | 120×120 | iPhone (2× Retina) |
| `icon-152.png` | 152×152 | iPad (2× Retina) |
| `icon-167.png` | 167×167 | iPad Pro (2× Retina) |
| `icon-180.png` | 180×180 | iPhone (3× Retina) |
