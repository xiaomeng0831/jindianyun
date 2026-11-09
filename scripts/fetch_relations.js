#!/usr/bin/env node
// Fetch named OSM building relations (library, Pingyuan dorms) that the
// way-only Overpass extract missed, and assemble their outer rings.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'extra_buildings.json');
const IDS = [12461401, 7617624, 7617625, 7617626, 7617627];

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'jinDianYun-basemap/1.0 (local project)' } });
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}

function assembleRings(memberWays) {
  // memberWays: [{nodes:[ids], coords:[[lon,lat],...]}]
  const remaining = memberWays.slice();
  const rings = [];
  while (remaining.length) {
    let cur = remaining.shift();
    let coords = cur.coords.slice();
    let changed = true;
    while (changed && coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
      changed = false;
      for (let i = 0; i < remaining.length; i++) {
        const n = remaining[i];
        const first = coords[0], last = coords[coords.length - 1];
        const nf = n.coords[0], nl = n.coords[n.coords.length - 1];
        const eq = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
        if (eq(last, nf)) { coords = coords.concat(n.coords.slice(1)); remaining.splice(i, 1); changed = true; break; }
        if (eq(last, nl)) { coords = coords.concat(n.coords.slice(0, -1).reverse()); remaining.splice(i, 1); changed = true; break; }
        if (eq(first, nl)) { coords = n.coords.slice(0, -1).concat(coords); remaining.splice(i, 1); changed = true; break; }
        if (eq(first, nf)) { coords = n.coords.slice(1).reverse().concat(coords); remaining.splice(i, 1); changed = true; break; }
      }
    }
    rings.push(coords);
  }
  return rings;
}

(async () => {
  const extras = [];
  for (const id of IDS) {
    const j = await getJSON(`https://api.openstreetmap.org/api/0.6/relation/${id}/full.json`);
    const rel = j.elements.find(e => e.type === 'relation' && e.id === id);
    if (!rel) { console.error('missing relation', id); continue; }
    const nodeMap = new Map();
    for (const e of j.elements) if (e.type === 'node') nodeMap.set(e.id, [e.lon, e.lat]);
    const wayMap = new Map();
    for (const e of j.elements) if (e.type === 'way') wayMap.set(e.id, e.nodes.map(n => nodeMap.get(n)).filter(Boolean));
    const outer = rel.members.filter(m => m.type === 'way' && (m.role === 'outer' || !m.role))
      .map(m => ({ nodes: wayMap.get(m.ref) || [], coords: wayMap.get(m.ref) || [] }))
      .filter(w => w.coords.length >= 2);
    const rings = assembleRings(outer);
    const name = (rel.tags['name:zh'] || rel.tags.name || '').trim();
    for (const ring of rings) {
      if (ring.length < 3) continue;
      extras.push({ name, poly: ring, source: `relation/${id}` });
    }
    console.log(id, name, 'outer ways', outer.length, 'rings', rings.length, 'points', rings.map(r => r.length).join(','), JSON.stringify(rel.tags));
    await new Promise(r => setTimeout(r, 800));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(extras, null, 1));
  console.log('wrote', OUT, extras.length, 'polygons');
})();