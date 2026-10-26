// 竜宮城の海底コース(LANDSCAPES.ryugu)の景色の手続き型生成。海底の地形の起伏・色と、サンゴ・昆布・
// 貝殻・沈没船・宝箱・魚の群れ・マンタ・光の筋などの配置を決める純粋関数(Three.js 非依存。テスト対象)。
// 3D の形・描画・動き(魚の群れの回遊・昆布の揺れ・泡・水面からの光の模様)は ryuguParts.js。
//
// 座標系は landscapeLayout.js と同じ(s = 絶対距離、d = 道路中心からの横距離。負 = 左)。
// 海の底を走るので水面(湖・海の平面)は使わない。左は海溝へ落ち込み、右は岩山がせり上がる。
// 昆布の林・沈没船・海溝の縁・乙姫の舞台の踊り子(タイやヒラメ)は1周(tour.loopM)ごとに繰り返し、
// 名所の建物(竜宮門・竜宮城・乙姫の舞台・玉手箱)はコースプロファイルの landmarks(sightModels.js)。
//
// いずれも見た目だけで、物理・勾配・トレーナーへの指示には影響しない。

import { roadEdgeM, fbm, valueNoise, smoothstep, ridged, cellRand, forEachCell } from './landscapeLayout.js';
import { loopPos, toNearestM } from './tourLayout.js';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 1周の中の区間の端で 0→1 に滑らかに立ち上がる重み(区間の外は 0)。 */
function spanWeight(L, s, span, rampM) {
  const p = loopPos(L, s);
  return smoothstep(span.fromM, span.fromM + rampM, p) * smoothstep(span.toM, span.toM - rampM, p);
}

/** 1周に1回の地点 atM のうち、[from, to) に入るものの絶対距離。 */
function occurrences(L, atM, from, to) {
  const m = L.tour.loopM;
  const list = [];
  for (let k = Math.floor((from - atM) / m); k * m + atM < to; k++) {
    const s = k * m + atM;
    if (s >= from) list.push(s);
  }
  return list;
}

// サンゴ(ピンク・橙・紫・黄・水色・赤)、イソギンチャク、貝殻の色
export const CORAL_COLORS = [0xf28aa0, 0xff9b5a, 0xb07ad8, 0xf5d04a, 0x6fd6cf, 0xe8504a, 0xffc0cb];
const ANEMONE_COLORS = [0xff7a5c, 0xc27be0, 0x5fd0c0, 0xffb347];
const SHELL_COLORS = [0xfff4ea, 0xf7d5c8, 0xf3c1a8, 0xffe9d6, 0xe8b4b8, 0xfaf0dc];
const KELP_COLORS = [0x7a8a36, 0x66863a, 0x8a8434, 0x7c7230];
// 魚の種類: 0 = 黄色(キイロハギ)、1 = 青(ナンヨウハギ)、2 = 橙(カクレクマノミ)、3 = 銀(イワシ)
export const FISH_SPECIES = 4;

// ---- 地形 ----

/** 海溝の縁の始まり(路肩外縁から、左側)。海溝の区間だけ道路のすぐ近くまで迫る。 */
export function ryuguTrenchU(L, s) {
  const T = L.tour;
  return lerp(T.trench.baseU, T.trench.nearU, spanWeight(L, s, T.trench, 150));
}

/** (s, d) の海底の絶対標高。u は路肩外縁からの距離。 */
export function ryuguTerrainHeight(L, d, s, u, roadE) {
  const T = L.tour;
  const seed = L.seed;
  if (u <= T.sandM) return roadE + 0.05; // 道路脇の平らな白い砂
  // サンゴ礁のゆるい塚
  let h = roadE + 0.05 + (fbm(s / 60, u / 60, seed + 5, 3) - 0.5) * 2.6 * smoothstep(T.sandM, 30, u);
  if (d > 0) {
    // 右: 岩山(尖った尾根)がせり上がる
    const hu = u - T.hillU;
    if (hu > 0) {
      h += 0.32 * Math.min(hu, 500) + 0.1 * Math.max(0, hu - 500)
        + 80 * ridged(s / 260, hu / 260, seed + 43) * smoothstep(0, 160, hu);
    }
    return h;
  }
  // 左: 海溝へ落ち込む
  const tu = u - ryuguTrenchU(L, s);
  if (tu > 0) h -= T.trench.depthM * smoothstep(0, 240, tu) + 20 * fbm(s / 200, tu / 200, seed + 13, 3) * smoothstep(0, 60, tu);
  return h;
}

