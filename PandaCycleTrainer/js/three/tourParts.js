// 観光地コース(京都・東山/奈良公園/河口湖)の町並み・名物の3D部品(LandscapeScene が使う)。
// 配置は tourLayout.js(純粋ロジック)が決め、ここでは形を作ってインスタンスとして置くだけ。
//
// - 京町家: 1F の格子・暖簾、2F の虫籠窓は Canvas 2D で描いた小さなアトラスで、木部・漆喰・瓦は
//   頂点カラーで塗る(1種類1 draw call。外壁の色味はインスタンスの色で変える)。
// - そのほか(提灯・石灯籠・柳・鹿・池/小川の水面・京都タワー・遊覧船・河口湖大橋)は単色の
//   インスタンスのプール。どれも画像ファイルを使わない(ビルド・アセット不要の制約)。

import THREE from './three.js';
import { mergeGeometries, makePool, pushInstance, pushInstanceYawPitch } from './sceneKit.js';

const MAX_MACHIYA = 130; // 種類ごと
const MAX_LANTERNS = 160;
const MAX_STONE_LANTERNS = 480;
const MAX_WILLOWS = 60;
const MAX_DEER = 160;
const MAX_PONDS = 4;
const MAX_CANAL = 4;
const MAX_TOWERS = 3;
const MAX_STEAMERS = 3;
const MAX_BRIDGE_PIERS = 80;

// 京町家の模型の基準の奥行き(m)。インスタンスの X スケール = 奥行き / これ
const MACHIYA_DEPTH_M = 11;
// 水面は道路より少し低い(小川の水面 = 道路 − 1.0m、池 = 池の中心の道路 − 1.3m)
const CANAL_WATER_DROP_M = 1.0;
const POND_WATER_DROP_M = 1.3;

// ---- 町家のアトラス(1F の格子/店先、2F の虫籠窓) ----
const ATLAS_W = 512;
const ATLAS_H = 256;
// [x, y, w, h](キャンバスのピクセル。y は上から)
const CELLS = {
  lattice: [0, 0, 256, 128],
  shop: [256, 0, 256, 128],
  upper: [0, 128, 256, 96],
};
const PLAIN_PX = [384, 200]; // 何も描いていない白い所

function buildMachiyaAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  // 1F: 千本格子と格子戸、紺の暖簾
  {
    const [x, y, w, h] = CELLS.lattice;
    ctx.fillStyle = '#3b2a1d';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#6b4c33';
    for (let i = 0; i < w; i += 5) ctx.fillRect(x + i, y + 6, 2.4, h - 10);
    ctx.fillStyle = '#4a3424';
    ctx.fillRect(x, y, w, 7);
    ctx.fillRect(x, y + h - 5, w, 5);
    // 入口(格子戸の奥は暗い)と暖簾
    ctx.fillStyle = '#1b130d';
    ctx.fillRect(x + 150, y + 10, 56, h - 15);
    ctx.fillStyle = '#23365c';
    ctx.fillRect(x + 150, y + 10, 56, 48);
    ctx.fillStyle = '#e9e4d8';
    ctx.beginPath();
    ctx.arc(x + 178, y + 32, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1b130d';
    ctx.lineWidth = 2;
    for (const o of [168, 188]) {
      ctx.beginPath();
      ctx.moveTo(x + o, y + 22);
      ctx.lineTo(x + o, y + 58);
      ctx.stroke();
    }
  }
  // 1F: 店先(明るい店内、赤い暖簾、木の看板)
  {
    const [x, y, w, h] = CELLS.shop;
    ctx.fillStyle = '#3b2a1d';
    ctx.fillRect(x, y, w, h);
    const glow = ctx.createLinearGradient(0, y + 30, 0, y + h);
    glow.addColorStop(0, '#d9b884');
    glow.addColorStop(1, '#8a6a44');
    ctx.fillStyle = glow;
    ctx.fillRect(x + 14, y + 26, w - 28, h - 32);
    // 棚の品物
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = ['#c0392b', '#e8d8b0', '#4f7a3a', '#d98e32', '#ffffff'][i % 5];
      ctx.fillRect(x + 22 + i * 12, y + 82 + (i % 3) * 8, 9, 10);
    }
    ctx.fillStyle = '#a3241a';
    ctx.fillRect(x + 14, y + 26, w - 28, 34);
    ctx.strokeStyle = '#5a120c';
    ctx.lineWidth = 2;
    for (let i = 1; i < 6; i++) {
      ctx.beginPath();
      ctx.moveTo(x + 14 + ((w - 28) * i) / 6, y + 34);
      ctx.lineTo(x + 14 + ((w - 28) * i) / 6, y + 60);
      ctx.stroke();
    }
    ctx.fillStyle = '#f3ead2';
    ctx.font = 'bold 22px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('京', x + w / 2, y + 44);
    // 看板
    ctx.fillStyle = '#2a1d14';
    ctx.fillRect(x + 70, y + 2, 116, 22);
    ctx.fillStyle = '#e2c25a';
    ctx.font = 'bold 18px serif';
    ctx.fillText('名物 八ツ橋', x + w / 2, y + 13);
  }
  // 2F: 漆喰の壁と虫籠窓
  {
    const [x, y, w, h] = CELLS.upper;
    ctx.fillStyle = '#d6c9ad';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#2f241b';
    for (const wx of [24, 140]) {
      ctx.fillRect(x + wx, y + 26, 92, 40);
      ctx.fillStyle = '#c9bb9d';
      for (let i = 4; i < 92; i += 9) ctx.fillRect(x + wx + i, y + 26, 4, 40);
      ctx.fillStyle = '#2f241b';
    }
    ctx.fillStyle = '#5a4232';
    ctx.fillRect(x, y + h - 6, w, 6);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** ジオメトリに頂点カラーと UV(アトラスの cell、なければ白い所)を付ける。 */
function paint(geo, hex, cell = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const pos = g.attributes.position;
  const color = new THREE.Color(hex);
  const colors = new Float32Array(pos.count * 3);
  const uvs = new Float32Array(pos.count * 2);
  const src = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    colors.set([color.r, color.g, color.b], i * 3);
    if (cell && src) {
      const [x, y, w, h] = cell;
      uvs[i * 2] = (x + src.getX(i) * w) / ATLAS_W;
      uvs[i * 2 + 1] = 1 - (y + (1 - src.getY(i)) * h) / ATLAS_H;
    } else {
      uvs[i * 2] = (PLAIN_PX[0] + 0.5) / ATLAS_W;
      uvs[i * 2 + 1] = 1 - (PLAIN_PX[1] + 0.5) / ATLAS_H;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function mergePainted(list) {
  const merged = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
    const array = new Float32Array(list.reduce((n, g) => n + g.attributes[name].count * size, 0));
    let offset = 0;
    for (const g of list) {
      array.set(g.attributes[name].array, offset);
      offset += g.attributes[name].count * size;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  for (const g of list) g.dispose();
  return merged;
}

const boxAt = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** 正面(+X 向き)の面。幅は Z 方向(−0.5〜0.5)、高さ y0〜y1、x の位置に立てる。 */
function facadePlane(x, y0, y1, halfZ = 0.5) {
  return new THREE.PlaneGeometry(2 * halfZ, y1 - y0).rotateY(Math.PI / 2).translate(x, (y0 + y1) / 2, 0);
}

/** 切妻の大屋根(棟は Z 方向、平入り)。軒先は正面(+X)と背面へ張り出す。 */
function gableRoof(x0, x1, eaveY, ridgeY, halfZ) {
  const xm = (x0 + x1) / 2;
  const p = [
    [x1, eaveY, halfZ], [x1, eaveY, -halfZ], [xm, ridgeY, -halfZ], [x1, eaveY, halfZ], [xm, ridgeY, -halfZ], [xm, ridgeY, halfZ],
    [x0, eaveY, -halfZ], [x0, eaveY, halfZ], [xm, ridgeY, halfZ], [x0, eaveY, -halfZ], [xm, ridgeY, halfZ], [xm, ridgeY, -halfZ],
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

/** 妻壁(屋根の下の三角の壁、両端)。 */
function gableWalls(x0, x1, y0, y1, halfZ) {
  const xm = (x0 + x1) / 2;
  const p = [];
  for (const z of [-halfZ, halfZ]) p.push(x0, y0, z, x1, y0, z, xm, y1, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * 京町家(2階建て、平入りの瓦屋根、1F と 2F の間に一文字の庇)。原点は正面の壁の足元の中央、
 * 正面は +X、間口は Z 方向に 1(インスタンスの Z スケールが間口の幅)、奥行きは MACHIYA_DEPTH_M。
 */
function buildMachiyaGeometry(shop) {
  const D = MACHIYA_DEPTH_M;
  const WOOD = 0x4a3526;
  const PLASTER = 0xcbbd9f;
  const TILE = 0x3b3d40;
  const parts = [
    paint(boxAt(D, 4.0, 1, -D / 2, 1.0, 0), WOOD), // 1F(地面の下 1m まで)
    paint(boxAt(D - 0.6, 2.7, 1, -D / 2 - 0.3, 4.35, 0), PLASTER), // 2F(少し奥に下がる)
    paint(facadePlane(0.012, 0.0, 2.85), 0xffffff, shop ? CELLS.shop : CELLS.lattice),
    paint(facadePlane(-0.588, 3.35, 5.55), 0xffffff, CELLS.upper),
    // 一文字の庇(道路側へ下がる)
    paint(new THREE.BoxGeometry(1.3, 0.12, 1.02).rotateZ(-0.32).translate(0.2, 3.1, 0), TILE),
    paint(gableRoof(-D - 0.5, 0.6, 5.55, 7.4, 0.51), TILE),
    paint(gableWalls(-D, -0.6, 5.7, 7.3, 0.5), PLASTER),
    paint(boxAt(D * 0.5, 0.3, 1.02, -D / 2 + 0.05, 7.4, 0).scale(1, 1, 1), 0x2c2d30), // 棟
  ];
  if (!shop) parts.push(paint(boxAt(0.35, 0.55, 0.8, 0.18, 0.27, 0), 0x6e5536)); // 犬矢来
  return mergePainted(parts);
}

/** 石灯籠(春日大社の参道に並ぶ形、高さ約2.2m)。 */
function buildStoneLanternGeometry() {
  return mergeGeometries([
    new THREE.CylinderGeometry(0.42, 0.48, 0.3, 6).translate(0, 0.0, 0),
    new THREE.CylinderGeometry(0.28, 0.38, 0.16, 6).translate(0, 0.23, 0),
    new THREE.CylinderGeometry(0.13, 0.15, 0.9, 10).translate(0, 0.76, 0),
    new THREE.CylinderGeometry(0.36, 0.2, 0.18, 6).translate(0, 1.3, 0),
    new THREE.CylinderGeometry(0.25, 0.25, 0.4, 6).translate(0, 1.59, 0),
    new THREE.ConeGeometry(0.58, 0.32, 6).translate(0, 1.95, 0),
    new THREE.SphereGeometry(0.11, 8, 6).translate(0, 2.17, 0),
  ]);
}

/** 柳の樹冠(丸い頭と、そこから垂れ下がる枝のカーテン)。幹は木の幹のプール。 */
function buildWillowGeometry() {
  const curtain = new THREE.CylinderGeometry(2.3, 2.9, 3.8, 18, 4, true);
  const pos = curtain.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = pos.getY(i);
    const th = Math.atan2(x, z);
    const k = 1 + 0.1 * Math.sin(th * 13) + 0.06 * Math.sin(th * 5 + y);
    pos.setXYZ(i, x * k, y + (Math.sin(th * 9) * 0.35 - 0.1) * (y < 0 ? 1 : 0), z * k);
  }
  curtain.computeVertexNormals();
  return mergeGeometries([
    new THREE.SphereGeometry(2.4, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.55, 1).translate(0, 5.7, 0),
    curtain.translate(0, 3.8, 0),
  ]);
}

/** 鹿(静止)。pose = 'stand'(顔を上げる)/'graze'(草を食む)。原点は足元、前は −Z。 */
function buildDeerGeometry(pose) {
  const parts = [
    new THREE.SphereGeometry(1, 12, 9).scale(0.25, 0.28, 0.58).translate(0, 0.86, 0),
    new THREE.SphereGeometry(0.1, 8, 6).scale(1, 1, 0.6).translate(0, 0.95, 0.56), // 尻
  ];
  for (const [x, z] of [[-0.12, -0.38], [0.12, -0.38], [-0.12, 0.38], [0.12, 0.38]]) {
    parts.push(new THREE.CylinderGeometry(0.035, 0.03, 0.78, 6).translate(x, 0.39, z));
  }
  const neck = (from, to) => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const geo = new THREE.CylinderGeometry(0.07, 0.1, a.distanceTo(b), 8);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
    const m = a.add(b).multiplyScalar(0.5);
    return geo.translate(m.x, m.y, m.z);
  };
  if (pose === 'graze') {
    parts.push(neck([0, 0.92, -0.42], [0, 0.42, -0.74]));
    parts.push(new THREE.SphereGeometry(1, 10, 8).scale(0.09, 0.09, 0.18).rotateX(-1.0).translate(0, 0.3, -0.84));
  } else {
    parts.push(neck([0, 0.95, -0.42], [0, 1.32, -0.58]));
    parts.push(new THREE.SphereGeometry(1, 10, 8).scale(0.09, 0.09, 0.18).translate(0, 1.36, -0.68));
    for (const sx of [-1, 1]) parts.push(new THREE.SphereGeometry(1, 6, 4).scale(0.09, 0.035, 0.05).translate(sx * 0.1, 1.44, -0.6)); // 耳
  }
  return mergeGeometries(parts);
}

/** 京都タワー(白い塔と、展望室の赤い帯)。高さ約131m。 */
function buildTowerGeometries() {
  const white = mergeGeometries([
    new THREE.BoxGeometry(40, 31, 22).translate(0, 15.5 - 5, 0), // 京都タワービル(地下まで)
    new THREE.CylinderGeometry(3.2, 6.8, 68, 20).translate(0, 26 + 34, 0),
    new THREE.CylinderGeometry(7.6, 6.4, 8, 24).translate(0, 98, 0),
    new THREE.CylinderGeometry(2.2, 3.2, 10, 12).translate(0, 107, 0),
    new THREE.CylinderGeometry(0.5, 1.6, 20, 8).translate(0, 122, 0),
  ]);
  const red = mergeGeometries([
    new THREE.CylinderGeometry(7.75, 7.75, 1.4, 24).translate(0, 100.5, 0),
    new THREE.CylinderGeometry(7.0, 7.0, 1.0, 24).translate(0, 95.0, 0),
    new THREE.CylinderGeometry(0.55, 0.55, 3, 8).translate(0, 131, 0),
  ]);
  return { white, red };
}

/** 河口湖の遊覧船(戦国武将の御座船を模した船。黒い船体に朱と金の楼閣)。前は −Z。 */
function buildSteamerGeometries() {
  const hull = mergeGeometries([
    new THREE.BoxGeometry(6.4, 2.6, 22).translate(0, 0.2, 1),
    new THREE.ConeGeometry(3.2, 7, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.55).rotateX(-Math.PI / 2).translate(0, 0.2, -13.3),
  ]);
  const red = mergeGeometries([
    new THREE.BoxGeometry(5.6, 2.4, 13).translate(0, 2.7, 2),
    new THREE.BoxGeometry(4.2, 2.2, 6).translate(0, 5.0, 3),
  ]);
  const gold = mergeGeometries([
    new THREE.ConeGeometry(4.3, 1.6, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 1.6).translate(0, 4.7, 2),
    new THREE.ConeGeometry(3.4, 1.4, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 1.4).translate(0, 6.8, 3),
    new THREE.CylinderGeometry(0.12, 0.12, 9, 6).translate(0, 7, -5),
    new THREE.BoxGeometry(0.1, 2.6, 3.2).translate(0, 9.6, -3.5), // 旗
  ]);
  return { hull, red, gold };
}

/**
 * 観光地の部品(プール)を作って inner に加える。
 * @returns {{pools: object, glowMaterials: Array, textures: THREE.Texture[]}}
 */
export function buildTourParts(inner, L, waterColor) {
  const pools = {};
  const textures = [];
  const glowMaterials = [];
  const kind = L.tour.kind;
  const water = new THREE.MeshStandardMaterial({ color: waterColor, roughness: 0.1, metalness: 0 });
  if (kind === 'kyoto') {
    const atlas = buildMachiyaAtlas();
    textures.push(atlas);
    const material = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    pools.machiya0 = makePool(buildMachiyaGeometry(false), material, MAX_MACHIYA);
    pools.machiya1 = makePool(buildMachiyaGeometry(true), material, MAX_MACHIYA);
    const lanternMat = new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: 0x5a2a10, emissiveIntensity: 0.6 });
    pools.lanterns = makePool(new THREE.SphereGeometry(0.15, 10, 8).scale(1, 1.35, 1), lanternMat, MAX_LANTERNS, { cast: false });
    glowMaterials.push({ material: lanternMat, night: 5 });
    pools.canalWater = makePool(new THREE.BoxGeometry(1, 0.1, 1), water, MAX_CANAL, { cast: false });
    const tower = buildTowerGeometries();
    pools.towerWhite = makePool(tower.white, new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.5 }), MAX_TOWERS, { cast: false });
    pools.towerRed = makePool(tower.red, new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.5 }), MAX_TOWERS, { cast: false });
  }
  if (kind === 'kyoto' || kind === 'nara') {
    pools.willows = makePool(buildWillowGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide }), MAX_WILLOWS);
  }
  if (kind === 'nara') {
    pools.stoneLanterns = makePool(buildStoneLanternGeometry(), new THREE.MeshStandardMaterial({ color: 0x7f7c72, roughness: 1 }), MAX_STONE_LANTERNS, { cast: false });
    const deerMat = new THREE.MeshStandardMaterial({ color: 0x9b6b3d, roughness: 0.9 });
    pools.deerStand = makePool(buildDeerGeometry('stand'), deerMat, MAX_DEER);
    pools.deerGraze = makePool(buildDeerGeometry('graze'), deerMat, MAX_DEER);
    pools.pondWater = makePool(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), water, MAX_PONDS, { cast: false });
  }
  if (kind === 'kawaguchiko') {
    const steamer = buildSteamerGeometries();
    pools.steamerHull = makePool(steamer.hull, new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.5 }), MAX_STEAMERS, { cast: false });
    pools.steamerRed = makePool(steamer.red, new THREE.MeshStandardMaterial({ color: 0xa8322a, roughness: 0.5 }), MAX_STEAMERS, { cast: false });
    pools.steamerGold = makePool(steamer.gold, new THREE.MeshStandardMaterial({ color: 0xc9a640, roughness: 0.4, metalness: 0.3 }), MAX_STEAMERS, { cast: false });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.85 });
    pools.bridgeDecks = makePool(new THREE.BoxGeometry(1, 1, 1), concrete, 4, { cast: false });
    pools.bridgePiers = makePool(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), concrete, MAX_BRIDGE_PIERS, { cast: false });
  }
  for (const pool of Object.values(pools)) inner.add(pool.mesh);
  return { pools, glowMaterials, textures };
}

