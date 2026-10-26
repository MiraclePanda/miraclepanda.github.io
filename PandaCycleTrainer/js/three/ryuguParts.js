// 竜宮城の海底コースの3D部品(LandscapeScene が tourParts.js 経由で使う)。配置は ryuguLayout.js
// (純粋ロジック)が決め、ここでは形を作ってインスタンスとして置き、毎フレームの動きをつける。
//
// - 動かない物(貝殻・サンゴ・イソギンチャク・昆布・沈没船・宝箱・チョウチンアンコウ・光の筋)は、ほかの
//   景色と同じく組み直し(REBUILD_M ごと)のときだけ置く。昆布の揺れは頂点シェーダーで時間から求める
//   (インスタンスの位置を位相にする)ので、毎フレームの CPU の仕事はない。
// - 魚の群れ・マンタ・泡は毎フレーム位置を計算して置き直す(合わせて数百個の行列だけ)。
// - 海底と砂の道には、水面で集まった光の模様(コースティクス)をシェーダーで重ねる。模様は道路・地形の
//   テクスチャ座標(絶対距離に固定、繰り返しの長さの整数倍の周波数)から求めるので、組み直しで跳ばない。
// - 夜は光の筋・模様を消し、宝箱の金貨とチョウチンアンコウの明かりを強くする(sceneEnvironment.js の glow)。
// どれも画像ファイルを使わない(ビルド・アセット不要の制約)。見た目だけで、物理・トレーナーへの指示には影響しない。

import THREE from './three.js';
import { makePool, pushInstance, pushInstanceYawPitch, commitPool } from './sceneKit.js';
import { mulberry32 } from './cityLayout.js';

const MAX_SHELLS = 700; // 種類ごと
const MAX_CORALS = 320; // 種類ごと
const MAX_ANEMONES = 120;
const MAX_KELP = 900;
const MAX_SHIPS = 2;
const MAX_CHESTS = 12;
const MAX_ANGLERS = 16;
const MAX_SHAFTS = 120;
const MAX_FISH = 600;
const MAX_FLATS = 40;
const MAX_MANTAS = 6;
const MAX_BUBBLES = 360;
// QUALITY_TIERS の 'low' 以下では、道路から LITE_FAR_M より遠い貝・サンゴ・イソギンチャクを置かない
const LITE_QUALITY_INDEX = 2;
const LITE_FAR_M = 16;

// 光の筋の高さ(m)・濃さ、コースティクスの強さ。昼の太陽の強さ(LandscapeScene の SUN_INTENSITY)を基準に夜は弱める
const SHAFT_HEIGHT_M = 45;
const SHAFT_OPACITY = 0.16;
const CAUSTIC_STRENGTH = 0.5;
const DAY_SUN_INTENSITY = 2.6;
// 泡: 湧き出し口ごとの数と、上がる高さ(m)・速さ(m/s)
const BUBBLES_PER_VENT = 8;
const BUBBLE_RISE_M = 9;
const BUBBLE_MPS = 0.9;
// マンタは MANTA_LOOP_M 進むと元の位置へ戻る(遠くの霧の中で入れ替わるので目立たない)
const MANTA_LOOP_M = 300;

// 魚の種類ごとの色と大きさ(ryuguLayout.js の FISH_SPECIES、'tai' / 'hirame' は舞台の踊り子)
const FISH_LOOKS = [
  { color: 0xffd23a, scale: 0.7 }, // キイロハギ
  { color: 0x2f6fdc, scale: 0.75 }, // ナンヨウハギ
  { color: 0xff7a2a, scale: 0.55 }, // カクレクマノミ
  { color: 0xc8d6e0, scale: 0.6 }, // イワシ
];
const TAI_LOOK = { color: 0xe8505a, scale: 1.1 };
const HIRAME_LOOK = { color: 0xa58b62, scale: 1.3 };

const UP = new THREE.Vector3(0, 1, 0);

// ---- 形 ----

/** 2点間を結ぶ円柱(細い枝ばかりなので両端のふたは付けない。三角形の数を抑える)。 */
function rod(from, to, r0, r1 = r0, seg = 6) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const geo = new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), seg, 1, true);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize()));
  const m = a.add(b).multiplyScalar(0.5);
  return geo.translate(m.x, m.y, m.z);
}

