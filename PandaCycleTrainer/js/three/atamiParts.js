// 熱海サンビーチコース(js/ui/AtamiScene.js)のメッシュ作り: PLATEAU の建物 LOD1 の押し出し、
// 道路(走るルートと道路網)、地形の格子、海沿いの遊歩道の部品(ヤシ・街灯・パラソル)、熱海城。
// 位置の計算は atamiRealLayout.js(純粋関数)、ここは Three.js のジオメトリにするだけ。

import THREE from './three.js';
import { mergeGeometries } from './sceneKit.js';
import { FLOOR_HEIGHT_M } from './cityLayout.js';
import { FACADE_TILE } from './cityMaterials.js';
import { gridHeight, groundColor, buildingLook, SUN_BEACH_T } from './atamiRealLayout.js';

/** 地図座標 (x 東, y 北, 標高 z) → シーン座標(北が −Z)。 */
export const toScene = (x, y, z) => new THREE.Vector3(x, z, -y);

const BUILDING_CHUNK_M = 300;
const STREET_STEP_M = 5;
const STREET_LIFT_M = 0.12;
const TERRAIN_TILE_M = 5;

// ---- 地形 ----

/** 建物の外形を地形の格子に塗り、各頂点のまわりの建物の割合(0..1)を返す(地面の色に使う)。 */
function builtUpGrid(grid, buildings) {
  const { nx, ny, step, x0, y0 } = grid;
  const cover = new Float32Array(nx * ny);
  for (const b of buildings) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let area = 0;
    const r = b.ring;
    for (let k = 0; k < r.length; k++) {
      const [ax, ay] = r[k];
      const [bx, by] = r[(k + 1) % r.length];
      area += ax * by - bx * ay;
      minX = Math.min(minX, ax); maxX = Math.max(maxX, ax);
      minY = Math.min(minY, ay); maxY = Math.max(maxY, ay);
    }
    const i = Math.round(((minX + maxX) / 2 - x0) / step);
    const j = Math.round(((minY + maxY) / 2 - y0) / step);
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    cover[j * nx + i] += Math.abs(area) / 2 / (step * step);
  }
  // 周りへ少しにじませる(格子の間隔より小さな建物でも街並みの色になるよう)
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          sum += cover[b * nx + a];
        }
      }
      out[j * nx + i] = Math.min(1, sum / 9);
    }
  }
  return out;
}

/** サンビーチの砂浜の範囲(格子の頂点ごとの 0/1)。中心線から海側へ伸ばした帯で塗る。 */
function beachGrid(grid, route, sides) {
  const { nx, ny, step, x0, y0 } = grid;
  const mask = new Uint8Array(nx * ny);
  const c = {};
  for (let t = SUN_BEACH_T[0]; t <= SUN_BEACH_T[1]; t += step / 2) {
    const side = sides[Math.round(t / route.stepM)] || 1;
    route.center(t, c);
    const ex = c.ty * side;
    const ey = -c.tx * side;
    for (let u = c.hw + 4; u < c.hw + 140; u += step / 2) {
      const i = Math.round((c.x + ex * u - x0) / step);
      const j = Math.round((c.y + ey * u - y0) / step);
      if (i >= 0 && j >= 0 && i < nx && j < ny) mask[j * nx + i] = 1;
    }
  }
  return mask;
}

// 地形のメッシュを分ける区画(格子のセル数)。区画ごとに視錐台カリングが効き、背後の地形を描かずに済む
const TERRAIN_CHUNK_CELLS = 48;

/**
 * 標高の格子 → 地形のメッシュ(頂点カラー)を TERRAIN_CHUNK_CELLS 四方の区画に分けた Group。
 * skipBox の内側のセル(近景が描く範囲)は作らない。法線と色は格子全体で求めてから分けるので、区画の境目も滑らか。
 * @param {object} opts.buildings 建物(近景の地面の色に使う)。opts.route, opts.sides は砂浜の範囲
 */