/**
 * tourLayout.js の配置物をプールへ置く(placeObjects から、組み直しのたびに呼ばれる)。
 * @param {object} st LandscapeScene の状態
 * @param {object} tour collectTourObjects の結果
 * @param {object} h { groundAt(s,d), local(s,d,height) → [x,y,z,道路の向き], blocked(s,d,r), floorM }
 */
export function placeTourObjects(st, tour, { groundAt, local, blocked, floorM }) {
  const { elev, anchorElev, pools: p } = st;

  for (const m of tour.machiya) {
    if (blocked(m.s, m.d, m.widthM / 2)) continue;
    const [x, y, z, roadYaw] = local(m.s, m.d, groundAt(m.s, m.d));
    // 正面(模型の +X)を道路へ向ける: 左側はそのまま、右側は反転
    const yaw = roadYaw + (m.side > 0 ? Math.PI : 0);
    pushInstance(p[`machiya${m.variant}`], x, y, z, m.depthM / MACHIYA_DEPTH_M, m.heightScale, m.widthM, 0, yaw, m.tint);
  }
  for (const ln of tour.lanterns) {
    if (blocked(ln.s, ln.d, 0.3)) continue;
    const [x, y, z] = local(ln.s, ln.d, groundAt(ln.s, ln.d));
    pushInstance(p.lanterns, x, y + 2.45, z, 1, 1, 1, 0, 0, ln.color);
  }
  for (const sl of tour.stoneLanterns) {
    if (blocked(sl.s, sl.d, 0.5)) continue;
    const [x, y, z, roadYaw] = local(sl.s, sl.d, groundAt(sl.s, sl.d));
    pushInstance(p.stoneLanterns, x, y + 0.1, z, 0.9, 0.9, 0.9, 0, roadYaw + sl.yaw, sl.tint);
  }
  for (const w of tour.willows) {
    if (blocked(w.s, w.d, 2)) continue;
    const [x, y, z] = local(w.s, w.d, groundAt(w.s, w.d));
    pushInstance(p.trunks, x, y - 0.3, z, w.scale * 1.3, 5.6 * w.scale, w.scale * 1.3);
    pushInstance(p.willows, x, y, z, w.scale, w.scale, w.scale, 0, w.s, 0x87a83f);
  }
  for (const dr of tour.deer) {
    if (blocked(dr.s, dr.d, 0.8)) continue;
    const [x, y, z] = local(dr.s, dr.d, groundAt(dr.s, dr.d));
    pushInstance(dr.pose === 'graze' ? p.deerGraze : p.deerStand, x, y, z, dr.scale, dr.scale, dr.scale, 0, dr.yaw, 0xffffff);
  }
  for (const pd of tour.ponds) {
    const [x, , z, roadYaw] = local(pd.s, pd.d, 0);
    // 水面の X(横)= rLat、Z(道路沿い)= rAlong。少し大きめにして岸の斜面に沈める
    pushInstance(p.pondWater, x, elev.elevAt(pd.s) - POND_WATER_DROP_M - anchorElev, z, pd.rLatM * 1.12, 1, pd.rAlongM * 1.12, 0, roadYaw);
  }
  for (const c of tour.canal) {
    // 小川は短い区間(4m)ごとの板で、道路の高さ・向きに沿わせる
    const dMid = (c.dIn + c.dOut) / 2;
    const width = Math.abs(c.dOut - c.dIn) + 0.6;
    for (let s = c.fromS; s < c.toS; s += 4) {
      const [x0, , z0] = local(s, dMid, 0);
      const [x1, , z1] = local(s + 4, dMid, 0);
      const yMid = elev.elevAt(s + 2) - CANAL_WATER_DROP_M - anchorElev;
      const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
      pushInstanceYawPitch(p.canalWater, (x0 + x1) / 2, yMid, (z0 + z1) / 2, width, 1, Math.hypot(x1 - x0, z1 - z0) + 0.3, yaw, 0);
    }
  }
  for (const t of tour.towers) {
    const [x, y, z, roadYaw] = local(t.s, t.d, groundAt(t.s, t.d));
    pushInstance(p.towerWhite, x, y, z, 1, 1, 1, 0, roadYaw);
    pushInstance(p.towerRed, x, y, z, 1, 1, 1, 0, roadYaw);
  }
  for (const sm of tour.steamers) {
    if (groundAt(sm.s, sm.d) > floorM - 1.5) continue; // 湖の上だけ
    const [x, , z, roadYaw] = local(sm.s, sm.d, 0);
    const y = floorM - anchorElev;
    // 湖岸と平行に、こちらと同じ向きへ進む姿
    for (const pool of [p.steamerHull, p.steamerRed, p.steamerGold]) pushInstance(pool, x, y, z, 1.4, 1.4, 1.4, 0, roadYaw);
  }
  for (const b of tour.bridges) {
    // 河口湖大橋: 湖岸から対岸までまっすぐ渡る桁と、等間隔の橋脚
    const [x0, , z0] = local(b.s, b.dFrom, 0);
    const [x1, , z1] = local(b.s, b.dTo, 0);
    const deckY = floorM + 9 - anchorElev;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
    pushInstanceYawPitch(p.bridgeDecks, (x0 + x1) / 2, deckY, (z0 + z1) / 2, 12, 1.4, len, yaw, 0);
    const piers = Math.min(MAX_BRIDGE_PIERS, Math.floor(len / 45));
    for (let i = 1; i < piers; i++) {
      const t = i / piers;
      pushInstanceYawPitch(p.bridgePiers, x0 + (x1 - x0) * t, floorM - 6 - anchorElev, z0 + (z1 - z0) * t, 3, 6 + 8.3, 2.2, yaw + Math.PI / 2, 0);
    }
  }
}
