# GNSS·ATMO v2 — Real RINEX Data Design

**Date:** 2026-04-20  
**Status:** Approved

## Overview

Replace all simulated/API-fetched data in GNSS·ATMO with real observations from `2026-04-09_00-00-00_GNSS-1.26O` (RINEX 3.03, ~14.5h session). Add a time-scrubbing slider so the user can explore any epoch across the full session.

## File Structure

```
gnss-atmo/
  index.html          # single-file app shell + all CSS
  rinex-worker.js     # Web Worker: RINEX parsing, orbit calc, tropo model
  2026-04-09_00-00-00_GNSS-1.26O  # symlink or copy of the source file
```

## Data Source

**File:** `../2026-04-09_00-00-00_GNSS-1/2026-04-09_00-00-00_GNSS-1.26O`  
**Format:** RINEX 3.03 Observation, Mixed constellation  
**Period:** 2026-04-08 23:59:59 UTC → 2026-04-09 14:34:58 UTC (~14.5h)  
**Receiver position (ECEF):** x=3917062.9861, y=1284878.5261, z=4850970.2738 m  
**Constellations:** G (GPS), R (GLONASS), E (Galileo), C (BeiDou)  
**Key observables used:** C1C (pseudorange), S1C/S1X/S2I/S2C (SNR dB-Hz)

## Architecture

### Web Worker (rinex-worker.js)

Runs off the main thread. Receives messages:
- `{type:'index', url}` → parse full file, build epoch index, reply with index metadata
- `{type:'epoch', offset, numSats, systems}` → parse single epoch, reply with sat array + computed values

**Epoch index structure** (built once on load):
```js
[{ time: Date, lineOffset: number, numSats: number }, ...]
// ~52000 entries, ~3MB in memory
```

**Single-epoch parse output:**
```js
{
  time: Date,
  receiverLLH: { lat, lon, alt },  // from ECEF header (constant)
  satellites: [{
    system: 'G'|'R'|'E'|'C',
    prn: number,
    el: number,      // degrees, from orbital model
    az: number,      // degrees
    range: number,   // km
    snr: number,     // real dB-Hz from S1C/S1X/S2I
    slantWD: number, // mm wet delay along signal path
    humPct: number,  // % GPS humidity
    cls: 'high'|'mid'|'low'
  }],
  tropo: { ZTD, ZHD, ZWD, PWV, pressure, temp, vaporPressure },
  summary: { numSats, avgHumGPS, humMet }
}
```

### Main Thread (index.html inline script)

1. On load: `fetch()` the RINEX file as text, transfer to worker via `postMessage({type:'index', text})`
2. Worker replies with epoch count + time range → render slider
3. On slider change (debounced 200ms): `postMessage({type:'epoch', idx})`
4. Worker replies with epoch data → update all DOM elements (same IDs as original)

### RINEX Parser Logic

**Header parse** (first 27 lines):
- Extract ECEF XYZ from `APPROX POSITION XYZ` line
- Extract observable types per system from `SYS / # / OBS TYPES`

**Body parse** — epoch detection:
- Line starts with `> ` → new epoch header: parse year/month/day/hr/min/sec, numSats
- Following N lines: first char = system letter, chars 1-2 = PRN, then 8 fields of 16 chars each (value + signal strength)
- Field order per system from header (e.g., GPS: C1C L1C D1C S1C C2X L2X D2X S2X)
- S1C is field index 3 (0-based) for GPS → chars at position 3×16+3 to 3×16+13 of the observation line

**SNR extraction:** value in dB-Hz (range 25-52 in this file). Blank/zero = satellite not usable.

### Orbital Model

Same simplified Keplerian model as original (circular orbits, 6 planes × 4 for GPS). For GLONASS, Galileo, BeiDou: use same constellation template scaled to their orbital parameters:
- GLONASS: a=25510000m, i=64.8°, 3 planes × 8
- Galileo: a=29600000m, i=56°, 3 planes × 9  
- BeiDou MEO: a=27906000m, i=55°, 3 planes × 7

> Note: orbital positions are approximate (no broadcast ephemeris in this RINEX-O file). Elevation/azimut will be realistic but not cm-accurate. SNR is real.

### Meteorological Model

No external API. Use climatological values for the receiver location and date:
- Receiver location: computed from ECEF → ~41.4°N, 18.1°E (Albania/Adriatic area based on ECEF coords)
- Date: 9 April 2026, spring
- **T = 12°C, RH = 65%, P = 1013 hPa** (standard spring Mediterranean coast)
- These are fixed constants — the humidity variation comes from satellite geometry (elevation, SNR), not from varying met conditions

### Time Slider UI

- Full-width slider below the header, before summary cards
- Shows current epoch time (UTC) as `2026-04-09 HH:MM:SS UTC`
- Left/right labels show session start/end
- Play/pause button for auto-advance (1 epoch/500ms = ~14.5h in ~7 minutes)
- Epoch count badge: `Época 1234 / 52000`

### Satellite Color Coding by System

| System | Color |
|--------|-------|
| GPS (G) | cyan `#00e5ff` |
| GLONASS (R) | green `#00e676` |
| Galileo (E) | amber `#ffab00` |
| BeiDou (C) | purple `#d500f9` |

Sky plot and cards use system color instead of elevation-only color.

## Performance

- RINEX file is ~180MB text. `fetch()` + full text parse for index takes ~10-15s on a modern machine. Show progress bar.
- Index building: scan only epoch header lines (`> ` prefix) — skip observation lines. Store byte offset via running char count.
- Per-epoch parse: only parse the ~40 observation lines of the selected epoch. Fast (<1ms).
- Worker uses `ReadableStream` chunked reading if `fetch` streaming is available; fallback to full text.

## No External Dependencies Added

GSAP already loaded via CDN in original. No new CDN calls. No API calls. Works fully offline after initial file load.