export function buildTerrainMesh(grid, material, { buildings = null, route = null, sides = null, skipBox = null } = {}) {
  const { nx, ny, step, x0, y0, h } = grid;
  const pos = new Float32Array(nx * ny * 3);
  const uv = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = x0 + i * step;
      const y = y0 + j * step;
      pos[k * 3] = x;
      pos[k * 3 + 1] = h[k];
      pos[k * 3 + 2] = -y;
      uv[k * 2] = x / TERRAIN_TILE_M;
      uv[k * 2 + 1] = y / TERRAIN_TILE_M;
    }
  }
  const skipCell = (i, j) => {
    if (!skipBox) return false;
    const cx = x0 + (i + 0.5) * step;
    const cy = y0 + (j + 0.5) * step;
    return cx > skipBox.x0 && cx < skipBox.x1 && cy > skipBox.y0 && cy < skipBox.y1;
  };
  // 法線(格子全体)
  const full = new THREE.BufferGeometry();
  full.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const fullIdx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      // 北(+y)は −Z なので、上から見て反時計回り = 上向きの面になる巻き順
      fullIdx.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
    }
  }
  full.setIndex(fullIdx);
  full.computeVertexNormals();
  const nrm = full.attributes.normal.array;
  const built = buildings ? builtUpGrid(grid, buildings) : null;
  const beach = route && sides ? beachGrid(grid, route, sides) : null;
  const col = new Float32Array(nx * ny * 3);
  const c = new THREE.Color();
  for (let k = 0; k < nx * ny; k++) {
    const noise = fract(Math.sin(k * 12.9898) * 43758.5453);
    const rgb = groundColor(h[k], nrm[k * 3 + 1], built ? built[k] : 0, beach ? beach[k] === 1 : false, noise);
    c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    col[k * 3] = c.r;
    col[k * 3 + 1] = c.g;
    col[k * 3 + 2] = c.b;
  }
  full.dispose();

  const group = new THREE.Group();
  const N = TERRAIN_CHUNK_CELLS;
  for (let cj = 0; cj < ny - 1; cj += N) {
    for (let ci = 0; ci < nx - 1; ci += N) {
      const i1 = Math.min(nx - 1, ci + N);
      const j1 = Math.min(ny - 1, cj + N);
      const w = i1 - ci + 1;
      const idx = [];
      for (let j = cj; j < j1; j++) {
        for (let i = ci; i < i1; i++) {
          if (skipCell(i, j)) continue;
          const a = (j - cj) * w + (i - ci);
          idx.push(a, a + 1, a + w, a + 1, a + w + 1, a + w);
        }
      }
      if (idx.length === 0) continue;
      const n = w * (j1 - cj + 1);
      const p = new Float32Array(n * 3);
      const u = new Float32Array(n * 2);
      const cc = new Float32Array(n * 3);
      const nn = new Float32Array(n * 3);
      for (let j = cj; j <= j1; j++) {
        for (let i = ci; i <= i1; i++) {
          const k = j * nx + i;
          const q = (j - cj) * w + (i - ci);
          p.set(pos.subarray(k * 3, k * 3 + 3), q * 3);
          nn.set(nrm.subarray(k * 3, k * 3 + 3), q * 3);
          cc.set(col.subarray(k * 3, k * 3 + 3), q * 3);
          u.set(uv.subarray(k * 2, k * 2 + 2), q * 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nn, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(u, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}

function fract(v) {
  return v - Math.floor(v);
}

// ---- 走るルート ----

/**
 * 走るルートの車道と歩道のリボン。車道は U が全幅(0..1)、V が距離(roadTileM ごと)。
 * 歩道は車道の端から外へ sidewalkAt(t, side) m、路面より 15cm 高い。両端はUターン用の半円でふさぐ。
 */
export function buildRouteMeshes(route, { roadTileM, sidewalkAt, paveTileM = 2 }) {
  const T = route.oneWayM;
  const c = {};
  const road = { pos: [], uv: [], idx: [] };
  const walk = { pos: [], uv: [], idx: [] };
  let rows = 0;
  for (let t = 0; t <= T + 1e-6; t += 2) {
    route.center(Math.min(t, T), c);
    // 右(北へ走るとき)= (ty, −tx)
    const rx = c.ty;
    const ry = -c.tx;
    const z = c.z + 0.02;
    const left = c.hw;
    road.pos.push(c.x - rx * left, z, -(c.y - ry * left), c.x + rx * left, z, -(c.y + ry * left));
    road.uv.push(0, t / roadTileM, 1, t / roadTileM);
    const wl = sidewalkAt(t, -1);
    const wr = sidewalkAt(t, 1);
    const zw = c.z + 0.15;
    walk.pos.push(
      c.x - rx * (left + wl), zw, -(c.y - ry * (left + wl)), c.x - rx * left, zw, -(c.y - ry * left),
      c.x + rx * left, zw, -(c.y + ry * left), c.x + rx * (left + wr), zw, -(c.y + ry * (left + wr)),
    );
    walk.uv.push(0, t / paveTileM, wl / paveTileM, t / paveTileM, 0, t / paveTileM, wr / paveTileM, t / paveTileM);
    if (rows > 0) {
      const a = (rows - 1) * 2;
      // 上から見て反時計回り(地図座標)= 上向きの面
      road.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      const w = (rows - 1) * 4;
      walk.idx.push(w, w + 1, w + 4, w + 1, w + 5, w + 4, w + 2, w + 3, w + 6, w + 3, w + 7, w + 6);
    }
    rows++;
  }
  // Uターンする両端を半円でふさぐ(車道の色)
  for (const endT of [0, T]) {
    route.center(endT, c);
    const sgn = endT === 0 ? -1 : 1;
    const fx = c.tx * sgn;
    const fy = c.ty * sgn;
    const base = road.pos.length / 3;
    road.pos.push(c.x, c.z + 0.02, -c.y);
    // 線の無いアスファルトの所(全幅の 3 割の位置)の色を使う
    road.uv.push(0.3, endT / roadTileM);
    const R = c.hw + 1;
    for (let k = 0; k <= 12; k++) {
      const a = (Math.PI * k) / 12;
      // 右(rx, ry)から前を通って左へ
      const rx = fy;
      const ry = -fx;
      const px = c.x + R * (Math.cos(a) * rx + Math.sin(a) * fx);
      const py = c.y + R * (Math.cos(a) * ry + Math.sin(a) * fy);
      road.pos.push(px, c.z + 0.02, -py);
      road.uv.push(0.3, endT / roadTileM + 0.1);
      // 右 → 前 → 左は、どちらの端でも上から見て反時計回り
      if (k > 0) road.idx.push(base, base + k, base + k + 1);
    }
  }
  return { road: toGeometry(road), sidewalk: toGeometry(walk) };
}

function toGeometry({ pos, uv, idx }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 巻き順の向きによらず上向きの法線にそろえる
  const n = g.attributes.normal;
  for (let k = 0; k < n.count; k++) if (n.getY(k) < 0) n.setXYZ(k, -n.getX(k), -n.getY(k), -n.getZ(k));
  return g;
}

// ---- 道路網(国土地理院の道路中心線) ----

/** 道路網のリボン(地形の上に少し浮かせる)。幅は道路中心線の幅の区分。 */
export function buildStreetGeometry(streets, heightAt) {
  const pos = [];
  const idx = [];
  const uv = [];
  for (const s of streets) {
    const pts = densify(s.pts, STREET_STEP_M);
    if (pts.length < 2) continue;
    const half = s.widthM / 2;
    const base = pos.length / 3;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)];
      const b = pts[Math.min(pts.length - 1, k + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const [x, y] = pts[k];
      const lx = x - dy * half;
      const ly = y + dx * half;
      const rx = x + dy * half;
      const ry = y - dx * half;
      pos.push(lx, heightAt(lx, ly) + STREET_LIFT_M, -ly, rx, heightAt(rx, ry) + STREET_LIFT_M, -ry);
      uv.push(lx / 4, ly / 4, rx / 4, ry / 4);
      if (k > 0) {
        const p = base + (k - 1) * 2;
        idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
      }
    }
  }
  return toGeometry({ pos, uv, idx });
}

function densify(pts, stepM) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepM));
    for (let i = 1; i <= n; i++) out.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n]);
  }
  return out;
}

