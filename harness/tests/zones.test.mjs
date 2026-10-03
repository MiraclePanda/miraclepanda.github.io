import { test } from 'node:test';
import assert from 'node:assert/strict';
import { powerZone, ZONE_THRESHOLDS } from '../../PandaCycleTrainer/js/utils/zones.js';

test('powerZone: FTP 200W boundaries fall into the upper zone exactly at the threshold', () => {
  const cases = [
    [0, 0], [109, 0], [110, 1], [149, 1], [150, 2], [179, 2], [180, 3],
    [209, 3], [210, 4], [239, 4], [240, 5], [299, 5], [300, 6], [1200, 6],
  ];
  for (const [w, zone] of cases) assert.equal(powerZone(w, 200), zone, `${w}W`);
});

test('powerZone: thresholds match the spec and invalid input yields zone 0', () => {
  assert.deepEqual(ZONE_THRESHOLDS, [0.55, 0.75, 0.9, 1.05, 1.2, 1.5]);
  assert.equal(powerZone(NaN, 200), 0);
  assert.equal(powerZone(250, 0), 0);
  assert.equal(powerZone(250, -100), 0);
  assert.equal(powerZone(250, undefined), 0);
  assert.equal(powerZone(null, 200), 0);
  assert.equal(powerZone(-50, 200), 0);
});
