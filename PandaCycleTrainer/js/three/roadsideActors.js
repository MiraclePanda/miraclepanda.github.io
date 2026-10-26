// 沿道のハプニング(猫・パンダ・応援団・給水所・鹿)と観光地の名所(大鳥居・五重塔・三門など)の3D描画
// (CityScene / LandscapeScene が使う。上野不忍池は対象外)。配置と動きの入力は happeningsLayout.js の actors、
// 道路の断面への横位置の決め方は roadsideLayout.js(どちらも Three.js 非依存の純粋ロジック)。
//
// 描画負荷を抑える工夫:
// - マテリアルは全部で1つ(頂点カラー + 文字のアトラステクスチャ、両面)。色のついた部品は
//   アトラスの白い所を指す UV にして頂点カラーで塗り、旗・看板・扁額だけ文字の所を指す。
//   こうすると旗も腕と同じメッシュに結合でき、シェーダープログラムも1つで済む。
// - 動かない部品は種類ごとに1つのジオメトリへ焼き込む(大鳥居・名所の建物・給水所は1 draw call)。
//   名所の建物の形は sightModels.js。
//   脚・尻尾・首・旗を振る腕だけ別メッシュにして回す(猫6・パンダ5・鹿6・応援団8 draw call)。
// - 模型(とジオメトリ)は種類ごとに初めて必要になったときに作り、以後は使い回す。
//   同じ種類が同時に出るのは高々 MAX_PER_KEY 体まで。使っていない模型は visible = false。
// - 影は品質「高」(qualityIndex 0)のときだけ落とす。品質「低」では旗振りを止める(模型は出す)。
// 見た目だけの機能で、物理・トレーナーへの指示には一切影響しない。

import THREE from './three.js';
import {
  actorLateralM, SIGHT_FOOTPRINTS, TORII_PILLAR_OUTSET_M, AID_HALF_WIDTH_M, AID_DEPTH_M, variantOf,
} from './roadsideLayout.js';
import { sightTemplate } from './sightModels.js';

// 同じ種類(猫は毛色ごと)の模型を同時に描く上限
const MAX_PER_KEY = 4;
// 描く前方の上限(m)。happeningsLayout の描画範囲(前方300m)より少し広く。
// 遠くから見える大きな名所(actor.viewM があるもの)はその距離まで描く
const MAX_AHEAD_M = 400;
// 一度に描く actors の上限
const MAX_ACTORS = 16;
// 坂に合わせて前後に傾けてよい小動物
const PITCHABLE = new Set(['cat', 'panda', 'deer']);
const CAT_COATS = 3;

const UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _c = new THREE.Color();

// ---- 文字のアトラス(旗・看板・扁額) ----
// キャンバス全体を白で塗り、色のついた部品は文字のない白い所を UV で指す。
const ATLAS_W = 1024;
const ATLAS_H = 512;
const WHITE_PX = [768, 416]; // 文字のない白い所(640〜896 × 320〜512 の中央)
// [x, y, w, h](キャンバスのピクセル。y は上から)
const CELLS = {
  flag0: [0, 0, 256, 170],
  flag1: [256, 0, 256, 170],
  flag2: [512, 0, 256, 170],
  flag3: [768, 0, 256, 170],
  banner: [0, 192, 640, 128],
  sign: [0, 336, 400, 160],
  plaque: [896, 192, 128, 300],
};
const FLAGS = [
  { text: 'がんばれ', bg: '#ffffff', fg: '#d7263d', border: '#d7263d' },
  { text: 'ファイト', bg: '#ffd23f', fg: '#1b3a8a', border: '#1b3a8a' },
  { text: '祝 完走', bg: '#d7263d', fg: '#ffffff', border: '#ffd23f' },
  { text: 'いけー！', bg: '#1b65b8', fg: '#ffffff', border: '#ffffff' },
];

function fitFont(ctx, text, maxW, size, min = 16) {
  let s = size;
  ctx.font = `bold ${s}px sans-serif`;
  while (s > min && ctx.measureText(text).width > maxW) {
    s -= 2;
    ctx.font = `bold ${s}px sans-serif`;
  }
  return s;
}

function buildAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 応援の旗(縁取りのある横長の旗)
  FLAGS.forEach((f, i) => {
    const [x, y, w, h] = CELLS[`flag${i}`];
    ctx.fillStyle = f.border;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = f.bg;
    ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
    ctx.fillStyle = f.fg;
    fitFont(ctx, f.text, w - 40, 64);
    ctx.fillText(f.text, x + w / 2, y + h / 2 + 2);
  });
  // 給水所の横断幕(テントの前)
  {
    const [x, y, w, h] = CELLS.banner;
    ctx.fillStyle = '#1f5fbf';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y + h - 14, w, 6);
    fitFont(ctx, '給水所', w - 60, 92);
    ctx.fillText('給水所', x + w / 2, y + h / 2 - 4);
  }
  // 給水所の立て看板(走ってくる側を向く)
  {
    const [x, y, w, h] = CELLS.sign;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#1f5fbf';
    ctx.lineWidth = 10;
    ctx.strokeRect(x + 5, y + 5, w - 10, h - 10);
    ctx.fillStyle = '#1f5fbf';
    fitFont(ctx, '給水所', w - 60, 72);
    ctx.fillText('給水所', x + w / 2, y + h * 0.38);
    ctx.fillStyle = '#333333';
    fitFont(ctx, 'ご自由にどうぞ', w - 60, 34);
    ctx.fillText('ご自由にどうぞ', x + w / 2, y + h * 0.76);
  }
  // 大鳥居の扁額(黒地に金の縁と縦書きの文字)
  {
    const [x, y, w, h] = CELLS.plaque;
    ctx.fillStyle = '#c9a640';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#16181c';
    ctx.fillRect(x + 10, y + 10, w - 20, h - 20);
    ctx.fillStyle = '#e2c25a';
    const chars = ['大', '鳥', '居'];
    ctx.font = 'bold 72px serif';
    chars.forEach((ch, i) => ctx.fillText(ch, x + w / 2, y + 62 + i * 88));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// ---- ジオメトリの部品 ----

/**
 * ジオメトリに頂点カラーと UV を付ける。color は 0xRRGGBB か (x, y, z) => 0xRRGGBB(模型座標での塗り分け)。
 * cell があれば UV をアトラスのその文字の所へ、なければ白い所へ向ける。
 */
function paint(geo, color, cell = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const fn = typeof color === 'function' ? color : null;
  if (!fn) _c.setHex(color);
  for (let i = 0; i < pos.count; i++) {
    if (fn) _c.setHex(fn(pos.getX(i), pos.getY(i), pos.getZ(i)));
    colors[i * 3] = _c.r;
    colors[i * 3 + 1] = _c.g;
    colors[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const uvs = new Float32Array(pos.count * 2);
  const src = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    if (cell && src) {
      const [x, y, w, h] = cell;
      uvs[i * 2] = (x + src.getX(i) * w) / ATLAS_W;
      uvs[i * 2 + 1] = 1 - (y + (1 - src.getY(i)) * h) / ATLAS_H;
    } else {
      uvs[i * 2] = (WHITE_PX[0] + 0.5) / ATLAS_W;
      uvs[i * 2 + 1] = 1 - (WHITE_PX[1] + 0.5) / ATLAS_H;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

/** paint() 済みのジオメトリ群を1つに結合する(position/normal/uv/color)。 */
function merge(list) {
  const merged = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
    const total = list.reduce((n, g) => n + g.attributes[name].count * size, 0);
    const array = new Float32Array(total);
    let offset = 0;
    for (const g of list) {
      array.set(g.attributes[name].array, offset);
      offset += g.attributes[name].count * size;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  for (const g of list) g.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/** 回転の中心(pivot)が原点になるよう平行移動する(メッシュの position に pivot を入れて回す)。 */
function aroundPivot(geo, pivot) {
  return geo.translate(-pivot[0], -pivot[1], -pivot[2]);
}

/** 2点間を結ぶ円柱。 */
function rod(from, to, r0, r1 = r0, seg = 8) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const geo = new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), seg);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, b.clone().sub(a).normalize());
  geo.applyQuaternion(q);
  const m = a.add(b).multiplyScalar(0.5);
  return geo.translate(m.x, m.y, m.z);
}

function sphere(r, [x, y, z], [sx, sy, sz] = [1, 1, 1], seg = 12) {
  return new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * 0.75))).scale(sx, sy, sz).translate(x, y, z);
}

function box(w, h, d, [x, y, z]) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// 名所の建物(sightModels.js)に渡す道具
const KIT = { paint, merge, box, rod, sphere };

// ---- 模型のテンプレート ----
// テンプレート = { parts: [{ name, geo, pivot, parent }], animate(nodes, actor, low) }。
// geo が null の部品は空のグループ(人ごとの跳ねなど、まとめて動かす単位)。
// ジオメトリはテンプレート(種類)ごとに1回だけ作り、同じ種類の模型どうしで共有する。

// 猫の毛色: 茶トラ・黒猫・三毛
function catCoat(variant) {
  if (variant === 1) return () => 0x1e1e24;
  if (variant === 2) {
    return (x, y, z) => {
      const n = Math.sin(x * 31 + 1.2) * Math.sin(z * 23 + y * 19);
      return n > 0.35 ? 0xd9822b : n < -0.5 ? 0x2a2622 : 0xf4f1ea;
    };
  }
  return (x, y, z) => (y > 0.17 && Math.sin(z * 75 + x * 8) > 0.45 ? 0xa65a1e : 0xe38d3c);
}

