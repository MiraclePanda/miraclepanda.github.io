// 森の木の形(InstancedMesh 用の単位ジオメトリ)。realRoadScene の placeTrees が使う。
//
// 近くの木(near)は葉の塊・枝の段が分かる作り込んだ形、遠くの木(far)は頂点の少ない形にして、
// 2 万本を超える木でも描画が重くなりすぎないようにする。どちらも
//   - 頂点色で「上は明るく、下と内側は暗く」(葉の塊の陰。インスタンス色 = 木の色と掛け合わされる)
//   - 樹冠の法線を中心から外向きに寄せる(葉の集まりらしく柔らかい陰影になり、角ばって見えない)
// を焼き込む。形は乱数ではなく固定の式で決め、毎回同じ形になる(木ごとの違いは向きと大きさで出す)。
//
// 単位(placeTrees の拡大率に合わせた座標):
//   樹冠 canopy  : x/z は -1〜1、y は 0〜2(旧 IcosahedronGeometry(1).translate(0, 1, 0) と同じ)
//   針葉樹 conifer: 底の半径 1、y は 0〜1(旧 ConeGeometry(1, 1).translate(0, 0.5, 0) と同じ)
//   松の枝葉 pad : x/z は -1〜1、y は 0〜1(旧 CylinderGeometry(1, 0.75, 1).translate(0, 0.5, 0) と同じ)
//   幹 trunk     : 根元 y=0〜先 y=1
import THREE from './three.js';

/** 位置だけで決まるなめらかなデコボコ(継ぎ目の重複頂点も同じだけ動くので割れない)。 */
function bump(x, y, z, seed) {
  return Math.sin(x * 4.7 + seed) * Math.sin(y * 5.3 + seed * 1.7) * 0.5
    + Math.sin(z * 6.1 + x * 2.3 + seed * 0.6) * 0.3
    + Math.sin((x + y + z) * 9.7 + seed * 2.9) * 0.2;
}

/**
 * 葉の塊1つ(デコボコの球)。center を中心に半径 (rx, ry, rz)。
 * 法線は塊の中心と樹冠の中心(crown)からの外向きを混ぜ、頂点色は高さと塊の中の位置で陰をつける。
 */
