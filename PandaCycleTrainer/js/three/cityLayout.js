// 3D都市シーンの「街並み生成」ロジック(Three.js非依存の純粋関数)。
// レンダリングコード(js/ui/CityScene.js)から分離してあるのは、
// Node上でWebGLなしにユニットテストできるようにするため。
//
// 街はBLOCK_LENGTH_Mごとの「ブロック(街区)」の繰り返しで表現する。
// 各ブロックの先頭 INTERSECTION_LENGTH_M は交差点(横断歩道+交差道路+横断歩道)、
// 残りに沿道の建物・街路樹・街灯・路上駐車車両を配置する。
// 配置は blockIndex から決定的に導出するシード付き疑似乱数(mulberry32)で決めるため、
// 同じブロックは何度呼んでも同じ配置になる(毎フレーム再計算しても
// 結果がちらつかない)。
//
// 座標の約束:
//   - alongBlockM / alongM : 道路に沿った距離(進行方向が正)
//   - xOffsetM             : 道路中心からの横方向オフセット(side=-1が左、+1が右)
//   - 建物の width は「道路に沿った間口」(進行方向の長さ)、depth は奥行き(横方向)

// ---- 道路断面(m) ----
export const ROAD_HALF_WIDTH_M = 4; // 片側1車線ずつの2車線道路
export const SIDEWALK_WIDTH_M = 4;
export const CURB_HEIGHT_M = 0.15;
export const SIDEWALK_OUTER_M = ROAD_HALF_WIDTH_M + SIDEWALK_WIDTH_M;

// ---- 街区 ----
export const BLOCK_LENGTH_M = 64;
export const CROSSWALK_LENGTH_M = 4;
export const CROSS_STREET_WIDTH_M = 10;
// 交差点帯: [0, 4) 横断歩道 / [4, 14) 交差道路 / [14, 18) 横断歩道
export const INTERSECTION_LENGTH_M = CROSSWALK_LENGTH_M * 2 + CROSS_STREET_WIDTH_M;
// 沿道の建物・設置物を置ける区間(交差点帯の後ろ〜次ブロック手前)
export const FRONTAGE_START_M = INTERSECTION_LENGTH_M + 1;
export const FRONTAGE_END_M = BLOCK_LENGTH_M - 1;

// ---- 建物 ----
export const FLOOR_HEIGHT_M = 3.3;
export const BUILDING_STYLES = ['brick', 'concrete', 'glass', 'stucco'];
// 奥の列(スカイライン)の建物の、道路中心からの最小距離
export const BACK_ROW_MIN_OFFSET_M = 30;

// 建物ごとのわずかな色味の揺らぎ(テクスチャに乗算する、ほぼ白の色)。
const FACADE_TINTS = {
  brick: [0xffffff, 0xf2e6dc, 0xe8d8cc, 0xfff4ec],
  concrete: [0xffffff, 0xeeeeea, 0xe4e2dc, 0xf6f2ea],
  glass: [0xffffff, 0xe6eef6, 0xeef4f2, 0xf2f2f8],
  stucco: [0xfff8ee, 0xf6ecdc, 0xeef0e8, 0xf8efe6, 0xe8e2d8],
};

// 路上駐車車両の現実的なボディカラー(白・黒・シルバー系が大半)。
export const CAR_COLORS = [
  0xf4f4f2, 0xf4f4f2, 0xeae9e4, 0x1b1c1f, 0x2a2c30, 0x9da1a6, 0xb9bcc0,
  0x6b7076, 0x7a1f24, 0x1f3552, 0x3b4a3a, 0x8a7a62,
];
export const CAR_LENGTH_M = 4.4;
export const CAR_WIDTH_M = 1.75;

export const TREE_LEAF_COLORS = [0x4f6f35, 0x5a7d3a, 0x44642e, 0x66843f, 0x3d5a2b];

