// 実在コース(GPX の経路点列)から、courseProfiles.js と同じ形のコースプロファイルを作る。
// 純粋関数のみ(Node の単体テスト対象)。
//
// 手順:
//  1. 経路点間の距離をハバーサイン式で積算し、RESAMPLE_M ごとの等間隔点に引き直す
//  2. 標高を移動平均で平滑化する(GPS 標高の数m単位のノイズがそのまま勾配の暴れになるため)
//  3. GRADE_STEP_M 区間ごとの平均勾配を区間中央の制御点 [km, %] にする
//     (CourseEngine は制御点間を線形補間するので、積分した標高差が元の標高差とほぼ一致する)
//  4. 平面上の進行方位から curve(方位の揺らぎのフーリエ級数、routeLayout.js 参照)を求める。
//     curve は3D表示の見た目専用で、物理・勾配・距離・記録には使われない。
//
// 実在コースはループしない: profile.fixedLength = true とし、走行距離(ゴール距離)は
// コース長以下に制限する(ゴール後の続行・周回もしない。2026-10 ユーザー指示)。

export const RESAMPLE_M = 10;
export const GRADE_STEP_M = 100;
// 標高の平滑化幅(m)。移動平均を2回かける(三角窓相当)。
export const ELEVATION_SMOOTH_M = 60;
// 方位の平滑化幅(m)。GPS の横ぶれによる細かな方位の振れを落とす。
export const HEADING_SMOOTH_M = 40;
// ノイズ・データ欠落による非現実的な勾配の上限(%)。
// トレーナーへ送る値はさらに deviceProfile.js の範囲でクランプされる。
export const MAX_ABS_GRADE_PERCENT = 25;
// 走行できる最短コース長(km)。
export const MIN_COURSE_KM = 0.5;
// curve の項数の目安: 何 m の波長までを再現するか。項数には上限を設ける
// (headingAtM は毎フレーム多数回呼ばれるため)。
export const CURVE_WAVELENGTH_M = 300;
export const CURVE_MAX_TERMS = 60;
// これより小さい振幅(度)の項は捨てる。
export const CURVE_MIN_AMP_DEG = 0.5;

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** 2点間の大円距離(m)。 */
export function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 経路点列からコースプロファイルを作る。
 * @param {{lat: number, lon: number, ele: number|null}[]} trackPoints gpx.js の parseGpx().points
 * @param {{ id?: string, name?: string }} [opts]
 * @returns {{ profile: object, stats: object }}
 *   profile は courseProfiles.js の要素と同じ形(id/name/scenery/description/loopLengthKm/
 *   crossfadeKm/curve/points)。stats は画面表示用の集計値。
 * @throws {Error} コースが短すぎるとき(メッセージは画面表示用)
 */
export function buildRealCourse(trackPoints, opts = {}) {
  const pts = dedupe(trackPoints);
  const cum = cumulativeDistances(pts);
  const totalM = cum[cum.length - 1];
  if (pts.length < 2 || !(totalM >= MIN_COURSE_KM * 1000)) {
    throw new Error(`コースが短すぎます(${MIN_COURSE_KM} km 以上必要です)。`);
  }

  const hasElevation = pts.filter((p) => Number.isFinite(p.ele)).length >= pts.length / 2;
  const samples = resample(pts, cum, totalM, hasElevation);
  const smoothedEle = hasElevation
    ? movingAverage(movingAverage(samples.ele, ELEVATION_SMOOTH_M / RESAMPLE_M), ELEVATION_SMOOTH_M / RESAMPLE_M)
    : samples.ele;

  const points = gradePoints(samples.distM, smoothedEle, totalM);
  const stats = computeStats(totalM, smoothedEle, points, hasElevation);
  const curve = fitCurve(samples, totalM);

  const name = (opts.name || '').trim() || '実在コース';
  const profile = {
    id: opts.id || 'gpx',
    name,
    scenery: suggestScenery(stats),
    description: describe(stats),
    loopLengthKm: totalM / 1000,
    // ループしないのでクロスフェードは不要(あると終点手前の勾配が始点の値へ引っ張られる)
    crossfadeKm: 0,
    fixedLength: true,
    curve,
    points,
  };
  return { profile, stats };
}

