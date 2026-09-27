// 丘陵(湖畔)・山岳コース用の手続き的テクスチャ。cityMaterials.jsと同じく、画像ファイルは
// 使わずCanvas 2Dで描く(ビルド・アセット不要の制約を保つため)。

import THREE from './three.js';

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

// 決定的な乱数(テクスチャが毎回同じになるように)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 粒状のノイズを重ねる(アスファルトの骨材・砂利・草の粒感)。 */
function speckle(ctx, width, height, rand, count, minL, maxL, alpha, sizeMax = 2) {
  for (let i = 0; i < count; i++) {
    const l = Math.floor(minL + rand() * (maxL - minL));
    ctx.fillStyle = `rgba(${l},${l},${l},${alpha})`;
    const size = 0.6 + rand() * sizeMax;
    ctx.fillRect(rand() * width, rand() * height, size, size);
  }
}

function toTexture(canvas, { srgb = true, repeat = true, anisotropy = 1 } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 田舎道/山道のアスファルト。U=道路の全幅(左端0〜右端1)、V=ROAD_TILE_M分。
 * 外側線(白の実線)と中央線(湖畔: 白の破線、山岳: 黄色の実線=追越し禁止)を描く。
 */
export function createCountryRoadTexture(roadHalfWidthM, centerLine, anisotropy) {
  const W = 256;
  const H = 512; // = ROAD_TILE_M(12m)
  const { canvas, ctx } = makeCanvas(W, H);
  const rand = rng(centerLine === 'yellow' ? 77 : 55);
  ctx.fillStyle = '#56595c';
  ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, rand, 9000, 40, 120, 0.35, 1.6);
  // 轍(わだち)に沿ってわずかに明るく/暗くする
  for (const lane of [-1, 1]) {
    for (const off of [-0.55, 0.55]) {
      const x = ((lane * roadHalfWidthM * 0.5 + off) / (roadHalfWidthM * 2) + 0.5) * W;
      const grad = ctx.createLinearGradient(x - 10, 0, x + 10, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(0.5, 'rgba(30,30,32,0.18)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - 10, 0, 20, H);
    }
  }
  const mToPx = W / (roadHalfWidthM * 2);
  const lineW = 0.15 * mToPx;
  const paint = (color, x) => {
    ctx.fillStyle = color;
    ctx.fillRect(x - lineW / 2, 0, lineW, H);
  };
  // 外側線
  paint('rgba(236,236,230,0.92)', 0.25 * mToPx);
  paint('rgba(236,236,230,0.92)', W - 0.25 * mToPx);
  // 中央線
  if (centerLine === 'yellow') {
    paint('rgba(232,178,42,0.95)', W / 2);
  } else {
    // 白破線: 5m引いて7m空ける(12mで1周期)
    ctx.fillStyle = 'rgba(236,236,230,0.92)';
    ctx.fillRect(W / 2 - lineW / 2, 0, lineW, (5 / 12) * H);
  }
  // 塗装の擦れ
  speckle(ctx, W, H, rand, 2500, 70, 110, 0.35, 1.2);
  return toTexture(canvas, { anisotropy });
}

/** 路肩(アスファルトの端から地山までの砂利・土)。 */
export function createShoulderTexture(anisotropy) {
  const S = 128;
  const { canvas, ctx } = makeCanvas(S, S);
  const rand = rng(91);
  ctx.fillStyle = '#7d7466';
  ctx.fillRect(0, 0, S, S);
  speckle(ctx, S, S, rand, 3500, 60, 170, 0.5, 2.2);
  return toTexture(canvas, { anisotropy });
}

/** 地形のディテール(グレースケール。頂点カラーに乗算して草や土の粒感を出す)。 */
export function createTerrainDetailTexture(anisotropy) {
  const S = 256;
  const { canvas, ctx } = makeCanvas(S, S);
  const rand = rng(123);
  ctx.fillStyle = '#d6d6d6';
  ctx.fillRect(0, 0, S, S);
  // 大きめのムラ
  for (let i = 0; i < 60; i++) {
    const l = Math.floor(170 + rand() * 70);
    ctx.fillStyle = `rgba(${l},${l},${l},0.25)`;
    const r = 8 + rand() * 30;
    ctx.beginPath();
    ctx.arc(rand() * S, rand() * S, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 草の葉(短いストローク)
  ctx.lineWidth = 1;
  for (let i = 0; i < 5000; i++) {
    const l = Math.floor(120 + rand() * 135);
    ctx.strokeStyle = `rgba(${l},${l},${l},0.5)`;
    const x = rand() * S;
    const y = rand() * S;
    const len = 1.5 + rand() * 3;
    const ang = -Math.PI / 2 + (rand() - 0.5) * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  return toTexture(canvas, { anisotropy });
}

/** 水面の法線マップ(タイル可能な正弦波の重ね合わせ)。 */
export function createWaterNormalTexture() {
  const S = 256;
  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const rand = rng(211);
  // タイル可能にするため、波数は整数(周期がSの約数)に限る
  const waves = [];
  for (let i = 0; i < 14; i++) {
    const kx = Math.round((rand() - 0.5) * 16);
    const ky = Math.round((rand() - 0.5) * 16) || 1;
    waves.push({ kx, ky, amp: 1 / Math.hypot(kx, ky), phase: rand() * Math.PI * 2 });
  }
  const height = (x, y) => {
    let h = 0;
    for (const w of waves) h += w.amp * Math.sin(((w.kx * x + w.ky * y) / S) * Math.PI * 2 + w.phase);
    return h;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      const nx = -dx * 2.2;
      const ny = -dy * 2.2;
      const len = Math.hypot(nx, ny, 1);
      const i = (y * S + x) * 4;
      img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, { srgb: false });
}

/** 山道の擁壁(コンクリートブロック積み風)。U=長さ4m分、V=高さ3m分。 */
export function createRetainingWallTexture(anisotropy) {
  const W = 256;
  const H = 192;
  const { canvas, ctx } = makeCanvas(W, H);
  const rand = rng(301);
  ctx.fillStyle = '#9d9a92';
  ctx.fillRect(0, 0, W, H);
  speckle(ctx, W, H, rand, 4000, 110, 190, 0.35, 1.5);
  // 間知ブロック風の目地(斜めに組んだ石積み)
  ctx.strokeStyle = 'rgba(70,68,62,0.55)';
  ctx.lineWidth = 2;
  const cell = 32;
  for (let y = -cell; y < H + cell; y += cell) {
    for (let x = -cell; x < W + cell; x += cell) {
      const ox = (Math.floor(y / cell) % 2) * (cell / 2);
      ctx.beginPath();
      ctx.moveTo(x + ox, y + cell / 2);
      ctx.lineTo(x + ox + cell / 2, y);
      ctx.lineTo(x + ox + cell, y + cell / 2);
      ctx.lineTo(x + ox + cell / 2, y + cell);
      ctx.closePath();
      ctx.stroke();
    }
  }
  // 雨だれの汚れ
  for (let i = 0; i < 40; i++) {
    const x = rand() * W;
    const len = 20 + rand() * 120;
    const grad = ctx.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, 'rgba(60,58,52,0.28)');
    grad.addColorStop(1, 'rgba(60,58,52,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 2 + rand() * 5, len);
  }
  return toTexture(canvas, { anisotropy });
}

/** LandscapeScene用のテクスチャ一式。all は破棄用。 */
export function createLandscapeTextures(L, anisotropy) {
  const road = createCountryRoadTexture(L.roadHalfWidthM, L.centerLine, anisotropy);
  const shoulder = createShoulderTexture(anisotropy);
  const terrain = createTerrainDetailTexture(anisotropy);
  const water = createWaterNormalTexture();
  const wall = createRetainingWallTexture(anisotropy);
  return { road, shoulder, terrain, water, wall, all: [road, shoulder, terrain, water, wall] };
}
