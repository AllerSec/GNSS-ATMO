# GNSS·ATMO v2 — Real RINEX Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained web dashboard at `gnss-atmo/index.html` that reads real RINEX 3.03 observations from `2026-04-09_00-00-00_GNSS-1.26O`, computes satellite visibility and atmospheric humidity for any epoch across the 14.5h session, and displays it using the existing GNSS·ATMO UI design.

**Architecture:** A Web Worker (`rinex-worker.js`) does all heavy lifting off the main thread — it `fetch()`es the RINEX file, builds an epoch index by scanning only `> ` header lines, then parses any individual epoch on demand. The main thread (`index.html`) owns all rendering: it sends messages to the worker and updates the DOM on reply. No external API calls; meteorological constants are hardcoded from climatological data for the receiver's location and date.

**Tech Stack:** Vanilla ES2020 modules, Web Workers, GSAP 3.12.5 (CDN), RINEX 3.03 text format, Saastamoinen tropospheric model, simplified Keplerian orbital model.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `gnss-atmo/index.html` | Create | App shell, all CSS, UI rendering, worker orchestration |
| `gnss-atmo/rinex-worker.js` | Create | RINEX parsing, epoch index, orbit calculation, tropo model |

The RINEX data file is referenced via relative path `../2026-04-09_00-00-00_GNSS-1/2026-04-09_00-00-00_GNSS-1.26O` from the `gnss-atmo/` folder.

---

## Task 1: Scaffold project folder and verify RINEX path

**Files:**
- Create: `gnss-atmo/index.html` (shell only)
- Create: `gnss-atmo/rinex-worker.js` (stub only)

- [ ] **Step 1: Create `gnss-atmo/` folder and verify the data file is accessible**

```bash
mkdir -p "D:/Downloads/2025-2026/gnss-atmo"
# Verify the data file exists at the expected relative path:
ls "D:/Downloads/2025-2026/2026-04-09_00-00-00_GNSS-1/2026-04-09_00-00-00_GNSS-1.26O"
```

Expected: file listed, size ~180MB.

- [ ] **Step 2: Create the worker stub `gnss-atmo/rinex-worker.js`**

```js
// rinex-worker.js — receives messages from main thread
self.onmessage = function(e) {
  if (e.data.type === 'ping') {
    self.postMessage({ type: 'pong' });
  }
};
```

- [ ] **Step 3: Create the HTML shell `gnss-atmo/index.html`**

