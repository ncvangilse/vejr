# Test Fixtures — Raw Overpass Responses

This directory holds real-world Overpass API responses captured from the browser.
They allow `processShoreData` to be unit-tested with actual OSM topology.

## How to capture a fixture

1. Open the app in a browser and navigate to the location you want to test.
2. Wait for the shore analysis to complete (the compass widget appears).
3. Open DevTools console and run:
   ```js
   copy(JSON.stringify(window.SHORE_DEBUG.rawOverpassData))
   ```
4. Paste the clipboard contents into a new file in this directory, e.g.:
   ```
   tests/fixtures/vordingborg.json
   ```

## How to write a fixture test

In `tests/shore.test.js`, import the fixture and call `processShoreData`:

```js
import vordingborgData from './fixtures/vordingborg.json' assert { type: 'json' };

it('north of Vordingborg is land', () => {
  const lat = 55.008, lon = 11.9106;
  const bbox = expandBbox(lat, lon, 6);
  const { mask, originIsLand } = processShoreData(lat, lon, vordingborgData, bbox);

  // Origin (town centre) should be land
  expect(originIsLand).toBe(true);
  // Bearing 0° (north) = Sjælland mainland — must NOT be mostly sea
  expect(mask[0]).toBeLessThan(0.5);
  // Bearing 180° (south) = Storstrøm / open water — should be mostly sea
  expect(mask[18]).toBeGreaterThanOrEqual(0.5);
});
```

## Existing fixtures

*(none yet — capture from browser as described above)*
