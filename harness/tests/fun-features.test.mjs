// 走行を楽しくする機能の純粋ロジック: 沿道のハプニング・名所、観光ガイド、グルメ換算、バーチャル日本縦断。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planHappenings, createHappeningDirector, landmarkActors, pickKind, seedForCourse,
  DEFAULT_HAPPENING_WEIGHTS, MIN_GAP_M, MAX_GAP_M, FIRST_AT_M, HAPPENING_KINDS, LANDMARK_KINDS,
} from '../../PandaCycleTrainer/js/three/happeningsLayout.js';
import { guideEventsBetween } from '../../PandaCycleTrainer/js/utils/tourGuide.js';
import {
  kcalFromWorkKj, workKjFromSamples, recordKcal, gourmetLine, gourmetMilestone, gourmetVerdict, fmtAmount,
} from '../../PandaCycleTrainer/js/utils/gourmet.js';
import {
  JOURNEY_CITIES, JOURNEY_TOTAL_KM, journeyPosition, citiesPassed, journeyTotalKm, journeyToast, projectLatLon, JOURNEY_MAP,
} from '../../PandaCycleTrainer/js/utils/journey.js';
import { COURSE_PROFILES, getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';

// ---- 沿道のハプニング ----

test('planHappenings is deterministic and spaced between MIN_GAP_M and MAX_GAP_M', () => {
  const a = planHappenings(42, DEFAULT_HAPPENING_WEIGHTS, 0, 50000);
  const b = planHappenings(42, DEFAULT_HAPPENING_WEIGHTS, 0, 50000);
  assert.deepEqual(a, b);
  assert.equal(a[0].atM, FIRST_AT_M);
  for (let i = 1; i < a.length; i++) {
    const gap = a[i].atM - a[i - 1].atM;
    assert.ok(gap >= MIN_GAP_M && gap <= MAX_GAP_M, `gap ${gap}`);
  }
  // 途中から求めても同じ地点・同じ種類になる(前方の予定を作り直しても変わらない)
  const tail = planHappenings(42, DEFAULT_HAPPENING_WEIGHTS, 20000, 50000);
  assert.deepEqual(tail, a.filter((p) => p.atM >= 20000));
  // deer は既定では出ない
  assert.ok(a.every((p) => p.kind !== 'deer'));
  assert.notDeepEqual(planHappenings(43, DEFAULT_HAPPENING_WEIGHTS, 0, 50000).map((p) => p.atM), a.map((p) => p.atM));
});

test('pickKind honours weights and returns null when all weights are zero', () => {
  assert.equal(pickKind({ cat: 0, panda: 0 }, 0.5), null);
  assert.equal(pickKind({ deer: 1 }, 0.99), 'deer');
  const counts = Object.fromEntries(HAPPENING_KINDS.map((k) => [k, 0]));
  for (let i = 0; i < 1000; i++) counts[pickKind({ cat: 1, deer: 3 }, (i + 0.5) / 1000)]++;
  assert.equal(counts.cat, 250);
  assert.equal(counts.deer, 750);
});

/** 一定速度で走らせて、actors と events を集める。 */
function ride(director, { toM, speedMps = 6, dt = 0.1 }) {
  const events = [];
  const seenKinds = new Set();
  let maxActors = 0;
  for (let d = 0; d <= toM; d += speedMps * dt) {
    const r = director.step({ distanceM: d, speedMps, dt });
    events.push(...r.events);
    maxActors = Math.max(maxActors, r.actors.length);
    for (const a of r.actors) {
      seenKinds.add(a.kind);
      assert.ok(Number.isFinite(a.distanceM) && Number.isFinite(a.lateralM) && Number.isFinite(a.yaw));
      assert.ok([-1, 0, 1].includes(a.side));
      assert.ok(a.distanceM >= d - 31 && a.distanceM <= d + 301, `${a.kind} at ${a.distanceM} vs ${d}`);
    }
  }
  return { events, seenKinds, maxActors };
}

test('happening director emits one toast per planned happening (panda: start and end) and visible actors', () => {
  const seed = 7;
  const director = createHappeningDirector({ seed, weights: DEFAULT_HAPPENING_WEIGHTS });
  const toM = 30000;
  const { events, seenKinds } = ride(director, { toM });
  const plan = planHappenings(seed, DEFAULT_HAPPENING_WEIGHTS, 0, toM - 400);
  const expected = plan.reduce((n, p) => n + (p.kind === 'panda' ? 2 : 1), 0);
  // 終点付近で始まったパンダは脱落の通知がまだのことがあるので、計画分以上・計画分+数件以内
  assert.ok(events.length >= expected, `${events.length} >= ${expected}`);
  assert.ok(events.length <= expected + 4);
  for (const e of events) {
    assert.equal(e.kind, 'happening');
    assert.ok(e.title && e.sub && e.kicker.includes('沿道のハプニング'));
  }
  for (const k of new Set(plan.map((p) => p.kind))) assert.ok(seenKinds.has(k), k);
});

test('cat crosses from the right sidewalk to the left once the rider is close', () => {
  const director = createHappeningDirector({ seed: 1, weights: { cat: 1 } });
  // 最初のハプニング(FIRST_AT_M)は猫
  let r = director.step({ distanceM: FIRST_AT_M - 200, speedMps: 0, dt: 0.1 });
  const cat0 = r.actors.find((a) => a.kind === 'cat');
  assert.ok(cat0.lateralM > 5 && r.events.length === 0);
  r = director.step({ distanceM: FIRST_AT_M - 40, speedMps: 0, dt: 0.1 });
  assert.equal(r.events.length, 1);
  for (let i = 0; i < 40; i++) r = director.step({ distanceM: FIRST_AT_M - 40, speedMps: 0, dt: 0.1 });
  const cat1 = r.actors.find((a) => a.kind === 'cat');
  assert.ok(cat1.lateralM < -5, `${cat1.lateralM}`);
  assert.equal(cat1.moving, 0);
});

test('panda catches up from behind, paces alongside and then drops back; it waits while the rider is stopped', () => {
  const director = createHappeningDirector({ seed: 3, weights: { panda: 1 } });
  let r = director.step({ distanceM: FIRST_AT_M - 10, speedMps: 5, dt: 0.1 });
  assert.equal(r.actors.length, 0); // 地点の手前では見えない
  r = director.step({ distanceM: FIRST_AT_M + 1, speedMps: 5, dt: 0.1 });
  assert.match(r.events[0].title, /パンダ/);
  let d = FIRST_AT_M + 1;
  let gap = null;
  for (let i = 0; i < 100; i++) {
    d += 0.5;
    r = director.step({ distanceM: d, speedMps: 5, dt: 0.1 });
    gap = r.actors[0].distanceM - d;
  }
  assert.ok(gap > 0, `panda should be ahead after catching up (${gap})`);
  // 止まっている間は並走の時間が進まない
  for (let i = 0; i < 600; i++) r = director.step({ distanceM: d, speedMps: 0, dt: 0.1 });
  assert.equal(r.events.length, 0);
  assert.ok(r.actors.length === 1);
  let ended = false;
  for (let i = 0; i < 600 && r.actors.length > 0; i++) {
    d += 0.5;
    r = director.step({ distanceM: d, speedMps: 5, dt: 0.1 });
    if (r.events.length) ended = true;
  }
  assert.ok(ended);
  assert.equal(r.actors.length, 0);
});

test('null weights disable happenings but landmarks still appear', () => {
  const profile = { loopLengthKm: 2, landmarks: [{ km: 0.5, kind: 'torii', side: 0, lateralM: 0 }] };
  const director = createHappeningDirector({ seed: 1, weights: null, profile });
  const { events, seenKinds } = ride(director, { toM: 6000 });
  assert.equal(events.length, 0);
  assert.deepEqual([...seenKinds], ['torii']);
});

test('landmarkActors repeat every loop (not on fixedLength courses) and stay within the window', () => {
  const profile = { loopLengthKm: 2, landmarks: [{ km: 0.5, kind: 'torii', side: 0, lateralM: 0 }, { km: 1.5, kind: 'pagoda', side: 1, lateralM: 15 }] };
  assert.deepEqual(landmarkActors(profile, 300).map((a) => [a.kind, a.distanceM]), [['torii', 500]]);
  assert.deepEqual(landmarkActors(profile, 4300).map((a) => [a.kind, a.distanceM, a.id]), [['torii', 4500, 'lm-2-0']]);
  assert.deepEqual(landmarkActors(profile, 1450).map((a) => [a.kind, a.side, a.lateralM]), [['pagoda', 1, 15]]);
  assert.deepEqual(landmarkActors({ ...profile, fixedLength: true }, 4300), []);
  assert.deepEqual(landmarkActors({ loopLengthKm: 2 }, 300), []);
});

test('seedForCourse is stable and differs between courses', () => {
  assert.equal(seedForCourse('kyoto'), seedForCourse('kyoto'));
  assert.notEqual(seedForCourse('kyoto'), seedForCourse('nara'));
});

// ---- 観光地コース・観光ガイド ----

test('tourist courses have guide, landmarks and local food; ueno has no happenings', () => {
  const tourist = COURSE_PROFILES.filter((p) => p.tag === '観光地');
  assert.deepEqual(tourist.map((p) => p.id), ['fuji', 'kyoto', 'nara', 'ryugu']);
  for (const p of tourist) {
    assert.ok(p.guide.length >= 3);
    for (const g of p.guide) assert.ok(g.km >= 0 && g.km < p.loopLengthKm && g.title);
    for (const m of p.landmarks) assert.ok(LANDMARK_KINDS.includes(m.kind) && m.km < p.loopLengthKm);
    assert.ok(p.localFood.kcal > 0);
    assert.equal(p.points[p.points.length - 1][0], p.loopLengthKm);
  }
  assert.equal(getCourseProfile('fuji').backdrop, 'fuji');
  assert.equal(getCourseProfile('ueno').happenings, null);
  assert.ok(getCourseProfile('nara').happenings.deer > 0);
});

test('guideEventsBetween fires each announcement once per loop', () => {
  const p = getCourseProfile('kyoto');
  const all = [];
  for (let d = 0; d < 16000; d += 37) all.push(...guideEventsBetween(p, d, d + 37));
  assert.equal(all.length, p.guide.length * 2);
  assert.equal(all[0].kind, 'guide');
  assert.equal(all[0].title, p.guide[0].title);
  assert.deepEqual(guideEventsBetween(p, 500, 500), []);
  assert.deepEqual(guideEventsBetween({ ...p, fixedLength: true }, 8000, 16000), []);
  assert.deepEqual(guideEventsBetween(getCourseProfile('flat'), 0, 10000), []);
});

// ---- グルメ換算 ----

test('kcal from work uses ~24% gross efficiency (1 kJ ≈ 1 kcal)', () => {
  assert.ok(Math.abs(kcalFromWorkKj(1000) - 995.86) < 0.1);
  assert.equal(kcalFromWorkKj(-5), 0);
  assert.equal(kcalFromWorkKj(NaN), 0);
  // 1時間 150W = 540kJ
  const samples = Array.from({ length: 3600 }, (_, i) => ({ tOffsetS: i, powerW: 150 }));
  assert.ok(Math.abs(workKjFromSamples(samples) - 540) < 0.2);
  assert.ok(Math.abs(recordKcal({ samples }) - kcalFromWorkKj(540)) < 0.5);
  assert.equal(recordKcal({ workKj: 100, samples }), kcalFromWorkKj(100));
  // 一時停止で間隔が空いても、その間は1秒分しか数えない
  assert.equal(workKjFromSamples([{ tOffsetS: 0, powerW: 100 }, { tOffsetS: 600, powerW: 100 }]), 0.2);
});

test('gourmetLine picks the largest food reached, and the course local food when present', () => {
  assert.equal(gourmetLine(40, null), '温泉まんじゅう 0.5個分');
  assert.equal(gourmetLine(360, null), 'ショートケーキ 1.0個分');
  assert.equal(gourmetLine(1000, null), 'カツ丼 1.1杯分');
  assert.equal(gourmetLine(275, getCourseProfile('fuji')), 'ほうとう 0.5杯分');
  assert.equal(gourmetLine(500, getCourseProfile('kyoto')), '生八つ橋 10個分');
  assert.equal(fmtAmount(0), '0');
});

test('gourmetMilestone fires when a food threshold or each further ramen is crossed', () => {
  assert.equal(gourmetMilestone(170, 185, null).title, 'おにぎり 1個分を消費しました');
  assert.equal(gourmetMilestone(185, 190, null), null);
  assert.equal(gourmetMilestone(999, 1001, null).title, 'ラーメン 2杯分を消費しました');
  assert.equal(gourmetMilestone(1499, 1500, null).title, 'ラーメン 3杯分を消費しました');
  assert.equal(gourmetMilestone(49, 51, getCourseProfile('nara')).title, '柿の葉寿司 1個分を消費しました');
  assert.equal(gourmetMilestone(10, 5, null), null);
});

test('gourmetVerdict lists foods and a comment matching the amount', () => {
  const v = gourmetVerdict(600, getCourseProfile('fuji'));
  assert.equal(v.headline, 'ラーメン 1.2杯分');
  assert.equal(v.items[0].name, 'ほうとう');
  assert.ok(v.items[0].local);
  assert.ok(v.comment.length > 0);
  assert.equal(gourmetVerdict(40, null).headline, '温泉まんじゅう 0.5個分');
  assert.match(gourmetVerdict(1200, null).comment, /替え玉/);
});

// ---- バーチャル日本縦断 ----

test('journey cities run north to south with increasing distance', () => {
  assert.equal(JOURNEY_CITIES[0].name, '宗谷岬');
  assert.equal(JOURNEY_CITIES[JOURNEY_CITIES.length - 1].name, '佐多岬');
  for (let i = 1; i < JOURNEY_CITIES.length; i++) assert.ok(JOURNEY_CITIES[i].km > JOURNEY_CITIES[i - 1].km);
  for (const c of JOURNEY_CITIES) {
    const [x, y] = projectLatLon(c.lat, c.lon);
    assert.ok(x >= 0 && x <= JOURNEY_MAP.width && y >= 0 && y <= JOURNEY_MAP.height, c.name);
  }
});

test('journeyPosition finds the current leg and laps after Cape Sata', () => {
  let p = journeyPosition(0);
  assert.equal(p.lap, 1);
  assert.equal(p.from.name, '宗谷岬');
  assert.equal(p.to.name, '稚内');
  p = journeyPosition(1500);
  assert.equal(p.from.name, '宇都宮');
  assert.equal(p.to.name, '東京');
  assert.equal(p.kmToNext, 5);
  p = journeyPosition(1505);
  assert.equal(p.from.name, '東京');
  p = journeyPosition(JOURNEY_TOTAL_KM + 10);
  assert.equal(p.lap, 2);
  assert.equal(p.from.name, '宗谷岬');
  assert.equal(journeyPosition(-3).kmInLap, 0);
});

test('citiesPassed reports each city once, across laps, and journeyTotalKm sums rides', () => {
  assert.deepEqual(citiesPassed(400, 430).map((c) => c.city.name), ['札幌']);
  assert.deepEqual(citiesPassed(430, 430), []);
  const wrap = citiesPassed(JOURNEY_TOTAL_KM - 100, JOURNEY_TOTAL_KM + 40);
  assert.deepEqual(wrap.map((c) => [c.city.name, c.lap]), [['鹿児島', 1], ['佐多岬', 1], ['稚内', 2]]);
  assert.match(journeyToast(wrap[1]).title, /日本縦断達成/);
  assert.match(journeyToast(wrap[2]).kicker, /2周目/);
  assert.equal(journeyTotalKm([{ totalDistanceM: 12000 }, { totalDistanceM: 3500 }, {}]), 15.5);
  assert.equal(journeyTotalKm(null), 0);
});

test('玉手箱: 竜宮城の1日は地上の100年', async () => {
  const { landTimeFromRyuguS, landTimeLabel } = await import('../../PandaCycleTrainer/js/utils/tamatebako.js');
  assert.deepEqual(landTimeFromRyuguS(86400), { years: 100, months: 0, days: 0 });
  assert.equal(landTimeLabel(1800), '約2年1か月');
  assert.equal(landTimeLabel(60), '約25日');
  assert.deepEqual(landTimeFromRyuguS(-5), { years: 0, months: 0, days: 0 });
});
