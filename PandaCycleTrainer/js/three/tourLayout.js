// 観光地コース(京都・東山/奈良公園/河口湖)の景色の手続き型生成。landscapeLayout.js の
// 景色(LANDSCAPES.kyoto / nara / kawaguchiko の tour)に対する地形の起伏・色と、町並み・名物の配置を
// 決める純粋関数(Three.js 非依存。テスト対象)。3D の形と描画は tourParts.js。
//
// 座標系は landscapeLayout.js と同じ(s = 絶対距離、d = 道路中心からの横距離。負 = 左)。
// 名所の並びは1周(tour.loopM)ごとに繰り返し、同じ地点は何度通っても同じ景色になる。
// 大きな名所の建物(三門・大仏殿・清水の舞台など)はここではなく、コースプロファイルの landmarks
// (happeningsLayout.js → roadsideActors.js / sightModels.js)。ここはそのまわりの町並み・公園・池など。
//
// いずれも見た目だけで、物理・勾配・トレーナーへの指示には影響しない。

import {
  roadEdgeM, fbm, valueNoise, smoothstep, ridged, cellRand, forEachCell, CONIFER_COLORS,
} from './landscapeLayout.js';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
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

/** 1周の中の区間 [fromM, toM) に s が入っているか。 */
export function inSpan(L, s, span) {
  if (!span) return false;
  const p = loopPos(L, s);
  return p >= span.fromM && p < span.toM;
}

/** 区間の端で 0→1 に滑らかに立ち上がる重み(区間の外は 0)。 */
function spanWeight(L, s, span, rampM) {
  if (!span) return 0;
  const p = loopPos(L, s);
  return smoothstep(span.fromM, span.fromM + rampM, p) * smoothstep(span.toM, span.toM - rampM, p);
}

// 秋の京都・奈良の木(緑に紅葉・黄葉を混ぜる)
export const AUTUMN_COLORS = [0xc8361d, 0xd9541e, 0xe08a1c, 0xb02a1a, 0xd8b02a];
const GREEN_COLORS = [0x4a6b2f, 0x3f5f2a, 0x56793a, 0x34552a, 0x5c7a34];
// 京町家の外壁の色味(木部・漆喰の頂点カラーに乗算される)と、奥の家並みの壁・屋根
export const MACHIYA_TINTS = [0xffffff, 0xece4d8, 0xd8cfc0, 0xc4b8a6, 0xfff6ea, 0xb5a998];
const KYOTO_WALLS = [0xd9cdb2, 0x5a4232, 0xe6dccb, 0x4a3526, 0xcfc2a6];
const KYOTO_ROOFS = [0x3a3c40, 0x44464a, 0x35373a, 0x4a4b4e];
const STONE_TINTS = [0xffffff, 0xe8ece0, 0xd8dccb, 0xf2efe6];
const LANTERN_RED = 0xd8321e;
const LANTERN_WHITE = 0xf3ead2;

function treeColor(rand, autumnRatio) {
  return rand() < autumnRatio
    ? AUTUMN_COLORS[Math.floor(rand() * AUTUMN_COLORS.length)]
    : GREEN_COLORS[Math.floor(rand() * GREEN_COLORS.length)];
}

// ---- 地形 ----

/** (s, d) の地形の絶対標高(路肩外縁からの距離 u は landscapeLayout が計算済み)。 */
export function tourTerrainHeight(L, d, s, u, roadElevM, floorM) {
  if (L.tour.kind === 'kyoto') return kyotoHeight(L, d, s, u, roadElevM);
  if (L.tour.kind === 'nara') return naraHeight(L, d, s, u, roadElevM);
  return roadElevM;
}

/** 地形の色(sRGB 0..1)。 */
export function tourTerrainColor(L, d, s, h, floorM, normalY) {
  const u = Math.abs(d) - roadEdgeM(L);
  if (L.tour.kind === 'kyoto') return kyotoColor(L, d, s, u, normalY).map(clamp01);
  if (L.tour.kind === 'nara') return naraColor(L, d, s, u, normalY).map(clamp01);
  return [0.4, 0.5, 0.3];
}