function lump(detail, center, [rx, ry, rz], seed, crown, shade) {
  const geo = new THREE.IcosahedronGeometry(1, detail); // 多面体は元からインデックスなし
  const pos = geo.attributes.position;
  const n = pos.count;
  const normals = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const out = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 1 + 0.18 * bump(v.x, v.y, v.z, seed);
    const x = center[0] + v.x * rx * k;
    const y = center[1] + v.y * ry * k;
    const z = center[2] + v.z * rz * k;
    pos.setXYZ(i, x, y, z);
    // 柔らかい陰影: 塊の外向き 45% + 樹冠全体の外向き 55%
    out.set(x - crown[0], (y - crown[1]) * 1.2, z - crown[2]).normalize().multiplyScalar(0.55);
    out.addScaledVector(v.normalize(), 0.45).normalize();
    normals.set([out.x, out.y, out.z], i * 3);
    const c = shade(x, y, z, v.y);
    colors.set([c, c * 1.02, c * 0.96], i * 3);
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** 頂点色つきの非インデックスジオメトリを1つにまとめる(position/normal/color)。 */
function merge(parts) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const total = parts.reduce((s, g) => s + g.attributes[name].array.length, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of parts) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

/** 頂点色を一色で塗る(幹など)。 */
function paint(geo, shadeAtY) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.deleteAttribute('uv');
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = shadeAtY(pos.getY(i));
    colors.set([c, c, c], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// 広葉樹の樹冠: 上ほど明るく、下・内側ほど暗い(葉の重なりの陰)
const canopyShade = (x, y, z, ly) => {
  const outer = Math.min(1, Math.hypot(x, z) * 0.9 + 0.2);
  return Math.min(1.08, 0.5 + 0.28 * (y / 2) + 0.18 * outer + 0.12 * Math.max(0, ly));
};

/** 近くの広葉樹の樹冠: 大小 8 つの葉の塊が重なった、こんもりした形。 */
export function broadleafNearGeometry() {
  const crown = [0, 1.05, 0];
  const parts = [lump(1, [0, 1.0, 0], [0.62, 0.55, 0.62], 0.3, crown, canopyShade)];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    const r = 0.52 + 0.08 * Math.sin(i * 2.1);
    const y = 0.72 + 0.32 * ((i * 3) % 5) / 4;
    const s = 0.42 + 0.08 * Math.cos(i * 1.7);
    parts.push(lump(1, [Math.cos(a) * r, y, Math.sin(a) * r], [s, s * 0.85, s], 1.1 + i, crown, canopyShade));
  }
  parts.push(lump(1, [0.12, 1.5, -0.08], [0.46, 0.4, 0.46], 7.7, crown, canopyShade));
  parts.push(lump(1, [-0.25, 1.32, 0.3], [0.38, 0.34, 0.38], 9.1, crown, canopyShade));
  return merge(parts);
}

/** 遠くの広葉樹の樹冠: 丸みのある塊1つ(80 面)。 */
export function broadleafFarGeometry() {
  return merge([lump(1, [0, 1, 0], [0.95, 0.95, 0.95], 2.4, [0, 1, 0], canopyShade)]);
}

/**
 * 杉・檜の円錐の段(縁を星形に出し入れして、垂れた枝先らしいギザギザにする)。
 * y0〜y0+h、底の半径 r。
 */
function coneTier(y0, h, r, sides, seed, dark, light) {
  const geo = new THREE.ConeGeometry(r, h, sides, 1, true).translate(0, y0 + h / 2, 0).toNonIndexed();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y < y0 + h * 0.5) {
      // 底の縁: 角ごとに半径と高さを変えて枝先を垂らす
      const a = Math.atan2(z, x);
      const tip = 0.5 + 0.5 * Math.cos(a * sides + seed);
      const k = 0.82 + 0.26 * tip;
      pos.setXYZ(i, x * k, y - tip * h * 0.18, z * k);
    }
    const c = y < y0 + h * 0.5 ? dark : light;
    colors.set([c, c * 1.02, c * 0.97], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  // 円錐の面の法線を少し上向きに(上からの光で枝の段が明るく見える)
  const nrm = geo.attributes.normal;
  for (let i = 0; i < nrm.count; i++) {
    const nx = nrm.getX(i);
    const ny = nrm.getY(i) + 0.35;
    const nz = nrm.getZ(i);
    const l = Math.hypot(nx, ny, nz);
    nrm.setXYZ(i, nx / l, ny / l, nz / l);
  }
  geo.deleteAttribute('uv');
  return geo;
}

/** 近くの杉・檜: 下から上へ細くなる 6 段の枝(段の下側は暗い)。 */
export function coniferNearGeometry() {
  const parts = [];
  const tiers = 6;
  for (let k = 0; k < tiers; k++) {
    const y0 = 0.04 + k * 0.145;
    const r = 1 - k * 0.15;
    parts.push(coneTier(y0, 0.3 - k * 0.012, r, 11, k * 1.3, 0.5 + k * 0.04, 0.95 + k * 0.02));
  }
  return merge(parts);
}

/** 遠くの杉・檜: 3 段の円錐。 */
export function coniferFarGeometry() {
  return merge([
    coneTier(0.0, 0.48, 1, 7, 0, 0.55, 0.92),
    coneTier(0.32, 0.4, 0.72, 7, 1.1, 0.62, 0.97),
    coneTier(0.6, 0.4, 0.44, 7, 2.2, 0.7, 1.02),
  ]);
}

/** 松原の松の枝葉: 平たい葉の雲が 5 つ集まった段(盆栽のような形)。 */
export function pinePadGeometry() {
  const crown = [0, 0.3, 0];
  const shade = (x, y, z, ly) => Math.min(1.05, 0.5 + 0.4 * Math.max(0, ly) + 0.1 * Math.hypot(x, z));
  const parts = [lump(1, [0, 0.5, 0], [0.5, 0.32, 0.5], 0.2, crown, shade)];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.7;
    parts.push(lump(1, [Math.cos(a) * 0.58, 0.42 + 0.08 * (i % 2), Math.sin(a) * 0.58], [0.42, 0.26, 0.42], 3 + i, crown, shade));
  }
  return merge(parts);
}

/** 近くの木の幹: 7 角の幹の先から 3 本の枝が樹冠へ伸びる。 */
export function trunkNearGeometry() {
  const parts = [paint(new THREE.CylinderGeometry(0.11, 0.2, 1, 7).translate(0, 0.5, 0), (y) => 0.75 + 0.25 * y)];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const b = new THREE.CylinderGeometry(0.035, 0.07, 0.5, 5).translate(0, 0.25, 0);
    b.rotateZ(0.6);
    b.rotateY(a);
    b.translate(0, 0.72, 0);
    parts.push(paint(b, () => 0.85));
  }
  return merge(parts);
}

/** 遠くの木の幹: 5 角の幹。 */
export function trunkFarGeometry() {
  return merge([paint(new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0), (y) => 0.8 + 0.2 * y)]);
}
