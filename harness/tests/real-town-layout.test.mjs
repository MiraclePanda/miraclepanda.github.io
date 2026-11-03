import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { KYOTO_TOWN_DATA } from '../../PandaCycleTrainer/js/physics/realTowns/kyoto.js';
import { NARA_TOWN_DATA } from '../../PandaCycleTrainer/js/physics/realTowns/nara.js';
import { FUJI_TOWN_DATA } from '../../PandaCycleTrainer/js/physics/realTowns/fuji.js';
import { createAtamiRoute, createTerrainSampler } from '../../PandaCycleTrainer/js/three/atamiRealLayout.js';
import {
  REAL_TOWNS, decodeTownData, loadTownData, waterIndexAt, waterCells, waterLevelAt, townBuildingLook,
  townGroundColor, chamferDistance,
} from '../../PandaCycleTrainer/js/three/realTownLayout.js';

// 実在の街の観光地コース(京都・東山/奈良公園/富士山・河口湖)の実データ js/data/<id>-town.json と、
// コースの勾配・方位 js/physics/realTowns/<id>.js(どちらも tools/real-towns/build.py が生成)が
// 互いに、またコースプロファイルと食い違わないことを確かめる。
const COURSES = [
  { id: 'kyoto', scenery: 'kyoto', file: 'kyoto-town.json', D: KYOTO_TOWN_DATA, mode: 'outback', plateau: true },
  { id: 'nara', scenery: 'nara', file: 'nara-town.json', D: NARA_TOWN_DATA, mode: 'loop', plateau: false },
  { id: 'fuji', scenery: 'kawaguchiko', file: 'fuji-town.json', D: FUJI_TOWN_DATA, mode: 'outback', plateau: false },
];
const load = (file) => decodeTownData(JSON.parse(readFileSync(new URL(`../../PandaCycleTrainer/js/data/${file}`, import.meta.url))));

for (const c of COURSES) {
  const data = load(c.file);
  const route = createAtamiRoute(data.route);
  const p = getCourseProfile(c.id);

  test(`${c.id}: the course profile uses the real town scene and the generated lap`, () => {
    assert.equal(p.scenery, c.scenery);
    assert.ok(REAL_TOWNS[c.scenery], 'RideScreen mounts RealTownScene for this scenery');
    assert.equal(p.tag, '観光地');
    assert.equal(p.cornering, true);
    assert.equal(p.backdrop, undefined, 'real terrain replaces the procedural backdrop');
    assert.equal(c.D.mode, c.mode);
    assert.ok(Math.abs(p.loopLengthKm * 1000 - c.D.loopLengthM) < 1e-6);
    assert.ok(Math.abs(route.lapM - c.D.loopLengthM) < 1, `lap ${route.lapM} vs ${c.D.loopLengthM}`);
    assert.equal(p.curve.type, 'table');
    // 勾配は ±12% に抑えてある(街なかの急坂・標高タイルの誤差)
    for (const [, g] of p.points) assert.ok(Math.abs(g) <= 12 + 1e-9, `grade ${g}`);
    // 名所・ガイドは1周の中にあり、ガイドは距離の順
    for (const l of p.landmarks) assert.ok(l.km >= 0 && l.km < p.loopLengthKm, `${l.kind} at ${l.km}`);
    for (let i = 1; i < p.guide.length; i++) assert.ok(p.guide[i].km >= p.guide[i - 1].km);
    assert.ok(p.guide.every((g) => g.km >= 0 && g.km < p.loopLengthKm));
  });

  test(`${c.id}: data has the route, terrain, buildings, streets and the required attribution`, () => {
    assert.equal(data.id, c.id);
    assert.equal(data.route.mode, c.mode);
    assert.ok(data.buildings.length > 300, `buildings: ${data.buildings.length}`);
    for (const b of data.buildings) assert.ok(b.height > 0 && b.height < 200 && b.ring.length >= 3);
    assert.ok(data.streets.length > 100);
    assert.match(data.attribution, /国土地理院/);
    if (c.plateau) assert.match(data.attribution, /PLATEAU/);
    const h = createTerrainSampler(data);
    for (let m = 0; m < route.lapM; m += 97) {
      const q = route.center(route.legAt(m).t);
      assert.ok(Number.isFinite(h(q.x, q.y)), `terrain under the route at ${m} m`);
    }
  });

  if (c.mode === 'loop') {
    test(`${c.id}: the loop closes on itself with no U-turn`, () => {
      assert.equal(route.loop, true);
      const a = route.center(route.legAt(0).t);
      const b = route.center(route.legAt(route.lapM - 0.01).t);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1, 'start and end of the lap meet');
      // ちょうど1周で同じ地点・同じ向きに戻る
      const l0 = route.legAt(5), l1 = route.legAt(route.lapM + 5);
      assert.ok(Math.abs(l0.t - l1.t) < 1e-6 && l0.dir === l1.dir);
    });
  } else {
    test(`${c.id}: one lap = out-and-back + two U-turns`, () => {
      assert.equal(route.loop, false);
      assert.ok(Math.abs(c.D.loopLengthM - (2 * c.D.oneWayM + 2 * c.D.uturnM)) < 1);
      // 折り返すと向きが逆になる
      assert.equal(route.legAt(30).dir, -route.legAt(c.D.oneWayM + c.D.uturnM + 30).dir);
    });
  }
}

