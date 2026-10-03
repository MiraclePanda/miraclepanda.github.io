// ゴースト対戦用の「トラック」(走行時間 → 距離 の対応表)を作る純粋関数群。
// PR2+3 仕様 §5.1 / §5.2 に対応。DOM・IndexedDB・localStorage に依存しない(Node でテスト可能)。
//
// トラックの形式:
//   { name, courseId, points: Float64Array [t0, d0, t1, d1, …] }
//   t は走行時間(秒、一時停止を含まない)、d は通算距離(m)。t・d とも非減少にそろえる。
//
// 記録(record.samples)の時間について:
//   - 新しい記録は各サンプルに rideTimeS(一時停止を除いた走行時間)を持つ → それをそのまま使う
//   - 古い記録は tOffsetS(一時停止も含む経過時間)しかない → 一時停止に当たる区間を詰めて使う
//       (a) 速度0のまま距離が進まない区間 → 時間を進めない
//       (b) サンプル間隔が大きく空いた区間(一時停止中はサンプルを取らないため) →
//           前後の速度から「その距離を走るのに要した時間」を推定し、経過時間より短ければそれを使う

export const PB_GHOST_NAME = '自己ベスト';
export const DEFAULT_FRIEND_GHOST_NAME = '友人のゴースト';

// サンプル間隔(RideScreen の SAMPLE_INTERVAL_MS = 1000)の何倍以上空いたら「途切れ」とみなすか
const GAP_FACTOR = 2.5;
const NOMINAL_INTERVAL_S = 1;
// 「進んでいない」「止まっている」とみなす閾値
const STILL_DISTANCE_M = 0.01;
const STILL_SPEED_KMH = 0.5;

// ---------------------------------------------------------------------------
// 記録 → トラック
// ---------------------------------------------------------------------------

export function fromRecord(record) {
  const samples = Array.isArray(record?.samples) ? record.samples : [];
  const courseId = record?.courseId ?? null;
  const hasRideTime = samples.length > 0 && samples.every((s) => isNum(s?.rideTimeS));

  const raw = [];
  for (const s of samples) {
    const t = hasRideTime ? s.rideTimeS : s?.tOffsetS;
    if (!isNum(t) || !isNum(s?.distanceM)) continue;
    raw.push({ t, d: s.distanceM, v: isNum(s.speedKmh) ? s.speedKmh / 3.6 : null });
  }

  const points = hasRideTime ? normalizeDirect(raw) : compressPauses(raw);
  appendFinalPoint(points, raw, record);
  return { name: PB_GHOST_NAME, courseId, points: toFloat64(points) };
}

// サンプリングは1秒ごとで、ゴール到達で止まるため、末尾サンプルの距離はゴール手前になる。
// 記録の最終値 record.totalDistanceM が末尾より大きければ、それを末尾の点として補う。
// 時刻は末尾サンプルの速度から外挿する(残り距離 / 速度)。ゴールのダイアログ表示中も
// record.ridingTimeS は進むため、速度が分かる場合はそちらを優先する。速度が0・欠損のときは
// record.ridingTimeS を使う(末尾の時刻より後の場合のみ。それ以外は補わない)。
function appendFinalPoint(points, raw, record) {
  const total = record?.totalDistanceM;
  const n = points.length >> 1;
  if (n === 0 || !isNum(total)) return;
  const lastT = points[(n - 1) * 2];
  const lastD = points[(n - 1) * 2 + 1];
  if (!(total > lastD)) return;
  const v = raw.length > 0 ? raw[raw.length - 1].v : null;
  let t = null;
  if (v !== null && v * 3.6 >= STILL_SPEED_KMH) t = lastT + (total - lastD) / v;
  else if (isNum(record?.ridingTimeS) && record.ridingTimeS > lastT) t = record.ridingTimeS;
  if (t === null) return;
  points.push(t, total);
}

// ---------------------------------------------------------------------------
// TCX → トラック(友人のゴースト)
// ---------------------------------------------------------------------------

