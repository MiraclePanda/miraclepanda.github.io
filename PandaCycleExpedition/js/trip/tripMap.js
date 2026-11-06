// 旅の地図のための計算: 走ってきた道の経緯度、今いる場所、地図の範囲と投影。純粋関数のみ。
//
// 区間データの map は約 200 m ごとの [経度, 緯度](最後の点は終点)。区間の地点 m は
// 「map の何番目の点か」= m / 区間の長さ × (点の数 − 1) で読む(点の間隔のずれは地図の縮尺では見えない)。

import { getSegment } from './network.js';
import { SEGMENTS, NODES, TRANSFERS } from '../data/catalog.js';

/** 区間の地点 m の [経度, 緯度]。 */
export function lonLatAt(segment, m) {
  const pts = segment.map ?? [];
  if (pts.length === 0) return null;
  const x = Math.min(1, Math.max(0, m / segment.lengthM)) * (pts.length - 1);
  const i = Math.min(Math.floor(x), pts.length - 2);
  if (i < 0) return pts[0];
  const f = x - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
}

/** 区間の fromM〜toM の部分の線。 */
export function segmentSlice(segment, fromM, toM) {
  const pts = segment.map ?? [];
  if (pts.length < 2 || !(toM > fromM)) return [];
  const n = pts.length - 1;
  const a = Math.max(0, fromM / segment.lengthM) * n;
  const b = Math.min(1, toM / segment.lengthM) * n;
  const out = [lonLatAt(segment, fromM)];
  for (let i = Math.ceil(a); i < b; i++) out.push(pts[i]);
  out.push(lonLatAt(segment, toM));
  return out;
}

/**
 * 旅の累積距離 totalM のときの区間と区間内の地点(legs から引く)。
 * arrived = その距離で着いた所(泊まった場所)。旧版で保存した旅の、コースを走り直した区間(restart)は同じ累積距離から
 * 始まるので、着いた所としては走り直す前の区間の地点を返す。
 */
export function locateTotalM(trip, totalM, { arrived = false } = {}) {
  const legs = trip.legs ?? [{ segmentId: trip.position.segmentId, startTotalM: 0 }];
  let k = 0;
  for (let i = 0; i < legs.length; i++) if (legs[i].startTotalM <= totalM) k = i;
  while (arrived && k > 0 && legs[k].restart && legs[k].startTotalM === totalM) k--;
  const seg = getSegment(legs[k].segmentId);
  if (!seg) return null;
  // 電車・船で着いた区間は終点(着いた町)にいる
  // 旧版で保存した旅の、続きから走り直した区間は startM の地点から入っている
  const m = legs[k].transfer ? seg.lengthM : Math.min(seg.lengthM, Math.max(0, (legs[k].startM ?? 0) + totalM - legs[k].startTotalM));
  return { segment: seg, m, leg: k };
}

/** 旅の累積距離 fromTotalM〜toTotalM に走った道(区間ごとの線の配列)。 */
export function pathBetween(trip, fromTotalM, toTotalM) {
  const legs = trip.legs ?? [{ segmentId: trip.position.segmentId, startTotalM: 0 }];
  const out = [];
  for (let i = 0; i < legs.length; i++) {
    const seg = getSegment(legs[i].segmentId);
    if (!seg || legs[i].transfer) continue;
    const s = legs[i].startTotalM;
    const e = i + 1 < legs.length ? legs[i + 1].startTotalM : trip.position.totalM;
    const a = Math.max(s, fromTotalM);
    const b = Math.min(e, toTotalM);
    const off = legs[i].startM ?? 0;
    if (b > a) {
      const line = segmentSlice(seg, Math.min(seg.lengthM, off + a - s), Math.min(seg.lengthM, off + b - s));
      if (line.length >= 2) out.push(line);
    }
  }
  return out;
}

/** 地図に描くもの一式: すべての区間(まだ走っていない道も)、電車・船、走った道、今いる場所、泊まった場所、町。 */
export function buildTripMap(trip) {
  const roads = Object.values(SEGMENTS).map((s) => s.map ?? []).filter((l) => l.length >= 2);
  const here = locateTotalM(trip, trip.position.totalM);
  const nights = trip.log
    .map((d) => ({ day: d.day, at: locateTotalM(trip, d.endTotalM, { arrived: true }) }))
    .filter((x) => x.at)
    .map((x) => ({ day: x.day, lonLat: lonLatAt(x.at.segment, x.at.m) }));
  const towns = [];
  for (const s of Object.values(SEGMENTS)) {
    for (const [id, m] of [[s.from, 0], [s.to, s.lengthM]]) {
      if (!towns.some((t) => t.id === id)) towns.push({ id, name: NODES[id]?.name ?? id, lonLat: lonLatAt(s, m) });
    }
  }
  const at = (id) => towns.find((t) => t.id === id)?.lonLat;
  const transfers = TRANSFERS.filter((t) => at(t.a) && at(t.b)).map((t) => ({ kind: t.kind, line: [at(t.a), at(t.b)] }));
  return {
    roads,
    transfers,
    traveled: pathBetween(trip, 0, trip.position.totalM),
    here: here ? lonLatAt(here.segment, here.m) : null,
    nights,
    towns,
  };
}

/**
 * 経緯度を画面の px にする投影(縦横比を保って w×h に収める)。緯度で経度方向を縮める。
 * @param {[number,number][]} points 範囲を決める点
 */
export function fitProjection(points, w, h, padPx = 16) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [lon, lat] of points) {
    x0 = Math.min(x0, lon); x1 = Math.max(x1, lon); y0 = Math.min(y0, lat); y1 = Math.max(y1, lat);
  }
  if (!Number.isFinite(x0)) return () => [w / 2, h / 2];
  const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
  const sw = Math.max(1e-6, (x1 - x0) * k);
  const sh = Math.max(1e-6, y1 - y0);
  const s = Math.min((w - 2 * padPx) / sw, (h - 2 * padPx) / sh);
  const ox = (w - sw * s) / 2;
  const oy = (h - sh * s) / 2;
  return ([lon, lat]) => [ox + (lon - x0) * k * s, h - (oy + (lat - y0) * s)];
}