// ---- 京都・東山 ----

/** 東山の山裾の始まり(路肩外縁から)。清水寺のあたりだけ道路のすぐ近くまで山が迫る。 */
export function kyotoHillStartU(L, s) {
  const H = L.tour.hill;
  const near = Math.exp(-((toNearestM(L, s, H.nearAtM) / H.nearHalfM) ** 2) * 2.2);
  return lerp(H.baseU, H.nearU, near);
}

/** 祇園白川(左の小川)の重み(0〜1)。端は30mかけて浅くなる。 */
export function kyotoCanalWeight(L, s) {
  return spanWeight(L, s, L.tour.canal, 30);
}

function kyotoHeight(L, d, s, u, roadE) {
  const T = L.tour;
  const seed = L.seed;
  if (u <= T.sidewalkM) return roadE + 0.12;
  if (d < 0) {
    const w = kyotoCanalWeight(L, s);
    if (w > 0 && u >= T.canal.fromU && u <= T.canal.toU) return roadE + 0.12 - 2.0 * w;
    // 盆地(西): 町並みが市街地へゆるく下り、遠くに西山。五条坂の眺めの所は斜面で下の町を見下ろす
    const vista = spanWeight(L, s, T.vista, 60) * Math.min(26, 0.32 * Math.max(0, u - 8));
    const down = Math.max(vista, Math.min(25, 0.012 * Math.max(0, u - 150)));
    const W = T.westHills;
    const west = W.heightM * smoothstep(W.startU, W.startU + 900, u) * (0.5 + 0.7 * fbm(s / 900, u / 900, seed + 13, 4));
    return roadE + 0.15 - down + west;
  }
  // 東: 町並み → 東山
  const town = roadE + 0.15 + 0.02 * Math.max(0, u - 15);
  const hu = u - kyotoHillStartU(L, s);
  if (hu <= 0) return town;
  const H = T.hill;
  const rise = H.riseSlope * Math.min(hu, 600) + 0.08 * Math.max(0, hu - 600);
  const hills = H.hillAmpM * fbm(s / 380, hu / 380, seed + 41, 5) * smoothstep(0, 120, hu);
  const ridge = H.ridgeM * smoothstep(250, 1400, hu) * (0.5 + 0.6 * ridged(s / 800, hu / 800, seed + 43));
  return town + rise * smoothstep(0, 25, hu) + hills + ridge;
}

/** 紅葉の山肌(緑の森に赤・橙・黄のまだら)。 */
function autumnForest(L, s, d, amount) {
  const seed = L.seed;
  const patch = fbm(s / 230, d / 230, seed + 71, 3);
  const hue = valueNoise(s / 140, d / 140, seed + 73);
  const autumn = smoothstep(0.6 - amount, 0.8 - amount, patch) * 0.75;
  const green = [0.2, 0.31, 0.16];
  const color = hue < 0.4 ? [0.55, 0.22, 0.12] : hue < 0.75 ? [0.62, 0.4, 0.15] : [0.64, 0.56, 0.22];
  return green.map((c, i) => lerp(c, color[i], autumn));
}

