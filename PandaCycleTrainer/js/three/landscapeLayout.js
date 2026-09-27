// 丘陵(湖畔)・山岳コースの景観の手続き型生成。cityLayout.js同様Three.js非依存の
// 純粋関数にしてあり、Node上でユニットテストできる。
//
// 座標系: s = コース上の絶対距離(m)、d = 道路中心線からの横方向距離(m、負=谷/湖側=左、
// 正=山側=右)。高さはコースの「絶対標高」(走行開始地点=0)で表す。道路は緩やかに
// カーブしながら(roadCenterX)進み、地形・樹木などはすべて s に固定された乱数/ノイズから
// 決まるため、同じ地点は何度通っても同じ景色になる。
//
// コースはループごとに標高が大きく変わる(丘陵: 1周+160m、山岳: 1周+666m)ため、湖面や
// 谷底の高さは固定できない。createFloorModel() は「周回ごとの上昇トレンド」に沿って
// ゆっくり上がる水面/谷底を、道路より常に minDropM 以上低い位置に置く。

import { mulberry32 } from './cityLayout.js';

export const LANDSCAPES = {
  lakeside: {
    id: 'lakeside',
    seed: 1307,
    roadHalfWidthM: 3.5,
    shoulderM: 1.1,
    centerLine: 'white-dashed',
    // 道路のカーブ(中心線の横ずれ = Σ amp·sin(2πs/len + phase))。
    curves: [
      { ampM: 22, lenM: 900, phase: 0.3 },
      { ampM: 8, lenM: 350, phase: 1.9 },
    ],
    valley: {
      bankSlope: 0.42, // 路肩から湖へ下る斜面の勾配
      bankCurve: 0.01, // 離れるほど斜面を急にする係数
      bankNoiseM: 4,
      minDropM: 70, // 湖面は道路より最低これだけ低い(見下ろす眺め)
      bedDepthM: 7, // 湖岸付近の水深
      farShoreM: 1150, // 対岸までの距離(路肩から)
      farShoreJitterM: 320,
      farHillM: 190, // 対岸の丘の高さ
    },
    hill: {
      cutSlope: 0.55, // 路肩のすぐ脇の切土法面
      cutWidthM: 4,
      riseSlope: 0.09, // 山側の平均的な上り勾配
      hillAmpM: 60, // なだらかな丘の起伏
      hillScaleM: 340,
      hillRampM: 80,
    },
    treeline: null,
    snowline: null,
    trees: { valley: 1.2, hill: 2.2, coniferRatio: 0.3, maxLateralM: 110, maxSlope: 1.1 },
    farTrees: { density: 1.8, coniferRatio: 0.45, maxLateralM: 1500 },
    guardrailChance: 0.55,
    houses: true,
    boats: true,
    walls: false,
    rocks: 0.1,
    rockMaxM: 1.2,
    forestCover: [0.44, 0.58], // 地形の色を森にするノイズの閾値
  },
  mountain: {
    id: 'mountain',
    seed: 2711,
    roadHalfWidthM: 3.2,
    shoulderM: 0.9,
    centerLine: 'yellow',
    curves: [
      { ampM: 30, lenM: 800, phase: 1.1 },
      { ampM: 6, lenM: 300, phase: 0.4 },
    ],
    valley: {
      bankSlope: 0.75, // 急峻な谷側斜面
      bankCurve: 0.006,
      bankNoiseM: 10,
      minDropM: 140, // 谷底(川)は道路より最低これだけ低い
      bedDepthM: 3, // 川の深さ
      riverWidthM: 34,
      // 川の位置(谷側の路肩外縁から)。道路が最も高い(谷底から約500m)ときでも
      // 谷側斜面の裾(約280m先)より向こうになるよう置く。
      riverBaseM: 480,
      valleyFloorWidthM: 700, // 川から対岸の山裾までの谷底平地の幅(×0.5)
      farRangeM: 1700, // 対岸の山並みの高さ(谷底から)
      farRangeRiseM: 2200, // 山裾から主稜線までの水平距離
      farRangeScaleM: 900,
    },
    hill: {
      cutSlope: 1.1, // 岩盤の切土
      cutWidthM: 4,
      riseSlope: 0.5,
      hillAmpM: 380,
      hillScaleM: 650,
      hillRampM: 260, // 起伏が立ち上がるまでの距離
    },
    // 谷底からの高さ(m)で決まる森林限界・雪線。
    treeline: 1150,
    snowline: 1450,
    trees: { valley: 2.0, hill: 2.2, coniferRatio: 0.9, maxLateralM: 90, maxSlope: 1.7 },
    farTrees: { density: 2.2, coniferRatio: 0.95, maxLateralM: 900 },
    guardrailChance: 1,
    houses: false,
    boats: false,
    walls: true,
    rocks: 0.9,
    rockMaxM: 4,
    forestCover: [0.28, 0.46],
  },
  // 熱海サンビーチ: 相模湾(左)に沿った海岸通り。海側はヤシ並木の遊歩道と護岸、その下に
  // 砂浜。山側は歩道とホテルの建ち並ぶ敷地、その奥にホテル・家々が張り付く急な斜面と山並み。
  atami: {
    id: 'atami',
    seed: 3907,
    roadHalfWidthM: 3.5,
    shoulderM: 0.5,
    centerLine: 'white-dashed',
    curves: [
      { ampM: 30, lenM: 1400, phase: 0.2 },
      { ampM: 6, lenM: 420, phase: 2.2 },
    ],
    town: {
      promenadeM: 9, // 海側の遊歩道の幅
      seawallM: 2, // 遊歩道の縁から砂浜へ下りる護岸の水平幅
      sidewalkM: 3, // 山側の歩道の幅
      lotM: 42, // ホテルの建つ平らな敷地の奥行き
    },
    valley: {
      minDropM: 4, // 海面は道路より最低これだけ低い
      beachTopM: 2.2, // 護岸の足元(砂浜の最上部)の海面からの最低の高さ
      seawallHeightM: 2.8, // 遊歩道から砂浜への段差(実際のサンビーチ同様、低い護岸)
      beachWidthM: 55, // 護岸の足元から波打ち際までの砂浜の幅
    },
    hill: {
      riseSlope: 0.42, // 市街地の急斜面(熱海は山が海に迫る)
      hillAmpM: 110,
      hillScaleM: 420,
      ridgeM: 260, // 背後の山並み(十国峠方面)
    },
    treeline: null,
    snowline: null,
    trees: { valley: 0, hill: 0.8, coniferRatio: 0.45, minLateralM: 60, maxLateralM: 160, maxSlope: 1.2 },
    farTrees: { density: 1.6, coniferRatio: 0.5, maxLateralM: 900 },
    houseBandM: [70, 320], // 斜面に点在する民家の範囲(路肩外縁から)
    houseChance: 0.95,
    guardrailChance: 0,
    delineators: false,
    houses: true,
    boats: true,
    walls: false,
    rocks: 0,
    rockMaxM: 1,
    forestCover: [0.42, 0.56],
  },
};

