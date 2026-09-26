import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsEngine } from '../../PandaCycleTrainer/js/physics/physicsEngine.js';
import { CourseEngine } from '../../PandaCycleTrainer/js/physics/courseEngine.js';
import { COURSE_PROFILES, getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { PhysicsConstants } from '../../PandaCycleTrainer/js/physics/physicsConstants.js';

const flatCourse = (km = 10) =>
  new CourseEngine({ id: 't', loopLengthKm: 10, crossfadeKm: 0, points: [[0, 0], [10, 0]] }, km);

function ride(engine, watts, seconds, dt = 0.05) {
  engine.setCurrentPower(watts);
  let s;
  for (let t = 0; t < seconds; t += dt) s = engine.step(dt);
  return s;
}

test('全コースプロファイルが整合している', () => {
  assert.ok(COURSE_PROFILES.length >= 2);
  for (const p of COURSE_PROFILES) {
    assert.equal(getCourseProfile(p.id), p);
    const last = p.points[p.points.length - 1][0];
    assert.ok(last <= p.loopLengthKm, `${p.id}: 最終制御点がloop長を超える`);
    for (let i = 1; i < p.points.length; i++) {
      assert.ok(p.points[i][0] >= p.points[i - 1][0], `${p.id}: 距離が単調増加でない`);
    }
  }
});

test('勾配はループ境界で連続(クロスフェード)', () => {
  for (const p of COURSE_PROFILES) {
    const c = new CourseEngine(p, 100);
    const L = p.loopLengthKm;
    const before = c.gradeAtKm(L - 1e-6);
    const after = c.gradeAtKm(L + 1e-6);
    assert.ok(Math.abs(before - after) < 0.01, `${p.id}: 境界で不連続 ${before} -> ${after}`);
  }
});

test('平坦・200Wで妥当な巡航速度(25〜45km/h)に収束する', () => {
  const e = new PhysicsEngine({ riderWeightKg: 65, bikeWeightKg: 8, courseEngine: flatCourse() });
  const s = ride(e, 200, 120);
  assert.ok(s.speedKmh > 25 && s.speedKmh < 45, `speed=${s.speedKmh}`);
});

test('0Wでは減速し、速度は負にならない', () => {
  const e = new PhysicsEngine({ riderWeightKg: 65, bikeWeightKg: 8, courseEngine: flatCourse() });
  const v1 = ride(e, 250, 60).speedMps;
  const v2 = ride(e, 0, 30).speedMps;
  assert.ok(v2 < v1);
  const v3 = ride(e, 0, 600).speedMps;
  assert.ok(v3 >= 0 && v3 <= PhysicsConstants.MAX_SPEED_MPS);
});

test('上り坂は平坦より遅く、獲得標高が増える', () => {
  const hill = new CourseEngine({ id: 'h', loopLengthKm: 10, crossfadeKm: 0, points: [[0, 6], [10, 6]] }, 10);
  const e1 = new PhysicsEngine({ riderWeightKg: 65, bikeWeightKg: 8, courseEngine: flatCourse() });
  const e2 = new PhysicsEngine({ riderWeightKg: 65, bikeWeightKg: 8, courseEngine: hill });
  const flat = ride(e1, 200, 60);
  const up = ride(e2, 200, 60);
  assert.ok(up.speedMps < flat.speedMps);
  assert.ok(up.elevationGainM > 0);
});

test('不正/過大な dt で状態が壊れない', () => {
  const e = new PhysicsEngine({ riderWeightKg: 65, bikeWeightKg: 8, courseEngine: flatCourse() });
  e.setCurrentPower(300);
  for (const dt of [0, -1, NaN, Infinity, 10]) {
    const s = e.step(dt);
    assert.ok(Number.isFinite(s.speedMps) && Number.isFinite(s.distanceM));
  }
});

test('ゴール判定と延長', () => {
  const p = getCourseProfile(COURSE_PROFILES[0].id);
  const c = new CourseEngine(p, 5);
  assert.equal(c.isGoalReached(4.99), false);
  assert.equal(c.isGoalReached(5), true);
  c.extendGoal();
  assert.equal(c.remainingKm(5), p.loopLengthKm);
});
