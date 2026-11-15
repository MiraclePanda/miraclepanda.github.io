// 描画品質の自動調整の決め方(純粋な計算。three.js を使わないので Node でテストできる)。
//
// 10 フレームごとのフレーム間隔の中央値で、
//   - 遅い(SLOW_FRAME_MS より長い)窓が DOWN_AFTER_WINDOWS 回続いたら下げる(1窓だけの遅れは、木の置き直し・
//     写真の読み込みなどの重なりのことが多いので下げない)。高のうちは先に画面の細かさ(画素の倍率)を 3/4 ずつ下げ、
//     等倍まで下げても遅ければ段階を1つ下げる。桁違いに遅い(VERY_SLOW_FRAME_MS)なら最低へ直行する。
//   - 速い(FAST_FRAME_MS より短い)窓が RAISE_AFTER_WINDOWS 回続いたら上げる。下げたときの逆順で、
//     まず画素の倍率をその段階の上限まで戻し、それから段階を1つ上げる(上げた段階は等倍から始める)。
//   - 上げてから FREEZE_WINDOWS 窓のうちにまた下げることになったら、その走行の間はもう上げない(上げ下げを繰り返して
//     画面がちらついたり、そのたびにシェーダーを組み直して止まったりしないように)。
//   - 下げたあと、次に上げてみるまで少なくとも HOLD_WINDOWS 窓(約 1 分)待ち、下げるたびに待ちを倍にする
//     (HOLD_MAX_DOUBLINGS 回まで)。軽い所(海沿い)で上げて重い所(森・町)で下げる、を数十秒おきに繰り返して、
//     そのたびにシェーダーの組み直しや木の置き直しで止まらないように。
// 一時的に重い区間(町なか)で下げても、軽い区間に戻れば(待ちのあと)元の画質に戻る。

export const SLOW_FRAME_MS = 45; // 約22fps未満が続いたら下げる
export const VERY_SLOW_FRAME_MS = 180; // ソフトウェアで描いている等
export const FAST_FRAME_MS = 22; // 60Hz の画面でほぼ毎回描けている
export const DOWN_AFTER_WINDOWS = 2; // 遅い窓がこれだけ続いたら下げる(約1秒)
export const RAISE_AFTER_WINDOWS = 6; // 速い窓がこれだけ続いたら上げる(約1秒)
export const FREEZE_WINDOWS = 30;
export const HOLD_WINDOWS = 300; // 下げてから上げてみるまでの最短の窓の数(10 フレームの窓 × 300 ≒ 30 fps で 100 秒、60 fps で 50 秒)
export const HOLD_MAX_DOUBLINGS = 3; // 待ちを倍にするのはここまで(最長 HOLD_WINDOWS × 8)
const PIXEL_STEP = 0.75;

/**
 * 自動調整の状態。
 * drops: この走行で下げた回数、sinceDown: 最後に下げてからの窓の数(上げてみるまでの待ちに使う)
 * @typedef {{index:number, pixelRatio:number, fastWindows:number, slowWindows:number, sinceUp:number, frozen:boolean,
 *   drops:number, sinceDown:number}} QualityState
 */

/** 段階 index・画素の倍率 pixelRatio から始める状態。 */
export function initialQualityState(index, pixelRatio) {
  return { index, pixelRatio, fastWindows: 0, slowWindows: 0, sinceUp: Infinity, frozen: false, drops: 0, sinceDown: Infinity };
}

/** drops 回下げたあと、次に上げてみるまでに待つ窓の数。 */
export function holdWindows(drops) {
  return drops > 0 ? HOLD_WINDOWS * 2 ** Math.min(drops - 1, HOLD_MAX_DOUBLINGS) : 0;
}

/**
 * 1つの窓(10 フレーム)の中央値から次の状態を決める。
 * @param {QualityState} st
 * @param {number} medianMs
 * @param {{lowest:number, maxRatio:(index:number)=>number}} lim
 *   lowest: 最低の段階の番号。maxRatio(index): その段階の画素の倍率の上限(端末の倍率で頭打ち)
 * @returns {QualityState} 新しい状態(段階・倍率が変わったかは呼び出し側で比べる)
 */
export function nextQualityState(st0, medianMs, { lowest, maxRatio }) {
  const st = { ...st0, sinceUp: st0.sinceUp + 1, drops: st0.drops ?? 0, sinceDown: (st0.sinceDown ?? Infinity) + 1 };
  const down = (index, pixelRatio) => ({
    index, pixelRatio, fastWindows: 0, slowWindows: 0, sinceUp: Infinity, frozen: st.frozen || st.sinceUp <= FREEZE_WINDOWS,
    drops: st.drops + 1, sinceDown: 0,
  });
  if (medianMs > VERY_SLOW_FRAME_MS && st.index < lowest) return down(lowest, maxRatio(lowest));
  if (medianMs > SLOW_FRAME_MS) {
    const slow = (st.slowWindows ?? 0) + 1;
    if (slow < DOWN_AFTER_WINDOWS) return { ...st, fastWindows: 0, slowWindows: slow };
    if (st.index === 0 && st.pixelRatio > 1.01) return down(0, Math.max(1, st.pixelRatio * PIXEL_STEP));
    if (st.index < lowest) return down(st.index + 1, maxRatio(st.index + 1));
    return { ...st, fastWindows: 0, slowWindows: 0 };
  }
  st.slowWindows = 0;
  if (medianMs >= FAST_FRAME_MS || st.frozen || st.sinceDown < holdWindows(st.drops)) return { ...st, fastWindows: 0 };
  const fast = st.fastWindows + 1;
  if (fast < RAISE_AFTER_WINDOWS) return { ...st, fastWindows: fast };
  const top = maxRatio(st.index);
  if (st.pixelRatio < top - 0.01) {
    return { ...st, pixelRatio: Math.min(top, st.pixelRatio / PIXEL_STEP), fastWindows: 0, sinceUp: 0 };
  }
  if (st.index > 0) {
    const index = st.index - 1;
    return { ...st, index, pixelRatio: Math.min(maxRatio(index), Math.max(1, st.pixelRatio)), fastWindows: 0, sinceUp: 0 };
  }
  return { ...st, fastWindows: 0 };
}