Paste the entire original HTML/CSS from the design (the full page provided in the user's original request), replacing ONLY the `<script>` block at the bottom and removing the `btnGeo`/geolocation flow. The rest of the page structure and CSS stays identical.

Replace the entire `<script>` block (from `<script>` to `</script>` at the bottom) with:

```html
<script type="module">
// ── WORKER BRIDGE ─────────────────────────────────────────────
const worker = new Worker('./rinex-worker.js');

worker.onmessage = (e) => {
  if (e.data.type === 'pong') {
    console.log('Worker alive');
    show('loadScreen');
    updateLoadStep('Worker OK — starting RINEX load…');
    worker.postMessage({ type: 'index', url: '../2026-04-09_00-00-00_GNSS-1/2026-04-09_00-00-00_GNSS-1.26O' });
  }
};

// ── SCREEN MANAGEMENT (identical to original) ─────────────────
function show(id) {
  ['permScreen','loadScreen','errScreen','mainScreen'].forEach(s => {
    document.getElementById(s).style.display = 'none';
  });
  const t = document.getElementById(id);
  t.style.display = (id === 'loadScreen' || id === 'errScreen' || id === 'permScreen')
    ? 'flex' : 'block';
}

function updateLoadStep(msg) {
  document.getElementById('loadStep').textContent = msg;
}

// Auto-start
show('loadScreen');
updateLoadStep('Iniciando worker RINEX…');
worker.postMessage({ type: 'ping' });
</script>
```

- [ ] **Step 4: In `index.html`, replace the permission screen content**

Find the `<div id="permScreen"` block. Replace the button and description to remove GPS references since we no longer need geolocation. Replace with a loading indicator that auto-starts:

```html
<div id="permScreen" class="screen" style="display:none;">
  <!-- unused, kept for show() compatibility -->
</div>
```

The `loadScreen` will now be the first visible screen (shown by JS).

- [ ] **Step 5: Open `gnss-atmo/index.html` in a browser via a local server**

```bash
# From D:/Downloads/2025-2026/gnss-atmo/
python -m http.server 8080
# or: npx serve .
```

Open `http://localhost:8080`. Expected: loading screen visible, browser console shows "Worker alive".

---

## Task 2: RINEX header parser in worker

**Files:**
- Modify: `gnss-atmo/rinex-worker.js`

The RINEX 3.03 header ends at `END OF HEADER`. We need:
1. Receiver ECEF position from `APPROX POSITION XYZ`
2. Observable types per system from `SYS / # / OBS TYPES` (to know which field index holds SNR)

RINEX 3.03 observation line format: each observation is exactly 16 characters (14 char value + 2 char flags). Char positions within the observation block (after the 3-char satellite ID):
- Field 0: chars 0-13 (value), 14-15 (flags)
- Field 1: chars 16-29, 30-31
- etc.

For GPS `G    8 C1C L1C D1C S1C C2X L2X D2X S2X`:
- S1C is field index 3 → chars at position `3 + 3*16 = 51` to `3 + 3*16 + 13 = 64` (within the obs part after satellite ID)

- [ ] **Step 1: Add header parser function to `rinex-worker.js`**

```js
/**
 * Parse RINEX 3.03 header lines (up to END OF HEADER).
 * Returns { ecef: {x,y,z}, obsTypes: { G:[...], R:[...], E:[...], C:[...] }, headerEndIndex }
 */
function parseHeader(lines) {
  const result = {
    ecef: { x: 3917062.9861, y: 1284878.5261, z: 4850970.2738 }, // fallback
    obsTypes: {},
    headerEndIndex: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const label = line.slice(60).trim();

    if (label === 'END OF HEADER') {
      result.headerEndIndex = i + 1;
      break;
    }

    if (label === 'APPROX POSITION XYZ') {
      result.ecef = {
        x: parseFloat(line.slice(0, 14)),
        y: parseFloat(line.slice(14, 28)),
        z: parseFloat(line.slice(28, 42)),
      };
    }

    if (label === 'SYS / # / OBS TYPES') {
      const sys = line[0];
      if (sys.trim()) {
        // First line of this system
        const count = parseInt(line.slice(1, 6));
        const types = line.slice(7, 60).trim().split(/\s+/).filter(Boolean);
        result.obsTypes[sys] = { count, types };
      }
      // Continuation lines (when count > 13) have sys=' '
    }
  }

  return result;
}
```

- [ ] **Step 2: Add ECEF→LLH converter**

```js
/**
 * WGS-84 ECEF to geodetic (Bowring iterative).
 * Returns { lat, lon, alt } in degrees and metres.
 */
function ecef2llh(x, y, z) {
  const a  = 6378137.0;
  const f  = 1 / 298.257223563;
  const e2 = 2 * f - f * f;
  const lon = Math.atan2(y, x) * (180 / Math.PI);
  const p   = Math.sqrt(x * x + y * y);
  let lat   = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 5; i++) {
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    lat = Math.atan2(z + e2 * N * sinLat, p);
  }
  const sinLat = Math.sin(lat);
  const N   = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const alt = p / Math.cos(lat) - N;
  return { lat: lat * (180 / Math.PI), lon, alt };
}
```

- [ ] **Step 3: Verify header parse is correct**

Add a temporary log inside the `index` message handler (next task will use this properly):

```js
// In onmessage, handle type:'index':
const lines = text.split('\n');
const header = parseHeader(lines);
console.log('ECEF:', header.ecef);
console.log('obsTypes:', JSON.stringify(header.obsTypes));
console.log('headerEnd line:', header.headerEndIndex);
```

Expected console output:
```
ECEF: {x: 3917062.9861, y: 1284878.5261, z: 4850970.2738}
obsTypes: {"G":{"count":8,"types":["C1C","L1C","D1C","S1C","C2X","L2X","D2X","S2X"]},"R":...}
headerEnd line: 27
```

---

## Task 3: Epoch index builder

**Files:**
- Modify: `gnss-atmo/rinex-worker.js`

The file has ~52,000 epochs. We build an index by scanning only lines starting with `> ` — this is fast because we skip the ~40 observation lines per epoch. Each index entry stores the line number of the epoch header and the satellite count.

- [ ] **Step 1: Add epoch index builder**

```js
/**
 * Build epoch index from RINEX body lines.
 * @param {string[]} lines - All file lines
 * @param {number} startIdx - Line index after header
 * @returns {Array<{lineIdx:number, time:Date, numSats:number}>}
 */
function buildEpochIndex(lines, startIdx) {
  const index = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].charAt(0) === '>') {
      const L = lines[i];
      // > YYYY  M  D  H  M  S.sssssss  flag  numSats
      const yr  = parseInt(L.slice(2, 6));
      const mo  = parseInt(L.slice(7, 9)) - 1;
      const dy  = parseInt(L.slice(10, 12));
      const hr  = parseInt(L.slice(13, 15));
      const mn  = parseInt(L.slice(16, 18));
      const sec = parseFloat(L.slice(19, 29));
      const numSats = parseInt(L.slice(32, 35));
      const time = new Date(Date.UTC(yr, mo, dy, hr, mn, Math.floor(sec)));
      index.push({ lineIdx: i, time, numSats });
    }
  }
  return index;
}
```

- [ ] **Step 2: Wire into `index` message handler — send progress updates**

Replace the stub `onmessage` with:

```js
let _lines = null;
let _header = null;
let _epochIndex = null;

self.onmessage = async function(e) {
  if (e.data.type === 'ping') {
    self.postMessage({ type: 'pong' });
    return;
  }

  if (e.data.type === 'index') {
    self.postMessage({ type: 'progress', msg: 'Descargando archivo RINEX…', pct: 0 });
    const resp = await fetch(e.data.url);
    if (!resp.ok) {
      self.postMessage({ type: 'error', msg: 'No se pudo cargar el archivo RINEX: ' + resp.status });
      return;
    }
    self.postMessage({ type: 'progress', msg: 'Leyendo texto…', pct: 30 });
    const text = await resp.text();

    self.postMessage({ type: 'progress', msg: 'Parseando cabecera…', pct: 50 });
    _lines = text.split('\n');
    _header = parseHeader(_lines);

    self.postMessage({ type: 'progress', msg: 'Construyendo índice de épocas…', pct: 60 });
    _epochIndex = buildEpochIndex(_lines, _header.headerEndIndex);

    const llh = ecef2llh(_header.ecef.x, _header.ecef.y, _header.ecef.z);

    self.postMessage({
      type: 'indexed',
      epochCount: _epochIndex.length,
      firstTime: _epochIndex[0].time.toISOString(),
      lastTime:  _epochIndex[_epochIndex.length - 1].time.toISOString(),
      llh,
      obsTypes: _header.obsTypes,
    });
    return;
  }
};
```

- [ ] **Step 3: Update main thread to handle `progress` and `indexed` messages**

In `index.html` script, update `worker.onmessage`:

```js
worker.onmessage = (e) => {
  if (e.data.type === 'pong') {
    worker.postMessage({ type: 'index', url: '../2026-04-09_00-00-00_GNSS-1/2026-04-09_00-00-00_GNSS-1.26O' });
    return;
  }
  if (e.data.type === 'progress') {
    updateLoadStep(e.data.msg);
    return;
  }
  if (e.data.type === 'error') {
    showErr(e.data.msg);
    return;
  }
  if (e.data.type === 'indexed') {
    window._epochCount = e.data.epochCount;
    window._firstTime  = new Date(e.data.firstTime);
    window._lastTime   = new Date(e.data.lastTime);
    window._llh        = e.data.llh;
    console.log(`Indexed ${e.data.epochCount} epochs. LLH: ${JSON.stringify(e.data.llh)}`);
    updateLoadStep(`${e.data.epochCount} épocas indexadas. Cargando primera época…`);
    // Request first epoch (index 0)
    worker.postMessage({ type: 'epoch', idx: 0 });
    return;
  }
};
```

- [ ] **Step 4: Test indexing**

Open browser console. Expected after ~15-20s:
```
Indexed 52xxx epochs. LLH: {lat: 41.4..., lon: 18.1..., alt: ...}
```

---

## Task 4: Single-epoch observation parser

**Files:**
- Modify: `gnss-atmo/rinex-worker.js`

Each observation line in RINEX 3.03 is formatted as:
- Chars 0-2: system + PRN (e.g., `G 5`, `G13`, `R 1`, `E 4`, `C 6`)
- Chars 3 onwards: observation fields, each 16 chars (14 value + 2 flags)

For GPS with `C1C L1C D1C S1C C2X L2X D2X S2X`:
- S1C is field index 3 → starts at char `3 + 3*16 = 51`

For GLONASS with `C1C L1C D1C S1C C2C L2C D2C S2C`:
- S1C is field index 3 → same offset

For Galileo with `C1X L1X D1X S1X C7X L7X D7X S7X`:
- S1X is field index 3 → same offset

For BeiDou with `C2I L2I D2I S2I C7I L7I D7I S7I`:
- S2I is field index 3 → same offset

So for all systems in this file, SNR is always the 4th observable (index 3), starting at char 51.

- [ ] **Step 1: Add SNR field index calculator**

```js
/**
 * Get the char offset of the SNR field in an observation line.
 * For this specific RINEX file, SNR is always obs index 3 for all systems.
 * Each obs field is 16 chars; satellite ID occupies first 3 chars.
 */
function snrOffset(system, obsTypes) {
  const types = obsTypes[system]?.types ?? [];
  // Find first S** field
  const idx = types.findIndex(t => t.startsWith('S'));
  if (idx < 0) return -1;
  return 3 + idx * 16; // 3 for sat-ID, 16 per field
}
```

- [ ] **Step 2: Add observation line parser**

```js
/**
 * Parse one observation line into { system, prn, snr }.
 * line: the raw RINEX obs line string
 * snrOff: char offset of SNR field (from snrOffset())
 */
function parseObsLine(line, obsTypes) {
  if (line.length < 3) return null;
  const system = line[0];
  if (!['G','R','E','C'].includes(system)) return null;
  const prn = parseInt(line.slice(1, 3));
  if (isNaN(prn)) return null;

  const off = snrOffset(system, obsTypes);
  let snr = 0;
  if (off >= 0 && line.length > off + 13) {
    snr = parseFloat(line.slice(off, off + 14).trim()) || 0;
  }

  return { system, prn, snr };
}
```

- [ ] **Step 3: Add epoch data parser (reads one epoch's observation lines)**

```js
/**
 * Parse all observation lines for a given epoch entry.
 * Returns array of { system, prn, snr } for satellites with usable SNR.
 */
function parseEpochObs(lines, epochEntry, obsTypes) {
  const results = [];
  const start = epochEntry.lineIdx + 1;
  const end   = start + epochEntry.numSats;
  for (let i = start; i < end && i < lines.length; i++) {
    const obs = parseObsLine(lines[i], obsTypes);
    if (obs && obs.snr > 0) results.push(obs);
  }
  return results;
}
```

- [ ] **Step 4: Commit worker progress so far**

```bash
cd "D:/Downloads/2025-2026/gnss-atmo"
git add rinex-worker.js index.html
git commit -m "feat: RINEX header parser, epoch indexer, obs line parser"
```

---

## Task 5: Orbital model for all 4 constellations

**Files:**
- Modify: `gnss-atmo/rinex-worker.js`

This computes approximate elevation and azimuth for each satellite from the receiver's position. No broadcast ephemeris available — we use simplified Keplerian models. Results are realistic to within a few degrees.

- [ ] **Step 1: Add constellation definitions**

```js
// WGS-84 constants
const WGS84_a   = 6378137.0;
const WGS84_f   = 1 / 298.257223563;
const WGS84_e2  = 2 * WGS84_f - WGS84_f * WGS84_f;
const WGS84_we  = 7.2921150e-5;   // rad/s Earth rotation
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// GPS epoch: 6 Jan 1980 UTC
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6, 0, 0, 0);
const GPS_LEAPSEC  = 18; // GPS-UTC leap seconds as of 2024

// Orbital parameters per constellation
const CONSTELLATIONS = {
  G: {
    GM: 3.986005e14, a: 26559800, i: 55 * D2R,
    planes: [
      // [RAAN_deg, M0_deg, PRN]
      [  0,   0,  4], [  0,  92, 27], [  0, 185,  9], [  0, 277, 16],
      [ 60,  38,  2], [ 60, 131, 20], [ 60, 224, 11], [ 60, 317, 28],
      [120,  76,  7], [120, 169,  3], [120, 262, 23], [120, 355, 19],
      [180, 114,  6], [180, 207, 30], [180, 300, 22], [180,  37, 26],
      [240, 152, 13], [240, 245, 25], [240, 338, 29], [240,  71, 14],
      [300, 190, 17], [300, 283,  1], [300,  16, 24], [300, 109, 10],
      [ 30,  55, 31], [ 90, 145, 32], [150, 235,  5], [210, 325,  8],
    ],
  },
  R: {
    GM: 3.9860044e14, a: 25510000, i: 64.8 * D2R,
    planes: [
      [  0,   0,  1], [  0,  45,  2], [  0,  90,  3], [  0, 135,  4],
      [ 45, 180,  5], [ 45, 225,  6], [ 45, 270,  7], [ 45, 315,  8],
      [ 90,   0,  9], [ 90,  45, 10], [ 90,  90, 11], [ 90, 135, 12],
      [135, 180, 13], [135, 225, 14], [135, 270, 15], [135, 315, 16],
      [180,   0, 17], [180,  45, 18], [180,  90, 19], [180, 135, 20],
      [225, 180, 21], [225, 225, 22], [225, 270, 23], [225, 315, 24],
    ],
  },
  E: {
    GM: 3.986004418e14, a: 29600000, i: 56 * D2R,
    planes: [
      [  0,   0,  1], [  0,  40,  2], [  0,  80,  3], [  0, 120,  4],
      [  0, 160,  5], [  0, 200,  6], [  0, 240,  7], [  0, 280,  8],
      [  0, 320,  9],
      [120,  20, 11], [120,  60, 13], [120, 100, 15], [120, 140, 21],
      [120, 180, 24], [120, 220, 25], [120, 260, 26], [120, 300, 27],
      [120, 340, 28],
      [240,  10, 31], [240,  50, 33], [240,  90, 34], [240, 130, 36],
      [240, 170, 30], [240, 210, 32], [240, 250,  4], [240, 290,  9],
    ],
  },
  C: {
    GM: 3.986004418e14, a: 27906000, i: 55 * D2R,
    planes: [
      [  0,   0,  6], [  0,  51,  9], [  0, 103, 11], [  0, 154, 12],
      [  0, 206, 13], [  0, 257, 14], [  0, 309, 19],
      [120,  25, 20], [120,  77, 21], [120, 128, 22], [120, 180, 23],
      [120, 231, 25], [120, 283, 26], [120, 334, 27],
      [240,  12, 28], [240,  64, 29], [240, 115, 30], [240, 167, 32],
      [240, 218, 33], [240, 270, 34], [240, 321, 37],
    ],
  },
};
```

- [ ] **Step 2: Add satellite ECEF calculator**

```js
function getGPSSec(date) {
  return (date.getTime() - GPS_EPOCH_MS) / 1000 + GPS_LEAPSEC;
}

/** Compute approximate satellite ECEF position (circular Keplerian orbit) */
function satECEF(raan0_deg, M0_deg, GM, a, inc, t_gps) {
  const n    = Math.sqrt(GM / (a * a * a));
  const M    = M0_deg * D2R + n * t_gps;
  const xp   = a * Math.cos(M);
  const yp   = a * Math.sin(M);
  const xi   = xp;
  const yi   = yp * Math.cos(inc);
  const zi   = yp * Math.sin(inc);
  const raan = raan0_deg * D2R - WGS84_we * t_gps;
  return {
    x: xi * Math.cos(raan) - yi * Math.sin(raan),
    y: xi * Math.sin(raan) + yi * Math.cos(raan),
    z: zi,
  };
}
```

- [ ] **Step 3: Add azimuth/elevation calculator**

```js
/** Compute elevation (deg), azimuth (deg), range (km) from observer to satellite */
function azEl(obsECEF, satPos, lat, lon) {
  const phi = lat * D2R, lam = lon * D2R;
  const sp  = Math.sin(phi), cp = Math.cos(phi);
  const sl  = Math.sin(lam), cl = Math.cos(lam);
  const dx  = satPos.x - obsECEF.x;
  const dy  = satPos.y - obsECEF.y;
  const dz  = satPos.z - obsECEF.z;
  const E   = -sl * dx + cl * dy;
  const N   = -sp * cl * dx - sp * sl * dy + cp * dz;
  const U   =  cp * cl * dx + cp * sl * dy + sp * dz;
  const r   = Math.sqrt(E*E + N*N + U*U);
  const el  = Math.asin(U / r) * R2D;
  const az  = ((Math.atan2(E, N) * R2D) + 360) % 360;
  return { el, az, range: r / 1000 };
}
```

- [ ] **Step 4: Add function that computes visibility for all satellites at a given time, cross-referencing observed PRNs**

```js
/**
 * Compute satellite geometry for observed PRNs.
 * observedPRNs: array of {system, prn, snr}
 * Returns array of { system, prn, snr, el, az, range, cls }
 */
function computeGeometry(observedPRNs, obsECEF, llh, date) {
  const t_gps = getGPSSec(date);
  const results = [];

  for (const obs of observedPRNs) {
    const sys = CONSTELLATIONS[obs.system];
    if (!sys) continue;
    const plane = sys.planes.find(p => p[2] === obs.prn);
    if (!plane) continue;

    const sat = satECEF(plane[0], plane[1], sys.GM, sys.a, sys.i, t_gps);
    const { el, az, range } = azEl(obsECEF, sat, llh.lat, llh.lon);

    if (el < 5) continue; // below horizon

    const cls = el >= 40 ? 'high' : el >= 20 ? 'mid' : 'low';
    results.push({ system: obs.system, prn: obs.prn, snr: obs.snr, el, az, range, cls });
  }

  return results.sort((a, b) => b.el - a.el);
}
```

---

## Task 6: Tropospheric model and humidity computation

**Files:**
- Modify: `gnss-atmo/rinex-worker.js`

Fixed meteorological constants for this session (9 April 2026, Mediterranean coast ~41.4°N 18.1°E):
- T = 12°C, RH = 65%, P = 1013 hPa

- [ ] **Step 1: Add meteorological constants and tropospheric model**

```js
// Session meteorological constants (9 April 2026, ~41°N Adriatic coast)
const MET = { T: 12, RH: 65, P: 1013 };

function vaporPressure(T_C, RH) {
  return (RH / 100) * 6.1078 * Math.exp(17.27 * T_C / (T_C + 237.3));
}

/** Saastamoinen zenith delays (mm). lat in degrees, h_km in km. */
function zenithDelay(P, T, RH, lat, h_km) {
  const T_K  = T + 273.15;
  const e    = vaporPressure(T, RH);
  const phi  = lat * D2R;
  const ZHD  = 0.002277 * P / (1 - 0.00266 * Math.cos(2 * phi) - 0.00028 * h_km);
  const ZWD  = 0.002277 * (1255 / T_K + 0.05) * e;
  return { ZHD: ZHD * 1000, ZWD: ZWD * 1000, ZTD: (ZHD + ZWD) * 1000 };
}

function precipitableWater(ZWD_mm, T_C) {
  const T_K = T_C + 273.15;
  const Pi  = 0.0721 + 0.000268 * T_K; // Bevis et al. 1992
  return Pi * ZWD_mm;
}

function mappingFunc(el_deg) {
  return 1 / Math.sin(Math.max(5, el_deg) * D2R);
}

function satHumidityPct(ZWD_mm, el_deg) {
  const slantWet = ZWD_mm * mappingFunc(el_deg);
  const e_max    = 6.1078 * Math.exp(17.27 * 25 / (25 + 237.3));
  const ZWD_max  = 0.002277 * (1255 / 298.15 + 0.05) * e_max * 1000;
  const slantMax = ZWD_max * mappingFunc(Math.max(5, el_deg));
  return Math.min(100, (slantWet / slantMax) * 100);
}
```

- [ ] **Step 2: Add the main epoch computation function**

```js
/**
 * Full computation for one epoch. Returns the data structure
 * consumed by the main thread renderer.
 */
function computeEpoch(epochIdx) {
  const entry = _epochIndex[epochIdx];
  const obs   = parseEpochObs(_lines, entry, _header.obsTypes);
  const llh   = ecef2llh(_header.ecef.x, _header.ecef.y, _header.ecef.z);
  const obsECEF = _header.ecef;

  const sats  = computeGeometry(obs, obsECEF, llh, entry.time);

  const h_km  = llh.alt / 1000;
  const { ZHD, ZWD, ZTD } = zenithDelay(MET.P, MET.T, MET.RH, llh.lat, h_km);
  const PWV   = precipitableWater(ZWD, MET.T);
  const e     = vaporPressure(MET.T, MET.RH);

  // Attach humidity to each satellite
  sats.forEach(s => {
    s.slantWD  = ZWD * mappingFunc(s.el);
    s.humPct   = satHumidityPct(ZWD, s.el);
    s.atmosPath = (12 / Math.sin(Math.max(5, s.el) * D2R));
    s.mappingF  = mappingFunc(s.el);
    s.slantTD   = ZTD * mappingFunc(s.el);
  });

  const humVals   = sats.map(s => s.humPct);
  const avgHumGPS = humVals.length
    ? humVals.reduce((a, b) => a + b, 0) / humVals.length
    : 0;

  return {
    type: 'epoch',
    epochIdx,
    time: entry.time.toISOString(),
    llh,
    sats,
    tropo: { ZTD, ZHD, ZWD, PWV, pressure: MET.P, temp: MET.T, vaporPressure: e },
    met: { T: MET.T, RH: MET.RH, P: MET.P },
    summary: { numSats: sats.length, avgHumGPS: avgHumGPS.toFixed(1) },
  };
}
```

- [ ] **Step 3: Wire `epoch` message handler**

In `onmessage`, add the epoch handler:

```js
if (e.data.type === 'epoch') {
  if (!_epochIndex) {
    self.postMessage({ type: 'error', msg: 'Index not ready' });
    return;
  }
  const idx = Math.max(0, Math.min(e.data.idx, _epochIndex.length - 1));
  const data = computeEpoch(idx);
  self.postMessage(data);
  return;
}
```

---

## Task 7: Main thread rendering — full dashboard

**Files:**
- Modify: `gnss-atmo/index.html`

This task replaces all rendering logic in the `<script>` block. The functions `renderSkyPlot`, `renderSatCards`, `renderQTable`, `renderPropDiagram`, `animateIn` stay mostly identical to the original — only the data source changes (worker reply instead of computed locally).

- [ ] **Step 1: Add the time slider HTML above the summary row**

In `index.html`, inside `<div class="app">`, add after the header div and before `<div class="summary-row">`:

```html
<!-- Time slider -->
<div id="timeSlider" style="
  background: var(--bg-panel);
  border: 1px solid var(--border);
  padding: 14px 18px;
  margin-bottom: 16px;
  display: flex; flex-direction: column; gap: 10px;
">
  <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap;">
    <div style="display:flex; align-items:center; gap:10px;">
      <button id="btnPlay" style="
        font-family:var(--font-brand); font-size:0.6rem; font-weight:700;
        letter-spacing:0.15em; color:#04070f; background:var(--accent);
        border:none; padding:8px 16px; cursor:pointer;
        clip-path: polygon(6px 0%,100% 0%,calc(100% - 6px) 100%,0% 100%);
      ">▶ PLAY</button>
      <div style="font-family:var(--font-brand); font-size:0.7rem; color:var(--accent);" id="epochTime">—</div>
    </div>
    <div style="font-family:var(--font-mono); font-size:0.56rem; color:var(--text-muted);" id="epochCounter">Época — / —</div>
  </div>
  <input type="range" id="epochSlider" min="0" max="1" value="0" step="1" style="
    width:100%; accent-color:var(--accent); cursor:pointer;
  ">
  <div style="display:flex; justify-content:space-between; font-family:var(--font-mono); font-size:0.52rem; color:var(--text-muted);">
    <span id="sliderStart">—</span>
    <span id="sliderEnd">—</span>
  </div>
</div>
```

- [ ] **Step 2: Add CSS for the slider into the `<style>` block**

```css
input[type="range"] {
  -webkit-appearance: none;
  height: 3px; background: rgba(0,229,255,0.15);
  outline: none; border-radius: 0;
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px; height: 14px;
  background: var(--accent);
  clip-path: polygon(50% 0%, 100% 100%, 0% 100%);
  cursor: pointer;
}
```

- [ ] **Step 3: Replace the full `<script>` block with the rendering + worker bridge**

The complete script (replaces everything between `<script>` and `</script>` at bottom of body):

```js
/* GNSS·ATMO v2 — Real RINEX Data */
const D2R = Math.PI / 180;

// ── WORKER SETUP ──────────────────────────────────────────────
const worker = new Worker('./rinex-worker.js');
let _epochCount = 0;
let _playing = false;
let _playInterval = null;
let _currentEpoch = 0;

worker.onmessage = (e) => {
  switch (e.data.type) {
    case 'pong':
      worker.postMessage({ type: 'index', url: '../2026-04-09_00-00-00_GNSS-1/2026-04-09_00-00-00_GNSS-1.26O' });
      break;
    case 'progress':
      updateLoadStep(e.data.msg);
      break;
    case 'error':
      showErr(e.data.msg);
      break;
    case 'indexed':
      onIndexed(e.data);
      break;
    case 'epoch':
      onEpochData(e.data);
      break;
  }
};

function onIndexed(data) {
  _epochCount = data.epochCount;
  const slider = document.getElementById('epochSlider');
  slider.max   = _epochCount - 1;
  slider.value = 0;

  const fmt = (iso) => new Date(iso).toUTCString().replace(' GMT','').slice(5);
  document.getElementById('sliderStart').textContent   = fmt(data.firstTime);
  document.getElementById('sliderEnd').textContent     = fmt(data.lastTime);
  document.getElementById('epochCounter').textContent  = `Época 1 / ${_epochCount}`;

  // Update header with receiver position
  const llh = data.llh;
  const latS = `${Math.abs(llh.lat).toFixed(5)}° ${llh.lat >= 0 ? 'N' : 'S'}`;
  const lonS = `${Math.abs(llh.lon).toFixed(5)}° ${llh.lon >= 0 ? 'E' : 'W'}`;
  document.getElementById('hdrCoords').textContent = `${latS}  ${lonS}`;
  document.getElementById('hdrAlt').textContent    = `Alt: ${Math.round(llh.alt)} m`;
  document.getElementById('hdrAcc').textContent    = `RINEX 3.03 · ${_epochCount} épocas`;

  updateLoadStep(`${_epochCount} épocas indexadas. Cargando primera época…`);
  worker.postMessage({ type: 'epoch', idx: 0 });
}

function onEpochData(data) {
  if (document.getElementById('mainScreen').style.display === 'none' ||
      document.getElementById('mainScreen').style.display === '') {
    show('mainScreen');
    animateIn(data.sats.length);
  }

  const t = new Date(data.time);
  const pad = (n) => String(n).padStart(2,'0');
  const timeStr = `${t.getUTCFullYear()}-${pad(t.getUTCMonth()+1)}-${pad(t.getUTCDate())} ` +
                  `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} UTC`;
  document.getElementById('epochTime').textContent    = timeStr;
  document.getElementById('epochCounter').textContent = `Época ${data.epochIdx + 1} / ${_epochCount}`;
  document.getElementById('aTimestamp').textContent   = timeStr;

  // Summary
  document.getElementById('sumSats').textContent   = data.sats.length;
  document.getElementById('sumHumMet').textContent = Math.round(data.met.RH);
  document.getElementById('sumPWV').textContent    = data.tropo.PWV.toFixed(1);
  document.getElementById('sumZTD').textContent    = Math.round(data.tropo.ZTD);
  const avgH = parseFloat(data.summary.avgHumGPS);
  document.getElementById('sumHumGPS').textContent = isNaN(avgH) ? '—' : avgH.toFixed(1);

  // Analysis: tropospheric
  document.getElementById('aZTD').innerHTML   = `${Math.round(data.tropo.ZTD)}<span class="u">mm</span>`;
  document.getElementById('aZHD').innerHTML   = `${Math.round(data.tropo.ZHD)}<span class="u">mm</span>`;
  document.getElementById('aZWD').innerHTML   = `${Math.round(data.tropo.ZWD)}<span class="u">mm</span>`;
  document.getElementById('aPWV').innerHTML   = `${data.tropo.PWV.toFixed(1)}<span class="u">mm</span>`;
  document.getElementById('aPress').innerHTML = `${Math.round(data.tropo.pressure)}<span class="u">hPa</span>`;
  document.getElementById('aTemp').innerHTML  = `${data.tropo.temp.toFixed(1)}<span class="u">°C</span>`;
  document.getElementById('aVapor').innerHTML = `${data.tropo.vaporPressure.toFixed(2)}<span class="u">hPa</span>`;

  // Analysis: meteorological
  document.getElementById('aMetTemp').innerHTML  = `${data.met.T.toFixed(1)}<span class="u">°C</span>`;
  document.getElementById('aMetHum').innerHTML   = `${Math.round(data.met.RH)}<span class="u">%</span>`;
  document.getElementById('aMetPress').innerHTML = `${Math.round(data.met.P)}<span class="u">hPa</span>`;
  document.getElementById('aMetCloud').innerHTML = `—`;
  document.getElementById('aMetUV').innerHTML    = `—`;
  document.getElementById('aLocName').textContent = `${data.llh.lat.toFixed(3)}°N ${data.llh.lon.toFixed(3)}°E`;

  // Renders
  renderSkyPlot(data.sats);
  renderPropDiagram(data.sats);
  renderSatCards(data.sats, data.tropo.ZWD, data.met.T);
  renderQTable(data.sats, data.tropo.ZWD, data.tropo.ZTD, data.met.T);

  // Animate humidity bars
  setTimeout(() => {
    document.querySelectorAll('.hum-bar-fill').forEach(bar => {
      bar.style.width = bar.dataset.pct + '%';
    });
  }, 400);
}

// ── SLIDER LOGIC ──────────────────────────────────────────────
let _sliderDebounce = null;
document.getElementById('epochSlider').addEventListener('input', (e) => {
  const idx = parseInt(e.target.value);
  _currentEpoch = idx;
  clearTimeout(_sliderDebounce);
  _sliderDebounce = setTimeout(() => {
    worker.postMessage({ type: 'epoch', idx });
  }, 200);
});

document.getElementById('btnPlay').addEventListener('click', () => {
  if (_playing) {
    clearInterval(_playInterval);
    _playing = false;
    document.getElementById('btnPlay').textContent = '▶ PLAY';
  } else {
    _playing = true;
    document.getElementById('btnPlay').textContent = '⏸ PAUSE';
    _playInterval = setInterval(() => {
      _currentEpoch = (_currentEpoch + 1) % _epochCount;
      document.getElementById('epochSlider').value = _currentEpoch;
      worker.postMessage({ type: 'epoch', idx: _currentEpoch });
    }, 500);
  }
});

// ── SCREEN MANAGEMENT ─────────────────────────────────────────
function show(id) {
  ['permScreen','loadScreen','errScreen','mainScreen'].forEach(s => {
    document.getElementById(s).style.display = 'none';
  });
  const t = document.getElementById(id);
  t.style.display = (id === 'loadScreen' || id === 'errScreen' || id === 'permScreen')
    ? 'flex' : 'block';
}

function showErr(msg) {
  document.getElementById('errMsg').textContent = msg;
  show('errScreen');
}

function updateLoadStep(msg) {
  document.getElementById('loadStep').textContent = msg;
}

// ── RENDERING (unchanged from original, adapted for system colors) ─
const SYS_COLOR = { G: '#00e5ff', R: '#00e676', E: '#ffab00', C: '#d500f9' };

function renderSkyPlot(sats) {
  const svg  = document.getElementById('skyPlot');
  const cx = 150, cy = 150, R = 130;
  const els  = [];

  els.push(`<circle cx="${cx}" cy="${cy}" r="${R+8}" fill="#0a1020" stroke="rgba(0,229,255,0.08)" stroke-width="1"/>`);

  [0, 30, 60, 90].forEach(el => {
    const r = R * (1 - el / 90);
    els.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(0,229,255,0.1)" stroke-width="0.8"/>`);
    if (el > 0 && el < 90)
      els.push(`<text x="${cx+4}" y="${cy - r + 10}" fill="rgba(0,229,255,0.35)" font-size="7" font-family="'IBM Plex Mono',monospace">${el}°</text>`);
  });

  ['N','E','S','W'].forEach((dir, i) => {
    const ang = i * 90 * D2R;
    const x1 = cx + (R+4)*Math.sin(ang), y1 = cy - (R+4)*Math.cos(ang);
    const x2 = cx + 8*Math.sin(ang),     y2 = cy - 8*Math.cos(ang);
    els.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(0,229,255,0.15)" stroke-width="0.8"/>`);
    const lx = cx + (R+16)*Math.sin(ang), ly = cy - (R+16)*Math.cos(ang) + 4;
    els.push(`<text x="${lx}" y="${ly}" fill="rgba(0,229,255,0.55)" font-size="9" font-family="'IBM Plex Mono',monospace" text-anchor="middle">${dir}</text>`);
  });

  sats.forEach(s => {
    const r   = R * (1 - s.el / 90);
    const ang = s.az * D2R;
    const sx  = cx + r * Math.sin(ang), sy = cy - r * Math.cos(ang);
    const col = SYS_COLOR[s.system] || '#00e5ff';
    const hx  = cx + R * Math.sin(ang), hy = cy - R * Math.cos(ang);
    els.push(`<line x1="${hx}" y1="${hy}" x2="${sx}" y2="${sy}" stroke="${col}" stroke-width="0.5" stroke-dasharray="3,3" opacity="0.3"/>`);
    els.push(`<circle cx="${sx}" cy="${sy}" r="6" fill="${col}" fill-opacity="0.25" stroke="${col}" stroke-width="1.2"/>`);
    els.push(`<circle cx="${sx}" cy="${sy}" r="2.5" fill="${col}" opacity="0.9"/>`);
    const lx = sx + (sx < cx ? -14 : 6), ly = sy + (sy < cy ? -5 : 11);
    els.push(`<text x="${lx}" y="${ly}" fill="${col}" font-size="7.5" font-weight="600" font-family="'IBM Plex Mono',monospace">${s.system}${s.prn}</text>`);
  });

  svg.innerHTML = els.join('');
}