function catTemplate(variant) {
  const coat = catCoat(variant);
  const eye = variant === 1 ? 0xf2d23a : 0x9fd13a;
  const body = merge([
    paint(new THREE.CapsuleGeometry(0.075, 0.2, 4, 10).rotateX(Math.PI / 2).translate(0, 0.2, 0), coat),
    paint(sphere(0.07, [0, 0.29, -0.19]), coat),
    paint(new THREE.ConeGeometry(0.026, 0.055, 6).rotateZ(0.25).translate(-0.04, 0.35, -0.18), coat),
    paint(new THREE.ConeGeometry(0.026, 0.055, 6).rotateZ(-0.25).translate(0.04, 0.35, -0.18), coat),
    paint(sphere(0.03, [0, 0.27, -0.245], [1, 0.8, 1]), variant === 1 ? 0x2a2a30 : 0xf6f2ea),
    paint(sphere(0.012, [-0.028, 0.305, -0.248]), eye),
    paint(sphere(0.012, [0.028, 0.305, -0.248]), eye),
    paint(sphere(0.008, [0, 0.285, -0.272]), 0xe58a9a),
  ]);
  const parts = [{ name: 'body', geo: body, pivot: [0, 0, 0] }];
  const legs = [[-0.045, -0.1], [0.045, -0.1], [-0.045, 0.1], [0.045, 0.1]];
  legs.forEach(([x, z], i) => {
    const pivot = [x, 0.16, z];
    parts.push({ name: `leg${i}`, geo: aroundPivot(paint(rod([x, 0.16, z], [x, 0.0, z], 0.022, 0.02, 6), coat), pivot), pivot });
  });
  const tailPivot = [0, 0.22, 0.16];
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.22, 0.16), new THREE.Vector3(0, 0.24, 0.24), new THREE.Vector3(0, 0.33, 0.3), new THREE.Vector3(0, 0.43, 0.28),
  ]);
  parts.push({ name: 'tail', geo: aroundPivot(paint(new THREE.TubeGeometry(curve, 10, 0.016, 6), coat), tailPivot), pivot: tailPivot });
  return {
    parts,
    animate(n, a) {
      const t = a.phase || 0;
      const m = a.moving || 0;
      // 速歩(対角の脚が同時に出る)。毎秒4歩くらい
      const w = Math.sin(t * Math.PI * 2 * 4);
      n.leg0.rotation.x = w * 0.6 * m;
      n.leg3.rotation.x = w * 0.6 * m;
      n.leg1.rotation.x = -w * 0.6 * m;
      n.leg2.rotation.x = -w * 0.6 * m;
      n.body.position.y = Math.abs(w) * 0.012 * m;
      // 尻尾はいつもゆらゆら
      n.tail.rotation.z = Math.sin(t * 2.2) * 0.35;
      n.tail.rotation.x = -0.15 * m;
    },
  };
}

function pandaTemplate() {
  const WHITE = 0xf3f1ea;
  const BLACK = 0x1d1d20;
  // 胴: 肩をぐるりと巻く黒い帯(パンダらしさの決め手)。胴の楕円体に沿わせた筒を少しだけ大きく重ねる
  const band = new THREE.CylinderGeometry(1, 1, 1, 24, 6, true).rotateX(Math.PI / 2);
  const bp = band.attributes.position;
  for (let i = 0; i < bp.count; i++) {
    const z = -0.25 + bp.getZ(i) * 0.36;
    const k = Math.sqrt(Math.max(0, 1 - (z / 0.68) ** 2)) * 1.025;
    bp.setXYZ(i, bp.getX(i) * 0.42 * k, 0.72 + bp.getY(i) * 0.4 * k, z);
  }
  band.computeVertexNormals();
  const body = merge([
    paint(sphere(1, [0, 0.72, 0], [0.42, 0.4, 0.68], 20), WHITE),
    paint(band, BLACK),
    paint(sphere(0.27, [0, 0.95, -0.72], [1, 0.92, 0.95], 16), WHITE),
    paint(sphere(0.09, [-0.17, 1.17, -0.68]), BLACK),
    paint(sphere(0.09, [0.17, 1.17, -0.68]), BLACK),
    paint(sphere(0.07, [-0.1, 0.98, -0.94], [1, 1.35, 0.5]).rotateZ(0), BLACK),
    paint(sphere(0.07, [0.1, 0.98, -0.94], [1, 1.35, 0.5]), BLACK),
    paint(sphere(0.016, [-0.1, 1.0, -0.98]), 0xffffff),
    paint(sphere(0.016, [0.1, 1.0, -0.98]), 0xffffff),
    paint(sphere(0.1, [0, 0.87, -0.95], [1, 0.75, 0.8]), WHITE),
    paint(sphere(0.035, [0, 0.9, -1.03], [1.2, 0.8, 1]), BLACK),
    paint(sphere(0.07, [0, 0.8, 0.68]), WHITE),
  ]);
  const parts = [{ name: 'body', geo: body, pivot: [0, 0, 0] }];
  const legs = [[-0.2, -0.38], [0.2, -0.38], [-0.21, 0.38], [0.21, 0.38]];
  legs.forEach(([x, z], i) => {
    const pivot = [x, 0.6, z];
    const geo = merge([
      paint(rod([x, 0.6, z], [x, 0.07, z], 0.13, 0.11, 10), BLACK),
      paint(sphere(0.12, [x, 0.06, z - 0.03], [1, 0.6, 1.25], 10), BLACK),
    ]);
    parts.push({ name: `leg${i}`, geo: aroundPivot(geo, pivot), pivot });
  });
  return {
    parts,
    animate(n, a) {
      const t = a.phase || 0;
      const m = a.moving || 0;
      // ゆったりした歩き〜駆け足(速いほど脚の回転も速い)
      const w = Math.sin(t * Math.PI * 2 * (1.1 + 1.5 * m));
      const amp = 0.55 * m;
      n.leg0.rotation.x = w * amp;
      n.leg3.rotation.x = w * amp;
      n.leg1.rotation.x = -w * amp;
      n.leg2.rotation.x = -w * amp;
      n.body.position.y = Math.abs(w) * 0.04 * m;
      n.body.rotation.x = w * 0.03 * m;
    },
  };
}

