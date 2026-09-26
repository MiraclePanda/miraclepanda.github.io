// 選択されたコースプロファイルとユーザー入力の走行距離(ゴール距離)から、
// 走行位置(km)に対する勾配(%)を返すエンジン。
// 要件定義書4章に対応:
//  - 入力距離がプロファイルより短ければ先頭から切り出し
//  - 長ければプロファイルをループさせる
//  - ループ境界の不連続はクロスフェードで緩和する

export class CourseEngine {
  /**
   * @param {object} profile courseProfiles.js の要素
   * @param {number} goalDistanceKm ユーザー入力のゴール距離
   */
  constructor(profile, goalDistanceKm) {
    this.profile = profile;
    this.goalDistanceKm = goalDistanceKm;
    // 継続走行時に加算していく「現在の目標距離」。ゴール到達→続行のたびに
    // プロファイル1周分を加算し、残距離表示や再ゴール判定の基準にする。
    this.effectiveGoalKm = goalDistanceKm;
  }

  /** ゴールに到達し「続行」が選ばれた時に呼ぶ。目標距離を1周分延長する。 */
  extendGoal() {
    this.effectiveGoalKm += this.profile.loopLengthKm;
  }

  /** 指定した走行距離(km)における勾配(%)を返す。 */
  gradeAtKm(distanceKm) {
    const L = this.profile.loopLengthKm;
    const points = this.profile.points;
    const crossfade = this.profile.crossfadeKm ?? 0;
    let m = distanceKm % L;
    if (m < 0) m += L;

    const rawGrade = interpolate(points, m);
    if (crossfade > 0 && m > L - crossfade) {
      const t = (m - (L - crossfade)) / crossfade;
      const startGrade = interpolate(points, 0);
      return rawGrade * (1 - t) + startGrade * t;
    }
    return rawGrade;
  }

  remainingKm(distanceKm) {
    return Math.max(0, this.effectiveGoalKm - distanceKm);
  }

  isGoalReached(distanceKm) {
    return distanceKm >= this.effectiveGoalKm;
  }
}

function interpolate(points, km) {
  if (km <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (km >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [k0, g0] = points[i];
    const [k1, g1] = points[i + 1];
    if (km >= k0 && km <= k1) {
      const t = k1 === k0 ? 0 : (km - k0) / (k1 - k0);
      return g0 + (g1 - g0) * t;
    }
  }
  return last[1];
}
