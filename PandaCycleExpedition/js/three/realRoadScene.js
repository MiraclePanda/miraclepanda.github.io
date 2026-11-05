// 実在の地形の走行シーン。区間の景色データ(sceneryData.js)から、国土地理院の標高でできた山と海岸線・
// 実在の建物の外形・道を、区間の平面投影そのままの座標に置く(東 = +X、北 = -Z、高さ = Y)。
//
// 地形・道・建物は読み込み時に1回だけ組み立て(タイル・塊ごとのメッシュ。頂点は塊の原点からの相対座標にして
// 何十 km 先でも精度が落ちないようにする)、毎フレーム動かすのはライダー・カメラ・影の範囲・海面と、
// ライダーの近くだけに置くもの(中央線・ガードレール・電柱・トンネル・森の木)。
// 描画品質(最高/高/中/低)で、木を置く範囲と密度・建物を描く距離・見通し(霧と描画距離)・波を変える。
// 道の見た目は物理・トレーナーには関係しない(勾配は区間データのまま)。

import THREE from './three.js';
import {
  RIDER_X_M, bakeSky, createAvatar, updateRiderAvatar, makePool, pushInstance, pushInstanceYawPitch, commitPool,
  setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene, setCameraFov, setAvatarVisible,
} from './sceneKit.js';
import { createRouteSampler, heightAt, nearTileAt, ringBounds, hash2 } from './sceneryData.js';
import { createPanorama } from './panoramaParts.js';
import { buildLandmarks } from './landmarkParts.js';
import { createAerialPhotos } from './aerialPhoto.js';
import { VIEW_RIGS, normalizeCameraView, estimateCadenceRpm, fpBobM, fpFovDeg } from './cameraViews.js';

const SKY_BY_WEATHER = {
  // fog: 霞の濃さ(1/m)。晴れなら 60 km 先の富士山がうっすら見えるくらい(遠景と同じ値を使う)
  sunny: { zenith: '#3b78c9', horizon: '#d3e6f3', ground: '#5d7a55', cloudCover: 0.15, fog: 0.000022 },
  cloudy: { zenith: '#7d8a99', horizon: '#c9d0d6', ground: '#5d6a58', cloudCover: 0.75, sunGlow: 0.5, fog: 0.00007 },
  rain: { zenith: '#4f5864', horizon: '#8e979f', ground: '#4a5448', cloudCover: 0.95, sunGlow: 0.25, fog: 0.0012 },
  squall: { zenith: '#2f353d', horizon: '#646c74', ground: '#3b4239', cloudCover: 1, sunGlow: 0.1, fog: 0.0025 },
};

// 描画品質ごとの景色の重さ。treeR/treeCell = 木を置く半径と格子(m)、bldM = 建物を描く距離、
// far = 描画距離、waves = 海のさざ波(法線マップ)、pano = 遠景(富士山・大島などの山並み)。
// 遠景を出さない段階は、描画距離の端が見えないように霞を濃くする(3.5 / far 以上)
const TIER_SCENERY = {
  ultra: { treeR: 900, treeCell: 9, bldM: Infinity, far: 20000, waves: true, pano: true },
  high: { treeR: 650, treeCell: 11, bldM: 4000, far: 12000, waves: true, pano: true },
  medium: { treeR: 420, treeCell: 14, bldM: 1800, far: 6000, waves: true, pano: true },
  low: { treeR: 220, treeCell: 20, bldM: 700, far: 3000, waves: false, pano: false },
};
const TREE_MAX = 22000;
// トンネルの坑口: 地形の格子(25 m)では山肌を坑口でぴったり切れないので、トンネルの筒の中の地面は
// シェーダーで描かない(TUN_HALF_W より内側・路面 -1 m 〜 TUN_TOP_M)。坑口の外で道より高い地面が残る所は、
// 筒と坑口の壁をその先(最大 TUN_EXT_MAX_M)まで延ばす(覆道のように見える)。
const TUN_MAX = 64;
const TUN_PIECE_M = 20;
const TUN_HALF_W = 5.85;
const TUN_TOP_M = 5.9;
const TUN_EXT_MAX_M = 60;
const TUN_CUT_R = 900;
const FP_LOOK_M = 20;
const TREE_REBUILD_M = 40;
const ROAD_CHUNK = 50; // 道のメッシュ1つあたりの点の数(10 m ごと)
// 道の断面: [中心からの距離(m), 路面からの高さ, 色]。同じ色の列を2本並べて白線の縁をくっきりさせる
const ROAD_COLS = [
  [-7, -0.45, 0x77756c], [-5.4, 0.06, 0x9a978f], [-4.8, 0.06, 0x8f8c84], [-4.79, 0.04, 0xe6e6e0],
  [-4.6, 0.04, 0xe6e6e0], [-4.59, 0.03, 0x46484b], [4.59, 0.03, 0x46484b], [4.6, 0.04, 0xe6e6e0],
  [4.79, 0.04, 0xe6e6e0], [4.8, 0.06, 0x8f8c84], [5.4, 0.06, 0x9a978f], [7, -0.45, 0x77756c],
];
const WALL_COLORS = [0xece6da, 0xdcd2c0, 0xc9ced2, 0xf3efe7, 0xbfb3a0, 0xd8cfc4];
const HOUSE_ROOFS = [0x4a4f57, 0x5b4636, 0x3e4a5c, 0x6a6a66, 0x7a4b36];

function canvasTexture(size, paint) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  paint(cv.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 建物の壁: 白地に窓1つ(4 m × 1階ぶん)。左下の隅は窓の無い白(屋根・倉庫の壁に使う)。 */
function facadeTexture() {
  return canvasTexture(64, (g, n) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, n, n);
    g.fillStyle = '#56606a';
    g.fillRect(18, 14, 30, 26);
    g.fillStyle = '#8b98a3';
    g.fillRect(20, 16, 12, 22);
    g.fillStyle = '#d9d6cf';
    g.fillRect(0, 50, n, 4);
  });
}