/**
 * ジオメトリ群を1つに結合する(position / normal / uv / color)。sceneKit の mergeGeometries と違い、
 * uv や頂点カラーの無い部品(三角形の板など)も混ぜられる(無い属性は uv = 0、色 = 白で埋める)。
 */
function mergeGeometries(list) {
  const parts = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!n.attributes.normal) n.computeVertexNormals();
    return n;
  });
  const merged = new THREE.BufferGeometry();
  for (const [name, size, fill] of [['position', 3, 0], ['normal', 3, 0], ['uv', 2, 0], ['color', 3, 1]]) {
    if (!parts.some((g) => g.attributes[name])) continue;
    const array = new Float32Array(parts.reduce((n, g) => n + g.attributes.position.count * size, 0));
    let offset = 0;
    for (const g of parts) {
      const len = g.attributes.position.count * size;
      if (g.attributes[name]) array.set(g.attributes[name].array, offset);
      else array.fill(fill, offset, offset + len);
      offset += len;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  for (const g of new Set([...list, ...parts])) g.dispose();
  return merged;
}

/** 頂点カラーを付ける(魚・マンタ: 体は白 = インスタンスの色、目などは黒)。 */
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

function triangle(a, b, c) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
  geo.computeVertexNormals();
  return geo;
}

/** 枝サンゴ(ミドリイシ): 3本ずつ枝分かれする。高さ約1m。数百本並ぶので枝分かれは2段まで。 */
function buildBranchCoral() {
  const rand = mulberry32(5);
  const parts = [];
  const grow = (from, dir, len, r, depth) => {
    const to = from.clone().addScaledVector(dir, len);
    parts.push(rod(from.toArray(), to.toArray(), r, r * 0.75, 4));
    if (depth === 0) {
      parts.push(new THREE.SphereGeometry(r * 1.1, 5, 3).translate(to.x, to.y, to.z));
      return;
    }
    for (let k = 0; k < 3; k++) {
      const next = dir.clone().applyAxisAngle(new THREE.Vector3(Math.cos(k * 2.1 + rand()), 0, Math.sin(k * 2.1 + rand())), 0.45 + rand() * 0.3).normalize();
      grow(to, next, len * 0.85, r * 0.72, depth - 1);
    }
  };
  grow(new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0, 1, 0), 0.42, 0.08, 2);
  return mergeGeometries(parts);
}

/** 脳サンゴ(溝のある半球)。 */
function buildBrainCoral() {
  const geo = new THREE.SphereGeometry(0.5, 16, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    const th = Math.atan2(v.x, v.z);
    const k = 1 + 0.05 * Math.sin(th * 11 + v.y * 14) * Math.sin(v.y * 22 + th * 3);
    pos.setXYZ(i, v.x * k, v.y * k * 0.7, v.z * k);
  }
  geo.computeVertexNormals();
  return geo.translate(0, -0.04, 0);
}

/** うちわサンゴ(ヤギ): 1枚の面の中で細い枝が二股に分かれ続け、扇形の網のようになる。高さ約1.2m。 */
function buildFanCoral() {
  const rand = mulberry32(9);
  const parts = [];
  const grow = (x, y, angle, len, r, depth) => {
    const x1 = x + Math.sin(angle) * len;
    const y1 = y + Math.cos(angle) * len;
    const z = 0.03 * Math.sin(x * 7);
    parts.push(rod([x, y, z], [x1, y1, 0.03 * Math.sin(x1 * 7)], r, r * 0.8, 3));
    if (depth === 0) return;
    for (const sign of [-1, 1]) grow(x1, y1, angle + sign * (0.32 + rand() * 0.2), len * (0.78 + rand() * 0.1), r * 0.8, depth - 1);
  };
  grow(0, -0.1, 0, 0.34, 0.035, 4);
  return mergeGeometries(parts);
}

/** 筒状の海綿(大小の筒の束)。 */
function buildTubeCoral() {
  const parts = [];
  for (const [x, z, h, r] of [[0, 0, 0.9, 0.11], [0.2, 0.08, 0.6, 0.09], [-0.17, 0.12, 0.7, 0.08], [0.05, -0.2, 0.5, 0.08], [-0.12, -0.14, 0.4, 0.07]]) {
    parts.push(new THREE.CylinderGeometry(r, r * 0.8, h, 10, 1, true).translate(x, h / 2 - 0.05, z));
  }
  return mergeGeometries(parts);
}