/**
 * mulberry32疑似乱数生成器。seedが同じなら常に同じ数列を返す。
 * @param {number} seed
 * @returns {() => number} 0以上1未満の乱数を返す関数
 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

function range(rand, min, max) {
  return min + rand() * (max - min);
}

function pickFloors(rand, row) {
  const r = rand();
  if (row === 'front') {
    // 沿道は低〜中層が中心。たまに高層。
    if (r < 0.55) return 2 + Math.floor(rand() * 4); // 2〜5階
    if (r < 0.9) return 6 + Math.floor(rand() * 5); // 6〜10階
    return 12 + Math.floor(rand() * 10); // 12〜21階
  }
  // 奥の列はスカイラインを作るため高め。
  if (r < 0.4) return 6 + Math.floor(rand() * 6);
  if (r < 0.8) return 12 + Math.floor(rand() * 10);
  return 22 + Math.floor(rand() * 14);
}

function pickStyle(rand, floors) {
  const r = rand();
  if (floors >= 12) return r < 0.6 ? 'glass' : 'concrete';
  if (floors >= 6) return r < 0.45 ? 'concrete' : r < 0.7 ? 'brick' : r < 0.85 ? 'glass' : 'stucco';
  return r < 0.35 ? 'stucco' : r < 0.7 ? 'brick' : 'concrete';
}

function makeRoofUnits(rand) {
  // 屋上設備(空調室外機・塔屋・給水タンク)を屋上面の相対座標(-0.5〜0.5)で返す。
  const units = [];
  const count = Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    units.push({
      u: range(rand, -0.3, 0.3),
      v: range(rand, -0.3, 0.3),
      sizeX: range(rand, 1.2, 3.2),
      sizeY: range(rand, 0.8, 2.6),
      sizeZ: range(rand, 1.2, 3.2),
    });
  }
  return units;
}

function makeBuilding(rand, { side, alongBlockM, width, row, frontOffsetM }) {
  const floors = pickFloors(rand, row);
  const style = pickStyle(rand, floors);
  const depth = row === 'front' ? range(rand, 10, 18) : range(rand, 14, 26);
  return {
    side,
    row,
    alongBlockM,
    xOffsetM: side * (frontOffsetM + depth / 2),
    width,
    depth,
    floors,
    height: floors * FLOOR_HEIGHT_M,
    style,
    tint: pick(rand, FACADE_TINTS[style]),
    // 沿道の建物の多くは1階が店舗(ガラス張りのショーウィンドウ+日よけ)。
    storefront: row === 'front' && rand() < 0.7,
    roofUnits: makeRoofUnits(rand),
  };
}

/**
 * 区間[start, end)を、間口 minW〜maxW の建物で端から順に埋める。
 * @returns {Array<{alongBlockM: number, width: number}>}
 */
function fillFrontage(rand, start, end, minW, maxW, maxGap) {
  const lots = [];
  let cursor = start;
  while (end - cursor >= minW) {
    const width = Math.min(range(rand, minW, maxW), end - cursor);
    lots.push({ alongBlockM: cursor + width / 2, width });
    cursor += width + rand() * maxGap;
  }
  return lots;
}

/**
 * ブロック番号から、そのブロック内の建物・街路樹・街灯・駐車車両の配置を
 * 決定的に生成する。各要素の位置はブロック内相対距離(alongBlockM: 0〜BLOCK_LENGTH_M)
 * で返す。呼び出し側でブロック開始位置を加算し、絶対距離(alongM)に変換する。
 *
 * @param {number} blockIndex 0, 1, 2, ... (負値も可: 走行開始前の後方ブロック)
 */
