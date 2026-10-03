// 集団走行(仮想の5人)とドラフティング・追い越し(車線移動)の純粋ロジック。
// 仕様 PR2+3 §6 に対応。
//  - パワーは demoRiderTarget と同じ形の式(riderTargetWithBase)で、基準パワーだけ人ごとにずらす
//  - ドラフティング: 前のライダーとの車間 0.5〜6.0m(両端含む)・横ずれ 1.0m 未満で CdA×0.66
//    (判定定数は physicsConstants.js の DRAFT_*)。ゴーストは leaders に含めない(呼び出し側の責務)
//  - 追い越し: 前 3.5m 以内・横ずれ 0.8m 未満の遅いライダーがいたら、その人の右 0.9m へ。
//    laneOffsetM は時定数 0.7 秒の一次遅れで目標へ近づける
// 自分(実ライダー)の判定も ui が同じ isDrafting / laneTarget / stepLane で行う。

import { PhysicsConstants } from './physicsConstants.js';
import { riderTargetWithBase } from './demoRider.js';
import { createVirtualRider, stepVirtualRider, VIRTUAL_RIDER } from './virtualRider.js';

export const PACK = {
  BASE_POWERS_W: [175, 190, 215, 225, 240], // 平坦での巡航パワー(人ごと)
  START_GAPS_M: [30, 90, 160, 260, 420], // スタート地点からの前方距離
  NAMES: ['ハヤト', 'ミサキ', 'ケンジ', 'アオイ', 'リョウ'],
  JERSEY_COLORS: ['#e4572e', '#2e86de', '#f4c430', '#17a589', '#8e44ad'],
  MASS_KG: 76, // 体重+自転車重量(全員共通)
  LANE_TAU_S: 0.7, // 車線移動の時定数
  PASS_LOOKAHEAD_M: 3.5, // この距離以内の前方ライダーを追い越し対象として見る
  PASS_LATERAL_M: 0.8, // 横ずれがこれ未満なら「同じ車線で塞がれている」
  PASS_SHIFT_M: 0.9, // 塞いでいる人の右へずらす量
  // 追い越し中に元の車線へ戻るのは、抜いた相手がこの距離だけ後ろへ下がってから
  // (並走中に戻って重ならないように。自転車1台分+余裕)。
  PASS_CLEAR_BEHIND_M: 2.0,
  // 揺らぎの位相を人ごとにずらす(全員が同時に踏み込まないように)。
  WOBBLE_PHASE_S: 37,
};

/**
 * 集団の5人を作る。kind は 'pack'、id は 'pack-0'〜'pack-4'。
 * @param {{startDistanceM?: number}} [opts]
 * @returns {object[]} VirtualRider の配列(各要素に drafting:boolean を追加)
 */
export function createPack({ startDistanceM = 0 } = {}) {
  const start = Number.isFinite(startDistanceM) ? startDistanceM : 0;
  return PACK.BASE_POWERS_W.map((baseW, i) => {
    const phase = i * PACK.WOBBLE_PHASE_S;
    const rider = createVirtualRider({
      id: `pack-${i}`,
      kind: 'pack',
      name: PACK.NAMES[i],
      color: PACK.JERSEY_COLORS[i],
      startDistanceM: start + PACK.START_GAPS_M[i],
      laneOffsetM: 0,
      massKg: PACK.MASS_KG,
      powerModel: (gradePercent, tSec) => {
        const { targetPowerW, cadenceRpm } = riderTargetWithBase(baseW, gradePercent, tSec + phase);
        return { powerW: targetPowerW, cadenceRpm };
      },
    });
    rider.drafting = false;
    return rider;
  });
}

/**
 * follower が leaders の誰かの後ろでドラフティングできているか。
 * 車間 gap = leader.distanceM − follower.distanceM が DRAFT_MIN_GAP_M 以上 DRAFT_MAX_GAP_M 以下、
 * かつ横ずれ |Δlane| が DRAFT_MAX_LATERAL_M 未満の人が1人でもいれば true。
 * @param {{distanceM:number, laneOffsetM?:number}} follower
 * @param {Array<{distanceM:number, laneOffsetM?:number}>} leaders
 */
export function isDrafting(follower, leaders) {
  if (!follower || !Array.isArray(leaders)) return false;
  const C = PhysicsConstants;
  const lane = follower.laneOffsetM ?? 0;
  for (const l of leaders) {
    if (!l || l === follower) continue;
    const gap = l.distanceM - follower.distanceM;
    const lateral = Math.abs((l.laneOffsetM ?? 0) - lane);
    if (gap >= C.DRAFT_MIN_GAP_M && gap <= C.DRAFT_MAX_GAP_M && lateral < C.DRAFT_MAX_LATERAL_M) return true;
  }
  return false;
}