/** イソギンチャク(太い胴と、上へ広がる触手)。 */
function buildAnemone() {
  const parts = [new THREE.CylinderGeometry(0.2, 0.24, 0.25, 8).translate(0, 0.08, 0)];
  for (let i = 0; i < 18; i++) {
    const a = i * 2.4;
    const r = 0.05 + (i % 3) * 0.05;
    const from = [Math.sin(a) * r, 0.2, Math.cos(a) * r];
    const to = [Math.sin(a) * (r + 0.12), 0.48 - (i % 3) * 0.06, Math.cos(a) * (r + 0.12)];
    parts.push(rod(from, to, 0.028, 0.014, 3));
  }
  return mergeGeometries(parts);
}

/** ホタテ貝(放射状の筋のある扇。地面に伏せる)。 */
function buildScallop() {
  const geo = new THREE.CircleGeometry(1, 16, 0, Math.PI);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const r = Math.hypot(x, y);
    const th = Math.atan2(y, x);
    pos.setZ(i, 0.1 * Math.abs(Math.sin(th * 7)) * r + 0.3 * (1 - r * r));
  }
  geo.computeVertexNormals();
  return geo.rotateX(-Math.PI / 2).translate(0, 0.02, 0.4);
}

/** 巻き貝(とがった螺旋の貝。横に寝かせる)。 */
function buildConch() {
  const parts = [new THREE.ConeGeometry(0.45, 1.3, 8).rotateZ(Math.PI / 2).translate(0.25, 0.3, 0)];
  for (let i = 0; i < 3; i++) parts.push(new THREE.TorusGeometry(0.4 - i * 0.12, 0.07, 4, 8).rotateY(Math.PI / 2).translate(-0.25 + i * 0.33, 0.3, 0));
  return mergeGeometries(parts);
}

/** 昆布(高さ1の数枚のねじれた帯。インスタンスの拡大で高さを決め、シェーダーで揺らす)。 */
function buildKelp() {
  const parts = [];
  for (let b = 0; b < 4; b++) {
    const blade = new THREE.PlaneGeometry(0.055, 1, 1, 12).translate(0, 0.5, 0);
    const pos = blade.attributes.position;
    const h = 0.65 + b * 0.12;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i) * h;
      const a = y * 2.2 + b * 1.6;
      const lean = 0.04 * Math.sin(b * 2.3) * y;
      pos.setXYZ(i, x * Math.cos(a) + lean, y, x * Math.sin(a) + 0.03 * Math.cos(b * 1.7) * y);
    }
    blade.computeVertexNormals();
    parts.push(blade);
  }
  return mergeGeometries(parts);
}

/** 沈没船(木造の帆船。右へ傾き、前のめりに砂に埋まる)。木部と、破れた帆。原点は船体の中央の底。 */
function buildShipGeometries() {
  const tilt = (g) => g.rotateZ(0.32).rotateX(0.08);
  const wood = mergeGeometries([
    new THREE.BoxGeometry(6.4, 3.4, 22).translate(0, 1.7, 1),
    new THREE.ConeGeometry(3.2, 7, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 0.55).rotateX(-Math.PI / 2).translate(0, 1.7, -13.3),
    new THREE.BoxGeometry(6.2, 3, 6).translate(0, 4.6, 8.5), // 船尾楼
    new THREE.BoxGeometry(6.6, 0.3, 22.4).translate(0, 3.45, 1), // 甲板の縁
    rod([0, 3, -4], [0.8, 13, -4.6], 0.28, 0.2, 8), // 折れたマスト
    rod([0, 3, 3.5], [0, 7.5, 3.5], 0.3, 0.26, 8),
    new THREE.BoxGeometry(6, 0.22, 0.22).translate(0.6, 11.5, -4.5), // 帆桁
    rod([0, 2.6, -14], [0, 5.5, -20], 0.15, 0.1, 6), // 船首の斜檣
  ]);
  const sail = new THREE.PlaneGeometry(5.6, 6, 6, 6);
  const sp = sail.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i);
    const y = sp.getY(i);
    // 下の縁ほどぼろぼろに裂けて、ゆるく膨らむ
    const tear = y < -1.5 ? Math.abs(Math.sin(x * 3.1)) * 1.4 : 0;
    sp.setXYZ(i, x, y + tear, 0.5 * Math.cos(x * 0.5) * (1 - (y + 3) / 6));
  }
  sail.computeVertexNormals();
  return { wood: tilt(wood), sail: tilt(sail.translate(0.6, 8.4, -4.5)) };
}

