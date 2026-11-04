// 端末ごとの表示の好み(localStorage)。旅の記録(tripStore)とは別に、この端末だけで覚える。

const RENDER_QUALITY_KEY = 'pce_render_quality_v1';
/** 走行画面の描画品質: 自動 / 最高 / 高 / 中 / 低(js/three/sceneKit.js の QUALITY_MODES と同じ並び)。 */
export const RENDER_QUALITY_VALUES = ['auto', 'ultra', 'high', 'medium', 'low'];

export function loadRenderQuality(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(RENDER_QUALITY_KEY);
    return RENDER_QUALITY_VALUES.includes(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function saveRenderQuality(value, storage = globalThis.localStorage) {
  if (!RENDER_QUALITY_VALUES.includes(value)) return;
  try {
    storage?.setItem(RENDER_QUALITY_KEY, value);
  } catch {
    // 保存できない環境(プライベートモード等)では、その回だけの選択になる
  }
}

const RIDE_MAP_KEY = 'pce_ride_map_v1';

/** 走行画面の地図を出すか(既定は出す)。 */
export function loadShowRideMap(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(RIDE_MAP_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveShowRideMap(show, storage = globalThis.localStorage) {
  try {
    storage?.setItem(RIDE_MAP_KEY, show ? 'on' : 'off');
  } catch {
    // 保存できない環境では、その回だけの選択になる
  }
}
