import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromRecord,
  fromTcx,
  distanceAt,
  trackEndS,
  timeAtDistance,
  bestRecordFor,
  PB_GHOST_NAME,
} from '../../PandaCycleTrainer/js/storage/ghostTrack.js';
import { buildTcx } from '../../PandaCycleTrainer/js/storage/tcx.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// 一定速度 speedMps で totalM まで走る記録(1秒ごとのサンプル、rideTimeS あり)
function steadyRide({ courseId = 'c1', speedMps, totalM, id }) {
  const samples = [];
  for (let t = 1; ; t++) {
    const d = Math.min(totalM, speedMps * t);
    samples.push({ tOffsetS: t, rideTimeS: t, distanceM: d, speedKmh: speedMps * 3.6, powerW: 200, cadenceRpm: 90 });
    if (d >= totalM) break;
  }
  return { id, courseId, totalDistanceM: totalM, ridingTimeS: samples.length, samples };
}

test('distanceAt: interpolates linearly and clamps outside the track', () => {
  const track = { name: 'x', courseId: null, points: Float64Array.from([0, 0, 10, 50, 20, 150]) };
  assert.equal(distanceAt(track, -1), 0);
  assert.equal(distanceAt(track, 0), 0);
  close(distanceAt(track, 5), 25);
  close(distanceAt(track, 15), 100);
  assert.equal(distanceAt(track, 20), 150);
  assert.equal(distanceAt(track, 999), 150);
  assert.equal(distanceAt(track, NaN), 0);
  assert.equal(distanceAt({ points: new Float64Array(0) }, 5), 0);
  assert.equal(trackEndS(track), 20);
  close(timeAtDistance(track, 100), 15);
  assert.equal(timeAtDistance(track, 151), null);
});

test('fromRecord: uses rideTimeS when present and starts from (0, 0)', () => {
  const record = {
    courseId: 'c1',
    samples: [
      { tOffsetS: 1, rideTimeS: 1, distanceM: 5, speedKmh: 18 },
      { tOffsetS: 2, rideTimeS: 2, distanceM: 10, speedKmh: 18 },
      // 一時停止明け: 経過時間は 40 秒飛ぶが走行時間は連続
      { tOffsetS: 42, rideTimeS: 3, distanceM: 15, speedKmh: 18 },
    ],
  };
  const track = fromRecord(record);
  assert.equal(track.name, PB_GHOST_NAME);
  assert.equal(track.courseId, 'c1');
  assert.ok(track.points instanceof Float64Array);
  assert.deepEqual(Array.from(track.points), [0, 0, 1, 5, 2, 10, 3, 15]);
  close(distanceAt(track, 2.5), 12.5);
});

test('fromRecord: distance that momentarily goes back is held (non-decreasing)', () => {
  const record = {
    courseId: 'c1',
    samples: [
      { tOffsetS: 1, distanceM: 5, speedKmh: 18 },
      { tOffsetS: 2, distanceM: 10, speedKmh: 18 },
      { tOffsetS: 3, distanceM: 9.5, speedKmh: 18 },
      { tOffsetS: 4, distanceM: 15, speedKmh: 18 },
    ],
  };
  const p = Array.from(fromRecord(record).points);
  const ds = p.filter((_, i) => i % 2 === 1);
  assert.deepEqual(ds, [0, 5, 10, 10, 15]);
  for (let i = 1; i < ds.length; i++) assert.ok(ds[i] >= ds[i - 1]);
  // 時間は普通に進む(止まっていたわけではない)
  assert.equal(trackEndS({ points: Float64Array.from(p) }), 4);
});

test('fromRecord: without rideTimeS, a 30 s stretch at zero speed is squeezed out', () => {
  const samples = [];
  for (let t = 1; t <= 20; t++) samples.push({ tOffsetS: t, distanceM: 5 * t, speedKmh: 18 });
  for (let t = 21; t <= 51; t++) samples.push({ tOffsetS: t, distanceM: 100, speedKmh: 0 });
  for (let t = 52; t <= 70; t++) samples.push({ tOffsetS: t, distanceM: 100 + 5 * (t - 51), speedKmh: 18 });
  const record = { courseId: 'c1', ridingTimeS: 40, elapsedTimeS: 70, totalDistanceM: 195, samples };
  const track = fromRecord(record);
  close(trackEndS(track), record.ridingTimeS);
  close(distanceAt(track, 20), 100);
  close(distanceAt(track, 21), 100);
  close(distanceAt(track, 22), 105);
  close(distanceAt(track, 40), 195);
});