function deerTemplate() {
  const BROWN = 0x9b6b3d;
  // 茶色の胴に白い斑点(夏毛)、腹は淡く、尻は白
  const coat = (x, y, z) => {
    if (z > 0.48) return 0xf1ebe0;
    if (y < 0.7) return 0xd9c4a2;
    if (y > 0.86 && Math.sin(x * 41 + z * 13) * Math.sin(z * 37 - y * 29) > 0.78) return 0xeee2c8;
    return BROWN;
  };
  const body = merge([
    paint(sphere(1, [0, 0.82, 0], [0.26, 0.29, 0.58], 16), coat),
    paint(sphere(0.06, [0, 0.9, 0.58], [1, 1.3, 0.6]), 0xf6f1e8),
  ]);
  const parts = [{ name: 'body', geo: body, pivot: [0, 0, 0] }];
  const legs = [[-0.12, -0.38], [0.12, -0.38], [-0.12, 0.38], [0.12, 0.38]];
  legs.forEach(([x, z], i) => {
    const pivot = [x, 0.68, z];
    const geo = merge([
      paint(rod([x, 0.68, z], [x, 0.04, z], 0.045, 0.028, 7), BROWN),
      paint(rod([x, 0.05, z], [x, 0.0, z], 0.032, 0.032, 7), 0x2a2420),
    ]);
    parts.push({ name: `leg${i}`, geo: aroundPivot(geo, pivot), pivot });
  });
  // 首と頭(肩を中心に前へ倒しておじぎする)
  const neckPivot = [0, 0.95, -0.4];
  const head = merge([
    paint(rod([0, 0.92, -0.38], [0, 1.28, -0.55], 0.11, 0.075, 10), BROWN),
    paint(sphere(1, [0, 1.32, -0.66], [0.1, 0.1, 0.19], 12).rotateX(0), BROWN),
    paint(sphere(0.045, [0, 1.3, -0.84], [1, 0.9, 1]), 0x2a2420),
    paint(sphere(1, [-0.11, 1.4, -0.6], [0.09, 0.035, 0.05]).rotateZ(0), 0x8a5d33),
    paint(sphere(1, [0.11, 1.4, -0.6], [0.09, 0.035, 0.05]), 0x8a5d33),
    paint(sphere(0.018, [-0.07, 1.36, -0.73]), 0x111111),
    paint(sphere(0.018, [0.07, 1.36, -0.73]), 0x111111),
    // 小さな角(二又)
    paint(rod([-0.05, 1.4, -0.62], [-0.09, 1.6, -0.6], 0.018, 0.012, 5), 0xd8c9a8),
    paint(rod([0.05, 1.4, -0.62], [0.09, 1.6, -0.6], 0.018, 0.012, 5), 0xd8c9a8),
    paint(rod([-0.075, 1.5, -0.61], [-0.06, 1.58, -0.69], 0.012, 0.008, 5), 0xd8c9a8),
    paint(rod([0.075, 1.5, -0.61], [0.06, 1.58, -0.69], 0.012, 0.008, 5), 0xd8c9a8),
  ]);
  parts.push({ name: 'neck', geo: aroundPivot(head, neckPivot), pivot: neckPivot });
  return {
    scale: 0.85,
    parts,
    animate(n, a) {
      const t = a.phase || 0;
      const m = a.moving || 0;
      // 3秒ごとに1.3秒かけて深くおじぎする
      const u = (t % 3) / 1.3;
      const bow = u < 1 ? Math.sin(Math.PI * u) : 0;
      n.neck.rotation.x = -bow * 0.95 * m;
      n.body.rotation.x = -bow * 0.05 * m;
    },
  };
}