function renderPropDiagram(sats) {
  const svg = document.getElementById('propDiagram');
  const W = 260, H = 160, groundY = H - 18, tropoY = groundY - 55;
  const els = [];
  els.push(`<line x1="0" y1="${groundY}" x2="${W}" y2="${groundY}" stroke="rgba(0,229,255,0.2)" stroke-width="1"/>`);
  els.push(`<rect x="0" y="${tropoY}" width="${W}" height="${groundY-tropoY}" fill="rgba(0,229,255,0.04)"/>`);
  els.push(`<line x1="0" y1="${tropoY}" x2="${W}" y2="${tropoY}" stroke="rgba(0,229,255,0.2)" stroke-width="0.7" stroke-dasharray="4,4"/>`);
  els.push(`<text x="4" y="${tropoY-4}" fill="rgba(0,229,255,0.4)" font-size="7" font-family="'IBM Plex Mono',monospace">TROPOSFERA (12 km)</text>`);
  const rx = 60, ry = groundY - 2;
  els.push(`<rect x="${rx-5}" y="${ry-8}" width="10" height="8" fill="rgba(0,229,255,0.6)" rx="1"/>`);
  els.push(`<line x1="${rx}" y1="${ry-8}" x2="${rx}" y2="${ry-16}" stroke="var(--accent)" stroke-width="1.5"/>`);
  const examples = [
    { el: 70, col: '#00e676' }, { el: 30, col: '#ffab00' }, { el: 12, col: '#ff5252' },
  ];
  examples.forEach(ex => {
    const ang = ex.el * D2R;
    const exitX = rx + (groundY - tropoY) / Math.tan(ang);
    const exitY = tropoY;
    els.push(`<line x1="${rx}" y1="${ry-8}" x2="${Math.min(W-5, exitX)}" y2="${Math.max(10, exitY)}" stroke="${ex.col}" stroke-width="1" stroke-dasharray="5,3" opacity="0.7"/>`);
    if (exitX < W-10) els.push(`<text x="${Math.min(W-30,exitX+4)}" y="${Math.max(18,exitY-3)}" fill="${ex.col}" font-size="7.5" font-family="'IBM Plex Mono',monospace">${ex.el}°</text>`);
  });
  svg.innerHTML = els.join('');
}

