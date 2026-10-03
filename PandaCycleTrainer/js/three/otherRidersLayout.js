// 他のライダー(ゴースト・集団)のうち、どれを描くかを決める純粋ロジック(Three.js 非依存。テスト対象)。
// 実際の描画(アバターのプール・半透明化・ラベル)は otherRiders.js。

// 自分の後ろ OTHERS_BEHIND_M 〜 前 OTHERS_AHEAD_M にいる人だけ描く
export const OTHERS_BEHIND_M = 40;
export const OTHERS_AHEAD_M = 300;
// 描く人数の上限(アバターのプールの大きさ)。品質「低」では集団を近い順に LOW_QUALITY_MAX_PACK 人まで
export const MAX_PACK = 5;
export const MAX_GHOSTS = 2;
export const LOW_QUALITY_MAX_PACK = 2;

/**
 * @param {Array<{id, kind:'ghost'|'pack', distanceM:number}>} others
 * @param {number} myDistanceM
 * @param {{maxPack?:number, maxGhosts?:number, behindM?:number}} [limits]
 *   behindM: 後方の描画範囲(m)。道路を後方まで作らないシーン(CityScene は 20m)はその範囲に抑える
 * @returns {{ghosts: Array<{other, gapM:number}>, pack: Array<{other, gapM:number}>}}
 *   gapM = other.distanceM − myDistanceM(前が正)。それぞれ近い順(|gapM| の小さい順)に上限まで。
 */
export function selectVisibleOthers(others, myDistanceM, { maxPack = MAX_PACK, maxGhosts = MAX_GHOSTS, behindM = OTHERS_BEHIND_M } = {}) {
  const behind = Math.min(OTHERS_BEHIND_M, Math.max(0, behindM));
  const ghosts = [];
  const pack = [];
  if (Array.isArray(others)) {
    for (const other of others) {
      if (!other || !Number.isFinite(other.distanceM)) continue;
      const gapM = other.distanceM - myDistanceM;
      if (gapM < -behind || gapM > OTHERS_AHEAD_M) continue;
      if (other.kind === 'ghost') ghosts.push({ other, gapM });
      else if (other.kind === 'pack') pack.push({ other, gapM });
    }
  }
  const byDistance = (a, b) => Math.abs(a.gapM) - Math.abs(b.gapM);
  ghosts.sort(byDistance);
  pack.sort(byDistance);
  return { ghosts: ghosts.slice(0, Math.max(0, maxGhosts)), pack: pack.slice(0, Math.max(0, maxPack)) };
}

/** ゴーストの頭上ラベルの文言。記録が終わったゴーストは「記録終了」を併記する。 */
export function ghostLabelText(other) {
  const name = other.label ? String(other.label) : 'ゴースト';
  return other.finished ? `${name}(記録終了)` : name;
}
