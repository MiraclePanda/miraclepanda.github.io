// トンネルの筒の中の地面を描かない判定(realRoadScene.js の cutTunnels)に渡す、ライダーの近くの筒の選び方(純粋な計算)。
//
// 地面の画素ごとに筒の 20 m の切れ端を全部調べると、トンネルの近くでは 1 画素あたり 64 回の計算になり、
// 遅い GPU(N100)では fps が半分になっていた(?off=tunnel で 7 → 14 fps)。そこで切れ端をトンネルごとにまとめ、
// トンネルごとの箱(平面の範囲と路面の高さの範囲)を先に調べて、箱に入った画素だけがそのトンネルの切れ端を調べる。
// 地面のほとんどの画素は箱の外(山の上・遠くの平地)なので、箱の数回の比べだけで済む。

/**
 * @param {number[][]} pieces 切れ端 [x1, y1, x2, y2, z1, z2, トンネルの番号](区間の平面座標と路面の高さ)。同じトンネルの切れ端は続けて並ぶこと
 * @param {number} ox ライダーの平面座標 x
 * @param {number} oy ライダーの平面座標 y
 * @param {{radius:number, maxPieces:number, maxTubes:number, halfW:number, below:number, top:number}} o
 *   radius: これより遠い切れ端は使わない。halfW: 筒の半分の幅。below / top: 路面からどれだけ下・上までを筒の中とするか
 * @returns {{pieces:number[][], tubes:{minX:number, minY:number, maxX:number, maxY:number, minZ:number, maxZ:number, start:number, count:number}[]}}
 *   pieces はトンネルごとに続けて並べた切れ端、tubes はトンネルごとの箱と pieces の中の範囲(start から count 本)
 */
export function selectTunnelCut(pieces, ox, oy, { radius, maxPieces, maxTubes, halfW, below, top }) {
  const near = [];
  for (const pc of pieces) {
    const d = Math.hypot((pc[0] + pc[2]) / 2 - ox, (pc[1] + pc[3]) / 2 - oy);
    if (d < radius) near.push([d, pc]);
  }
  // 近い切れ端から数えて、使うトンネルと本数を決める(上限を超えたら遠い分を捨てる)
  near.sort((a, b) => a[0] - b[0]);
  const keepTubes = new Map(); // トンネルの番号 → 一番近い距離
  const kept = [];
  for (const [d, pc] of near) {
    if (kept.length >= maxPieces) break;
    if (!keepTubes.has(pc[6])) {
      if (keepTubes.size >= maxTubes) continue;
      keepTubes.set(pc[6], d);
    }
    kept.push(pc);
  }
  // トンネルごとに、元の並び(筒に沿った順)で続けて並べる
  const order = [...keepTubes.keys()];
  const outPieces = [];
  const tubes = [];
  for (const id of order) {
    const start = outPieces.length;
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const pc of pieces) {
      if (pc[6] !== id || !kept.includes(pc)) continue;
      outPieces.push(pc);
      box.minX = Math.min(box.minX, pc[0], pc[2]);
      box.maxX = Math.max(box.maxX, pc[0], pc[2]);
      box.minY = Math.min(box.minY, pc[1], pc[3]);
      box.maxY = Math.max(box.maxY, pc[1], pc[3]);
      box.minZ = Math.min(box.minZ, pc[4], pc[5]);
      box.maxZ = Math.max(box.maxZ, pc[4], pc[5]);
    }
    tubes.push({
      minX: box.minX - halfW, maxX: box.maxX + halfW, minY: box.minY - halfW, maxY: box.maxY + halfW,
      minZ: box.minZ - below, maxZ: box.maxZ + top, start, count: outPieces.length - start,
    });
  }
  return { pieces: outPieces, tubes };
}
