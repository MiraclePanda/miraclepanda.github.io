import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseEngine } from '../../PandaCycleTrainer/js/physics/courseEngine.js';
import { PhysicsEngine, computeForces } from '../../PandaCycleTrainer/js/physics/physicsEngine.js';
import { getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { PhysicsConstants } from '../../PandaCycleTrainer/js/physics/physicsConstants.js';
import { createVirtualRider, stepVirtualRider } from '../../PandaCycleTrainer/js/physics/virtualRider.js';

// computeForces を切り出す前の PhysicsEngine.step() をそのまま写した参照実装。
// 切り出し後の結果が浮動小数まで同一であることを確かめる。
class ReferenceEngine {
  constructor({ riderWeightKg, bikeWeightKg, courseEngine, crr, cdaM2 }) {
    this.courseEngine = courseEngine;
    this.crr = crr ?? PhysicsConstants.CRR;
    this.cdaM2 = cdaM2 ?? PhysicsConstants.CDA;
    this.totalMassKg = riderWeightKg + bikeWeightKg;
    this.speedMps = 0;
    this.distanceM = 0;
    this.elevationM = 0;
    this.elevationGainM = 0;
    this.currentGradePercent = courseEngine.gradeAtKm(0);
    this.currentPowerW = 0;
    this._lastForces = { fGravity: 0, fRolling: 0, fAir: 0 };
  }
  setCurrentPower(w) {
    this.currentPowerW = w ?? 0;
  }
  step(dtSeconds) {
    if (dtSeconds <= 0 || !Number.isFinite(dtSeconds)) return this._snapshot();
    const dt = Math.min(dtSeconds, 0.25);
    const gradePercent = this.courseEngine.gradeAtKm(this.distanceM / 1000);
    this.currentGradePercent = gradePercent;
    const theta = Math.atan(gradePercent / 100);
    const g = PhysicsConstants.GRAVITY;
    const mass = this.totalMassKg;
    const fGravity = mass * g * Math.sin(theta);
    const fRolling = this.crr * mass * g * Math.cos(theta);
    const rel = Math.max(0, this.speedMps - PhysicsConstants.WIND_SPEED_MPS);
    const fAir = 0.5 * PhysicsConstants.AIR_DENSITY * this.cdaM2 * rel * rel;
    const fDrive = this.currentPowerW / Math.max(this.speedMps, PhysicsConstants.MIN_SPEED_FOR_DRIVE_FORCE);
    const acceleration = (fDrive - fGravity - fRolling - fAir) / mass;
    this._lastForces = { fGravity, fRolling, fAir };
    const newSpeed = Math.min(PhysicsConstants.MAX_SPEED_MPS, Math.max(0, this.speedMps + acceleration * dt));
    const dd = newSpeed * dt;
    const de = dd * Math.sin(theta);
    this.speedMps = newSpeed;
    this.distanceM += dd;
    this.elevationM += de;
    if (de > 0) this.elevationGainM += de;
    return this._snapshot();
  }
  computeErgTargetWatts() {
    const v = Math.max(this.speedMps, PhysicsConstants.ERG_REFERENCE_SPEED_MPS);
    const { fGravity, fRolling, fAir } = this._lastForces;
    return Math.max(0, (fGravity + fRolling + fAir) * v);
  }
  _snapshot() {
    return {
      speedMps: this.speedMps,
      speedKmh: this.speedMps * 3.6,
      distanceM: this.distanceM,
      elevationM: this.elevationM,
      elevationGainM: this.elevationGainM,
      gradePercent: this.currentGradePercent,
    };
  }
}

// 勾配変化を含む固定入力: 0→上り8%→下り−6%→平坦の折れ線コース。パワーも時間で変える。
const VARIED_PROFILE = {
  loopLengthKm: 0.4,
  crossfadeKm: 0.02,
  points: [[0, 0], [0.03, 8], [0.1, 8], [0.15, -6], [0.25, -6], [0.32, 0], [0.4, 0]],
};
function inputAt(i) {
  const powerW = i < 100 ? 300 : i < 250 ? 180 + 0.6 * (i - 100) : i < 400 ? 0 : 420 - i * 0.3;
  const dt = i % 50 === 7 ? 0.4 : i % 50 === 13 ? 0 : 1 / 10; // 丸め(0.4→0.25)と不正dtも混ぜる
  return { powerW, dt };
}

function runBoth(opts) {
  const ce = new CourseEngine(VARIED_PROFILE, 10);
  const a = new PhysicsEngine({ riderWeightKg: 68, bikeWeightKg: 8.5, courseEngine: ce, ...opts });
  const b = new ReferenceEngine({ riderWeightKg: 68, bikeWeightKg: 8.5, courseEngine: ce, ...opts });
  const outA = [];
  const outB = [];
  for (let i = 0; i < 600; i++) {
    const { powerW, dt } = inputAt(i);
    a.setCurrentPower(powerW);
    b.setCurrentPower(powerW);
    outA.push({ ...a.step(dt), erg: a.computeErgTargetWatts() });
    outB.push({ ...b.step(dt), erg: b.computeErgTargetWatts() });
  }
  return { outA, outB };
}

test('computeForces refactor: PhysicsEngine.step() is bit-identical to the pre-refactor formula (600 steps)', () => {
  for (const opts of [{}, { crr: 0.006, cdaM2: 0.28 }]) {
    const { outA, outB } = runBoth(opts);
    assert.deepEqual(outA, outB);
    // 勾配変化・パワー変化が実際に入力に含まれていること
    const grades = new Set(outA.map((s) => Math.round(s.gradePercent)));
    assert.ok(grades.has(8) && grades.has(-6) && grades.has(0), `grades covered: ${[...grades]}`);
    assert.ok(outA[599].distanceM > 200, 'should have reached the descent');
    assert.ok(outA.some((s) => s.speedMps === 0 && s.distanceM > 50), 'includes stalling on the climb under 0W (0 clamp)');
  }
});

test('PhysicsEngine is deterministic: same inputs give the same results', () => {
  const r1 = runBoth({}).outA;
  const r2 = runBoth({}).outA;
  assert.deepEqual(r1, r2);
});

test('computeForces: force components follow the physical model', () => {
  const base = { speedMps: 8, gradePercent: 0, massKg: 80, crr: 0.004, cdaM2: 0.32, powerW: 200 };
  const flat = computeForces(base);
  assert.equal(flat.fGravity, 0);
  assert.ok(Math.abs(flat.fRolling - 0.004 * 80 * PhysicsConstants.GRAVITY) < 1e-12);
  assert.ok(Math.abs(flat.fAir - 0.5 * PhysicsConstants.AIR_DENSITY * 0.32 * 64) < 1e-12);
  assert.equal(flat.fDrive, 25);
  assert.ok(Math.abs(flat.netForce - (flat.fDrive - flat.fRolling - flat.fAir)) < 1e-12);
  assert.ok(computeForces({ ...base, gradePercent: 5 }).fGravity > 0);
  assert.ok(computeForces({ ...base, gradePercent: -5 }).fGravity < 0);
  // draftFactor=1 は省略と完全一致、0.66 で fAir だけが 0.66 倍
  assert.deepEqual(computeForces({ ...base, draftFactor: 1 }), flat);
  const drafted = computeForces({ ...base, draftFactor: 0.66 });
  assert.ok(Math.abs(drafted.fAir - flat.fAir * 0.66) < 1e-12);
  assert.equal(drafted.fRolling, flat.fRolling);
  // v=0 でも駆動力が有限(特異点回避)
  assert.ok(Number.isFinite(computeForces({ ...base, speedMps: 0 }).fDrive));
});

test('stepVirtualRider uses the same force balance as PhysicsEngine (same power → same trajectory)', () => {
  const ce = new CourseEngine(VARIED_PROFILE, 10);
  const pe = new PhysicsEngine({ riderWeightKg: 70, bikeWeightKg: 9, courseEngine: ce });
  const r = createVirtualRider({ id: 'v', kind: 'pack', powerModel: () => 230, massKg: 79 });
  pe.setCurrentPower(230);
  for (let i = 0; i < 600; i++) {
    pe.step(0.1);
    stepVirtualRider(r, 0.1, { gradeAtKm: (km) => ce.gradeAtKm(km), tSec: i * 0.1 });
  }
  assert.equal(r.speedMps, pe.speedMps);
  assert.equal(r.distanceM, pe.distanceM);
});

test('stepVirtualRider: dt rounding, invalid dt, speed clamps, cadence/crank, determinism', () => {
  const flat = () => 0;
  const r = createVirtualRider({ id: 'a', kind: 'pack', name: 'A', color: '#ff0000', startDistanceM: 50, laneOffsetM: 0.3, powerModel: () => 250 });
  assert.deepEqual(
    Object.keys(r).sort(),
    ['color', 'id', 'kind', 'laneOffsetM', 'massKg', 'name', 'powerModel', 'powerW', 'speedMps', 'cadenceRpm', 'crankRad', 'distanceM', 'targetLaneM'].sort()
  );
  assert.equal(r.distanceM, 50);
  assert.equal(r.targetLaneM, 0.3);
  const snap = { ...r };
  for (const bad of [0, -1, NaN, Infinity]) stepVirtualRider(r, bad, { gradeAtKm: flat });
  assert.deepEqual({ ...r }, snap, 'invalid dt must not change state');

  // dt=10 は 0.25 に丸められる
  const big = createVirtualRider({ id: 'b', kind: 'pack', powerModel: () => 250 });
  const small = createVirtualRider({ id: 'c', kind: 'pack', powerModel: () => 250 });
  stepVirtualRider(big, 10, { gradeAtKm: flat });
  stepVirtualRider(small, 0.25, { gradeAtKm: flat });
  assert.equal(big.distanceM, small.distanceM);

  for (let i = 0; i < 2400; i++) stepVirtualRider(r, 0.25, { gradeAtKm: flat, tSec: i * 0.25 });
  const kmh = r.speedMps * 3.6;
  assert.ok(kmh > 25 && kmh < 45, `flat 250W steady ${kmh}`);
  assert.ok(r.cadenceRpm > 0 && r.crankRad >= 0 && r.crankRad < Math.PI * 2);
  assert.equal(r.powerW, 250);

  // 急な下りでも MAX_SPEED_MPS を超えない、0W・上りでも逆走しない
  const down = createVirtualRider({ id: 'd', kind: 'pack', powerModel: () => 1500 });
  for (let i = 0; i < 4000; i++) stepVirtualRider(down, 0.25, { gradeAtKm: () => -25 });
  assert.ok(down.speedMps <= PhysicsConstants.MAX_SPEED_MPS);
  const up = createVirtualRider({ id: 'e', kind: 'pack', powerModel: null });
  up.speedMps = 5;
  for (let i = 0; i < 400; i++) stepVirtualRider(up, 0.25, { gradeAtKm: () => 12 });
  assert.equal(up.speedMps, 0);
  assert.equal(up.cadenceRpm, 0);
  const d0 = up.distanceM;
  stepVirtualRider(up, 0.25, { gradeAtKm: () => 12 });
  assert.equal(up.distanceM, d0, 'no reverse');

  // 決定性
  const run = () => {
    const x = createVirtualRider({ id: 'x', kind: 'pack', powerModel: (g, t) => 200 + 10 * g + 20 * Math.sin(t) });
    const ce = new CourseEngine(getCourseProfile('hilly'), 30);
    for (let i = 0; i < 600; i++) stepVirtualRider(x, 1 / 30, { gradeAtKm: (km) => ce.gradeAtKm(km), tSec: i / 30 });
    return { ...x, powerModel: null };
  };
  assert.deepEqual(run(), run());
});