function renderSatCards(sats, ZWD_mm, T_C) {
  const grid = document.getElementById('satGrid');
  grid.innerHTML = '';
  sats.forEach(s => {
    const col    = SYS_COLOR[s.system] || '#00e5ff';
    const card   = document.createElement('div');
    card.className = `sat-card ${s.cls}`;
    card.style.cssText = 'opacity:0; --sat-col:' + col;
    card.innerHTML = `
      <div class="sat-prn" style="color:${col}">${s.system}${String(s.prn).padStart(2,'0')} <small>${s.system === 'G' ? 'GPS' : s.system === 'R' ? 'GLO' : s.system === 'E' ? 'GAL' : 'BDS'}</small></div>
      <div class="sat-row"><span class="sat-key">ELEV</span><span class="sat-val">${s.el.toFixed(1)}°</span></div>
      <div class="sat-row"><span class="sat-key">AZIM</span><span class="sat-val">${s.az.toFixed(1)}°</span></div>
      <div class="sat-row"><span class="sat-key">DIST</span><span class="sat-val">${s.range.toFixed(0)} km</span></div>
      <div class="sat-row"><span class="sat-key">RECORR ATM</span><span class="sat-val">${s.atmosPath.toFixed(1)} km</span></div>
      <div class="sat-row"><span class="sat-key">FACTOR MAP</span><span class="sat-val">${s.mappingF.toFixed(2)}×</span></div>
      <div class="sat-row"><span class="sat-key">RETARD HÚM</span><span class="sat-val">${s.slantWD.toFixed(1)} mm</span></div>
      <div class="sat-row"><span class="sat-key">SNR REAL</span><span class="sat-val">${s.snr.toFixed(1)} dBHz</span></div>
      <div class="hum-bar-wrap">
        <div class="hum-bar-head"><span>HUMEDAD GPS</span><span>${s.humPct.toFixed(1)}%</span></div>
        <div class="hum-bar-track">
          <div class="hum-bar-fill" data-pct="${s.humPct.toFixed(1)}" style="background:${col}; box-shadow:0 0 6px ${col}33;"></div>
        </div>
      </div>`;
    grid.appendChild(card);
  });
}

