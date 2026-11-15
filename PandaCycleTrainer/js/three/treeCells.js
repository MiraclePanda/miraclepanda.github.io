// 実在の街(京都・奈良・河口湖)の木を、地面の区画ごとに分けて持つ(レビュー R1・R2)。
//
// 以前は街じゅうの木(1万本以上)を種類ごとに1つの InstancedMesh にまとめていたので、three.js はそれを丸ごと
// 描くか描かないかしか選べず、画面の外や真後ろの木まで毎フレーム描いていた(河口湖では三角形の 6 割以上が木)。
// また、ライダーが 25m 進むたびに近く(作り込んだ形)/遠く(軽い形)の木を分け直し、最大 2.3MB を GPU へ送っていた。
//
// ここでは木を区画 × 種類ごとの InstancedMesh にし、区画の木を包む球で画面の外の区画を three.js の視野の判定で
// 飛ばす。遠くは大きい区画(TREE_BLOCK_M 四方。描画命令を増やしすぎない)の軽い形、ライダーの近くにかかる
// 大きい区画だけを小さい区画(TREE_CELL_M 四方)の作り込んだ形/軽い形で描く。どれも最初に一度だけ作って GPU へ
// 送り、走行中は距離でどれを見せるかを切り替えるだけにする(分け直し・送り直しをしない)。
// 作り込んだ形にする範囲は「区画のいちばん近い点がライダーから treeNearR の内側」なので、treeNearR の内側の木は
// 必ず作り込んだ形になる(以前より細かくなることはあっても、粗くなることはない)。
// 区画分けと近さの判定は純粋な関数(treeCellLayout.js)で、Node でテストできる。

import THREE from './three.js';
import { treeCellKey, chooseNearCells } from './treeCellLayout.js';

const _obj = new THREE.Object3D();
const _color = new THREE.Color();

/** 作り込んだ形にするかを決める小さい区画の大きさ(m)。 */
export const TREE_CELL_M = 80;
/** 遠くの木をまとめて描く大きい区画の大きさ(m。描画命令の数を抑える)。TREE_CELL_M の整数倍。 */
export const TREE_BLOCK_M = 240;

/**
 * @param {THREE.Object3D} parent 木のメッシュを入れる親(実在の街の world)
 * @param {Record<string, {near: THREE.BufferGeometry, far: THREE.BufferGeometry, material: THREE.Material}>} kinds
 */