function kyotoColor(L, d, s, u, normalY) {
  const T = L.tour;
  const seed = L.seed;
  const fine = (valueNoise(s / 7, d / 7, seed + 63) - 0.5) * 0.06;
  if (u <= T.sidewalkM + 0.3) return [0.6 + fine, 0.58 + fine, 0.54 + fine]; // 石畳の歩道
  if (d < 0 && kyotoCanalWeight(L, s) > 0.05 && u <= T.canal.toU + 0.4) return [0.42 + fine, 0.41 + fine, 0.38 + fine]; // 白川の石垣
  const avenue = inSpan(L, s, T.avenue) && u < 40;
  const park = d > 0 && inSpan(L, s, T.park) && u < 160;
  if (d < 0 && inSpan(L, s, T.vista) && u < 100) {
    // 五条坂の眺め: 道端の砂利と、町へ下る紅葉の斜面
    const slope = autumnForest(L, s, d, 0.15);
    const g = smoothstep(3, 6, u);
    return [lerp(0.6, slope[0], g) + fine, lerp(0.57, slope[1], g) + fine, lerp(0.5, slope[2], g) + fine];
  }
  if (avenue || park) {
    // 並木道・公園: 砂利と芝生
    const lawn = smoothstep(4, 8, u);
    return [lerp(0.62, 0.42, lawn) + fine, lerp(0.6, 0.53, lawn) + fine, lerp(0.54, 0.26, lawn) + fine];
  }
  let rgb;
  // 町並みの地面: 通りの近く(路地・空き地・名所の境内)は土と砂利、奥は瓦屋根の色
  const ground = [0.55 + fine, 0.52 + fine, 0.46 + fine];
  // 瓦・トタン・ビルの屋上がまだらに混じる(遠くから見ても水面に見えないよう、明るさにむらをつける)
  const block = valueNoise(s / 16, d / 16, seed + 91);
  const tile = (block < 0.3 ? [0.31, 0.31, 0.33] : block < 0.6 ? [0.43, 0.43, 0.44] : block < 0.82 ? [0.52, 0.48, 0.42] : [0.66, 0.64, 0.6]).map((c) => c + fine);
  const roofs = ground.map((c, i) => lerp(c, tile[i], smoothstep(T.rowDepthM + 4, T.rowDepthM + 20, u)));
  if (d > 0) {
    const hu = u - kyotoHillStartU(L, s);
    const forest = autumnForest(L, s, d, 0.12);
    rgb = roofs.map((c, i) => lerp(c, forest[i], smoothstep(-10, 15, hu)));
  } else {
    // 瓦屋根の海に、庭や寺の緑が点々と。遠くの西山は森
    const garden = smoothstep(0.56, 0.66, fbm(s / 120, d / 120, seed + 81, 3));
    const town = roofs.map((c, i) => lerp(c, [0.24, 0.34, 0.2][i], garden * 0.7));
    const hills = autumnForest(L, s, d, 0.05);
    rgb = town.map((c, i) => lerp(c, hills[i], smoothstep(T.westHills.startU, T.westHills.startU + 400, u)));
  }
  const rock = smoothstep(0.6, 0.42, normalY);
  return rgb.map((c, i) => lerp(c, [0.46, 0.44, 0.4][i], rock));
}

// ---- 奈良公園 ----

/** 池の中心からの正規化距離(1 = 池の縁)。池が無ければ Infinity。左側(d < 0)だけ。 */
export function naraPondR(L, d, s) {
  if (d >= 0) return Infinity;
  const u = -d - roadEdgeM(L);
  let best = Infinity;
  for (const p of L.tour.ponds) {
    const a = toNearestM(L, s, p.atM) / p.rAlongM;
    const b = (u - p.u) / p.rLatM;
    best = Math.min(best, Math.hypot(a, b));
  }
  return best;
}

/** 若草山の重み(0〜1、山の芝生の範囲)。右側だけ。 */
export function wakakusaWeight(L, d, s) {
  if (d <= 0) return 0;
  const W = L.tour.wakakusa;
  const u = d - roadEdgeM(L);
  const r = Math.hypot(toNearestM(L, s, W.atM) / W.rAlongM, (u - W.u) / W.rLatM);
  return smoothstep(1.0, 0.8, r);
}

