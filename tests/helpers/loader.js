/**
 * Loads one or more vanilla-JS browser scripts into an isolated vm context,
 * simulating the browser globals they expect.  Scripts are concatenated so
 * that const/let declared in an earlier file are in scope for later files
 * (matching how the browser loads them as plain <script> tags).
 *
 * Function declarations become properties of the returned context object,
 * making them callable from tests.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadScripts(...relPaths) {
  const mockWindow = {
    location: { search: '', href: 'http://localhost/' },
    history:  { replaceState: () => {} },
    SHORE_MASK:   null,
    SHORE_STATUS: { state: 'idle', msg: '' },
    SHORE_DEBUG:  null,
  };

  const mockLocalStorage = (() => {
    const store = {};
    return {
      getItem:    (k)      => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
      setItem:    (k, v)   => { store[k] = String(v); },
      removeItem: (k)      => { delete store[k]; },
      clear:      ()       => { Object.keys(store).forEach(k => delete store[k]); },
    };
  })();

  const ctx = vm.createContext({
    window:             mockWindow,
    localStorage:       mockLocalStorage,
    console,
    Math,
    Date,
    Array, Float32Array, Set, Map,
    Number, String, Boolean, Object,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
    URL, URLSearchParams,
    Promise, Error,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    fetch: () => Promise.reject(new Error('fetch not mocked in tests')),
  });

  const combined = relPaths
    .map(p => readFileSync(resolve(ROOT, p), 'utf8'))
    .join('\n');

  vm.runInContext(combined, ctx);
  return ctx;
}