/** 宝箱(蓋が開いて金貨がのぞく)。木部と金(帯・金貨)。原点は箱の底の中央。 */
function buildChestGeometries() {
  const lid = new THREE.BoxGeometry(1.05, 0.14, 0.72).translate(0, 0.07, -0.36).rotateX(-1.15).translate(0, 0.62, 0.36);
  const wood = mergeGeometries([new THREE.BoxGeometry(1, 0.62, 0.7).translate(0, 0.31, 0), lid]);
  const gold = mergeGeometries([
    new THREE.SphereGeometry(1, 12, 8).scale(0.44, 0.16, 0.3).translate(0, 0.6, 0),
    new THREE.BoxGeometry(1.04, 0.08, 0.74).translate(0, 0.12, 0),
    new THREE.BoxGeometry(1.04, 0.08, 0.74).translate(0, 0.5, 0),
    new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10).translate(0.7, 0.01, 0.2),
    new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10).rotateZ(0.4).translate(0.62, 0.05, -0.15),
    new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10).translate(-0.66, 0.01, 0.3),
  ]);
  return { wood, gold };
}

/** チョウチンアンコウ(大きな口の丸い体と、頭から垂れる提灯)。前は −Z。 */
function buildAnglerGeometries() {
  const body = mergeGeometries([
    new THREE.SphereGeometry(0.45, 14, 10).scale(1, 0.85, 1.2),
    new THREE.SphereGeometry(0.3, 10, 8).scale(1.2, 0.5, 0.6).translate(0, -0.18, -0.42), // 下あご
    new THREE.ConeGeometry(0.25, 0.4, 4).rotateX(Math.PI / 2).translate(0, 0, 0.7), // 尾
    rod([0, 0.35, -0.25], [0, 0.78, -0.55], 0.025, 0.015, 4),
    rod([0, 0.78, -0.55], [0, 0.68, -0.85], 0.015, 0.012, 4),
  ]);
  const lure = new THREE.SphereGeometry(0.1, 10, 8).translate(0, 0.62, -0.88);
  return { body, lure };
}

