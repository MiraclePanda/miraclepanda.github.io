// コーナーでの減速(GPX の実在コース)。
// 実在コースの道路の向きの表(realCourse.js が作る profile.curve = { type: 'table', stepM, headings })
// から、各地点を安全に曲がれる上限速度を求め、物理演算(PhysicsEngine・仮想ライダー)で
// その速度を超えないようにブレーキをかける。
//
//  1. 曲がり具合: 地点の前後 W/2 ずつの方位差 Δθ を窓 W(CORNER_WINDOWS_M)ごとに見て、
//     |Δθ| ≥ CORNER_MIN_TURN_RAD の窓だけを「コーナー」とみなし、曲率 κ = |Δθ| / W の最大を取る
//     (GPS の横ぶれによる小さな振れでは減速しないよう、ある程度まとまった向きの変化だけを数える)。
//     ただし方位の表は平滑化されているため、交差点の直角コーナーのような急な曲がりは
//     30〜40 m に広がって半径 20〜25 m の緩い弧に見えてしまう(実走の GPX では交差点を
//     10 km/h 前後で曲がっているのに 27 km/h 前後まで許していた。2026-10)。そこで
//     CORNER_KINK_WINDOW_M の窓で曲がった角度 Δθ から、幅 CORNER_LANE_WIDTH_M の車線内で
//     取れる最大の半径 R = w / (1 − cos(Δθ/2)) も求め、κ = 1/R が大きければそちらを使う
//     (Δθ は 90° で頭打ち。ヘアピンは平滑化後も実際の曲率がそのまま測れるため)。
//  2. コーナー速度: 横方向の加速度を CORNER_LATERAL_ACCEL_MPS2 に抑える v = √(a / κ)。
//  3. 手前からの減速: 終点側から後ろ向きに v_lim[i] = min(v_c[i], √(v_lim[i+1]² + 2·b·Δs)) と
//     たどり、減速度 b(CORNER_BRAKE_DECEL_MPS2)で間に合うように上限を前へ広げる。
// 組み込みコース(フーリエ級数の curve)と旧形式の GPX コースには減速を入れない(上限なし)。

import { PhysicsConstants } from './physicsConstants.js';

export const CORNER_WINDOWS_M = [20, 40, 80];
export const CORNER_MIN_TURN_RAD = (30 * Math.PI) / 180;
// 急な曲がりを角度から見積もる窓(m)。realCourse.js の方位の平滑化で広がる幅に合わせる。
export const CORNER_KINK_WINDOW_M = 40;
// 角度から半径を見積もるときに使う車線の幅(m)。
export const CORNER_LANE_WIDTH_M = 3;
const KINK_MAX_TURN_RAD = Math.PI / 2;

/** 曲がった角度 turn(rad)を幅 CORNER_LANE_WIDTH_M の車線内で曲がるときの最小の曲率(1/m)。 */
export function kinkCurvature(turn) {
  const t = Math.min(Math.abs(turn), KINK_MAX_TURN_RAD);
  return (1 - Math.cos(t / 2)) / CORNER_LANE_WIDTH_M;
}

function isHeadingTable(curve) {
  return !!curve && !Array.isArray(curve) && curve.type === 'table' && Array.isArray(curve.headings) &&
    curve.headings.length >= 2 && curve.stepM > 0;
}

/**
 * 方位の表から、表の各地点の上限速度(m/s。コーナーの影響が無い地点は Infinity)を求める。
 * @returns {{ stepM: number, limits: Float64Array } | null} 方位の表でなければ null
 */
export function buildCornerSpeedLimits(curve, {
  lateralAccel = PhysicsConstants.CORNER_LATERAL_ACCEL_MPS2,
  brakeDecel = PhysicsConstants.CORNER_BRAKE_DECEL_MPS2,
} = {}) {
  if (!isHeadingTable(curve)) return null;
  const step = curve.stepM;
  const h = curve.headings;
  const n = h.length;
  const limits = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let kappa = 0;
    for (const w of CORNER_WINDOWS_M) {
      const half = Math.max(1, Math.round(w / 2 / step));
      const a = Math.max(0, i - half);
      const b = Math.min(n - 1, i + half);
      if (b <= a) continue;
      const turn = Math.abs(h[b] - h[a]);
      if (turn >= CORNER_MIN_TURN_RAD) kappa = Math.max(kappa, turn / ((b - a) * step));
    }
    {
      const half = Math.max(1, Math.round(CORNER_KINK_WINDOW_M / 2 / step));
      const turn = Math.abs(h[Math.min(n - 1, i + half)] - h[Math.max(0, i - half)]);
      if (turn >= CORNER_MIN_TURN_RAD) kappa = Math.max(kappa, kinkCurvature(turn));
    }
    limits[i] = kappa > 0 ? Math.sqrt(lateralAccel / kappa) : Infinity;
  }
  for (let i = n - 2; i >= 0; i--) {
    const fromNext = Math.sqrt(limits[i + 1] ** 2 + 2 * brakeDecel * step);
    if (fromNext < limits[i]) limits[i] = fromNext;
  }
  // 速度の上限(MAX_SPEED_MPS)以上は実質的に制限なし。コーナーから遠い直線は Infinity に戻す。
  for (let i = 0; i < n; i++) if (limits[i] >= PhysicsConstants.MAX_SPEED_MPS) limits[i] = Infinity;
  return { stepM: step, limits };
}

/** 距離 m(m)での上限速度(m/s)。表の外・コーナーの無い地点は Infinity。 */
export function cornerSpeedLimitAt(table, m) {
  if (!table || !(m >= 0)) return Infinity;
  const { stepM, limits } = table;
  const x = m / stepM;
  if (x > limits.length - 1) return Infinity;
  const i = Math.floor(x);
  const a = limits[i];
  const b = limits[Math.min(limits.length - 1, i + 1)];
  // v² で線形補間する(階段状だと区間の境目で上限が急に下がり、減速が追いつかない)。
  // 一定減速度のブレーキでは v² が距離に比例して変わるので、速度そのものを線形補間するより
  // 後ろ向きパスの減速度を超えにくい。片側が Infinity(制限なしとの境目)なら有限の側の値。
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Math.min(a, b);
  return Math.sqrt(a * a + (b * b - a * a) * (x - i));
}

/**
 * 1ステップ分の速度に上限をかける。上限を超えるときは減速度 brakeDecel 以内で上限まで下げる
 * (いきなり上限へ落とさない)。戻り値 braking は表示用(コーナーのため減速中)。
 */
export function applyCornerLimit(prevSpeedMps, newSpeedMps, limitMps, dt, brakeDecel = PhysicsConstants.CORNER_BRAKE_DECEL_MPS2) {
  if (!(newSpeedMps > limitMps)) return { speedMps: newSpeedMps, braking: false };
  const braked = Math.max(limitMps, Math.min(newSpeedMps, prevSpeedMps - brakeDecel * dt));
  return { speedMps: Math.max(0, braked), braking: true };
}
