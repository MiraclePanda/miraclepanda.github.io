// 道ばたの置き物の描画: 電柱と電線・カーブミラー・標識(速度・カーブの警戒・青い案内)。
// 配置は roadsideLayout.js(純粋な計算)が決め、ここは毎フレーム、ライダーの前後にあるものだけを
// インスタンスのプールに並べ直す(ライダーの位置を原点にした座標。realRoadScene の置き物と同じやり方)。
// 青い案内標識だけは文字が1枚ずつ違うので、読み込み時に1枚ずつメッシュを作り、近い物だけ見せる。

import THREE from './three.js';
import { makePool, pushInstance, pushInstanceYawPitch, commitPool } from './sceneKit.js';
import { firstIndexFrom, wireSagM } from './roadsideLayout.js';

const BEHIND_M = 40;
const AHEAD_M = 360;
const GUIDE_VIEW_M = 900;
const GOAL_VIEW_M = 1500; // ゴールの門はこの手前から見える
const POLE_H = 11;
const ARM_Y = 10.3;
const WIRE_SEGS = 5;
// 電線: [電柱からの横のずれ(m、道の側が正), 高さ, 太さ, 色]
const WIRES = [
  [-0.75, ARM_Y + 0.12, 0.03, 0x3a3a3a], [0, ARM_Y + 0.12, 0.03, 0x3a3a3a], [0.75, ARM_Y + 0.12, 0.03, 0x3a3a3a],
  [0.25, 7.2, 0.06, 0x1d1d1d],
];

