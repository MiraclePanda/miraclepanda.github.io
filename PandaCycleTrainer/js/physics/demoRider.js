// デモ走行(トレーナー未接続)用の仮想ライダー。コースの勾配に応じてパワーとケイデンスを
// 返す純粋関数。上りでは踏み込み、下りでは脚を緩める一般的なライダーの振る舞いを模し、
// 実走らしく見えるよう緩やかな揺らぎを加える。

export const DEMO_RIDER = {
  BASE_POWER_W: 185, // 平坦での巡航パワー
  POWER_PER_GRADE_W: 11, // 勾配1%あたりの増減
  MIN_POWER_W: 60,
  MAX_POWER_W: 360,
  BASE_CADENCE_RPM: 88,
  CADENCE_PER_GRADE_RPM: -1.8, // 上りほどケイデンスは落ちる
  MIN_CADENCE_RPM: 55,
  MAX_CADENCE_RPM: 105,
  POWER_SMOOTHING_S: 2, // 目標パワーへの追従の時定数
};

/**
 * @param {number} gradePercent 現在のコース勾配(%)
 * @param {number} tSec デモ開始からの経過秒(揺らぎの位相)
 * @returns {{targetPowerW: number, cadenceRpm: number}}
 */
export function demoRiderTarget(gradePercent, tSec) {
  return riderTargetWithBase(DEMO_RIDER.BASE_POWER_W, gradePercent, tSec);
}

/**
 * demoRiderTarget と同じ形の式で、平坦での基準パワーだけを差し替えたもの。
 * 集団走行(packRiders.js)のライダーごとの脚力差に使う。その他の係数・上下限は DEMO_RIDER。
 * @param {number} basePowerW 平坦での巡航パワー
 * @param {number} gradePercent
 * @param {number} tSec
 * @returns {{targetPowerW: number, cadenceRpm: number}}
 */
export function riderTargetWithBase(basePowerW, gradePercent, tSec) {
  const g = Number.isFinite(gradePercent) ? gradePercent : 0;
  const t = Number.isFinite(tSec) ? tSec : 0;
  const R = DEMO_RIDER;
  const wobble = 12 * Math.sin(t / 7) + 6 * Math.sin(t / 2.3 + 1.1);
  const targetPowerW = clamp(basePowerW + R.POWER_PER_GRADE_W * g + wobble, R.MIN_POWER_W, R.MAX_POWER_W);
  const cadenceRpm = clamp(R.BASE_CADENCE_RPM + R.CADENCE_PER_GRADE_RPM * g + 3 * Math.sin(t / 5), R.MIN_CADENCE_RPM, R.MAX_CADENCE_RPM);
  return { targetPowerW, cadenceRpm };
}

/** 現在のパワーを目標へ一次遅れで近づける(急なパワー変化で加速がぎくしゃくしないように)。 */
export function smoothDemoPower(currentW, targetW, dtSec) {
  if (!Number.isFinite(currentW)) return targetW;
  const k = Math.min(1, Math.max(0, dtSec) / DEMO_RIDER.POWER_SMOOTHING_S);
  return currentW + (targetW - currentW) * k;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}
