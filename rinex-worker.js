// GNSS·ATMO v2 — Web Worker: RINEX parser + orbital model + tropospheric model

// ── CONSTANTS ─────────────────────────────────────────────────
const WGS84_a  = 6378137.0;
const WGS84_f  = 1 / 298.257223563;
const WGS84_e2 = 2 * WGS84_f - WGS84_f * WGS84_f;
const WGS84_we = 7.2921150e-5;
const D2R = Math.PI / 180;

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6, 0, 0, 0);
const GPS_LEAPSEC  = 18;

// Session meteorological constants (9 April 2026, ~41°N Adriatic coast)
const MET = { T: 12, RH: 65, P: 1013 };

// ── CONSTELLATIONS ────────────────────────────────────────────
const CONSTELLATIONS = {
  G: {
    GM: 3.986005e14, a: 26559800, i: 55 * D2R,
    planes: [
      [  0,   0,  4],[  0,  92, 27],[  0, 185,  9],[  0, 277, 16],
      [ 60,  38,  2],[ 60, 131, 20],[ 60, 224, 11],[ 60, 317, 28],
      [120,  76,  7],[120, 169,  3],[120, 262, 23],[120, 355, 19],
      [180, 114,  6],[180, 207, 30],[180, 300, 22],[180,  37, 26],
      [240, 152, 13],[240, 245, 25],[240, 338, 29],[240,  71, 14],
      [300, 190, 17],[300, 283,  1],[300,  16, 24],[300, 109, 10],
      [ 30,  55, 31],[ 90, 145, 32],[150, 235,  5],[210, 325,  8],
    ],
  },
  R: {
    GM: 3.9860044e14, a: 25510000, i: 64.8 * D2R,
    planes: [
      [  0,   0,  1],[  0,  45,  2],[  0,  90,  3],[  0, 135,  4],
      [ 45, 180,  5],[ 45, 225,  6],[ 45, 270,  7],[ 45, 315,  8],
      [ 90,   0,  9],[ 90,  45, 10],[ 90,  90, 11],[ 90, 135, 12],
      [135, 180, 13],[135, 225, 14],[135, 270, 15],[135, 315, 16],
      [180,   0, 17],[180,  45, 18],[180,  90, 19],[180, 135, 20],
      [225, 180, 21],[225, 225, 22],[225, 270, 23],[225, 315, 24],
    ],
  },
  E: {
    GM: 3.986004418e14, a: 29600000, i: 56 * D2R,
    planes: [
      [  0,   0,  1],[  0,  40,  2],[  0,  80,  3],[  0, 120,  4],
      [  0, 160,  5],[  0, 200,  6],[  0, 240,  7],[  0, 280,  8],
      [  0, 320,  9],
      [120,  20, 11],[120,  60, 13],[120, 100, 15],[120, 140, 21],
      [120, 180, 24],[120, 220, 25],[120, 260, 26],[120, 300, 27],
      [120, 340, 28],
      [240,  10, 31],[240,  50, 33],[240,  90, 34],[240, 130, 36],
      [240, 170, 30],[240, 210, 32],[240, 250,  4],[240, 290,  9],
    ],
  },
  C: {
    GM: 3.986004418e14, a: 27906000, i: 55 * D2R,
    planes: [
      [  0,   0,  6],[  0,  51,  9],[  0, 103, 11],[  0, 154, 12],
      [  0, 206, 13],[  0, 257, 14],[  0, 309, 19],
      [120,  25, 20],[120,  77, 21],[120, 128, 22],[120, 180, 23],
      [120, 231, 25],[120, 283, 26],[120, 334, 27],
      [240,  12, 28],[240,  64, 29],[240, 115, 30],[240, 167, 32],
      [240, 218, 33],[240, 270, 34],[240, 321, 37],
    ],
  },
};

// ── STATE ─────────────────────────────────────────────────────
let _lines      = null;
let _header     = null;
let _epochIndex = null;

// ── HEADER PARSER ─────────────────────────────────────────────
function parseHeader(lines) {
  const result = {
    ecef: { x: 3917062.9861, y: 1284878.5261, z: 4850970.2738 },
    obsTypes: {},
    headerEndIndex: 0,
  };
  for (let i = 0; i < lines.length; i++) {
    const line  = lines[i];
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
        const count = parseInt(line.slice(1, 6));
        const types = line.slice(7, 60).trim().split(/\s+/).filter(Boolean);
        result.obsTypes[sys] = { count, types };
        result._lastObsSys = sys;
      } else if (result._lastObsSys) {
        // continuation line — append extra types
        const more = line.slice(7, 60).trim().split(/\s+/).filter(Boolean);
        result.obsTypes[result._lastObsSys].types.push(...more);
      }
    }
  }
  delete result._lastObsSys;
  return result;
}