/** 法被(はっぴ)姿の人。原点は足元、前は −Z。flagCell があれば右手に旗を持つ。 */
function personParts(prefix, [px, pz], happi, flagCell, parentName) {
  const PANTS = 0x2b2f45;
  const SKIN = 0xf1c7a1;
  // 法被・はちまき・髪は別の部品を重ねて塗り分ける(頂点カラーの補間でにじまないように)
  const body = merge([
    paint(rod([px - 0.1, 0.8, pz], [px - 0.1, 0.05, pz], 0.065, 0.06), PANTS),
    paint(rod([px + 0.1, 0.8, pz], [px + 0.1, 0.05, pz], 0.065, 0.06), PANTS),
    paint(box(0.12, 0.07, 0.24, [px - 0.1, 0.035, pz - 0.03]), 0x1a1a1a),
    paint(box(0.12, 0.07, 0.24, [px + 0.1, 0.035, pz - 0.03]), 0x1a1a1a),
    paint(new THREE.CylinderGeometry(0.19, 0.24, 0.66, 12).translate(px, 1.11, pz), happi),
    paint(new THREE.CylinderGeometry(0.245, 0.25, 0.1, 12).translate(px, 0.83, pz), 0xffffff), // 裾の白い帯
    paint(box(0.07, 0.56, 0.03, [0, 0, 0]).rotateX(-0.076).translate(px, 1.13, pz - 0.218), 0xffffff), // 襟
    paint(sphere(0.13, [px, 1.57, pz]), SKIN),
    paint(new THREE.SphereGeometry(0.137, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42).rotateX(0.35).translate(px, 1.575, pz + 0.01), 0x1d1712), // 髪
    paint(new THREE.CylinderGeometry(0.139, 0.139, 0.045, 14, 1, true).translate(px, 1.625, pz), 0xffffff), // はちまき
    paint(sphere(0.016, [px - 0.045, 1.585, pz - 0.122]), 0x111111),
    paint(sphere(0.016, [px + 0.045, 1.585, pz - 0.122]), 0x111111),
    paint(rod([px - 0.24, 1.38, pz], [px - 0.27, 0.86, pz - 0.04], 0.055, 0.045, 6), happi),
    paint(sphere(0.05, [px - 0.27, 0.83, pz - 0.04]), SKIN),
  ]);
  const parts = [{ name: `${prefix}body`, geo: body, pivot: [0, 0, 0], parent: parentName }];
  if (flagCell) {
    // 右肩を中心に左右へ振る腕・旗竿・旗(旗は走ってくる側と道路の間を向く)
    const sh = [px + 0.22, 1.38, pz];
    const hand = [sh[0] + 0.2, sh[1] + 0.55, sh[2]];
    const alpha = (Math.PI * 2) / 3;
    const flagW = 0.78;
    const flagH = 0.52;
    const ex = Math.cos(alpha);
    const ez = -Math.sin(alpha);
    const poleTop = [hand[0], hand[1] + 1.05, hand[2]];
    const flag = new THREE.PlaneGeometry(flagW, flagH)
      .rotateY(alpha)
      .translate(poleTop[0] + (ex * flagW) / 2, poleTop[1] - flagH / 2 - 0.02, poleTop[2] + (ez * flagW) / 2);
    const arm = merge([
      paint(rod(sh, hand, 0.055, 0.045, 6), happi),
      paint(sphere(0.05, hand), SKIN),
      paint(rod([hand[0], hand[1] - 0.12, hand[2]], poleTop, 0.016, 0.016, 5), 0x8a6a45),
      paint(flag, 0xffffff, flagCell),
    ]);
    parts.push({ name: `${prefix}arm`, geo: aroundPivot(arm, sh), pivot: sh, parent: parentName });
  }
  return parts;
}

const HAPPI_COLORS = [0xd7263d, 0x1b65b8, 0xf2a541, 0x2a9d5c];

function cheerTemplate() {
  // 4人が道路側(−Z)を向いて横一列に並ぶ。原点は列の道路側の縁の中央
  const xs = [-1.2, -0.4, 0.4, 1.2];
  const parts = [];
  xs.forEach((x, i) => {
    parts.push({ name: `p${i}`, geo: null, pivot: [0, 0, 0] });
    parts.push(...personParts(`p${i}`, [x, 0.35 + (i % 2) * 0.15], HAPPI_COLORS[i], CELLS[`flag${i}`], `p${i}`));
  });
  return {
    parts,
    animate(n, a, low) {
      const t = a.phase || 0;
      const m = a.moving || 0;
      for (let i = 0; i < 4; i++) {
        const off = i * 1.7;
        // 品質「低」では旗を振らない(掲げたまま)
        n[`p${i}arm`].rotation.z = low ? 0 : Math.sin(t * Math.PI * 2 * 1.3 + off) * 0.45 * m;
        n[`p${i}`].position.y = low ? 0 : Math.max(0, Math.sin(t * Math.PI * 2 * 1.1 + off)) * 0.07 * m;
      }
    },
  };
}

