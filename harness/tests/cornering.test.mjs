import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCornerSpeedLimits, cornerSpeedLimitAt, applyCornerLimit } from '../../PandaCycleTrainer/js/physics/cornering.js';
import { PhysicsConstants } from '../../PandaCycleTrainer/js/physics/physicsConstants.js';
import { CourseEngine } from '../../PandaCycleTrainer/js/physics/courseEngine.js';
import { PhysicsEngine } from '../../PandaCycleTrainer/js/physics/physicsEngine.js';
import { createVirtualRider, stepVirtualRider } from '../../PandaCycleTrainer/js/physics/virtualRider.js';
import { COURSE_PROFILES } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { buildRealCourse } from '../../PandaCycleTrainer/js/physics/realCourse.js';
import { buildRouteFrame, curvatureAtM, hasCurve } from '../../PandaCycleTrainer/js/three/routeLayout.js';

const R = 6371008.8;
const DEG = Math.PI / 180;

/** 方位 headingFn(m) で進む平坦な経路点列(stepM 間隔)。 */
function track(totalM, stepM, headingFn) {
  const lat = 35.1;
  const kx = R * DEG * Math.cos(lat * DEG);
  const ky = R * DEG;
  const pts = [];
  let x = 0;
  let y = 0;
  for (let m = 0; m <= totalM + 1e-9; m += stepM) {
    pts.push({ lat: lat + y / ky, lon: 139 + x / kx, ele: 10 });
    const h = headingFn(m + stepM / 2);
    x += Math.cos(h) * stepM;
    y += Math.sin(h) * stepM;
  }
  return pts;
}

// 1000 m 直進 → 直角の右折 → 1000 m 直進 → 半径 15 m のヘアピン(180° 左)→ 1000 m 直進
const HAIRPIN_LEN = Math.PI * 15;
function junctionAndHairpin(m) {
  if (m < 1000) return 0;
  if (m < 2000) return -Math.PI / 2;
  if (m < 2000 + HAIRPIN_LEN) return -Math.PI / 2 + (m - 2000) / 15;
  return Math.PI / 2;
}
const { profile } = buildRealCourse(track(3000 + HAIRPIN_LEN, 2, junctionAndHairpin));
const engine = new CourseEngine(profile, profile.loopLengthKm);
const limitAt = (m) => engine.speedLimitMpsAt(m / 1000);

test('corner speed limits: no limit on straights, realistic speeds at a junction and a hairpin', () => {
  assert.equal(limitAt(500), Infinity, 'straight');
  assert.equal(limitAt(1500), Infinity, 'straight between the corners');
  const junction = Math.min(...[990, 1000, 1010].map(limitAt)) * 3.6;
  const hairpin = Math.min(...[2010, 2020, 2030].map(limitAt)) * 3.6;
  assert.ok(junction > 15 && junction < 32, `junction ${junction.toFixed(1)} km/h`);
  assert.ok(hairpin > 15 && hairpin < 30, `hairpin ${hairpin.toFixed(1)} km/h`);
  // 手前から減速が始まる(上限は終点側から減速度で広がる)
  const before = limitAt(950);
  assert.ok(before > limitAt(1000) && before < Infinity, 'the limit rises gradually before the corner');
  const b = PhysicsConstants.CORNER_BRAKE_DECEL_MPS2;
  for (let m = 800; m < 1000; m += 10) {
    const a = limitAt(m);
    const c = limitAt(m + 10);
    if (Number.isFinite(a) && Number.isFinite(c)) assert.ok(a * a - c * c <= 2 * b * 10 * 2 + 1e-6, `braking demand at ${m}`);
  }
});

test('corner speed limits: built-in courses and old Fourier GPX courses are unaffected', () => {
  for (const p of COURSE_PROFILES) {
    const e = new CourseEngine(p, 10);
    for (let km = 0; km < p.loopLengthKm; km += 0.25) assert.equal(e.speedLimitMpsAt(km), Infinity, p.id);
  }
  assert.equal(buildCornerSpeedLimits([[25, 3, 0]]), null);
  assert.equal(cornerSpeedLimitAt(null, 100), Infinity);
});

