// 旅の路面・荷物・風(設計書3章)。純粋関数のみ(Node のテストからそのまま読める)。
//
//  - 路面ごとの転がり抵抗 Crr(グラベルタイヤ)。雨の後は未舗装路だけ WET_UNPAVED_CRR_FACTOR 倍。
//  - 荷物の重さの合計(物理の質量に入る)。
//  - トレーナーへの勾配指示の上乗せ分(extraGradePercent): 旅で増えた抵抗を等価勾配に換算する。
//    DC1 が Simulation Parameters の Crr/Cw を反映するかは実機未確認なので、
//    トレーナーには基準の Crr/CdA(PhysicsConstants.CRR/CDA)を送ったまま、差分を勾配で感じさせる。

import { PhysicsConstants } from './physicsConstants.js';

/** 路面の種類。crr はグラベルタイヤでの値、unpaved は雨で濡れると重くなるか。 */
export const SURFACES = {
  paved: { label: '舗装', crr: 0.006, unpaved: false },
  gravel: { label: '砂利道', crr: 0.010, unpaved: true },
  rough: { label: '荒れた未舗装', crr: 0.015, unpaved: true },
  mud: { label: '泥道', crr: 0.025, unpaved: true },
};

export const DEFAULT_SURFACE = 'paved';

/** 不明な路面 ID は舗装として扱う(区間データの書き損じで止まらないように)。 */
export function surfaceOf(id) {
  return SURFACES[id] ?? SURFACES[DEFAULT_SURFACE];
}

/**
 * 路面と濡れ具合から転がり抵抗係数を求める。
 * @param {string} surfaceId SURFACES のキー
 * @param {boolean} [wet=false] 雨の後で路面が濡れているか
 */
export function rollingCrr(surfaceId, wet = false) {
  const s = surfaceOf(surfaceId);
  return s.unpaved && wet ? s.crr * PhysicsConstants.WET_UNPAVED_CRR_FACTOR : s.crr;
}

/**
 * 既定の荷物(フル装備で約14kg)。設計書2章の bike.pack と同じ項目名。
 * 食料と水は旅の中で減ったり補給したりする想定。
 */
export const DEFAULT_PACK = {
  tent: 2.0,
  sleepingBag: 1.2,
  rainwear: 0.6,
  food: 2.5,
  water: 3.0,
  clothes: 1.5,
  tools: 1.2, // 工具・予備チューブ・ポンプ
  bags: 2.0, // バッグ類そのもの
};

/** 荷物の重さの合計(kg)。数値でない・負の項目は 0 として数える。 */
export function packWeightKg(pack = DEFAULT_PACK) {
  let sum = 0;
  for (const v of Object.values(pack ?? {})) {
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

/**
 * 空気抵抗(N)。headwindMps は向かい風が正。追い風で相対風速が負になれば押す力(負の抵抗)になる。
 */
export function airDragN(cdaM2, speedMps, headwindMps = 0) {
  const rel = speedMps + headwindMps;
  return 0.5 * PhysicsConstants.AIR_DENSITY * cdaM2 * rel * Math.abs(rel);
}

/**
 * トレーナーへ送る勾配に上乗せする等価勾配(%)。
 * 旅の抵抗(荷物込みの質量・路面の Crr・バッグ込みの CdA・向かい風)と、トレーナーが標準で想定する
 * 抵抗(体重+車体、PhysicsConstants.CRR/CDA、無風)との差を、体重+車体の重さを持ち上げる勾配に換算する
 * (Δ勾配 ≈ ΔF / (m_base·g)、小角近似)。下りでは荷物の重さが進む力になるので負にもなる。
 * @param {object} p
 * @param {number} p.speedMps
 * @param {number} p.gradePercent 道の勾配
 * @param {number} p.baseMassKg 体重+車体(トレーナー側が想定する質量)
 * @param {number} p.packKg 荷物の合計
 * @param {number} p.crr 旅の路面の Crr(rollingCrr)
 * @param {number} p.cdaM2 旅の CdA
 * @param {number} [p.headwindMps=0]
 */
export function extraGradePercent({ speedMps, gradePercent, baseMassKg, packKg, crr, cdaM2, headwindMps = 0 }) {
  const g = PhysicsConstants.GRAVITY;
  const theta = Math.atan(gradePercent / 100);
  const v = Math.max(0, speedMps);
  const tripMass = baseMassKg + packKg;
  const fTrip = tripMass * g * Math.sin(theta) + crr * tripMass * g * Math.cos(theta) + airDragN(cdaM2, v, headwindMps);
  const fBase = baseMassKg * g * Math.sin(theta) + PhysicsConstants.CRR * baseMassKg * g * Math.cos(theta)
    + airDragN(PhysicsConstants.CDA, v, 0);
  return ((fTrip - fBase) / (baseMassKg * g)) * 100;
}
