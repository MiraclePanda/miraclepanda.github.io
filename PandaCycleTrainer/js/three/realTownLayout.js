// 実在の街の観光地コース(京都・東山/奈良公園/富士山・河口湖)のデータの読み込みと、配置の計算。
// Three.js・DOM に依存しない純粋関数(test/unit から読める)。描画は js/ui/RealTownScene.js。
//
// データ(js/data/<id>-town.json)は tools/real-towns/build.py が作る。形は熱海(atamiRealLayout.js)と同じで、
// 加えて route.mode('outback' = 往復 / 'loop' = 周回)と waters(湖・池の水面)を持つ。
// 建物は PLATEAU の建築物 LOD1(京都)、または PLATEAU の無い所では国土地理院の建築物の外周線に
// 種類から推定した高さを付けたもの(奈良・河口湖)。
//
// 座標は熱海と同じ: 原点 = スタート地点、x = 東(m)、y = 北(m)、z = 標高(m)。シーンでは (x, z, −y)。

import { decodeAtamiData, gridHeight, buildingLook } from './atamiRealLayout.js';

/** 実在の街のコース(景色の id → データの URL と見た目の設定)。 */
export const REAL_TOWNS = {
  // 京都・東山: 町家の瓦屋根と、東山の紅葉の森
  kyoto: {
    url: new URL('../data/kyoto-town.json', import.meta.url).href,
    label: '京都・東山',
    palette: 'autumn',
    forest: { flat: 0.05, slope: 0.85, minSlopeY: 0.985 },
    fog: 0.00022,
  },
  // 奈良公園: 芝生と大きな木がまばらに立つ公園、春日山の森
  nara: {
    url: new URL('../data/nara-town.json', import.meta.url).href,
    label: '奈良公園',
    palette: 'park',
    forest: { flat: 0.16, slope: 0.85, minSlopeY: 0.99 },
    fog: 0.0002,
  },
  // 富士山・河口湖: 湖畔の紅葉と、約18km 先の富士山まで見通せる澄んだ空気(フォグをごく薄く)
  kawaguchiko: {
    url: new URL('../data/fuji-town.json', import.meta.url).href,
    label: '河口湖',
    palette: 'autumn',
    forest: { flat: 0.08, slope: 0.8, minSlopeY: 0.99 },
    fog: 0.00003,
  },
};

const cache = new Map();