test('fromRecord: without rideTimeS, a sampling gap (pause, no samples) is squeezed to the time needed', () => {
  const samples = [];
  for (let t = 1; t <= 20; t++) samples.push({ tOffsetS: t, distanceM: 5 * t, speedKmh: 18 });
  // 一時停止で 30 秒サンプルがなく、再開後 1 秒走ったところで次のサンプル
  for (let t = 51; t <= 60; t++) samples.push({ tOffsetS: t, distanceM: 100 + 5 * (t - 50), speedKmh: 18 });
  const track = fromRecord({ courseId: 'c1', samples });
  close(trackEndS(track), 30);
  close(distanceAt(track, 21), 105);
});

test('bestRecordFor: same course, long enough, shortest interpolated time at the goal', () => {
  // B は 142.9 秒、A は 142.857 秒で 1km 地点。サンプル単位(143秒目)だと同着になるが補間で A が勝つ
  const b = steadyRide({ id: 'B', speedMps: 1000 / 142.9, totalM: 1100 });
  const a = steadyRide({ id: 'A', speedMps: 7, totalM: 1100 });
  const otherCourse = steadyRide({ id: 'other', courseId: 'c2', speedMps: 12, totalM: 1500 });
  const tooShort = steadyRide({ id: 'short', speedMps: 12, totalM: 900 });
  const rides = [tooShort, b, otherCourse, a];
  assert.equal(bestRecordFor(rides, 'c1', 1).id, 'A');
  assert.equal(bestRecordFor([tooShort, otherCourse], 'c1', 1), null);
  assert.equal(bestRecordFor(rides, 'c2', 1).id, 'other');
  assert.equal(bestRecordFor(rides, 'c1', 2), null);
  assert.equal(bestRecordFor([], 'c1', 1), null);
  assert.equal(bestRecordFor(rides, 'c1', NaN), null);
});

test('bestRecordFor: goal time, not the finish time, decides the winner', () => {
  // fast: 1km までは速いが、その後ゆっくり走って総時間は長い
  const fast = steadyRide({ id: 'fast', speedMps: 10, totalM: 1000 });
  for (let t = 1; t <= 300; t++) {
    fast.samples.push({ tOffsetS: 100 + t, rideTimeS: 100 + t, distanceM: 1000 + t, speedKmh: 3.6 });
  }
  fast.totalDistanceM = 1300;
  const steady = steadyRide({ id: 'steady', speedMps: 8, totalM: 1300 });
  assert.equal(bestRecordFor([steady, fast], 'c1', 1).id, 'fast');
});

