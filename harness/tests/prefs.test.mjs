import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// localStorage のスタブ(Node には無いのでテスト内で用意する)
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const prefs = await import('../../PandaCycleTrainer/js/storage/prefs.js');

beforeEach(() => localStorage.clear());

test('prefs: existing pct_prefs_v1 data keeps loading; ftpW defaults to 200', () => {
  localStorage.setItem(
    'pct_prefs_v1',
    JSON.stringify({ distanceKm: 20, weightKg: 65, bikeWeightKg: 9, crr: 0.004, cdaM2: 0.32, vehicle: 'swan' }),
  );
  const p = prefs.loadPrefs();
  assert.deepEqual(p, { distanceKm: 20, weightKg: 65, bikeWeightKg: 9, crr: 0.004, cdaM2: 0.32, vehicle: 'swan', ftpW: 200 });
  assert.equal(prefs.loadPrefs().ftpW, 200);
  localStorage.clear();
  assert.equal(prefs.loadPrefs().ftpW, 200);
  assert.equal(prefs.loadPrefs().distanceKm, undefined);
});

test('prefs: ftpW round-trips, invalid values fall back to the default, legacy save keeps ftpW', () => {
  prefs.savePrefs({ distanceKm: 10, weightKg: 70, bikeWeightKg: 8, crr: 0.005, cdaM2: 0.3, vehicle: 'bike', ftpW: 250 });
  assert.equal(prefs.loadPrefs().ftpW, 250);
  assert.equal(prefs.loadPrefs().distanceKm, 10);
  // ftpW を渡さない従来の呼び出し方でも保存済みの FTP は消えない
  prefs.savePrefs({ distanceKm: 12, weightKg: 70, bikeWeightKg: 8, crr: 0.005, cdaM2: 0.3, vehicle: 'bike' });
  assert.equal(prefs.loadPrefs().ftpW, 250);
  assert.equal(prefs.loadPrefs().distanceKm, 12);
  for (const bad of [10, 9999, 'abc', null]) {
    localStorage.setItem('pct_prefs_v1', JSON.stringify({ distanceKm: 5, ftpW: bad }));
    assert.equal(prefs.loadPrefs().ftpW, 200, String(bad));
  }
  localStorage.setItem('pct_prefs_v1', '{broken');
  assert.equal(prefs.loadPrefs().ftpW, 200);
});

test('prefs: environment / camera view / pack toggle defaults and validation', () => {
  assert.deepEqual(prefs.loadEnvironment(), { time: 'noon', weather: 'clear' });
  prefs.saveEnvironment({ time: 'night', weather: 'rain' });
  assert.deepEqual(prefs.loadEnvironment(), { time: 'night', weather: 'rain' });
  localStorage.setItem('pct_environment_v1', JSON.stringify({ time: 'midnight', weather: 'fog' }));
  assert.deepEqual(prefs.loadEnvironment(), { time: 'noon', weather: 'fog' });
  localStorage.setItem('pct_environment_v1', 'xx');
  assert.deepEqual(prefs.loadEnvironment(), { time: 'noon', weather: 'clear' });

  assert.equal(prefs.loadCameraView(), 'chase');
  prefs.saveCameraView('cine');
  assert.equal(prefs.loadCameraView(), 'cine');
  prefs.saveCameraView('drone');
  assert.equal(prefs.loadCameraView(), 'cine');
  localStorage.setItem('pct_camera_view_v1', 'drone');
  assert.equal(prefs.loadCameraView(), 'chase');

  assert.equal(prefs.loadPackEnabled(), true);
  prefs.savePackEnabled(false);
  assert.equal(prefs.loadPackEnabled(), false);
  prefs.savePackEnabled(true);
  assert.equal(prefs.loadPackEnabled(), true);
});

test('prefs: ghost selection keeps up to 2 unique string ids', () => {
  assert.deepEqual(prefs.loadGhostSelection(), []);
  prefs.saveGhostSelection(['pb', 'pb', 3, 'fg_a', 'fg_b']);
  assert.deepEqual(prefs.loadGhostSelection(), ['pb', 'fg_a']);
  localStorage.setItem('pct_ghost_selection_v1', '"pb"');
  assert.deepEqual(prefs.loadGhostSelection(), []);
});

test('prefs: friend ghosts are kept per course, max 3, oldest dropped first', () => {
  const mk = (name, courseId) => ({ name, courseId, points: Float64Array.from([0, 0, 10, 55.55, 20, 120]) });
  const ids = ['g1', 'g2', 'g3', 'g4'].map((n) => prefs.saveFriendGhost(mk(n, 'city')));
  const otherId = prefs.saveFriendGhost(mk('o1', 'lake'));
  assert.ok(ids.every((id) => typeof id === 'string' && id !== 'pb'));
  assert.equal(new Set(ids).size, 4);

  const city = prefs.loadFriendGhosts('city');
  assert.equal(city.length, 3);
  assert.deepEqual(city.map((g) => g.name).sort(), ['g2', 'g3', 'g4']);
  assert.ok(city[0].points instanceof Float64Array);
  assert.deepEqual(Array.from(city.find((g) => g.name === 'g4').points), [0, 0, 10, 55.6, 20, 120]);
  assert.equal(prefs.loadFriendGhosts('lake').length, 1);
  assert.equal(prefs.loadFriendGhosts().length, 4);

  // 保存形式は通常配列
  const stored = JSON.parse(localStorage.getItem('pct_friend_ghosts_v1'));
  assert.ok(Array.isArray(stored[0].points));

  // 削除するとゴースト選択からも外れる
  prefs.saveGhostSelection(['pb', otherId]);
  prefs.deleteFriendGhost(otherId);
  assert.equal(prefs.loadFriendGhosts('lake').length, 0);
  assert.deepEqual(prefs.loadGhostSelection(), ['pb']);

  // courseId がないもの・点がないものは保存しない
  assert.equal(prefs.saveFriendGhost({ name: 'x', courseId: null, points: Float64Array.from([0, 0]) }), null);
  assert.equal(prefs.saveFriendGhost({ name: 'x', courseId: 'city', points: new Float64Array(0) }), null);
});
