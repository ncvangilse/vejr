# Vejrudsigt 🌤️

A Danish weather forecast web app powered by [DMI](https://www.dmi.dk/) and [Open-Meteo](https://open-meteo.com/) data. Displays hourly forecasts for temperature, precipitation, wind, and more — all in a clean, minimal chart interface.

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

1. **Push the repo to GitHub**
   ```
   git add .
   git commit -m "Initial commit"
   git push
   ```

2. **Enable GitHub Pages**
   - Go to your repository on GitHub
   - Navigate to **Settings → Pages**
   - Under *Branch*, select `main` (or `master`) and folder `/root`
   - Click **Save**

3. **Wait ~1 minute**, then your app will be live at:
   ```
   https://<your-username>.github.io/<repo-name>/vejr.html
   ```

---

## Adding to your iPhone home screen

> **Important:** You must use **Safari** on iOS — other browsers (Chrome, Firefox) do not support Add to Home Screen properly on iPhone.

1. Open **Safari** on your iPhone
2. Go to:
   ```
   https://<your-username>.github.io/<repo-name>/vejr.html
   ```
3. Tap the **Share** button (the box with an arrow pointing up) at the bottom of the screen
4. Scroll down and tap **"Add to Home Screen"**
5. Optionally edit the name (it defaults to **"Vejr"**), then tap **Add**

The app will now appear on your home screen with the weather icon. When launched from there, it opens **full-screen** without the Safari browser UI — just like a native app.

---

## Offline support

After your first visit, the app shell (HTML, icons, fonts) is cached by the Service Worker. This means:

- The app **loads instantly** on subsequent visits
- It still **works without an internet connection** (though live weather data requires a connection)
- Live forecast API calls always go to the network to ensure fresh data

---

## Icon sizes

| File | Size | Used by |
|---|---|---|
| `icon-120.png` | 120×120 | iPhone (2× Retina) |
| `icon-152.png` | 152×152 | iPad (2× Retina) |
| `icon-167.png` | 167×167 | iPad Pro (2× Retina) |
| `icon-180.png` | 180×180 | iPhone (3× Retina) |
