// 選択されたコースプロファイルとユーザー入力の走行距離(ゴール距離)から、
// 走行位置(km)に対する勾配(%)を返すエンジン。
// 要件定義書4章に対応:
//  - 入力距離がプロファイルより短ければ先頭から切り出し
//  - 長ければプロファイルをループさせる
//  - ループ境界の不連続はクロスフェードで緩和する
//  - ただし fixedLength のコース(GPX の実在コース)はループしない。コースの外側は
//    始点より手前 = 始点の勾配、終点より先 = 平坦(0%)として扱う。走行距離はコース長以下に
//    制限されるので物理には効かず、3D 表示が終点の先・始点の手前を描くときにだけ使われる
//    (ループさせると終点の先に始点の起伏が現れてしまうため)。

import { buildCornerSpeedLimits, cornerSpeedLimitAt } from './cornering.js';

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

  /**
   * 指定した走行距離(km)でコーナーを曲がるための上限速度(m/s)。コーナーの減速は
   * 方位の表を持つ GPX の実在コース(ループしない)だけ。それ以外・コーナーの無い地点は Infinity。
   */
  speedLimitMpsAt(distanceKm) {
    if (this._cornerLimits === undefined) {
      this._cornerLimits = this.profile.fixedLength ? buildCornerSpeedLimits(this.profile.curve) : null;
    }
    return cornerSpeedLimitAt(this._cornerLimits, distanceKm * 1000);
  }

  /** 指定した走行距離(km)における勾配(%)を返す。 */
  gradeAtKm(distanceKm) {
    if (this.profile.fixedLength) return this._gradeFixed(distanceKm);
    const L = this.profile.loopLengthKm;
    let m = distanceKm % L;
    if (m < 0) m += L;
    return this._gradeInLoop(m);
  }

  /** ループしないコースの勾配(%)。始点より手前は始点の勾配、終点より先は 0%。 */
  _gradeFixed(km) {
    if (km > this.profile.loopLengthKm) return 0;
    return interpolate(this.profile.points, km);
  }

  /** 1周内の位置 m(0〜L km)における勾配(%)。gradeAtKm とループ積分の共通部分。 */
  _gradeInLoop(m) {
    const L = this.profile.loopLengthKm;
    const points = this.profile.points;
    const crossfade = this.profile.crossfadeKm ?? 0;
    const rawGrade = interpolate(points, m);
    if (crossfade > 0 && m > L - crossfade) {
      const t = (m - (L - crossfade)) / crossfade;
      const startGrade = interpolate(points, 0);
      return rawGrade * (1 - t) + startGrade * t;
    }
    return rawGrade;
  }

  /**
   * fromKm → toKm の標高差(m)。gradeAtKm を距離で積分する(ループ・クロスフェード込み)。
   * fromKm > toKm なら符号が反転した負方向の値を返す。次の500mの平均勾配
   * (= elevationDeltaM(d, d+0.5) / 500 × 100)などに使う。
   * 勾配は制御点間で線形、クロスフェード区間で2次式なので、それらの折れ点で区間を
   * 分け、各区間をシンプソン則(台形則の2次精度版。2次式まで厳密)で積分する。
   * 注: PhysicsEngine の標高は走行距離×sinθ の積算なので、急勾配ではごくわずかに異なる。
   */
  elevationDeltaM(fromKm, toKm) {
    if (!Number.isFinite(fromKm) || !Number.isFinite(toKm) || fromKm === toKm) return 0;
    if (fromKm > toKm) return -this.elevationDeltaM(toKm, fromKm);
    const L = this.profile.loopLengthKm;
    if (this.profile.fixedLength) {
      // 始点より手前は始点の勾配一定、終点より先は平坦(_gradeFixed と同じ扱い)
      const before = Math.max(0, Math.min(toKm, 0) - fromKm) * interpolate(this.profile.points, 0);
      const a = Math.max(fromKm, 0);
      const b = Math.min(toKm, L);
      return (before + (b > a ? this._integrateInLoop(a, b) : 0)) * 10;
    }
    const firstLoop = Math.floor(fromKm / L);
    const lastLoop = Math.floor(toKm / L);
    const a = fromKm - firstLoop * L;
    const b = toKm - lastLoop * L;
    // 勾配[%]×距離[km] の積分値。×10 で m になる(% /100 × km×1000)。
    let integral;
    if (firstLoop === lastLoop) {
      integral = this._integrateInLoop(a, b);
    } else {
      integral = this._integrateInLoop(a, L) + this._integrateInLoop(0, b);
      const fullLoops = lastLoop - firstLoop - 1;
      if (fullLoops > 0) integral += fullLoops * this._integrateInLoop(0, L);
    }
    return integral * 10;
  }

  /** 1周内 [a, b](0 ≤ a ≤ b ≤ L)の勾配の積分(%·km)。 */
  _integrateInLoop(a, b) {
    if (!(b > a)) return 0;
    const L = this.profile.loopLengthKm;
    const crossfade = this.profile.crossfadeKm ?? 0;
    const breaks = [a, b];
    for (const [km] of this.profile.points) {
      if (km > a && km < b) breaks.push(km);
    }
    if (crossfade > 0) {
      const cf = L - crossfade;
      if (cf > a && cf < b) breaks.push(cf);
    }
    breaks.sort((x, y) => x - y);
    let sum = 0;
    for (let i = 0; i < breaks.length - 1; i++) {
      const x0 = breaks[i];
      const x1 = breaks[i + 1];
      if (x1 <= x0) continue;
      const g0 = this._gradeInLoop(x0);
      const gm = this._gradeInLoop((x0 + x1) / 2);
      const g1 = this._gradeInLoop(x1);
      sum += ((x1 - x0) / 6) * (g0 + 4 * gm + g1);
    }
    return sum;
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
  // 二分探索で km を含む区間 [lo, lo+1] を探す(GPX の実在コースは制御点が数百〜千点になるため)。
  // 同じ km の制御点が並ぶ(勾配の段差)ときは、従来の線形走査と同じく手前の点の値を返す。
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < km) lo = mid;
    else hi = mid;
  }
  const [k0, g0] = points[lo];
  const [k1, g1] = points[hi];
  const t = k1 === k0 ? 0 : (km - k0) / (k1 - k0);
  return g0 + (g1 - g0) * t;
}
