// 観光地コースの景色(LANDSCAPES の tour を持つ景色)に対する地形の起伏・色と、名物の配置の振り分け。
// 純粋関数(Three.js 非依存。テスト対象)。いまの tour は竜宮城の海底(ryugu)だけで、中身は
// ryuguLayout.js(形と描画は ryuguParts.js)。京都・奈良・河口湖は実在の街(RealTownScene)に
// 作り直したので、作り物の町並み(京町家・鹿・遊覧船など)は削除した(レビュー Q7)。
//
// 座標系は landscapeLayout.js と同じ(s = 絶対距離、d = 道路中心からの横距離。負 = 左)。
// 名所の並びは1周(tour.loopM)ごとに繰り返し、同じ地点は何度通っても同じ景色になる。
//
// いずれも見た目だけで、物理・勾配・トレーナーへの指示には影響しない。

import { ryuguTerrainHeight, ryuguTerrainColor, collectRyuguObjects } from './ryuguLayout.js';

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** 1周の中での位置(0〜loopM)。 */
export function loopPos(L, s) {
  const m = L.tour.loopM;
  return ((s % m) + m) % m;
}

/** 1周の中の地点 atM のうち、s に一番近いものまでの符号付き距離(s − 地点)。 */
export function toNearestM(L, s, atM) {
  const m = L.tour.loopM;
  const r = (((s - atM) % m) + m) % m;
  return r > m / 2 ? r - m : r;
}

/** (s, d) の地形の絶対標高(路肩外縁からの距離 u は landscapeLayout が計算済み)。 */
export function tourTerrainHeight(L, d, s, u, roadElevM) {
  if (L.tour.kind === 'ryugu') return ryuguTerrainHeight(L, d, s, u, roadElevM);
  return roadElevM;
}

/** 地形の色(sRGB 0..1)。 */
export function tourTerrainColor(L, d, s, h, floorM, normalY) {
  if (L.tour.kind === 'ryugu') return ryuguTerrainColor(L, d, s, normalY).map(clamp01);
  return [0.4, 0.5, 0.3];
}

/** ふつうの木を (s, d) に植えてよいか。 */
export function tourTreeAllowed() {
  return true;
}

/**
 * [fromM, toM) の範囲(遠くに見える物は farToM まで)の名物を返す。trees / houses は
 * landscapeLayout のふつうの木・家と同じ形(同じプールで描く)。
 * - ryugu: 竜宮城の海底の配置物(ryuguLayout.js の collectRyuguObjects。ほかの景色では null)
 */
export function collectTourObjects(L, fromM, toM, farToM = toM) {
  const out = { trees: [], houses: [], ryugu: null };
  if (L.tour.kind === 'ryugu') out.ryugu = collectRyuguObjects(L, fromM, toM, farToM);
  return out;
}