export function getLandscape(id) {
  return LANDSCAPES[id] ?? LANDSCAPES.lakeside;
}

/** 路肩の外縁(道路中心から)。ここより外が地形。 */
export function roadEdgeM(L) {
  return L.roadHalfWidthM + L.shoulderM;
}

// ---- 道路のカーブ ----

/** 絶対距離sにおける道路中心線の横ずれ(m)。 */
export function roadCenterX(L, s) {
  let x = 0;
  for (const c of L.curves) x += c.ampM * Math.sin((2 * Math.PI * s) / c.lenM + c.phase);
  return x;
}

/** 道路中心線の傾き dx/ds(進行方向に対する横方向の変化率)。 */
export function roadSlopeX(L, s) {
  let dx = 0;
  for (const c of L.curves) dx += ((c.ampM * 2 * Math.PI) / c.lenM) * Math.cos((2 * Math.PI * s) / c.lenM + c.phase);
  return dx;
}

/**
 * 横方向の列を道路のカーブに追従させる割合。道路付近(|d|<150m)は完全に追従、
 * 遠景(|d|>600m)は追従させない(遠くの山や湖岸は世界に固定され、道路だけが蛇行する)。
 */
export function lateralFollow(d) {
  const a = Math.abs(d);
  if (a <= 150) return 1;
  if (a >= 600) return 0;
  const t = (a - 150) / 450;
  return 1 - t * t * (3 - 2 * t);
}

/** (s, d) の地点のローカルX座標(道路のカーブを反映)。 */
export function lateralX(L, s, d) {
  return d + roadCenterX(L, s) * lateralFollow(d);
}

// ---- 標高 ----

/**
 * CourseEngine#gradeAtKm を絶対距離の等間隔グリッド上で積分し、任意地点の絶対標高
 * (開始地点=0)を返すサンプラー。グリッドが絶対距離に固定されているため、どの位置から
 * 見ても同じ地点は同じ標高になる(地形・道路のつなぎ目がフレーム間で揺れない)。
 * 結果は0mから前方へ必要な分だけキャッシュされる。
 */
export function createElevationSampler(gradeAtKm, stepM = 4) {
  const cache = [0];
  const grade = (m) => gradeAtKm(m / 1000) / 100;
  const ensure = (index) => {
    for (let i = cache.length; i <= index; i++) {
      const midM = (i - 0.5) * stepM;
      cache.push(cache[i - 1] + grade(midM) * stepM);
    }
  };
  return {
    stepM,
    elevAt(s) {
      if (!Number.isFinite(s)) return 0;
      if (s <= 0) return grade(0) * s; // 開始地点より後方は開始地点の勾配で外挿
      const i = Math.floor(s / stepM);
      ensure(i + 1);
      const t = s / stepM - i;
      return cache[i] + (cache[i + 1] - cache[i]) * t;
    },
  };
}

