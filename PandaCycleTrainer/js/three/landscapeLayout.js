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
import { tourTerrainHeight, tourTerrainColor, collectTourObjects, tourTreeAllowed } from './tourLayout.js';

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
  // ---- 観光地コース(tourLayout.js が地形の起伏・色、町並み・名物の配置を担う) ----
  // 京都・東山: 石畳の細い通りの両側に京町家が軒を連ね、東(右)は紅葉の東山、西(左)は
  // 京都盆地の瓦屋根が西山まで続く。祇園白川(柳並木の小川)・円山公園・神宮道の並木道がある。
  kyoto: {
    id: 'kyoto',
    seed: 4517,
    roadHalfWidthM: 3.0,
    shoulderM: 0.4,
    centerLine: 'none',
    roadStyle: 'stone',
    curves: [
      { ampM: 14, lenM: 1100, phase: 0.8 },
      { ampM: 4, lenM: 380, phase: 2.6 },
    ],
    tour: {
      kind: 'kyoto',
      terrain: true,
      loopM: 8000,
      sidewalkM: 1.5, // 道路脇の石畳の歩道
      rowDepthM: 11, // 通り沿いの町家の奥行き
      avenue: { fromM: 250, toM: 1250 }, // 神宮道(平安神宮の大鳥居の並木道)
      park: { fromM: 1950, toM: 2350 }, // 円山公園(右側)
      canal: { fromM: 2950, toM: 3650, fromU: 1.4, toU: 6.2 }, // 祇園白川(左側)
      vista: { fromM: 6700, toM: 7250 }, // 五条坂から西の眺め(左側に町家がなく、京都タワーが見える)
      hill: { baseU: 190, nearU: 18, nearAtM: 5250, nearHalfM: 650, riseSlope: 0.32, hillAmpM: 70, ridgeM: 210 }, // 東山
      westHills: { startU: 2300, heightM: 260 }, // 西山
      tower: { atM: 400, d: -1300 }, // 京都タワー(五条坂の眺めの左前方。1周の始まりのすぐ先)
    },
    valley: { minDropM: 40 }, // 水面(湖)は使わない。地形より十分低く隠しておく
    hill: {},
    treeline: null,
    snowline: null,
    trees: { valley: 0, hill: 0, coniferRatio: 0.35, maxLateralM: 140, maxSlope: 1.3 },
    farTrees: { density: 1.6, coniferRatio: 0.45, maxLateralM: 1500, sides: [1] },
    broadleafColors: [0x4a6b2f, 0x3f5f2a, 0x56793a, 0xc8361d, 0xd9541e, 0xe08a1c, 0xb02a1a, 0xd8b02a],
    guardrailChance: 0,
    delineators: false,
    houses: false,
    boats: false,
    walls: false,
    rocks: 0,
    rockMaxM: 1,
    forestCover: [0.36, 0.52],
  },
  // 奈良公園: 芝生の公園に大きな木と鹿の群れ。東(右)は春日山の森と若草山、西(左)は奈良の町並み。
  // 猿沢池・鷺池(浮見堂)、春日大社の参道(石灯籠と杉並木)がある。
  nara: {
    id: 'nara',
    seed: 5381,
    roadHalfWidthM: 3.3,
    shoulderM: 0.8,
    centerLine: 'white-dashed',
    curves: [
      { ampM: 18, lenM: 1000, phase: 0.4 },
      { ampM: 5, lenM: 360, phase: 1.7 },
    ],
    tour: {
      kind: 'nara',
      terrain: true,
      loopM: 6000,
      ponds: [
        { atM: 700, u: 42, rAlongM: 60, rLatM: 34, willows: true }, // 猿沢池(左側)
        { atM: 4750, u: 42, rAlongM: 80, rLatM: 30, willows: false }, // 鷺池と浮見堂(左側)
      ],
      wakakusa: { atM: 2700, u: 650, hM: 250, rAlongM: 430, rLatM: 270 }, // 若草山(右側)
      sando: { fromM: 3330, toM: 4250 }, // 春日大社の参道
      forestU: 330, // 東の春日山の森の始まり
      townU: 520, // 西の奈良の町並みの始まり
    },
    valley: { minDropM: 40 },
    hill: {},
    treeline: null,
    snowline: null,
    trees: { valley: 0, hill: 0, coniferRatio: 0.3, maxLateralM: 160, maxSlope: 1.2 },
    farTrees: { density: 1.8, coniferRatio: 0.5, maxLateralM: 1500, sides: [1] },
    broadleafColors: [0x3f5f2a, 0x4a6b2f, 0x56793a, 0x34552a, 0x5c7a34, 0xc8461d, 0xd8a52a],
    guardrailChance: 0,
    delineators: false,
    houses: false,
    boats: false,
    walls: false,
    rocks: 0,
    rockMaxM: 1,
    forestCover: [0.34, 0.5],
  },
  // 河口湖: 湖畔(lakeside)の地形のまま、湖を近くし、紅葉の木・もみじ回廊・河口湖大橋・遊覧船を足す。
  kawaguchiko: {
    id: 'kawaguchiko',
    seed: 6007,
    roadHalfWidthM: 3.5,
    shoulderM: 1.1,
    centerLine: 'white-dashed',
    curves: [
      { ampM: 22, lenM: 900, phase: 0.3 },
      { ampM: 8, lenM: 350, phase: 1.9 },
    ],
    tour: {
      kind: 'kawaguchiko',
      terrain: false,
      loopM: 20000,
      bridge: { atM: 9000, fromU: 40, toU: 1450 }, // 河口湖大橋(左の湖を渡る)
      steamers: [{ atM: 11800, u: 300 }], // 遊覧船
      momiji: { fromM: 12700, toM: 13700 }, // もみじ回廊(右側)
    },
    valley: {
      bankSlope: 0.5,
      bankCurve: 0.012,
      bankNoiseM: 3,
      minDropM: 18, // 湖畔のすぐ上を走る
      bedDepthM: 7,
      farShoreM: 1450, // 対岸までの距離(河口湖は幅1km余り)
      farShoreJitterM: 260,
      farHillM: 240,
    },
    hill: {
      cutSlope: 0.55,
      cutWidthM: 4,
      riseSlope: 0.12,
      hillAmpM: 70,
      hillScaleM: 320,
      hillRampM: 80,
    },
    treeline: null,
    snowline: null,
    trees: { valley: 1.0, hill: 2.2, coniferRatio: 0.3, maxLateralM: 110, maxSlope: 1.1 },
    farTrees: { density: 1.8, coniferRatio: 0.4, maxLateralM: 1500 },
    // 秋の河口湖(紅葉・黄葉を3割ほど混ぜる)
    broadleafColors: [0x4a6b2f, 0x56793a, 0x3f5f2a, 0x66843f, 0x5c7a34, 0x4a6b2f, 0xc8361d, 0xe0761c, 0xd8b02a],
    guardrailChance: 0.45,
    houses: true,
    boats: true,
    walls: false,
    rocks: 0.1,
    rockMaxM: 1.2,
    forestCover: [0.44, 0.58],
  },
  // 竜宮城の海底(ryuguLayout.js が地形の起伏・色、サンゴ・昆布・魚などの配置を担う)。水面は使わず、
  // 空は水面を見上げた海の色(LandscapeScene の ATMOSPHERE.ryugu、underwater)。左は海溝、右は岩山。
  ryugu: {
    id: 'ryugu',
    seed: 7193,
    roadHalfWidthM: 3.2,
    shoulderM: 0.6,
    centerLine: 'none',
    roadStyle: 'sand',
    underwater: true,
    curves: [
      { ampM: 16, lenM: 1000, phase: 0.9 },
      { ampM: 5, lenM: 360, phase: 2.4 },
    ],
    tour: {
      kind: 'ryugu',
      terrain: true,
      loopM: 6000,
      sandM: 6, // 道路脇の平らな白い砂の幅(路肩外縁から)
      hillU: 120, // 右の岩山の始まり
      kelp: { fromM: 2550, toM: 3450 }, // 昆布の林
      ship: { atM: 3950, u: 34 }, // 沈没船(左側)
      trench: { fromM: 4200, toM: 4950, baseU: 170, nearU: 26, depthM: 160 }, // 海溝の縁(左側)
      stage: { atM: 2250, d: -15.7 }, // 乙姫の舞台(コースプロファイルの landmarks と同じ位置)
    },
    valley: { minDropM: 400 }, // 水面は使わない。海底より十分低く隠しておく
    hill: {},
    treeline: null,
    snowline: null,
    trees: { valley: 0, hill: 0, coniferRatio: 0, maxLateralM: 100, maxSlope: 1 },
    farTrees: { density: 0, coniferRatio: 0, maxLateralM: 1000 },
    guardrailChance: 0,
    delineators: false,
    houses: false,
    boats: false,
    walls: false,
    rocks: 0.5,
    rockMaxM: 2.6,
    forestCover: [1, 1],
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
 * opts.fixedLength(ループしない GPX の実在コース)では、終点より先は道路が平坦になるので
 * 水面/谷底も終点の高さで止める(トレンドのまま上り続けると道路が水没する)。
 */
export function createFloorModel(sampler, loopLengthM, minDropM, opts = {}) {
  const clampEnd = !!opts.fixedLength;
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
      const t = clampEnd ? Math.min(s, loopLengthM) : s;
      return ratePerM * t + minDeviation - minDropM;
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
export function ridged(x, y, seed, octaves = 5) {
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

export function smoothstep(e0, e1, x) {
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
  if (L.tour?.terrain) return tourTerrainHeight(L, d, s, u, roadElevM, floorM);

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
  if (L.tour?.terrain) return tourTerrainColor(L, d, s, h, floorM, normalY);
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

export function cellRand(L, kind, index) {
  return mulberry32((L.seed * 7919) ^ (kind * 104729) ^ Math.imul(index, 2654435761));
}

export function forEachCell(fromM, toM, cellM, fn) {
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
  // 秋の景色などで広葉樹の色を変える景色がある(乱数の使い方は同じなので、ほかの景色の見た目は変わらない)
  const broadleaf = L.broadleafColors ?? BROADLEAF_COLORS;

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
          color: conifer ? CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)] : broadleaf[Math.floor(rand() * broadleaf.length)],
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
      if (L.farTrees.sides && !L.farTrees.sides.includes(side)) continue; // 町並みの側には森を置かない
      const conifer = rand() < L.farTrees.coniferRatio;
      if (s >= fromM && s < farToM) {
        farTrees.push({ s, d, kind: conifer ? 'conifer' : 'broadleaf', scale: 1.4 + rand() * 1.4, color: conifer ? CONIFER_COLORS[Math.floor(rand() * CONIFER_COLORS.length)] : broadleaf[Math.floor(rand() * broadleaf.length)] });
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
      const tries = L.houseBandM ? 6 : 1; // houseBandM のある景色は斜面に家が密集する
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

  // 観光地コースの町並み・名物。木と家はふつうの木・家と同じ形で返し、同じプールで描く
  const tour = L.tour ? collectTourObjects(L, fromM, toM, farToM) : null;
  if (tour) {
    trees.push(...tour.trees);
    houses.push(...tour.houses);
    const ok = (t) => tourTreeAllowed(L, t.s, t.d);
    return { trees: trees.filter(ok), farTrees: farTrees.filter(ok), rocks, houses, boats, guardrailRuns, walls, delineators, tour };
  }
  return { trees, farTrees, rocks, houses, boats, guardrailRuns, walls, delineators, tour };
}
