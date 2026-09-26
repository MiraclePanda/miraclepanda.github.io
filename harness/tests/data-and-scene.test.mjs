import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTcx } from '../../PandaCycleTrainer/js/storage/tcx.js';
import { fmt, fmtTime } from '../../PandaCycleTrainer/js/utils/format.js';
import { validateWeight, validateBikeWeight, validateDistance } from '../../PandaCycleTrainer/js/utils/validation.js';
import { generateBlock, collectSceneObjects } from '../../PandaCycleTrainer/js/three/cityLayout.js';
import { buildElevationProfile, interpolateElevation } from '../../PandaCycleTrainer/js/three/roadElevation.js';

test('TCX: GPS座標を含まず、パワー/ケイデンスを含む', () => {
  const xml = buildTcx({
    startTime: Date.UTC(2026, 0, 1),
    ridingTimeS: 2,
    totalDistanceM: 20,
    samples: [
      { tOffsetS: 0, distanceM: 0, powerW: 150, cadenceRpm: 80 },
      { tOffsetS: 1, distanceM: 10, powerW: 160.4, cadenceRpm: 300 },
      { tOffsetS: 2, distanceM: 20, powerW: null, cadenceRpm: null },
    ],
  });
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(!xml.includes('<Position>'), 'GPS座標は付与しない方針');
  assert.equal((xml.match(/<Trackpoint>/g) || []).length, 3);
  assert.ok(xml.includes('<Watts>160</Watts>'));
  assert.ok(xml.includes('<Cadence>254</Cadence>'), 'ケイデンスはuint8にクランプ');
});

test('format: 欠損値は -- 表示', () => {
  assert.equal(fmt(null), '--');
  assert.equal(fmt(12.345, 1, 'km'), '12.3km');
  assert.equal(fmtTime(3725), '1:02:05');
  assert.equal(fmtTime(65), '01:05');
  assert.equal(fmtTime(undefined), '--:--');
});

test('validation: 範囲外・非数値を弾く', () => {
  assert.equal(validateWeight('65').valid, true);
  assert.equal(validateWeight('').valid, false);
  assert.equal(validateWeight(500).valid, false);
  assert.equal(validateBikeWeight(8).valid, true);
  assert.equal(validateDistance(0).valid, false);
});

test('街並み生成は決定的(同じblockIndexで同じ結果)', () => {
  assert.deepEqual(generateBlock(7), generateBlock(7));
  assert.notDeepEqual(generateBlock(7), generateBlock(8));
  const objs = collectSceneObjects(0, 500);
  for (const k of ['buildings', 'trees', 'lamps', 'cars', 'intersections']) assert.ok(Array.isArray(objs[k]), k);
});

test('道路標高プロファイル: 現在地で0、上り勾配で前方が高い', () => {
  const prof = buildElevationProfile(() => 5, 0, { behindM: 100, aheadM: 200, stepM: 10 });
  assert.ok(Math.abs(interpolateElevation(prof, 0)) < 1e-9);
  assert.ok(interpolateElevation(prof, 200) > 9);
  assert.ok(interpolateElevation(prof, -100) < 0);
});