/** 地面の細かいむら(下草・土)。頂点色に掛ける。 */
function groundTexture() {
  return canvasTexture(128, (g, n) => {
    const img = g.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const v = 200 + Math.floor(hash2(i % n, Math.floor(i / n), 3) * 55);
      img.data.set([v, v, v * 0.97, 255], i * 4);
    }
    g.putImageData(img, 0, 0);
  });
}

/** 海のさざ波の法線マップ(継ぎ目なく繰り返す値ノイズから)。 */
function waveNormalTexture() {
  const n = 128;
  const hgt = (x, y) => {
    let v = 0;
    for (const [f, a] of [[4, 1], [8, 0.5], [16, 0.25]]) {
      const fx = (x / n) * f;
      const fy = (y / n) * f;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const u = fx - i;
      const w = fy - j;
      const r = (a1, b1) => hash2(((a1 % f) + f) % f, ((b1 % f) + f) % f, f);
      const s = (t) => t * t * (3 - 2 * t);
      v += a * (r(i, j) + (r(i + 1, j) - r(i, j)) * s(u) + (r(i, j + 1) - r(i, j)) * s(w)
        + (r(i, j) - r(i + 1, j) - r(i, j + 1) + r(i + 1, j + 1)) * s(u) * s(w));
    }
    return v;
  };
  const tex = canvasTexture(n, (g) => {
    const img = g.createImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (hgt(x + 1, y) - hgt(x - 1, y)) * 3;
        const dy = (hgt(x, y + 1) - hgt(x, y - 1)) * 3;
        const l = Math.hypot(dx, dy, 1);
        img.data.set([(-dx / l) * 127 + 128, (-dy / l) * 127 + 128, (1 / l) * 127 + 128, 255], (y * n + x) * 4);
      }
    }
    g.putImageData(img, 0, 0);
  });
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const _c = new THREE.Color();
const _c2 = new THREE.Color();

/** 地面の色: 高さ・斜面の急さ・道や家並みへの近さから。 */
function groundColor(h, ny, roadD, built, r) {
  if (h < 0.6) return _c.setHex(0xcdbd92);
  if (roadD < 9) return _c.setHex(0x7b7870);
  if (h < 2.2 && roadD > 20) return _c.setHex(0xc4b68e);
  const slope = 1 - ny;
  if (slope > 0.45) return _c.setHex(0x6e6656).lerp(_c2.setHex(0x55603f), r * 0.5);
  if (built) return _c.setHex(0x8e8a80).lerp(_c2.setHex(0x627a4a), 0.35 + r * 0.4);
  if (slope < 0.06 && h < 60 && roadD < 160) return _c.setHex(r < 0.5 ? 0x748c48 : 0x8b9a58);
  return _c.setHex(0x2e4b25).lerp(_c2.setHex(0x46672f), r);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} segment 区間データ
 * @param {object} sc 景色データ(decodeScenery の戻り値)
 * @param {{qualityMode?:string, onQualityChange?:(tier:string)=>void, panorama?:object|null}} [opts]
 *   panorama: 遠景の標高(loadPanorama の戻り値)。無ければ遠景なし
 */
