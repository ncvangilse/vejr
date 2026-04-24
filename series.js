/* ══════════════════════════════════════════════════
   PORTRAIT-AWARE RENDERING
   In portrait mode the full remaining forecast is shown in a scrollable
   canvas — each 1-hour slot is PORTRAIT_COL_W px wide (one icon per slot)
   so the current day is shown at the finest available time resolution,
   and the user can swipe to travel through time.
══════════════════════════════════════════════════ */
const PORTRAIT_COL_W = 30; // px per slot in portrait scroll mode (ICON_H=36, visible content ~24px fits with ~6px gap)

function slicePercentilesFrom(obj, start, n) {
  if (!obj) return null;
  return { p10: obj.p10.slice(start, start + n), p50: obj.p50.slice(start, start + n), p90: obj.p90.slice(start, start + n) };
}

/**
 * Compute CSS x-center positions for each 1h data point on the variable-resolution
 * display grid.  Each display slot has width portraitColW px; a 1h point that falls
 * at offset t within a slot of duration D gets centered at:
 *   x = (slotIndex + 0.5 + t / D) * portraitColW
 * The +0.5 shifts the slot-start time to the slot centre, matching where icons,
 * wind arrows and tick marks are drawn, so all chart rows align on the same x axis.
 * Returns { xMap1h, xFrac1h, slotIdx1h } — parallel arrays of length times1h.length.
 */
function computeXMap1h(times1h, displayTimes, portraitColW) {
  const n1h  = times1h.length;
  const nDsp = displayTimes.length;
  const dspMs = displayTimes.map(t => new Date(t).getTime());
  // Use (nDsp + 1) slots as denominator so xFrac stays in (0, 1) even when late
  // points in the final coarse slot extend slightly past the canvas edge.
  const fracDenom = (nDsp + 1) * portraitColW;
  const xMap = [], xFrac = [], slotIdx = [];
  let j = 0;
  for (let k = 0; k < n1h; k++) {
    const tk = new Date(times1h[k]).getTime();
    while (j < nDsp - 1 && dspMs[j + 1] <= tk) j++;
    const slotDur = j < nDsp - 1
      ? dspMs[j + 1] - dspMs[j]
      : (j > 0 ? dspMs[j] - dspMs[j - 1] : 3600000);
    const x = (j + 0.5 + (tk - dspMs[j]) / slotDur) * portraitColW;
    xMap.push(x);
    xFrac.push(x / fracDenom);
    slotIdx.push(j);
  }
  return { xMap1h: xMap, xFrac1h: xFrac, slotIdx1h: slotIdx };
}

/**
 * Build a variable-resolution display series for portrait mode.
 * Resolution decreases with distance from now; nighttime is compressed:
 *   0–24 h  daytime  → 1h  |  nighttime → 3h
 *   24–48 h daytime  → 3h  |  nighttime → 6h
 *   48–168 h         → 6h  (always)
 *   168 h+  daytime only, step increases linearly from 6h→12h (nighttime skipped)
 *
 * For coarse slots the icon/direction is picked from whichever hour in the
 * window is most "daytime" (prefers midday, avoids night).
 *
 * The returned object keeps the display series (times/codes/dirs/precips/winds,
 * length = N_display) separate from the full 1h arrays (times1h/temps1h/etc.,
 * length = N_1h).  xMap1h / xFrac1h map each 1h point to its CSS x-center on
 * the display grid so curves can be drawn at full resolution.
 */