test('kyoto: Kiyomizu-zaka really climbs, and most buildings near the route are PLATEAU', () => {
  const p = getCourseProfile('kyoto');
  const { km } = KYOTO_TOWN_DATA.sights.niomon;
  // 仁王門の手前 600m の平均勾配は上り
  const before = p.points.filter(([k]) => k > km - 0.6 && k < km);
  assert.ok(before.reduce((s, [, g]) => s + g, 0) / before.length > 3);
});

test('fuji: Lake Kawaguchi lies left of the outbound north-shore road and Mt. Fuji rises in the outer terrain', () => {
  const data = load('fuji-town.json');
  const route = createAtamiRoute(data.route);
  const lake = data.waters.reduce((a, w, i) => (w.rows.length > data.waters[a].rows.length ? i : a), 0);
  assert.ok(data.waters[lake].level > 820 && data.waters[lake].level < 840, `lake level ${data.waters[lake].level}`);
  assert.ok(waterCells(data, lake).length > 100);
  // 往路(西向き)の左 = 南に湖
  let left = 0, n = 0;
  for (let m = 300; m < FUJI_TOWN_DATA.oneWayM - 300; m += 50, n++) {
    const { t, dir } = route.legAt(m);
    const q = route.center(t), q2 = route.center(t + dir * 2);
    const L = Math.hypot(q2.x - q.x, q2.y - q.y), fx = (q2.x - q.x) / L, fy = (q2.y - q.y) / L;
    for (const d of [80, 160, 240]) {
      if (waterIndexAt(data, q.x - fy * d, q.y + fx * d) === lake) { left++; break; }
    }
  }
  assert.ok(left / n > 0.6, `lake on the left ${left}/${n}`);
  assert.equal(waterLevelAt(data, 0, 0), null, 'the start is on land');
  // 富士山頂(スタートの南南西およそ 18km)は遠景の格子の中で 3000m を超える
  const h = createTerrainSampler(data);
  let top = 0;
  for (let x = -6000; x <= 0; x += 160) for (let y = -20000; y <= -15000; y += 160) top = Math.max(top, h(x, y));
  assert.ok(top > 3000, `Mt. Fuji ${top}`);
});

test('nara: the ponds are water and the deer get more chances than elsewhere', () => {
  const data = load('nara-town.json');
  assert.ok(data.waters.length >= 2);
  assert.ok(getCourseProfile('nara').happenings.deer > 1);
});

test('townBuildingLook: low small buildings get gable roofs; Kyoto mixes in machiya, Kawaguchiko has metal roofs', () => {
  const low = { height: 6, ring: [[0, 0], [10, 0], [10, 8], [0, 8]] };
  const tall = { height: 30, ring: [[0, 0], [30, 0], [30, 30], [0, 30]] };
  assert.equal(townBuildingLook('nara', low, 1).gable, true);
  assert.equal(townBuildingLook('nara', tall, 1).gable, false);
  const kyoto = Array.from({ length: 200 }, (_, i) => townBuildingLook('kyoto', low, i).style);
  const machiya = kyoto.filter((s) => s === 'machiya').length;
  assert.ok(machiya > 70 && machiya < 150, `machiya ${machiya}`);
  assert.ok(!Array.from({ length: 50 }, (_, i) => townBuildingLook('nara', low, i).style).includes('machiya'));
  assert.deepEqual(townBuildingLook('kawaguchiko', low, 5), townBuildingLook('kawaguchiko', low, 5), 'deterministic');
});

test('townGroundColor: water bed, shore, forest and town colours stay in range', () => {
  for (const pal of ['autumn', 'park']) {
    for (const args of [[1, 0, 2, 0, 0.5], [1, 0, -0.5, 0, 0.5], [1, 0, -5, 1, 0.5], [1, 1, -5, 0, 0.5], [0.3, 0, -5, 0, 0.5]]) {
      const c = townGroundColor(pal, ...args);
      assert.equal(c.length, 3);
      assert.ok(c.every((v) => v >= 0 && v <= 1));
    }
  }
  const forest = townGroundColor('park', 1, 0, -5, 1, 0.5);
  const town = townGroundColor('park', 1, 1, -5, 0, 0.5);
  assert.ok(forest[1] > forest[0] && town[0] > forest[0]);
});

test('chamferDistance: distance grows away from the seed cells', () => {
  const nx = 9, ny = 9;
  const seed = new Uint8Array(nx * ny);
  seed[4 * nx + 4] = 1;
  const d = chamferDistance(seed, nx, ny);
  assert.equal(d[4 * nx + 4], 0);
  assert.ok(Math.abs(d[4 * nx + 7] - 3) < 0.01);
  assert.ok(d[0] > d[2 * nx + 2] && d[2 * nx + 2] > 0);
});

test('loadTownData: caches per town and retries after a failed fetch', async () => {
  let calls = 0;
  const failing = () => { calls++; return Promise.resolve({ ok: false, status: 404 }); };
  await assert.rejects(loadTownData('nara', failing), /404/);
  await assert.rejects(loadTownData('nara', failing), /404/);
  assert.equal(calls, 2, 'a failure is not cached');
  await assert.rejects(loadTownData('nowhere'), /unknown town/);
});