export function createRealRoadScene(canvas, segment, sc, { qualityMode = 'auto', onQualityChange, panorama = null, cameraView = 'chase' } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false; // 遠景 → 近くの景色の順に重ねて描く
  const pano = panorama ? createPanorama(panorama, sc) : null;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd3e6f3, 0.00035);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 12000);
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x4a5a40, 0.9);
  const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.6);
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0004;
  Object.assign(sunLight.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 200 });
  scene.add(hemi, sunLight, sunLight.target);
  const textures = [];
  const tex = (t) => (textures.push(t), t);
  const routeAt = createRouteSampler(sc, segment);

  // ---- トンネル(坑口の外で道より高い地面が残る所まで筒を延ばす) ----
  const tubes = [];
  const tunPieces = []; // [x1, y1, x2, y2, z1, z2](区間の平面座標と路面の高さ)
  {
    const p = {};
    const blocked = (m) => {
      routeAt(m, p);
      let h = -Infinity;
      for (const off of [-4, 0, 4]) h = Math.max(h, heightAt(sc, p.x - p.hy * off, p.y + p.hx * off));
      return h > p.z + 0.3;
    };
    for (const tn of segment.tunnels ?? []) {
      let from = tn.fromM;
      let to = tn.toM;
      while (tn.fromM - from < TUN_EXT_MAX_M && from > 0 && blocked(from - 2)) from -= 2;
      while (to - tn.toM < TUN_EXT_MAX_M && to < segment.lengthM && blocked(to + 2)) to += 2;
      tubes.push({ fromM: from - 2, toM: to + 2 });
    }
    const a = {};
    const b = {};
    for (const tb of tubes) {
      for (let m = tb.fromM; m < tb.toM; m += TUN_PIECE_M) {
        routeAt(m, a);
        routeAt(Math.min(m + TUN_PIECE_M, tb.toM), b);
        tunPieces.push([a.x, a.y, b.x, b.y, a.z, b.z]);
      }
    }
  }
  const tubeAt = (m) => tubes.find((t) => m >= t.fromM && m < t.toM) ?? null;
  // 地面のシェーダーに、ライダーの近くのトンネルの筒(線分と路面の高さ)を渡して、その中の地面を描かない
  const tunUniforms = {
    uTun: { value: Array.from({ length: TUN_MAX }, () => new THREE.Vector4()) },
    uTunY: { value: Array.from({ length: TUN_MAX }, () => new THREE.Vector2()) },
    uTunN: { value: 0 },
  };
  function cutTunnels(mat) {
    if (!tunPieces.length) return mat;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, tunUniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTunW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvTunW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vTunW;
uniform vec4 uTun[${TUN_MAX}];
uniform vec2 uTunY[${TUN_MAX}];
uniform int uTunN;`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
for (int i = 0; i < ${TUN_MAX}; i++) {
  if (i >= uTunN) break;
  vec2 a = uTun[i].xy;
  vec2 ab = uTun[i].zw - a;
  float f = clamp(dot(vTunW.xz - a, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
  float ry = mix(uTunY[i].x, uTunY[i].y, f);
  if (length(vTunW.xz - a - ab * f) < ${TUN_HALF_W.toFixed(2)} && vTunW.y > ry - 1.0 && vTunW.y < ry + ${TUN_TOP_M.toFixed(2)}) discard;
}`);
    };
    mat.customProgramCacheKey = () => 'tunnel-cut';
    return mat;
  }
  let tunAt = null;
  function updateTunnelCut(ox, oy) {
    if (!tunPieces.length || (tunAt && Math.hypot(ox - tunAt[0], oy - tunAt[1]) < 20)) return;
    tunAt = [ox, oy];
    const near = tunPieces
      .map((pc) => [Math.hypot((pc[0] + pc[2]) / 2 - ox, (pc[1] + pc[3]) / 2 - oy), pc])
      .filter(([d]) => d < TUN_CUT_R)
      .sort((p1, p2) => p1[0] - p2[0])
      .slice(0, TUN_MAX);
    // シェーダーは世界の座標(東 = +X、北 = -Z)
    near.forEach(([, pc], i) => {
      tunUniforms.uTun.value[i].set(pc[0], -pc[1], pc[2], -pc[3]);
      tunUniforms.uTunY.value[i].set(pc[4], pc[5]);
    });
    tunUniforms.uTunN.value = near.length;
  }

  // ---- 地形(近景のタイル + 遠景の1枚) ----
  const N = sc.n;
  const groundMat = cutTunnels(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, map: tex(groundTexture()) }));
  const farMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  // 近景の頂点ごとの「道までの距離」と「家並み」の印(色と木の配置に使う)
  for (const t of sc.near.values()) {
    t.roadD = new Float32Array((N + 1) ** 2).fill(1e9);
    t.built = new Uint8Array((N + 1) ** 2);
  }
  /** 範囲 [x0,x1]×[y0,y1] にかかる近景の頂点ごとに fn(tile, index, x, y) を呼ぶ。 */
  function forVertices(x0, y0, x1, y1, fn) {
    for (let ty = Math.floor(y0 / sc.tile); ty <= Math.floor(y1 / sc.tile); ty++) {
      for (let tx = Math.floor(x0 / sc.tile); tx <= Math.floor(x1 / sc.tile); tx++) {
        const t = sc.near.get(`${tx},${ty}`);
        if (!t) continue;
        const ox = tx * sc.tile;
        const oy = ty * sc.tile;
        const i0 = Math.max(0, Math.ceil((x0 - ox) / sc.cell));
        const i1 = Math.min(N, Math.floor((x1 - ox) / sc.cell));
        const j0 = Math.max(0, Math.ceil((y0 - oy) / sc.cell));
        const j1 = Math.min(N, Math.floor((y1 - oy) / sc.cell));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(t, j * (N + 1) + i, ox + i * sc.cell, oy + j * sc.cell);
      }
    }
  }
  const R = sc.route;
  for (let k = 0; k < R.n; k++) {
    const x = R.x[k];
    const y = R.y[k];
    forVertices(x - 60, y - 60, x + 60, y + 60, (t, i, vx, vy) => {
      const d = Math.hypot(vx - x, vy - y);
      if (d < t.roadD[i]) t.roadD[i] = d;
    });
  }
  // 道の点の格子(50 m)。木が道にかからないように、任意の地点から道までの距離を引く
  const routeGrid = new Map();
  for (let k = 0; k < R.n; k++) {
    const key = `${Math.floor(R.x[k] / 50)},${Math.floor(R.y[k] / 50)}`;
    if (!routeGrid.has(key)) routeGrid.set(key, []);
    routeGrid.get(key).push(k);
  }
  function roadDistance(x, y) {
    let d = 1e9;
    const gx = Math.floor(x / 50);
    const gy = Math.floor(y / 50);
    for (let j = gy - 1; j <= gy + 1; j++) {
      for (let i = gx - 1; i <= gx + 1; i++) {
        for (const k of routeGrid.get(`${i},${j}`) ?? []) d = Math.min(d, Math.hypot(R.x[k] - x, R.y[k] - y));
      }
    }
    return d;
  }
  const buildingBounds = sc.buildings.map((b) => ringBounds(b.ring));
  buildingBounds.forEach((bb) => forVertices(bb.minX - 6, bb.minY - 6, bb.maxX + 6, bb.maxY + 6, (t, i) => { t.built[i] = 1; }));

  function gridIndex(nx, ny, skip) {
    const idx = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        if (skip?.(i, j)) continue;
        const a = j * nx + i;
        idx.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
      }
    }
    return idx;
  }
  const nearIndex = gridIndex(N + 1, N + 1);
  const terrain = new THREE.Group();
  scene.add(terrain);
  for (const t of sc.near.values()) {
    const n1 = N + 1;
    const pos = new Float32Array(n1 * n1 * 3);
    const uv = new Float32Array(n1 * n1 * 2);
    for (let j = 0; j < n1; j++) {
      for (let i = 0; i < n1; i++) {
        const k = j * n1 + i;
        pos.set([i * sc.cell, t.h[k], -j * sc.cell], k * 3);
        uv.set([(t.tx * N + i) * (sc.cell / 12) % 4096, (t.ty * N + j) * (sc.cell / 12) % 4096], k * 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(nearIndex);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.computeVertexNormals();
    const nrm = g.attributes.normal.array;
    const col = new Float32Array(n1 * n1 * 3);
    for (let k = 0; k < n1 * n1; k++) {
      const c = groundColor(t.h[k], nrm[k * 3 + 1], t.roadD[k], t.built[k], hash2(t.tx * N + (k % n1), t.ty * N + Math.floor(k / n1), 1));
      col.set([c.r, c.g, c.b], k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, groundMat);
    mesh.position.set(t.tx * sc.tile, 0, -t.ty * sc.tile);
    mesh.receiveShadow = true;
    terrain.add(mesh);
    t.mesh = mesh;
  }
  {
    const f = sc.far;
    const pos = new Float32Array(f.nx * f.ny * 3);
    const col = new Float32Array(f.nx * f.ny * 3);
    for (let j = 0; j < f.ny; j++) for (let i = 0; i < f.nx; i++) pos.set([i * f.cell, f.h[j * f.nx + i], -j * f.cell], (j * f.nx + i) * 3);
    const g = new THREE.BufferGeometry();
    // 近景のタイルがある所は描かない(近景と重なってちらつかないように)
    g.setIndex(gridIndex(f.nx, f.ny, (i, j) => !!nearTileAt(sc, f.x0 + (i + 0.5) * f.cell, f.y0 + (j + 0.5) * f.cell)));
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const nrm = g.attributes.normal.array;
    for (let k = 0; k < f.nx * f.ny; k++) {
      const c = groundColor(f.h[k], nrm[k * 3 + 1], 1e9, 0, hash2(k % f.nx, Math.floor(k / f.nx), 2));
      col.set([c.r, c.g, c.b], k * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(g, farMat);
    mesh.position.set(f.x0, 0, -f.y0);
    terrain.add(mesh);
  }

  // ---- 海(遠景の格子の範囲の1枚。その外の海は遠景が描く) ----
  const waveTex = tex(waveNormalTexture());
  const WAVE_M = 36;
  const seaW = (sc.far.nx - 1) * sc.far.cell;
  const seaH = (sc.far.ny - 1) * sc.far.cell;
  waveTex.repeat.set(seaW / WAVE_M, seaH / WAVE_M);
  const seaMat = new THREE.MeshStandardMaterial({ color: 0x1d5a7a, roughness: 0.22, metalness: 0.05, normalScale: new THREE.Vector2(0.35, 0.35) });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(seaW, seaH), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(sc.far.x0 + seaW / 2, 0, -(sc.far.y0 + seaH / 2));
  sea.receiveShadow = true;
  scene.add(sea);

  // ---- 名所(熱海城・灯台・ヤシ並木。松原は木の配置で) ----
  const landmarks = buildLandmarks(sc);
  scene.add(landmarks.group);
  const landmarkSpots = sc.landmarks.filter((l) => l.x !== undefined && l.kind !== 'pines');

  // ---- 道(10 m ごとの断面をつないだリボン) ----
  const roadMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  for (let k0 = 0; k0 < R.n - 1; k0 += ROAD_CHUNK) {
    const k1 = Math.min(k0 + ROAD_CHUNK, R.n - 1);
    const ox = R.x[k0];
    const oy = R.y[k0];
    const cols = ROAD_COLS.length;
    const pos = [];
    const col = [];
    for (let k = k0; k <= k1; k++) {
      const a = Math.max(k - 1, 0);
      const b = Math.min(k + 1, R.n - 1);
      const len = Math.hypot(R.x[b] - R.x[a], R.y[b] - R.y[a]) || 1;
      const lx = -(R.y[b] - R.y[a]) / len;
      const ly = (R.x[b] - R.x[a]) / len;
      for (const [off, dy, hex] of ROAD_COLS) {
        pos.push(R.x[k] + lx * off - ox, R.z[k] + dy, -(R.y[k] + ly * off - oy));
        _c.setHex(hex);
        col.push(_c.r, _c.g, _c.b);
      }
    }
    const idx = [];
    for (let r = 0; r < k1 - k0; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    // 法線が下を向いたら(断面の向きの取り違え)面の向きを反転する
    if (g.attributes.normal.array[1] < 0) {
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
      g.setIndex(idx);
      g.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(g, roadMat);
    mesh.position.set(ox, 0, -oy);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // ---- 建物(実在の外形。1 km のタイルごとに1つのメッシュにまとめる) ----
  const facade = tex(facadeTexture());
  const bldMat = new THREE.MeshStandardMaterial({ map: facade, vertexColors: true, roughness: 0.85 });
  const bldChunks = new Map();
  sc.buildings.forEach((b, bi) => {
    const bb = buildingBounds[bi];
    // 名所の足もとの建物(天守の外形など)は名所の形に置きかえる
    if (landmarkSpots.some((l) => Math.hypot(l.x - bb.cx, l.y - bb.cy) < 28)) return;
    const key = `${Math.floor(bb.cx / sc.tile)},${Math.floor(bb.cy / sc.tile)}`;
    if (!bldChunks.has(key)) {
      bldChunks.set(key, { ox: Math.floor(bb.cx / sc.tile) * sc.tile, oy: Math.floor(bb.cy / sc.tile) * sc.tile, pos: [], uv: [], col: [] });
    }
    const ch = bldChunks.get(key);
    let ring = [];
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < b.ring.length; i += 2) {
      ring.push([b.ring[i], b.ring[i + 1]]);
      const gh = heightAt(sc, b.ring[i], b.ring[i + 1]);
      lo = Math.min(lo, gh);
      hi = Math.max(hi, gh);
    }
    let area = 0;
    ring.forEach(([x, y], i) => { const [x2, y2] = ring[(i + 1) % ring.length]; area += x * y2 - x2 * y; });
    if (area < 0) ring = ring.reverse(); // 反時計回り(上から見て)にそろえる
    area = Math.abs(area) / 2;
    const base = Math.max(lo, -1) - 0.6;
    const top = Math.max(hi, 0) + b.height;
    const r = hash2(bi, 7, 5);
    const wall = b.kind === 2 ? 0x9a948a : WALL_COLORS[Math.floor(r * WALL_COLORS.length)];
    const roof = b.kind === 0 ? HOUSE_ROOFS[Math.floor(hash2(bi, 3, 9) * HOUSE_ROOFS.length)] : b.kind === 2 ? 0x6d7377 : 0x8d8d88;
    const P = (x, y, z) => [x - ch.ox, z, -(y - ch.oy)];
    const push = (p, u, v, hex) => { ch.pos.push(...p); ch.uv.push(u, v); _c.setHex(hex); ch.col.push(_c.r, _c.g, _c.b); };
    // 壁(窓の模様は 4 m × 1階 3.2 m ごと。倉庫などは窓なし)
    let along = 0;
    const floors = (top - base) / 3.2;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const u0 = b.kind === 2 ? 0.02 : along / 4;
      const u1 = b.kind === 2 ? 0.02 : (along + len) / 4;
      const v1 = b.kind === 2 ? 0.02 : floors;
      const vb = b.kind === 2 ? 0.02 : 0;
      push(P(x1, y1, base), u0, vb, wall);
      push(P(x2, y2, base), u1, vb, wall);
      push(P(x2, y2, top), u1, v1, wall);
      push(P(x1, y1, base), u0, vb, wall);
      push(P(x2, y2, top), u1, v1, wall);
      push(P(x1, y1, top), u0, v1, wall);
      along += len;
    }
    // 屋根: 小さな家は寄棟ふう(重心へ持ち上げる)、ほかは平らな屋上
    if (b.kind === 0 && area < 260) {
      const bbx = bb.cx;
      const bby = bb.cy;
      const rise = Math.min(2.4, 0.22 * Math.sqrt(area));
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        push(P(x1, y1, top), 0.02, 0.02, roof);
        push(P(x2, y2, top), 0.02, 0.02, roof);
        push(P(bbx, bby, top + rise), 0.02, 0.02, roof);
      }
    } else {
      const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
      for (const tri of tris) {
        // 上から見て反時計回り(= 上向きの面)にそろえる
        const [a, b2, c] = tri.map((q) => ring[q]);
        const ccw = (b2[0] - a[0]) * (c[1] - a[1]) - (b2[1] - a[1]) * (c[0] - a[0]) > 0;
        for (const q of ccw ? [a, b2, c] : [a, c, b2]) push(P(q[0], q[1], top), 0.02, 0.02, roof);
      }
    }
  });
  const bldMeshes = [];
  for (const ch of bldChunks.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(ch.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(ch.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(ch.col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, bldMat);
    mesh.position.set(ch.ox, 0, -ch.oy);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.center = [ch.ox + sc.tile / 2, ch.oy + sc.tile / 2];
    scene.add(mesh);
    bldMeshes.push(mesh);
  }

  // ---- ライダーの近くに置くもの(毎フレーム、ライダーの位置を原点に並べ直す) ----
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
  const pools = {
    dash: makePool(box, std(0xf2f2f2), 60, { cast: false }),
    rail: makePool(box, std(0xd8d8d0, { metalness: 0.4 }), 600),
    pole: makePool(box, std(0x8b8378), 40),
    tunnel: makePool(box, std(0x77746c), 400, { cast: false }),
    lamp: makePool(box, std(0xffd27a, { emissive: 0xffb43a, emissiveIntensity: 1.5 }), 80, { cast: false }),
  };
  const trees = {
    trunk: makePool(new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0), std(0x5b4632), TREE_MAX, { cast: false }),
    cone: makePool(new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0), std(0xffffff, { roughness: 0.95 }), TREE_MAX),
    ball: makePool(new THREE.IcosahedronGeometry(1, 0).translate(0, 1, 0), std(0xffffff, { roughness: 0.95, flatShading: true }), TREE_MAX),
    disc: makePool(new THREE.CylinderGeometry(1, 0.75, 1, 9).translate(0, 0.5, 0), std(0xffffff, { roughness: 0.95, flatShading: true }), TREE_MAX),
  };
  for (const p of [...Object.values(pools), ...Object.values(trees)]) scene.add(p.mesh);

  // ---- ライダー(荷物を積んだグラベルバイク) ----
  const rider = createAvatar();
  rider.group.rotation.order = 'YXZ';
  const bagMat = std(0x2f3a2c);
  for (const [w, hgt, d, y, z] of [[0.34, 0.2, 0.2, 0.92, -0.62], [0.16, 0.2, 0.42, 0.98, 0.42], [0.06, 0.2, 0.42, 0.62, -0.12]]) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), bagMat);
    bag.position.set(0, y, z);
    bag.castShadow = true;
    rider.group.add(bag);
  }
  scene.add(rider.group);

  // ---- 雨 ----
  const RAIN_N = 1800;
  const rainPos = new Float32Array(RAIN_N * 3);
  for (let i = 0; i < RAIN_N; i++) rainPos.set([(Math.random() - 0.5) * 60, Math.random() * 25 - 5, (Math.random() - 0.5) * 60], i * 3);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  // トンネルの筒の中には降らせない(地面と同じ切り抜き)
  const rain = new THREE.Points(rainGeo, cutTunnels(new THREE.PointsMaterial({ color: 0xaab4c0, size: 0.08, transparent: true, opacity: 0.7 })));
  rain.visible = false;
  rain.frustumCulled = false;
  scene.add(rain);

  let tier = TIER_SCENERY.high;
  let treeAt = null;
  // 地面の航空写真(最高・高のとき、まわりのタイルだけ)
  const photos = createAerialPhotos(sc, {
    anisotropy: Math.min(16, renderer.capabilities.getMaxAnisotropy()), patchMaterial: cutTunnels,
  });
  const s = {
    renderer, scene, camera, canvas, sunLight, textures, sky: null, clock: new THREE.Clock(),
    skyKey: null, disposed: false,
    onQualityChange(name) {
      tier = TIER_SCENERY[name] ?? TIER_SCENERY.high;
      camera.far = tier.far;
      camera.updateProjectionMatrix();
      pano?.setVisible(tier.pano);
      photos?.setTier(name);
      seaMat.normalMap = tier.waves ? waveTex : null;
      seaMat.needsUpdate = true;
      treeAt = null; // 木を置き直す
      s.skyKey = null; // 霧の濃さを掛け直す
      onQualityChange?.(name);
    },
    // 最高: 影の範囲を広げ(遠くの建物・木まで影が落ちる)、画面の解像度を端末いっぱいまで上げる
    onUltraChange(on) {
      const r = on ? 80 : 40;
      Object.assign(sunLight.shadow.camera, { left: -r, right: r, top: r, bottom: -r, far: on ? 300 : 200 });
      sunLight.shadow.camera.updateProjectionMatrix();
      if (on) renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    },
  };
  let sunDir = new THREE.Vector3(1, 0.3, 0.3).normalize();

  function rebakeSky(kind, clockMinutes) {
    const hour = Math.floor(clockMinutes / 60);
    const key = `${kind}:${Math.min(Math.max(hour, 6), 18)}`;
    if (key === s.skyKey) return;
    s.skyKey = key;
    const w = SKY_BY_WEATHER[kind] ?? SKY_BY_WEATHER.sunny;
    // 太陽: 6時に東(+X)の地平線、12時に南(+Z)の空高く、18時に西へ沈む
    const t = Math.min(Math.max((clockMinutes - 6 * 60) / (12 * 60), 0), 1);
    sunDir = new THREE.Vector3(Math.cos(t * Math.PI), Math.sin(t * Math.PI) * 0.75 + 0.05, 0.55 * Math.sin(t * Math.PI)).normalize();
    const evening = Math.max(0, (clockMinutes - 15.5 * 60) / 90);
    const horizon = new THREE.Color(w.horizon).lerp(new THREE.Color('#f2a35e'), Math.min(evening, 1) * (kind === 'sunny' ? 0.8 : 0.3));
    const old = s.sky;
    s.sky = bakeSky(renderer, {
      zenith: w.zenith, horizon: `#${horizon.getHexString()}`, ground: w.ground, sunColor: '#fff2d2', sunDir,
      cloudCover: w.cloudCover, sunGlow: w.sunGlow ?? 1, night: Math.max(0, Math.min(1, (clockMinutes - 17 * 60) / 60)),
    });
    (pano ? pano.scene : scene).background = s.sky.background;
    if (scene.environment) scene.environment = s.sky.getEnvironment();
    old?.dispose();
    scene.fog.color.copy(horizon);
    scene.fog.density = tier.pano && pano ? w.fog : Math.max(w.fog, 3.5 / tier.far);
    sunLight.intensity = 1.8 * (w.sunGlow ?? 1) * Math.max(0.15, Math.sin(t * Math.PI));
    hemi.intensity = 0.55 + 0.45 * (w.sunGlow ?? 1);
    const seaColor = kind === 'sunny' ? 0x1d5a7a : 0x2c4e5e;
    seaMat.color.setHex(seaColor);
    pano?.setAtmosphere({
      fogColor: horizon, fogDensity: scene.fog.density, sunDir, sunIntensity: sunLight.intensity, hemiIntensity: hemi.intensity, seaColor,
    });
    rain.visible = kind === 'rain' || kind === 'squall';
  }

  rebakeSky('sunny', 7 * 60);
  setupQuality(s, qualityMode);

  /** ライダーのまわりに森の木を置き直す(同じ場所はいつも同じ木)。 */
  function placeTrees(ox, oy) {
    const { treeR, treeCell } = tier;
    const r2 = treeR * treeR;
    for (let j = Math.floor((oy - treeR) / treeCell); j <= Math.ceil((oy + treeR) / treeCell); j++) {
      for (let i = Math.floor((ox - treeR) / treeCell); i <= Math.ceil((ox + treeR) / treeCell); i++) {
        const x = (i + hash2(i, j, 11)) * treeCell;
        const y = (j + hash2(i, j, 12)) * treeCell;
        if ((x - ox) ** 2 + (y - oy) ** 2 > r2) continue;
        const t = nearTileAt(sc, x, y);
        if (!t) continue;
        const k = Math.round((y - t.ty * sc.tile) / sc.cell) * (N + 1) + Math.round((x - t.tx * sc.tile) / sc.cell);
        const roadD = t.roadD[k];
        const r = hash2(i, j, 13);
        if (roadD < 40 && roadDistance(x, y) < 13) continue;
        if (landmarkSpots.some((l) => Math.abs(l.x - x) < 30 && Math.abs(l.y - y) < 30)) continue;
        const h = heightAt(sc, x, y);
        const grove = landmarks.pines.some((g) => (g.x - x) ** 2 + (g.y - y) ** 2 < g.r * g.r);
        // 松原の松は 12 m に1本くらい(格子の細かい段階でも増やしすぎない)
        if (grove && h > 0.8 && h < 25 && !t.built[k]) {
          if (hash2(i, j, 18) >= (treeCell / 12) ** 2) continue;
          // 松原: 砂地に黒松の林(幹が海風で傾き、平たい枝葉が段になる)
          const hgt = 9 + hash2(i, j, 14) * 8;
          const px = x - ox;
          const pz = -(y - oy);
          const lean = (hash2(i, j, 17) - 0.5) * 0.5;
          pushInstance(trees.trunk, px, h - 0.3, pz, 1.3, hgt * 0.8, 1.3, lean, r * 6);
          for (let d = 0; d < 2; d++) {
            const w = hgt * (0.38 - d * 0.11);
            pushInstance(trees.disc, px, h + hgt * (0.62 + d * 0.15), pz + Math.sin(lean) * hgt * (0.62 + d * 0.15),
              w, 1.2, w * 0.8, 0, r * 6 + d, d === 0 ? 0x24401f : 0x2c4d26);
          }
          continue;
        }
        if (t.built[k] && r > 0.06) continue;
        if (h < 2) continue;
        if (h < 30 && roadD < 160 && r < 0.45) continue; // 町はずれの畑・草地
        const hgt = 5 + hash2(i, j, 14) * 9;
        const conifer = hash2(i, j, 15) < 0.35 + Math.min(h / 600, 0.4);
        const px = x - ox;
        const pz = -(y - oy);
        pushInstance(trees.trunk, px, h - 0.3, pz, 1, hgt * 0.45, 1);
        if (conifer) {
          pushInstance(trees.cone, px, h + hgt * 0.22, pz, hgt * 0.24, hgt * 0.8, hgt * 0.24, 0, r * 6,
            r < 0.5 ? 0x264a26 : 0x2f5a2c);
        } else {
          const w = hgt * (0.3 + hash2(i, j, 16) * 0.15);
          pushInstance(trees.ball, px, h + hgt * 0.35, pz, w, hgt * 0.32, w, 0, r * 6,
            [0x3d6a2e, 0x4a7834, 0x35602a, 0x56803a][Math.floor(r * 4)]);
        }
      }
    }
    for (const p of Object.values(trees)) {
      commitPool(p);
      p.mesh.position.set(ox, 0, -oy);
    }
  }

  const P0 = {};
  const PA = {};
  const PB = {};
  const PC = {};
  const camPos = new THREE.Vector3();
  let camInit = false;
  let view = normalizeCameraView(cameraView);
  const fpCam = {};

  /**
   * 1フレーム描く。
   * @param {{segmentM:number, speedKmh:number, gradePercent:number, weatherKind:string, clockMinutes:number, cadenceRpm?:number}} f
   */
  function draw({ segmentM, speedKmh, gradePercent, weatherKind, clockMinutes, cadenceRpm }) {
    if (s.disposed) return;
    rebakeSky(weatherKind, clockMinutes);
    const m0 = segmentM;
    routeAt(m0, P0);
    const ox = P0.x;
    const oy = P0.y;
    // ライダーの位置を原点にした座標(世界の座標は大きいので、毎フレームの置き物はこの原点からの相対で置く)
    const local = (p, off, dz = 0) => [p.x - p.hy * off - ox, p.z + dz, -(p.y + p.hx * off - oy)];
    const yawOf = (p) => Math.atan2(p.hx, -p.hy);

    if (!treeAt || Math.hypot(ox - treeAt[0], oy - treeAt[1]) > TREE_REBUILD_M) {
      treeAt = [ox, oy];
      placeTrees(ox, oy);
    }

    // 中央線(10m ごとに 5m の破線。絶対位置にそろえるので走ると流れる)
    for (let mm = Math.ceil((m0 - 30) / 10) * 10; mm < m0 + 220; mm += 10) {
      routeAt(mm + 2.5, PA);
      const [x, y, z] = local(PA, 0, 0.05);
      pushInstance(pools.dash, x, y, z, 0.14, 0.02, 5, 0, yawOf(PA));
    }
    // トンネル・ガードレール(道の脇が 2.5 m 以上落ち込む側 = 崖・海・橋)・電柱(高い側)
    for (let mm = Math.ceil((m0 - 30) / 4) * 4; mm < m0 + 420; mm += 4) {
      routeAt(mm, PA);
      routeAt(mm + 4, PB);
      const yaw = yawOf(PA);
      const pitch = Math.atan2(PB.z - PA.z, 4);
      const inTunnel = tubeAt(mm);
      // トンネルの坑口(山肌から出たコンクリートの壁。筒を延ばした所はその先端)
      for (const tn of tubes) {
        for (const end of [tn.fromM, tn.toM]) {
          if (end < mm || end >= mm + 4) continue;
          routeAt(end, PC);
          const pyaw = yawOf(PC);
          for (const off of [-7.2, 7.2]) {
            const [x, y, z] = local(PC, off);
            pushInstance(pools.tunnel, x, y - 0.5, z, 3.2, 6, 1.4, 0, pyaw, 0xb4afa3);
          }
          const [x, y, z] = local(PC, 0, 5.5);
          pushInstance(pools.tunnel, x, y, z, 17.6, 4.5, 1.4, 0, pyaw, 0xb4afa3);
        }
      }
      if (inTunnel) {
        for (const off of [-5.6, 5.6]) {
          const [x, y, z] = local(PA, off);
          pushInstance(pools.tunnel, x, y, z, 0.6, 5.5, 4.3, 0, yaw);
        }
        const [x, y, z] = local(PA, 0, 5.5);
        pushInstance(pools.tunnel, x, y, z, 11.8, 0.5, 4.3, 0, yaw);
        if (mm % 12 === 0) {
          const [lx, ly, lz] = local(PA, -4.8, 4.6);
          pushInstance(pools.lamp, lx, ly, lz, 0.2, 0.15, 1.2, 0, yaw);
        }
        continue;
      }
      if (mm - m0 > 280) continue;
      let high = 1;
      let highH = -Infinity;
      for (const side of [-1, 1]) {
        const gx = PA.x - PA.hy * side * 9;
        const gy = PA.y + PA.hx * side * 9;
        const gh = heightAt(sc, gx, gy);
        if (gh > highH) { highH = gh; high = side; }
        if (PA.z - gh > 2.5) {
          const [x, y, z] = local(PA, side * 5.3);
          pushInstance(pools.rail, x, y, z, 0.12, 0.75, 0.12, 0, 0);
          const [bx, by, bz] = local(PA, side * 5.25, 0.55);
          // ビームは次の柱まで(4 m)。中点に置く
          pushInstanceYawPitch(pools.rail, bx + (PB.x - PA.x) / 2, by + (PB.z - PA.z) / 2, bz - (PB.y - PA.y) / 2,
            0.05, 0.3, 4.05, yaw, -pitch);
        }
      }
      if (mm % 40 === 0) {
        const [x, y, z] = local(PA, high * 6.2);
        pushInstance(pools.pole, x, y, z, 0.3, 9, 0.3, 0, 0);
      }
    }
    for (const p of Object.values(pools)) {
      commitPool(p);
      p.mesh.position.set(ox, 0, -oy);
    }

    // 建物は描画品質の距離まで
    for (const mesh of bldMeshes) {
      const [cx, cy] = mesh.userData.center;
      mesh.visible = Math.hypot(cx - ox, cy - oy) < tier.bldM + 800;
    }

    // ライダー(左側通行: 進む向きの左 2 m)・カメラ・影
    const lane = -RIDER_X_M;
    const [rx, ry, rz] = local(P0, lane);
    rider.group.position.set(rx + ox, ry, rz - oy);
    rider.group.rotation.y = Math.atan2(-P0.hx, P0.hy);
    updateRiderAvatar(rider, s.clock, speedKmh, -Math.atan(gradePercent / 100));
    setAvatarVisible(rider, view !== 'fp');
    if (view === 'fp') {
      // 目線: ハンドルの少し後ろ・目の高さ。ペダルを踏むたびに少し上下し、速いほど画角が広がる
      const bob = fpBobM(fpCam, cadenceRpm ?? estimateCadenceRpm(speedKmh), rider.dt ?? 0.016);
      routeAt(m0 + 0.3, PA);
      const [ex, ey, ez] = local(PA, lane, rider.camera.eyeM + bob);
      camPos.set(ex + ox, ey, ez - oy);
      camera.position.copy(camPos);
      routeAt(m0 + FP_LOOK_M, PB);
      const [lx, ly, lz] = local(PB, lane, 1.2);
      camera.lookAt(lx + ox, ly, lz - oy);
      setCameraFov(camera, fpFovDeg(speedKmh / 3.6));
      camInit = false; // ほかの視点に戻したら、その位置へすぐ移る
    } else {
      // 上空の視点はトンネル(とその手前)では後ろの視点に下りる(山の上からでは自分が見えないので)
      const rig = VIEW_RIGS[view === 'high' && (tubeAt(m0) || tubeAt(m0 + 15)) ? 'chase' : view];
      routeAt(m0 - rig.backM, PA);
      const [cx, cy, cz] = local(PA, lane - 0.3, rig.upM);
      const target = new THREE.Vector3(cx + ox, cy, cz - oy);
      const k = camInit ? 1 - Math.exp(-(rider.dt ?? 0.016) * 5) : 1;
      camInit = true;
      camPos.lerp(target, k);
      camera.position.copy(camPos);
      routeAt(m0 + rig.aheadM, PB);
      const [lx, ly, lz] = local(PB, lane, rig.lookUpM);
      camera.lookAt(lx + ox, ly, lz - oy);
      setCameraFov(camera, rig.fov);
    }
    sunLight.target.position.set(rider.group.position.x, ry, rider.group.position.z);
    sunLight.position.copy(sunLight.target.position).addScaledVector(sunDir, 120);

    const tsec = s.clock.elapsedTime;
    waveTex.offset.set((tsec * 0.004) % 1, (tsec * 0.006) % 1);
    photos?.update(ox, oy);
    updateTunnelCut(ox, oy);

    if (rain.visible) {
      rain.position.copy(camera.position);
      const fall = (weatherKind === 'squall' ? 22 : 12) * (rider.dt ?? 0.016);
      for (let i = 0; i < RAIN_N; i++) {
        let yv = rainPos[i * 3 + 1] - fall;
        if (yv < -5) yv += 25;
        rainPos[i * 3 + 1] = yv;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    adaptQuality(s);
    renderer.clear();
    if (pano) {
      pano.follow(camera);
      renderer.render(pano.scene, pano.camera);
      renderer.clearDepth();
    }
    renderer.render(scene, camera);
  }

  return {
    draw,
    resize: () => resizeScene(s),
    setQualityMode: (mode) => setQualityMode(s, mode),
    /** 視点('chase' | 'fp' | 'high')。 */
    setCameraView(v) {
      const next = normalizeCameraView(v);
      if (next !== view) camInit = false;
      view = next;
    },
    dispose() {
      s.disposed = true;
      photos?.dispose();
      pano?.dispose();
      disposeScene(s);
    },
  };
}
