import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGpx } from '../../PandaCycleTrainer/js/storage/gpx.js';
import { buildRealCourse, haversineM, suggestScenery, MAX_ABS_GRADE_PERCENT } from '../../PandaCycleTrainer/js/physics/realCourse.js';
import { CourseEngine } from '../../PandaCycleTrainer/js/physics/courseEngine.js';
import { COURSE_PROFILES } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { headingAtM } from '../../PandaCycleTrainer/js/three/routeLayout.js';

const DEG = Math.PI / 180;
const R = 6371008.8;
const LAT0 = 35.1;
const LON0 = 139.07;

// 決定的な疑似乱数(テストの再現性のため)
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * 合成の経路点列を作る。headingFn(m): 方位(rad、東=0・反時計回り正)、eleFn(m): 標高(m)。
 */
function synthTrack(totalM, stepM, headingFn, eleFn) {
  const kx = R * DEG * Math.cos(LAT0 * DEG);
  const ky = R * DEG;
  const pts = [];
  let x = 0;
  let y = 0;
  for (let m = 0; m <= totalM + 1e-9; m += stepM) {
    pts.push({ lat: LAT0 + y / ky, lon: LON0 + x / kx, ele: eleFn ? eleFn(m) : null });
    const h = headingFn(m + stepM / 2);
    x += Math.cos(h) * stepM;
    y += Math.sin(h) * stepM;
  }
  return pts;
}

