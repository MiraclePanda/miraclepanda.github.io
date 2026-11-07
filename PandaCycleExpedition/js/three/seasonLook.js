// 景色の季節の色(木・地面・遠くの山・航空写真・空)。季節そのもの(いつ・どこで何が起きるか)は
// js/trip/season.js、ここはその様子を色に直すだけ。Three.js に依存しない(Node のテストから読めるように)。

/** 16進の色 a と b を t(0..1)で混ぜる。 */
export function mixHex(a, b, t) {
  const k = Math.min(Math.max(t, 0), 1);
  const ch = (s) => Math.round(((a >> s) & 255) + (((b >> s) & 255) - ((a >> s) & 255)) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

const SUMMER_LEAVES = [0x3d6a2e, 0x4a7834, 0x35602a, 0x56803a];
const FRESH_LEAF = 0x8dbb4c;
const AUTUMN_LEAVES = [0xb8402a, 0xd2772a, 0xd9b03a, 0xa8552c];
const BARE_TWIGS = 0x7a6a58;
const SAKURA = 0xf3c4d2;
const SNOW = 0xf2f4f6;

/** 常緑の広葉樹(椎・樫・椿など)の割合。暖かい所ほど多い。 */
export function evergreenShare(latDeg, elevM) {
  return Math.min(Math.max(0.5 - (latDeg - 34) * 0.1 - Math.max(elevM, 0) / 1200, 0.05), 0.6);
}

/**
 * 広葉樹1本の見た目。r1〜r3 は木ごとの決まった乱数(0..1)。
 * @param {{sakura:number, fresh:number, turn:number, bare:number}} p plantPhase の戻り値
 * @param {{evergreen:boolean, sakuraTree:boolean}} kind
 * @returns {{color:number, scale:number}} scale: 葉の茂みの大きさの倍率(冬の裸の枝は小さく)
 */
export function broadleafLook(p, { evergreen, sakuraTree }, r1, r2) {
  const summer = SUMMER_LEAVES[Math.floor(r1 * 4) % 4];
  if (evergreen) return { color: mixHex(summer, 0x2c4a26, p.bare * 0.3), scale: 1 };
  let c = mixHex(summer, FRESH_LEAF, p.fresh * (0.55 + r2 * 0.3));
  // 色づきは木ごとに少しずれる(早い木・遅い木)
  c = mixHex(c, AUTUMN_LEAVES[Math.floor(r2 * 4) % 4], p.turn * (0.6 + r1 * 0.4));
  c = mixHex(c, BARE_TWIGS, p.bare);
  if (sakuraTree && p.sakura > 0) c = mixHex(c, SAKURA, Math.min(p.sakura * 1.4, 1));
  const leafless = sakuraTree ? Math.max(p.bare - p.sakura, 0) : p.bare;
  return { color: c, scale: 1 - leafless * 0.3 };
}

/** 杉・檜などの針葉樹(冬は少し赤茶ける)。 */
export function coniferColor(base, p) {
  return mixHex(base, 0x4f4a2c, p.bare * 0.3);
}

/**
 * 地面の植物の色を季節に寄せる。
 * @param {number} base 夏の色
 * @param {'field'|'forest'} kind field = 畑・草地、forest = 山の木々(上から見た森の色)
 */
export function vegetationColor(base, kind, p) {
  if (kind === 'field') {
    let c = mixHex(base, 0xa0b858, p.fresh * 0.4);
    c = mixHex(c, 0xb09a52, p.turn * 0.5); // 実った稲・枯れ始めの草
    return mixHex(c, 0x9a8c64, p.bare * 0.65); // 冬の枯れ草・刈田
  }
  let c = mixHex(base, 0x5f8a35, p.fresh * 0.4);
  c = mixHex(c, 0x7a5a2a, p.turn * 0.35);
  return mixHex(c, 0x585440, p.bare * 0.4);
}

/** 雪の積もり具合(0..1): 雪線から 150 m 上で真っ白。 */
export function snowCover(elevM, snowLineM) {
  return Number.isFinite(snowLineM) ? Math.min(Math.max((elevM - snowLineM) / 150, 0), 1) : 0;
}

/** 雪をかぶせた色。 */
export function withSnow(hex, cover) {
  return cover > 0 ? mixHex(hex, SNOW, cover) : hex;
}

/** 航空写真に掛ける色(写真は冬の撮影が多いので、葉のある季節は緑に、秋は黄みに寄せる)。 */
export function photoTint(p) {
  let c = mixHex(0xa4ad94, 0x9cb488, (1 - p.bare) * 0.7);
  c = mixHex(c, 0xb4a888, p.turn * 0.6);
  return c;
}
