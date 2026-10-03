import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../PandaCycleTrainer/js/physics/physicsEngine.js';
import { PhysicsConstants } from '../../PandaCycleTrainer/js/physics/physicsConstants.js';
import { CourseEngine } from '../../PandaCycleTrainer/js/physics/courseEngine.js';
import { getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { createVirtualRider, stepVirtualRider } from '../../PandaCycleTrainer/js/physics/virtualRider.js';
import { PACK, createPack, isDrafting, laneTarget, stepLane, stepPack } from '../../PandaCycleTrainer/js/physics/packRiders.js';

const flat = () => 0;
const me = (distanceM, laneOffsetM = 0, speedMps = 8) => ({ distanceM, laneOffsetM, speedMps });

test('drafting constants live in PhysicsConstants', () => {
  assert.equal(PhysicsConstants.DRAFT_MIN_GAP_M, 0.5);
  assert.equal(PhysicsConstants.DRAFT_MAX_GAP_M, 6.0);
  assert.equal(PhysicsConstants.DRAFT_MAX_LATERAL_M, 1.0);
  assert.equal(PhysicsConstants.DRAFT_CDA_FACTOR, 0.66);
});

test('isDrafting: gap boundaries 0.49 off / 0.5 on / 6.0 on / 6.01 off', () => {
  const f = me(0);
  assert.equal(isDrafting(f, [me(0.49)]), false);
  assert.equal(isDrafting(f, [me(0.5)]), true);
  assert.equal(isDrafting(f, [me(3)]), true);
  assert.equal(isDrafting(f, [me(6.0)]), true);
  assert.equal(isDrafting(f, [me(6.01)]), false);
  assert.equal(isDrafting(f, [me(-2)]), false, 'a rider behind gives no draft');
});

test('isDrafting: lateral boundaries 0.99 on / 1.0 off (either side)', () => {
  const f = me(0, 0.2);
  assert.equal(isDrafting(f, [me(3, 1.19)]), true); // 0.99
  assert.equal(isDrafting(f, [me(3, -0.79)]), true); // 0.99
  assert.equal(isDrafting(f, [me(3, 1.2)]), false); // 1.0
  assert.equal(isDrafting({ distanceM: 0, laneOffsetM: 0 }, [{ distanceM: 3, laneOffsetM: 0.99 }]), true);
  assert.equal(isDrafting({ distanceM: 0, laneOffsetM: 0 }, [{ distanceM: 3, laneOffsetM: 1.0 }]), false);
  assert.equal(isDrafting({ distanceM: 0, laneOffsetM: 0 }, [{ distanceM: 3, laneOffsetM: -1.0 }]), false);
});

test('isDrafting: any one leader suffices; empty/self/invalid inputs are false', () => {
  const f = me(100);
  assert.equal(isDrafting(f, [me(150), me(90), me(103, 0.5)]), true);
  assert.equal(isDrafting(f, []), false);
  assert.equal(isDrafting(f, [f]), false);
  assert.equal(isDrafting(f, null), false);
  // laneOffsetM 省略は 0 扱い
  assert.equal(isDrafting({ distanceM: 0 }, [{ distanceM: 2 }]), true);
});

function steadyEngine(draftFactor) {
  const pe = new PhysicsEngine({ riderWeightKg: 70, bikeWeightKg: 9, courseEngine: { gradeAtKm: flat } });
  if (draftFactor !== undefined) pe.setDraftFactor(draftFactor);
  pe.setCurrentPower(250);
  for (let i = 0; i < 60 * 600; i++) pe.step(1 / 60);
  return pe;
}

test('PhysicsEngine.setDraftFactor(0.66) raises the flat 250W steady speed and lowers the ERG target', () => {
  const solo = steadyEngine();
  const drafted = steadyEngine(0.66);
  const soloKmh = solo.speedMps * 3.6;
  const draftKmh = drafted.speedMps * 3.6;
  assert.ok(soloKmh > 30 && soloKmh < 45, `solo ${soloKmh}`);
  assert.ok(draftKmh > soloKmh + 3, `drafted ${draftKmh} vs solo ${soloKmh}`);
  // 既定値 1.0 を明示しても未使用時と完全に同じ
  assert.deepEqual(steadyEngine(1).step(0.1), steadyEngine().step(0.1));
  // 不正値は 1.0 扱い
  for (const bad of [NaN, Infinity, 0, -1, undefined]) {
    const pe = new PhysicsEngine({ riderWeightKg: 70, bikeWeightKg: 9, courseEngine: { gradeAtKm: flat } });
    pe.setDraftFactor(bad);
    assert.equal(pe.draftFactor, 1);
  }
  // 同じ速度で比べると ERG 目標W はドラフティング中の方が低い(fAir 経由)
  const a = new PhysicsEngine({ riderWeightKg: 70, bikeWeightKg: 9, courseEngine: { gradeAtKm: flat } });
  const b = new PhysicsEngine({ riderWeightKg: 70, bikeWeightKg: 9, courseEngine: { gradeAtKm: flat } });
  b.setDraftFactor(0.66);
  a.speedMps = b.speedMps = 10;
  a.step(0.1);
  b.step(0.1);
  assert.ok(b.computeErgTargetWatts() < a.computeErgTargetWatts());
});

test('stepVirtualRider with draftFactor 0.66 reaches a higher flat 250W speed', () => {
  const solo = createVirtualRider({ id: 's', kind: 'pack', powerModel: () => 250, massKg: 79 });
  const drafted = createVirtualRider({ id: 'd', kind: 'pack', powerModel: () => 250, massKg: 79 });
  for (let i = 0; i < 2400; i++) {
    stepVirtualRider(solo, 0.25, { gradeAtKm: flat });
    stepVirtualRider(drafted, 0.25, { gradeAtKm: flat, draftFactor: PhysicsConstants.DRAFT_CDA_FACTOR });
  }
  assert.ok(drafted.speedMps * 3.6 > solo.speedMps * 3.6 + 3, `${drafted.speedMps * 3.6} vs ${solo.speedMps * 3.6}`);
});

test('laneTarget: shifts 0.9m right of a slower rider just ahead, otherwise returns to lane 0', () => {
  const self = me(100, 0, 10);
  assert.equal(laneTarget(self, [me(102, 0, 8)]), 0.9);
  assert.equal(laneTarget(self, [me(103.5, 0.3, 8)]), 0.3 + 0.9); // 3.5m ちょうどは対象
  assert.equal(laneTarget(self, [me(103.6, 0, 8)]), 0, 'beyond 3.5m: no shift');
  assert.equal(laneTarget(self, [me(102, 0.8, 8)]), 0, 'lateral 0.8m: not blocking');
  assert.equal(laneTarget(self, [me(102, 0, 10)]), 0, 'not slower: no shift (follow/draft instead)');
  assert.equal(laneTarget(self, [me(98, 0, 8)]), 0, 'behind, while in own lane: no shift');
  assert.equal(laneTarget(self, []), 0);
  // 複数いれば最も右
  assert.equal(laneTarget(self, [me(102, 0, 8), me(101, 0.5, 8)]), 0.5 + 0.9);
  // ずらした後(横ずれ ≥0.8)も、抜いた相手が十分後ろへ下がるまで目標を保つ
  const passing = me(100, 0.85, 10);
  assert.equal(laneTarget(passing, [me(101, 0, 8)]), 0.9);
  assert.equal(laneTarget(passing, [me(99, 0, 8)]), 0.9, 'alongside: keep the passing lane');
  assert.equal(laneTarget(passing, [me(97.9, 0, 8)]), 0, 'cleared by 2m: return to lane 0');
});

test('stepLane: first-order lag with a 0.7s time constant', () => {
  assert.ok(Math.abs(stepLane(0, 1, 0.7) - (1 - Math.exp(-1))) < 1e-12);
  let x = 0;
  for (let i = 0; i < 60 * 5; i++) x = stepLane(x, 0.9, 1 / 60);
  assert.ok(Math.abs(x - 0.9) < 0.01, `converges: ${x}`);
  const half = stepLane(0, 0.9, 0.1);
  assert.ok(half > 0 && half < 0.9, 'moves monotonically towards the target without overshoot');
  assert.equal(stepLane(0.4, 0.9, 0), 0.4);
  assert.equal(stepLane(0.4, 0.9, NaN), 0.4);
  assert.equal(stepLane(0.4, NaN, 0.1), 0.4);
});

test('createPack: 5 riders with the spec base powers / start gaps', () => {
  const pack = createPack({ startDistanceM: 1000 });
  assert.equal(pack.length, 5);
  pack.forEach((r, i) => {
    assert.equal(r.kind, 'pack');
    assert.equal(r.distanceM, 1000 + PACK.START_GAPS_M[i]);
    assert.equal(r.name, PACK.NAMES[i]);
    assert.match(r.color, /^#[0-9a-f]{6}$/i);
    assert.equal(r.laneOffsetM, 0);
    assert.equal(r.drafting, false);
  });
  assert.deepEqual(PACK.BASE_POWERS_W, [175, 190, 215, 225, 240]);
  assert.deepEqual(PACK.START_GAPS_M, [30, 90, 160, 260, 420]);
  assert.equal(createPack()[0].distanceM, 30);
  // 基準パワーの高い人ほど平坦で強く踏む
  const p0 = pack[0].powerModel(0, 0);
  const p4 = pack[4].powerModel(0, 0);
  assert.ok(Number.isFinite(p0.powerW) && p4.powerW > p0.powerW);
});

function runPack(seconds, dt) {
  const ce = new CourseEngine(getCourseProfile('hilly'), 30);
  const pack = createPack({ startDistanceM: 0 });
  const rider = { distanceM: 0, laneOffsetM: 0, speedMps: 0 };
  let draftedAny = false;
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    rider.speedMps = Math.min(9, rider.speedMps + 0.5 * dt);
    rider.distanceM += rider.speedMps * dt;
    stepPack(pack, dt, { gradeAtKm: (km) => ce.gradeAtKm(km), tSec: i * dt, me: rider });
    if (pack.some((r) => r.drafting)) draftedAny = true;
  }
  return { pack: pack.map((r) => ({ ...r, powerModel: null })), draftedAny };
}

test('stepPack: deterministic, sane speeds, riders progress and lanes stay bounded', () => {
  const a = runPack(600, 1 / 30);
  const b = runPack(600, 1 / 30);
  assert.deepEqual(a, b);
  a.pack.forEach((r, i) => {
    assert.ok(r.distanceM > PACK.START_GAPS_M[i] + 1000, `rider ${i} progressed: ${r.distanceM}`);
    assert.ok(r.speedMps >= 0 && r.speedMps <= PhysicsConstants.MAX_SPEED_MPS);
    assert.ok(Math.abs(r.laneOffsetM) < 5, `lane ${r.laneOffsetM}`);
    assert.ok(r.cadenceRpm >= 0);
  });
  const avgKmh = (a.pack[2].distanceM - PACK.START_GAPS_M[2]) / 600 * 3.6;
  assert.ok(avgKmh > 15 && avgKmh < 45, `pack rider avg ${avgKmh}`);
  // 不正な dt では何も変えない
  const pack = createPack();
  const before = pack.map((r) => ({ ...r }));
  for (const bad of [0, -1, NaN, Infinity]) stepPack(pack, bad, { gradeAtKm: flat });
  assert.deepEqual(pack.map((r) => ({ ...r })), before);
});

test('stepPack: a rider sitting right behind another drafts and goes faster than solo', () => {
  const mk = () => {
    const pack = createPack();
    // 後ろの人(0)を前の人(1)の 2m 後ろ・同じ速度に置く
    pack[0].distanceM = 100;
    pack[1].distanceM = 102;
    pack.forEach((r) => (r.speedMps = 9));
    return pack;
  };
  const pack = mk();
  stepPack(pack, 0.1, { gradeAtKm: flat, tSec: 0 });
  assert.equal(pack[0].drafting, true);
  assert.equal(pack[1].drafting, false);
  const solo = createPack()[0];
  solo.distanceM = 100;
  solo.speedMps = 9;
  stepVirtualRider(solo, 0.1, { gradeAtKm: flat, tSec: 0 });
  assert.ok(pack[0].speedMps > solo.speedMps);
  // 自分(me)の後ろにいる集団ライダーも、me を leaders としてドラフティングする
  const p2 = createPack();
  p2[0].distanceM = 10;
  stepPack(p2, 0.1, { gradeAtKm: flat, tSec: 0, me: { distanceM: 13, laneOffsetM: 0, speedMps: 5 } });
  assert.equal(p2[0].drafting, true);
});