// ── ECEF → LLH ────────────────────────────────────────────────
function ecef2llh(x, y, z) {
  const a  = WGS84_a;
  const e2 = WGS84_e2;
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
  const alt = Math.abs(lat) < Math.PI / 4
    ? p / Math.cos(lat) - N
    : z / sinLat - N * (1 - e2);
  return { lat: lat * (180 / Math.PI), lon, alt };
}

// ── EPOCH INDEX ───────────────────────────────────────────────
function buildEpochIndex(lines, startIdx, onProgress) {
  const index = [];
  const total = lines.length - startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].charAt(0) === '>') {
      const L = lines[i];
      const yr  = parseInt(L.slice(2, 6));
      const mo  = parseInt(L.slice(7, 9)) - 1;
      const dy  = parseInt(L.slice(10, 12));
      const hr  = parseInt(L.slice(13, 15));
      const mn  = parseInt(L.slice(16, 18));
      const sec = parseFloat(L.slice(19, 29));
      const numSats = parseInt(L.slice(32, 35));
      if (isNaN(yr) || isNaN(mo) || isNaN(dy) || isNaN(hr) || isNaN(mn) || isNaN(sec) || isNaN(numSats)) continue;
      const secFloor = Math.floor(sec);
      const time = new Date(Date.UTC(yr, mo, dy, hr, mn, secFloor));
      if (isNaN(time.getTime())) continue;
      index.push({ lineIdx: i, time, numSats });
      if (onProgress && index.length % 5000 === 0) {
        const pct = 60 + Math.round(35 * (i - startIdx) / total);
        onProgress(pct);
      }
    }
  }
  return index;
}

// ── OBSERVATION PARSER ────────────────────────────────────────
function snrOffset(system, obsTypes) {
  const types = (obsTypes[system] && obsTypes[system].types) ? obsTypes[system].types : [];
  const idx = types.findIndex(t => t.startsWith('S'));
  if (idx < 0) return -1;
  // For this RINEX file S-type is always at field index 3 (offset 51).
  // Assert and fall back to dynamic only if header differs.
  return idx === 3 ? 51 : 3 + idx * 16;
}

function parseObsLine(line, obsTypes) {
  if (!line || line.length < 3) return null;
  const system = line[0];
  if (!['G','R','E','C'].includes(system)) return null;
  const prn = parseInt(line.slice(1, 3));
  if (isNaN(prn)) return null;
  const off = snrOffset(system, obsTypes);
  let snr = 0;
  if (off >= 0 && line.length > off + 13) {
    const raw = line.slice(off, off + 14).trim();
    snr = raw ? (parseFloat(raw) || 0) : 0;
  }
  return { system, prn, snr };
}

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

// ── ORBITAL MODEL ─────────────────────────────────────────────
function getGPSSec(date) {
  return (date.getTime() - GPS_EPOCH_MS) / 1000 + GPS_LEAPSEC;
}

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
  const el  = Math.asin(U / r) * (180 / Math.PI);
  const az  = ((Math.atan2(E, N) * (180 / Math.PI)) + 360) % 360;
  return { el, az, range: r / 1000 };
}

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
    if (el < 5) continue;
    const cls = el >= 40 ? 'high' : el >= 20 ? 'mid' : 'low';
    results.push({ system: obs.system, prn: obs.prn, snr: obs.snr, el, az, range, cls });
  }
  return results.sort((a, b) => b.el - a.el);
}

// ── TROPOSPHERIC MODEL ────────────────────────────────────────
function vaporPressure(T_C, RH) {
  return (RH / 100) * 6.1078 * Math.exp(17.27 * T_C / (T_C + 237.3));
}

function zenithDelay(P, T, RH, lat, h_km) {
  const T_K = T + 273.15;
  const e   = vaporPressure(T, RH);
  const phi = lat * D2R;
  const ZHD = 0.002277 * P / (1 - 0.00266 * Math.cos(2 * phi) - 0.00028 * h_km);
  const ZWD = 0.002277 * (1255 / T_K + 0.05) * e;
  return { ZHD: ZHD * 1000, ZWD: ZWD * 1000, ZTD: (ZHD + ZWD) * 1000 };
}

