// 名所の形(景色データの landmarks。設定は tools/segments/regions/<地方>.json の区間)。
//   castle     熱海城: 石垣の上に白壁と黒い屋根の天守(5層に見える)
//   lighthouse 門脇灯台(城ヶ崎): 白い塔と展望台
//   palms      熱海サンビーチのヤシ並木: 道の海側に並べる(fromM〜toM は元の向きの区間の距離)
//   pines      三保の松原: 木の配置(realRoadScene の placeTrees)が、この円の中を松の林にする
// どれも見た目だけ(物理・トレーナーには関係しない)。

import THREE from './three.js';
import { heightAt } from './sceneryData.js';

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });

/** 四角錐台(石垣・屋根)。下の一辺 w0、上の一辺 w1、高さ h。底面が y=0。 */
function frustum(w0, w1, h) {
  const g = new THREE.CylinderGeometry(w1 / Math.SQRT2, w0 / Math.SQRT2, h, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, h / 2, 0);
  return g;
}

function castle() {
  const grp = new THREE.Group();
  const stone = std(0x8a8478, { roughness: 0.95 });
  const wall = std(0xf2efe6);
  const roof = std(0x3c4148, { roughness: 0.6 });
  const add = (geo, mat, y) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.castShadow = m.receiveShadow = true;
    grp.add(m);
  };
  add(frustum(26, 21, 8), stone, -2); // 石垣(少し地面に埋める)
  let y = 6;
  for (const [w, h] of [[19, 5], [16, 4.2], [13, 4], [10, 3.6], [7.5, 3.4]]) {
    add(new THREE.BoxGeometry(w, h, w * 0.8).translate(0, h / 2, 0), wall, y);
    y += h;
    add(frustum(w + 4.5, w * 0.55, 1.6), roof, y - 0.4); // 反りの代わりに大きく張り出した屋根
    y += 0.8;
  }
  add(frustum(6, 0.4, 2.6), roof, y);
  return grp;
}

function lighthouse() {
  const grp = new THREE.Group();
  const white = std(0xf5f5f2);
  const add = (geo, mat, y) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.castShadow = m.receiveShadow = true;
    grp.add(m);
  };
  add(new THREE.CylinderGeometry(2.2, 3.2, 20, 16).translate(0, 10, 0), white, 0);
  add(new THREE.CylinderGeometry(4.2, 4.2, 0.6, 16), std(0x9aa0a6), 20.3); // 展望台
  add(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 12).translate(0, 1.2, 0),
    std(0xcfe6ef, { metalness: 0.3, roughness: 0.2, emissive: 0x332a10 }), 20.6);
  add(new THREE.ConeGeometry(2, 1.6, 12).translate(0, 0.8, 0), std(0xb23b2e), 23);
  return grp;
}

/** ヤシ並木のメッシュ(幹と葉、インスタンス)。 */
function palms(sc, lm) {
  const R = sc.route;
  const spots = [];
  for (let m = lm.fromM; m <= lm.toM; m += 14) {
    const k = Math.min(Math.round(m / sc.step), R.n - 2);
    const hx = R.x[k + 1] - R.x[k];
    const hy = R.y[k + 1] - R.y[k];
    const len = Math.hypot(hx, hy) || 1;
    const lx = -hy / len;
    const ly = hx / len;
    // 海側(道から 80 m 先が低い側。道の脇はならしてあるので少し離れた所で比べる)の歩道に植える
    const side = heightAt(sc, R.x[k] + lx * 80, R.y[k] + ly * 80) < heightAt(sc, R.x[k] - lx * 80, R.y[k] - ly * 80) ? 1 : -1;
    spots.push([R.x[k] + lx * side * 7.5, R.y[k] + ly * side * 7.5, R.z[k]]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 1, 6).translate(0, 0.5, 0);
  const frondGeo = new THREE.ConeGeometry(0.7, 4.2, 4).rotateX(Math.PI / 2).translate(0, 0, 2.1).scale(1, 0.25, 1);
  const trunks = new THREE.InstancedMesh(trunkGeo, std(0x8a7558, { roughness: 1 }), spots.length);
  const fronds = new THREE.InstancedMesh(frondGeo, std(0x4f7d34, { side: THREE.DoubleSide }), spots.length * 8);
  const o = new THREE.Object3D();
  spots.forEach(([x, y, z], i) => {
    const hgt = 8 + ((i * 37) % 5);
    o.position.set(x, z, -y);
    o.rotation.set(0, 0, 0);
    o.scale.set(1, hgt, 1);
    o.updateMatrix();
    trunks.setMatrixAt(i, o.matrix);
    for (let f = 0; f < 8; f++) {
      o.position.set(x, z + hgt, -y);
      o.rotation.set(0.45, (f / 8) * Math.PI * 2 + i, 0, 'YXZ');
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      fronds.setMatrixAt(i * 8 + f, o.matrix);
    }
  });
  for (const m of [trunks, fronds]) {
    m.castShadow = m.receiveShadow = true;
  }
  const grp = new THREE.Group();
  grp.add(trunks, fronds);
  return grp;
}

/**
 * @param {object} sc 景色データ
 * @returns {{group: THREE.Group, pines: {x:number, y:number, r:number}[]}}
 */
export function buildLandmarks(sc) {
  const group = new THREE.Group();
  const pines = [];
  for (const lm of sc.landmarks) {
    if (lm.kind === 'pines') {
      pines.push({ x: lm.x, y: lm.y, r: lm.radiusM ?? 800 });
      continue;
    }
    if (lm.kind === 'palms') {
      group.add(palms(sc, lm));
      continue;
    }
    const make = { castle, lighthouse }[lm.kind];
    if (!make) continue;
    const obj = make();
    // 足もとのいちばん低い所に建てる(斜面でも浮かないように)
    let base = Infinity;
    for (const [dx, dy] of [[0, 0], [8, 8], [-8, 8], [8, -8], [-8, -8]]) base = Math.min(base, heightAt(sc, lm.x + dx, lm.y + dy));
    obj.position.set(lm.x, Math.max(base, 0), -lm.y);
    group.add(obj);
  }
  return { group, pines };
}