function naraHeight(L, d, s, u, roadE) {
  const T = L.tour;
  const seed = L.seed;
  // 芝生のゆるい起伏(道路際は平ら)
  let h = roadE + 0.1 + (fbm(s / 160, u / 160, seed + 5, 3) - 0.5) * 3 * smoothstep(5, 40, u);
  if (d > 0) {
    const fu = u - T.forestU;
    if (fu > 0) {
      h += 0.28 * Math.min(fu, 900) + 0.06 * Math.max(0, fu - 900)
        + 110 * fbm(s / 420, fu / 420, seed + 41, 5) * smoothstep(0, 200, fu)
        + 170 * smoothstep(400, 1600, fu) * (0.5 + 0.6 * ridged(s / 800, fu / 800, seed + 43));
    }
    // 若草山: 三段に重なる、木の無いなだらかな山
    const W = T.wakakusa;
    const a = toNearestM(L, s, W.atM) / W.rAlongM;
    const b = (u - W.u) / W.rLatM;
    const r2 = a * a + b * b;
    if (r2 < 4) {
      const dome = Math.exp(-r2 * 1.5);
      const tiers = dome + 0.05 * Math.sin(dome * Math.PI * 3);
      h = Math.max(h, roadE + 0.1 + W.hM * tiers);
    }
    return h;
  }
  // 池(水面は roadE − 1.3 付近。tourParts.js が水面を描く)
  const r = naraPondR(L, d, s);
  if (r < 1.2) h = lerp(roadE - 3.2, h, smoothstep(0.9, 1.2, r));
  // 西: 奈良の町並みがゆるく下り、遠くに生駒の山並み
  const tu = u - T.townU;
  if (tu > 0) h -= Math.min(12, 0.01 * tu);
  h += 300 * smoothstep(2600, 3400, u) * (0.5 + 0.6 * fbm(s / 900, u / 900, seed + 13, 4));
  return h;
}

function naraColor(L, d, s, u, normalY) {
  const T = L.tour;
  const seed = L.seed;
  const fine = (valueNoise(s / 11, d / 11, seed + 63) - 0.5) * 0.07;
  // 芝生(鹿に食まれた所は薄茶色)
  const worn = smoothstep(0.5, 0.7, fbm(s / 70, d / 70, seed + 61, 3)) * 0.6;
  let rgb = [lerp(0.43, 0.58, worn) + fine, lerp(0.56, 0.52, worn) + fine, lerp(0.25, 0.33, worn) + fine * 0.5];
  if (d > 0) {
    const forest = autumnForest(L, s, d, 0.02).map((c) => c * 0.9);
    rgb = rgb.map((c, i) => lerp(c, forest[i], smoothstep(T.forestU - 20, T.forestU + 40, u)));
    const grass = [0.62 + fine, 0.6 + fine, 0.32]; // 秋の若草山(黄みがかった芝)
    rgb = rgb.map((c, i) => lerp(c, grass[i], wakakusaWeight(L, d, s)));
  } else {
    const r = naraPondR(L, d, s);
    if (r < 1.12) rgb = [0.42 + fine, 0.38 + fine, 0.28]; // 池の岸と底
    const roofs = [0.4 + fine, 0.4 + fine, 0.41 + fine];
    rgb = rgb.map((c, i) => lerp(c, roofs[i], smoothstep(T.townU, T.townU + 80, u) * 0.85));
    const hills = autumnForest(L, s, d, 0);
    rgb = rgb.map((c, i) => lerp(c, hills[i], smoothstep(2500, 2900, u)));
  }
  const rock = smoothstep(0.62, 0.45, normalY);
  return rgb.map((c, i) => lerp(c, [0.46, 0.44, 0.38][i], rock));
}

// ---- 配置物 ----

/**
 * その地点に木を置いてよいか(landscapeLayout のふつうの木・遠景の森にも使う)。
 * 奈良: 若草山(芝の山)と池の中には置かない。京都: 白川の流れの中には置かない。
 */
export function tourTreeAllowed(L, s, d) {
  if (L.tour.kind === 'nara') return wakakusaWeight(L, d, s) < 0.15 && naraPondR(L, d, s) > 1.15;
  if (L.tour.kind === 'kyoto') {
    const u = Math.abs(d) - roadEdgeM(L);
    return !(d < 0 && kyotoCanalWeight(L, s) > 0 && u <= L.tour.canal.toU + 0.5);
  }
  return true;
}