/**
 * 湖面・谷底の高さモデル。1周あたりの標高上昇を直線トレンドとして追い、
 * 1周分の起伏(トレンドからの偏差)の最小値からさらに minDropM 下に置く。
 * これで道路は常に水面/谷底より minDropM 以上高く、かつ水面は周回を重ねても
 * 道路からどんどん離れていかない。
 */
export function createFloorModel(sampler, loopLengthM, minDropM) {
  const loopRise = sampler.elevAt(loopLengthM);
  const ratePerM = loopRise / loopLengthM;
  let minDeviation = 0;
  let maxDeviation = 0;
  for (let s = 0; s <= loopLengthM; s += 10) {
    const dev = sampler.elevAt(s) - ratePerM * s;
    minDeviation = Math.min(minDeviation, dev);
    maxDeviation = Math.max(maxDeviation, dev);
  }
  return {
    ratePerM,
    /** 道路と水面/谷底の最大の高低差(minDropM + 1周の起伏幅)。 */
    maxDropM: minDropM + (maxDeviation - minDeviation),
    floorAt(s) {
      return ratePerM * s + minDeviation - minDropM;
    },
  };
}

// ---- ノイズ ----

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 2次元バリューノイズ(0..1)。 */
export function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** fBm(0..1付近)。 */
export function fbm(x, y, seed, octaves = 4) {
  let v = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * valueNoise(x, y, seed + i * 101);
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return v / norm;
}

/** 尾根状のfBm(0..1)。山並みの稜線に使う。 */
function ridged(x, y, seed, octaves = 5) {
  let v = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x, y, seed + i * 131) * 2 - 1);
    v += amp * n * n;
    norm += amp;
    x *= 2.1;
    y *= 2.1;
    amp *= 0.5;
  }
  return v / norm;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---- 地形 ----

/** 山岳コースの谷底を流れる川の中心(谷側の路肩外縁からの距離)。 */
function riverOffsetM(L, s) {
  const v = L.valley;
  return v.riverBaseM + 60 * Math.sin(s / 420 + 0.7) + 25 * Math.sin(s / 170 + 2.1);
}

/**
 * (s, d) における地形の絶対標高。
 * @param {object} L LANDSCAPESの要素
 * @param {number} d 道路中心からの横距離(負=谷/湖側)
 * @param {number} s 絶対距離
 * @param {number} roadElevM その断面での道路の絶対標高
 * @param {number} floorM 水面/谷底の絶対標高
 */
export function terrainHeightM(L, d, s, roadElevM, floorM) {
  const edge = roadEdgeM(L);
  const a = Math.abs(d);
  // 道路の下(路面より少し低く、道路メッシュの下に隠れる)
  if (a <= L.roadHalfWidthM + 0.6) return roadElevM - 0.3;
  if (a <= edge) return roadElevM - 0.12;
  const u = a - edge; // 路肩外縁からの距離
  const seed = L.seed;
  if (L.id === 'atami') return atamiTerrainHeight(L, d, s, u, roadElevM, floorM);

  if (d < 0) {
    // 谷/湖側: 道路から下る斜面(bank)と、水面/谷底基準の地形(bed)の高い方。
    const v = L.valley;
    const wobble = (fbm(s / 90, u / 70, seed + 11, 3) - 0.5) * 2 * v.bankNoiseM * smoothstep(0, 25, u);
    const bank = roadElevM - v.bankSlope * u - (v.bankCurve * u * u) / (1 + u / 60) + wobble;
    let bed;
    if (L.id === 'mountain') {
      const riverU = riverOffsetM(L, s);
      const channel = smoothstep(v.riverWidthM * 0.5 + 12, v.riverWidthM * 0.5, Math.abs(u - riverU));
      const meadow = floorM + 2.5 + (fbm(s / 150, u / 150, seed + 5, 3) - 0.5) * 3;
      // 谷底平地の向こう(対岸)は高い山並みへ急激にせり上がる。
      const farU = u - (riverU + v.valleyFloorWidthM * 0.5);
      const rise = farU > 0 ? Math.pow(smoothstep(0, v.farRangeRiseM, farU), 0.8) : 0;
      const peaks = ridged(s / v.farRangeScaleM, u / v.farRangeScaleM, seed + 23);
      bed = meadow - channel * (v.bedDepthM + 3) + rise * v.farRangeM * (0.35 + 0.9 * peaks);
    } else {
      const shoreU = v.farShoreM + (fbm(s / 900, 3.1, seed + 17, 3) - 0.5) * 2 * v.farShoreJitterM;
      const toShore = u - shoreU;
      const depth = v.bedDepthM + Math.min(25, u * 0.02);
      const farHills = toShore > 0
        ? smoothstep(-40, 500, toShore) * v.farHillM * (0.45 + 0.8 * fbm(s / 600, u / 600, seed + 29, 4))
        : 0;
      bed = floorM - depth + (toShore > -60 ? smoothstep(-60, 0, toShore) * (depth + 1.5) : 0) + farHills;
    }
    return Math.max(bank, bed);
  }

  // 山側: 切土法面 → なだらかな丘(湖畔)/急峻な山腹(山岳)
  const hl = L.hill;
  const cut = hl.cutSlope * Math.min(u, hl.cutWidthM);
  const beyond = Math.max(0, u - hl.cutWidthM);
  const hills = hl.hillAmpM * fbm(s / hl.hillScaleM, u / hl.hillScaleM, seed + 41, 5) * smoothstep(0, hl.hillRampM, beyond);
  const ridge = L.id === 'mountain' ? hl.hillAmpM * 0.8 * ridged(s / 500, u / 500, seed + 43) * smoothstep(80, 600, beyond) : 0;
  return roadElevM + cut + hl.riseSlope * beyond + hills + ridge;
}

