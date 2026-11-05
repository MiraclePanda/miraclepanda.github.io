// 走行画面の視点(後ろ / 目線 / 上空)。Three.js 非依存の純粋ロジック(テスト対象)。
// 後ろ・目線は PandaCycleTrainer の cameraViews.js から写したもの(中継風の cine は入れない)。
// 実際のカメラへの反映は realRoadScene.js が行う。

// chase = 斜め後ろ(既定)、fp = ライダーの目線、high = 後ろの上空から見下ろす
export const CAMERA_VIEWS = ['chase', 'fp', 'high'];
export const CHASE_FOV_DEG = 60;
const FP_BOB_M = 0.012;

/**
 * 視点ごとのカメラの置き方。backM = ライダーの何 m 後ろ、upM = 路面からの高さ、
 * aheadM / lookUpM = 見る点(ライダーの何 m 先・高さ)、fov = 画角(度)。目線(fp)は別に計算する。
 */
export const VIEW_RIGS = {
  chase: { backM: 6, upM: 2.4, aheadM: 24, lookUpM: 1.0, fov: CHASE_FOV_DEG },
  // 上空: 後ろ 30 m・高さ 22 m から、少し先の道を見下ろす(地形と道の続きが見渡せる)
  high: { backM: 30, upM: 22, aheadM: 30, lookUpM: 0, fov: 55 },
};

/** 不正な値は 'chase' に丸める。 */
export function normalizeCameraView(view) {
  return CAMERA_VIEWS.includes(view) ? view : 'chase';
}

/** 次の視点(後ろ → 目線 → 上空 → 後ろ)。 */
export function nextCameraView(view) {
  const i = CAMERA_VIEWS.indexOf(normalizeCameraView(view));
  return CAMERA_VIEWS[(i + 1) % CAMERA_VIEWS.length];
}

/** ケイデンスが届かないときの推定値(rpm)。速度に比例させ、30km/h で約90rpm。 */
export function estimateCadenceRpm(speedKmh) {
  return speedKmh > 1 ? Math.min(100, speedKmh * 3) : 0;
}

/**
 * 目線カメラの上下の揺れ(m)を進める。クランク角を cam.crankRad に積分し、
 * 1回転に2回(左右のペダル)±1.2cm 揺らす。ケイデンス0なら揺らさない。
 */
export function fpBobM(cam, cadenceRpm, dt) {
  if (!(cadenceRpm > 0)) return 0;
  cam.crankRad = ((cam.crankRad ?? 0) + (cadenceRpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
  return Math.sin(cam.crankRad * 2) * FP_BOB_M;
}

/** 目線視点の画角(度): 60 + v[m/s]·0.35(速いほど広く見せる)。 */
export function fpFovDeg(speedMps) {
  return CHASE_FOV_DEG + speedMps * 0.35;
}