// ---- 建物(PLATEAU LOD1) ----

/**
 * 建物の外形を押し出したメッシュ。外壁は外壁の種類(style)ごと・BUILDING_CHUNK_M 四方の区画ごとに
 * まとめ(区画ごとに視錐台カリングが効く)、屋根は頂点カラーで1種類のマテリアルにまとめる。
 * 外壁の UV は都市の外壁シェーダー(cityMaterials.js)のタイル単位(ベイ数 / タイルのベイ数, 階 / タイルの階数)。
 * 基礎は地面(地形の格子)の一番低い所より下まで下ろし、斜面でも浮かない。
 * @param {(i:number) => boolean} [skip] 置かない建物(熱海城の位置など)
 * @returns {{ walls: Map<string, THREE.BufferGeometry[]>, roofs: THREE.BufferGeometry[], count: number }}
 */
export function buildBuildingGeometries(buildings, heightAt, { skip } = {}) {
  const chunks = new Map(); // key → { style → arrays, roof arrays }
  const color = new THREE.Color();
  let count = 0;
  buildings.forEach((b, index) => {
    if (skip?.(index)) return;
    const look = buildingLook(b, index);
    const ring = b.ring;
    let ground = Infinity;
    let cx = 0;
    let cy = 0;
    for (const [x, y] of ring) {
      ground = Math.min(ground, heightAt(x, y));
      cx += x;
      cy += y;
    }
    cx /= ring.length;
    cy /= ring.length;
    const top = b.base + b.height;
    if (!(top > ground + 1)) return;
    const bottom = Math.min(ground, b.base) - 0.8;
    const key = `${Math.floor(cx / BUILDING_CHUNK_M)},${Math.floor(cy / BUILDING_CHUNK_M)}`;
    let ch = chunks.get(key);
    if (!ch) {
      ch = { walls: {}, roof: { pos: [], col: [], idx: [] } };
      chunks.set(key, ch);
    }
    const w = (ch.walls[look.style] ??= { pos: [], uv: [], col: [], idx: [] });
    color.setHex(look.tint).convertSRGBToLinear();
    const bayM = look.style === 'glass' ? 1.8 : FLOOR_HEIGHT_M;
    const vBottom = (bottom - b.base) / FLOOR_HEIGHT_M / FACADE_TILE.cellFloors;
    const vTop = (top - b.base) / FLOOR_HEIGHT_M / FACADE_TILE.cellFloors;
    for (let k = 0; k < ring.length; k++) {
      const [ax, ay] = ring[k];
      const [bx, by] = ring[(k + 1) % ring.length];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.05) continue;
      const bays = Math.max(1, Math.round(len / bayM));
      const u1 = bays / FACADE_TILE.cellBays;
      const base = w.pos.length / 3;
      w.pos.push(ax, bottom, -ay, bx, bottom, -by, bx, top, -by, ax, top, -ay);
      w.uv.push(0, vBottom, u1, vBottom, u1, vTop, 0, vTop);
      for (let v = 0; v < 4; v++) w.col.push(color.r, color.g, color.b);
      // 外形は反時計回り(上から見て)なので、外向きの面になる巻き順
      w.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    // 屋根(陸屋根)。外形を三角形に分割する
    const contour = ring.map(([x, y]) => new THREE.Vector2(x, y));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const r = ch.roof;
    const rb = r.pos.length / 3;
    color.setHex(look.roof).convertSRGBToLinear();
    for (const [x, y] of ring) {
      r.pos.push(x, top, -y);
      r.col.push(color.r, color.g, color.b);
    }
    for (const [a, bb, cc] of tris) {
      // 上から見て反時計回り(地図座標)の三角形が上向きの面
      const [ax, ay] = ring[a];
      const [bx2, by2] = ring[bb];
      const [cx2, cy2] = ring[cc];
      const ccw = (bx2 - ax) * (cy2 - ay) - (by2 - ay) * (cx2 - ax) > 0;
      if (ccw) r.idx.push(rb + a, rb + bb, rb + cc);
      else r.idx.push(rb + a, rb + cc, rb + bb);
    }
    count++;
  });
  const walls = new Map();
  const roofs = [];
  for (const ch of chunks.values()) {
    for (const [style, w] of Object.entries(ch.walls)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(w.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(w.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(w.col, 3));
      g.setIndex(w.idx);
      g.computeVertexNormals();
      if (!walls.has(style)) walls.set(style, []);
      walls.get(style).push(g);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(ch.roof.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(ch.roof.col, 3));
    g.setIndex(ch.roof.idx);
    g.computeVertexNormals();
    // 三角形分割の向きは外形の向き次第なので、上向きにそろえる
    const n = g.attributes.normal;
    for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
    roofs.push(g);
  }
  return { walls, roofs, count };
}

// ---- 海沿いの遊歩道の部品 ----

/** カナリーヤシの樹冠: 放射状に垂れ下がる羽状の葉(V字断面のリボン)を16枚。 */
export function buildPalmCrownGeometry() {
  const parts = [];
  const fronds = 16;
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + (f % 2) * 0.2;
    const lift = f % 3 === 0 ? 0.9 : f % 3 === 1 ? 0.45 : 0.15; // 若い葉は上向き、古い葉は垂れる
    const length = 4.2 + (f % 4) * 0.25;
    const segs = 8;
    const positions = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      // 付け根から上へ伸び、先端に向かって弓なりに垂れる
      const r = length * t;
      const y = Math.sin(t * Math.PI * 0.55) * lift * 2.2 - t * t * 2.1;
      const half = 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.04;
      const droop = half * 0.45;
      for (const side of [-1, 0, 1]) {
        const lx = side * half;
        const ly = y - (side !== 0 ? droop : 0);
        positions.push(Math.cos(yaw) * r - Math.sin(yaw) * lx, ly, Math.sin(yaw) * r + Math.cos(yaw) * lx);
      }
      if (i < segs) {
        const a = i * 3;
        idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3, a + 1, a + 2, a + 4, a + 2, a + 5, a + 4);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g);
  }
  parts.push(new THREE.SphereGeometry(0.55, 10, 8).scale(1, 0.8, 1).translate(0, -0.2, 0)); // 葉の付け根
  return mergeGeometries(parts);
}

