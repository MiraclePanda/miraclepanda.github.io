// 森の木のメッシュを区画ごとに分けて持つ。
//
// 木はライダーのまわり(最高で半径 900 m)に数万本あり、種類ごとに1つの InstancedMesh にまとめると、
// three.js はそのメッシュを丸ごと描くか描かないかしか選べない(まわり全部が範囲なので、いつも全部を描く)。
// そこで、区画(遠くの木は広め、近くの木は狭め)× 種類ごとに別の InstancedMesh にして、区画の木を包む球を持たせ、
// 画面の外・影の範囲の外の区画は three.js の視野の判定で描かないようにする。どの木をどこに置くかは呼び出し側
// (realRoadScene の placeTrees)のままで、見た目は1つにまとめていたときと同じ。
//
// 置き直しは数フレームに分けて CPU 側の配列へ入れ(begin → push …)、できあがったら commit で一度に GPU へ送る。
// それまでは前の木をそのまま描く(表と裏の2組のメッシュを持たなくてよい)。

import THREE from './three.js';

const _obj = new THREE.Object3D();
const _color = new THREE.Color();
const MIN_CAPACITY = 16;

/**
 * @param {THREE.Scene} scene
 * @param {{geo:THREE.BufferGeometry, mat:THREE.Material, cast:boolean, near?:boolean, max:number, reach:number}[]} kinds
 *   reach: 大きさ 1 の形の、原点から一番遠い点までの距離(区画を包む球の大きさに使う)。max: 1回の置き直しでの本数の上限。
 *   near: ライダーの近くだけにある作り込んだ形(影を落とす)。小さい区画に分けて、影の範囲にかかる分だけを影の段で描く
 */
export function createTreeChunks(scene, kinds) {
  const buckets = new Map(); // 数の鍵(種類と区画) → { kind, mat, col, n, 範囲, mesh }
  const counts = new Array(kinds.length).fill(0);
  let farM = 100;
  let nearM = 60;

  function bucketFor(k, ax, ay) {
    const size = kinds[k].near ? nearM : farM;
    const ci = Math.floor(ax / size) & 0xfff;
    const cj = Math.floor(ay / size) & 0xfff;
    const key = (k * 4096 + ci) * 4096 + cj;
    let b = buckets.get(key);
    if (!b) {
      b = { k, mat: new Float32Array(MIN_CAPACITY * 16), col: new Float32Array(MIN_CAPACITY * 3), n: 0, mesh: null };
      resetBounds(b);
      buckets.set(key, b);
    }
    return b;
  }

  function resetBounds(b) {
    b.minX = b.minY = b.minZ = Infinity;
    b.maxX = b.maxY = b.maxZ = -Infinity;
    b.reach = 0;
  }

  function grow(b) {
    const cap = (b.mat.length / 16) * 2;
    const mat = new Float32Array(cap * 16);
    mat.set(b.mat);
    const col = new Float32Array(cap * 3);
    col.set(b.col);
    b.mat = mat;
    b.col = col;
  }

  function removeMesh(b) {
    if (!b.mesh) return;
    scene.remove(b.mesh);
    b.mesh.dispose(); // 形と材質は種類ごとに共有なので捨てない(GPU のインスタンスの配列だけ)
    b.mesh = null;
  }

  return {
    /** 置き直しを始める(区画の大きさ: 遠くの木 far m、近くの木 near m)。前に入れた木は commit まで描かれたまま。 */
    begin(far, near) {
      farM = far;
      nearM = near;
      counts.fill(0);
      for (const b of buckets.values()) {
        b.n = 0;
        resetBounds(b);
      }
    },

    /**
     * 種類 k の木を1本置く。(ax, ay) は区画を決める区間の平面の座標、(px, py, pz) は commit の原点からの位置。
     * 拡大・回転・色は sceneKit.js の pushInstance と同じ。
     */
    push(k, ax, ay, px, py, pz, sx, sy, sz, rotX, rotY, colorHex) {
      if (counts[k] >= kinds[k].max) return;
      counts[k]++;
      const b = bucketFor(k, ax, ay);
      if (b.n * 16 >= b.mat.length) grow(b);
      _obj.position.set(px, py, pz);
      _obj.rotation.set(rotX, rotY, 0);
      _obj.scale.set(sx, sy, sz);
      _obj.updateMatrix();
      _obj.matrix.toArray(b.mat, b.n * 16);
      _color.setHex(colorHex ?? 0xffffff);
      b.col[b.n * 3] = _color.r;
      b.col[b.n * 3 + 1] = _color.g;
      b.col[b.n * 3 + 2] = _color.b;
      b.n++;
      if (px < b.minX) b.minX = px;
      if (px > b.maxX) b.maxX = px;
      if (py < b.minY) b.minY = py;
      if (py > b.maxY) b.maxY = py;
      if (pz < b.minZ) b.minZ = pz;
      if (pz > b.maxZ) b.maxZ = pz;
      const reach = kinds[k].reach * Math.max(sx, sy, sz);
      if (reach > b.reach) b.reach = reach;
    },

    /** 置き直した木を GPU へ送り、全部のメッシュを原点 (ox, oy)(区間の平面の座標)に置く。 */
    commit(ox, oy) {
      for (const [key, b] of buckets) {
        if (b.n === 0) {
          // この置き直しで木の無くなった区画は、メッシュごと捨てる(遠ざかった区画がたまらないように)
          removeMesh(b);
          buckets.delete(key);
          continue;
        }
        const kind = kinds[b.k];
        if (!b.mesh || b.mesh.instanceMatrix.count < b.n) {
          removeMesh(b);
          let cap = MIN_CAPACITY;
          while (cap < b.n) cap *= 2;
          const mesh = new THREE.InstancedMesh(kind.geo, kind.mat, cap);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
          mesh.castShadow = kind.cast;
          mesh.receiveShadow = true;
          mesh.frustumCulled = true;
          mesh.boundingSphere = new THREE.Sphere();
          scene.add(mesh);
          b.mesh = mesh;
        }
        const mesh = b.mesh;
        mesh.instanceMatrix.array.set(b.mat.subarray(0, b.n * 16));
        mesh.instanceColor.array.set(b.col.subarray(0, b.n * 3));
        // GPU へ送るのは使った分だけ
        for (const [attr, size] of [[mesh.instanceMatrix, 16], [mesh.instanceColor, 3]]) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, b.n * size);
          attr.needsUpdate = true;
        }
        mesh.count = b.n;
        // 区画の木を全部包む球(メッシュの原点からの座標)。three.js はこれで画面・影の範囲の外の区画を飛ばす
        const sp = mesh.boundingSphere;
        sp.center.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
        sp.radius = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) / 2 + b.reach;
        mesh.position.set(ox, 0, -oy);
      }
    },

    /** いま描いている木のメッシュの数(確認用)。 */
    meshCount() {
      let n = 0;
      for (const b of buckets.values()) if (b.mesh) n++;
      return n;
    },
  };
}