/**
 * 目標の laneOffsetM(m)を返す。
 *  - 自分の前 PASS_LOOKAHEAD_M 以内(0 < gap ≤ 3.5)で横ずれ PASS_LATERAL_M 未満の、自分より遅い
 *    ライダーがいたら、その人の laneOffsetM + PASS_SHIFT_M(複数いれば最も右)
 *  - すでに車線をずらしている間は、元の車線(0)を塞ぐ人が −PASS_CLEAR_BEHIND_M < gap ≤ 3.5 に
 *    いる限りその目標を保つ(ずらした直後に横ずれが 0.8m を超えて戻ろうとする振動を防ぐ)
 *  - どちらもいなければ 0(元の車線へ戻る)
 * @param {{distanceM:number, laneOffsetM?:number, speedMps?:number}} self
 * @param {Array<{distanceM:number, laneOffsetM?:number, speedMps?:number}>} others
 */
export function laneTarget(self, others) {
  if (!self || !Array.isArray(others)) return 0;
  const P = PACK;
  const myLane = self.laneOffsetM ?? 0;
  const mySpeed = self.speedMps ?? 0;
  const shifted = Math.abs(myLane) >= P.PASS_LATERAL_M;
  let target = 0;
  let blocked = false;
  for (const o of others) {
    if (!o || o === self) continue;
    const gap = o.distanceM - self.distanceM;
    const oLane = o.laneOffsetM ?? 0;
    const blocking =
      (gap > 0 && gap <= P.PASS_LOOKAHEAD_M && Math.abs(oLane - myLane) < P.PASS_LATERAL_M && (o.speedMps ?? 0) < mySpeed) ||
      (shifted && gap > -P.PASS_CLEAR_BEHIND_M && gap <= P.PASS_LOOKAHEAD_M && Math.abs(oLane) < P.PASS_LATERAL_M);
    if (blocking) {
      const t = oLane + P.PASS_SHIFT_M;
      target = blocked ? Math.max(target, t) : t;
      blocked = true;
    }
  }
  return target;
}

/**
 * 車線位置を目標へ時定数 LANE_TAU_S の一次遅れで近づける。不正な dt では現在値のまま。
 * @param {number} currentM
 * @param {number} targetM
 * @param {number} dt 秒
 */
export function stepLane(currentM, targetM, dt) {
  const cur = Number.isFinite(currentM) ? currentM : 0;
  if (!Number.isFinite(targetM) || !(dt > 0) || !Number.isFinite(dt)) return cur;
  const k = 1 - Math.exp(-dt / PACK.LANE_TAU_S);
  return cur + (targetM - cur) * k;
}

/**
 * 集団を dt 秒進める(各ライダーを書き換えて pack を返す)。
 * ドラフティングと車線目標は、全員を進める前の位置で判定する(処理順に依存しない=決定的)。
 * @param {object[]} pack createPack の戻り値
 * @param {number} dt 秒(0.25 で丸める)
 * @param {object} env
 * @param {(km:number)=>number} env.gradeAtKm
 * @param {number} [env.crr]
 * @param {number} [env.cdaM2]
 * @param {number} [env.tSec]
 * @param {{distanceM:number, laneOffsetM?:number, speedMps?:number}} [env.me] 実ライダー
 *   (集団のドラフティング・追い越し判定の相手に含める)
 */
export function stepPack(pack, dt, { gradeAtKm, crr, cdaM2, tSec, me } = {}) {
  if (!Array.isArray(pack) || !(dt > 0) || !Number.isFinite(dt)) return pack;
  const step = Math.min(dt, VIRTUAL_RIDER.MAX_DT_S);
  const decisions = pack.map((r) => {
    const others = pack.filter((o) => o !== r);
    if (me) others.push(me);
    return { drafting: isDrafting(r, others), target: laneTarget(r, others) };
  });
  pack.forEach((r, i) => {
    const { drafting, target } = decisions[i];
    r.drafting = drafting;
    r.targetLaneM = target;
    r.laneOffsetM = stepLane(r.laneOffsetM, target, step);
    stepVirtualRider(r, step, {
      gradeAtKm,
      crr,
      cdaM2,
      tSec,
      draftFactor: drafting ? PhysicsConstants.DRAFT_CDA_FACTOR : 1,
    });
  });
  return pack;
}