/** 海底の色(sRGB 0..1)。白い砂・海草・サンゴ礁の床・岩・海溝の暗がり。 */
export function ryuguTerrainColor(L, d, s, normalY) {
  const T = L.tour;
  const seed = L.seed;
  const u = Math.abs(d) - roadEdgeM(L);
  const fine = (valueNoise(s / 3, d / 3, seed + 63) - 0.5) * 0.05;
  // 白い砂(さざ波の筋)
  const ripple = (valueNoise(s / 1.6, d / 9, seed + 65) - 0.5) * 0.06;
  let rgb = [0.84 + fine + ripple, 0.8 + fine + ripple, 0.66 + fine + ripple];
  if (u > T.sandM) {
    // サンゴ礁の床(ピンク・橙・紫のまだら)
    const reef = smoothstep(0.5, 0.62, fbm(s / 140, d / 140, seed + 7, 3)) * smoothstep(T.sandM, T.sandM + 6, u);
    const hue = valueNoise(s / 40, d / 40, seed + 9);
    const coral = hue < 0.3 ? [0.82, 0.5, 0.55] : hue < 0.55 ? [0.86, 0.58, 0.36] : hue < 0.8 ? [0.6, 0.44, 0.66] : [0.4, 0.64, 0.6];
    rgb = rgb.map((c, i) => lerp(c, coral[i] + fine, reef * 0.75));
    // 海草の草原
    const grass = smoothstep(0.58, 0.68, fbm(s / 90, d / 90, seed + 11, 3)) * (1 - reef);
    rgb = rgb.map((c, i) => lerp(c, [0.27, 0.42, 0.22][i] + fine, grass * 0.8));
  }
  // 岩肌(急斜面・右の岩山)
  const rock = Math.max(smoothstep(0.75, 0.5, normalY), d > 0 ? smoothstep(T.hillU - 10, T.hillU + 40, u) * 0.85 : 0);
  rgb = rgb.map((c, i) => lerp(c, [0.36, 0.41, 0.44][i] + fine, rock));
  // 海溝: 縁から離れて深くなるほど暗い
  const deep = d < 0 ? smoothstep(10, 200, u - ryuguTrenchU(L, s)) : 0;
  rgb = rgb.map((c, i) => lerp(c, [0.1, 0.17, 0.22][i], deep));
  // 水の色をかぶせる(赤い光ほど水に吸われる)
  return [rgb[0] * 0.82, rgb[1] * 0.94, rgb[2]];
}

// ---- 配置物 ----

const SHELL_SPACING_M = 1.6;

/**
 * [fromM, toM) の範囲(遠くに見える物は farToM まで)の海底の配置物。
 * - shells: 道路の縁取りの貝殻 { s, d, yaw, scale, color, type: 0 = ホタテ, 1 = 巻き貝 }
 * - corals: サンゴ { s, d, type: 0 = 枝 / 1 = 脳 / 2 = うちわ / 3 = 筒, scale, yaw, color }
 * - anemones: イソギンチャク { s, d, scale, color }
 * - kelp: 昆布 { s, d, heightM, color }
 * - ships: 沈没船 { s, d, yaw }
 * - chests: 宝箱 { s, d, yaw }
 * - schools: 魚の群れ { s, d, heightM, radiusM, count, species, speed, seed, dance }
 *   (species: 0〜3 = FISH_SPECIES、'tai' / 'hirame' = 乙姫の舞台の踊り子。dance なら舞い踊る)
 * - mantas: マンタ { s, d, heightM, speedMps, seed }(前へゆっくり進む)
 * - shafts: 水面から差し込む光の筋 { s, d, widthM, yaw, lean }
 * - anglers: チョウチンアンコウ { s, d, heightM, yaw }(海溝の縁)
 * - bubbles: 泡の湧き出し口 { s, d, seed }
 */