/**
 * [fromM, toM) の範囲(遠くに見える物は farToM まで)の町並み・名物を返す。trees / houses は
 * landscapeLayout のふつうの木・家と同じ形(同じプールで描く)。ほかは tourParts.js が描く:
 * - machiya: 通り沿いの京町家 { s, d(正面の横位置), widthM, depthM, heightScale, variant, tint }
 * - lanterns: 軒先の提灯 { s, d, color }
 * - stoneLanterns: 石灯籠 { s, d, yaw }
 * - willows: 柳 { s, d, scale }
 * - deer: 鹿 { s, d, yaw, pose: 'stand'|'graze', scale }
 * - ponds: 池の水面 { s, d, rAlongM, rLatM }(楕円の中心)
 * - canal: 小川の水面の区間 { fromS, toS, dIn, dOut }
 * - towers: 京都タワー { s, d }
 * - steamers: 遊覧船 { s, d }
 * - bridges: 湖を渡る橋 { s, dFrom, dTo }
 */
export function collectTourObjects(L, fromM, toM, farToM = toM) {
  const out = {
    trees: [], houses: [], machiya: [], lanterns: [], stoneLanterns: [], willows: [], deer: [],
    ponds: [], canal: [], towers: [], steamers: [], bridges: [],
  };
  if (L.tour.kind === 'kyoto') collectKyoto(L, fromM, toM, farToM, out);
  else if (L.tour.kind === 'nara') collectNara(L, fromM, toM, farToM, out);
  else if (L.tour.kind === 'kawaguchiko') collectKawaguchiko(L, fromM, toM, farToM, out);
  return out;
}

/** 1周に1回の地点 atM のうち、[from, to) に入るものの絶対距離を列挙する。 */
function occurrences(L, atM, from, to) {
  const m = L.tour.loopM;
  const list = [];
  for (let k = Math.floor((from - atM) / m); k * m + atM < to; k++) {
    const s = k * m + atM;
    if (s >= from) list.push(s);
  }
  return list;
}

// 京町家の間口の区切り(m)。家ごとの間口はこの幅から少しだけ狭める
const MACHIYA_CELL_M = 7.2;