/** 遊歩道の街灯(高さ約5m、2灯の球形ランプ)。 */
export function buildPromenadeLampGeometry() {
  const pole = mergeGeometries([
    new THREE.CylinderGeometry(0.12, 0.16, 0.5, 10).translate(0, 0.25, 0),
    new THREE.CylinderGeometry(0.06, 0.08, 4.8, 10).translate(0, 2.4, 0),
    new THREE.BoxGeometry(1.2, 0.06, 0.06).translate(0, 4.7, 0),
  ]);
  const globes = mergeGeometries([
    new THREE.SphereGeometry(0.22, 14, 10).translate(-0.6, 4.95, 0),
    new THREE.SphereGeometry(0.22, 14, 10).translate(0.6, 4.95, 0),
    new THREE.SphereGeometry(0.2, 14, 10).translate(0, 5.1, 0),
  ]);
  return { pole, globes };
}

/** 熱海城: 石垣の上に白壁と黒っぽい瓦屋根を重ねた天守(高さ約33m)。 */
export function buildCastleGeometries() {
  const frustum = (rTop, rBottom, height, y) => new THREE.CylinderGeometry(rTop, rBottom, height, 4, 1).rotateY(Math.PI / 4).translate(0, y + height / 2, 0);
  const stone = frustum(12, 16, 9, 0);
  const walls = mergeGeometries([
    new THREE.BoxGeometry(16, 6, 14).translate(0, 12, 0),
    new THREE.BoxGeometry(12, 5, 10.5).translate(0, 19.7, 0),
    new THREE.BoxGeometry(8.5, 4.5, 7.5).translate(0, 26.45, 0),
  ]);
  const roofs = mergeGeometries([
    frustum(8, 13.5, 2.2, 15),
    frustum(5.5, 10, 2, 22.2),
    new THREE.ConeGeometry(7.5, 4, 4, 1).rotateY(Math.PI / 4).translate(0, 30.7, 0),
    new THREE.BoxGeometry(9, 0.8, 1.2).translate(0, 32.4, 0), // 大棟
  ]);
  return { stone, walls, roofs };
}

export { gridHeight };