/**
 * 地形の色(sRGB 0..1)。高さ・傾斜・水面からの高さで草地/森/岩/雪/砂浜を塗り分ける。
 * @param {number} normalY 地形法線のY成分(1=水平、0=垂直)
 */
export function terrainColor(L, d, s, h, floorM, normalY) {
  if (L.id === 'atami') return atamiTerrainColor(L, d, s, h, floorM, normalY);
  const seed = L.seed;
  const aboveFloor = h - floorM;
  const patch = fbm(s / 180, d / 180, seed + 61, 3);
  const forest = fbm(s / 420, d / 420, seed + 67, 4);
  let r;
  let g;
  let b;
  if (L.id === 'mountain') {
    // 針葉樹林(暗緑) ⇄ 高山草原(黄緑) を森林限界で切り替える
    const tree = smoothstep(L.treeline + 80, L.treeline - 120, aboveFloor);
    const dense = smoothstep(L.forestCover[0], L.forestCover[1], forest) * tree;
    r = lerp(0.42, 0.13, dense) + (patch - 0.5) * 0.08;
    g = lerp(0.5, 0.25, dense) + (patch - 0.5) * 0.08;
    b = lerp(0.26, 0.13, dense);
  } else {
    // 牧草地(緑〜刈り取り後の黄緑のパッチ、細かなムラ) + 雑木林(暗緑)
    const dense = smoothstep(L.forestCover[0], L.forestCover[1], forest);
    const field = smoothstep(0.4, 0.75, patch);
    const fine = (valueNoise(s / 31, d / 31, seed + 63) - 0.5) * 0.09;
    r = lerp(lerp(0.36, 0.56, field), 0.17, dense) + fine;
    g = lerp(lerp(0.49, 0.56, field), 0.29, dense) + fine;
    b = lerp(lerp(0.22, 0.28, field), 0.15, dense) + fine * 0.5;
  }
  // 急斜面は岩肌
  const rockiness = smoothstep(L.id === 'mountain' ? 0.72 : 0.62, L.id === 'mountain' ? 0.5 : 0.42, normalY);
  const rockTone = 0.42 + (valueNoise(s / 23, d / 23, seed + 71) - 0.5) * 0.12;
  r = lerp(r, rockTone + 0.03, rockiness);
  g = lerp(g, rockTone + 0.01, rockiness);
  b = lerp(b, rockTone - 0.02, rockiness);
  // 雪(山岳の高所、急すぎない斜面のみ)
  if (L.snowline !== null) {
    const snowNoise = (fbm(s / 260, d / 260, seed + 73, 3) - 0.5) * 220;
    const snow = smoothstep(L.snowline - 60, L.snowline + 120, aboveFloor + snowNoise) * smoothstep(0.35, 0.6, normalY);
    r = lerp(r, 0.93, snow);
    g = lerp(g, 0.95, snow);
    b = lerp(b, 0.98, snow);
  }
  // 水際の砂浜/河原
  const shore = smoothstep(2.5, 0.4, aboveFloor);
  r = lerp(r, L.id === 'mountain' ? 0.6 : 0.72, shore);
  g = lerp(g, L.id === 'mountain' ? 0.58 : 0.66, shore);
  b = lerp(b, L.id === 'mountain' ? 0.53 : 0.5, shore);
  return [clamp01(r), clamp01(g), clamp01(b)];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// ---- 配置物 ----

const TREE_CELL_M = 8;
const FAR_TREE_CELL_M = 24;
const RUN_CELL_M = 100;
const HOUSE_CELL_M = 150;
const BOAT_CELL_M = 400;
const WALL_CELL_M = 200;
const DELINEATOR_SPACING_M = 50;

export const BROADLEAF_COLORS = [0x4a6b2f, 0x56793a, 0x3f5f2a, 0x66843f, 0x5c7a34];
export const CONIFER_COLORS = [0x23402a, 0x2b4a30, 0x1f3a26, 0x31522f];
export const HOUSE_WALL_COLORS = [0xf1ece2, 0xe4dccb, 0xd9cdb6, 0x9c7a58, 0xf5f3ee];
export const HOUSE_ROOF_COLORS = [0x3c4148, 0x2f3d52, 0x7a3b2a, 0x4a4a4a, 0x5b3a2a];

function cellRand(L, kind, index) {
  return mulberry32((L.seed * 7919) ^ (kind * 104729) ^ Math.imul(index, 2654435761));
}

function forEachCell(fromM, toM, cellM, fn) {
  const first = Math.floor(fromM / cellM);
  const last = Math.floor(toM / cellM);
  for (let i = first; i <= last; i++) fn(i, i * cellM);
}

/**
 * [fromM, toM) の範囲に置く配置物を決定的に列挙する(地形の高さによる除外=水中・急斜面
 * などはThree.js側で行う)。すべて絶対距離 s と横距離 d で返す。
 */
export function collectLandscapeObjects(L, fromM, toM, { farToM = toM } = {}) {
  const edge = roadEdgeM(L);
  const trees = [];
  const farTrees = [];
  const rocks = [];
  const houses = [];
  const boats = [];
  const guardrailRuns = [];
  const walls = [];
  const delineators = [];

  const inRange = (s) => s >= fromM && s < toM;

  forEachCell(fromM, toM, TREE_CELL_M, (i, cellS) => {
    const rand = cellRand(L, 1, i);
    for (const [side, density] of [[-1, L.trees.valley], [1, L.trees.hill]]) {
      // 森のノイズが濃い所ほど木を密に(木立ち・雑木林のまとまりができる)
      const grove = fbm(cellS / 420, side * (edge + 40) / 420, L.seed + 67, 4);
      const count = Math.floor(density * (0.3 + 1.6 * grove) + rand());
      for (let k = 0; k < count; k++) {
        const s = cellS + rand() * TREE_CELL_M;
        // 路肩付近は疎に、離れるほど密に見えるよう、横距離は二乗分布で奥寄りにする
        const minU = L.trees.minLateralM ?? 1.8;
        const u = minU + Math.pow(rand(), 0.7) * (L.trees.maxLateralM - minU);
        const conifer = rand() < L.trees.coniferRatio;
        const tree = {
          s, d: side * (edge + u), kind: conifer ? 'conifer' : 'broadleaf',
          scale: conifer ? 0.8 + rand() * 0.7 : 0.75 + rand() * 0.6,
          color: conifer ? CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)] : BROADLEAF_COLORS[Math.floor(rand() * BROADLEAF_COLORS.length)],
          seed: Math.floor(rand() * 1e9),
        };
        if (inRange(s)) trees.push(tree);
      }
    }
    if (rand() < L.rocks) {
      const s = cellS + rand() * TREE_CELL_M;
      const side = rand() < 0.65 ? 1 : -1;
      const rock = { s, d: side * (edge + 1 + rand() * 30), size: 0.4 + rand() * rand() * L.rockMaxM, yaw: rand() * Math.PI * 2, tilt: rand() * 0.5 };
      if (inRange(s)) rocks.push(rock);
    }
  });

  // 遠景の森(幹なしの簡略な木)。森のノイズが濃い所にだけ置く。
  forEachCell(fromM, farToM, FAR_TREE_CELL_M, (i, cellS) => {
    const rand = cellRand(L, 2, i);
    const count = Math.floor(L.farTrees.density * 6 + rand());
    for (let k = 0; k < count; k++) {
      const s = cellS + rand() * FAR_TREE_CELL_M;
      const side = rand() < 0.5 ? -1 : 1;
      const u = L.trees.maxLateralM + rand() * (L.farTrees.maxLateralM - L.trees.maxLateralM);
      const d = side * (edge + u);
      const forest = fbm(s / 420, d / 420, L.seed + 67, 4);
      if (forest < L.forestCover[0]) continue;
      const conifer = rand() < L.farTrees.coniferRatio;
      if (s >= fromM && s < farToM) {
        farTrees.push({ s, d, kind: conifer ? 'conifer' : 'broadleaf', scale: 1.4 + rand() * 1.4, color: conifer ? CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)] : BROADLEAF_COLORS[Math.floor(rand() * BROADLEAF_COLORS.length)] });
      }
    }
  });

  // ガードレール(谷側)と擁壁(山側)は区間単位で有無を決める。
  forEachCell(fromM, toM, RUN_CELL_M, (i, cellS) => {
    const rand = cellRand(L, 3, i);
    if (rand() < L.guardrailChance) {
      guardrailRuns.push({ fromS: Math.max(fromM, cellS), toS: Math.min(toM, cellS + RUN_CELL_M) });
    }
  });
  if (L.walls) {
    forEachCell(fromM, toM, WALL_CELL_M, (i, cellS) => {
      const rand = cellRand(L, 4, i);
      if (rand() < 0.4) {
        const start = cellS + rand() * 60;
        const length = 50 + rand() * 90;
        const fromS = Math.max(fromM, start);
        const toS = Math.min(toM, start + length);
        if (toS > fromS) walls.push({ fromS, toS, heightM: 3 + rand() * 3 });
      }
    });
  }

  forEachCell(fromM, toM, DELINEATOR_SPACING_M, (i, cellS) => {
    if (L.delineators !== false && inRange(cellS)) {
      delineators.push({ s: cellS, d: -(edge - 0.3) });
      delineators.push({ s: cellS + DELINEATOR_SPACING_M / 2, d: edge - 0.3 });
    }
  });

  if (L.houses) {
    forEachCell(fromM, toM, HOUSE_CELL_M, (i, cellS) => {
      const rand = cellRand(L, 5, i);
      const [bandMin, bandMax] = L.houseBandM ?? [16, 76];
      const tries = L.houseBandM ? 6 : 1; // 熱海は斜面に家が密集する
      for (let k = 0; k < tries; k++) {
      if (rand() < (L.houseChance ?? 0.45)) {
        const s = cellS + rand() * HOUSE_CELL_M;
        const house = {
          s, d: edge + bandMin + rand() * (bandMax - bandMin), widthM: 7 + rand() * 4, depthM: 6 + rand() * 3, heightM: 3 + (rand() < 0.5 ? 2.8 : 0),
          yaw: (rand() - 0.5) * 0.5, wall: HOUSE_WALL_COLORS[Math.floor(rand() * HOUSE_WALL_COLORS.length)],
          roof: HOUSE_ROOF_COLORS[Math.floor(rand() * HOUSE_ROOF_COLORS.length)],
        };
        if (inRange(s)) houses.push(house);
      }
      }
    });
  }

  if (L.boats) {
    forEachCell(fromM, farToM, BOAT_CELL_M, (i, cellS) => {
      const rand = cellRand(L, 6, i);
      if (rand() < 0.6) {
        const s = cellS + rand() * BOAT_CELL_M;
        const boat = { s, d: -(edge + 250 + rand() * 650), yaw: rand() * Math.PI * 2, scale: 0.8 + rand() * 0.6 };
        if (s >= fromM && s < farToM) boats.push(boat);
      }
    });
  }

  const town = L.town ? collectAtamiObjects(L, fromM, toM, farToM) : null;
  return { trees, farTrees, rocks, houses, boats, guardrailRuns, walls, delineators, town };
}

