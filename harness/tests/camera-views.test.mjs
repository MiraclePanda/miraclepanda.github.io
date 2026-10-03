import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_VIEWS, CINE_SHOT_S, CINE_SHOT_TYPES, CHASE_FOV_DEG, createCineDirector, normalizeCameraView,
  riderRollRad, fpCameraRollRad, estimateCadenceRpm, fpBobM, fpFovDeg,
} from '../../PandaCycleTrainer/js/three/cameraViews.js';

/** dt 秒刻みで tEnd 秒まで進め、ショットが切り替わった時刻と種類を返す。 */
function runDirector(director, { tEnd, dt = 0.05, speedMps = 0, startM = 1000 }) {
  const switches = [];
  let lastIndex = -1;
  for (let i = 0; i * dt <= tEnd + 1e-9; i++) {
    const t = i * dt;
    const shot = director.update(t, startM + speedMps * t);
    if (shot.index !== lastIndex) {
      switches.push({ t: Math.round(t * 1000) / 1000, type: shot.type, index: shot.index });
      lastIndex = shot.index;
    }
  }
  return switches;
}

test('camera views: chase / fp / cine, unknown values fall back to chase, the pond has no cine', () => {
  assert.deepEqual(CAMERA_VIEWS, ['chase', 'fp', 'cine']);
  assert.equal(normalizeCameraView(undefined), 'chase');
  assert.equal(normalizeCameraView('drone'), 'chase');
  assert.equal(normalizeCameraView('fp'), 'fp');
  assert.equal(normalizeCameraView('cine'), 'cine');
  assert.equal(normalizeCameraView('cine', false), 'chase');
  assert.equal(normalizeCameraView('fp', false), 'fp');
});

test('cine switches shots every 10 seconds (stationary and at a typical riding speed)', () => {
  assert.equal(CINE_SHOT_S, 10);
  for (const speedMps of [0, 4, 7]) {
    const switches = runDirector(createCineDirector(), { tEnd: 60, speedMps });
    assert.deepEqual(switches.map((s) => s.t), [0, 10, 20, 30, 40, 50, 60], `speed ${speedMps} m/s`);
    // 沿道カメラ2種とヘリ視点を順番に繰り返す
    assert.deepEqual(switches.map((s) => s.type), [0, 1, 2, 3, 4, 5, 6].map((i) => CINE_SHOT_TYPES[i % 3]));
  }
});

test('cine roadside cameras stand ahead of the rider and move on once the rider has passed', () => {
  const director = createCineDirector();
  const first = director.update(0, 500);
  assert.equal(first.type, 'roadside-low');
  assert.ok(first.s >= 555 && first.s <= 595, `roadside camera 55-95 m ahead, got ${first.s - 500}`);
  assert.equal(director.update(1, first.s + 10).index, 0, 'still the same shot while the rider is near');
  assert.equal(director.update(2, first.s + 15).index, 1, 'passed by more than 14 m -> next shot');
});

test('cine moves to the next shot on a distance jump or when the clock goes back', () => {
  const director = createCineDirector();
  director.update(0, 100);
  assert.equal(director.update(1, 100).index, 0);
  assert.equal(director.update(2, 900).index, 1, 'jump of 800 m');
  assert.equal(director.update(1, 900).index, 2, 'clock went back');
});

test('cine shots are deterministic and within sane ranges; reset() starts over', () => {
  const a = runDirector(createCineDirector(7), { tEnd: 90 });
  const b = runDirector(createCineDirector(7), { tEnd: 90 });
  assert.deepEqual(a, b);
  const director = createCineDirector();
  for (let t = 0; t < 120; t += 0.5) {
    const shot = director.update(t, 2000 + t * 6);
    assert.ok(shot.side === -1 || shot.side === 1);
    assert.ok(shot.lateralU >= 0 && shot.lateralU < 1);
    assert.ok(shot.heightM >= 1.4 && shot.heightM <= 9);
    assert.ok(shot.fovDeg >= 30 && shot.fovDeg <= 60);
  }
  const firstShot = createCineDirector().update(0, 2000);
  director.reset();
  assert.deepEqual(director.update(0, 2000), firstShot);
});

test('rider roll = clamp(k·v²/g, ±0.35) leaning into the curve; 0 on straights', () => {
  assert.equal(riderRollRad(0, 12), 0);
  assert.equal(riderRollRad(undefined, 12), 0);
  const v = 10;
  assert.ok(Math.abs(riderRollRad(0.002, v) - (0.002 * v * v) / 9.81) < 1e-12);
  assert.ok(riderRollRad(0.002, v) > 0, 'left curve (k > 0) leans left (positive rotation.z)');
  assert.ok(riderRollRad(-0.002, v) < 0, 'right curve leans right');
  assert.equal(riderRollRad(0.05, 15), 0.35);
  assert.equal(riderRollRad(-0.05, 15), -0.35);
});

test('fp camera rolls half the rider roll, capped at ±0.08 rad', () => {
  assert.equal(fpCameraRollRad(0), 0);
  assert.equal(fpCameraRollRad(0.1), 0.05);
  assert.equal(fpCameraRollRad(0.35), 0.08);
  assert.equal(fpCameraRollRad(-0.35), -0.08);
});

test('fp field of view widens with speed (60 + v·0.35); chase stays at 60', () => {
  assert.equal(CHASE_FOV_DEG, 60);
  assert.equal(fpFovDeg(0), 60);
  assert.ok(Math.abs(fpFovDeg(10) - 63.5) < 1e-12);
});

test('fp head bob follows the cadence within ±1.2 cm (two bobs per crank revolution)', () => {
  const cam = { crankRad: 0 };
  let max = 0;
  let crossings = 0;
  let prev = 0;
  // 90rpm で 2 秒 = 3 回転 → 上下の揺れは 6 周期(ゼロ交差 約12回)
  for (let i = 0; i < 400; i++) {
    const y = fpBobM(cam, 90, 0.005);
    max = Math.max(max, Math.abs(y));
    if ((prev < 0 && y >= 0) || (prev > 0 && y <= 0)) crossings++;
    prev = y;
  }
  assert.ok(max <= 0.012 + 1e-12 && max > 0.0115, `amplitude ${max}`);
  assert.ok(crossings >= 11 && crossings <= 13, `crossings ${crossings}`);
  assert.equal(fpBobM({ crankRad: 1 }, 0, 0.1), 0, 'no bob without pedaling');
});

test('cadence estimate when the scene gets no cadence: ~90 rpm at 30 km/h, 0 when stopped', () => {
  assert.equal(estimateCadenceRpm(0), 0);
  assert.equal(estimateCadenceRpm(30), 90);
  assert.equal(estimateCadenceRpm(60), 100);
});
