// 地面の航空写真: 国土地理院のシームレス空中写真タイルを、走っている所のまわりの近景の地形タイル(1 km 四方)に貼る。
//
// 描画品質が最高(z17 ≒ 0.8 m/画素、半径 1.5 km)・高(z16 ≒ 1.6 m/画素、半径 1.2 km)のときだけ。
// 写真タイルを1枚の canvas に並べてテクスチャにし、地形の頂点ごとに経緯度 → Web メルカトルの画素で
// 2つめの UV(uv1)を作る。遠ざかったタイル・品質を下げたときは、元の色分けの地面に戻してテクスチャを捨てる。
// 通信できない・写真の無いタイルは、元の色の地面のまま(または写真の無い所だけ落ち着いた緑)になる。

import THREE from './three.js';
import { toLonLat } from './sceneryData.js';

const URL_TEMPLATE = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
const TIERS = { ultra: { z: 17, r: 1500 }, high: { z: 16, r: 1200 } };
const MAX_IN_FLIGHT = 6;
const CHECK_EVERY_M = 50;

function mercatorPx(lon, lat, z) {
  const n = 2 ** z * 256;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/**
 * @param {object} sc 景色データ。sc.near の各タイルに mesh(地形のメッシュ)が付いていること
 * @param {{anisotropy?:number, loadImage?:(url:string)=>Promise<HTMLImageElement>}} [opts]
 *   anisotropy: 斜めから見た地面の写真をぼかさないための異方性フィルタ(端末の上限)。loadImage はテスト用。
 *   patchMaterial: 写真の地面の material に元の地面と同じ加工(トンネルの中を描かない)をする関数
 */
export function createAerialPhotos(sc, { anisotropy = 4, loadImage, patchMaterial = (m) => m } = {}) {
  const tiles = [...sc.near.values()].filter((t) => t.mesh);
  const N = sc.n;
  let cfg = null;
  let generation = 0; // 品質を切り替えたら、読み込み中の結果は捨てる
  let last = null;
  const queue = [];
  let inFlight = 0;

  const load = loadImage ?? ((url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  }));
  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
      const job = queue.shift();
      if (job.cancelled()) continue;
      inFlight++;
      load(job.url).then(job.done, () => job.done(null)).finally(() => {
        inFlight--;
        pump();
      });
    }
  }

  function revert(t) {
    if (!t.photo) return;
    t.photo.cancelled = true;
    if (t.photo.material) {
      t.mesh.material = t.baseMaterial;
      t.photo.material.map.dispose();
      t.photo.material.dispose();
    }
    t.photo = null;
  }

  function request(t) {
    const { z } = cfg;
    const gen = generation;
    const photo = { cancelled: false, material: null };
    t.photo = photo;
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => mercatorPx(...toLonLat(sc, (t.tx + a) * sc.tile, (t.ty + b) * sc.tile), z));
    const tx0 = Math.floor(Math.min(...corners.map((c) => c[0])) / 256);
    const tx1 = Math.floor(Math.max(...corners.map((c) => c[0])) / 256);
    const ty0 = Math.floor(Math.min(...corners.map((c) => c[1])) / 256);
    const ty1 = Math.floor(Math.max(...corners.map((c) => c[1])) / 256);
    const cv = document.createElement('canvas');
    cv.width = (tx1 - tx0 + 1) * 256;
    cv.height = (ty1 - ty0 + 1) * 256;
    const g = cv.getContext('2d');
    g.fillStyle = '#5f6e4c';
    g.fillRect(0, 0, cv.width, cv.height);
    // 空中写真は冬の撮影が多く灰色がかるので、少し鮮やかにする(下の material の色でさらに緑寄りに抑える)
    g.filter = 'saturate(1.35) contrast(1.05)';
    let left = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    let got = 0;
    const finish = () => {
      if (photo.cancelled || gen !== generation || got === 0) return;
      // 地形の頂点ごとの写真上の位置(2つめの UV)
      const uv = new Float32Array((N + 1) ** 2 * 2);
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const [px, py] = mercatorPx(...toLonLat(sc, t.tx * sc.tile + i * sc.cell, t.ty * sc.tile + j * sc.cell), z);
          uv.set([(px - tx0 * 256) / cv.width, 1 - (py - ty0 * 256) / cv.height], (j * (N + 1) + i) * 2);
        }
      }
      t.mesh.geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
      const map = new THREE.CanvasTexture(cv);
      map.colorSpace = THREE.SRGBColorSpace;
      map.channel = 1;
      map.anisotropy = anisotropy;
      // 写真には影も写っているので、日の光で明るくなりすぎないよう少し暗い緑がかった色を掛ける
      photo.material = patchMaterial(new THREE.MeshStandardMaterial({ map, color: 0xa4ad94, roughness: 0.95 }));
      t.baseMaterial ??= t.mesh.material;
      t.mesh.material = photo.material;
    };
    for (let x = tx0; x <= tx1; x++) {
      for (let y = ty0; y <= ty1; y++) {
        queue.push({
          url: URL_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y),
          cancelled: () => photo.cancelled || gen !== generation,
          done: (img) => {
            if (img && !photo.cancelled) {
              g.drawImage(img, (x - tx0) * 256, (y - ty0) * 256);
              got++;
            }
            if (--left === 0) finish();
          },
        });
      }
    }
    pump();
  }

  return {
    /** 描画品質の段階名('ultra' | 'high' | 'medium' | 'low')。最高・高以外では写真を外す。 */
    setTier(name) {
      const next = TIERS[name] ?? null;
      if (next === cfg) return;
      cfg = next;
      generation++;
      queue.length = 0;
      for (const t of tiles) revert(t);
      last = null;
    },
    /** ライダーの位置 (x, y)。近づいたタイルに写真を貼り、遠ざかったタイルからは外す。 */
    update(x, y) {
      if (!cfg || (last && Math.hypot(x - last[0], y - last[1]) < CHECK_EVERY_M)) return;
      last = [x, y];
      const near = [];
      for (const t of tiles) {
        const d = Math.hypot((t.tx + 0.5) * sc.tile - x, (t.ty + 0.5) * sc.tile - y);
        if (d > cfg.r * 1.4 + sc.tile) revert(t);
        else if (d < cfg.r + sc.tile * 0.5 && !t.photo) near.push([d, t]);
      }
      near.sort((a, b) => a[0] - b[0]).forEach(([, t]) => request(t)); // 近いタイルから読む
    },
    dispose() {
      generation++;
      queue.length = 0;
      for (const t of tiles) revert(t);
    },
  };
}