function precipitableWater(ZWD_mm, T_C) {
  const T_K = T_C + 273.15;
  const Pi  = 0.0721 + 0.000268 * T_K;
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

// ── EPOCH COMPUTATION ─────────────────────────────────────────
function computeEpoch(epochIdx) {
  const entry   = _epochIndex[epochIdx];
  const obs     = parseEpochObs(_lines, entry, _header.obsTypes);
  const llh     = ecef2llh(_header.ecef.x, _header.ecef.y, _header.ecef.z);
  const obsECEF = _header.ecef;
  const sats    = computeGeometry(obs, obsECEF, llh, entry.time);

  const h_km  = llh.alt / 1000;
  const { ZHD, ZWD, ZTD } = zenithDelay(MET.P, MET.T, MET.RH, llh.lat, h_km);
  const PWV   = precipitableWater(ZWD, MET.T);
  const e     = vaporPressure(MET.T, MET.RH);

  sats.forEach(s => {
    s.slantWD   = ZWD * mappingFunc(s.el);
    s.humPct    = satHumidityPct(ZWD, s.el);
    s.atmosPath = 12 / Math.sin(Math.max(5, s.el) * D2R);
    s.mappingF  = mappingFunc(s.el);
    s.slantTD   = ZTD * mappingFunc(s.el);
  });

  const humVals   = sats.map(s => s.humPct);
  const avgHumGPS = humVals.length
    ? (humVals.reduce((a, b) => a + b, 0) / humVals.length)
    : 0;

  return {
    type: 'epoch',
    epochIdx,
    time: entry.time.toISOString(),
    llh,
    sats,
    tropo: { ZTD, ZHD, ZWD, PWV, pressure: MET.P, temp: MET.T, vaporPressure: e },
    met:   { T: MET.T, RH: MET.RH, P: MET.P },
    summary: { numSats: sats.length, avgHumGPS: avgHumGPS.toFixed(1) },
  };
}

// ── MESSAGE HANDLER ───────────────────────────────────────────
self.onmessage = async function(e) {
  if (e.data.type === 'ping') {
    self.postMessage({ type: 'pong' });
    return;
  }

  if (e.data.type === 'index') {
    try {
      let text;
      if (e.data.text) {
        text = e.data.text;
        self.postMessage({ type: 'progress', msg: 'Archivo cargado localmente…', pct: 30 });
      } else {
        self.postMessage({ type: 'progress', msg: 'Descargando archivo RINEX…', pct: 0 });
        const resp = await fetch(e.data.url);
        if (!resp.ok) {
          self.postMessage({ type: 'error', msg: 'No se pudo cargar el archivo RINEX: ' + resp.status });
          return;
        }
        const isGzip = e.data.url.endsWith('.gz') || e.data.url.endsWith('.bin');
        if (isGzip) {
          self.postMessage({ type: 'progress', msg: 'Descomprimiendo…', pct: 20 });
          const ds = new DecompressionStream('gzip');
          const decompressed = resp.body.pipeThrough(ds);
          const reader = decompressed.getReader();
          const decoder = new TextDecoder('utf-8');
          let result = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) { result += decoder.decode(); break; }
            result += decoder.decode(value, { stream: true });
          }
          text = result;
        } else {
          text = await resp.text();
        }
        self.postMessage({ type: 'progress', msg: 'Leyendo texto…', pct: 30 });
      }

      self.postMessage({ type: 'progress', msg: 'Parseando cabecera…', pct: 50 });
      _lines  = text.split('\n');
      _header = parseHeader(_lines);

      self.postMessage({ type: 'progress', msg: 'Construyendo índice de épocas…', pct: 60 });
      _epochIndex = buildEpochIndex(_lines, _header.headerEndIndex, (pct) => {
        self.postMessage({ type: 'progress', msg: 'Indexando épocas…', pct });
      });

      if (_epochIndex.length === 0) {
        self.postMessage({ type: 'error', msg: 'No se encontraron épocas en el archivo RINEX.' });
        return;
      }

      self.postMessage({ type: 'progress', msg: 'Índice completo.', pct: 100 });

      const llh = ecef2llh(_header.ecef.x, _header.ecef.y, _header.ecef.z);
      self.postMessage({
        type: 'indexed',
        epochCount: _epochIndex.length,
        firstTime:  _epochIndex[0].time.toISOString(),
        lastTime:   _epochIndex[_epochIndex.length - 1].time.toISOString(),
        llh,
        obsTypes:   _header.obsTypes,
      });
    } catch (err) {
      self.postMessage({ type: 'error', msg: 'Error procesando RINEX: ' + err.message });
    }
    return;
  }

  if (e.data.type === 'epoch') {
    if (!_epochIndex) {
      self.postMessage({ type: 'error', msg: 'Índice no disponible aún.' });
      return;
    }
    const idx  = Math.max(0, Math.min(e.data.idx, _epochIndex.length - 1));
    const data = computeEpoch(idx);
    self.postMessage(data);
    return;
  }
};