function collectKyoto(L, fromM, toM, farToM, out) {
  const T = L.tour;
  const edge = roadEdgeM(L);
  const inRange = (s) => s >= fromM && s < toM;

  // 通り沿いの京町家(両側。並木道・公園・白川の内側は除く)
  for (const side of [-1, 1]) {
    forEachCell(fromM, toM, MACHIYA_CELL_M, (i, cellS) => {
      const rand = cellRand(L, side < 0 ? 40 : 41, i);
      const s = cellS + MACHIYA_CELL_M / 2;
      if (!inRange(s) || inSpan(L, s, T.avenue)) return;
      if (side > 0 && inSpan(L, s, T.park)) return;
      if (side < 0 && inSpan(L, s, T.vista)) return;
      const canal = side < 0 && kyotoCanalWeight(L, s) > 0;
      const frontU = canal ? T.canal.toU + 2.6 : T.sidewalkM + 0.3;
      if (side > 0 && frontU + T.rowDepthM > kyotoHillStartU(L, s) + 25) return; // 山の斜面の上には建てない
      if (rand() < 0.06) return; // ところどころ路地・駐車場
      const widthM = MACHIYA_CELL_M - 0.15 - rand() * 0.5;
      const variant = rand() < 0.45 ? 1 : 0; // 1 = 暖簾の店、0 = 格子戸の住まい
      out.machiya.push({
        s, d: side * (edge + frontU), side, widthM, depthM: T.rowDepthM * (0.9 + rand() * 0.2),
        heightScale: 0.92 + rand() * 0.16, variant, tint: MACHIYA_TINTS[Math.floor(rand() * MACHIYA_TINTS.length)],
      });
      // 店先の提灯(左右一対。お茶屋・料理屋は赤、ほかは白)
      if (rand() < (variant === 1 ? 0.7 : 0.25)) {
        const color = rand() < 0.6 ? LANTERN_RED : LANTERN_WHITE;
        for (const o of [-0.28, 0.28]) out.lanterns.push({ s: s + o * widthM, d: side * (edge + frontU - 0.55), color });
      }
    });
  }

  // 町並みの奥の家々(瓦屋根の家並み。ふつうの家のプールで描く)
  for (const side of [-1, 1]) {
    forEachCell(fromM, toM, 12, (i, cellS) => {
      const rand = cellRand(L, side < 0 ? 42 : 43, i);
      for (let k = 0; k < 3; k++) {
        const s = cellS + rand() * 12;
        const u = T.rowDepthM + 6 + rand() * 110;
        const widthM = 7 + rand() * 5;
        const house = {
          s, d: side * (edge + u), widthM, depthM: 7 + rand() * 4, heightM: 3 + (rand() < 0.6 ? 2.8 : 0),
          yaw: (rand() - 0.5) * 0.1, wall: KYOTO_WALLS[Math.floor(rand() * KYOTO_WALLS.length)],
          roof: KYOTO_ROOFS[Math.floor(rand() * KYOTO_ROOFS.length)],
        };
        if (!inRange(s)) continue;
        if (side > 0 && u > kyotoHillStartU(L, s) - 4) continue;
        if (side > 0 && inSpan(L, s, T.park) && u < 160) continue;
        if (inSpan(L, s, T.avenue) && u < 40) continue;
        if (side < 0 && inSpan(L, s, T.vista) && u < 90) continue;
        out.houses.push(house);
      }
    });
  }

  // 五条坂の眺めの下に広がる町(家を多めに)
  forEachCell(fromM, toM, 10, (i, cellS) => {
    const rand = cellRand(L, 48, i);
    for (let k = 0; k < 3; k++) {
      const s = cellS + rand() * 10;
      const u = 95 + rand() * 260;
      const house = {
        s, d: -(edge + u), widthM: 8 + rand() * 6, depthM: 7 + rand() * 5, heightM: 3 + (rand() < 0.6 ? 2.8 : 0) + (rand() < 0.15 ? 9 : 0),
        yaw: (rand() - 0.5) * 0.1, wall: KYOTO_WALLS[Math.floor(rand() * KYOTO_WALLS.length)],
        roof: KYOTO_ROOFS[Math.floor(rand() * KYOTO_ROOFS.length)],
      };
      if (inRange(s) && inSpan(L, s, T.vista)) out.houses.push(house);
    }
  });

  // 神宮道の並木(両側)と円山公園の木立ち(右)
  forEachCell(fromM, toM, 9, (i, cellS) => {
    const rand = cellRand(L, 44, i);
    const s = cellS + 4.5;
    if (!inRange(s)) return;
    if (inSpan(L, s, T.avenue)) {
      for (const side of [-1, 1]) {
        out.trees.push({ s: s + (rand() - 0.5) * 2, d: side * (edge + 3.2), kind: 'broadleaf', scale: 1.05 + rand() * 0.3, color: treeColor(rand, 0.6), seed: Math.floor(rand() * 1e9) });
      }
    }
    if (inSpan(L, s, T.park)) {
      for (let k = 0; k < 3; k++) {
        const u = 4 + rand() * 150;
        out.trees.push({ s: s + (rand() - 0.5) * 9, d: edge + u, kind: rand() < 0.2 ? 'conifer' : 'broadleaf', scale: 1 + rand() * 0.6, color: treeColor(rand, 0.55), seed: Math.floor(rand() * 1e9) });
      }
    }
  });

  // 五条坂の眺めの斜面の木(まばらに。町と京都タワーの眺めをふさがない)
  forEachCell(fromM, toM, 14, (i, cellS) => {
    const rand = cellRand(L, 47, i);
    const s = cellS + rand() * 14;
    const u = 12 + rand() * 70;
    const tree = { s, d: -(edge + u), kind: 'broadleaf', scale: 0.8 + rand() * 0.4, color: treeColor(rand, 0.7), seed: Math.floor(rand() * 1e9) };
    if (inRange(s) && inSpan(L, s, T.vista)) out.trees.push(tree);
  });

  // 東山の斜面の木(近景。遠景の森は landscapeLayout の farTrees)
  forEachCell(fromM, toM, 8, (i, cellS) => {
    const rand = cellRand(L, 45, i);
    for (let k = 0; k < 3; k++) {
      const s = cellS + rand() * 8;
      const u = kyotoHillStartU(L, s) + 2 + Math.pow(rand(), 0.8) * 220;
      const conifer = rand() < 0.35;
      const tree = { s, d: edge + u, kind: conifer ? 'conifer' : 'broadleaf', scale: 0.9 + rand() * 0.6, color: conifer ? CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)] : treeColor(rand, 0.5), seed: Math.floor(rand() * 1e9) };
      if (inRange(s)) out.trees.push(tree);
    }
  });

  // 祇園白川: 小川の水面と、対岸(町家の前)の柳並木
  const c = T.canal;
  let canalFrom = null;
  let canalTo = null;
  for (let s = Math.ceil(fromM / 4) * 4; s < toM; s += 4) {
    if (kyotoCanalWeight(L, s) <= 0.6) continue;
    canalFrom ??= s;
    canalTo = s + 4;
  }
  if (canalFrom !== null) out.canal.push({ fromS: canalFrom, toS: canalTo, dIn: -(edge + c.fromU), dOut: -(edge + c.toU) });
  forEachCell(fromM, toM, 10, (i, cellS) => {
    const rand = cellRand(L, 46, i);
    const s = cellS + 5;
    if (inRange(s) && kyotoCanalWeight(L, s) > 0.8) out.willows.push({ s, d: -(edge + c.toU + 1.1), scale: 0.85 + rand() * 0.3 });
  });

  // 京都タワー(西の盆地の向こう。遠くから見えるよう広い範囲で拾う)
  for (const s of occurrences(L, T.tower.atM, fromM - 3000, farToM + 3000)) out.towers.push({ s, d: T.tower.d });
}