test('applyCornerLimit brakes gradually down to the limit and reports braking', () => {
  assert.deepEqual(applyCornerLimit(8, 8.2, Infinity, 0.1), { speedMps: 8.2, braking: false });
  const r = applyCornerLimit(12, 12.1, 6, 0.1);
  assert.equal(r.braking, true);
  assert.ok(Math.abs(r.speedMps - (12 - PhysicsConstants.CORNER_BRAKE_DECEL_MPS2 * 0.1)) < 1e-9, 'no instant drop');
  assert.equal(applyCornerLimit(6.1, 6.3, 6, 0.1).speedMps, 6);
});

test('PhysicsEngine slows for the corners even while pedalling hard, then speeds up again', () => {
  const physics = new PhysicsEngine({ riderWeightKg: 70, bikeWeightKg: 9, courseEngine: engine });
  physics.setCurrentPower(400);
  let maxOver = 0;
  let sawBraking = false;
  let speedAt1500 = 0;
  const minSpeedNear = { junction: Infinity, hairpin: Infinity };
  while (physics.distanceM < 2600) {
    const s = physics.step(0.05);
    const lim = engine.speedLimitMpsAt(s.distanceM / 1000);
    if (Number.isFinite(lim)) maxOver = Math.max(maxOver, s.speedMps - lim);
    if (s.cornerBraking) sawBraking = true;
    if (s.distanceM > 980 && s.distanceM < 1020) minSpeedNear.junction = Math.min(minSpeedNear.junction, s.speedKmh);
    if (s.distanceM > 2010 && s.distanceM < 2040) minSpeedNear.hairpin = Math.min(minSpeedNear.hairpin, s.speedKmh);
    if (s.distanceM < 1500) speedAt1500 = s.speedKmh;
  }
  assert.ok(sawBraking, 'braking is reported');
  assert.ok(maxOver < 1.5, `never far above the limit (${maxOver.toFixed(2)} m/s)`);
  assert.ok(minSpeedNear.junction < 32, `junction ${minSpeedNear.junction.toFixed(1)} km/h`);
  assert.ok(minSpeedNear.hairpin < 30, `hairpin ${minSpeedNear.hairpin.toFixed(1)} km/h`);
  assert.ok(speedAt1500 > 38, `back up to speed on the straight (${speedAt1500.toFixed(1)} km/h)`);
});

test('virtual riders (pack) brake for the same corners when given the CourseEngine', () => {
  const r = createVirtualRider({ powerModel: () => ({ powerW: 400, cadenceRpm: 90 }), startDistanceM: 0 });
  let maxOver = 0;
  for (let i = 0; i < 4000 && r.distanceM < 2100; i++) {
    stepVirtualRider(r, 0.05, { gradeAtKm: engine, tSec: i * 0.05 });
    const lim = engine.speedLimitMpsAt(r.distanceM / 1000);
    if (Number.isFinite(lim)) maxOver = Math.max(maxOver, r.speedMps - lim);
  }
  assert.ok(r.distanceM > 2000);
  assert.ok(maxOver < 1.5, `pack rider stays near the limit (${maxOver.toFixed(2)} m/s)`);
});

test('3D road frame from the heading table turns a right angle at the junction', () => {
  assert.equal(hasCurve(profile.curve), true);
  const frame = buildRouteFrame(profile.curve, profile.loopLengthKm * 1000, 900, { behindM: 0, aheadM: 300, stepM: 4 });
  const end = frame[frame.length - 1];
  // 右折(上から見て時計回り)なので、100 m 先の角を曲がった後は右(+X)へ約 200 m 進む
  assert.ok(end.x > 150, `turned right: x = ${end.x.toFixed(1)}`);
  assert.ok(Math.abs(end.z + 100) < 15, `about 100 m ahead of the rider: z = ${end.z.toFixed(1)}`);
  assert.ok(curvatureAtM(profile.curve, 0, 1000) < -0.01, 'right turn has negative curvature (rider leans right)');
  assert.equal(curvatureAtM(profile.curve, 0, 500), 0);
});

test('corner speed limits: interpolation between table nodes never asks for more than the braking deceleration', () => {
  const b = PhysicsConstants.CORNER_BRAKE_DECEL_MPS2;
  // 1 m 刻みで v² の差から減速度を求める(後ろ向きパスの b を超えない)
  for (let m = 800; m < 2100; m += 1) {
    const a = limitAt(m);
    const c = limitAt(m + 1);
    if (Number.isFinite(a) && Number.isFinite(c) && c < a) {
      assert.ok((a * a - c * c) / 2 <= b + 1e-6, `deceleration ${((a * a - c * c) / 2).toFixed(2)} at ${m} m`);
    }
  }
});