function buildPortraitSeries(s) {
  const t0 = new Date(s.times1h[0]).getTime();
  const times = [], codes = [], dirs = [];
  const precips = [], winds = [], temps = [], gusts = [];
  const hasEns = s.ensTemp1h != null;
  const ensTemp = { p10: [], p50: [], p90: [] };
  const ensWind = { p10: [], p50: [], p90: [] };
  const ensGust = { p10: [], p50: [], p90: [] };
  const ensPrecip = { p10: [], p50: [], p90: [] };

  let i = 0;
  while (i < s.times1h.length) {
    const hoursAhead = (new Date(s.times1h[i]).getTime() - t0) / 3600000;
    const h = new Date(s.times1h[i]).getHours();
    const night = typeof isNight === 'function' ? isNight(s.times1h[i]) : (h < 6 || h >= 20);

    let step;
    if (hoursAhead >= 168) {
      // Extended zone: skip nighttime icons entirely (req #4)
      if (night) { i += 1; continue; }
      // Linear zoom: step increases from 6h at day 7 to 12h at day 16
      const ratio = Math.min(1, (hoursAhead - 168) / 216);
      step = Math.ceil((6 + 6 * ratio) / 3) * 3; // snaps to 6, 9, or 12
    } else {
      const baseStep = hoursAhead < 24 ? 1 : hoursAhead < 48 ? 3 : 6;
      step = Math.min(6, night ? baseStep * 3 : baseStep);
    }

    // For coarse steps pick the slot in [i, i+step) that is most daytime.
    let best = i;
    if (step > 1) {
      let bestScore = -Infinity;
      const end = Math.min(i + step, s.times1h.length);
      for (let j = i; j < end; j++) {
        const hj = new Date(s.times1h[j]).getHours();
        const nj = typeof isNight === 'function' ? isNight(s.times1h[j]) : (hj < 6 || hj >= 20);
        const score = (nj ? 0 : 100) - Math.abs(hj - 12);
        if (score > bestScore) { bestScore = score; best = j; }
      }
    }

    // Time label: step-aligned start (so day boundaries land on exact midnight).
    times.push(s.times1h[i]);
    // Icon/direction: from the most-daytime slot.
    codes.push(s.codes1h ? s.codes1h[best] : null);
    dirs.push(s.dirs1h ? s.dirs1h[best]
                       : s.dirs[Math.min(Math.round(best / 3), s.dirs.length - 1)]);
    precips.push(s.precips1h[best]);
    winds.push(s.winds1h[best]);
    temps.push(s.temps1h[best]);
    gusts.push(s.gusts1h[best]);
    // Down-sample ensemble percentile bands by picking the best-slot value.
    if (hasEns) {
      ['p10', 'p50', 'p90'].forEach(k => {
        ensTemp[k].push(s.ensTemp1h[k][best]);
        ensWind[k].push(s.ensWind1h[k][best]);
        ensGust[k].push(s.ensGust1h[k][best]);
        ensPrecip[k].push(s.ensPrecip1h[k][best]);
      });
    }

    i += step;
  }

  // Compute x-positions mapping each 1h point onto the variable-resolution grid.
  const { xMap1h, xFrac1h, slotIdx1h } = computeXMap1h(s.times1h, times, PORTRAIT_COL_W);

  return {
    // Display series (N_display): icons, arrows, axis ticks, kite highlights, curves.
    times, codes, dirs,
    temps,    // representative temperature per display slot (for temp curve in portrait)
    precips,  // representative precip per display slot (for bars in drawTemp)
    gusts,    // representative gust per display slot (for wind curve in portrait)
    winds,    // representative wind per display slot (for kite highlights in drawWind)
    ensTemp:   hasEns ? ensTemp   : null,
    ensWind:   hasEns ? ensWind   : null,
    ensGust:   hasEns ? ensGust   : null,
    ensPrecip: hasEns ? ensPrecip : null,

    // Full 1h arrays (N_1h): smooth curves and precise tooltip values.
    times1h:     s.times1h,
    temps1h:     s.temps1h,
    precips1h:   s.precips1h,
    gusts1h:     s.gusts1h,
    winds1h:     s.winds1h,
    codes1h:     s.codes1h,
    dirs1h:      s.dirs1h,
    ensTemp1h:   s.ensTemp1h,
    ensWind1h:   s.ensWind1h,
    ensGust1h:   s.ensGust1h,
    ensPrecip1h: s.ensPrecip1h,
    // Other model wind lines: passed through at 1h resolution for rendering
    // with xMap1h providing correct x-positions on the variable-res display grid.
    otherModelsWind1h: s.otherModelsWind1h || null,

    // x-position mapping: each 1h point → CSS x-center on the display grid.
    xMap1h, xFrac1h, slotIdx1h,
    isPortraitMode: true,
  };
}

