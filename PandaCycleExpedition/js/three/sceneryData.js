// 走行画面の景色データ(js/data/scenery/<区間ID>.json。tools/segments/scenery.py が国土地理院の
// 標高タイル・建築物の外周線・道路中心線から生成)の読み込みと、純粋な計算。
// Three.js に依存しない(Node のテストから読めるように)。描画は realRoadScene.js。
//
// 座標は区間ごとの平面投影(東が x・北が y、単位 m)。数値は 0.1 m 単位の整数を差分で並べてある。

import { REVERSE_SUFFIX } from '../trip/network.js';

/** 区間(逆向きなら元の区間)の景色データの URL。 */
export function sceneryUrl(segment) {
  const id = segment.id.endsWith(REVERSE_SUFFIX) ? segment.id.slice(0, -REVERSE_SUFFIX.length) : segment.id;
  return new URL(`../data/scenery/${id}.json`, import.meta.url).href;
}

/** 景色データを読む。無い・読めないときは null(走行画面は簡易の景色で続ける)。 */
export async function loadScenery(segment, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(sceneryUrl(segment));
    if (!res.ok) return null;
    return decodeScenery(await res.json());
  } catch {
    return null;
  }
}

function undelta(arr, Type = Float64Array) {
  const out = new Type(arr.length);
  let v = 0;
  for (let i = 0; i < arr.length; i++) {
    v += arr[i];
    out[i] = v / 10;
  }
  return out;
}

export function decodeScenery(json) {
  const route = { x: undelta(json.route.x), y: undelta(json.route.y), z: undelta(json.route.z) };
  route.n = route.x.length;
  const n = Math.round(json.tile / json.near.cell);
  const near = new Map();
  for (const t of json.near.tiles) near.set(`${t.x},${t.y}`, { tx: t.x, ty: t.y, h: undelta(t.h, Float32Array) });
  const far = { ...json.far, h: undelta(json.far.h, Float32Array) };
  const buildings = json.buildings.map(([hgt, kind, ...q]) => {
    const ring = new Float64Array(q.length);
    let x = 0;
    let y = 0;
    for (let i = 0; i < q.length; i += 2) {
      x += q[i];
      y += q[i + 1];
      ring[i] = x / 10;
      ring[i + 1] = y / 10;
    }
    return { height: hgt / 10, kind, ring };
  });
  return {
    id: json.id, origin: json.origin, k: json.k, step: json.step, route,
    tile: json.tile, cell: json.near.cell, n, near, far, buildings, attribution: json.attribution,
    landmarks: json.landmarks ?? [],
  };
}

/** 景色データの平面座標 (x, y) ↔ 経緯度(区間ごとの平面投影。tools/segments/build.py の en/ll と同じ式)。 */
export function toLonLat(sc, x, y) {
  return [sc.origin[0] + x / sc.k[0], sc.origin[1] + y / sc.k[1]];
}
export function fromLonLat(sc, lon, lat) {
  return [(lon - sc.origin[0]) * sc.k[0], (lat - sc.origin[1]) * sc.k[1]];
}

let panoramaPromise = null;
/** 遠景(富士山・大島などの山並み。js/data/scenery/panorama.json)を読む。全区間で共有。読めなければ null。 */
export function loadPanorama(fetchFn = globalThis.fetch) {
  panoramaPromise ??= (async () => {
    try {
      const res = await fetchFn(new URL('../data/scenery/panorama.json', import.meta.url).href);
      return res.ok ? decodePanorama(await res.json()) : null;
    } catch {
      return null;
    }
  })();
  return panoramaPromise;
}

/** 遠景の標高(1 m 単位の差分)を戻す。h[j * nx + i] は 経度 lon0 + i*step・緯度 lat0 + j*step の高さ(海は負)。 */
export function decodePanorama(json) {
  const h = new Float32Array(json.h.length);
  let v = 0;
  for (let i = 0; i < h.length; i++) {
    v += json.h[i];
    h[i] = v;
  }
  return { lon0: json.lon0, lat0: json.lat0, step: json.step, nx: json.nx, ny: json.ny, h, attribution: json.attribution };
}

/** 地球の丸み(大気の屈折込み)で、水平距離 d(m)先が見かけで下がる高さ(m)。60 km 先で約 250 m。 */
export function curvatureDropM(d) {
  return (d * d) / (2 * 6371000 * 1.14);
}

function bilinear(h, stride, rows, fx, fy) {
  const cols = stride;
  const i = Math.min(Math.max(Math.floor(fx), 0), cols - 2);
  const j = Math.min(Math.max(Math.floor(fy), 0), rows - 2);
  const u = Math.min(Math.max(fx - i, 0), 1);
  const v = Math.min(Math.max(fy - j, 0), 1);
  const a = h[j * cols + i];
  const b = h[j * cols + i + 1];
  const c = h[(j + 1) * cols + i];
  const d = h[(j + 1) * cols + i + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** 近景のタイル(無ければ null)。 */
export function nearTileAt(sc, x, y) {
  return sc.near.get(`${Math.floor(x / sc.tile)},${Math.floor(y / sc.tile)}`) ?? null;
}

/** 地点 (x, y) の地面の高さ(m)。近景のタイルがあればそれを、無ければ遠景を補間する。海は負の値。 */
export function heightAt(sc, x, y) {
  const t = nearTileAt(sc, x, y);
  if (t) {
    return bilinear(t.h, sc.n + 1, sc.n + 1, (x - t.tx * sc.tile) / sc.cell, (y - t.ty * sc.tile) / sc.cell);
  }
  const f = sc.far;
  return bilinear(f.h, f.nx, f.ny, (x - f.x0) / f.cell, (y - f.y0) / f.cell);
}

/**
 * 区間の距離 m(区間の向き。逆向きの区間は元のデータを反転して読む)での道の中心 (x, y)・路面の高さ z と、
 * 進む向きの単位ベクトル (hx, hy)。
 */
export function createRouteSampler(sc, segment) {
  const rev = segment.id.endsWith(REVERSE_SUFFIX);
  const { x, y, z, n } = sc.route;
  const L = (n - 1) * sc.step;
  return function at(m, out = {}) {
    const mf = Math.min(Math.max(rev ? L - m : m, 0), L) / sc.step;
    const i = Math.min(Math.floor(mf), n - 2);
    const f = mf - i;
    out.x = x[i] + (x[i + 1] - x[i]) * f;
    out.y = y[i] + (y[i + 1] - y[i]) * f;
    out.z = z[i] + (z[i + 1] - z[i]) * f;
    // 向きは前後 2 区間ぶんの差でならす(10 m ごとの折れ目でカメラが揺れないように)
    const a = Math.max(i - 1, 0);
    const b = Math.min(i + 2, n - 1);
    let hx = x[b] - x[a];
    let hy = y[b] - y[a];
    const len = Math.hypot(hx, hy) || 1;
    hx /= len;
    hy /= len;
    out.hx = rev ? -hx : hx;
    out.hy = rev ? -hy : hy;
    return out;
  };
}

/** 建物の外周の重心と外接の範囲。 */
export function ringBounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]);
    maxY = Math.max(maxY, ring[i + 1]);
    cx += ring[i];
    cy += ring[i + 1];
  }
  const k = ring.length / 2;
  return { minX, minY, maxX, maxY, cx: cx / k, cy: cy / k };
}

/** 0〜1 の決定的な乱数(整数2つから)。木の配置など、同じ場所はいつも同じになるように。 */
export function hash2(i, j, salt = 0) {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
