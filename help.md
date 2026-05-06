## About

**kitevibe** is a free, no-ads weather and kitesurfing forecast app. No tracking, no enshitification — just a useful tool, given freely.

The name reflects how it was made: written with vibe coding, with the goal of spreading a positive vibe and giving people a genuinely good tool for free.

## Add to your home screen

**iPhone / iPad:** Open the page in Safari, tap the Share icon (□↑), then choose **Add to Home Screen**. The app will open full-screen like a native app — and your settings are saved between visits.

**Android:** Open in Chrome, tap the three-dot menu (⋮), then tap **Add to Home Screen** or **Install app**.

## Weather forecast

Type a city name in the search bar and press Enter to load the 7-day forecast. Use the model dropdown to switch between weather models (DMI HARMONIE, ECMWF IFS, NOAA GFS, etc.).

The charts show, from top to bottom:

- **Weather icons & time** — daily summary icons and the hour-by-hour timeline
- **Temperature & precipitation** — temperature curve with a light-blue uncertainty band (model ensemble spread) and precipitation bars
- **Wind direction** — compass bearing over time; coloured track shows ensemble spread
- **Wind speed & gusts** — white line = forecast wind speed; colour-coded fill below (blue = light, green = moderate, purple/dark = strong); lighter coloured band above the line = forecast gust range

Tap or hover on any chart to see exact values for that hour.

## Ensemble uncertainty

The shaded bands on the temperature and wind charts come from running the same forecast with slightly different starting conditions (an ensemble). A narrow band means the models agree; a wide band means the forecast is uncertain. Trust wide-band forecasts less.

## Radar map

Below the charts is a live radar map showing recent precipitation from RainViewer. Press **▶ Play** to animate the last hour of radar frames.

Weather station markers are overlaid on the map:

- **DMI obs** — Danish Meteorological Institute observation stations
- **Trafikinfo** — road-traffic weather stations from Vejdirektoratet

Tap any marker to open a popup with the station name, latest wind speed and direction, model bias, and a 24-hour mini wind chart.

The **location pin** on the radar map is draggable — drag it to your exact kite spot to update the forecast and sea bearing analysis for that position.

## Kitesurfing analysis

Tap **⚙ 🪁** to open the kitesurfing settings. Configure:

- Your preferred wind speed range (m/s) for good kite conditions
- Which wind directions are flyable (drag on the compass rose to select bearings)
- The sea threshold — how much open water a direction must have to count

When good conditions are forecast, those hours are highlighted in green on the wind chart.

## Sea bearings

The compass rose in the kitesurfing settings shows which directions have enough open water for safe kitesurfing. The app fetches an ESA WorldCover satellite land-cover map around your location and classifies each compass bearing by the fraction of open water in that direction.

A bearing is marked as "sea" when the water fraction exceeds the **sea threshold** (adjustable from 10 % to 100 % with the slider). A lower threshold accepts more marginal directions; a higher threshold requires mostly open water.

## Kite spots

Kite spots are saved locations with pre-configured sea bearings. They appear as 🪁 markers on the radar map.

**Curated spots** are built into the app and cover well-known kitesurfing beaches. Tap a 🪁 marker and press **Use this spot** to load the forecast and apply its sea bearings. Dragging the location pin within 2 km of a curated spot snaps it to that spot automatically.

**Creating your own spot:** Right-click (desktop) or long-press (mobile) on any point on the radar map, then choose **Create kite spot**. Give the spot a name, drag on the compass to select the sea bearings, and tap **Save spot**. The spot is saved locally on your device and a pre-filled GitHub issue opens so you can propose it for inclusion in the curated list.

## Trafikkort station names

Trafikinfo weather stations sometimes have unhelpful auto-generated names. If you see a poorly named station, tap the **✏ pencil link** in its popup to open a pre-filled GitHub issue proposing a better name. The owner reviews it and adds the curated name to the app.

