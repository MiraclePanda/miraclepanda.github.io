import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actorLateralM, clearZones, inClearZone, variantOf,
  PAGODA_PLINTH_HALF_M, PAGODA_MIN_GAP_M, TORII_PILLAR_OUTSET_M,
} from '../../PandaCycleTrainer/js/three/roadsideLayout.js';

// 沿道のハプニング・名所を道路の断面へ置く純粋ロジック(js/three/roadsideLayout.js)。
// 3D の模型(roadsideActors.js)はヘッドレスでは確かめられないので、横位置とよけ範囲だけをここで固定する。

const HALF = 4;

test('side 0 は道路中心からの距離、side ±1 は車道の端からの距離として横位置を返す', () => {
  assert.equal(actorLateralM({ kind: 'cat', side: 0, lateralM: -2.5 }, HALF), -2.5);
  assert.equal(actorLateralM({ kind: 'panda', side: 0, lateralM: 1.6 }, HALF), 1.6);
  assert.equal(actorLateralM({ kind: 'cheer', side: -1, lateralM: 0.8 }, HALF), -4.8);
  assert.equal(actorLateralM({ kind: 'deer', side: 1, lateralM: 0.6 }, HALF), 4.6);
  // 沿道の物は車道へはみ出さない(負の lateralM は車道の端に丸める)
  assert.equal(actorLateralM({ kind: 'aid', side: -1, lateralM: -3 }, HALF), -4);
});

test('五重塔は基壇が車道にかからないよう中心を外へ押し出す', () => {
  const near = actorLateralM({ kind: 'pagoda', side: 1, lateralM: 2 }, HALF);
  assert.equal(near, HALF + PAGODA_MIN_GAP_M + PAGODA_PLINTH_HALF_M);
  assert.equal(actorLateralM({ kind: 'pagoda', side: -1, lateralM: 16 }, HALF), -(HALF + 16));
});

test('clearZones: 大鳥居は左右の柱、五重塔は基壇、テント・応援団は外向きの奥行きをよける', () => {
  const zones = clearZones([
    { kind: 'torii', distanceM: 1000, side: 0, lateralM: 0 },
    { kind: 'pagoda', distanceM: 2000, side: 1, lateralM: 18 },
    { kind: 'aid', distanceM: 3000, side: -1, lateralM: 0.8 },
    { kind: 'cat', distanceM: 4000, side: 0, lateralM: 0 },
  ], HALF);
  assert.equal(zones.length, 4); // 柱2 + 基壇1 + テント1(猫はよけない)
  const pillar = HALF + TORII_PILLAR_OUTSET_M;
  assert.ok(inClearZone(zones, 1000, pillar, 0.5, 0.5), '右の柱');
  assert.ok(inClearZone(zones, 1000, -pillar, 0.5, 0.5), '左の柱');
  assert.ok(!inClearZone(zones, 1000, 0, 0.5, 0.5), '鳥居の下の道路はふさがない');
  assert.ok(inClearZone(zones, 2003, HALF + 18 + 4, 1, 1), '基壇の上');
  assert.ok(!inClearZone(zones, 2020, HALF + 18, 1, 1), '基壇から離れた所');
  assert.ok(inClearZone(zones, 3000, -(HALF + 2), 0.5, 0.5), 'テントの下');
  assert.ok(!inClearZone(zones, 3000, HALF + 2, 0.5, 0.5), '反対側の沿道');
  assert.ok(!inClearZone(zones, 4000, 0, 0.5, 0.5), '猫はよけ範囲を作らない');
});

test('clearZones は actors が無い・壊れていても空を返す', () => {
  assert.deepEqual(clearZones(undefined, HALF), []);
  assert.deepEqual(clearZones([null, { kind: 'torii' }], HALF), []);
});

test('variantOf は id ごとに決定的で、範囲内の番号を返す', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const v = variantOf(`hp-${i}`, 3);
    assert.equal(v, variantOf(`hp-${i}`, 3));
    assert.ok(v >= 0 && v < 3);
    seen.add(v);
  }
  assert.equal(seen.size, 3, '3色とも出る');
});
