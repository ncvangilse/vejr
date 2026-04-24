/* ══════════════════════════════════════════════════
   SHORE DEBUG PANEL
══════════════════════════════════════════════════ */

/* ── Minimap ── */
function drawShoreDebugMap(d) {
  const canvas = document.getElementById('shore-debug-map');
  if (!canvas) return;

  const SIZE = canvas.clientWidth || 200;
  const dpr  = window.devicePixelRatio || 1;
  canvas.width  = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width  = SIZE + 'px';
  canvas.style.height = SIZE + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const PAD  = 6;
  const mapW = SIZE - PAD * 2;
  const mapH = mapW;           // square map
  const offX = PAD, offY = PAD;

  // ── Background ──
  ctx.fillStyle = '#141e2a';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.strokeStyle = 'rgba(80,100,130,0.5)';
  ctx.lineWidth   = 0.5;
  ctx.strokeRect(offX, offY, mapW, mapH);

  // ── Image-pixel → canvas coordinate helper ──
  const imgToCanvas = (px, py) => [
    offX + (px / d.width)  * mapW,
    offY + (py / d.height) * mapH,
  ];

  // ── Lat/lon → canvas via Mercator (same math as latLonToPixel in shore.js) ──
  const mb = d.mercatorBbox;
  const latLonToCanvas = (lat, lon) => {
    const R  = 6378137;
    const x  = lon * Math.PI / 180 * R;
    const y  = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
    const nx = (x - mb.west)  / (mb.east  - mb.west);
    const ny = (mb.north - y) / (mb.north - mb.south);
    return [offX + nx * mapW, offY + ny * mapH];
  };

  // ── Water-area polygons (from Overpass, viz only) ──
  (d.waterPolys || []).forEach(poly => {
    if (!poly || poly.length < 2) return;
    ctx.beginPath();
    poly.forEach((p, i) => {
      const [x, y] = latLonToCanvas(p.lat, p.lon);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle   = 'rgba(30,100,180,0.35)';  ctx.fill();
    ctx.strokeStyle = 'rgba(60,140,220,0.6)';   ctx.lineWidth = 0.8; ctx.stroke();
  });

  // ── Coastline ways (from Overpass, viz only) ──
  (d.coastWays || []).forEach(way => {
    if (!way || way.length < 2) return;
    ctx.beginPath();
    way.forEach((p, i) => {
      const [x, y] = latLonToCanvas(p.lat, p.lon);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(220,140,50,0.9)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  });

  // ── Ray lines from origin to farthest sample in each bearing ──
  const [ox, oy] = d.originPx
    ? imgToCanvas(d.originPx.px, d.originPx.py)
    : latLonToCanvas(d.lat, d.lon);

  ctx.lineWidth = 0.5;
  (d.bearings || []).forEach(row => {
    if (!row.samples.length) return;
    const last = row.samples[row.samples.length - 1];
    const [lx, ly] = last.px != null
      ? imgToCanvas(last.px, last.py)
      : latLonToCanvas(last.lat, last.lon);
    ctx.strokeStyle = row.seaFrac >= SHORE_SEA_THRESH
      ? 'rgba(0,200,160,0.22)'
      : 'rgba(220,140,50,0.18)';
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(lx, ly);
    ctx.stroke();
  });

  // ── Sample dots ──
  (d.bearings || []).forEach(row => {
    row.samples.forEach(s => {
      const [x, y] = s.px != null
        ? imgToCanvas(s.px, s.py)
        : latLonToCanvas(s.lat, s.lon);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = s.reason === 'oob:sea'  ? 'rgba(180,180,180,0.7)'
                    : s.isSea                 ? '#00c8a0'
                    :                           '#e06020';
      ctx.fill();
    });
  });

  // ── Origin crosshair ──
  const CH = 6;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.beginPath(); ctx.moveTo(ox - CH, oy); ctx.lineTo(ox + CH, oy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, oy - CH); ctx.lineTo(ox, oy + CH); ctx.stroke();
  ctx.beginPath(); ctx.arc(ox, oy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill();

  // ── Scale bar (1 km) ──
  const metersW  = mb.east - mb.west;
  const barPxW   = (1000 / metersW) * mapW;
  const barX = offX + 5, barY = offY + mapH - 7;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(barX, barY);         ctx.lineTo(barX + barPxW, barY);
  ctx.moveTo(barX, barY - 3);     ctx.lineTo(barX, barY + 3);
  ctx.moveTo(barX + barPxW, barY - 3); ctx.lineTo(barX + barPxW, barY + 3);
  ctx.stroke();
  ctx.font = '9px IBM Plex Mono, monospace';
  ctx.fillStyle = '#ccc'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('1 km', barX + barPxW + 3, barY + 4);

  // ── N arrow ──
  const narX = offX + mapW - 10, narY = offY + 18;
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(narX, narY - 10); ctx.lineTo(narX - 4, narY + 2);
  ctx.lineTo(narX, narY - 2);  ctx.lineTo(narX + 4, narY + 2);
  ctx.closePath(); ctx.fill();
  ctx.font = 'bold 9px IBM Plex Sans, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('N', narX, narY + 4);

  // ── Legend ──
  const LEG = [
    { color: 'rgba(30,100,180,0.6)',      label: 'water polygon'  },
    { color: 'rgba(220,140,50,0.9)',      label: 'coastline way'  },
    { color: '#00c8a0',                   label: 'sample – water' },
    { color: '#e06020',                   label: 'sample – land'  },
    { color: 'rgba(180,180,180,0.7)',     label: 'sample – out of bbox' },
  ];
  ctx.font = '8px IBM Plex Mono, monospace';
  ctx.textBaseline = 'middle';
  let legY = offY + 4;
  LEG.forEach(({ color, label }) => {
    ctx.fillStyle = color;
    ctx.fillRect(offX + 4, legY - 4, 8, 8);
    ctx.fillStyle = 'rgba(200,210,220,0.9)';
    ctx.textAlign = 'left';
    ctx.fillText(label, offX + 15, legY);
    legY += 12;
  });
}

function renderShoreDebug() {
  const d = window.SHORE_DEBUG;

  const mapCanvas = document.getElementById('shore-debug-map');
  const metaEl   = document.getElementById('shore-debug-meta');
  const ringsTb  = document.querySelector('#shore-debug-rings-table tbody');
  const bearTb   = document.querySelector('#shore-debug-bearings-table tbody');
  if (!metaEl || !ringsTb || !bearTb) return;

  if (!d) {
    metaEl.textContent = 'No debug data yet — fetch sea bearings first.';
    ringsTb.innerHTML  = '';
    bearTb.innerHTML   = '';
    if (mapCanvas) {
      const ctx = mapCanvas.getContext('2d');
      ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    }
    return;
  }

  drawShoreDebugMap(d);

  const seaCount = Array.from(window.SHORE_MASK || []).filter(v => v >= SHORE_SEA_THRESH).length;
  metaEl.innerHTML = `
    <span class="sdd-key">Location:</span>
    <span class="sdd-val">${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}</span>
    <span class="sdd-key">Image:</span>
    <span class="sdd-val">${d.width} × ${d.height} px</span>
    <span class="sdd-key">Resolution:</span>
    <span class="sdd-val">~${d.metersPerPixel.toFixed(1)} m/px</span>
    <span class="sdd-key">Sea bearings:</span>
    <span class="sdd-val">${seaCount} / 36</span>
    <span class="sdd-key">Origin:</span>
    <span class="sdd-val">${d.originIsWater ? 'on water' : 'on land'}</span>
  `;

  // ── WMS request details table ──
  const urlShort = d.wmsUrl.replace(/^https?:\/\//, '');
  const vecStatus = d.vectorState === 'loading' ? '<span class="sdd-warn">loading…</span>'
                  : d.vectorState === 'error'   ? '<span class="sdd-warn">unavailable</span>'
                  : `${(d.coastWays||[]).length} coast ways, ${(d.waterPolys||[]).length} water polys`;
  ringsTb.innerHTML = `
    <tr>
      <td class="sdd-key">URL</td>
      <td colspan="2" style="word-break:break-all;font-size:9px">
        <a href="${d.wmsUrl}" target="_blank" style="color:#5af;text-decoration:none">
          open ↗</a>
        <span class="sdd-sub" style="display:block">${urlShort.slice(0, 100)}…</span>
      </td>
    </tr>
    <tr>
      <td class="sdd-key">Mercator W/E</td>
      <td colspan="2" class="sdd-val" style="font-size:9px">
        ${d.mercatorBbox.west.toFixed(0)} / ${d.mercatorBbox.east.toFixed(0)} m
      </td>
    </tr>
    <tr>
      <td class="sdd-key">Mercator S/N</td>
      <td colspan="2" class="sdd-val" style="font-size:9px">
        ${d.mercatorBbox.south.toFixed(0)} / ${d.mercatorBbox.north.toFixed(0)} m
      </td>
    </tr>
    <tr>
      <td class="sdd-key">Vector (viz)</td>
      <td colspan="2" class="sdd-val" style="font-size:9px">${vecStatus}</td>
    </tr>
  `;

  // ── Bearings table ──
  const REASON_ABBR = {
    // WMS pixel-based reasons (current)
    'wms:water': 'WW',
    'wms:land':  'WL',
    'oob:sea':   'OB',
    // Legacy Overpass reasons (kept for any cached SHORE_DEBUG snapshots)
    'coast:land':       'CL',
    'coast:sea':        'CS',
    waterArea:          'WA',
    'fallback:sea':     'FS',
    'fallback:noCoast': 'NC',
  };
  bearTb.innerHTML = d.bearings.map(row => {
    const pct   = Math.round(row.seaFrac * 100);
    const isSea = row.seaFrac >= SHORE_SEA_THRESH;
    const cells = row.samples.map(s => {
      const abbr = REASON_ABBR[s.reason] ?? s.reason;

      const cls  = s.isSea ? 'sdd-sea-cell' : 'sdd-land-cell';
      return `<td class="${cls}" title="${s.reason}">${s.isSea ? '~' : '▲'}${abbr}</td>`;
    }).join('');
    return `<tr class="${isSea ? 'sdd-sea-row' : 'sdd-land-row'}">
      <td>${row.bearing}°</td>
      <td>${pct}%</td>
      ${cells}
    </tr>`;
  }).join('');
}