function aidTemplate() {
  // 原点はテントの道路側の縁の中央。テントは外向き(+Z)へ奥行き AID_DEPTH_M
  const hw = AID_HALF_WIDTH_M;
  const d = AID_DEPTH_M;
  const cz = d / 2;
  const POLE = 0x9aa3ab;
  const geos = [];
  // 支柱(地面が奥へ下がっていても届くよう、地面の下 1.5m まで伸ばす)
  for (const x of [-hw + 0.05, hw - 0.05]) {
    for (const z of [0.05, d - 0.05]) geos.push(paint(rod([x, 2.3, z], [x, -1.5, z], 0.035, 0.035, 6), POLE));
  }
  // 白い屋根(四角錐)と青い垂れ幕
  geos.push(paint(new THREE.ConeGeometry(hw * Math.SQRT2 + 0.05, 0.7, 4, 1, true).rotateY(Math.PI / 4).translate(0, 2.65, cz), 0xf7f7f5));
  geos.push(paint(box(2 * hw + 0.1, 0.24, 0.03, [0, 2.2, d]), 0x1f5fbf));
  geos.push(paint(box(0.03, 0.24, d, [-hw - 0.03, 2.2, cz]), 0x1f5fbf));
  geos.push(paint(box(0.03, 0.24, d, [hw + 0.03, 2.2, cz]), 0x1f5fbf));
  // 前の横断幕「給水所」(道路側を向く)
  geos.push(paint(new THREE.PlaneGeometry(2 * hw + 0.1, 0.42).rotateY(Math.PI).translate(0, 2.2, -0.02), 0xffffff, CELLS.banner));
  // 机(青いクロス)と天板
  geos.push(paint(box(2.0, 0.04, 0.62, [0, 0.74, 0.55]), 0xf5f5f5));
  // クロスは地面の下 1m まで垂らす(湖側の下り斜面でも机が浮かない)
  geos.push(paint(box(2.0, 1.74, 0.02, [0, -0.13, 0.25]), 0x2d6cdf));
  geos.push(paint(box(2.0, 1.74, 0.02, [0, -0.13, 0.85]), 0x2d6cdf));
  geos.push(paint(box(0.02, 1.74, 0.6, [-1.0, -0.13, 0.55]), 0x2d6cdf));
  geos.push(paint(box(0.02, 1.74, 0.6, [1.0, -0.13, 0.55]), 0x2d6cdf));
  const top = 0.76;
  // 水のペットボトル
  for (let i = 0; i < 6; i++) {
    const x = -0.9 + i * 0.11;
    const z = 0.45 + (i % 2) * 0.12;
    geos.push(paint(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 8).translate(x, top + 0.1, z), 0x9fd6ff));
    geos.push(paint(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 6).translate(x, top + 0.215, z), 0x1f5fbf));
  }
  // 紙コップ
  for (let i = 0; i < 8; i++) {
    const x = -0.15 + (i % 4) * 0.1;
    const z = 0.45 + Math.floor(i / 4) * 0.12;
    geos.push(paint(new THREE.CylinderGeometry(0.036, 0.028, 0.085, 8).translate(x, top + 0.043, z), 0xffffff));
  }
  // お皿とおにぎり(白い三角に黒い海苔の帯)
  geos.push(paint(new THREE.CylinderGeometry(0.2, 0.17, 0.02, 16).translate(0.62, top + 0.01, 0.52), 0xffffff));
  const onigiri = [[0.52, 0.45, 0.2], [0.7, 0.45, -0.2], [0.55, 0.6, 0.1], [0.72, 0.6, -0.1]];
  for (const [x, z, yaw] of onigiri) {
    geos.push(paint(new THREE.CylinderGeometry(0.075, 0.075, 0.045, 3).rotateX(-Math.PI / 2).rotateY(yaw).translate(x, top + 0.02 + 0.0375, z), 0xfbfaf2));
    geos.push(paint(box(0.055, 0.05, 0.05, [0, 0, 0]).rotateY(yaw).translate(x, top + 0.02 + 0.028, z), 0x1b2a1f));
  }
  // 立て看板(走ってくる側 = +X を向く)
  const sx = hw + 0.6;
  geos.push(paint(rod([sx, 0, 0.3], [sx, 1.1, 0.3], 0.025, 0.025, 6), 0x8a6a45));
  geos.push(paint(rod([sx, 0, 0.9], [sx, 1.1, 0.9], 0.025, 0.025, 6), 0x8a6a45));
  geos.push(paint(box(0.03, 0.5, 0.9, [sx - 0.02, 1.15, 0.6]), 0xf5f5f5));
  geos.push(paint(new THREE.PlaneGeometry(0.86, 0.46).rotateY(Math.PI / 2).translate(sx + 0.001, 1.15, 0.6), 0xffffff, CELLS.sign));
  // 机の向こうの係の人(白い法被)
  const staff = personParts('staff', [0.1, 1.2], 0xf5f5f5, null, null);
  for (const p of staff) geos.push(p.geo);
  return {
    parts: [{ name: 'body', geo: merge(geos), pivot: [0, 0, 0] }],
    animate() {},
  };
}

