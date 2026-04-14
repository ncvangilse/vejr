const CACHE_NAME = 'vejr-2026.04.14-41-nchvg-dmi_obs_batch_fetch-5';

// Only cache truly static assets — never the HTML or SW itself
const ASSETS = [
  'icon-assets/icon-120.png',
  'icon-assets/icon-152.png',
  'icon-assets/icon-167.png',
  'icon-assets/icon-180.png',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600;700&display=swap'
];

// Install: pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   - HTML files      → network-first (always get fresh build number)
//   - JS / CSS files  → network-first (always get latest code)
//   - API requests    → network-only  (always live data)
//   - everything else → cache-first   (icons, fonts)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept non-GET requests (POST etc.) — Cache API doesn't support them
  if (event.request.method !== 'GET') return;

  // Network-only: weather APIs, radar, geocoding, CORS proxies, and Overpass (must always be live)
  if (
    url.hostname.includes('dmi.dk') ||
    url.hostname.includes('open-meteo.com') ||
    url.hostname.includes('nominatim') ||
    url.hostname.includes('rainviewer.com') ||
    url.hostname.includes('overpass-api.de') ||
    url.hostname.includes('overpass.kumi.systems') ||
    url.hostname.includes('allorigins.win') ||   // NinJo CORS proxy
    url.hostname.includes('corsproxy.io')         // NinJo CORS proxy fallback
  ) {
    // Let the browser handle these directly — no SW interception, no caching.
    return;
  }

  // Network-first: HTML pages and JS/CSS (so updates are always live)
  if (
    event.request.destination === 'document' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css')
  ) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then(
          r => r || new Response('', { status: 503, statusText: 'Offline' })
        )
      )
    );
    return;
  }

  // Cache-first: static assets (icons, fonts, manifest)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Only cache successful same-origin or CORS-enabled responses.
        if (!response || response.status !== 200 || response.type === 'error') return response;
        return caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, response.clone());
          return response;
        });
      });
    }).catch(() => fetch(event.request))
  );
});