export function collectRyuguObjects(L, fromM, toM, farToM = toM) {
  const T = L.tour;
  const edge = roadEdgeM(L);
  const half = L.roadHalfWidthM;
  const inRange = (s) => s >= fromM && s < toM;
  const out = {
    shells: [], corals: [], anemones: [], kelp: [], ships: [], chests: [], schools: [], mantas: [], shafts: [], anglers: [], bubbles: [],
  };
  const kelpW = (s) => spanWeight(L, s, T.kelp, 60);

  // 道路の縁取りの貝殻(路肩の上に左右1列ずつ)
  for (const side of [-1, 1]) {
    forEachCell(fromM, toM, SHELL_SPACING_M, (i, cellS) => {
      const rand = cellRand(L, side < 0 ? 70 : 71, i);
      const s = cellS + rand() * 0.6;
      const shell = {
        s, d: side * (half + 0.15 + rand() * 0.3), yaw: rand() * Math.PI * 2, scale: 0.8 + rand() * 0.5,
        color: SHELL_COLORS[Math.floor(rand() * SHELL_COLORS.length)], type: rand() < 0.65 ? 0 : 1,
      };
      if (inRange(s)) out.shells.push(shell);
    });
  }

  // サンゴ(サンゴ礁の濃い所ほど密に。昆布の林の中は少なめ)とイソギンチャク
  forEachCell(fromM, toM, 6, (i, cellS) => {
    const rand = cellRand(L, 72, i);
    for (const side of [-1, 1]) {
      const reef = fbm(cellS / 140, side * (edge + 20) / 140, L.seed + 7, 3);
      const count = Math.floor((1.5 + 4.5 * smoothstep(0.42, 0.65, reef)) * (1 - 0.7 * kelpW(cellS)) + rand());
      for (let k = 0; k < count; k++) {
        const s = cellS + rand() * 6;
        // 道路の近くほど密に(遠くは霞んで見えないので)
        const u = 0.9 + Math.pow(rand(), 1.8) * 65;
        const coral = {
          s, d: side * (edge + u), type: Math.floor(rand() * 4), scale: 0.8 + rand() * 1.2,
          yaw: rand() * Math.PI * 2, color: CORAL_COLORS[Math.floor(rand() * CORAL_COLORS.length)],
        };
        if (inRange(s) && (side > 0 || u < ryuguTrenchU(L, s) - 4)) out.corals.push(coral);
      }
    }
  });
  forEachCell(fromM, toM, 9, (i, cellS) => {
    const rand = cellRand(L, 73, i);
    for (const side of [-1, 1]) {
      if (rand() > 0.6) continue;
      const s = cellS + rand() * 9;
      const anemone = { s, d: side * (edge + 0.8 + rand() * 18), scale: 0.6 + rand() * 0.6, color: ANEMONE_COLORS[Math.floor(rand() * ANEMONE_COLORS.length)] };
      if (inRange(s)) out.anemones.push(anemone);
    }
  });

  // 昆布: 林の区間は道路の両側に密に、ほかは所々に株
  forEachCell(fromM, toM, 2.5, (i, cellS) => {
    const rand = cellRand(L, 74, i);
    const w = kelpW(cellS);
    if (w <= 0.05) return;
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const s = cellS + rand() * 2.5;
        const u = 0.7 + Math.pow(rand(), 0.9) * 45;
        const kelp = { s, d: side * (edge + u), heightM: (6 + rand() * 9) * (0.5 + 0.5 * w), color: KELP_COLORS[Math.floor(rand() * KELP_COLORS.length)] };
        if (inRange(s) && rand() < w) out.kelp.push(kelp);
      }
    }
  });
  forEachCell(fromM, toM, 12, (i, cellS) => {
    const rand = cellRand(L, 75, i);
    if (rand() > 0.3 || kelpW(cellS) > 0.05) return;
    const side = rand() < 0.5 ? -1 : 1;
    const u = 6 + rand() * 50;
    const n = 3 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const s = cellS + 6 + (rand() - 0.5) * 3;
      const kelp = { s, d: side * (edge + u + (rand() - 0.5) * 3), heightM: 4 + rand() * 5, color: KELP_COLORS[Math.floor(rand() * KELP_COLORS.length)] };
      if (inRange(s) && (side > 0 || u < ryuguTrenchU(L, s) - 4)) out.kelp.push(kelp);
    }
  });

  // 沈没船と、まわりの宝箱(遠くから見えるよう farToM まで)
  const sh = T.ship;
  for (const s of occurrences(L, sh.atM, fromM - 40, farToM)) {
    out.ships.push({ s, d: -(edge + sh.u), yaw: 0.55 });
    out.bubbles.push({ s: s + 4, d: -(edge + sh.u - 2), seed: 1 });
    for (const [ds, du, yaw] of [[-16, -12, 0.4], [-11, -15, -0.6], [14, -9, 1.2]]) {
      if (inRange(s + ds)) out.chests.push({ s: s + ds, d: -(edge + sh.u + du), yaw });
    }
  }
  forEachCell(fromM, toM, 150, (i, cellS) => {
    const rand = cellRand(L, 76, i);
    if (rand() > 0.35) return;
    const s = cellS + rand() * 150;
    const side = rand() < 0.5 ? -1 : 1;
    const chest = { s, d: side * (edge + 3 + rand() * 18), yaw: rand() * Math.PI * 2 };
    if (inRange(s)) {
      out.chests.push(chest);
      out.bubbles.push({ s, d: chest.d, seed: i });
    }
  });

  // 魚の群れ(道路の上を横切る群れもある)
  forEachCell(fromM, toM, 30, (i, cellS) => {
    const rand = cellRand(L, 77, i);
    if (rand() > 0.8) return;
    const s = cellS + rand() * 30;
    const over = rand() < 0.45;
    const side = rand() < 0.5 ? -1 : 1;
    const d = over ? (rand() - 0.5) * 6 : side * (edge + 2 + rand() * 35);
    const school = {
      s, d, heightM: over ? 3.5 + rand() * 3 : 1.5 + rand() * 5, radiusM: 2.5 + rand() * 3.5,
      count: 10 + Math.floor(rand() * 14), species: Math.floor(rand() * FISH_SPECIES),
      speed: (0.25 + rand() * 0.35) * (rand() < 0.5 ? -1 : 1), seed: Math.floor(rand() * 1e9), dance: false,
    };
    if (inRange(s)) out.schools.push(school);
  });
  // 乙姫の舞台のまわりで舞い踊るタイやヒラメ
  const st = T.stage;
  for (const s of occurrences(L, st.atM, fromM, toM)) {
    out.schools.push({ s, d: st.d, heightM: 3.2, radiusM: 9.5, count: 12, species: 'tai', speed: 0.35, seed: 11, dance: true });
    out.schools.push({ s, d: st.d, heightM: 5.5, radiusM: 6, count: 8, species: 'hirame', speed: -0.45, seed: 12, dance: true });
  }

  // マンタ(頭上をゆっくり進む)
  forEachCell(fromM - 200, farToM, 350, (i, cellS) => {
    const rand = cellRand(L, 78, i);
    if (rand() > 0.6) return;
    const manta = { s: cellS + rand() * 350, d: (rand() - 0.5) * 50, heightM: 9 + rand() * 7, speedMps: 1.2 + rand() * 0.8, seed: Math.floor(rand() * 1e9) };
    if (manta.s >= fromM - 200 && manta.s < farToM) out.mantas.push(manta);
  });

  // 水面から差し込む光の筋
  forEachCell(fromM, toM, 16, (i, cellS) => {
    const rand = cellRand(L, 79, i);
    const n = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < n; k++) {
      const s = cellS + rand() * 16;
      const shaft = { s, d: (rand() - 0.5) * 140, widthM: 2.5 + rand() * 5, yaw: rand() * Math.PI, lean: (rand() - 0.5) * 0.3 };
      if (inRange(s)) out.shafts.push(shaft);
    }
  });

  // 海溝の縁のチョウチンアンコウ
  forEachCell(fromM, toM, 50, (i, cellS) => {
    const rand = cellRand(L, 80, i);
    const s = cellS + rand() * 50;
    if (spanWeight(L, s, T.trench, 150) < 0.5 || rand() > 0.6) return;
    const angler = { s, d: -(edge + ryuguTrenchU(L, s) - 3 - rand() * 6), heightM: 1 + rand() * 2.5, yaw: rand() * Math.PI * 2 };
    if (inRange(s)) out.anglers.push(angler);
  });

  // 泡の湧き出し口(サンゴ礁の所々)
  forEachCell(fromM, toM, 30, (i, cellS) => {
    const rand = cellRand(L, 81, i);
    if (rand() > 0.5) return;
    const s = cellS + rand() * 30;
    const side = rand() < 0.5 ? -1 : 1;
    const bubble = { s, d: side * (edge + 1 + rand() * 15), seed: i };
    if (inRange(s)) out.bubbles.push(bubble);
  });

  return out;
}

/** 乙姫の舞台の踊り子の群れの中心(テストで名所の位置と揃っているか確かめる)。 */
export function ryuguStageCenter(L, s) {
  return { s: s - toNearestM(L, s, L.tour.stage.atM), d: L.tour.stage.d };
}