function collectNara(L, fromM, toM, farToM, out) {
  const T = L.tour;
  const edge = roadEdgeM(L);
  const inRange = (s) => s >= fromM && s < toM;
  const inPond = (s, d, margin = 1.1) => naraPondR(L, d, s) < margin;

  // 池の水面と、猿沢池のほとりの柳
  for (const p of T.ponds) {
    for (const s of occurrences(L, p.atM, fromM - p.rAlongM, farToM + p.rAlongM)) {
      out.ponds.push({ s, d: -(edge + p.u), rAlongM: p.rAlongM, rLatM: p.rLatM });
      if (!p.willows) continue;
      const n = 22;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const ws = s + Math.sin(a) * (p.rAlongM + 4);
        const wu = p.u + Math.cos(a) * (p.rLatM + 4);
        if (wu < 2 || !inRange(ws)) continue;
        out.willows.push({ s: ws, d: -(edge + wu), scale: 0.9 + ((k * 37) % 10) / 30 });
      }
    }
  }

  // 公園の大きな木(楠・欅・桜・楓。両側、池と参道の灯籠の列はよける)
  forEachCell(fromM, toM, 12, (i, cellS) => {
    const rand = cellRand(L, 50, i);
    for (const side of [-1, 1]) {
      const count = 1 + Math.floor(rand() * 2.2);
      for (let k = 0; k < count; k++) {
        const s = cellS + rand() * 12;
        const u = 7 + Math.pow(rand(), 0.8) * 300;
        const d = side * (edge + u);
        const conifer = rand() < 0.18;
        const tree = { s, d, kind: conifer ? 'conifer' : 'broadleaf', scale: conifer ? 1.3 + rand() * 0.7 : 1.3 + rand() * 0.8, color: conifer ? CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)] : treeColor(rand, 0.3), seed: Math.floor(rand() * 1e9) };
        if (!inRange(s) || inPond(s, d, 1.25) || wakakusaWeight(L, d, s) > 0.1) continue;
        if (side > 0 && u > T.forestU + 60) continue; // 春日山の森は遠景の森に任せる
        out.trees.push(tree);
      }
    }
  });

  // 春日大社の参道: 両側に石灯籠が2列ずつ並び、奥は杉の巨木
  forEachCell(fromM, toM, 3.2, (i, cellS) => {
    if (!inSpan(L, cellS, T.sando) || !inRange(cellS)) return;
    const rand = cellRand(L, 51, i);
    for (const side of [-1, 1]) {
      // 苔むした石の色むら
      for (const [o, u] of [[0, 1.0], [1.6, 2.3]]) {
        out.stoneLanterns.push({ s: cellS + o, d: side * (edge + u), yaw: (rand() - 0.5) * 0.12, tint: STONE_TINTS[Math.floor(rand() * STONE_TINTS.length)] });
      }
    }
  });
  forEachCell(fromM, toM, 7, (i, cellS) => {
    const rand = cellRand(L, 52, i);
    for (const side of [-1, 1]) {
      const s = cellS + rand() * 7;
      if (!inSpan(L, s, T.sando) || !inRange(s)) continue;
      const u = 5 + rand() * 40;
      out.trees.push({ s, d: side * (edge + u), kind: 'conifer', scale: 1.8 + rand() * 0.8, color: CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)], seed: Math.floor(rand() * 1e9) });
    }
  });

  // 鹿の群れ(芝生の上で草を食んだり、立ち止まってこちらを見たり)
  forEachCell(fromM, toM, 22, (i, cellS) => {
    const rand = cellRand(L, 53, i);
    for (const side of [-1, 1]) {
      const count = Math.floor(rand() * 3.6);
      for (let k = 0; k < count; k++) {
        const s = cellS + rand() * 22;
        const u = 2.5 + Math.pow(rand(), 1.4) * 150;
        const d = side * (edge + u);
        const deer = { s, d, yaw: rand() * Math.PI * 2, pose: rand() < 0.55 ? 'graze' : 'stand', scale: 0.85 + rand() * 0.2 };
        if (!inRange(s) || inPond(s, d)) continue;
        if (inSpan(L, s, T.sando) && u < 3.2) continue; // 灯籠の列には入らない
        out.deer.push(deer);
      }
    }
  });
}