function toriiTemplate(roadHalfWidthM) {
  // 平安神宮風の大鳥居。原点は道路中心の路面、門は XY 面(走る向き −Z にくぐる)
  const P = roadHalfWidthM + TORII_PILLAR_OUTSET_M;
  const H = 17;
  const VERMILION = 0xd9472b;
  const BLACK = 0x1c1c1e;
  const geos = [];
  for (const sx of [-1, 1]) {
    // 柱(地面の高さが違っても浮かないよう地下 4m まで)。根元は黒い根巻
    geos.push(paint(new THREE.CylinderGeometry(0.72, 0.88, H + 4, 16).translate(sx * P, (H - 4) / 2, 0), (x, y) => (y < 1.6 ? BLACK : VERMILION)));
    geos.push(paint(new THREE.CylinderGeometry(1.02, 1.05, 5.6, 16).translate(sx * P, 1.6 - 2.8, 0), BLACK));
  }
  const nukiY = H * 0.72;
  geos.push(paint(box(2 * P + 4.6, 1.1, 0.75, [0, nukiY, 0]), VERMILION)); // 貫
  geos.push(paint(box(2 * P + 5.4, 0.9, 1.05, [0, H + 0.45, 0]), VERMILION)); // 島木
  // 笠木: 両端が反り上がる黒い梁
  const kw = 2 * P + 7.6;
  const kasagi = new THREE.BoxGeometry(kw, 1.1, 1.5, 32, 1, 1);
  const kp = kasagi.attributes.position;
  for (let i = 0; i < kp.count; i++) {
    const u = Math.abs(kp.getX(i)) / (kw / 2);
    kp.setY(i, kp.getY(i) * (1 - 0.15 * u) + 1.3 * Math.pow(u, 2.4));
  }
  kasagi.computeVertexNormals();
  geos.push(paint(kasagi.translate(0, H + 0.9 + 0.55, 0), BLACK));
  // 額束と扁額(走ってくる側 +Z を向く)
  const gakuH = H - (nukiY + 0.55);
  const gakuY = nukiY + 0.55 + gakuH / 2;
  geos.push(paint(box(0.7, gakuH, 0.6, [0, gakuY, 0]), VERMILION));
  geos.push(paint(box(1.6, 3.0, 0.2, [0, gakuY, 0.38]), BLACK));
  geos.push(paint(new THREE.PlaneGeometry(1.4, 2.8).translate(0, gakuY, 0.49), 0xffffff, CELLS.plaque));
  return { parts: [{ name: 'body', geo: merge(geos), pivot: [0, 0, 0] }], animate() {} };
}

// ---- 本体 ----

/**
 * @param {THREE.Object3D} parent 模型を入れる親(他のライダーと同じ。シーン、または景色の inner グループ)
 * @param {THREE.Texture[]} textures シーンが破棄時に dispose するテクスチャの一覧(文字のアトラスを足す)
 */
