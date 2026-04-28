import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadSW() {
  let fetchHandler = null;
  const mockCache = { addAll: () => Promise.resolve(), put: () => Promise.resolve() };
  const mockCaches = {
    open:   () => Promise.resolve(mockCache),
    match:  () => Promise.resolve(null),
    keys:   () => Promise.resolve([]),
    delete: () => Promise.resolve(),
  };
  const mockSelf = {
    addEventListener: (type, handler) => {
      if (type === 'fetch') fetchHandler = handler;
    },
    skipWaiting: () => {},
    clients: { claim: () => {} },
  };

  const src = readFileSync(resolve(ROOT, 'sw.js'), 'utf8');
  const ctx = vm.createContext({
    self: mockSelf,
    caches: mockCaches,
    fetch: () => Promise.resolve(new Response('')),
    URL, Response,
  });
  vm.runInContext(src, ctx);
  return { fetchHandler, mockCaches };
}

function makeFetchEvent(url, { method = 'GET', destination = '' } = {}) {
  let responded = false;
  return {
    request: { url, method, destination },
    respondWith: () => { responded = true; },
    get _responded() { return responded; },
  };
}

describe('service worker fetch routing', () => {
  let fetchHandler;
  beforeEach(() => {
    ({ fetchHandler } = loadSW());
  });

  it('does NOT intercept obs-history.json.gz (raw.githubusercontent.com)', () => {
    const evt = makeFetchEvent(
      'https://raw.githubusercontent.com/ncvangilse/vejr/data/obs-history.json.gz',
    );
    fetchHandler(evt);
    expect(evt._responded).toBe(false);
  });

  it('does NOT intercept forecast-history.json.gz (raw.githubusercontent.com)', () => {
    const evt = makeFetchEvent(
      'https://raw.githubusercontent.com/ncvangilse/vejr/data/forecast-history.json.gz',
    );
    fetchHandler(evt);
    expect(evt._responded).toBe(false);
  });

  it('does NOT intercept open-meteo API calls', () => {
    const evt = makeFetchEvent('https://api.open-meteo.com/v1/forecast?lat=55&lon=12');
    fetchHandler(evt);
    expect(evt._responded).toBe(false);
  });

  it('intercepts vejr.html with respondWith (network-first)', () => {
    const evt = makeFetchEvent('https://example.github.io/vejr.html', { destination: 'document' });
    fetchHandler(evt);
    expect(evt._responded).toBe(true);
  });

  it('intercepts icon PNG with respondWith (cache-first)', () => {
    const evt = makeFetchEvent('https://example.github.io/icon-assets/icon-120.png');
    fetchHandler(evt);
    expect(evt._responded).toBe(true);
  });

  it('does NOT intercept non-GET requests', () => {
    const evt = makeFetchEvent(
      'https://raw.githubusercontent.com/ncvangilse/vejr/data/obs-history.json.gz',
      { method: 'POST' },
    );
    fetchHandler(evt);
    expect(evt._responded).toBe(false);
  });
});