function collectKawaguchiko(L, fromM, toM, farToM, out) {
  const T = L.tour;
  const edge = roadEdgeM(L);
  const inRange = (s) => s >= fromM && s < toM;

  // もみじ回廊: 右側の小川沿いに真っ赤なもみじが密に並ぶ
  forEachCell(fromM, toM, 4, (i, cellS) => {
    const rand = cellRand(L, 60, i);
    const s = cellS + rand() * 4;
    if (!inRange(s) || spanWeight(L, s, T.momiji, 60) < 0.5) return;
    for (let k = 0; k < 2; k++) {
      const u = 1.6 + Math.pow(rand(), 1.2) * 30;
      const color = rand() < 0.75 ? AUTUMN_COLORS[Math.floor(rand() * 4)] : 0xd8b02a;
      out.trees.push({ s: s + rand(), d: edge + u, kind: 'broadleaf', scale: 0.85 + rand() * 0.35, color, seed: Math.floor(rand() * 1e9) });
    }
  });

  // 河口湖大橋・遊覧船(湖の上なので遠くから見える)
  const b = T.bridge;
  for (const s of occurrences(L, b.atM, fromM - 200, farToM + 1500)) out.bridges.push({ s, dFrom: -(edge + b.fromU), dTo: -(edge + b.toU) });
  for (const st of T.steamers) {
    for (const s of occurrences(L, st.atM, fromM - 300, farToM + 800)) out.steamers.push({ s, d: -(edge + st.u) });
  }
}