/** データ(build.py の JSON)→ 使いやすい形。熱海の形に waters を足したもの。 */
export function decodeTownData(raw) {
  const d = decodeAtamiData(raw);
  d.waters = (raw.waters ?? []).map((w) => ({ level: w.level, grid: w.grid, rows: w.rows ?? [], x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
  d.id = raw.id;
  // 格子の頂点ごとの水面の番号(+1。0 = 陸)。近景(terrain)と遠景(outer)の格子それぞれ
  d.waterMask = { inner: waterMaskOf(d.terrain, d.waters, 'inner'), outer: waterMaskOf(d.outer, d.waters, 'outer') };
  return d;
}

function waterMaskOf(grid, waters, name) {
  const m = new Uint16Array(grid.nx * grid.ny);
  waters.forEach((w, k) => {
    if (w.grid !== name) return;
    for (const [j, i0, i1] of w.rows) for (let i = i0; i <= i1; i++) m[j * grid.nx + i] = k + 1;
  });
  return m;
}

function maskAt(grid, mask, x, y) {
  const i = Math.round((x - grid.x0) / grid.step);
  const j = Math.round((y - grid.y0) / grid.step);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return -1;
  return mask[j * grid.nx + i];
}

/** 地点 (x, y) の水面(湖・池)の番号(data.waters の添字)。陸なら −1。近景の格子の範囲は近景で判定する。 */
export function waterIndexAt(data, x, y) {
  const v = maskAt(data.terrain, data.waterMask.inner, x, y);
  if (v >= 0) return v - 1;
  const o = maskAt(data.outer, data.waterMask.outer, x, y);
  return o > 0 ? o - 1 : -1;
}

/**
 * 水面のメッシュにする格子のセル(地図座標の矩形 [x0, y0, x1, y1] の配列)。水面の頂点を1つでも含むセル。
 * 岸のセルでは水面が岸の斜面と交わって、水際の線になる。
 */
export function waterCells(data, index) {
  const w = data.waters[index];
  const grid = w.grid === 'outer' ? data.outer : data.terrain;
  const { nx, ny, step, x0, y0 } = grid;
  const seen = new Uint8Array(nx * ny);
  const out = [];
  for (const [j, i0, i1] of w.rows) {
    for (let i = i0; i <= i1; i++) {
      for (let cj = j - 1; cj <= j; cj++) {
        for (let ci = i - 1; ci <= i; ci++) {
          if (ci < 0 || cj < 0 || ci >= nx - 1 || cj >= ny - 1) continue;
          const k = cj * nx + ci;
          if (seen[k]) continue;
          seen[k] = 1;
          // 遠景の水面のうち近景の範囲の中は、近景の格子(と水面)が描く
          if (w.grid === 'outer') {
            const cx = x0 + (ci + 0.5) * step;
            const cy = y0 + (cj + 0.5) * step;
            const t = data.terrain;
            if (cx > t.x0 && cx < t.x0 + (t.nx - 1) * t.step && cy > t.y0 && cy < t.y0 + (t.ny - 1) * t.step) continue;
          }
          out.push([x0 + ci * step, y0 + cj * step, x0 + (ci + 1) * step, y0 + (cj + 1) * step]);
        }
      }
    }
  }
  return out;
}

/** コースのデータを読む(コースごとに1回だけ。失敗したら次の走行でやり直す)。 */
export function loadTownData(id, fetchImpl = globalThis.fetch) {
  const town = REAL_TOWNS[id];
  if (!town) return Promise.reject(new Error(`unknown town: ${id}`));
  if (!cache.has(id)) {
    const p = fetchImpl(town.url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${town.url}`);
        return res.json();
      })
      .then(decodeTownData)
      .catch((err) => {
        cache.delete(id);
        throw err;
      });
    cache.set(id, p);
  }
  return cache.get(id);
}

// 低い家の屋根の色: 瓦(京都・奈良)、トタン・ガルバリウムの色とりどりの屋根(河口湖)
const TILE_ROOFS = [0x3a3d42, 0x45484d, 0x2f3236, 0x50535a, 0x3d3a36];
const METAL_ROOFS = [0x34466b, 0x7a3b2a, 0x4d5a3a, 0x5b4a3a, 0x3a3d42, 0x2f5a5a];
const HOUSE_TINTS = [0xf3eee4, 0xe8dfcf, 0xdcd2bf, 0xf6f4ef, 0xcfc4ae, 0xe4e0d8];

function hash01(i, salt) {
  let h = Math.imul((i + 1) | 0, 2654435761) ^ Math.imul(salt | 0, 0x5bd1e995);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function ringArea(ring) {
  let a = 0;
  for (let k = 0; k < ring.length; k++) {
    const [x1, y1] = ring[k];
    const [x2, y2] = ring[(k + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * 建物の見た目(決定的)。高さ 10.5m 未満・床面積 400m² 未満の低い建物は戸建て・町家として切妻屋根(gable)にし、
 * 京都では半分ほどを京町家(格子の外壁 'machiya')にする。それ以外は熱海と同じ buildingLook。
 */
export function townBuildingLook(town, b, index) {
  const low = b.height < 10.5 && ringArea(b.ring) < 400;
  if (!low) return { ...buildingLook(b, index), gable: false };
  const machiya = town === 'kyoto' && hash01(index, 11) < 0.55;
  const roofs = town === 'kawaguchiko' ? METAL_ROOFS : TILE_ROOFS;
  return {
    style: machiya ? 'machiya' : 'house',
    tint: machiya ? 0xffffff : HOUSE_TINTS[Math.floor(hash01(index, 23) * HOUSE_TINTS.length)],
    roof: roofs[Math.floor(hash01(index, 37) * roofs.length)],
    house: true,
    gable: true,
  };
}

/** 地点 (x, y) が湖・池なら、その水位。陸なら null。 */
export function waterLevelAt(data, x, y) {
  const k = waterIndexAt(data, x, y);
  return k >= 0 ? data.waters[k].level : null;
}

// 地面の色(sRGB 0..1)。palette ごとの森・草地・街の色
const PALETTES = {
  autumn: { grass: [0.42, 0.5, 0.26], forest: [0.33, 0.36, 0.19], town: [0.58, 0.56, 0.52], shore: [0.55, 0.5, 0.42] },
  park: { grass: [0.45, 0.58, 0.27], forest: [0.24, 0.36, 0.17], town: [0.6, 0.58, 0.53], shore: [0.5, 0.47, 0.38] },
};

/**
 * 地形の格子の頂点の色。builtUp = 建物の密度(0..1)、depth = 水面からの深さ(m、水中なら正)、forest = 森の度合い(0..1)。
 */
export function townGroundColor(palette, normalY, builtUp, depth, forest, noise) {
  const P = PALETTES[palette] ?? PALETTES.autumn;
  const n = (noise - 0.5) * 0.06;
  if (depth > 0.3) return [0.36 + n, 0.36 + n, 0.3 + n]; // 水底の泥
  if (depth > -0.8) return P.shore.map((v) => v + n); // 水際
  let rgb = P.grass.map((g, i) => g + (P.forest[i] - g) * forest);
  // 街なか(建物の多い所)は舗装・砂利の色。建物の割合が低めでも街の色になるよう強めに効かせる
  const k = Math.min(1, builtUp * 2.4);
  rgb = rgb.map((v, i) => v + (P.town[i] - v) * k + n);
  const rock = Math.min(1, Math.max(0, (0.62 - normalY) / 0.2));
  rgb = rgb.map((v, i) => v + ([0.45, 0.43, 0.39][i] - v) * rock);
  return rgb.map((v) => Math.min(1, Math.max(0, v)));
}

/**
 * 格子の上の距離(セル単位)の近似(2回走査のチャンファー距離)。seed のセルが 0。
 * @param {Uint8Array} seed 1 = 起点
 */
export function chamferDistance(seed, nx, ny) {
  const INF = 1e9;
  const d = new Float32Array(nx * ny);
  for (let k = 0; k < d.length; k++) d[k] = seed[k] ? 0 : INF;
  const D = Math.SQRT2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - nx] + 1);
        if (i > 0) v = Math.min(v, d[k - nx - 1] + D);
        if (i < nx - 1) v = Math.min(v, d[k - nx + 1] + D);
      }
      d[k] = v;
    }
  }
  for (let j = ny - 1; j >= 0; j--) {
    for (let i = nx - 1; i >= 0; i--) {
      const k = j * nx + i;
      let v = d[k];
      if (i < nx - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < ny - 1) {
        v = Math.min(v, d[k + nx] + 1);
        if (i < nx - 1) v = Math.min(v, d[k + nx + 1] + D);
        if (i > 0) v = Math.min(v, d[k + nx - 1] + D);
      }
      d[k] = v;
    }
  }
  return d;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 線分の列 pts([x, y] の配列)を stepM ごとの点にして fn(x, y) を呼ぶ。 */
function walkPolyline(pts, stepM, fn) {
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepM));
    for (let i = 0; i <= n; i++) fn(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
  }
}

/**
 * 地形の格子の補助情報: 各頂点のルートからの距離(m)、道路網・建物にかかるか、森の度合い。
 * 木の配置と地面の色に使う。
 * @param {object} data decodeTownData の結果
 * @param {object} route createAtamiRoute の結果
 * @param {(x:number, y:number) => number} heightAt
 * @param {{ flat:number, slope:number, minSlopeY:number }} forestCfg
 */
export function analyzeGrid(data, route, heightAt, forestCfg) {
  const g = data.terrain;
  const { nx, ny, step, x0, y0 } = g;
  const cell = (x, y) => {
    const i = Math.round((x - x0) / step);
    const j = Math.round((y - y0) / step);
    return i >= 0 && j >= 0 && i < nx && j < ny ? j * nx + i : -1;
  };
  // ルートの中心線を起点にした距離
  const seed = new Uint8Array(nx * ny);
  const c = {};
  const T = route.oneWayM;
  for (let t = 0; t <= T; t += step / 2) {
    route.center(t, c);
    const k = cell(c.x, c.y);
    if (k >= 0) seed[k] = 1;
  }
  const dist = chamferDistance(seed, nx, ny);
  for (let k = 0; k < dist.length; k++) dist[k] *= step;
  // 道路網・建物のかかる頂点
  const blocked = new Uint8Array(nx * ny);
  for (const s of data.streets) {
    walkPolyline(s.pts, step / 2, (x, y) => {
      const k = cell(x, y);
      if (k >= 0) blocked[k] = 1;
    });
  }
  for (const b of data.buildings) {
    walkPolyline([...b.ring, b.ring[0]], step / 2, (x, y) => {
      const k = cell(x, y);
      if (k >= 0) blocked[k] = 1;
    });
    let cx = 0;
    let cy = 0;
    for (const [x, y] of b.ring) {
      cx += x;
      cy += y;
    }
    const k = cell(cx / b.ring.length, cy / b.ring.length);
    if (k >= 0) blocked[k] = 1;
  }
  // 森の度合い: 斜面ほど森(平らな所は草地・街)
  const forest = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const hx = heightAt(x0 + (i + 1) * step, y0 + j * step) - heightAt(x0 + (i - 1) * step, y0 + j * step);
      const hy = heightAt(x0 + i * step, y0 + (j + 1) * step) - heightAt(x0 + i * step, y0 + (j - 1) * step);
      const slope = Math.hypot(hx, hy) / (2 * step);
      const ny_ = 1 / Math.sqrt(1 + slope * slope);
      const f = Math.min(1, Math.max(0, (forestCfg.minSlopeY - ny_) / 0.03));
      forest[k] = f;
    }
  }
  return { dist, blocked, forest };
}

/**
 * 木の配置(決定的)。地形の格子の頂点ごとに、森なら slope、平らな所なら flat の確率で1本。
 * 車道・歩道(ルートから半幅 + 6m 以内)・道路網・建物・水の中・名所のまわり(clear)には置かない。
 * @returns {Array<{ x:number, y:number, z:number, scale:number, conifer:boolean, tone:number }>}
 */
export function planTrees(data, route, heightAt, info, forestCfg, { clear = [], maxDistM = 420, maxTrees = 16000, seed = 7 } = {}) {
  const g = data.terrain;
  const { nx, ny, step, x0, y0 } = g;
  const rand = mulberry(seed);
  const out = [];
  const c = {};
  for (let j = 1; j < ny - 1 && out.length < maxTrees; j++) {
    for (let i = 1; i < nx - 1 && out.length < maxTrees; i++) {
      const k = j * nx + i;
      const r = rand();
      const jx = rand();
      const jy = rand();
      const sc = rand();
      const kind = rand();
      const tone = rand();
      if (info.dist[k] > maxDistM || info.blocked[k]) continue;
      const p = forestCfg.flat + (forestCfg.slope - forestCfg.flat) * info.forest[k];
      if (r > p) continue;
      const x = x0 + (i + (jx - 0.5) * 0.8) * step;
      const y = y0 + (j + (jy - 0.5) * 0.8) * step;
      const z = heightAt(x, y);
      const lv = waterLevelAt(data, x, y);
      if (lv !== null && z < lv + 0.6) continue;
      if (clear.some((q) => Math.hypot(x - q.x, y - q.y) < q.r)) continue;
      // 車道・歩道の近く(格子の距離は粗いので、近いものだけ中心線で測り直す)
      if (info.dist[k] < 40) {
        let best = Infinity;
        let hw = 4;
        const T = route.oneWayM;
        const t0 = Math.max(0, nearestT(route, x, y) - 30);
        for (let t = t0; t <= Math.min(T, t0 + 60); t += 2) {
          route.center(t, c);
          const d = Math.hypot(x - c.x, y - c.y);
          if (d < best) {
            best = d;
            hw = c.hw;
          }
        }
        if (best < hw + 6) continue;
      }
      out.push({ x, y, z, scale: 0.8 + sc * 0.6, conifer: kind < 0.35 + 0.3 * info.forest[k], tone });
    }
  }
  return out;
}

/** 中心線上で (x, y) に一番近い片道の位置 t(粗く 10m 刻み)。 */
function nearestT(route, x, y) {
  const c = {};
  let best = Infinity;
  let bt = 0;
  for (let t = 0; t <= route.oneWayM; t += 10) {
    route.center(t, c);
    const d = (x - c.x) ** 2 + (y - c.y) ** 2;
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  return bt;
}

export { gridHeight };
