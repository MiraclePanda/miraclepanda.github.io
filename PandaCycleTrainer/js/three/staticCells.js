// 動かない物(上野不忍池の木・建物・街灯など)のプールを、地面の区画ごとのメッシュに分ける(レビュー R3)。
//
// 池のまわりの物は初めに1度だけ置く。以前は種類ごとに1つの InstancedMesh で、池全体の分を毎フレーム描き、
// 影の範囲(ボートのまわり 180m 四方)の外の木・ビルまで影の描画に入っていた。区画ごとのメッシュに
// 区画を包む球を持たせると、three.js が画面の外・影の範囲の外の区画を飛ばす(見た目は変わらない)。
// 木(far を渡したプール)は区画ごとに遠くの形も作っておき、ボートから treeNearR より遠い区画は遠くの形で描く
// (実在の街・湖畔などと同じ決め方)。切り替えは表示だけで、GPU への送り直しはない。

import THREE from './three.js';
import { treeCellKey, cellDistance2 } from './treeCellLayout.js';

function cellMesh(parent, pool, geometry, idx, tag) {
  const src = pool.mesh;
  const n = idx.length;
  let geo = geometry;
  // WebGPU の外壁の窓(facadeScale。sceneKit の makePool)はジオメトリの属性なので、区画ごとに写す
  if (pool.facadeScale) {
    geo = geometry.clone();
    const fs = new Float32Array(n * 3);
    idx.forEach((i, k) => fs.set(pool.facadeScale.array.subarray(i * 3, i * 3 + 3), k * 3));
    geo.setAttribute('facadeScale', new THREE.InstancedBufferAttribute(fs, 3));
  }
  const mesh = new THREE.InstancedMesh(geo, src.material, n);
  const m = mesh.instanceMatrix.array;
  const c = new Float32Array(n * 3);
  idx.forEach((i, k) => {
    m.set(src.instanceMatrix.array.subarray(i * 16, i * 16 + 16), k * 16);
    c.set(src.instanceColor.array.subarray(i * 3, i * 3 + 3), k * 3);
  });
  mesh.instanceColor = new THREE.InstancedBufferAttribute(c, 3);
  mesh.castShadow = src.castShadow;
  mesh.receiveShadow = src.receiveShadow;
  mesh.computeBoundingSphere();
  mesh.frustumCulled = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.name = `${src.name || 'static'}-${tag}`;
  parent.add(mesh);
  return mesh;
}

/**
 * pools のうち名前を挙げたものを区画ごとのメッシュに分け、元の1つのメッシュは外す。
 * @param {THREE.Object3D} parent
 * @param {Record<string, {mesh: THREE.InstancedMesh, facadeScale?: THREE.InstancedBufferAttribute}>} pools commitPool 済みのプール
 * @param {Record<string, {cellM: number, far?: THREE.BufferGeometry}>} spec 分けるプールと区画の大きさ・遠くの形
 */
export function splitStaticPools(parent, pools, spec) {
  const lodCells = []; // { minX, maxX, minZ, maxZ, near: mesh, far: mesh, isNear }
  let meshes = 0;
  for (const [name, { cellM, far }] of Object.entries(spec)) {
    const pool = pools[name];
    // 置いた数(commitPool の後は pool.n が 0 に戻るので、メッシュの count を見る)
    const count = pool?.mesh?.count ?? 0;
    if (count === 0) continue;
    const src = pool.mesh;
    src.name ||= name;
    const groups = new Map();
    const a = src.instanceMatrix.array;
    for (let i = 0; i < count; i++) {
      const x = a[i * 16 + 12];
      const z = a[i * 16 + 14];
      const key = treeCellKey(x, z, cellM);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { idx: [], minX: x, maxX: x, minZ: z, maxZ: z }));
      g.idx.push(i);
      g.minX = Math.min(g.minX, x);
      g.maxX = Math.max(g.maxX, x);
      g.minZ = Math.min(g.minZ, z);
      g.maxZ = Math.max(g.maxZ, z);
    }
    for (const g of groups.values()) {
      const near = cellMesh(parent, pool, src.geometry, g.idx, 'near');
      meshes++;
      if (far) {
        const farMesh = cellMesh(parent, pool, far, g.idx, 'far');
        farMesh.visible = false;
        meshes++;
        lodCells.push({ minX: g.minX, maxX: g.maxX, minZ: g.minZ, maxZ: g.maxZ, near, far: farMesh, isNear: true });
      }
    }
    src.parent?.remove(src);
    src.dispose(); // インスタンスの配列だけ捨てる(形と材質は区画のメッシュが使い続ける)
    pool.mesh = null;
  }
  return {
    /** ボート(x, z)から r の内側にかかる区画は近くの形、それより遠い区画は遠くの形にする。 */
    update(x, z, r) {
      const r2 = r * r;
      for (const c of lodCells) {
        const on = cellDistance2(c, x, z) < r2;
        if (on === c.isNear) continue;
        c.isNear = on;
        c.near.visible = on;
        c.far.visible = !on;
      }
    },
    meshCount: () => meshes,
  };
}