// ---- 熱海サンビーチ ----

const ATAMI_LOOP_M = 6000; // 初島・熱海城は1周に1つずつ

/** 海側(遊歩道→護岸→砂浜→海底)と山側(歩道→ホテル敷地→市街地の急斜面→山並み)。 */
function atamiTerrainHeight(L, d, s, u, roadElevM, floorM) {
  const t = L.town;
  const seed = L.seed;
  if (d < 0) {
    const v = L.valley;
    if (u <= t.promenadeM) return roadElevM + 0.05; // 遊歩道(舗装の帯の下)
    // 砂浜の最上部(護岸の足元)。道路が高い所でも護岸は低く保ち、その分砂浜の傾きで
    // 海面まで下ろす(砂浜の幅は一定)。海岸線はゆるやかに出入りする
    const beachTop = Math.max(floorM + v.beachTopM, roadElevM - v.seawallHeightM) + (fbm(s / 260, 1.7, seed + 7, 3) - 0.5) * 0.6;
    const wallEnd = t.promenadeM + t.seawallM;
    if (u <= wallEnd) {
      const k = (u - t.promenadeM) / t.seawallM;
      return roadElevM + 0.05 + (beachTop - roadElevM - 0.05) * k;
    }
    const bu = u - wallEnd;
    const ripple = (valueNoise(s / 6, bu / 6, seed + 9) - 0.5) * 0.12;
    // 波打ち際より沖は海底へ(遠くほど深く)
    if (bu <= v.beachWidthM) return beachTop - ((beachTop - floorM) * bu) / v.beachWidthM + ripple;
    return floorM - Math.min(40, (bu - v.beachWidthM) * 0.05) + ripple;
  }
  if (u <= t.sidewalkM) return roadElevM + 0.05; // 歩道(舗装の帯の下)
  if (u <= t.sidewalkM + t.lotM) return roadElevM + 0.1; // ホテルの敷地
  const hu = u - t.sidewalkM - t.lotM;
  const h = L.hill;
  const rise = h.riseSlope * Math.min(hu, 500) + 0.12 * Math.max(0, hu - 500);
  const hills = h.hillAmpM * fbm(s / h.hillScaleM, hu / h.hillScaleM, seed + 41, 5) * smoothstep(0, 160, hu);
  const ridge = h.ridgeM * smoothstep(300, 1600, hu) * (0.5 + 0.7 * ridged(s / 700, hu / 700, seed + 43));
  const calm = 1 - 0.85 * castleCalmM(s, hu);
  return roadElevM + 0.1 + rise * smoothstep(0, 30, hu) + (hills + ridge) * calm + castleHillM(s, hu);
}

