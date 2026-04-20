/**
 * dmi.test.js — DMI API removed
 *
 * The DMI open-data observation API (opendataapi.dmi.dk/v2/metObs) is no
 * longer called by the app.  All observation history is now served via
 * obs-history.json.gz (pre-built by the RPi and pushed to gh-pages), and
 * every map marker is rendered interactively by radar.js directly from that
 * file.
 *
 * dmi.js is now an empty stub and is no longer loaded from vejr.html.
 *
 * Tests that previously covered _dmiHaversine, _dmiFindStation,
 * _dmiObsMultiParam, loadDmiObservations etc. have been removed.
 */

import { describe, it } from 'vitest';

describe('dmi (removed)', () => {
  it('dmi.js is an empty stub — no tests required', () => {
    // Nothing to test; DMI API calls have been replaced by obs-history.json.gz
  });
});

