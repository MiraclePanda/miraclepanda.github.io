import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTcx } from '../../PandaCycleTrainer/js/storage/tcx.js';
import { fmt, fmtTime } from '../../PandaCycleTrainer/js/utils/format.js';
import { validateWeight, validateBikeWeight, validateDistance, validateCrr, validateCda } from '../../PandaCycleTrainer/js/utils/validation.js';
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

test('validation: 詳細設定のCrr/CdAは旧版DC1と同じ範囲を受け付ける', () => {
  assert.equal(validateCrr(0.004).valid, true);
  assert.equal(validateCrr(0.0005).valid, false);
  assert.equal(validateCrr(0.03).valid, false);
  assert.equal(validateCda('0.32').valid, true);
  assert.equal(validateCda(0.1).valid, false);
  assert.equal(validateCda('').valid, false);
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

test('湖畔・山岳・熱海の景観: コース対応、道路は常に水面/谷底より高い、配置は決定的で道路上に出ない', async () => {
  const { CourseEngine } = await import('../../PandaCycleTrainer/js/physics/courseEngine.js');
  const { COURSE_PROFILES, getCourseProfile } = await import('../../PandaCycleTrainer/js/physics/courseProfiles.js');
  const LL = await import('../../PandaCycleTrainer/js/three/landscapeLayout.js');
  assert.deepEqual(COURSE_PROFILES.map((p) => p.scenery), ['city', 'lakeside', 'mountain', 'atami', 'ueno']);
  for (const [courseId, id] of [['hilly', 'lakeside'], ['mountain', 'mountain'], ['atami', 'atami']]) {
    const p = getCourseProfile(courseId);
    const ce = new CourseEngine(p, 100);
    const elev = LL.createElevationSampler((km) => ce.gradeAtKm(km));
    const L = LL.LANDSCAPES[id];
    const floor = LL.createFloorModel(elev, p.loopLengthKm * 1000, L.valley.minDropM);
    for (let s = 0; s <= p.loopLengthKm * 2000; s += 50) {
      assert.ok(elev.elevAt(s) - floor.floorAt(s) >= L.valley.minDropM - 0.5, `${id}: ${s}m`);
    }
    const a = LL.collectLandscapeObjects(L, 500, 900);
    assert.deepEqual(a, LL.collectLandscapeObjects(L, 500, 900));
    for (const t of a.trees) assert.ok(Math.abs(t.d) > LL.roadEdgeM(L));
  }
});

test('描画品質の保存: auto/high/medium/low のみ受け付け、既定は auto', async () => {
  const store = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    const { loadRenderQuality, saveRenderQuality } = await import('../../PandaCycleTrainer/js/storage/prefs.js');
    assert.equal(loadRenderQuality(), 'auto');
    saveRenderQuality('medium');
    assert.equal(loadRenderQuality(), 'medium');
    saveRenderQuality('ultra'); // 不正値は保存しない
    assert.equal(loadRenderQuality(), 'medium');
    store.set('pct_render_quality_v1', 'bogus');
    assert.equal(loadRenderQuality(), 'auto', '壊れた保存値は自動に戻す');
  } finally {
    globalThis.localStorage = saved;
  }
});

test('バイク種別の保存: bike/swan のみ復元し、不正値は未設定扱い', async () => {
  const store = new Map();
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try {
    const { loadPrefs, savePrefs } = await import('../../PandaCycleTrainer/js/storage/prefs.js');
    savePrefs({ distanceKm: 10, weightKg: 60, bikeWeightKg: 8, crr: 0.004, cdaM2: 0.32, vehicle: 'swan' });
    assert.equal(loadPrefs().vehicle, 'swan');
    assert.equal(loadPrefs().distanceKm, 10);
    store.set('pct_prefs_v1', JSON.stringify({ vehicle: 'rocket' }));
    assert.equal(loadPrefs().vehicle, undefined, '未知の種別は既定(標準)に任せる');
  } finally {
    globalThis.localStorage = saved;
  }
});

test('熱海サンビーチ: ヤシ・ホテル・パラソルは道路の外、初島は沖、熱海城は1周に1つ', async () => {
  const LL = await import('../../PandaCycleTrainer/js/three/landscapeLayout.js');
  const L = LL.LANDSCAPES.atami;
  const edge = LL.roadEdgeM(L);
  const { town } = LL.collectLandscapeObjects(L, 3800, 4200, { farToM: 5000 });
  assert.ok(town.palms.length > 30 && town.hotels.length > 0 && town.parasols.length > 0);
  for (const o of [...town.palms, ...town.hotels, ...town.parasols, ...town.lamps]) assert.ok(Math.abs(o.d) > edge);
  for (const ps of town.parasols) assert.ok(ps.d < -(edge + L.town.promenadeM), 'パラソルは砂浜(海側)');
  assert.ok(town.islands.every((i) => i.d < -3000), '初島は沖合');
  assert.equal(town.castles.filter((c) => c.s === 4500).length, 1);
});

test('デモ走行の仮想ライダー: 上りで踏み込み下りで緩め、値は範囲内', async () => {
  const { demoRiderTarget, smoothDemoPower, DEMO_RIDER } = await import('../../PandaCycleTrainer/js/physics/demoRider.js');
  const flat = demoRiderTarget(0, 0).targetPowerW;
  assert.ok(demoRiderTarget(8, 0).targetPowerW > flat && demoRiderTarget(-8, 0).targetPowerW < flat);
  for (const g of [-30, -5, 0, 5, 30]) {
    const { targetPowerW, cadenceRpm } = demoRiderTarget(g, 42);
    assert.ok(targetPowerW >= DEMO_RIDER.MIN_POWER_W && targetPowerW <= DEMO_RIDER.MAX_POWER_W);
    assert.ok(cadenceRpm >= DEMO_RIDER.MIN_CADENCE_RPM && cadenceRpm <= DEMO_RIDER.MAX_CADENCE_RPM);
  }
  const p = smoothDemoPower(100, 200, 0.5);
  assert.ok(p > 100 && p < 200);
});

test('上野不忍池: 1周1.2kmの反時計回りで常に左へ曲がる周回、岸から離れ、スワンボート固定', async () => {
  const P = await import('../../PandaCycleTrainer/js/three/pondLayout.js');
  const { getCourseProfile } = await import('../../PandaCycleTrainer/js/physics/courseProfiles.js');
  const course = getCourseProfile('ueno');
  assert.equal(course.fixedVehicle, 'swan');
  assert.equal(course.loopLengthKm * 1000, P.ROUTE_LENGTH_M);
  let len = 0;
  let area = 0;
  let prev = P.routeAt(0);
  for (let s = 1; s <= P.ROUTE_LENGTH_M; s++) {
    const p = P.routeAt(s);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    area += prev.x * p.y - p.x * prev.y;
    let dh = p.heading - prev.heading;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    assert.ok(dh > 0, `左へ曲がり続ける(${s}m)`);
    assert.ok(P.shoreR(p.theta) - P.routeR(p.theta) >= 15, `岸から離れている(${s}m)`);
    prev = p;
  }
  assert.ok(Math.abs(len - P.ROUTE_LENGTH_M) < 1);
  assert.ok(area > 0, '反時計回り');
  assert.deepEqual(P.collectPondObjects(), P.collectPondObjects(), '配置は決定的');
});
