// 区間データ(js/data/segments/<id>.json。network.js の loadSegment で読む)を PhysicsEngine の route にする。純粋関数のみ。
//
// 区間データの形:
//   { id, name, lengthM, stepM, grades: [%...](stepM ごとの勾配。i 番目は i·stepM〜(i+1)·stepM),
//     surfaces: [{ fromM, surface }](fromM の昇順。最初は 0), tunnels: [{ fromM, toM, name }],
//     places: [{ atM, id, name, kind, ... }](kind: town / food / shop / lodging / sight / encounter) }
// PhysicsEngine の距離はその日のライドの開始からなので、route は開始地点 startM だけずらして読む。

import { DEFAULT_SURFACE } from './surfaces.js';

/** 区間の地点 m の勾配(%)。隣り合う区間の値を線形補間する(段差で負荷が跳ねないように)。終点より先は 0。 */
export function gradeAtM(segment, m) {
  const { grades, stepM } = segment;
  if (!(m >= 0) || m >= segment.lengthM || grades.length === 0) return 0;
  const x = m / stepM - 0.5;
  const i = Math.floor(x);
  const a = grades[clampIndex(i, grades.length)];
  const b = grades[clampIndex(i + 1, grades.length)];
  return a + (b - a) * (x - i);
}

/** 区間の地点 m の路面。 */
export function surfaceAtM(segment, m) {
  let s = DEFAULT_SURFACE;
  for (const r of segment.surfaces ?? []) {
    if (r.fromM <= m) s = r.surface;
    else break;
  }
  return s;
}

/** 地点 m がトンネルの中なら、そのトンネル。 */
export function tunnelAtM(segment, m) {
  return (segment.tunnels ?? []).find((t) => m >= t.fromM && m < t.toM) ?? null;
}

/** 区間の始点から m までの標高差(m)。勾配を積分する(表示用)。 */
export function elevationAtM(segment, m, stepM = 10) {
  let e = 0;
  const end = Math.min(Math.max(0, m), segment.lengthM);
  for (let x = 0; x < end; x += stepM) {
    const d = Math.min(stepM, end - x);
    e += d * Math.sin(Math.atan(gradeAtM(segment, x + d / 2) / 100));
  }
  return e;
}

/** fromM より先(fromM を含む)で、kind に当てはまる最初の地点。 */
export function nextPlace(segment, fromM, kinds = null) {
  return (segment.places ?? []).find((p) => p.atM >= fromM && (!kinds || kinds.includes(p.kind))) ?? null;
}

/** m にいちばん近い地点(kinds で絞れる)。 */
export function nearestPlace(segment, m, kinds = null) {
  let best = null;
  for (const p of segment.places ?? []) {
    if (kinds && !kinds.includes(p.kind)) continue;
    if (!best || Math.abs(p.atM - m) < Math.abs(best.atM - m)) best = p;
  }
  return best;
}

/**
 * その日のライドの route(PhysicsEngine に渡す)。
 * @param {object} segment
 * @param {number} startM その日の出発地点(区間の始点からの m)
 */
export function createSegmentRoute(segment, startM = 0) {
  const at = (km) => startM + km * 1000;
  return {
    segment,
    startM,
    gradeAtKm: (km) => gradeAtM(segment, at(km)),
    surfaceAtKm: (km) => surfaceAtM(segment, at(km)),
    /** その日の走行距離 distanceM のときの区間上の地点。 */
    segmentM: (distanceM) => Math.min(segment.lengthM, startM + distanceM),
    remainingM: (distanceM) => Math.max(0, segment.lengthM - startM - distanceM),
    finished: (distanceM) => startM + distanceM >= segment.lengthM,
  };
}

function clampIndex(i, n) {
  return Math.min(n - 1, Math.max(0, i));
}
