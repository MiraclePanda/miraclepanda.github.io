// 走行画面の視点(chase / fp / cine)とライダーの傾きの計算。Three.js 非依存の純粋ロジック(テスト対象)。
// 実際のカメラ・アバターへの反映は各シーン(CityScene / LandscapeScene / PondScene)が行う。
//
// cine(中継風のカメラワーク)のショットの切り替え:
// 沿道に固定したカメラ2種(低い望遠・高い広角)とヘリ視点を、約 CINE_SHOT_S 秒ごとに順番に切り替える。
// 沿道カメラはライダーの前方に置き、通り過ぎたら(後ろへ PASS_BEHIND_M 離れたら)時間前でも次へ進む
// (遠ざかる背中を映し続けないため)。距離が大きく飛んだ(ループ・巻き戻し)ときも次へ進む。
// 実際のワールド座標への変換(横の位置・地面の高さ)は各シーンが行う。

// ---- 視点・傾き・目線の揺れ ----

// chase = 斜め後ろ(従来・既定)、fp = ライダーの目線、cine = 沿道の固定カメラとヘリ視点
export const CAMERA_VIEWS = ['chase', 'fp', 'cine'];
const ROLL_GRAVITY = 9.81; // 傾きの見た目用(物理演算には使わない)
const MAX_RIDER_ROLL_RAD = 0.35;
const MAX_FP_ROLL_RAD = 0.08;
const FP_BOB_M = 0.012;
export const CHASE_FOV_DEG = 60;

/** 不正な値は 'chase' に丸める。allowCine=false(上野不忍池)なら cine も chase 扱い。 */
export function normalizeCameraView(view, allowCine = true) {
  if (view === 'fp') return 'fp';
  if (view === 'cine' && allowCine) return 'cine';
  return 'chase';
}

/**
 * カーブでのライダーの傾き(rad、正 = 左へ倒れる。Three.js の rotation.z と同じ向き)。
 * 曲率 k(1/m、正 = 左カーブ)と速度 v から、遠心力と釣り合う角度の近似 k·v²/g を ±0.35 rad に丸める
 * (カーブの内側へ倒れる)。直線(k = 0)では 0。
 */
export function riderRollRad(k, speedMps) {
  if (!k) return 0;
  return Math.max(-MAX_RIDER_ROLL_RAD, Math.min(MAX_RIDER_ROLL_RAD, (k * speedMps * speedMps) / ROLL_GRAVITY));
}

/** 目線カメラの傾き: ライダーの傾きの半分を ±0.08 rad に丸める。 */
export function fpCameraRollRad(riderRoll) {
  return Math.max(-MAX_FP_ROLL_RAD, Math.min(MAX_FP_ROLL_RAD, riderRoll * 0.5));
}

/** ケイデンスが届かないとき(draw に cadenceRpm がない)の推定値(rpm)。速度に比例させ、30km/h で約90rpm。 */
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

/** 目線視点の画角(度): 60 + v[m/s]·0.35。 */
export function fpFovDeg(speedMps) {
  return CHASE_FOV_DEG + speedMps * 0.35;
}

// ---- cine のショット ----

export const CINE_SHOT_S = 10;
const PASS_BEHIND_M = 14;
const JUMP_M = 200;
const ROADSIDE_AHEAD_M = 55;
const ROADSIDE_AHEAD_SPREAD_M = 40;

/**
 * ショットの種類(順番に繰り返す)。
 * - roadside-low: 沿道の低い位置(1.4〜2.4m)から望遠で
 * - roadside-high: 沿道の高い位置(3.5〜5.5m)からやや広角で
 * - heli: ライダーの斜め後ろ上空(後ろ16m・高さ9m)を一緒に進む
 */
export const CINE_SHOT_TYPES = ['roadside-low', 'roadside-high', 'heli'];

/** 決定的な擬似乱数(mulberry32 と同じ式。毎回同じカメラワークにする)。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} [seed]
 * @returns {{ update(tSec:number, distanceM:number): CineShot, reset(): void }}
 *
 * @typedef {object} CineShot
 * @property {number} index    何番目のショットか(0〜)
 * @property {string} type     CINE_SHOT_TYPES のいずれか
 * @property {number} startedAtS ショットを始めた時刻(s)
 * @property {number} s        沿道カメラを置く絶対距離(m)。heli では使わない(ライダーに付いていく)
 * @property {number} side     左右(-1 = 左、+1 = 右)
 * @property {number} lateralU 沿道の中での横位置 0〜1(シーンが道路端からの距離へ換算する)
 * @property {number} heightM  地面からの高さ(m)
 * @property {number} fovDeg   画角(度)
 */
export function createCineDirector(seed = 20261003) {
  let rand = rng(seed);
  let shot = null;
  let count = 0;
  let lastDistanceM = null;

  function next(tSec, distanceM) {
    const type = CINE_SHOT_TYPES[count % CINE_SHOT_TYPES.length];
    const side = rand() < 0.5 ? -1 : 1;
    const r = rand();
    const base = { index: count, type, startedAtS: tSec, side, lateralU: rand() };
    count++;
    if (type === 'heli') return { ...base, s: distanceM, heightM: 9, fovDeg: 50 };
    const s = distanceM + ROADSIDE_AHEAD_M + r * ROADSIDE_AHEAD_SPREAD_M;
    if (type === 'roadside-low') return { ...base, s, heightM: 1.4 + rand(), fovDeg: 34 + rand() * 4 };
    return { ...base, s, heightM: 3.5 + rand() * 2, fovDeg: 42 + rand() * 4 };
  }

  return {
    update(tSec, distanceM) {
      const jumped = lastDistanceM !== null && Math.abs(distanceM - lastDistanceM) > JUMP_M;
      lastDistanceM = distanceM;
      if (
        !shot || jumped
        || tSec - shot.startedAtS >= CINE_SHOT_S
        || tSec < shot.startedAtS // 時計が戻った(テスト・一時停止からの復帰)
        || (shot.type !== 'heli' && distanceM > shot.s + PASS_BEHIND_M)
      ) {
        shot = next(tSec, distanceM);
      }
      return shot;
    },
    reset() {
      rand = rng(seed);
      shot = null;
      count = 0;
      lastDistanceM = null;
    },
  };
}