/** 水面から差し込む光の筋(十字に組んだ2枚の板。上ほど明るく、下と左右は透明へ)。 */
function buildShaftTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(32, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 32; x++) {
      const side = Math.sin((Math.PI * (x + 0.5)) / 32) ** 2;
      const v = Math.round(255 * side * (y / 127) ** 1.5); // 上(y = 127、テクスチャの v = 1 側)ほど明るい
      const i = ((127 - y) * 32 + x) * 4;
      img.data.set([v, v, v, 255], i);
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 魚(体の長さ1m。体と尾びれは白 = インスタンスの色、目は黒)。前は −Z。 */
function buildFishGeometry() {
  return mergeGeometries([
    colored(new THREE.SphereGeometry(0.5, 8, 6).scale(0.24, 0.48, 1), 0xffffff),
    colored(triangle([0, 0, 0.42], [0, 0.3, 0.78], [0, -0.3, 0.78]), 0xffffff),
    colored(triangle([0, 0.2, -0.15], [0, 0.36, 0.15], [0, 0.18, 0.3]), 0xffffff),
    colored(new THREE.SphereGeometry(0.045, 4, 3).translate(-0.09, 0.06, -0.32), 0x111111),
    colored(new THREE.SphereGeometry(0.045, 4, 3).translate(0.09, 0.06, -0.32), 0x111111),
  ]);
}

/** ヒラメ(平たい体。目は上側の片方に寄る)。前は −Z。 */
function buildFlatfishGeometry() {
  return mergeGeometries([
    colored(new THREE.SphereGeometry(0.5, 14, 6).scale(0.75, 0.1, 1), 0xffffff),
    colored(triangle([0, 0, 0.45], [0.22, 0, 0.72], [-0.22, 0, 0.72]), 0xffffff),
    colored(new THREE.SphereGeometry(0.04, 6, 4).translate(0.08, 0.05, -0.3), 0x111111),
    colored(new THREE.SphereGeometry(0.04, 6, 4).translate(0.15, 0.05, -0.22), 0x111111),
  ]);
}

/** マンタ(ひし形の大きなひれ。背は濃紺、腹は白)。幅約4.4m。前は −Z。 */
function buildMantaGeometry() {
  const top = 0x253542;
  const belly = 0xe4ecef;
  const nose = [0, 0, -1.0];
  const back = [0, 0, 1.0];
  const lt = [-2.2, 0.15, 0.35];
  const rt = [2.2, 0.15, 0.35];
  const up = [0, 0.32, -0.1];
  const down = [0, -0.18, -0.1];
  return mergeGeometries([
    colored(triangle(nose, lt, up), top), colored(triangle(up, lt, back), top),
    colored(triangle(nose, up, rt), top), colored(triangle(up, back, rt), top),
    colored(triangle(nose, down, lt), belly), colored(triangle(down, back, lt), belly),
    colored(triangle(nose, rt, down), belly), colored(triangle(down, rt, back), belly),
    colored(new THREE.BoxGeometry(0.14, 0.08, 0.5).translate(-0.3, 0, -1.1), top),
    colored(new THREE.BoxGeometry(0.14, 0.08, 0.5).translate(0.3, 0, -1.1), top),
    colored(rod([0, 0, 0.9], [0, 0.05, 2.6], 0.04, 0.015, 4), top),
  ]);
}

// ---- シェーダーの追加(コースティクス・昆布の揺れ) ----

const CAUSTIC_GLSL = /* glsl */ `
varying vec2 vCauUv;
uniform float uCauTime;
uniform float uCauStrength;
uniform vec3 uCauFreq;
// p.x = 横(m)、p.y = 道路に沿う向き(m)。p.y の周波数(uCauFreq)はテクスチャの繰り返しの長さで割り切れる値
float causticLight(vec2 p, float t) {
  float a = sin(p.x * 2.3 + sin(p.y * uCauFreq.x + t * 0.9) * 1.4 + t * 0.7);
  float b = sin(p.y * uCauFreq.y + sin(p.x * 1.7 - t * 0.6) * 1.3 - t * 0.5);
  float c = sin(p.x * 3.1 + p.y * uCauFreq.z + t * 0.8);
  float n = abs(a + b + c) / 3.0;
  return pow(1.0 - n, 6.0);
}
`;

/**
 * 地形・道路のマテリアルにコースティクスを重ねる。scale = テクスチャ座標1あたりのメートル(横, 沿う向き)、
 * periodM = 沿う向きのテクスチャの繰り返しの長さ(組み直しのたびに座標がこの長さの整数倍ずれる)。
 */
function addCaustics(material, shared, scale, periodM) {
  const freq = (lambda) => (2 * Math.PI * Math.max(1, Math.round(periodM / lambda))) / periodM;
  const uScale = { value: new THREE.Vector2(scale[0], scale[1]) };
  const uFreq = { value: new THREE.Vector3(freq(2.6), freq(1.9), freq(3.4)) };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCauTime = shared.time;
    shader.uniforms.uCauStrength = shared.strength;
    shader.uniforms.uCauScale = uScale;
    shader.uniforms.uCauFreq = uFreq;
    shader.vertexShader = `varying vec2 vCauUv;\nuniform vec2 uCauScale;\n${shader.vertexShader}`
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vCauUv = uv * uCauScale;');
    shader.fragmentShader = `${CAUSTIC_GLSL}\n${shader.fragmentShader}`
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * uCauStrength * causticLight(vCauUv, uCauTime);');
  };
  material.customProgramCacheKey = () => `ryugu-caustics-${periodM}`;
  material.needsUpdate = true;
}

/** 昆布のマテリアル: 先へいくほど大きく、インスタンスごとにずれた位相で揺れる。 */
function addSway(material, shared) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayTime = shared.time;
    shader.vertexShader = `uniform float uSwayTime;\n${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_INSTANCING
  float swayPh = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
  #else
  float swayPh = 0.0;
  #endif
  float swayK = transformed.y * transformed.y;
  transformed.x += sin(uSwayTime * 1.1 + swayPh + transformed.y * 3.0) * 0.09 * swayK;
  transformed.z += cos(uSwayTime * 0.8 + swayPh * 1.3 + transformed.y * 2.0) * 0.05 * swayK;`);
  };
  material.customProgramCacheKey = () => 'ryugu-sway';
}