/**
 * Build a display series for landscape mode.
 * Days 1–7: uniform 3h slots so exactly 7 days fills the viewport at baseColW.
 * Days 7–16: daytime only (nighttime skipped); step increases linearly from
 *             6h at day 7 to 12h at day 16 (linear zoom, req #3/#4).
 * colW is the base column width (= viewportWidth / 56) so days 1–7 fill the
 * screen and days 8–16 extend beyond, accessible by scrolling.
 */
function buildLandscapeSeries(s, colW) {
  const t0 = new Date(s.times1h[0]).getTime();
  const times = [], codes = [], dirs = [];
  const precips = [], winds = [], temps = [], gusts = [];
  const hasEns = s.ensTemp1h != null;
  const ensTemp = { p10: [], p50: [], p90: [] };
  const ensWind = { p10: [], p50: [], p90: [] };
  const ensGust = { p10: [], p50: [], p90: [] };
  const ensPrecip = { p10: [], p50: [], p90: [] };

  let i = 0;
  while (i < s.times1h.length) {
    const hoursAhead = (new Date(s.times1h[i]).getTime() - t0) / 3600000;
    const h = new Date(s.times1h[i]).getHours();
    const night = typeof isNight === 'function' ? isNight(s.times1h[i]) : (h < 6 || h >= 20);

    let step;
    if (hoursAhead < 168) {
      step = STEP; // 3h uniform — first 7 days fill viewport exactly
    } else {
      // Extended zone: skip nighttime icons (req #4)
      if (night) { i += 1; continue; }
      // Linear zoom: step increases from 6h at day 7 to 12h at day 16
      const ratio = Math.min(1, (hoursAhead - 168) / 216);
      step = Math.ceil((6 + 6 * ratio) / 3) * 3; // snaps to 6, 9, or 12
    }

    // For coarse steps pick the slot in [i, i+step) that is most daytime.
    let best = i;
    if (step > 1) {
      let bestScore = -Infinity;
      const end = Math.min(i + step, s.times1h.length);
      for (let j = i; j < end; j++) {
        const hj = new Date(s.times1h[j]).getHours();
        const nj = typeof isNight === 'function' ? isNight(s.times1h[j]) : (hj < 6 || hj >= 20);
        const score = (nj ? 0 : 100) - Math.abs(hj - 12);
        if (score > bestScore) { bestScore = score; best = j; }
      }
    }

    times.push(s.times1h[i]);
    codes.push(s.codes1h ? s.codes1h[best] : null);
    dirs.push(s.dirs1h ? s.dirs1h[best]
                       : s.dirs[Math.min(Math.round(best / 3), s.dirs.length - 1)]);
    precips.push(s.precips1h[best]);
    winds.push(s.winds1h[best]);
    temps.push(s.temps1h[best]);
    gusts.push(s.gusts1h[best]);
    if (hasEns) {
      ['p10', 'p50', 'p90'].forEach(k => {
        ensTemp[k].push(s.ensTemp1h[k][best]);
        ensWind[k].push(s.ensWind1h[k][best]);
        ensGust[k].push(s.ensGust1h[k][best]);
        ensPrecip[k].push(s.ensPrecip1h[k][best]);
      });
    }

    i += step;
  }

  const { xMap1h, xFrac1h, slotIdx1h } = computeXMap1h(s.times1h, times, colW);

  return {
    times, codes, dirs, temps, precips, gusts, winds,
    ensTemp:   hasEns ? ensTemp   : null,
    ensWind:   hasEns ? ensWind   : null,
    ensGust:   hasEns ? ensGust   : null,
    ensPrecip: hasEns ? ensPrecip : null,
    times1h:     s.times1h,   temps1h:   s.temps1h,
    precips1h:   s.precips1h, gusts1h:   s.gusts1h,
    winds1h:     s.winds1h,   codes1h:   s.codes1h,
    dirs1h:      s.dirs1h,
    ensTemp1h:   s.ensTemp1h, ensWind1h:  s.ensWind1h,
    ensGust1h:   s.ensGust1h, ensPrecip1h: s.ensPrecip1h,
    otherModelsWind1h: s.otherModelsWind1h || null,
    xMap1h, xFrac1h, slotIdx1h,
    isPortraitMode: false,
  };
}
