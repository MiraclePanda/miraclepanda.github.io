import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectVisibleOthers, ghostLabelText, OTHERS_BEHIND_M, OTHERS_AHEAD_M, MAX_PACK, MAX_GHOSTS, LOW_QUALITY_MAX_PACK,
} from '../../PandaCycleTrainer/js/three/otherRidersLayout.js';

const rider = (id, kind, distanceM, extra = {}) => ({ id, kind, distanceM, laneOffsetM: 0, speedKmh: 30, color: '#123456', label: id, ...extra });

test('only riders from 40 m behind to 300 m ahead are drawn', () => {
  assert.equal(OTHERS_BEHIND_M, 40);
  assert.equal(OTHERS_AHEAD_M, 300);
  const me = 1000;
  const others = [
    rider('a', 'pack', me - 40.01), rider('b', 'pack', me - 40), rider('c', 'pack', me + 300),
    rider('d', 'pack', me + 300.01), rider('g1', 'ghost', me - 41), rider('g2', 'ghost', me + 120),
  ];
  const sel = selectVisibleOthers(others, me);
  assert.deepEqual(sel.pack.map((e) => e.other.id), ['b', 'c']);
  assert.deepEqual(sel.ghosts.map((e) => e.other.id), ['g2']);
  assert.equal(sel.ghosts[0].gapM, 120);
});

test('nearest first, up to 5 pack riders and 2 ghosts (2 pack riders on low quality)', () => {
  assert.equal(MAX_PACK, 5);
  assert.equal(MAX_GHOSTS, 2);
  assert.equal(LOW_QUALITY_MAX_PACK, 2);
  const me = 500;
  const others = [
    rider('p1', 'pack', me + 90), rider('p2', 'pack', me - 5), rider('p3', 'pack', me + 30), rider('p4', 'pack', me + 3),
    rider('p5', 'pack', me + 200), rider('p6', 'pack', me - 30), rider('g1', 'ghost', me + 50), rider('g2', 'ghost', me - 2),
    rider('g3', 'ghost', me + 10),
  ];
  const sel = selectVisibleOthers(others, me);
  assert.deepEqual(sel.pack.map((e) => e.other.id), ['p4', 'p2', 'p3', 'p6', 'p1']);
  assert.deepEqual(sel.ghosts.map((e) => e.other.id), ['g2', 'g3']);
  const low = selectVisibleOthers(others, me, { maxPack: LOW_QUALITY_MAX_PACK });
  assert.deepEqual(low.pack.map((e) => e.other.id), ['p4', 'p2']);
});

test('bad input is ignored (no others, unknown kind, non-finite distance)', () => {
  assert.deepEqual(selectVisibleOthers(undefined, 0), { ghosts: [], pack: [] });
  assert.deepEqual(selectVisibleOthers([], 0), { ghosts: [], pack: [] });
  const sel = selectVisibleOthers([null, rider('x', 'car', 10), rider('y', 'pack', NaN), rider('z', 'pack', 10)], 0);
  assert.deepEqual(sel.pack.map((e) => e.other.id), ['z']);
  assert.equal(sel.ghosts.length, 0);
});

test('ghost labels show the name, with 記録終了 once the recorded ride has ended', () => {
  assert.equal(ghostLabelText({ label: '自己ベスト', finished: false }), '自己ベスト');
  assert.equal(ghostLabelText({ label: 'たろう', finished: true }), 'たろう(記録終了)');
  assert.equal(ghostLabelText({}), 'ゴースト');
});

test('a scene can narrow the behind range (CityScene builds the road only 20 m behind)', () => {
  const me = 100;
  const others = [rider('a', 'pack', me - 19), rider('b', 'pack', me - 21), rider('g', 'ghost', me - 30), rider('c', 'pack', me + 299)];
  const sel = selectVisibleOthers(others, me, { behindM: 20 });
  assert.deepEqual(sel.pack.map((e) => e.other.id), ['a', 'c']);
  assert.equal(sel.ghosts.length, 0);
  // 既定より広げることはできない
  assert.deepEqual(selectVisibleOthers([rider('d', 'pack', me - 41)], me, { behindM: 100 }).pack, []);
});