/** 獲得標高の密度から既存の景色を割り当てる(実写の景色は無いため)。 */
export function suggestScenery(stats) {
  const climbPerKm = stats.distanceKm > 0 ? stats.ascentM / stats.distanceKm : 0;
  if (climbPerKm >= 15) return 'mountain';
  if (climbPerKm >= 5) return 'lakeside';
  return 'city';
}

function describe(stats) {
  const km = stats.distanceKm.toFixed(1);
  if (!stats.hasElevation) return `GPX から読み込んだ実在コース(${km} km、標高データなし)。`;
  return `GPX から読み込んだ実在コース(${km} km、獲得標高 ${Math.round(stats.ascentM)} m)。`;
}

/** 座標が不正な点と、直前の点とほぼ同じ位置の点(停車中の記録など)を除く。 */
function dedupe(trackPoints) {
  const out = [];
  for (const p of trackPoints || []) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const ele = Number.isFinite(p.ele) ? p.ele : null;
    const prev = out[out.length - 1];
    if (prev && haversineM(prev, p) < 0.5) {
      if (prev.ele === null && ele !== null) prev.ele = ele;
      continue;
    }
    out.push({ lat: p.lat, lon: p.lon, ele });
  }
  return out;
}

function cumulativeDistances(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
  return cum;
}

/**
 * RESAMPLE_M 間隔(最後の区間だけ 0.5〜1.5 倍の端数)の点に引き直す。平面座標は経路の平均緯度での正距円筒近似
 * (x: 東, y: 北, m)。標高の欠けた点は前後の標高から距離で線形補間する。
 */
function resample(pts, cum, totalM, hasElevation) {
  const ele = hasElevation ? fillElevations(pts, cum) : pts.map(() => 0);
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const kx = EARTH_RADIUS_M * DEG * Math.cos(lat0 * DEG);
  const ky = EARTH_RADIUS_M * DEG;
  const lon0 = pts[0].lon;
  const out = { distM: [], x: [], y: [], ele: [] };
  let j = 0;
  // 最後の端数区間が極端に短いと方位・勾配がノイズになるため、
  // RESAMPLE_M / 2 未満の端数は直前の区間に吸収する(最後の点は常に totalM)。
  const n = Math.max(1, Math.round(totalM / RESAMPLE_M));
  for (let i = 0; i <= n; i++) {
    const d = i === n ? totalM : i * RESAMPLE_M;
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / seg)) : 0;
    const a = pts[j];
    const b = pts[j + 1];
    out.distM.push(d);
    out.x.push((a.lon + (b.lon - a.lon) * t - lon0) * kx);
    out.y.push((a.lat + (b.lat - a.lat) * t - lat0) * ky);
    out.ele.push(ele[j] + (ele[j + 1] - ele[j]) * t);
  }
  return out;
}

function fillElevations(pts, cum) {
  const known = [];
  pts.forEach((p, i) => {
    if (p.ele !== null) known.push(i);
  });
  return pts.map((p, i) => {
    if (p.ele !== null) return p.ele;
    // 前後の既知点(片側しか無ければその値)
    let k = 0;
    while (k < known.length && known[k] < i) k++;
    const after = known[k];
    const before = known[k - 1];
    if (before === undefined) return pts[after].ele;
    if (after === undefined) return pts[before].ele;
    const t = (cum[i] - cum[before]) / (cum[after] - cum[before] || 1);
    return pts[before].ele + (pts[after].ele - pts[before].ele) * t;
  });
}

/**
 * 中心移動平均(幅 widthSamples 点)。端では窓を左右対称のまま縮める
 * (片側だけ縮めると、一定勾配の登りでも始点・終点付近の勾配が鈍ってしまうため)。
 */
function movingAverage(values, widthSamples) {
  const half = Math.max(0, Math.floor(widthSamples / 2));
  if (half === 0) return values.slice();
  const prefix = [0];
  for (const v of values) prefix.push(prefix[prefix.length - 1] + v);
  return values.map((_, i) => {
    const w = Math.min(half, i, values.length - 1 - i);
    const a = i - w;
    const b = i + w;
    return (prefix[b + 1] - prefix[a]) / (b - a + 1);
  });
}

function eleAt(distM, ele, d) {
  const i = Math.max(0, Math.min(distM.length - 2, Math.floor(d / RESAMPLE_M)));
  const seg = distM[i + 1] - distM[i];
  const t = seg > 0 ? (d - distM[i]) / seg : 0;
  return ele[i] + (ele[i + 1] - ele[i]) * Math.min(1, Math.max(0, t));
}