export function generateBlock(blockIndex) {
  // 整数以外/巨大値でも安定するよう、シードはビット演算前提のUint32に丸める。
  const seed = (Math.imul(blockIndex | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  const rand = mulberry32(seed);

  const buildings = [];
  for (const side of [-1, 1]) {
    // 沿道の列: 歩道の外縁ぎりぎり(0〜1.5mのセットバック)に隙間少なく並べる。
    for (const lot of fillFrontage(rand, FRONTAGE_START_M, FRONTAGE_END_M, 8, 15, 1.2)) {
      buildings.push(makeBuilding(rand, {
        side, row: 'front', alongBlockM: lot.alongBlockM, width: lot.width,
        frontOffsetM: SIDEWALK_OUTER_M + rand() * 1.5,
      }));
    }
    // 奥の列: 遠景のスカイライン。
    for (const lot of fillFrontage(rand, FRONTAGE_START_M, FRONTAGE_END_M, 12, 24, 4)) {
      if (rand() < 0.2) continue;
      buildings.push(makeBuilding(rand, {
        side, row: 'back', alongBlockM: lot.alongBlockM, width: lot.width,
        frontOffsetM: BACK_ROW_MIN_OFFSET_M + rand() * 12,
      }));
    }
  }

  // 街灯: 両側に約20m間隔、左右で半ピッチずらす。
  const lamps = [];
  for (const side of [-1, 1]) {
    const phase = side < 0 ? 0 : 10;
    for (let a = FRONTAGE_START_M + 2 + phase; a < FRONTAGE_END_M; a += 20) {
      lamps.push({ side, alongBlockM: a, xOffsetM: side * (ROAD_HALF_WIDTH_M + 0.45) });
    }
  }

  // 街路樹: 車道寄りに約9m間隔。街灯と重なる位置は避ける。
  const trees = [];
  for (const side of [-1, 1]) {
    for (let a = FRONTAGE_START_M + 1; a < FRONTAGE_END_M - 1; a += 9) {
      const alongBlockM = a + rand() * 1.5;
      if (rand() < 0.15) continue; // たまに欠けている方が自然
      if (lamps.some((l) => l.side === side && Math.abs(l.alongBlockM - alongBlockM) < 2.5)) continue;
      trees.push({
        side,
        alongBlockM,
        xOffsetM: side * (ROAD_HALF_WIDTH_M + 1.3),
        scale: range(rand, 0.85, 1.25),
        leafColor: pick(rand, TREE_LEAF_COLORS),
        seed: Math.floor(rand() * 1e6),
      });
    }
  }

  // 路上駐車: 対向車線側(右側)の路肩のみ。ライダーは左車線を走る(左側通行)。
  const cars = [];
  let cursor = FRONTAGE_START_M + rand() * 6;
  while (cursor + CAR_LENGTH_M < FRONTAGE_END_M) {
    if (rand() < 0.55) {
      cars.push({
        side: 1,
        alongBlockM: cursor + CAR_LENGTH_M / 2,
        xOffsetM: ROAD_HALF_WIDTH_M - 0.35 - CAR_WIDTH_M / 2,
        color: pick(rand, CAR_COLORS),
      });
    }
    cursor += CAR_LENGTH_M + range(rand, 1.2, 6);
  }

  return { buildings, trees, lamps, cars };
}

/**
 * 指定した絶対距離レンジ[fromM, toM)に含まれる建物・街路樹・街灯・駐車車両と
 * 交差点を、ブロックをまたいで列挙する。各要素の位置は絶対距離(alongM)で返す。
 * 交差点は開始位置(alongM)で返し、帯の一部でもレンジに掛かっていれば含める。
 */
export function collectSceneObjects(fromM, toM) {
  const result = { buildings: [], trees: [], lamps: [], cars: [], intersections: [] };
  const firstBlock = Math.floor(fromM / BLOCK_LENGTH_M);
  const lastBlock = Math.floor(toM / BLOCK_LENGTH_M);
  for (let b = firstBlock; b <= lastBlock; b++) {
    const block = generateBlock(b);
    const blockStartM = b * BLOCK_LENGTH_M;
    for (const key of ['buildings', 'trees', 'lamps', 'cars']) {
      for (const item of block[key]) {
        const alongM = blockStartM + item.alongBlockM;
        if (alongM >= fromM && alongM < toM) result[key].push({ ...item, alongM });
      }
    }
    if (blockStartM + INTERSECTION_LENGTH_M > fromM && blockStartM < toM) {
      result.intersections.push({ alongM: blockStartM });
    }
  }
  return result;
}
