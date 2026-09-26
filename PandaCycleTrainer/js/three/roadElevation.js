// 3D都市シーンの道路起伏を、CourseEngineのgradeAtKm(km)から積分して求める。
// Three.js非依存の純粋関数にしてあるのはcityLayout.js同様、Node上での
// ユニットテストを可能にするため。
//
// 「現在位置(alongM=0)の標高を常に0とする」相対座標系を採用する。
// これはRideScreenの物理演算ループが管理する絶対標高(PhysicsEngine.elevationM)
// とは別物 — こちらはあくまで描画ウィンドウ内の相対的な起伏を表現するための値。
// (見た目上の坂を作るためのものであり、走行記録に使う実際の獲得標高計算には
// 使わない。)

/**
 * @param {(km: number) => number} gradeAtKm CourseEngine#gradeAtKmと同じ契約の関数
 * @param {number} currentDistanceKm 現在の走行距離(km)
 * @param {object} opts
 * @param {number} opts.behindM 後方何mまでサンプルするか
 * @param {number} opts.aheadM 前方何mまでサンプルするか
 * @param {number} opts.stepM サンプル間隔(m)
 * @returns {Array<{alongM: number, elevM: number}>} alongM昇順、alongM=0でelevM=0
 */
export function buildElevationProfile(gradeAtKm, currentDistanceKm, opts) {
  const { behindM, aheadM, stepM } = opts;
  const forward = [{ alongM: 0, elevM: 0 }];
  let elev = 0;
  let alongM = 0;
  while (alongM < aheadM) {
    const stepStart = alongM;
    const stepEnd = Math.min(alongM + stepM, aheadM);
    const stepLen = stepEnd - stepStart;
    const km = currentDistanceKm + (stepStart + stepLen / 2) / 1000;
    const grade = gradeAtKm(km) / 100;
    elev += grade * stepLen;
    alongM = stepEnd;
    forward.push({ alongM, elevM: elev });
  }

  const backward = [];
  elev = 0;
  alongM = 0;
  while (alongM > -behindM) {
    const stepStart = alongM;
    const stepEnd = Math.max(alongM - stepM, -behindM);
    const stepLen = stepStart - stepEnd; // positive
    const km = currentDistanceKm + (stepStart - stepLen / 2) / 1000;
    const grade = gradeAtKm(km) / 100;
    elev -= grade * stepLen;
    alongM = stepEnd;
    backward.push({ alongM, elevM: elev });
  }
  backward.reverse();

  return [...backward, ...forward];
}

/**
 * buildElevationProfileの結果から、任意のalongMにおける標高を線形補間で求める。
 * 範囲外は最も近い端点の値でクランプする。
 */
export function interpolateElevation(profile, alongM) {
  if (profile.length === 0) return 0;
  if (alongM <= profile[0].alongM) return profile[0].elevM;
  const last = profile[profile.length - 1];
  if (alongM >= last.alongM) return last.elevM;
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (alongM >= a.alongM && alongM <= b.alongM) {
      const t = b.alongM === a.alongM ? 0 : (alongM - a.alongM) / (b.alongM - a.alongM);
      return a.elevM + (b.elevM - a.elevM) * t;
    }
  }
  return last.elevM;
}
