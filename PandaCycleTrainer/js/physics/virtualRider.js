// ゴースト・集団走行の「他のライダー」が距離を進めるための最小モデル(純粋ロジック)。
// 仕様 PR2+3 §4.1 に対応。物理式は PhysicsEngine.step() と同じ力の釣り合い
// (computeForces)を使い、dt の丸め・速度の 0〜MAX_SPEED_MPS クランプも同じ規則にそろえる。
// ゴーストは記録の再生で距離を直接決めるため、ここで進めるのは主に集団(kind 'pack')。

import { PhysicsConstants } from './physicsConstants.js';
import { computeForces } from './physicsEngine.js';

export const VIRTUAL_RIDER = {
  // massKg 未指定時の体重+自転車重量(kg)。セットアップ画面の既定(70kg+9kg)相当。
  DEFAULT_MASS_KG: 79,
  // powerModel がケイデンスを返さないときの、勾配からの簡易ケイデンス(demoRider と同じ傾き)。
  BASE_CADENCE_RPM: 88,
  CADENCE_PER_GRADE_RPM: -1.8,
  MIN_CADENCE_RPM: 55,
  MAX_CADENCE_RPM: 105,
  // PhysicsEngine.step() と同じ dt 上限(s)。
  MAX_DT_S: 0.25,
};

const TWO_PI = Math.PI * 2;

/**
 * @param {object} opts
 * @param {string} opts.id
 * @param {'ghost'|'pack'} opts.kind
 * @param {string} [opts.name]
 * @param {string} [opts.color] '#rrggbb'
 * @param {number} [opts.startDistanceM=0]
 * @param {number} [opts.laneOffsetM=0]
 * @param {(gradePercent:number, tSec:number)=>(number|{powerW?:number, targetPowerW?:number, cadenceRpm?:number})|null} [opts.powerModel=null]
 *   W を返す関数(ケイデンスも決めたいときは { powerW, cadenceRpm } を返してよい)。null なら 0W(惰性)。
 * @param {number} [opts.massKg] 体重+自転車重量
 */
export function createVirtualRider({
  id,
  kind,
  name,
  color,
  startDistanceM = 0,
  laneOffsetM = 0,
  powerModel = null,
  massKg,
}) {
  const lane = Number.isFinite(laneOffsetM) ? laneOffsetM : 0;
  return {
    id,
    kind,
    name,
    color,
    powerModel,
    massKg: Number.isFinite(massKg) && massKg > 0 ? massKg : VIRTUAL_RIDER.DEFAULT_MASS_KG,
    distanceM: Number.isFinite(startDistanceM) ? startDistanceM : 0,
    speedMps: 0,
    cadenceRpm: 0,
    crankRad: 0,
    laneOffsetM: lane,
    targetLaneM: lane,
    powerW: 0,
  };
}

/**
 * 仮想ライダーを dt 秒進める(r を書き換えて返す)。不正な dt(0/負/NaN/Infinity)では何もしない。
 * @param {object} r createVirtualRider の戻り値
 * @param {number} dt 秒(0.25 で丸める)
 * @param {object} env
 * @param {(km:number)=>number} env.gradeAtKm 距離(km) → 勾配(%)。CourseEngine を渡してもよい
 * @param {number} [env.massKg] 省略時は r.massKg
 * @param {number} [env.crr] 省略時は PhysicsConstants.CRR
 * @param {number} [env.cdaM2] 省略時は PhysicsConstants.CDA
 * @param {number} [env.draftFactor=1] ドラフティング時の CdA 倍率
 * @param {number} [env.tSec] powerModel に渡す経過秒
 */
export function stepVirtualRider(r, dt, { gradeAtKm, massKg, crr, cdaM2, draftFactor = 1, tSec } = {}) {
  if (!r || !(dt > 0) || !Number.isFinite(dt)) return r;
  const step = Math.min(dt, VIRTUAL_RIDER.MAX_DT_S);

  const gradePercent = readGrade(gradeAtKm, r.distanceM / 1000);
  const mass = Number.isFinite(massKg) && massKg > 0 ? massKg : r.massKg;
  const { powerW, cadenceRpm } = evalPowerModel(r.powerModel, gradePercent, tSec);

  const { netForce } = computeForces({
    speedMps: r.speedMps,
    gradePercent,
    massKg: mass,
    crr: crr ?? PhysicsConstants.CRR,
    cdaM2: cdaM2 ?? PhysicsConstants.CDA,
    powerW,
    draftFactor: Number.isFinite(draftFactor) && draftFactor > 0 ? draftFactor : 1,
  });
  let speed = r.speedMps + (netForce / mass) * step;
  speed = Math.min(PhysicsConstants.MAX_SPEED_MPS, Math.max(0, speed));

  r.speedMps = speed;
  r.distanceM += speed * step;
  r.powerW = powerW;
  // 止まっている(または脚を止めている)ときはクランクも止める。
  r.cadenceRpm = powerW > 0 && speed > 0 ? cadenceRpm : 0;
  r.crankRad = (r.crankRad + (r.cadenceRpm / 60) * TWO_PI * step) % TWO_PI;
  return r;
}

function readGrade(gradeAtKm, km) {
  let g;
  if (typeof gradeAtKm === 'function') g = gradeAtKm(km);
  else if (gradeAtKm && typeof gradeAtKm.gradeAtKm === 'function') g = gradeAtKm.gradeAtKm(km);
  return Number.isFinite(g) ? g : 0;
}

function evalPowerModel(powerModel, gradePercent, tSec) {
  const fallbackCadence = defaultCadence(gradePercent);
  if (typeof powerModel !== 'function') return { powerW: 0, cadenceRpm: 0 };
  const out = powerModel(gradePercent, Number.isFinite(tSec) ? tSec : 0);
  let powerW;
  let cadenceRpm = fallbackCadence;
  if (typeof out === 'number') {
    powerW = out;
  } else if (out && typeof out === 'object') {
    powerW = out.powerW ?? out.targetPowerW;
    if (Number.isFinite(out.cadenceRpm)) cadenceRpm = out.cadenceRpm;
  }
  powerW = Number.isFinite(powerW) ? Math.max(0, powerW) : 0;
  return { powerW, cadenceRpm };
}

function defaultCadence(gradePercent) {
  const V = VIRTUAL_RIDER;
  const c = V.BASE_CADENCE_RPM + V.CADENCE_PER_GRADE_RPM * gradePercent;
  return Math.min(V.MAX_CADENCE_RPM, Math.max(V.MIN_CADENCE_RPM, c));
}