test('fromTcx: reads Time/DistanceMeters from a minimal TCX', () => {
  const xml = `<?xml version="1.0"?>
<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Lap StartTime="2026-01-01T09:00:00Z"><Track>
  <Trackpoint><Time>2026-01-01T09:00:00Z</Time><DistanceMeters>0</DistanceMeters></Trackpoint>
  <Trackpoint><Time>2026-01-01T09:00:10Z</Time><DistanceMeters>60.5</DistanceMeters></Trackpoint>
  <Trackpoint><Time>2026-01-01T09:00:11Z</Time></Trackpoint>
  <ns2:Trackpoint><ns2:Time>2026-01-01T09:00:20.000Z</ns2:Time><ns2:DistanceMeters>130</ns2:DistanceMeters></ns2:Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const track = fromTcx(xml, { name: 'たろう' });
  assert.equal(track.name, 'たろう');
  assert.equal(track.courseId, null);
  assert.deepEqual(Array.from(track.points), [0, 0, 10, 60.5, 20, 130]);
  close(distanceAt(track, 15), 95.25);
  assert.ok(fromTcx(xml).name.length > 0);
  assert.equal(fromTcx('not xml').points.length, 0);
});

test('fromTcx: reads back what buildTcx writes', () => {
  const samples = [];
  for (let t = 0; t <= 120; t++) {
    samples.push({ tOffsetS: t, distanceM: 6 * t, speedKmh: 21.6, powerW: 180, cadenceRpm: 85 });
  }
  const record = {
    courseId: 'c1',
    courseName: 'テスト',
    startTime: Date.UTC(2026, 0, 1, 9, 0, 0),
    ridingTimeS: 120,
    totalDistanceM: 720,
    samples,
  };
  const fromXml = fromTcx(buildTcx(record));
  const fromRec = fromRecord(record);
  close(trackEndS(fromXml), 120);
  for (const t of [0, 0.5, 30, 61.25, 119.9, 120, 500]) {
    close(distanceAt(fromXml, t), distanceAt(fromRec, t), 1e-9);
  }
});

test('fromTcx: a pause (time gap without distance) written by buildTcx is squeezed out', () => {
  const samples = [];
  for (let t = 0; t <= 20; t++) samples.push({ tOffsetS: t, distanceM: 5 * t });
  for (let t = 51; t <= 60; t++) samples.push({ tOffsetS: t, distanceM: 100 + 5 * (t - 50) });
  const xml = buildTcx({ startTime: Date.UTC(2026, 0, 1), ridingTimeS: 30, totalDistanceM: 150, samples });
  const track = fromTcx(xml);
  close(trackEndS(track), 30);
});

// 実走の記録: 1秒ごとのサンプルがゴール到達で止まり、末尾サンプルはゴール手前
function rideEndingShortOfGoal({ id, speedMps, goalM, ridingTimeS }) {
  const samples = [];
  for (let t = 1; speedMps * t < goalM; t++) {
    samples.push({ tOffsetS: t, rideTimeS: t, distanceM: speedMps * t, speedKmh: speedMps * 3.6 });
  }
  return { id, courseId: 'c1', totalDistanceM: goalM, ridingTimeS, samples };
}

test('fromRecord: appends totalDistanceM as the final point, time extrapolated from the last speed', () => {
  // 7 m/s: 末尾サンプルは 142 秒・994m。残り 6m を 7 m/s で → 142 + 6/7 秒
  // (ridingTimeS はゴールのダイアログ表示中も進むので 150 になっているが、速度外挿を優先する)
  const ride = rideEndingShortOfGoal({ id: 'A', speedMps: 7, goalM: 1000, ridingTimeS: 150 });
  const track = fromRecord(ride);
  close(trackEndS(track), 142 + 6 / 7);
  assert.equal(distanceAt(track, 999), 1000);
  close(timeAtDistance(track, 1000), 142 + 6 / 7);
});

test('fromRecord: without a usable last speed, the final point uses record.ridingTimeS', () => {
  const ride = rideEndingShortOfGoal({ id: 'A', speedMps: 7, goalM: 1000, ridingTimeS: 150 });
  ride.samples[ride.samples.length - 1].speedKmh = 0;
  close(trackEndS(fromRecord(ride)), 150);
  delete ride.samples[ride.samples.length - 1].speedKmh;
  close(trackEndS(fromRecord(ride)), 150);
  // totalDistanceM が末尾以下なら何も足さない
  const same = rideEndingShortOfGoal({ id: 'A', speedMps: 7, goalM: 1000, ridingTimeS: 150 });
  same.totalDistanceM = 994;
  assert.equal(trackEndS(fromRecord(same)), 142);
});

test('bestRecordFor: picks a real ride whose last sample is short of the goal', () => {
  const a = rideEndingShortOfGoal({ id: 'A', speedMps: 7, goalM: 1000, ridingTimeS: 160 });
  const b = rideEndingShortOfGoal({ id: 'B', speedMps: 6, goalM: 1000, ridingTimeS: 170 });
  assert.equal(bestRecordFor([b, a], 'c1', 1).id, 'A');
  assert.equal(bestRecordFor([b], 'c1', 1).id, 'B');
});
