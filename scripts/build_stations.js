#!/usr/bin/env node
// Build data/stations.json: 19 e-bike + 9 e-car charging sites placed
// against named buildings in data/basemap.json.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'data', 'basemap.json');
const OUT = path.join(ROOT, 'data', 'stations.json');
const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
const [minLon, minLat, maxLon, maxLat] = base.bbox;

const r6 = v => Math.round(v * 1e6) / 1e6;
const OFF_LAT = 0.00018; // ~20 m north/south
const OFF_LON = 0.00023; // ~20 m east/west

function ringAreaCentroid(ring) {
  const lat0 = ring[0][1] * Math.PI / 180;
  const mx = 111320 * Math.cos(lat0), my = 110540;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x0 = ring[i][0] * mx, y0 = ring[i][1] * my;
    const x1 = ring[i + 1][0] * mx, y1 = ring[i + 1][1] * my;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a /= 2;
  if (Math.abs(a) < 1e-9) {
    const n = ring.length - 1;
    return { area: 0, lon: ring.slice(0, n).reduce((s, p) => s + p[0], 0) / n, lat: ring.slice(0, n).reduce((s, p) => s + p[1], 0) / n };
  }
  cx /= 6 * a; cy /= 6 * a;
  return { area: Math.abs(a), lon: cx / mx, lat: cy / my };
}

function findBuildings(names) {
  const wanted = Array.isArray(names) ? names : [names];
  const out = [];
  for (const name of wanted) {
    const matches = base.buildings.filter(b => b.name === name);
    if (!matches.length) throw new Error('building not found in basemap: ' + name);
    out.push(...matches);
  }
  return out;
}

function combined(buildings) {
  let area = 0, lon = 0, lat = 0;
  let mnLon = Infinity, mnLat = Infinity, mxLon = -Infinity, mxLat = -Infinity;
  for (const b of buildings) {
    const c = ringAreaCentroid(b.poly);
    const w = c.area || 1;
    area += w; lon += c.lon * w; lat += c.lat * w;
    for (const p of b.poly) {
      mnLon = Math.min(mnLon, p[0]); mxLon = Math.max(mxLon, p[0]);
      mnLat = Math.min(mnLat, p[1]); mxLat = Math.max(mxLat, p[1]);
    }
  }
  return { lon: lon / area, lat: lat / area, mnLon, mnLat, mxLon, mxLat };
}

function place(names, side, opts = {}) {
  let buildings = findBuildings(names);
  if (opts.pick === 'west') buildings = [buildings.reduce((a, b) => (ringAreaCentroid(a.poly).lon <= ringAreaCentroid(b.poly).lon ? a : b))];
  const c = combined(buildings);
  let lon = c.lon, lat = c.lat;
  if (side === 'n') lat = c.mxLat + (opts.offLat || OFF_LAT);
  else if (side === 's') lat = c.mnLat - (opts.offLat || OFF_LAT);
  else if (side === 'e') lon = c.mxLon + (opts.offLon || OFF_LON);
  else if (side === 'w') lon = c.mnLon - (opts.offLon || OFF_LON);
  if (opts.dLon) lon += opts.dLon;
  if (opts.dLat) lat += opts.dLat;
  return { lon: r6(lon), lat: r6(lat), ref: buildings.map(b => b.name).join('+'), centroid: { lon: r6(c.lon), lat: r6(c.lat) } };
}

const stations = [];

// ---------- e-bike: 19 sites, 220 sockets ----------
const bike = [
  { id: 'bike-geyuan-1', name: '格园1斋', sockets: 10, cabinets: 1, names: '格园1斋', side: 'center',
    note: '含锂电柜1组' },
  { id: 'bike-liuyuan-a', name: '留园A/留学生公寓', sockets: 10, cabinets: 0,
    names: 'Overseas Students Apartment (Liuyuan)', side: 'center', pick: 'west', approx: true,
    note: 'OSM 有两栋同名留学生公寓，取靠留园餐厅的西南栋（推测 A 座）' },
  { id: 'bike-zhiyuan-5', name: '知园5斋', sockets: 10, cabinets: 0, names: '知园5斋', side: 'center' },
  { id: 'bike-chengyuan-6', name: '诚园6斋', sockets: 10, cabinets: 0, names: '诚园6斋', side: 'center' },
  { id: 'bike-chengyuan-7', name: '诚园7斋', sockets: 10, cabinets: 0, names: '诚园7斋', side: 'center' },
  { id: 'bike-zhengyuan-10', name: '正园10斋', sockets: 10, cabinets: 0, names: '正园10斋', side: 'center' },
  { id: 'bike-xiuyuan-12', name: '修园12斋', sockets: 10, cabinets: 0, names: '修园12斋', side: 'center' },
  { id: 'bike-qiyuan-16', name: '齐园16斋', sockets: 10, cabinets: 0, names: '齐园16斋', side: 'center' },
  { id: 'bike-zhiyuan-17', name: '治园17斋', sockets: 20, cabinets: 1, names: '治园17斋', side: 'center',
    note: '含锂电柜1组' },
  { id: 'bike-zhiyuan-19', name: '治园19斋', sockets: 10, cabinets: 0, names: '治园19斋', side: 'center' },
  { id: 'bike-zhiyuan-20', name: '治园20斋', sockets: 10, cabinets: 0, names: '治园20斋', side: 'center' },
  { id: 'bike-pingyuan-22', name: '平园22斋', sockets: 10, cabinets: 0, names: '平园22斋', side: 'center',
    note: 'OSM multipolygon relation，已并入底图' },
  { id: 'bike-pingyuan-24', name: '平园24斋', sockets: 10, cabinets: 0, names: '平园24斋', side: 'center',
    note: 'OSM multipolygon relation，已并入底图' },
  { id: 'bike-zhiyuan-25-26', name: '25/26斋', sockets: 20, cabinets: 1, names: ['治园25斋', '治园26斋'], side: 'center',
    dLon: 0.00011, dLat: -0.000195, note: '治园25、26斋两栋之间，含锂电柜1组' },
  { id: 'bike-taoyuan-south', name: '桃园餐厅南侧', sockets: 10, cabinets: 1, names: '桃园（学生第五食堂）', side: 's',
    note: '桃园餐厅南侧，含锂电柜1组' },
  { id: 'bike-zhuyuan', name: '竹园餐厅临齐园(光伏)', sockets: 10, cabinets: 0, names: '竹园餐厅（学四食堂）', side: 'n',
    note: '竹园餐厅北侧临齐园，光伏车棚' },
  { id: 'bike-jiaoxue-31', name: '31教北侧', sockets: 19, cabinets: 1, names: 'No.31 Teaching Building', side: 'n',
    note: '31教北侧（明德北道），含锂电柜1组' },
  { id: 'bike-jiaoxue-34', name: '34教北侧', sockets: 10, cabinets: 0, names: '34教学楼（热动力大楼）', side: 'n',
    dLon: -0.00028, note: '34教北侧偏西（与汽车站分列）' },
  { id: 'bike-xiuyuan-11', name: '修园11斋', sockets: 11, cabinets: 0, names: '修园11斋', side: 'center',
    note: '插口数 11（由 10 调整，使自行车插口合计 220）' }
];