export function createRoadsideActors(parent, textures) {
  const root = new THREE.Group();
  root.name = 'roadsideActors';
  parent.add(root);
  let material = null;
  const templates = new Map(); // key → テンプレート
  const pools = new Map(); // key → 模型の配列
  const stats = { count: 0, drawCalls: 0 };
  let shadows = false;
  let toriiHalf = null;
  const out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

  function ensureMaterial() {
    if (material) return material;
    const atlas = buildAtlas();
    textures.push(atlas);
    material = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.78, side: THREE.DoubleSide });
    return material;
  }

  function templateFor(key, kind, variant, roadHalfWidthM) {
    let t = templates.get(key);
    if (t) return t;
    switch (kind) {
      case 'cat': t = catTemplate(variant); break;
      case 'panda': t = pandaTemplate(); break;
      case 'deer': t = deerTemplate(); break;
      case 'cheer': t = cheerTemplate(); break;
      case 'aid': t = aidTemplate(); break;
      case 'torii': t = toriiTemplate(roadHalfWidthM); break;
      default:
        t = sightTemplate(kind, KIT);
        if (!t) return null;
    }
    templates.set(key, t);
    return t;
  }

  function instantiate(t) {
    const mat = ensureMaterial();
    const group = new THREE.Group();
    const nodes = {};
    let meshes = 0;
    for (const p of t.parts) {
      let node;
      if (p.geo) {
        node = new THREE.Mesh(p.geo, mat);
        node.castShadow = shadows;
        node.receiveShadow = true;
        meshes++;
      } else {
        node = new THREE.Group();
      }
      node.position.set(p.pivot[0], p.pivot[1], p.pivot[2]);
      nodes[p.name] = node;
      (p.parent ? nodes[p.parent] : group).add(node);
    }
    if (t.scale) group.scale.setScalar(t.scale);
    group.visible = false;
    root.add(group);
    return { group, nodes, template: t, meshes, used: false };
  }

  function setShadows(on) {
    if (shadows === on) return;
    shadows = on;
    root.traverse((o) => {
      if (o.isMesh) o.castShadow = on;
    });
  }

  return {
    /** 描画中の模型の数と draw call 数(テスト・計測用)。 */
    stats,
    /**
     * 毎フレーム呼ぶ。
     * @param {Array|undefined} actors happeningsLayout の actors
     * @param {number} myDistanceM 自分の絶対距離(m)
     * @param {object} opts
     * @param {(gapM:number, lateralM:number, speedMps:number, out:object) => object} opts.place
     *   自分からの距離 gapM・道路中心から右へ lateralM の路面の {x, y, z, yaw, pitch}(parent の座標)を out に書く
     * @param {(gapM:number, lateralM:number) => number} opts.groundAboveRoadM その地点の地面の路面からの高さ(m、負なら路面より低い)
     * @param {number} opts.roadHalfWidthM 車道の半幅(m)
     * @param {number} opts.dt このフレームの経過時間(s。動きは actor.phase で決まるので今は未使用)
     * @param {number} opts.qualityIndex 品質段階(0 = 高, 1 = 中, 2 = 低)
     * @param {number} [opts.behindM] 後方の描画範囲(m)。道路のない所に置かないよう、シーンの道路の後方範囲に合わせる
     */
    update(actors, myDistanceM, { place, groundAboveRoadM, roadHalfWidthM, qualityIndex = 0, behindM = 30 }) {
      for (const list of pools.values()) for (const m of list) m.used = false;
      let count = 0;
      let drawCalls = 0;
      const low = qualityIndex >= 2;
      if (Array.isArray(actors) && actors.length > 0) {
        setShadows(qualityIndex === 0);
        // 道路の幅が変わったら(通常は起きない)大鳥居を作り直す
        if (toriiHalf !== null && toriiHalf !== roadHalfWidthM) {
          for (const m of pools.get('torii') ?? []) root.remove(m.group);
          templates.get('torii')?.parts.forEach((p) => p.geo?.dispose());
          templates.delete('torii');
          pools.delete('torii');
        }
        for (let i = 0; i < actors.length && count < MAX_ACTORS; i++) {
          const a = actors[i];
          if (!a || !Number.isFinite(a.distanceM)) continue;
          const gap = a.distanceM - myDistanceM;
          if (!(gap >= -behindM && gap <= Math.max(MAX_AHEAD_M, a.viewM ?? 0))) continue;
          const variant = a.kind === 'cat' ? variantOf(a.id, CAT_COATS) : 0;
          const key = a.kind === 'cat' ? `cat${variant}` : a.kind;
          let list = pools.get(key);
          if (!list) {
            list = [];
            pools.set(key, list);
          }
          let model = list.find((m) => !m.used);
          if (!model) {
            if (list.length >= MAX_PER_KEY) continue;
            const t = templateFor(key, a.kind, variant, roadHalfWidthM);
            if (!t) continue;
            if (a.kind === 'torii') toriiHalf = roadHalfWidthM;
            model = instantiate(t);
            list.push(model);
          }
          model.used = true;
          const lateral = actorLateralM(a, roadHalfWidthM);
          place(gap, lateral, 0, out);
          let ground;
          const fp = SIGHT_FOOTPRINTS[a.kind];
          if (fp && fp.ground === 'max') {
            // 敷地の中で一番高い地面に建てる(低い側は深い基壇が隠す)
            const rl = fp.halfLatM - 0.5;
            const ra = fp.halfAlongM - 0.5;
            ground = Math.max(
              groundAboveRoadM(gap, lateral), groundAboveRoadM(gap, lateral - rl), groundAboveRoadM(gap, lateral + rl),
              groundAboveRoadM(gap - ra, lateral), groundAboveRoadM(gap + ra, lateral)
            );
          } else if (a.kind === 'torii') {
            ground = 0; // 柱は地下まで伸ばしてあるので路面に合わせる
          } else {
            ground = groundAboveRoadM(gap, lateral);
          }
          const g = model.group;
          g.position.set(out.x, out.y + ground, out.z);
          // 向き = 道路の向き → (小動物は坂の傾き) → actor.yaw。建物・名所は鉛直のまま
          _qa.setFromAxisAngle(UP, out.yaw);
          if (PITCHABLE.has(a.kind) && Math.sign(a.side || 0) === 0 && Math.abs(lateral) <= roadHalfWidthM) {
            _qa.multiply(_qb.setFromAxisAngle(AXIS_X, out.pitch || 0));
          }
          _qa.multiply(_qb.setFromAxisAngle(UP, a.yaw || 0));
          g.quaternion.copy(_qa);
          model.template.animate(model.nodes, a, low);
          count++;
          drawCalls += model.meshes;
        }
      }
      for (const list of pools.values()) for (const m of list) m.group.visible = m.used;
      stats.count = count;
      stats.drawCalls = drawCalls;
    },
  };
}