// ---- 本体 ----

/**
 * 竜宮城の海底の部品を作って inner に加える。
 * @param {THREE.Group} inner
 * @param {object} L LANDSCAPES.ryugu
 * @param {{causticTargets?: Array<{material: THREE.Material, scale: number[], periodM: number}>}} opts
 *   コースティクスを重ねる地形・道路のマテリアル
 * @returns {{pools: object, animPools: object, glowMaterials: Array, textures: THREE.Texture[], animate: Function}}
 */
export function buildRyuguParts(inner, L, { causticTargets = [] } = {}) {
  const shared = { time: { value: 0 }, strength: { value: CAUSTIC_STRENGTH } };
  for (const t of causticTargets) addCaustics(t.material, shared, t.scale, t.periodM);

  const pools = {};
  const textures = [];
  const glowMaterials = [];
  const std = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.8, ...opts });

  const shellMat = std({ roughness: 0.5 });
  pools.shell0 = makePool(buildScallop(), new THREE.MeshStandardMaterial({ roughness: 0.5, side: THREE.DoubleSide }), MAX_SHELLS, { cast: false });
  pools.shell1 = makePool(buildConch(), shellMat, MAX_SHELLS, { cast: false });
  const coralMat = std({ side: THREE.DoubleSide });
  [buildBranchCoral(), buildBrainCoral(), buildFanCoral(), buildTubeCoral()].forEach((geo, i) => {
    pools[`coral${i}`] = makePool(geo, coralMat, MAX_CORALS, { cast: i !== 2 });
  });
  pools.anemones = makePool(buildAnemone(), std({}), MAX_ANEMONES, { cast: false });
  const kelpMat = std({ side: THREE.DoubleSide });
  addSway(kelpMat, shared);
  pools.kelp = makePool(buildKelp(), kelpMat, MAX_KELP, { cast: false });
  const ship = buildShipGeometries();
  pools.shipWood = makePool(ship.wood, std({ color: 0x4f3a2a, roughness: 0.95 }), MAX_SHIPS);
  pools.shipSail = makePool(ship.sail, std({ color: 0xc9bea2, side: THREE.DoubleSide }), MAX_SHIPS, { cast: false });
  const chest = buildChestGeometries();
  pools.chestWood = makePool(chest.wood, std({ color: 0x6b4423, roughness: 0.9 }), MAX_CHESTS);
  const goldMat = std({ color: 0xe0b43a, metalness: 0.6, roughness: 0.35, emissive: 0x6a4a00, emissiveIntensity: 0.4 });
  pools.chestGold = makePool(chest.gold, goldMat, MAX_CHESTS, { cast: false });
  glowMaterials.push({ material: goldMat, night: 3 });
  const angler = buildAnglerGeometries();
  pools.anglerBody = makePool(angler.body, std({ color: 0x3d3446, roughness: 0.6 }), MAX_ANGLERS, { cast: false });
  const lureMat = std({ color: 0xfff6c8, emissive: 0xffe680, emissiveIntensity: 0.8 });
  pools.anglerLure = makePool(angler.lure, lureMat, MAX_ANGLERS, { cast: false });
  glowMaterials.push({ material: lureMat, night: 6 });
  const shaftTex = buildShaftTexture();
  textures.push(shaftTex);
  const shaftMat = new THREE.MeshBasicMaterial({
    map: shaftTex, color: 0xd8f6ff, transparent: true, opacity: SHAFT_OPACITY,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const shaftGeo = mergeGeometries([
    new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0),
    new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0).rotateY(Math.PI / 2),
  ]);
  pools.shafts = makePool(shaftGeo, shaftMat, MAX_SHAFTS, { cast: false, receive: false });

  // 毎フレーム置き直す物(placeObjects のまとめての commit には入れない)
  const animPools = {};
  const fishMat = std({ vertexColors: true, roughness: 0.45, side: THREE.DoubleSide });
  animPools.fish = makePool(buildFishGeometry(), fishMat, MAX_FISH, { cast: false });
  animPools.flats = makePool(buildFlatfishGeometry(), fishMat, MAX_FLATS, { cast: false });
  animPools.mantas = makePool(buildMantaGeometry(), std({ vertexColors: true, side: THREE.DoubleSide }), MAX_MANTAS);
  const bubbleMat = std({ color: 0xeaffff, roughness: 0.05, transparent: true, opacity: 0.55, emissive: 0x4a6a78, emissiveIntensity: 0.4 });
  animPools.bubbles = makePool(new THREE.SphereGeometry(0.06, 8, 6), bubbleMat, MAX_BUBBLES, { cast: false, receive: false });

  for (const pool of [...Object.values(pools), ...Object.values(animPools)]) inner.add(pool.mesh);

  return {
    pools,
    animPools,
    glowMaterials,
    textures,
    /** 毎フレーム: 揺れ・模様の時刻、夜の明るさ、魚の群れ・マンタ・泡の位置。 */
    animate(st, t) {
      shared.time.value = t;
      const day = Math.min(1, Math.max(0, st.sunLight.intensity / DAY_SUN_INTENSITY));
      shared.strength.value = CAUSTIC_STRENGTH * day;
      shaftMat.opacity = SHAFT_OPACITY * day;
      shaftMat.visible = day > 0.05;
      const a = st.tour.anim;
      if (a) animateCreatures(st, a, animPools, t);
      for (const pool of Object.values(animPools)) commitPool(pool);
    },
  };
}