/** GRADE_STEP_M 区間ごとの平均勾配を、区間中央の制御点 [km, %] にする。両端にも点を置く。 */
function gradePoints(distM, ele, totalM) {
  const mids = [];
  // 最後の端数区間が GRADE_STEP_M / 2 未満なら直前の区間と合わせて1区間にする(短い区間の勾配の暴れ防止)
  const nSeg = Math.max(1, Math.round(totalM / GRADE_STEP_M));
  for (let k = 0; k < nSeg; k++) {
    const a = k * GRADE_STEP_M;
    const b = k === nSeg - 1 ? totalM : a + GRADE_STEP_M;
    const grade = ((eleAt(distM, ele, b) - eleAt(distM, ele, a)) / (b - a)) * 100;
    const clamped = Math.max(-MAX_ABS_GRADE_PERCENT, Math.min(MAX_ABS_GRADE_PERCENT, grade));
    mids.push([(a + b) / 2 / 1000, round2(clamped)]);
  }
  return [[0, mids[0][1]], ...mids, [totalM / 1000, mids[mids.length - 1][1]]];
}

function computeStats(totalM, ele, points, hasElevation) {
  let ascentM = 0;
  let descentM = 0;
  for (let i = 1; i < ele.length; i++) {
    const d = ele[i] - ele[i - 1];
    if (d > 0) ascentM += d;
    else descentM -= d;
  }
  const grades = points.map(([, g]) => g);
  return {
    distanceKm: totalM / 1000,
    hasElevation,
    ascentM,
    descentM,
    minElevationM: hasElevation ? Math.min(...ele) : null,
    maxElevationM: hasElevation ? Math.max(...ele) : null,
    maxGradePercent: Math.max(...grades),
    minGradePercent: Math.min(...grades),
  };
}

/**
 * 進行方位(rad、東=0・反時計回り=正 = 左へ曲がる向き)から curve を求める。
 * 1周で方位が元に戻るフーリエ級数しか表せないため、始点→終点の正味の方位変化は
 * 直線トレンドとして取り除き、残りの揺らぎだけを近似する(見た目は局所的な曲がり方が
 * 合っていれば十分で、正味の旋回は数百 m の表示範囲ではごく緩い一定曲率にすぎない)。
 */
function fitCurve(samples, totalM) {
  const n = samples.x.length - 1;
  if (n < 2) return [];
  const raw = [];
  for (let i = 0; i < n; i++) {
    const dx = samples.x[i + 1] - samples.x[i];
    const dy = samples.y[i + 1] - samples.y[i];
    raw.push(Math.atan2(dy, dx));
  }
  // 連続になるよう 2π の飛びを外す
  for (let i = 1; i < raw.length; i++) {
    while (raw[i] - raw[i - 1] > Math.PI) raw[i] -= 2 * Math.PI;
    while (raw[i] - raw[i - 1] < -Math.PI) raw[i] += 2 * Math.PI;
  }
  const h = movingAverage(raw, HEADING_SMOOTH_M / RESAMPLE_M);
  // 区間中央の距離と、方位(始点基準・トレンド除去)
  const s = [];
  const v = [];
  const net = h[h.length - 1] - h[0];
  for (let i = 0; i < n; i++) {
    const m = (samples.distM[i] + samples.distM[i + 1]) / 2;
    s.push(m);
    v.push(h[i] - h[0] - (net * m) / totalM);
  }
  const terms = Math.max(3, Math.min(CURVE_MAX_TERMS, Math.round(totalM / CURVE_WAVELENGTH_M)));
  const curve = [];
  for (let k = 1; k <= terms; k++) {
    const w = (2 * Math.PI * k) / totalM;
    let a = 0;
    let b = 0;
    for (let i = 0; i < n; i++) {
      const ds = samples.distM[i + 1] - samples.distM[i];
      a += v[i] * Math.sin(w * s[i]) * ds;
      b += v[i] * Math.cos(w * s[i]) * ds;
    }
    a *= 2 / totalM;
    b *= 2 / totalM;
    // a·sin + b·cos = A·sin(ωm + φ)
    const ampDeg = Math.hypot(a, b) / DEG;
    if (ampDeg < CURVE_MIN_AMP_DEG) continue;
    curve.push([round2(ampDeg), k, Math.round(Math.atan2(b, a) * 1000) / 1000]);
  }
  return curve;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