function signTexture(paint, w = 128, h = 128) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  paint(cv.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 速度標識: 白地に赤い輪、青い数字。 */
function speedTexture(limit) {
  return signTexture((g, n) => {
    g.beginPath();
    g.arc(n / 2, n / 2, n / 2 - 2, 0, Math.PI * 2);
    g.fillStyle = '#d42a2a';
    g.fill();
    g.beginPath();
    g.arc(n / 2, n / 2, n / 2 - 15, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.fillStyle = '#1d4fa8';
    g.font = 'bold 58px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(limit), n / 2, n / 2 + 3);
  });
}

/** 警戒標識: 黄色のひし形に黒い縁、カーブの矢印(dir の向きに曲がる)。 */
function warnTexture(dir) {
  return signTexture((g, n) => {
    const diamond = (r) => {
      g.beginPath();
      g.moveTo(n / 2, n / 2 - r);
      g.lineTo(n / 2 + r, n / 2);
      g.lineTo(n / 2, n / 2 + r);
      g.lineTo(n / 2 - r, n / 2);
      g.closePath();
    };
    diamond(n / 2 - 1);
    g.fillStyle = '#111111';
    g.fill();
    diamond(n / 2 - 7);
    g.fillStyle = '#f4c20d';
    g.fill();
    const s = dir === 'left' ? -1 : 1;
    const c = n / 2;
    g.strokeStyle = '#111111';
    g.lineWidth = 12;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(c - s * 14, n * 0.8);
    g.lineTo(c - s * 14, n * 0.52);
    g.quadraticCurveTo(c - s * 14, n * 0.34, c + s * 8, n * 0.34);
    g.stroke();
    g.fillStyle = '#111111';
    g.beginPath();
    g.moveTo(c + s * 34, n * 0.34);
    g.lineTo(c + s * 6, n * 0.2);
    g.lineTo(c + s * 6, n * 0.48);
    g.closePath();
    g.fill();
  });
}

/** 標識の裏(灰色)に使う形だけの絵。 */
function silhouetteTexture(shape) {
  return signTexture((g, n) => {
    g.fillStyle = '#ffffff';
    g.beginPath();
    if (shape === 'circle') g.arc(n / 2, n / 2, n / 2 - 2, 0, Math.PI * 2);
    else { g.moveTo(n / 2, 1); g.lineTo(n - 1, n / 2); g.lineTo(n / 2, n - 1); g.lineTo(1, n / 2); g.closePath(); }
    g.fill();
  }, 64, 64);
}

/** 青い案内標識: 行き先と km を1行ずつ、上向きの矢印。 */
function guideTexture(lines) {
  return signTexture((g, w, h) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f55a5';
    g.fillRect(6, 6, w - 12, h - 12);
    g.fillStyle = '#ffffff';
    // 上向きの矢印(まっすぐ)
    g.fillRect(40, 60, 16, h - 90);
    g.beginPath();
    g.moveTo(48, 26);
    g.lineTo(74, 66);
    g.lineTo(22, 66);
    g.closePath();
    g.fill();
    g.textBaseline = 'middle';
    const rowH = (h - 30) / lines.length;
    lines.forEach((ln, i) => {
      const y = 15 + rowH * (i + 0.5);
      g.textAlign = 'left';
      g.font = 'bold 50px sans-serif';
      g.fillText(ln.name, 96, y, 250);
      g.textAlign = 'right';
      g.font = 'bold 44px sans-serif';
      g.fillText(`${ln.km}km`, w - 22, y);
    });
  }, 512, 256);
}

/** ゴールの表札: 木の枠にクリーム色の板、上に赤い「ゴール」、下に大きく行き先の名前。 */
function goalTexture(name) {
  return signTexture((g, w, h) => {
    g.fillStyle = '#6b4424';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#f7efdc';
    g.fillRect(22, 22, w - 44, h - 44);
    g.strokeStyle = '#b8862f';
    g.lineWidth = 6;
    g.strokeRect(36, 36, w - 72, h - 72);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#c0392b';
    g.font = 'bold 118px sans-serif';
    g.fillText('ゴール', w / 2, 132);
    g.fillStyle = '#2a1d12';
    g.font = 'bold 200px serif';
    g.fillText(name, w / 2, 330, w - 120);
  }, 1024, 480);
}

/**
 * @param {THREE.Scene} scene
 * @param {ReturnType<import('./roadsideLayout.js').planRoadside>} plan
 * @param {(m:number, out?:object)=>{x:number,y:number,z:number,hx:number,hy:number}} at
 * @param {{textures:THREE.Texture[]}} o テクスチャはシーンの片付けでまとめて解放する
 */
export function createRoadside(scene, plan, at, { textures }) {
  const tex = (t) => (textures.push(t), t);
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const plane = new THREE.PlaneGeometry(1, 1);
  const faceMat = (map) => std(0xffffff, { map, alphaTest: 0.5, roughness: 0.5 });
  const pools = {
    pole: makePool(new THREE.CylinderGeometry(0.13, 0.19, 1, 8).translate(0, 0.5, 0), std(0xb9b5ab, { roughness: 0.9 }), 30),
    arm: makePool(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), std(0x7d7d78, { metalness: 0.3 }), 60),
    trans: makePool(new THREE.CylinderGeometry(0.3, 0.3, 1, 10).translate(0, 0.5, 0), std(0x8c9590, { metalness: 0.3 }), 10),
    wire: makePool(unitBox, std(0xffffff, { roughness: 0.6 }), 700, { cast: false }),
    post: makePool(new THREE.CylinderGeometry(0.04, 0.04, 1, 6).translate(0, 0.5, 0), std(0xffffff, { metalness: 0.4, roughness: 0.5 }), 60),
    mirror: makePool(new THREE.CircleGeometry(0.5, 20), std(0xeef3f6, { metalness: 1, roughness: 0.08 }), 12),
    mirrorRim: makePool(new THREE.CylinderGeometry(0.55, 0.55, 0.08, 20).rotateX(Math.PI / 2), std(0xe8742a), 12),
    speed40: makePool(plane, faceMat(tex(speedTexture(40))), 12, { cast: false }),
    speed50: makePool(plane, faceMat(tex(speedTexture(50))), 12, { cast: false }),
    warnL: makePool(plane, faceMat(tex(warnTexture('left'))), 12, { cast: false }),
    warnR: makePool(plane, faceMat(tex(warnTexture('right'))), 12, { cast: false }),
    backC: makePool(plane, std(0x8a8d90, { map: tex(silhouetteTexture('circle')), alphaTest: 0.5 }), 24),
    backD: makePool(plane, std(0x8a8d90, { map: tex(silhouetteTexture('diamond')), alphaTest: 0.5 }), 24),
  };
  for (const p of Object.values(pools)) scene.add(p.mesh);

  const P = {};
  const Q = {};
  const yawOf = (p) => Math.atan2(p.hx, -p.hy);

  // ---- 青い案内標識(1枚ずつ。世界の座標に固定) ----
  const guideBack = std(0x8a8d90);
  const guides = plan.guides.map((gd) => {
    at(gd.m, P);
    const grp = new THREE.Group();
    const face = new THREE.Mesh(plane, std(0xffffff, { map: tex(guideTexture(gd.lines)), roughness: 0.5 }));
    face.scale.set(2.8, 1.4, 1);
    face.position.set(0, 3.9, 0);
    face.rotation.y = Math.PI; // 近づいてくるライダーの方を向く
    const back = new THREE.Mesh(unitBox, guideBack);
    back.scale.set(2.8, 1.4, 0.06);
    back.position.set(0, 3.9, 0.04);
    grp.add(face, back);
    for (const dx of [-1, 1]) {
      const post = new THREE.Mesh(unitBox, guideBack);
      post.scale.set(0.1, 4.6, 0.1);
      post.position.set(dx * 1.1, 2.3, 0.08);
      grp.add(post);
    }
    grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const off = gd.side * 7.6;
    grp.position.set(P.x - P.hy * off, P.z - 0.2, -(P.y + P.hx * off));
    grp.rotation.y = yawOf(P);
    grp.visible = false;
    scene.add(grp);
    return { m: gd.m, grp };
  });

  // ---- ゴールの表札(道をまたぐ木の門。世界の座標に固定) ----
  let goal = null;
  if (plan.goal) {
    at(plan.goal.m, P);
    const wood = std(0x6b4424, { roughness: 0.85 });
    const grp = new THREE.Group();
    const W = 13;
    const H = W * 480 / 1024;
    const Y = 6.0; // 板の中心の高さ(下の端は 3 m くらい)
    const face = new THREE.Mesh(plane, std(0xffffff, { map: tex(goalTexture(plan.goal.name)), roughness: 0.6 }));
    face.scale.set(W, H, 1);
    face.position.set(0, Y, -0.13);
    face.rotation.y = Math.PI; // 近づいてくるライダーの方を向く
    const board = new THREE.Mesh(unitBox, wood);
    board.scale.set(W, H, 0.24);
    board.position.set(0, Y, 0);
    const beam = new THREE.Mesh(unitBox, wood); // 上の笠木
    beam.scale.set(W + 2.4, 0.45, 0.6);
    beam.position.set(0, Y + H / 2 + 0.35, 0);
    grp.add(face, board, beam);
    for (const dx of [-1, 1]) {
      const post = new THREE.Mesh(unitBox, wood);
      post.scale.set(0.45, Y + H / 2 + 2.6, 0.45); // 地面の起伏に備えて 2 m 埋める
      post.position.set(dx * (W / 2 + 0.6), (Y + H / 2 + 0.6) / 2 - 1, 0);
      grp.add(post);
    }
    grp.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    const a = plan.goal.aheadM ?? 0; // 終わりの向きのまま先へ
    grp.position.set(P.x + P.hx * a, P.z - 0.3, -(P.y + P.hy * a));
    grp.rotation.y = yawOf(P);
    grp.visible = false;
    scene.add(grp);
    goal = { m: plan.goal.m, grp };
  }

  /** 丸・ひし形の標識1枚(柱つき)。face = 表のプール、back = 裏のプール。 */
  function pushSign(ox, oy, item, face, back, y, size) {
    at(item.m, P);
    const off = item.side * 5.9;
    const x = P.x - P.hy * off - ox;
    const z = -(P.y + P.hx * off - oy);
    const yaw = yawOf(P);
    pushInstance(pools.post, x + P.hx * 0.07, P.z, z - P.hy * 0.07, 1, y + size * 0.4, 1, 0, 0, 0xd5d7d8); // 柱は板の裏
    // 表はライダーの側(後ろ)へ、裏は前へ少しずらす
    pushInstance(face, x - P.hx * 0.02, P.z + y, z + P.hy * 0.02, size, size, 1, 0, yaw + Math.PI);
    pushInstance(back, x + P.hx * 0.025, P.z + y, z - P.hy * 0.025, size, size, 1, 0, yaw);
  }

  function update(m0, ox, oy) {
    const from = m0 - BEHIND_M;
    const to = m0 + AHEAD_M;
    // 電柱と電線
    const poles = plan.poles;
    for (let i = firstIndexFrom(poles, from); i < poles.length && poles[i].m < to; i++) {
      const pl = poles[i];
      const ends = poleEnds(pl, P);
      const yaw = yawOf(P);
      const [bx, by, bz] = ends.base;
      pushInstance(pools.pole, bx - ox, by, bz + oy, 1, POLE_H, 1, 0, 0);
      // 腕金(道に直角)と、低い所の通信線の金具
      pushInstance(pools.arm, bx - ox, by + ARM_Y, bz + oy, 1.9, 0.1, 0.1, 0, yaw);
      pushInstance(pools.arm, bx - ox, by + 7.1, bz + oy, 0.5, 0.08, 0.08, 0, yaw);
      if (pl.transformer) {
        const sx = bx - ox + -P.hy * pl.side * 0.45;
        const sz = bz + oy - P.hx * pl.side * 0.45;
        pushInstance(pools.trans, sx, by + 8.0, sz, 1, 1.1, 1);
      }
      if (!pl.link || i + 1 >= poles.length) continue;
      const nx = poleEnds(poles[i + 1], Q);
      const span = Math.hypot(nx.base[0] - bx, nx.base[2] - bz);
      for (const w of WIRES) {
        const a = ends.wire(w);
        const b = nx.wire(w);
        let prev = a;
        for (let k = 1; k <= WIRE_SEGS; k++) {
          const t = k / WIRE_SEGS;
          const cur = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - wireSagM(span, t), a[2] + (b[2] - a[2]) * t];
          const dx = cur[0] - prev[0];
          const dy = cur[1] - prev[1];
          const dz = cur[2] - prev[2];
          const h = Math.hypot(dx, dz);
          pushInstanceYawPitch(pools.wire, (prev[0] + cur[0]) / 2 - ox, (prev[1] + cur[1]) / 2, (prev[2] + cur[2]) / 2 + oy,
            w[2], w[2], Math.hypot(h, dy), Math.atan2(dx, dz), Math.atan2(-dy, h), w[3]);
          prev = cur;
        }
      }
    }
    // カーブミラー(カーブの外側。道の内側へ斜めに向ける)
    for (let i = firstIndexFrom(plan.mirrors, from); i < plan.mirrors.length && plan.mirrors[i].m < to; i++) {
      const mr = plan.mirrors[i];
      at(mr.m, P);
      const off = mr.side * 6;
      const x = P.x - P.hy * off - ox;
      const z = -(P.y + P.hx * off - oy);
      pushInstance(pools.post, x, P.z, z, 1.4, 2.7, 1.4, 0, 0, 0xe8742a);
      const yaw = yawOf(P) + Math.PI + mr.side * 0.6;
      pushInstance(pools.mirrorRim, x, P.z + 2.75, z, 1, 1, 1, 0, yaw);
      pushInstance(pools.mirror, x + Math.sin(yaw) * 0.05, P.z + 2.75, z + Math.cos(yaw) * 0.05, 1, 1, 1, 0, yaw);
    }
    for (let i = firstIndexFrom(plan.speeds, from); i < plan.speeds.length && plan.speeds[i].m < to; i++) {
      const sp = plan.speeds[i];
      pushSign(ox, oy, sp, sp.limit === 40 ? pools.speed40 : pools.speed50, pools.backC, 2.2, 0.6);
    }
    for (let i = firstIndexFrom(plan.warnings, from); i < plan.warnings.length && plan.warnings[i].m < to; i++) {
      const wn = plan.warnings[i];
      pushSign(ox, oy, wn, wn.dir === 'left' ? pools.warnL : pools.warnR, pools.backD, 2.3, 0.85);
    }
    for (const p of Object.values(pools)) {
      commitPool(p);
      p.mesh.position.set(ox, 0, -oy);
    }
    for (const g of guides) g.grp.visible = g.m > m0 - 60 && g.m < m0 + GUIDE_VIEW_M;
    if (goal) goal.grp.visible = goal.m < m0 + GOAL_VIEW_M; // 着いた後も見えたまま
  }

  /** 電柱の根もと(世界の座標。z は北 = 負)と、電線をかける点を返す。out には電柱の所の道の向きが入る。 */
  function poleEnds(pl, out) {
    at(pl.m, out);
    const off = pl.side * 6.4;
    // 道に直角の向き(道の側が正)
    const lx = out.hy * pl.side;
    const ly = -out.hx * pl.side;
    const base = [out.x - out.hy * off, out.z, -(out.y + out.hx * off)];
    return {
      base,
      wire: (w) => [base[0] + lx * w[0], base[1] + w[1], base[2] - ly * w[0]],
    };
  }

  return { update };
}