function animateCreatures(st, a, p, t) {
  for (const sc of a.schools) {
    const flat = sc.species === 'hirame';
    const look = sc.species === 'tai' ? TAI_LOOK : flat ? HIRAME_LOOK : FISH_LOOKS[sc.species] ?? FISH_LOOKS[0];
    const pool = flat ? p.flats : p.fish;
    const dir = Math.sign(sc.speed) || 1;
    for (const f of sc.fish) {
      const th = f.ang + sc.speed * t;
      const r = sc.radiusM * f.r;
      const bob = Math.sin(t * (sc.dance ? 1.8 : 0.9) + f.ph) * (sc.dance ? 0.9 : 0.3);
      const x = sc.x + Math.cos(th) * r;
      const z = sc.z + Math.sin(th) * r;
      // 進む向き(円の接線)へ頭を向ける。舞台の踊り子は跳ねたり(タイ)、ひらひら返ったり(ヒラメ)する
      const yaw = Math.atan2(dir * Math.sin(th), -dir * Math.cos(th));
      const pitch = sc.dance ? Math.sin(t * (flat ? 1.6 : 2.2) + f.ph) * (flat ? 1.0 : 0.35) : 0;
      const k = look.scale * f.size;
      pushInstanceYawPitch(pool, x, sc.y + f.y + bob, z, k, k, k, yaw, pitch, look.color);
    }
  }
  const placeAt = st.placement.placeAt ?? st.placement.place;
  for (const m of a.mantas) {
    const s = m.s + ((t * m.speedMps) % MANTA_LOOP_M);
    const q = placeAt(s, m.d);
    const y = st.elev.elevAt(s) + m.heightM + Math.sin(t * 0.5 + m.seed) * 0.6 - st.anchorElev;
    pushInstanceYawPitch(p.mantas, q.x, y, q.z, 1.6, 1.6, 1.6, q.yaw, Math.sin(t * 0.8 + m.seed) * 0.08);
  }
  for (const v of a.vents) {
    for (let i = 0; i < BUBBLES_PER_VENT; i++) {
      const rise = (t * BUBBLE_MPS + i * (BUBBLE_RISE_M / BUBBLES_PER_VENT) + v.ph) % BUBBLE_RISE_M;
      const k = 0.6 + rise / BUBBLE_RISE_M;
      pushInstance(p.bubbles, v.x + Math.sin(t * 3 + i * 1.7) * 0.15, v.y + rise, v.z + Math.cos(t * 2.6 + i) * 0.15, k, k, k);
    }
  }
}

/**
 * ryuguLayout.js の配置物を置く(placeTourObjects から、組み直しのたびに呼ばれる)。動く物は
 * アンカー基準の位置を st.tour.anim に覚えておき、毎フレーム animate() が置き直す。
 */