function atamiTerrainColor(L, d, s, h, floorM, normalY) {
  const t = L.town;
  const seed = L.seed;
  const edge = roadEdgeM(L);
  const u = Math.abs(d) - edge;
  const fine = (valueNoise(s / 9, d / 9, seed + 63) - 0.5) * 0.06;
  let rgb;
  if (d < 0) {
    const aboveFloor = h - floorM;
    if (u <= t.promenadeM + t.seawallM * 0.9) {
      rgb = [0.64 + fine, 0.62 + fine, 0.58 + fine]; // 遊歩道・護岸のコンクリート
    } else if (aboveFloor > 0.35) {
      rgb = [0.87 + fine, 0.79 + fine, 0.62 + fine]; // 乾いた砂浜
    } else if (aboveFloor > -0.3) {
      rgb = [0.68 + fine, 0.6 + fine, 0.47 + fine]; // 波打ち際の濡れた砂
    } else {
      rgb = [0.52, 0.5, 0.4]; // 海底の砂
    }
    return rgb.map(clamp01);
  }
  if (u <= t.sidewalkM + t.lotM) {
    rgb = atamiParkAt(L, s)
      ? [0.4 + fine, 0.56 + fine, 0.28 + fine] // 公園の芝生
      : [0.56 + fine, 0.56 + fine, 0.54 + fine]; // ホテル敷地の舗装
  } else {
    const hu = u - t.sidewalkM - t.lotM;
    // 斜面下部は家並み(屋根の灰色・ベージュ)が混じり、上へ行くほど森になる
    const town = smoothstep(0.38, 0.55, fbm(s / 160, d / 160, seed + 81, 3)) * smoothstep(420, 150, hu);
    const dense = smoothstep(L.forestCover[0], L.forestCover[1], fbm(s / 420, d / 420, seed + 67, 4));
    const green = [lerp(0.36, 0.16, dense), lerp(0.5, 0.3, dense), lerp(0.24, 0.15, dense)];
    const roofs = [0.62, 0.58, 0.52];
    rgb = green.map((c, i) => lerp(c, roofs[i], town * 0.75) + fine);
    const rockiness = smoothstep(0.6, 0.42, normalY);
    rgb = rgb.map((c, i) => lerp(c, [0.48, 0.46, 0.42][i], rockiness));
  }
  return rgb.map(clamp01);
}

