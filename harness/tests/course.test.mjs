import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseEngine } from '../../PandaCycleTrainer/js/physics/courseEngine.js';
import { PhysicsEngine } from '../../PandaCycleTrainer/js/physics/physicsEngine.js';
import { getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { PhysicsConstants } from '../../PandaCycleTrainer/js/physics/physicsConstants.js';

// elevationDeltaM の検証用: gradeAtKm を細かい台形則で数値積分した標高差(m)。
function numericElevationM(ce, fromKm, toKm, steps = 200000) {
  const h = (toKm - fromKm) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const a = fromKm + i * h;
    sum += (ce.gradeAtKm(a) + ce.gradeAtKm(a + h)) / 2 * h;
  }
  return sum * 10; // %·km → m
}

test('CourseEngine.elevationDeltaM: matches numerical integration of gradeAtKm (incl. loop boundary / crossfade)', () => {
  for (const id of ['flat', 'hilly', 'mountain', 'atami']) {
    const profile = getCourseProfile(id);
    const ce = new CourseEngine(profile, 100);
    const L = profile.loopLengthKm;
    const cf = profile.crossfadeKm ?? 0;
    const ranges = [
      [0, 0.5],
      [1.234, 1.734],
      [L - cf - 0.1, L + 0.4], // クロスフェード区間とループ境界をまたぐ
      [L - 0.05, L + 0.45],
      [0.3, 2 * L + 1.7], // 複数周
      [-0.2, 0.3], // 負の距離(前周の末尾)
    ];
    for (const [a, b] of ranges) {
      const expected = numericElevationM(ce, a, b);
      const got = ce.elevationDeltaM(a, b);
      assert.ok(Math.abs(got - expected) < 1e-3, `${id} [${a}, ${b}]: ${got} vs ${expected}`);
      // 負方向は符号反転
      assert.equal(ce.elevationDeltaM(b, a), -got);
    }
  }
});

test('CourseEngine.elevationDeltaM: one full loop sums to the loop elevation, zero/invalid spans give 0', () => {
  const ce = new CourseEngine(getCourseProfile('hilly'), 30);
  const loop = ce.elevationDeltaM(0, 15);
  assert.ok(Math.abs(ce.elevationDeltaM(15, 30) - loop) < 1e-9, 'every loop has the same net elevation');
  assert.ok(Math.abs(ce.elevationDeltaM(0, 45) - 3 * loop) < 1e-9);
  assert.equal(ce.elevationDeltaM(3, 3), 0);
  assert.equal(ce.elevationDeltaM(NaN, 3), 0);
  // 一定勾配のコースでは 勾配×距離 と厳密に一致する
  const steady = new CourseEngine({ loopLengthKm: 5, crossfadeKm: 0, points: [[0, 4], [5, 4]] }, 5);
  assert.ok(Math.abs(steady.elevationDeltaM(1, 1.5) - 20) < 1e-9, '4% over 500m = 20m');
});
