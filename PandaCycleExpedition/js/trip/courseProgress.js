// コースの走行記録: どのコースを途中まで走ったか・完走したか。純粋関数のみ。
//
// 新しい記録は持たず、旅のセーブデータ(legs と position)から求める。旅はコースごとに別々(tripCourseId)。旅の支度ではこれまでの旅
// (tripStore に残っている旅ごとの最新スナップショット)もまとめて見るので、新しい旅を始めても印は消えない。
// コース = 区間。逆向きに走った分も同じコースとして数える。

import { getSegment, REVERSE_SUFFIX } from './network.js';

/** 完走とみなす残り距離(m)。区間の終点判定(HomeScreen の finished)と同じ 1 m。 */
const FINISH_SLACK_M = 1;

const baseId = (id) => (id.endsWith(REVERSE_SUFFIX) ? id.slice(0, -REVERSE_SUFFIX.length) : id);

/**
 * 1つの旅で、コースごとに走った距離のいちばん長いものと完走したか。
 * @returns {Map<string, {bestM:number, done:boolean}>} キーは順方向の区間 id
 */
export function tripCourseProgress(trip) {
  const out = new Map();
  const legs = trip?.legs ?? [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.transfer || typeof leg.segmentId !== 'string') continue; // 電車・船で着いた区間は走っていない
    const seg = getSegment(leg.segmentId);
    if (!seg) continue;
    const last = i === legs.length - 1;
    // 最後の区間は今の位置、それより前は次の区間に入ったときの累積距離までを走った分とする
    // (続きから入った区間は startM の地点から)
    const m = last ? trip.position.segmentM : (leg.startM ?? 0) + legs[i + 1].startTotalM - leg.startTotalM;
    if (!(m > 0)) continue;
    const id = baseId(leg.segmentId);
    const prev = out.get(id) ?? { bestM: 0, done: false };
    out.set(id, {
      bestM: Math.max(prev.bestM, Math.min(m, seg.lengthM)),
      done: prev.done || m >= seg.lengthM - FINISH_SLACK_M,
    });
  }
  return out;
}

/**
 * いくつもの旅の記録をまとめる(同じコースは長い方・完走した方を取る)。
 * @param {object[]} trips
 * @returns {Map<string, {bestM:number, done:boolean}>}
 */
export function courseProgress(trips) {
  const out = new Map();
  for (const t of trips) {
    for (const [id, p] of tripCourseProgress(t)) {
      const prev = out.get(id);
      out.set(id, prev ? { bestM: Math.max(prev.bestM, p.bestM), done: prev.done || p.done } : p);
    }
  }
  return out;
}

/**
 * 旅のコース = その旅を始めたコース(最初の区間)。旅はコースごとに別々に持ち、
 * コースを切り替えると、そのコースの旅(日数・体力・所持金・荷物・日誌・位置)に戻る。
 */
export function tripCourseId(trip) {
  const id = trip?.legs?.[0]?.segmentId ?? trip?.position?.segmentId;
  return typeof id === 'string' ? baseId(id) : null;
}

/**
 * コースごとの旅(同じコースの旅がいくつもあれば、いちばん新しく更新したもの)。
 * @param {object[]} trips 保存に残っている旅(旅ごとの最新)
 * @returns {Map<string, object>} キーはコース(順方向の区間 id)
 */
export function tripsByCourse(trips) {
  const out = new Map();
  for (const t of trips) {
    const id = tripCourseId(t);
    if (!id) continue;
    const prev = out.get(id);
    if (!prev || (t.updatedAt ?? 0) > (prev.updatedAt ?? 0)) out.set(id, t);
  }
  return out;
}

/** コース一覧の印: 'done'(完走)/'partial'(途中まで)/null(まだ)。 */
export function courseMark(progress, segmentId) {
  const p = progress?.get(segmentId);
  if (!p) return null;
  return p.done ? 'done' : 'partial';
}