const ATAMI_CASTLE_OFFSET_M = 4500;
const ATAMI_CASTLE_HU_M = 150; // 敷地の奥(斜面の始まり)から天守までの距離

/** 絶対距離sから最寄りの熱海城までの、進行方向の符号付き距離。 */
function toNearestCastleM(s) {
  const r = (((s - ATAMI_CASTLE_OFFSET_M) % ATAMI_LOOP_M) + ATAMI_LOOP_M) % ATAMI_LOOP_M;
  return r > ATAMI_LOOP_M / 2 ? r - ATAMI_LOOP_M : r;
}

/** 熱海城の建つ小山(周囲より一段高い岬状の丘)。 */
function castleHillM(s, hu) {
  const ds = toNearestCastleM(s);
  const dh = hu - ATAMI_CASTLE_HU_M;
  return 85 * Math.exp(-(ds * ds + dh * dh) / (2 * 90 * 90));
}

/** 熱海城の手前(道路側)の起伏を抑える割合(0〜1)。天守が道路から見通せるようにする。 */
function castleCalmM(s, hu) {
  const ds = toNearestCastleM(s);
  const dh = Math.max(0, hu - ATAMI_CASTLE_HU_M * 0.5) - ATAMI_CASTLE_HU_M * 0.5;
  return Math.exp(-(ds * ds) / (2 * 450 * 450) - (dh * dh) / (2 * 160 * 160));
}

/**
 * 海沿いのホテルが途切れて公園・広場(芝生とヤシ)になる区間か。山側の家並み・山並みが
 * 見通せるよう所々に設け、熱海城の手前(650m〜80m)は必ず開けて天守が見えるようにする。
 */
export function atamiParkAt(L, s) {
  const toCastle = (((ATAMI_CASTLE_OFFSET_M - s) % ATAMI_LOOP_M) + ATAMI_LOOP_M) % ATAMI_LOOP_M;
  if (toCastle > 80 && toCastle < 650) return true;
  return fbm(s / 520, 4.2, L.seed + 91, 3) < 0.4;
}

// ホテルの外壁の色味(白・アイボリー・ベージュ系。都市の外壁シェーダーに乗算される)
export const ATAMI_HOTEL_TINTS = [0xffffff, 0xf7f2e8, 0xefe6d6, 0xe8e4dc, 0xf4efe4, 0xdcd6cc];
export const ATAMI_HOTEL_STYLES = ['stucco', 'stucco', 'concrete', 'concrete', 'glass'];
export const PARASOL_COLORS = [0xe8412f, 0xf6f4ee, 0x2f6fd0, 0xf3c318, 0x2aa37a, 0xef7fa0];

/**
 * 熱海ならではの配置物: ヤシ並木・街灯・遊歩道の手すり・ホテル群・ビーチパラソル・
 * 突堤(防波堤)・初島・熱海城。すべて s/d で返す。
 */