export function placeRyuguObjects(st, r, { groundAt, local, blocked }) {
  const { elev, pools: p } = st;
  // 最低品質(ソフトウェアGLや遅い端末)では、遠くの小物を減らす。フレームが遅いとライドが実時間より遅く進むため
  const lite = (st.qualityIndex ?? 0) >= LITE_QUALITY_INDEX;
  const far = (d) => lite && Math.abs(d) > LITE_FAR_M;
  for (const sh of r.shells) {
    if (far(sh.d)) continue;
    const [x, y, z] = local(sh.s, sh.d, elev.elevAt(sh.s) - 0.03);
    const k = sh.scale * 0.14;
    pushInstance(sh.type === 0 ? p.shell0 : p.shell1, x, y, z, k, k, k, 0, sh.yaw, sh.color);
  }
  for (const c of r.corals) {
    if (far(c.d) || blocked(c.s, c.d, 0.8 * c.scale)) continue;
    const [x, y, z] = local(c.s, c.d, groundAt(c.s, c.d));
    pushInstance(p[`coral${c.type}`], x, y - 0.05, z, c.scale, c.scale, c.scale, 0, c.yaw, c.color);
  }
  for (const an of r.anemones) {
    if (far(an.d) || blocked(an.s, an.d, 0.4)) continue;
    const [x, y, z] = local(an.s, an.d, groundAt(an.s, an.d));
    pushInstance(p.anemones, x, y - 0.05, z, an.scale, an.scale, an.scale, 0, an.s, an.color);
  }
  for (const kp of r.kelp) {
    if (blocked(kp.s, kp.d, 0.5)) continue;
    const [x, y, z] = local(kp.s, kp.d, groundAt(kp.s, kp.d));
    pushInstance(p.kelp, x, y - 0.2, z, kp.heightM, kp.heightM, kp.heightM, 0, kp.s * 1.7, kp.color);
  }
  for (const sh of r.ships) {
    const [x, y, z, roadYaw] = local(sh.s, sh.d, groundAt(sh.s, sh.d));
    pushInstance(p.shipWood, x, y - 1.6, z, 1, 1, 1, 0, roadYaw + sh.yaw);
    pushInstance(p.shipSail, x, y - 1.6, z, 1, 1, 1, 0, roadYaw + sh.yaw);
  }
  for (const c of r.chests) {
    if (blocked(c.s, c.d, 0.8)) continue;
    const [x, y, z, roadYaw] = local(c.s, c.d, groundAt(c.s, c.d));
    pushInstance(p.chestWood, x, y - 0.12, z, 1, 1, 1, 0, roadYaw + c.yaw);
    pushInstance(p.chestGold, x, y - 0.12, z, 1, 1, 1, 0, roadYaw + c.yaw);
  }
  for (const an of r.anglers) {
    const [x, y, z, roadYaw] = local(an.s, an.d, groundAt(an.s, an.d) + an.heightM);
    pushInstance(p.anglerBody, x, y, z, 1, 1, 1, 0, roadYaw + an.yaw);
    pushInstance(p.anglerLure, x, y, z, 1, 1, 1, 0, roadYaw + an.yaw);
  }
  for (const sf of r.shafts) {
    const [x, y, z, roadYaw] = local(sf.s, sf.d, groundAt(sf.s, sf.d) - 2);
    pushInstance(p.shafts, x, y, z, sf.widthM, SHAFT_HEIGHT_M, sf.widthM, sf.lean, roadYaw + sf.yaw);
  }

  // 動く物: 群れの中心・泡の湧き出し口はアンカー基準の座標で覚える(マンタは毎フレーム道路に沿って置く)
  const schools = r.schools.map((sc) => {
    const [x, y, z] = local(sc.s, sc.d, groundAt(sc.s, sc.d) + sc.heightM);
    const rand = mulberry32(sc.seed);
    const fish = [];
    for (let i = 0; i < sc.count; i++) {
      fish.push({ ang: (i / sc.count) * Math.PI * 2 + rand() * 0.5, r: 0.55 + rand() * 0.45, y: (rand() - 0.5) * 1.6, ph: rand() * 6.3, size: 0.8 + rand() * 0.4 });
    }
    return { ...sc, x, y, z, fish };
  });
  const vents = r.bubbles.map((b) => {
    const [x, y, z] = local(b.s, b.d, groundAt(b.s, b.d));
    return { x, y, z, ph: (b.seed * 1.37) % BUBBLE_RISE_M };
  });
  st.tour.anim = { schools, mantas: r.mantas, vents };
}