function toGpx(points, name = 'テスト') {
  const trkpts = points
    .map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele === null ? '' : `<ele>${p.ele}</ele>`}<name>点</name></trkpt>`)
    .join('\n');
  return `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><name>${name}</name><trkseg>${trkpts}</trkseg></trk></gpx>`;
}

// ---- parseGpx ----

test('parseGpx reads track points, elevation and the track name (not a point name)', () => {
  const gpx = toGpx([
    { lat: 35, lon: 139, ele: 10 },
    { lat: 35.001, lon: 139, ele: 12.5 },
  ], '熱海 &amp; 伊豆');
  const { name, points } = parseGpx(gpx);
  assert.equal(name, '熱海 & 伊豆');
  assert.deepEqual(points, [
    { lat: 35, lon: 139, ele: 10 },
    { lat: 35.001, lon: 139, ele: 12.5 },
  ]);
});

test('parseGpx falls back to route points, accepts self-closing/namespaced tags and missing elevation', () => {
  const gpx = `<gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1"><gpx:rte><gpx:name>R</gpx:name>
    <gpx:rtept lon='139.0' lat='35.0'/>
    <gpx:rtept lat="35.002" lon="139.001"><gpx:ele>5</gpx:ele></gpx:rtept>
    <gpx:rtept lat="bad" lon="139"/></gpx:rte></gpx:gpx>`;
  const { name, points } = parseGpx(gpx);
  assert.equal(name, 'R');
  assert.deepEqual(points, [
    { lat: 35, lon: 139, ele: null },
    { lat: 35.002, lon: 139.001, ele: 5 },
  ]);
});

test('parseGpx concatenates multiple track segments in order', () => {
  const gpx = `<gpx><trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg>
    <trkseg><trkpt lat="3" lon="3"/></trkseg></trk></gpx>`;
  assert.deepEqual(parseGpx(gpx).points.map((p) => p.lat), [1, 2, 3]);
});

test('parseGpx rejects non-GPX text and GPX without a path', () => {
  assert.throws(() => parseGpx('<kml></kml>'), /GPX ファイルではありません/);
  assert.throws(() => parseGpx('<gpx><wpt lat="1" lon="1"/></gpx>'), /経路/);
});

// ---- buildRealCourse ----

test('course length matches the summed great-circle distance of the track', () => {
  const pts = synthTrack(5000, 7, (m) => 0.4 * Math.sin(m / 300), (m) => 100 + m * 0.02);
  let expected = 0;
  for (let i = 1; i < pts.length; i++) expected += haversineM(pts[i - 1], pts[i]);
  const { profile, stats } = buildRealCourse(pts, { name: 'x' });
  assert.ok(Math.abs(profile.loopLengthKm * 1000 - expected) < 0.01);
  assert.equal(stats.distanceKm, profile.loopLengthKm);
  const ps = profile.points;
  assert.equal(ps[0][0], 0);
  assert.ok(Math.abs(ps[ps.length - 1][0] - profile.loopLengthKm) < 1e-9);
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i][0] > ps[i - 1][0], 'control points strictly increase');
});

test('a uniform climb becomes a constant grade and integrates back to the same elevation gain', () => {
  // 3 km 平坦 → 2 km 5% 登り → 1 km 平坦
  const ele = (m) => 50 + Math.min(Math.max(m - 3000, 0), 2000) * 0.05;
  const pts = synthTrack(6000, 10, () => 0.3, ele);
  const { profile, stats } = buildRealCourse(pts);
  const engine = new CourseEngine(profile, profile.loopLengthKm);
  assert.ok(Math.abs(engine.gradeAtKm(4.0) - 5) < 0.1, `mid-climb grade ${engine.gradeAtKm(4.0)}`);
  assert.ok(Math.abs(engine.gradeAtKm(1.5)) < 0.1);
  // 実在コースはループしないのでクロスフェードなし。全長で積分した標高差 ≈ 100 m
  assert.equal(profile.crossfadeKm, 0);
  assert.equal(profile.fixedLength, true);
  const gain = engine.elevationDeltaM(0, profile.loopLengthKm);
  assert.ok(Math.abs(gain - 100) < 2, `gain ${gain}`);
  assert.ok(Math.abs(stats.ascentM - 100) < 2, `ascent ${stats.ascentM}`);
  assert.ok(stats.descentM < 1);
});

test('GPS elevation noise is smoothed out instead of producing jagged grades', () => {
  const rnd = lcg(42);
  const pts = synthTrack(4000, 5, (m) => 0.2 * Math.sin(m / 500), () => 20 + (rnd() - 0.5) * 4);
  const { profile } = buildRealCourse(pts);
  const maxAbs = Math.max(...profile.points.map(([, g]) => Math.abs(g)));
  assert.ok(maxAbs < 2, `max |grade| ${maxAbs}`);
});

test('implausible grades from bad elevation data are clamped', () => {
  // 10 m の間に 50 m 跳ねる異常値
  const pts = synthTrack(2000, 10, () => 0, (m) => (m >= 1000 && m < 1300 ? 300 : 0));
  const { profile } = buildRealCourse(pts);
  for (const [, g] of profile.points) assert.ok(Math.abs(g) <= MAX_ABS_GRADE_PERCENT);
});

test('a track without elevation rides flat and is reported as such', () => {
  const pts = synthTrack(3000, 10, () => 1, null);
  const { profile, stats } = buildRealCourse(pts);
  assert.equal(stats.hasElevation, false);
  assert.equal(stats.minElevationM, null);
  assert.ok(profile.points.every(([, g]) => g === 0));
  assert.match(profile.description, /標高データなし/);
});

test('missing elevation on some points is interpolated from neighbours', () => {
  const pts = synthTrack(2000, 10, () => 0, (m) => m * 0.03);
  pts.forEach((p, i) => {
    if (i % 3 === 1) p.ele = null;
  });
  const { profile } = buildRealCourse(pts);
  const engine = new CourseEngine(profile, profile.loopLengthKm);
  assert.ok(Math.abs(engine.gradeAtKm(1.0) - 3) < 0.1);
});

test('curve is a heading table that reproduces the route heading changes (left turn = positive)', () => {
  const L = 6000;
  const truth = (m) => 30 * DEG * Math.sin((2 * Math.PI * 3 * m) / L);
  const pts = synthTrack(L, 5, (m) => 0.7 + truth(m), (m) => 10);
  const { profile } = buildRealCourse(pts);
  assert.equal(profile.curve.type, 'table');
  assert.equal(profile.curve.stepM, 10);
  assert.equal(profile.curve.headings.length, Math.floor(profile.loopLengthKm * 100 + 1e-9) + 1);
  const loopM = profile.loopLengthKm * 1000;
  for (let m = 200; m < loopM - 200; m += 250) {
    const got = headingAtM(profile.curve, loopM, m);
    assert.ok(Math.abs(got - truth(m)) < 1.5 * DEG, `at ${m} m: ${got / DEG}° vs ${truth(m) / DEG}°`);
  }
});

test('a straight track gets an effectively straight road', () => {
  const pts = synthTrack(3000, 10, () => 1.2, (m) => 0);
  const { profile } = buildRealCourse(pts);
  assert.ok(profile.curve.headings.every((h) => Math.abs(h) < 1e-3));
});

test('net turning (e.g. a long sweeping arc) is kept as it is', () => {
  // 半周の大きな弧(正味 180° 左旋回)。フーリエ級数の頃は消えていた正味の旋回もそのまま残る
  const L = 4000;
  const pts = synthTrack(L, 10, (m) => (Math.PI * m) / L, () => 0);
  const { profile } = buildRealCourse(pts);
  const loopM = profile.loopLengthKm * 1000;
  for (let m = 100; m <= loopM - 100; m += 100) {
    assert.ok(Math.abs(headingAtM(profile.curve, loopM, m) - (Math.PI * m) / L) < 1.5 * DEG, `at ${m}`);
  }
});

test('a right-angle junction stays a sharp corner (not smeared over hundreds of metres)', () => {
  // 500 m 東へ → 交差点で左折(90°)→ 500 m 北へ
  const pts = synthTrack(1000, 2, (m) => (m < 500 ? 0 : Math.PI / 2), () => 0);
  const { profile } = buildRealCourse(pts);
  const h = (m) => headingAtM(profile.curve, 1000, m);
  assert.ok(Math.abs(h(460)) < 2 * DEG, `before the corner: ${h(460) / DEG}°`);
  assert.ok(Math.abs(h(540) - Math.PI / 2) < 2 * DEG, `after the corner: ${h(540) / DEG}°`);
  // 終点より先は直進(方位一定)
  assert.equal(h(1000 + 300), h(1000));
});

test('courses shorter than the minimum are rejected', () => {
  const pts = synthTrack(300, 10, () => 0, () => 0);
  assert.throws(() => buildRealCourse(pts), /短すぎます/);
});

test('profile carries the given id/name and a scenery suggested from climbing density', () => {
  const pts = synthTrack(5000, 10, () => 0, (m) => m * 0.04);
  const { profile } = buildRealCourse(pts, { id: 'gpx-1', name: '  十国峠  ' });
  assert.equal(profile.id, 'gpx-1');
  assert.equal(profile.name, '十国峠');
  assert.equal(profile.scenery, 'mountain');
  assert.equal(suggestScenery({ distanceKm: 10, ascentM: 30 }), 'city');
  assert.equal(suggestScenery({ distanceKm: 10, ascentM: 80 }), 'lakeside');
  assert.equal(suggestScenery({ distanceKm: 10, ascentM: 200 }), 'mountain');
  assert.equal(buildRealCourse(pts).profile.name, '実在コース');
});

// ---- CourseEngine の補間(二分探索化)の回帰 ----

test('CourseEngine interpolation still matches a linear scan for the built-in courses', () => {
  const linear = (points, km) => {
    if (km <= points[0][0]) return points[0][1];
    for (let i = 0; i < points.length - 1; i++) {
      const [k0, g0] = points[i];
      const [k1, g1] = points[i + 1];
      if (km >= k0 && km <= k1) return g0 + (g1 - g0) * ((km - k0) / (k1 - k0));
    }
    return points[points.length - 1][1];
  };
  for (const p of COURSE_PROFILES) {
    const noFade = { ...p, crossfadeKm: 0 };
    const engine = new CourseEngine(noFade, 100);
    for (let km = 0; km < p.loopLengthKm; km += 0.037) {
      assert.ok(Math.abs(engine.gradeAtKm(km) - linear(p.points, km)) < 1e-12, `${p.id} @ ${km}`);
    }
  }
});

test('duplicate-km control points (a grade step) keep returning the earlier grade at the step', () => {
  const engine = new CourseEngine({ points: [[0, 0], [1, 5], [1, -5], [2, 0]], loopLengthKm: 2, crossfadeKm: 0 }, 2);
  assert.equal(engine.gradeAtKm(1), 5);
  assert.ok(Math.abs(engine.gradeAtKm(1.5) + 2.5) < 1e-12);
});

test('odd course lengths (tiny or long final remainder) give sane grades and curve', () => {
  for (const totalM of [2001, 2004, 2049, 2051, 2096]) {
    const pts = synthTrack(totalM, 1, () => 0.5, (m) => m * 0.04);
    const { profile } = buildRealCourse(pts);
    const engine = new CourseEngine({ ...profile, crossfadeKm: 0 }, profile.loopLengthKm);
    for (const [km, g] of profile.points) assert.ok(Math.abs(g - 4) < 0.2, `${totalM} m @ ${km}: ${g}`);
    assert.ok(Math.abs(engine.elevationDeltaM(0, profile.loopLengthKm) - totalM * 0.04) < 2);
    assert.ok(profile.curve.headings.every((x) => Math.abs(x) < 1e-3), `${totalM} m: straight`);
  }
});

// ---- ループしない実在コース(fixedLength)のコース外側 ----

test('fixedLength courses do not loop: flat beyond the finish, start grade before the start', () => {
  const pts = synthTrack(3000, 10, () => 0, (m) => 100 + m * 0.05);
  const { profile } = buildRealCourse(pts);
  const engine = new CourseEngine(profile, profile.loopLengthKm);
  const L = profile.loopLengthKm;
  assert.ok(Math.abs(engine.gradeAtKm(L - 0.2) - 5) < 0.1);
  assert.equal(engine.gradeAtKm(L + 0.01), 0, 'flat run-out past the finish (no wrap to the start)');
  assert.equal(engine.gradeAtKm(L + 5), 0);
  assert.equal(engine.gradeAtKm(-0.1), engine.gradeAtKm(0));
  // elevationDeltaM は gradeAtKm の積分と一致する(コースの外側も含む)
  const numeric = (a, b) => {
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += engine.gradeAtKm(a + ((i + 0.5) / n) * (b - a));
    return (sum / n) * (b - a) * 10;
  };
  for (const [a, b] of [[-0.5, 1], [1, L + 2], [-0.3, L + 0.7], [L + 0.1, L + 3], [2, 2.5]]) {
    assert.ok(Math.abs(engine.elevationDeltaM(a, b) - numeric(a, b)) < 0.5, `[${a}, ${b}]`);
  }
  assert.ok(Math.abs(engine.elevationDeltaM(L, L + 3)) < 1e-9);
});