// <Trackpoint> の <Time> と <DistanceMeters> を読む。DOMParser に依存しない正規表現の簡易版
// (名前空間接頭辞付きのタグ <ns:Trackpoint> も許容)。Time か DistanceMeters が欠けた点は捨てる。
// t は最初の Time からの秒。TCX のサンプル時刻は一時停止を含む経過時間なので、記録と同じく
// 大きく空いた区間は前後の速度から推定した時間に詰める(本アプリの buildTcx もこの形で書き出す)。
export function fromTcx(xmlText, { name } = {}) {
  const text = typeof xmlText === 'string' ? xmlText : '';
  const tpRe = /<(?:[\w.-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Trackpoint>/g;
  const raw = [];
  let t0 = null;
  let m;
  while ((m = tpRe.exec(text)) !== null) {
    const body = m[1];
    const timeStr = tagText(body, 'Time');
    const distStr = tagText(body, 'DistanceMeters');
    if (timeStr === null || distStr === null) continue;
    const ms = Date.parse(timeStr);
    const d = Number(distStr);
    if (!Number.isFinite(ms) || !Number.isFinite(d)) continue;
    if (t0 === null) t0 = ms;
    raw.push({ t: (ms - t0) / 1000, d, v: null });
  }
  const label = typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_FRIEND_GHOST_NAME;
  return { name: label, courseId: null, points: toFloat64(compressPauses(raw)) };
}

function tagText(body, tag) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([^<]*)<\\/(?:[\\w.-]+:)?${tag}>`);
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// トラックの参照
// ---------------------------------------------------------------------------

// 走行時間 tSec におけるゴーストの距離(m)。点の間は線形補間。
// 範囲外: t < 0 → 0、最後の点より後 → 最後の距離で止まる。点がなければ 0。
export function distanceAt(track, tSec) {
  const p = track?.points;
  const n = p ? p.length >> 1 : 0;
  if (n === 0 || !isNum(tSec) || tSec < 0) return 0;
  const tFirst = p[0];
  if (tSec <= tFirst) return tFirst > 0 ? p[1] * (tSec / tFirst) : p[1];
  const tLast = p[(n - 1) * 2];
  if (tSec >= tLast) return p[(n - 1) * 2 + 1];
  // t[i] <= tSec < t[i+1] となる i を二分探索で求める
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid * 2] <= tSec) lo = mid;
    else hi = mid;
  }
  const ta = p[lo * 2];
  const da = p[lo * 2 + 1];
  const tb = p[hi * 2];
  const db = p[hi * 2 + 1];
  if (tb <= ta) return db;
  return da + (db - da) * ((tSec - ta) / (tb - ta));
}

// トラックの最後の走行時間(秒)。点がなければ 0。ゴーストの「記録終了」判定に使う。
export function trackEndS(track) {
  const p = track?.points;
  const n = p ? p.length >> 1 : 0;
  return n === 0 ? 0 : p[(n - 1) * 2];
}

// 距離 distanceM に初めて到達した走行時間(秒)。補間で求める。届いていなければ null。
export function timeAtDistance(track, distanceM) {
  const p = track?.points;
  const n = p ? p.length >> 1 : 0;
  if (n === 0 || !isNum(distanceM)) return null;
  if (distanceM <= p[1]) {
    // 先頭の点より手前は (0, 0) から先頭の点へ補間する(distanceAt と対称)
    const t0 = p[0];
    return p[1] > 0 && t0 > 0 ? t0 * Math.max(0, distanceM) / p[1] : t0;
  }
  if (distanceM > p[(n - 1) * 2 + 1]) return null;
  for (let i = 1; i < n; i++) {
    const db = p[i * 2 + 1];
    if (db >= distanceM) {
      const ta = p[(i - 1) * 2];
      const da = p[(i - 1) * 2 + 1];
      const tb = p[i * 2];
      if (db <= da) return tb;
      return ta + (tb - ta) * ((distanceM - da) / (db - da));
    }
  }
  return null;
}

// 同じコースで goal 以上を走った記録のうち、goal 地点への到達走行時間が最短の記録を返す。
// 該当なしは null。到達時刻は fromRecord のトラックを補間して求める。
export function bestRecordFor(rides, courseId, goalDistanceKm) {
  if (!Array.isArray(rides) || courseId === null || courseId === undefined) return null;
  if (!isNum(goalDistanceKm) || goalDistanceKm <= 0) return null;
  const goalM = goalDistanceKm * 1000;
  let best = null;
  let bestT = Infinity;
  for (const ride of rides) {
    if (!ride || ride.courseId !== courseId) continue;
    if (!isNum(ride.totalDistanceM) || ride.totalDistanceM < goalM) continue;
    const t = timeAtDistance(fromRecord(ride), goalM);
    if (t === null || !Number.isFinite(t)) continue;
    if (t < bestT) {
      bestT = t;
      best = ride;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 内部処理
// ---------------------------------------------------------------------------

// rideTimeS をそのまま使う場合: t・d を非減少にそろえるだけ
function normalizeDirect(raw) {
  const out = [];
  let lastT = -Infinity;
  let lastD = 0;
  for (const s of raw) {
    const t = Math.max(lastT, Math.max(0, s.t));
    const d = Math.max(lastD, s.d);
    out.push(t, d);
    lastT = t;
    lastD = d;
  }
  return withOrigin(out);
}

// 経過時間(一時停止を含む)から走行時間を作る。
// 先頭サンプルの時刻はそのまま使い(記録開始から最初のサンプルまでは走行中)、以降は区間ごとに
// 「詰めた後の所要時間」を足していく。d は単調増加(非減少)にそろえる(一瞬戻るサンプルは前の値)。
function compressPauses(raw) {
  if (raw.length === 0) return [];
  const out = [];
  let t = Math.max(0, raw[0].t);
  let d = raw[0].d;
  out.push(t, d);
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1];
    const cur = raw[i];
    const dt = Math.max(0, cur.t - prev.t);
    const dNew = Math.max(d, cur.d);
    const dd = dNew - d;
    let step = dt;
    const still = dd < STILL_DISTANCE_M;
    const stopped = still && isStopped(prev) && isStopped(cur);
    if (stopped) {
      // (a) 速度0のまま進まない区間 → 一時停止として時間を進めない
      step = 0;
    } else if (dt > GAP_FACTOR * NOMINAL_INTERVAL_S) {
      // (b) サンプルが途切れた区間 → その距離を走るのに要した時間を前後の速度から推定する
      const v = gapSpeed(raw, i);
      if (still) step = Math.min(dt, NOMINAL_INTERVAL_S);
      else if (v > 0) step = Math.min(dt, dd / v);
    }
    t += step;
    d = dNew;
    out.push(t, d);
  }
  return withOrigin(out);
}

// 速度が分からない(TCX)場合は「距離が進んでいない」ことだけで止まっているとみなす
function isStopped(s) {
  return s.v === null ? true : s.v * 3.6 < STILL_SPEED_KMH;
}

// 途切れた区間 [i-1, i] の速度(m/s)の推定。サンプルの速度があれば前後の平均、
// なければ直前・直後の通常間隔の区間から距離/時間で求める。
function gapSpeed(raw, i) {
  const a = raw[i - 1];
  const b = raw[i];
  const vs = [a.v, b.v].filter((v) => v !== null && v > 0);
  if (vs.length > 0) return vs.reduce((x, y) => x + y, 0) / vs.length;
  const est = [];
  const before = raw[i - 2];
  if (before) {
    const dt = a.t - before.t;
    if (dt > 0 && dt <= GAP_FACTOR * NOMINAL_INTERVAL_S && a.d > before.d) est.push((a.d - before.d) / dt);
  }
  const after = raw[i + 1];
  if (after) {
    const dt = after.t - b.t;
    if (dt > 0 && dt <= GAP_FACTOR * NOMINAL_INTERVAL_S && after.d > b.d) est.push((after.d - b.d) / dt);
  }
  return est.length > 0 ? est.reduce((x, y) => x + y, 0) / est.length : 0;
}

// 先頭が t>0 なら (0, 0) を先頭に足す(スタート時点の距離0を明示する)。
// 先頭の距離が負(不正値)なら 0 に寄せる。
function withOrigin(flat) {
  if (flat.length === 0) return flat;
  if (flat[1] < 0) {
    for (let i = 1; i < flat.length; i += 2) flat[i] = Math.max(0, flat[i]);
  }
  if (flat[0] > 0) return [0, 0, ...flat];
  return flat;
}

function toFloat64(flat) {
  return Float64Array.from(flat);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
