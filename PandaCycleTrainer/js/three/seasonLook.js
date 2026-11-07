// 景色の季節の色(木・地面・雪・空)。季節そのもの(いつ・どこで何が起きるか)は season.js、
// ここはその様子を色に直すだけ。Three.js に依存しない(test/unit から読める)。
// season が null(竜宮城の海底など、季節の無い景色)なら、どの関数も元の色をそのまま返す。

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
export const SNOW = 0xf2f4f6;

/** 常緑の広葉樹(椎・樫・椿など)の割合。暖かい所ほど多い。 */
export function evergreenShare(latDeg, elevM) {
  return Math.min(Math.max(0.5 - (latDeg - 34) * 0.1 - Math.max(elevM, 0) / 1200, 0.05), 0.6);
}

/** 葉の色として緑っぽいか(紅葉の色を夏の色にそろえるのに使う)。 */
function isGreenish(hex) {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  return g > r * 1.05;
}

/**
 * 広葉樹1本の見た目。r1〜r3 は木ごとの決まった乱数(0..1)。
 * @param {{sakura:number, fresh:number, turn:number, bare:number}} p plantPhase の戻り値
 * @param {{evergreen:boolean, sakuraTree:boolean, summer?:number}} kind summer: 夏の葉の色(景色ごとの色)
 * @returns {{color:number, scale:number}} scale: 葉の茂みの大きさの倍率(冬の裸の枝は小さく)
 */
export function broadleafLook(p, { evergreen, sakuraTree, summer }, r1, r2) {
  const base = summer !== undefined && isGreenish(summer) ? summer : SUMMER_LEAVES[Math.floor(r1 * 4) % 4];
  if (evergreen) return { color: mixHex(base, 0x2c4a26, p.bare * 0.3), scale: 1 };
  let c = mixHex(base, FRESH_LEAF, p.fresh * (0.55 + r2 * 0.3));
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
 * 木1本の季節の色。season が null なら baseHex のまま。
 * @param {object|null} season season.js の createSeason の戻り値
 * @param {number} baseHex 景色が決めている(夏の)色
 * @param {number} h 景色の中の高さ(m)
 * @param {number} r1 木ごとの決まった乱数(0..1)。r2・r3 はそこから作る
 * @param {{conifer?:boolean, sakura?:number, evergreen?:number}} [o]
 *   sakura: 落葉樹のうち桜の割合、evergreen: 常緑樹の割合(省略時は緯度・標高から)
 * @returns {{color:number, scale:number}}
 */
export function seasonalTree(season, baseHex, h, r1, { conifer = false, sakura = 0, evergreen } = {}) {
  if (!season) return { color: baseHex, scale: 1 };
  const p = season.plants(h);
  const snow = season.snowAt(h) * 0.55;
  if (conifer) return { color: mixHex(coniferColor(baseHex, p), SNOW, snow), scale: 1 };
  const r2 = frac(r1 * 7.31 + 0.17);
  const r3 = frac(r1 * 13.77 + 0.53);
  const ev = r3 < (evergreen ?? evergreenShare(season.latDeg, h + season.elevM));
  const sakuraTree = !ev && frac(r1 * 29.3 + 0.71) < sakura;
  const look = broadleafLook(p, { evergreen: ev, sakuraTree, summer: baseHex }, r1, r2);
  return { color: mixHex(look.color, SNOW, snow * (1 - look.scale * 0.5)), scale: look.scale };
}

const frac = (x) => x - Math.floor(x);

/**
 * 地面の植物の色を季節に寄せる。
 * @param {number} base 夏の色
 * @param {'field'|'forest'} kind field = 畑・草地・芝生、forest = 山の木々(上から見た森の色)
 */
export function vegetationColor(base, kind, p) {
  if (kind === 'field') {
    let c = mixHex(base, 0xa0b858, p.fresh * 0.4);
    c = mixHex(c, 0xb09a52, p.turn * 0.5); // 実った稲・枯れ始めの草
    return mixHex(c, 0xa39468, p.bare * 0.8); // 冬の枯れ草・刈田
  }
  let c = mixHex(base, 0x5f8a35, p.fresh * 0.4);
  c = mixHex(c, 0x7a5a2a, p.turn * 0.35);
  return mixHex(c, 0x585440, p.bare * 0.4);
}

const toHex = ([r, g, b]) => (Math.round(clamp01(r) * 255) << 16) | (Math.round(clamp01(g) * 255) << 8) | Math.round(clamp01(b) * 255);
const fromHex = (c) => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/**
 * 地面の色(sRGB 0..1 の [r, g, b])を季節に寄せる。season が null なら rgb のまま。
 * @param {number} veg 植物の割合(0 = 岩・舗装・砂浜、1 = 草地・森)
 * @param {number} forest そのうち森の割合(0 = 草地・畑、1 = 森)
 * @param {number} [snowMul] 雪の積もりやすさ(急な崖は小さく)
 */
export function seasonalGround(season, rgb, h, veg, forest, snowMul = 1) {
  if (!season) return rgb;
  let c = toHex(rgb);
  if (veg > 0) {
    const p = season.plants(h);
    const field = vegetationColor(c, 'field', p);
    const wood = vegetationColor(c, 'forest', p);
    c = mixHex(c, mixHex(field, wood, forest), veg);
  }
  const snow = season.snowAt(h) * snowMul;
  if (snow > 0) c = mixHex(c, SNOW, snow);
  return fromHex(c);
}

/**
 * 写真(国土地理院の空中写真。撮影の季節はまちまち)に掛ける色の倍率 [r, g, b](1 前後)。
 * 葉のある季節は緑に、秋は黄みに寄せる。season が null なら [1, 1, 1]。
 */
export function photoTintMul(season, h = 0) {
  if (!season) return [1, 1, 1];
  const p = season.plants(h);
  const base = 0xa4ad94;
  let c = mixHex(base, 0x9cb488, (1 - p.bare) * 0.7);
  c = mixHex(c, 0xb4a888, p.turn * 0.6);
  const b = fromHex(base);
  return fromHex(c).map((v, i) => v / b[i]);
}

/**
 * 空の色・霞を季節に寄せる(冬は澄んで青が深く、春・夏は霞んで地平が白っぽい)。
 * @returns {{zenith:(c:string)=>string, horizon:(c:string)=>string, fogMul:number}}
 */
export function seasonalSky(season) {
  if (!season) return { zenith: (c) => c, horizon: (c) => c, fogMul: 1 };
  const { haze, clear, humid } = season.sky;
  const hex = (s) => parseInt(s.slice(1), 16);
  const str = (n) => `#${n.toString(16).padStart(6, '0')}`;
  return {
    zenith: (c) => str(mixHex(hex(c), 0x2a62b5, clear * 0.3)),
    horizon: (c) => str(mixHex(hex(c), 0xe4eaee, humid * 0.3)),
    fogMul: haze,
  };
}
