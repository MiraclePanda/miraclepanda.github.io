// 観光地コースの名物の3D部品(LandscapeScene が使う)の振り分け。いまは竜宮城の海底(ryuguParts.js)だけ。
// 配置は tourLayout.js(純粋ロジック)が決め、ここでは形を作ってインスタンスとして置くだけ。

import { buildRyuguParts, placeRyuguObjects } from './ryuguParts.js';

/**
 * 観光地の部品(プール)を作って inner に加える。
 * 竜宮城の海底(ryuguParts.js)は、毎フレーム動かす物のプール animPools と animate(st, t) も返す。
 * @param {object} [opts] 竜宮城の海底用(ryuguParts.js の buildRyuguParts の opts)
 * @returns {{pools: object, glowMaterials: Array, textures: THREE.Texture[], animate?: Function}}
 */
export function buildTourParts(inner, L, waterColor, opts = {}) {
  if (L.tour.kind === 'ryugu') return buildRyuguParts(inner, L, opts);
  return { pools: {}, glowMaterials: [], textures: [] };
}

/**
 * tourLayout.js の配置物をプールへ置く(placeObjects から、組み直しのたびに呼ばれる)。
 * @param {object} st LandscapeScene の状態
 * @param {object} tour collectTourObjects の結果
 * @param {object} h { groundAt(s,d), local(s,d,height) → [x,y,z,道路の向き], blocked(s,d,r), floorM }
 */
export function placeTourObjects(st, tour, { groundAt, local, blocked }) {
  if (tour.ryugu) placeRyuguObjects(st, tour.ryugu, { groundAt, local, blocked });
}
