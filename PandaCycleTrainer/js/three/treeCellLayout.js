// 木の区画分け(treeCells.js)の純粋な計算。three.js を使わないので Node でテストできる。

/** (x, z) の木が入る区画の鍵(cellM 四方)。 */
export function treeCellKey(x, z, cellM) {
  const i = Math.floor(x / cellM);
  const j = Math.floor(z / cellM);
  return `${i},${j}`;
}

/** 区画({minX, maxX, minZ, maxZ})の、点 (x, z) にいちばん近い点までの距離の2乗。 */
export function cellDistance2(c, x, z) {
  const dx = x < c.minX ? c.minX - x : x > c.maxX ? x - c.maxX : 0;
  const dz = z < c.minZ ? c.minZ - z : z > c.maxZ ? z - c.maxZ : 0;
  return dx * dx + dz * dz;
}

/**
 * どの区画を作り込んだ形で描くか。区画のいちばん近い点が (x, z) から r の内側なら候補で、近い区画から
 * 木の本数(count)の合計が budget を超えない分まで選ぶ(いちばん近い区画は本数によらず選ぶ)。
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, count:number}[]} cells
 * @returns {boolean[]} cells と同じ並び
 */
export function chooseNearCells(cells, x, z, r, budget) {
  const r2 = r * r;
  const cand = [];
  for (let i = 0; i < cells.length; i++) {
    const d2 = cellDistance2(cells[i], x, z);
    if (d2 < r2) cand.push([d2, i]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  const out = new Array(cells.length).fill(false);
  let total = 0;
  for (const [, i] of cand) {
    const n = cells[i].count;
    if (total > 0 && total + n > budget) break;
    out[i] = true;
    total += n;
  }
  return out;
}
