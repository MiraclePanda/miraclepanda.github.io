// 3D都市シーン用のテクスチャ・マテリアル生成。
//
// 外部の画像アセットは一切使わず、すべてCanvas 2Dで手続き的に描画した
// テクスチャ(CanvasTexture)から作る。ビルドもアセット配信も不要という
// このアプリの方針(index.htmlだけで動く)を保つため。
// 乱数はcityLayout.jsのmulberry32を固定シードで使い、毎回同じ見た目にする。
//
// 建物の外壁は「窓の並び(ベイ)×階」を1タイルとして繰り返す。InstancedMeshの
// インスタンスごとに建物サイズが違っても窓の大きさが一定になるよう、
// createFacadeMaterialがシェーダーを差し替えて、instanceMatrixから取り出した
// スケールでUVを計算し直す(ジオメトリのUVを建物ごとに書き換えずに済む)。

import THREE from './three.js';
import { mulberry32 } from './cityLayout.js';

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function toTexture(canvas, { srgb = true, anisotropy = 1 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function rgb(r, g, b, a = 1) {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

/** 全画素に明暗のばらつきを加える(骨材の粒状感)。大量のfillRectより桁違いに速い。 */
function grain(ctx, w, h, rand, amount) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/** 明暗の細かい粒(アスファルトやコンクリートの質感)を散らす。 */
function speckle(ctx, w, h, rand, count, { light = 255, dark = 0, alpha = 0.08, maxSize = 2 } = {}) {
  for (let i = 0; i < count; i++) {
    const v = rand() < 0.5 ? light : dark;
    ctx.fillStyle = rgb(v, v, v, alpha * (0.4 + rand() * 0.6));
    const s = 1 + rand() * (maxSize - 1);
    ctx.fillRect(rand() * w, rand() * h, s, s);
  }
}

/**
 * 色(map)と粗さ/金属度(roughnessMap=G, metalnessMap=B)の2枚のCanvasへ
 * 同じ形を同時に描くための小さなペインタ。
 */
function dualPainter(w, h) {
  const color = makeCanvas(w, h);
  const orm = makeCanvas(w, h);
  const c = color.getContext('2d');
  const o = orm.getContext('2d');
  return {
    color, orm, c, o,
    rect(x, y, rw, rh, fill, rough, metal = 0) {
      c.fillStyle = fill;
      c.fillRect(x, y, rw, rh);
      o.fillStyle = rgb(255, rough, metal);
      o.fillRect(x, y, rw, rh);
    },
    /** 空を映す窓ガラス。カーテン/ブラインドの有無をランダムに変える。 */
    glass(x, y, gw, gh, rand, { tint = [96, 116, 134], curtains = 0.45 } = {}) {
      const grad = c.createLinearGradient(x, y, x, y + gh);
      const [r, g, b] = tint;
      grad.addColorStop(0, rgb(r + 40, g + 42, b + 44));
      grad.addColorStop(0.55, rgb(r, g, b));
      grad.addColorStop(1, rgb(r - 25, g - 25, b - 22));
      c.fillStyle = grad;
      c.fillRect(x, y, gw, gh);
      o.fillStyle = rgb(255, 28, 170);
      o.fillRect(x, y, gw, gh);
      if (rand() < curtains) {
        // 室内側のカーテン/ブラインド(反射は弱め)
        const cover = 0.3 + rand() * 0.7;
        const tone = 170 + rand() * 60;
        c.fillStyle = rgb(tone, tone * 0.95, tone * 0.85, 0.55);
        c.fillRect(x, y, gw, gh * cover);
        o.fillStyle = rgb(255, 120, 60);
        o.fillRect(x, y, gw, gh * cover);
      }
    },
  };
}

// ---- 外壁テクスチャ(1タイル = 4ベイ × 4階、各セル128px四方) ----

const CELL = 128;
const TILE_BAYS = 4;
const TILE_FLOORS = 4;

function paintCells(p, rand, paintCell) {
  for (let fy = 0; fy < TILE_FLOORS; fy++) {
    for (let bx = 0; bx < TILE_BAYS; bx++) {
      paintCell(bx * CELL, fy * CELL, rand, bx, fy);
    }
  }
}

function paintBrick(p, rand) {
  const size = CELL * TILE_BAYS;
  p.rect(0, 0, size, size, '#8a4a36', 235);
  // レンガ目地(8px段、段ごとに半個ずらし)
  const brickH = 8;
  const brickW = 22;
  for (let row = 0; row < size / brickH; row++) {
    const offset = row % 2 ? brickW / 2 : 0;
    for (let x = -offset; x < size; x += brickW) {
      const j = (rand() - 0.5) * 34;
      p.c.fillStyle = rgb(142 + j, 74 + j * 0.6, 54 + j * 0.4);
      p.c.fillRect(x + 1, row * brickH + 1, brickW - 2, brickH - 2);
    }
    p.c.fillStyle = 'rgba(190,176,156,0.9)';
    p.c.fillRect(0, row * brickH + brickH - 1, size, 1);
  }
  speckle(p.c, size, size, rand, 2000, { alpha: 0.12 });
  paintCells(p, rand, (x, y) => {
    // 石のまぐさ・窓台と、白い窓枠
    p.rect(x + 28, y + 20, 72, 8, '#d9d0c0', 200);
    p.rect(x + 26, y + 102, 76, 7, '#d9d0c0', 200);
    p.rect(x + 32, y + 28, 64, 74, '#ecebe6', 150);
    p.glass(x + 36, y + 32, 56, 66, rand);
    p.rect(x + 62, y + 32, 4, 66, '#ecebe6', 150);
  });
}

function paintConcrete(p, rand) {
  const size = CELL * TILE_BAYS;
  p.rect(0, 0, size, size, '#b8b4ab', 225);
  speckle(p.c, size, size, rand, 3000, { alpha: 0.12, maxSize: 3 });
  // 型枠のセパ穴と打ち継ぎ目
  for (let y = 0; y < size; y += 64) {
    p.c.fillStyle = 'rgba(90,88,84,0.25)';
    p.c.fillRect(0, y, size, 1);
  }
  paintCells(p, rand, (x, y) => {
    // 連続した横長の窓(リボンウィンドウ)と、階ごとの庇
    p.rect(x, y + 24, CELL, 64, '#4d5359', 90, 150);
    for (let m = 0; m < 3; m++) {
      p.glass(x + 4 + m * 41, y + 28, 37, 56, rand, { tint: [92, 112, 128], curtains: 0.35 });
    }
    p.rect(x, y + 96, CELL, 6, '#d4d0c8', 190);
    p.c.fillStyle = 'rgba(40,40,40,0.18)';
    p.c.fillRect(x, y + 102, CELL, 4);
  });
}

function paintGlass(p, rand) {
  const size = CELL * TILE_BAYS;
  paintCells(p, rand, (x, y) => {
    p.glass(x, y, CELL, CELL - 20, rand, { tint: [90, 124, 140], curtains: 0.25 });
    // スパンドレル(階間の不透明パネル)
    p.rect(x, y + CELL - 20, CELL, 20, '#2b3a44', 70, 200);
    // 縦横のマリオン
    p.rect(x, y, 4, CELL, '#b9c0c6', 80, 230);
    p.rect(x + CELL / 2 - 1, y, 2, CELL - 20, '#9aa3aa', 80, 230);
    p.rect(x, y + CELL - 21, CELL, 2, '#b9c0c6', 80, 230);
  });
  // 階ごとにわずかに反射の色を揺らしてベタ塗り感を消す
  for (let i = 0; i < 40; i++) {
    p.c.fillStyle = rgb(200, 220, 235, rand() * 0.08);
    p.c.fillRect(rand() * size, rand() * size, 30 + rand() * 90, 10 + rand() * 40);
  }
}

function paintStucco(p, rand) {
  const size = CELL * TILE_BAYS;
  p.rect(0, 0, size, size, '#e6dccb', 240);
  speckle(p.c, size, size, rand, 2500, { alpha: 0.09, maxSize: 3 });
  // 雨だれ汚れ
  for (let i = 0; i < 24; i++) {
    const x = rand() * size;
    const grad = p.c.createLinearGradient(0, 0, 0, 80);
    grad.addColorStop(0, 'rgba(90,85,75,0.12)');
    grad.addColorStop(1, 'rgba(90,85,75,0)');
    p.c.fillStyle = grad;
    p.c.fillRect(x, Math.floor(rand() * 4) * CELL + 100, 3 + rand() * 6, 80);
  }
  paintCells(p, rand, (x, y) => {
    // 集合住宅: 掃き出し窓+バルコニー(スラブと手すり)
    p.rect(x + 14, y + 12, 100, 88, '#d8d8d4', 160);
    p.glass(x + 18, y + 16, 92, 82, rand, { curtains: 0.7 });
    p.rect(x + 63, y + 16, 3, 82, '#d8d8d4', 160);
    p.rect(x, y + 104, CELL, 10, '#cfcac0', 210);
    p.c.fillStyle = 'rgba(30,30,30,0.25)';
    p.c.fillRect(x, y + 114, CELL, 3);
    // 手すり(半透明の格子)
    p.rect(x, y + 70, CELL, 4, '#8c9196', 90, 200);
    for (let bx = x + 4; bx < x + CELL; bx += 8) {
      p.c.fillStyle = 'rgba(120,126,132,0.85)';
      p.c.fillRect(bx, y + 74, 2, 30);
    }
    // たまに洗濯物や室外機
    if (rand() < 0.35) p.rect(x + 90, y + 88, 22, 16, '#e9e9e4', 200);
  });
}

// 1階の店舗(1タイル = 4ベイ × 1階、各セル128×128px)。
const SIGN_COLORS = ['#1f5d8c', '#b8332c', '#2f6b3a', '#f2b632', '#3a3a3a', '#e8e4da', '#7a3b6e'];

function paintStorefront(p, rand) {
  const w = CELL * TILE_BAYS;
  p.rect(0, 0, w, CELL, '#6d6a66', 200);
  for (let b = 0; b < TILE_BAYS; b++) {
    const x = b * CELL;
    // 柱
    p.rect(x, 0, 10, CELL, '#a9a49b', 210);
    // 看板帯と文字(ダミーの文字ブロック)
    const sign = SIGN_COLORS[Math.floor(rand() * SIGN_COLORS.length)];
    p.rect(x + 10, 6, CELL - 10, 26, sign, 120, 20);
    const dark = sign === '#e8e4da' || sign === '#f2b632';
    p.c.fillStyle = dark ? 'rgba(30,30,30,0.85)' : 'rgba(250,250,245,0.9)';
    let tx = x + 24 + rand() * 12;
    const end = x + CELL - 20 - rand() * 36;
    while (tx < end) {
      const cw = 3 + rand() * 4;
      p.c.fillRect(tx, 15 + rand() * 2, cw, 7 + rand() * 3);
      tx += cw + 2;
    }
    // 日よけテント(ストライプ)をたまに
    if (rand() < 0.5) {
      for (let s = 0; s < CELL - 10; s += 12) {
        p.rect(x + 10 + s, 32, 6, 12, sign, 230);
        p.rect(x + 16 + s, 32, 6, 12, '#efe9dc', 230);
      }
    }
    // ショーウィンドウ(暖色の店内照明と商品棚をうっすら)
    const top = 46;
    const grad = p.c.createLinearGradient(0, top, 0, CELL - 8);
    grad.addColorStop(0, '#3b3a36');
    grad.addColorStop(1, '#1f1e1c');
    p.c.fillStyle = grad;
    p.c.fillRect(x + 14, top, CELL - 20, CELL - 8 - top);
    p.o.fillStyle = rgb(255, 30, 160);
    p.o.fillRect(x + 14, top, CELL - 20, CELL - 8 - top);
    for (let i = 0; i < 10; i++) {
      p.c.fillStyle = rgb(200 + rand() * 55, 160 + rand() * 60, 90 + rand() * 60, 0.35);
      p.c.fillRect(x + 16 + rand() * (CELL - 40), top + 10 + rand() * 50, 8 + rand() * 14, 6 + rand() * 10);
    }
    // 入口ドア
    if (rand() < 0.6) {
      const dx = x + 20 + rand() * (CELL - 60);
      p.rect(dx, top + 4, 26, CELL - 12 - top - 4, '#50504c', 60, 180);
      p.rect(dx + 12, top + 4, 2, CELL - 12 - top - 4, '#8b8b85', 80, 220);
    }
    // 巾木
    p.rect(x, CELL - 8, CELL, 8, '#4a4744', 200);
  }
}

// ---- 地面系テクスチャ ----

/** 車道(幅8m×長さ10m 1タイル): アスファルト+外側線+中央の破線。 */
function makeRoadCanvas(rand) {
  const w = 512;
  const h = 1024;
  const canvas = makeCanvas(w, h);
  const c = canvas.getContext('2d');
  paintAsphalt(c, w, h, rand);
  const pxPerMx = w / 8;
  const pxPerMy = h / 10;
  const lineW = 0.15 * pxPerMx;
  c.fillStyle = 'rgba(236,236,230,0.92)';
  // 外側線(車道端から0.25m内側)
  c.fillRect(0.25 * pxPerMx, 0, lineW, h);
  c.fillRect(w - 0.25 * pxPerMx - lineW, 0, lineW, h);
  // 中央線: 5m描いて5m空ける破線
  c.fillRect(w / 2 - lineW / 2, 0, lineW, 5 * pxPerMy);
  // 摩耗(白線の上にアスファルト色の粒)
  c.globalCompositeOperation = 'source-atop';
  speckle(c, w, h, rand, 3000, { light: 60, dark: 50, alpha: 0.35, maxSize: 3 });
  c.globalCompositeOperation = 'source-over';
  return canvas;
}

function paintAsphalt(c, w, h, rand) {
  c.fillStyle = '#6a6b6c';
  c.fillRect(0, 0, w, h);
  grain(c, w, h, rand, 38);
  speckle(c, w, h, rand, (w * h) / 150, { light: 150, dark: 10, alpha: 0.25, maxSize: 2 });
  // 補修跡のパッチと、タイヤが通る部分のわずかな色ムラ
  for (let i = 0; i < 5; i++) {
    c.fillStyle = rgb(70, 70, 72, 0.08 + rand() * 0.08);
    c.beginPath();
    c.ellipse(rand() * w, rand() * h, 20 + rand() * 60, 15 + rand() * 50, rand() * 3, 0, Math.PI * 2);
    c.fill();
  }
  for (let i = 0; i < 12; i++) {
    c.strokeStyle = 'rgba(25,25,25,0.35)';
    c.lineWidth = 1;
    c.beginPath();
    let x = rand() * w;
    let y = rand() * h;
    c.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rand() - 0.5) * 30;
      y += (rand() - 0.5) * 30;
      c.lineTo(x, y);
    }
    c.stroke();
  }
}

/** 歩道(2m四方1タイル): 0.5m角のコンクリート平板ブロック。 */
function makeSidewalkCanvas(rand) {
  const size = 512;
  const canvas = makeCanvas(size, size);
  const c = canvas.getContext('2d');
  c.fillStyle = '#8e8a84';
  c.fillRect(0, 0, size, size);
  const cell = size / 4;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const j = (rand() - 0.5) * 18;
      c.fillStyle = rgb(178 + j, 172 + j, 162 + j);
      c.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  grain(c, size, size, rand, 22);
  speckle(c, size, size, rand, 2000, { alpha: 0.12, maxSize: 2 });
  return canvas;
}

/** 敷地・広場(6m四方1タイル): 目地の入ったコンクリート舗装。 */
function makeLotCanvas(rand) {
  const size = 512;
  const canvas = makeCanvas(size, size);
  const c = canvas.getContext('2d');
  c.fillStyle = '#9d9a93';
  c.fillRect(0, 0, size, size);
  grain(c, size, size, rand, 20);
  speckle(c, size, size, rand, 2500, { alpha: 0.12, maxSize: 3 });
  for (let i = 0; i < 10; i++) {
    c.fillStyle = rgb(80, 80, 75, 0.06 + rand() * 0.06);
    c.beginPath();
    c.ellipse(rand() * size, rand() * size, 20 + rand() * 60, 10 + rand() * 40, rand() * 3, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = 'rgba(60,60,58,0.5)';
  c.fillRect(0, 0, size, 2);
  c.fillRect(0, 0, 2, size);
  c.fillRect(0, size / 2, size, 1);
  c.fillRect(size / 2, 0, 1, size);
  return canvas;
}

/** 横断歩道(幅8m×奥行き4m): 白い縞のみ不透明(alphaTestで抜く)。 */
function makeCrosswalkCanvas(rand) {
  const w = 512;
  const h = 256;
  const canvas = makeCanvas(w, h);
  const c = canvas.getContext('2d');
  const pxPerM = w / 8;
  c.fillStyle = 'rgba(238,238,232,1)';
  for (let x = 0.25; x + 0.45 <= 7.8; x += 0.9) {
    c.fillRect(x * pxPerM, 0, 0.45 * pxPerM, h);
  }
  c.globalCompositeOperation = 'destination-out';
  speckle(c, w, h, rand, 4000, { alpha: 1, maxSize: 3 });
  c.globalCompositeOperation = 'source-over';
  return canvas;
}

// ---- 公開API ----

const FACADE_PAINTERS = {
  brick: paintBrick,
  concrete: paintConcrete,
  glass: paintGlass,
  stucco: paintStucco,
};

/**
 * インスタンスのスケールから窓のタイリングを計算する外壁マテリアル。
 * ジオメトリは createFacadeGeometry() のもの(facadeAxis属性付き)と組で使う。
 *
 * @param {object} opts
 * @param {THREE.Texture} opts.map
 * @param {THREE.Texture} opts.ormMap  G=roughness, B=metalness
 * @param {number} opts.bayM    窓1列(ベイ)の幅(m)
 * @param {number} opts.floorM  1階分の高さ(m)
 * @param {number} opts.tileBays   テクスチャ1枚に含まれるベイ数
 * @param {number} opts.tileFloors テクスチャ1枚に含まれる階数
 * @param {number} opts.sinkM   地面下に埋めている深さ(坂道対策)。窓の段をずらさないため
 */
export function createFacadeMaterial({ map, ormMap, bayM, floorM, tileBays, tileFloors, sinkM }) {
  const material = new THREE.MeshStandardMaterial({
    map,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    roughness: 1,
    metalness: 1,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFacade = { value: new THREE.Vector4(bayM, floorM, tileBays, tileFloors) };
    shader.uniforms.uFacadeSink = { value: sinkM };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float facadeAxis;\nuniform vec4 uFacade;\nuniform float uFacadeSink;'
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_INSTANCING
{
  vec3 fs = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  float faceW = facadeAxis > 0.5 ? fs.z : fs.x;
  // 建物の幅に収まる整数個のベイに合わせて少しだけ伸縮させ、角で窓が切れないようにする。
  float bays = max(1.0, floor(faceW / uFacade.x + 0.5));
  vec2 fuv = vec2(uv.x * bays / uFacade.z, (uv.y * fs.y - uFacadeSink) / uFacade.y / uFacade.w);
  #ifdef USE_MAP
  vMapUv = fuv;
  #endif
  #ifdef USE_ROUGHNESSMAP
  vRoughnessMapUv = fuv;
  #endif
  #ifdef USE_METALNESSMAP
  vMetalnessMapUv = fuv;
  #endif
}
#endif`
      );
  };
  return material;
}

/**
 * 底面がy=0、上面がy=1の単位直方体。側面ごとに、UのスケールをX/Zどちらの
 * インスタンススケールから取るかを facadeAxis 属性(0=X, 1=Z)で持たせる。
 */
export function createFacadeGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  // BoxGeometryの面順: +X, -X, +Y, -Y, +Z, -Z(各4頂点)。
  // ±X面はUがZ方向に沿い、±Z面はUがX方向に沿う。
  const axis = new Float32Array(24);
  for (let face = 0; face < 6; face++) {
    const value = face < 2 ? 1 : 0;
    for (let v = 0; v < 4; v++) axis[face * 4 + v] = value;
  }
  geo.setAttribute('facadeAxis', new THREE.BufferAttribute(axis, 1));
  return geo;
}

/**
 * シーンで使うすべてのテクスチャを生成する。
 * @param {number} anisotropy renderer.capabilities.getMaxAnisotropy() 由来の値
 * @returns {{facades: Record<string, {map, ormMap}>, storefront: {map, ormMap}, road, asphalt, sidewalk, lot, crosswalk, all: THREE.Texture[]}}
 */
export function createCityTextures(anisotropy) {
  const all = [];
  const track = (tex) => {
    all.push(tex);
    return tex;
  };

  const facades = {};
  let seed = 101;
  for (const [style, paint] of Object.entries(FACADE_PAINTERS)) {
    const p = dualPainter(CELL * TILE_BAYS, CELL * TILE_FLOORS);
    paint(p, mulberry32(seed++));
    facades[style] = {
      map: track(toTexture(p.color, { anisotropy })),
      ormMap: track(toTexture(p.orm, { srgb: false, anisotropy })),
    };
  }

  const sp = dualPainter(CELL * TILE_BAYS, CELL);
  paintStorefront(sp, mulberry32(seed++));
  const storefront = {
    map: track(toTexture(sp.color, { anisotropy })),
    ormMap: track(toTexture(sp.orm, { srgb: false, anisotropy })),
  };

  return {
    facades,
    storefront,
    road: track(toTexture(makeRoadCanvas(mulberry32(201)), { anisotropy })),
    asphalt: track(toTexture((() => {
      const canvas = makeCanvas(512, 512);
      paintAsphalt(canvas.getContext('2d'), 512, 512, mulberry32(202));
      return canvas;
    })(), { anisotropy })),
    sidewalk: track(toTexture(makeSidewalkCanvas(mulberry32(203)), { anisotropy })),
    lot: track(toTexture(makeLotCanvas(mulberry32(204)), { anisotropy })),
    crosswalk: track(toTexture(makeCrosswalkCanvas(mulberry32(205)), { anisotropy })),
    all,
  };
}

export const FACADE_TILE = { cellBays: TILE_BAYS, cellFloors: TILE_FLOORS };