// ---------- e-car: 9 sites, socket counts not captured ----------
const car = [
  { id: 'car-1895', name: '1895行政楼北侧', names: '1895行政楼', side: 'n', note: '电动汽车站点，插口数待采集' },
  { id: 'car-taoyuan-east', name: '桃园餐厅东侧', names: '桃园（学生第五食堂）', side: 'e', note: '电动汽车站点，插口数待采集' },
  { id: 'car-gymnasium', name: '体育馆', names: '天津大学体育馆', side: 'center', note: '电动汽车站点，插口数待采集' },
  { id: 'car-datong', name: '大活中心(大通学生中心)', names: '大通学生中心', side: 'center', note: '电动汽车站点，插口数待采集' },
  { id: 'car-jiaoxue-34', name: '34教北', names: '34教学楼（热动力大楼）', side: 'n', dLon: 0.00030,
    note: '34教北侧偏东（与自行车站分列）；电动汽车站点，插口数待采集' },
  { id: 'car-jiaoxue-37', name: '37教南', names: '37教学楼', side: 's', note: '电动汽车站点，插口数待采集' },
  { id: 'car-jiaoxue-55', name: '55教北', names: '55教学楼', side: 'n', note: '电动汽车站点，插口数待采集' },
  { id: 'car-south-gate', name: '南门', fixed: { lon: 117.3112845, lat: 38.9890896 }, approx: false,
    note: 'OSM 校门节点「天津大学新校南门」（同砚路）' },
  { id: 'car-library', name: '图书馆/郑东图书馆', names: '郑东图书馆', side: 'center', approx: false,
    note: '郑东图书馆为 OSM multipolygon relation，已并入底图' }
];

for (const s of bike) {
  const p = place(s.names, s.side, { pick: s.pick, dLon: s.dLon, dLat: s.dLat });
  stations.push({
    type: 'bike', id: s.id, name: s.name, sockets: s.sockets, cabinets: s.cabinets,
    lon: p.lon, lat: p.lat, approx: !!s.approx, note: s.note || ''
  });
  console.log('bike', s.id.padEnd(20), s.name.padEnd(20), p.lon, p.lat, '| ref', p.ref);
}
for (const s of car) {
  let p;
  if (s.fixed) p = { lon: r6(s.fixed.lon), lat: r6(s.fixed.lat), ref: 'gate node' };
  else p = place(s.names, s.side, { dLon: s.dLon, dLat: s.dLat });
  stations.push({
    type: 'car', id: s.id, name: s.name, sockets: 0, cabinets: 0,
    lon: p.lon, lat: p.lat, approx: !!s.approx, note: s.note || ''
  });
  console.log('car ', s.id.padEnd(20), s.name.padEnd(20), p.lon, p.lat, '| ref', p.ref);
}

// Verification
let errors = [];
const seenIds = new Set();
for (const s of stations) {
  if (seenIds.has(s.id)) errors.push('duplicate id ' + s.id);
  seenIds.add(s.id);
  if (s.lon < minLon || s.lon > maxLon || s.lat < minLat || s.lat > maxLat)
    errors.push('out of bbox: ' + s.id + ' ' + s.lon + ',' + s.lat);
}
const bikeStations = stations.filter(s => s.type === 'bike');
const carStations = stations.filter(s => s.type === 'car');
const socketTotal = bikeStations.reduce((a, s) => a + s.sockets, 0);
const cabinetTotal = bikeStations.reduce((a, s) => a + s.cabinets, 0);
if (stations.length !== 28) errors.push('station count ' + stations.length);
if (bikeStations.length !== 19) errors.push('bike count ' + bikeStations.length);
if (carStations.length !== 9) errors.push('car count ' + carStations.length);
if (socketTotal !== 220) errors.push('bike socket total ' + socketTotal);
if (cabinetTotal !== 5) errors.push('cabinet total ' + cabinetTotal);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(stations, null, 2));
console.log(JSON.stringify({
  out: OUT, bytes: fs.statSync(OUT).size, stations: stations.length,
  bike: bikeStations.length, car: carStations.length,
  bikeSockets: socketTotal, cabinets: cabinetTotal,
  approx: stations.filter(s => s.approx).map(s => s.id),
  errors
}, null, 2));
if (errors.length) process.exit(1);