export function createTreeCells(parent, kinds, cellM = TREE_CELL_M, blockM = TREE_BLOCK_M) {
  const cells = new Map(); // 小さい区画: key → { minX, maxX, minZ, maxZ, count, items: {kind: {mat, col}}, near, far }
  let sealed = false;
  let list = [];
  let blocks = []; // 大きい区画: { far: メッシュ[], cells: 小さい区画の番号[], open: 小さい区画で描いているか }

  function makeMeshes(kind, mat, col, lod, tag) {
    const def = kinds[kind];
    const mesh = new THREE.InstancedMesh(def[lod], def.material, mat.length / 16);
    mesh.instanceMatrix.array.set(mat);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(col), 3);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // 区画の木を包む球で、画面の外の区画を飛ばす(木は動かないので一度だけ計算すればよい)
    mesh.computeBoundingSphere();
    mesh.frustumCulled = true;
    mesh.visible = false;
    // 木は動かない(数千のメッシュの行列を毎フレーム計算し直さない)
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `trees-${kind}-${tag}`;
    parent.add(mesh);
    return mesh;
  }

  const show = (meshes, on) => {
    for (const m of meshes) m.visible = on;
  };

  return {
    /**
     * 種類 kind の木(の部品)を1つ置く。(x, y, z) は世界の座標、区画は (x, z) で決める。
     * 幹と樹冠は同じ根元の (x, z) で置くので、同じ区画に入る。countTree は木の本数として数える部品(幹)。
     */
    push(kind, x, y, z, sx, sy, sz, rotX, rotY, colorHex, countTree = false) {
      if (sealed) return;
      const key = treeCellKey(x, z, cellM);
      let c = cells.get(key);
      if (!c) {
        c = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, count: 0, items: {}, meshes: [] };
        cells.set(key, c);
      }
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (z < c.minZ) c.minZ = z;
      if (z > c.maxZ) c.maxZ = z;
      if (countTree) c.count++;
      const it = (c.items[kind] ??= { mat: [], col: [] });
      _obj.position.set(x, y, z);
      _obj.rotation.set(rotX, rotY, 0);
      _obj.scale.set(sx, sy, sz);
      _obj.updateMatrix();
      const base = it.mat.length;
      it.mat.length += 16;
      _obj.matrix.toArray(it.mat, base);
      _color.setHex(colorHex ?? 0xffffff);
      it.col.push(_color.r, _color.g, _color.b);
    },

    /**
     * 置き終えた: 小さい区画ごとの作り込んだ形・軽い形と、大きい区画ごとの軽い形のメッシュを作って GPU へ送る
     * (この1回だけ)。ライダーから遠い大きい区画は1つのメッシュ(種類ごと)で描き、近くにかかる大きい区画だけ
     * 小さい区画に分けて描く。
     */
    seal() {
      sealed = true;
      list = [...cells.values()];
      const byBlock = new Map();
      list.forEach((c, i) => {
        c.near = [];
        c.far = [];
        for (const [kind, it] of Object.entries(c.items)) {
          c.near.push(makeMeshes(kind, it.mat, it.col, 'near', 'near'));
          c.far.push(makeMeshes(kind, it.mat, it.col, 'far', 'far'));
        }
        const bk = treeCellKey(c.minX, c.minZ, blockM);
        let b = byBlock.get(bk);
        if (!b) byBlock.set(bk, (b = { cells: [], items: {}, far: [], open: true }));
        b.cells.push(i);
        for (const [kind, it] of Object.entries(c.items)) {
          const bi = (b.items[kind] ??= { mat: [], col: [] });
          for (const v of it.mat) bi.mat.push(v);
          for (const v of it.col) bi.col.push(v);
        }
        c.items = null; // 控えの配列は要らない(メッシュが持つ)
        c.state = null;
      });
      blocks = [...byBlock.values()];
      for (const b of blocks) {
        for (const [kind, it] of Object.entries(b.items)) b.far.push(makeMeshes(kind, it.mat, it.col, 'far', 'block'));
        b.items = null;
        b.open = null;
      }
    },

    /**
     * ライダー(x, z)から treeNearR(r)の内側にかかる小さい区画を作り込んだ形に、それ以外を軽い形にする。
     * 作り込んだ形の木は近い区画から budget 本まで。表示の切り替えだけで、GPU への送り直しはない。
     * @returns {number} 作り込んだ形で描く木の本数
     */
    update(x, z, r, budget) {
      const near = chooseNearCells(list, x, z, r, budget);
      let trees = 0;
      for (const b of blocks) {
        // 大きい区画の中に作り込んだ形の小さい区画があれば、その大きい区画は小さい区画ごとに描く
        const open = b.cells.some((i) => near[i]);
        if (open !== b.open) {
          b.open = open;
          show(b.far, !open);
        }
        for (const i of b.cells) {
          const c = list[i];
          const state = open ? (near[i] ? 'near' : 'far') : 'block';
          if (near[i]) trees += c.count;
          if (state === c.state) continue;
          c.state = state;
          show(c.near, state === 'near');
          show(c.far, state === 'far');
        }
      }
      return trees;
    },

    /** 区画の数と、木のメッシュの数(確認用)。 */
    stats() {
      let meshes = 0;
      for (const c of list) meshes += c.near.length + c.far.length;
      for (const b of blocks) meshes += b.far.length;
      return { cells: list.length, blocks: blocks.length, meshes };
    },

    dispose() {
      for (const ms of [...list.flatMap((c) => [c.near, c.far]), ...blocks.map((b) => b.far)]) {
        for (const m of ms) {
          parent.remove(m);
          m.dispose(); // 形と材質は種類ごとに共有(disposeScene がシーンをたどって捨てる)
        }
      }
      list = [];
      blocks = [];
      cells.clear();
    },
  };
}