function collectAtamiObjects(L, fromM, toM, farToM) {
  const t = L.town;
  const edge = roadEdgeM(L);
  const inRange = (s) => s >= fromM && s < toM;
  const palms = [];
  const lamps = [];
  const hotels = [];
  const parasols = [];
  const groins = [];
  const islands = [];
  const castles = [];
  const railRuns = [{ fromS: fromM, toS: toM, d: -(edge + t.promenadeM - 0.25) }];

  // ヤシ並木: 遊歩道の車道寄りに1列、山側の歩道にも1列
  forEachCell(fromM, toM, 11, (i, cellS) => {
    const rand = cellRand(L, 20, i);
    const s = cellS + (rand() - 0.5) * 1.2;
    if (inRange(s)) palms.push({ s, d: -(edge + 1.6), scale: 0.9 + rand() * 0.35, lean: (rand() - 0.5) * 0.12, yaw: rand() * Math.PI * 2 });
  });
  forEachCell(fromM, toM, 17, (i, cellS) => {
    const rand = cellRand(L, 21, i);
    if (rand() < 0.8 && inRange(cellS)) palms.push({ s: cellS, d: edge + 1.4, scale: 0.8 + rand() * 0.3, lean: (rand() - 0.5) * 0.1, yaw: rand() * Math.PI * 2 });
  });
  forEachCell(fromM, toM, 33, (i, cellS) => {
    const s = cellS + 5;
    if (inRange(s)) lamps.push({ s, d: -(edge + 5.2) });
  });

  // 海沿いのホテル(敷地に1棟ずつ)と、斜面を上っていくホテル・マンション
  forEachCell(fromM, toM, 34, (i, cellS) => {
    const rand = cellRand(L, 22, i);
    if (rand() < 0.88 && !atamiParkAt(L, cellS + 17)) {
      const widthM = 18 + rand() * 12;
      const depthM = 14 + rand() * 10;
      const s = cellS + 17 + (rand() - 0.5) * 4;
      const floors = rand() < 0.25 ? 4 + Math.floor(rand() * 3) : 8 + Math.floor(rand() * 13);
      const hotel = {
        s, d: edge + t.sidewalkM + 3 + depthM / 2 + rand() * 6, widthM, depthM, floors,
        style: ATAMI_HOTEL_STYLES[Math.floor(rand() * ATAMI_HOTEL_STYLES.length)],
        tint: ATAMI_HOTEL_TINTS[Math.floor(rand() * ATAMI_HOTEL_TINTS.length)], hillside: false,
      };
      if (inRange(s)) hotels.push(hotel);
    }
  });
  forEachCell(fromM, toM, 40, (i, cellS) => {
    const rand = cellRand(L, 23, i);
    const count = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < count; k++) {
      const hu = 8 + rand() * 260;
      const cs = toNearestCastleM(cellS + 20);
      if (Math.hypot(cs, hu - ATAMI_CASTLE_HU_M) < 120) continue; // 天守の周りは建物を建てない
      const widthM = 12 + rand() * 12;
      const depthM = 10 + rand() * 8;
      const s = cellS + rand() * 40;
      const floors = Math.max(3, Math.round((14 - hu / 25) * (0.5 + rand() * 0.6)));
      const hotel = {
        s, d: edge + t.sidewalkM + t.lotM + hu, widthM, depthM, floors,
        style: ATAMI_HOTEL_STYLES[Math.floor(rand() * ATAMI_HOTEL_STYLES.length)],
        tint: ATAMI_HOTEL_TINTS[Math.floor(rand() * ATAMI_HOTEL_TINTS.length)], hillside: true,
      };
      if (inRange(s)) hotels.push(hotel);
    }
  });

  // 砂浜のパラソル
  const beachStart = edge + t.promenadeM + t.seawallM;
  forEachCell(fromM, toM, 20, (i, cellS) => {
    const rand = cellRand(L, 24, i);
    const count = Math.floor(rand() * 4);
    for (let k = 0; k < count; k++) {
      const s = cellS + rand() * 20;
      const p = { s, d: -(beachStart + 5 + rand() * 38), color: PARASOL_COLORS[Math.floor(rand() * PARASOL_COLORS.length)], tilt: (rand() - 0.5) * 0.25 };
      if (inRange(s)) parasols.push(p);
    }
  });

  // 突堤(砂浜から沖へ伸びる防波堤)
  forEachCell(fromM, farToM, 320, (i, cellS) => {
    const s = cellS + 160;
    if (s >= fromM && s < farToM) groins.push({ s, fromD: -(beachStart + 20), toD: -(beachStart + 150) });
  });

  // 初島(沖合の平たい島)と熱海城(山の上の天守閣)。遠くからでも見えるよう広い範囲で拾う
  forEachCell(fromM - 6000, farToM + 8000, ATAMI_LOOP_M, (i, cellS) => {
    islands.push({ s: cellS + 2400, d: -5200 });
    castles.push({ s: cellS + ATAMI_CASTLE_OFFSET_M, d: edge + t.sidewalkM + t.lotM + ATAMI_CASTLE_HU_M });
  });

  return { palms, lamps, hotels, parasols, groins, islands, castles, railRuns };
}
