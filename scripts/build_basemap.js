#!/usr/bin/env node
// Build a compact offline basemap extract for TJU Peiyang Park campus
// from the Overpass JSON dumps in the project root.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'osm_raw.json');
const BND = path.join(ROOT, 'campus_boundary.json');
const EXTRA = path.join(ROOT, 'data', 'extra_buildings.json');
const OUT = path.join(ROOT, 'data', 'basemap.json');

const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
const bnd = JSON.parse(fs.readFileSync(BND, 'utf8'));
const ways = raw.elements.filter(e => e.type === 'way');
const relations = raw.elements.filter(e => e.type === 'relation');
const boundaryWay = bnd.elements.find(e => e.id === 476603051);
if (!boundaryWay) throw new Error('boundary way 476603051 not found');

const r6 = v => Math.round(v * 1e6) / 1e6;

function toPts(geometry) {
  const out = [];
  for (const p of geometry) {
    const pt = [r6(p.lon), r6(p.lat)];
    const last = out[out.length - 1];
    if (last && last[0] === pt[0] && last[1] === pt[1]) continue;
    out.push(pt);
  }
  return out;
}

function samePt(a, b) { return a[0] === b[0] && a[1] === b[1]; }

function closeRing(pts) {
  if (pts.length < 3) return null;
  const ring = pts.slice();
  if (!samePt(ring[0], ring[ring.length - 1])) ring.push(ring[0].slice());
  if (ring.length < 4) return null;
  return ring;
}

// Approximate polygon area in m^2 (local equirectangular projection).
function areaM2(ring) {
  const lat0 = ring[0][1] * Math.PI / 180;
  const mx = 111320 * Math.cos(lat0), my = 110540;
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += (ring[i][0] * mx) * (ring[i + 1][1] * my) - (ring[i + 1][0] * mx) * (ring[i][1] * my);
  }
  return Math.abs(s / 2);
}

function poly(geometry, minArea) {
  const ring = closeRing(toPts(geometry));
  if (!ring) return null;
  if (areaM2(ring) < (minArea || 0.5)) return null;
  return ring;
}

function line(geometry) {
  const pts = toPts(geometry);
  if (pts.length < 2) return null;
  let distinct = 1;
  for (let i = 1; i < pts.length; i++) if (!samePt(pts[i], pts[i - 1])) distinct++;
  if (distinct < 2) return null;
  return pts;
}

function keyOf(geom) { return JSON.stringify(geom); }

function nameOf(tags) {
  return (tags['name:zh'] || tags.name || '').trim();
}

// ---- boundary + bbox ----
const boundaryPts = toPts(boundaryWay.geometry);
const boundaryRing = closeRing(boundaryPts);
if (!boundaryRing) throw new Error('bad boundary ring');
let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
for (const p of boundaryRing) {
  minLon = Math.min(minLon, p[0]); maxLon = Math.max(maxLon, p[0]);
  minLat = Math.min(minLat, p[1]); maxLat = Math.max(maxLat, p[1]);
}
const bbox = [r6(minLon), r6(minLat), r6(maxLon), r6(maxLat)];

// ---- collect layers ----
const buildings = [];
const roads = [];
const areas = [];
const sports = [];

const seenB = new Set(), seenR = new Set(), seenA = new Set(), seenS = new Set();

for (const w of ways) {
  const t = w.tags || {};
  if (!w.geometry || w.geometry.length < 2) continue;

  if (t.building) {
    const p = poly(w.geometry);
    if (!p) continue;
    const k = keyOf(p);
    if (seenB.has(k)) continue;
    seenB.add(k);
    buildings.push({ name: nameOf(t), poly: p });
  }

  if (t.highway) {
    const l = line(w.geometry);
    if (!l) continue;
    const k = keyOf(l);
    if (seenR.has(k)) continue;
    seenR.add(k);
    roads.push({ class: t.highway, name: nameOf(t), line: l });
  }

  let kind = null;
  if (t.leisure === 'park') kind = 'park';
  else if (t.natural === 'water') kind = 'water';
  else if (t.landuse === 'grass') kind = 'grass';
  else if (t.landuse === 'forest') kind = 'forest';
  else if (t.natural === 'wood') kind = 'forest';
  else if (t.landuse === 'meadow') kind = 'grass';
  if (kind) {
    const p = poly(w.geometry);
    if (p) {
      const k = keyOf(p);
      if (!seenA.has(k)) { seenA.add(k); areas.push({ kind, poly: p }); }
    }
  }

  const isPitch = t.leisure === 'pitch';
  const isTrack = t.leisure === 'track' && t.sport;
  const isSportCentre = t.leisure === 'sports_centre';
  if (isPitch || isTrack || isSportCentre) {
    const p = poly(w.geometry);
    if (p) {
      const k = keyOf(p);
      if (!seenS.has(k)) { seenS.add(k); sports.push({ sport: (t.sport || '').trim(), poly: p }); }
    }
  }
}

const out = { bbox, boundary: [boundaryRing], buildings, roads, areas, sports };

// ---- multipolygon relations ----
// Many named buildings (38/39 教, 平园 21–24 斋, 郑东图书馆 …) and some water
// bodies are OSM relations, not ways. With `out geom` each member carries its
// own geometry array; each outer ring becomes its own polygon (a building with
// two wings yields two same-named polygons, which the renderer de-dupes).
for (const rel of relations) {
  const t = rel.tags || {};
  if (t.type !== 'multipolygon') continue;
  const outers = (rel.members || []).filter(m => m.role === 'outer' && Array.isArray(m.geometry));
  for (const m of outers) {
    const p = poly(m.geometry);
    if (!p) continue;
    const k = keyOf(p);
    if (t.building) {
      if (seenB.has(k)) continue;
      seenB.add(k);
      buildings.push({ name: nameOf(t), poly: p });
      continue;
    }
    let kind = null;
    if (t.natural === 'water') kind = 'water';
    else if (t.leisure === 'park') kind = 'park';
    else if (t.landuse === 'grass') kind = 'grass';
    else if (t.landuse === 'forest' || t.natural === 'wood') kind = 'forest';
    if (kind && !seenA.has(k)) {
      seenA.add(k);
      areas.push({ kind, poly: p });
    }
  }
}

// Legacy hand-patch file (pre-relation support); kept for older extracts.
if (fs.existsSync(EXTRA)) {
  const extras = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
  for (const e of extras) {
    const ring = closeRing(toPts(e.poly.map(([lon, lat]) => ({ lon, lat }))));
    if (!ring || areaM2(ring) < 0.5) continue;
    const k = keyOf(ring);
    if (seenB.has(k)) continue;
    seenB.add(k);
    buildings.push({ name: (e.name || '').trim(), poly: ring });
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));

const st = fs.statSync(OUT);
console.log(JSON.stringify({
  file: OUT,
  bytes: st.size,
  bbox,
  boundaryPoints: boundaryRing.length,
  buildings: buildings.length,
  namedBuildings: buildings.filter(b => b.name).length,
  roads: roads.length,
  areas: areas.length,
  areaKinds: areas.reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {}),
  sports: sports.length,
  sportsByKind: sports.reduce((m, s) => (m[s.sport || '(none)'] = (m[s.sport || '(none)'] || 0) + 1, m), {})
}, null, 2));