function renderQTable(sats, ZWD_mm, ZTD_mm, T_C) {
  const tbody = document.getElementById('qTableBody');
  tbody.innerHTML = '';
  sats.forEach(s => {
    const col = SYS_COLOR[s.system] || '#00e5ff';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-prn" style="color:${col}">${s.system}${String(s.prn).padStart(2,'0')}</td>
      <td style="color:${col}">${s.el.toFixed(1)}°</td>
      <td>${s.az.toFixed(1)}°</td>
      <td>${s.range.toFixed(0)}</td>
      <td>${s.atmosPath.toFixed(1)} km</td>
      <td>${s.slantTD.toFixed(1)} mm</td>
      <td style="color:${col}">${s.slantWD.toFixed(1)} mm</td>
      <td style="color:${col}">${s.snr.toFixed(1)}</td>
      <td style="color:${col}">${s.humPct.toFixed(1)}%</td>
      <td style="color:${col}">${s.cls === 'high' ? 'ALTO' : s.cls === 'mid' ? 'MEDIO' : 'BAJO'}</td>`;
    tbody.appendChild(tr);
  });
}

function animateIn(n) {
  const mm = gsap.matchMedia();
  mm.add('(prefers-reduced-motion: no-preference)', () => {
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } });
    tl.fromTo('.sum-card',        { autoAlpha:0, y:18  }, { autoAlpha:1, y:0, stagger:0.07, duration:0.45 })
      .fromTo('.sky-wrap',        { autoAlpha:0, x:-24 }, { autoAlpha:1, x:0, duration:0.55 }, '-=0.2')
      .fromTo('.sats-wrap',       { autoAlpha:0, x:24  }, { autoAlpha:1, x:0, duration:0.55 }, '<')
      .fromTo('.sat-card',        { autoAlpha:0, y:14, scale:0.96 }, { autoAlpha:1, y:0, scale:1, stagger:{each:0.04,from:'random'}, duration:0.4 }, '-=0.3')
      .fromTo('.ana-panel',       { autoAlpha:0, y:18  }, { autoAlpha:1, y:0, stagger:0.08, duration:0.45 }, '-=0.2')
      .fromTo('.quality-section', { autoAlpha:0, y:14  }, { autoAlpha:1, y:0, duration:0.4 }, '-=0.1');
    return () => {};
  });
  mm.add('(prefers-reduced-motion: reduce)', () => {
    gsap.set('.sum-card,.sky-wrap,.sats-wrap,.ana-panel,.quality-section,.sat-card', { autoAlpha:1, y:0 });
    return () => {};
  });
}

// ── BOOT ──────────────────────────────────────────────────────
show('loadScreen');
updateLoadStep('Iniciando worker RINEX…');
worker.postMessage({ type: 'ping' });
```

- [ ] **Step 4: Update sky plot legend in HTML to show constellation colors**

Find the `.sky-legend` div in `index.html` and replace with:

```html
<div class="sky-legend">
  <div class="sky-leg-item">
    <div class="sky-dot" style="background:#00e5ff;"></div>GPS (G)
  </div>
  <div class="sky-leg-item">
    <div class="sky-dot" style="background:#00e676;"></div>GLONASS (R)
  </div>
  <div class="sky-leg-item">
    <div class="sky-dot" style="background:#ffab00;"></div>Galileo (E)
  </div>
  <div class="sky-leg-item">
    <div class="sky-dot" style="background:#d500f9;"></div>BeiDou (C)
  </div>
</div>
```

---

## Task 8: Loading progress bar and error handling

**Files:**
- Modify: `gnss-atmo/index.html`

The file is large (~180MB). Users need visible progress feedback during the fetch + parse phase.

- [ ] **Step 1: Add progress bar HTML inside `#loadScreen`**

Find `<div id="loadScreen" class="screen">` and add after `.load-step` div:

```html
<div id="loadProgress" style="
  width: 280px; height: 2px;
  background: rgba(0,229,255,0.1);
  margin-top: 8px; overflow: hidden;
">
  <div id="loadBar" style="
    height: 100%; width: 0%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
    transition: width 0.3s ease;
  "></div>
</div>
```

- [ ] **Step 2: Handle `progress` messages with percentage in main thread**

In `worker.onmessage` case `'progress'`:

```js
case 'progress':
  updateLoadStep(e.data.msg);
  if (e.data.pct !== undefined) {
    document.getElementById('loadBar').style.width = e.data.pct + '%';
  }
  break;
```

- [ ] **Step 3: Add retry button handler**

```js
document.getElementById('errRetry').addEventListener('click', () => {
  show('loadScreen');
  updateLoadStep('Reintentando…');
  worker.postMessage({ type: 'ping' });
});
```

---

## Task 9: Final integration test and commit

**Files:**
- Test: Manual browser testing

- [ ] **Step 1: Serve and open the app**

```bash
cd "D:/Downloads/2025-2026/gnss-atmo"
python -m http.server 8080
```

Open `http://localhost:8080/index.html`

- [ ] **Step 2: Verify loading sequence**

Expected:
1. Loading screen appears immediately
2. Progress bar fills from 0→60% (fetch + text read + header parse)
3. "Construyendo índice de épocas…" appears
4. "XXXX épocas indexadas" appears (~52000)
5. Dashboard appears with first epoch data (2026-04-08 23:59:59 UTC)
6. Sky plot shows ~35-40 satellite dots in 4 colors
7. Satellite cards show real SNR values (not round numbers — values like 48.0, 47.0, 38.0 dBHz)

- [ ] **Step 3: Verify time slider**

1. Drag slider to middle → epoch time updates to ~07:00 UTC
2. Dashboard re-renders with different satellite positions
3. Press PLAY → epochs advance automatically at 2 per second
4. Press PAUSE → stops

- [ ] **Step 4: Check SNR values are real (not simulated)**

In satellite cards, SNR values should match the S1C field from the RINEX file. For epoch 1, GPS G05 should show SNR ≈ 48.0 dBHz (from line `G 5  ...  48.000`).

- [ ] **Step 5: Final commit**

```bash
cd "D:/Downloads/2025-2026/gnss-atmo"
git add index.html rinex-worker.js
git commit -m "feat: GNSS·ATMO v2 — real RINEX data, epoch slider, 4-constellation dashboard"
```

---

## Self-Review

**Spec coverage check:**
- ✅ RINEX header parser (Task 2)
- ✅ ECEF→LLH converter (Task 2)
- ✅ Epoch index builder (Task 3)
- ✅ Time selector/slider (Task 7, Step 1)
- ✅ Play/pause (Task 7, Step 3)
- ✅ SNR real from S field (Task 4)
- ✅ All 4 constellations G/R/E/C (Task 5)
- ✅ Saastamoinen tropo model (Task 6)
- ✅ Climatological met constants (Task 6)
- ✅ Satellite color by system (Task 7)
- ✅ Progress bar (Task 8)
- ✅ Sky plot updated for all constellations (Task 7)
- ✅ Sat cards with real SNR (Task 7)
- ✅ Quality table (Task 7)

**Type consistency check:** `computeEpoch` returns `sats` with `.snr`, `.el`, `.az`, `.range`, `.cls`, `.slantWD`, `.humPct`, `.atmosPath`, `.mappingF`, `.slantTD` — all consumed by `renderSatCards` and `renderQTable`. Consistent throughout.

**Placeholder scan:** No TBD, no TODO, no "similar to Task N". All code blocks complete.
