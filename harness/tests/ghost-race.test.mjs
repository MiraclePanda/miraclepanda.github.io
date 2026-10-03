import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareGhosts, stepGhosts, overtakeToast, ghostSummary, GHOST_COLORS } from '../../PandaCycleTrainer/js/ui/ghostRace.js';

// 10 m/s で 100 秒走るトラック
const track = (id, name) => ({ id, name, points: Float64Array.from([0, 0, 100, 1000]) });

test('prepareGhosts: up to 2 ghosts, PB/friend colors, lanes on either side of the rider', () => {
  const g = prepareGhosts([track('pb', '自己ベスト'), track('fg_1', 'ケンタ'), track('fg_2', 'ミカ')]);
  assert.equal(g.length, 2);
  assert.equal(g[0].color, GHOST_COLORS.pb);
  assert.equal(g[1].color, GHOST_COLORS.friend);
  assert.ok(g[0].laneOffsetM < 0 && g[1].laneOffsetM > 0);
  assert.deepEqual(prepareGhosts(null), []);
});

test('stepGhosts: gap in m and s, finished after the end of the track, others for the scene', () => {
  const g = prepareGhosts([track('pb', '自己ベスト')]);
  const r = stepGhosts(g, 10, { distanceM: 80, speedMps: 10 });
  assert.equal(r.ghosts[0].gapM, 20);
  assert.equal(r.ghosts[0].gapS, 2);
  assert.equal(r.ghosts[0].ahead, true);
  assert.equal(r.others[0].kind, 'ghost');
  assert.equal(r.others[0].distanceM, 100);
  assert.ok(Math.abs(r.others[0].speedKmh - 36) < 1e-9);
  // 秒差は自分の速度 2m/s を下限に計算する
  assert.equal(stepGhosts(g, 10, { distanceM: 80, speedMps: 0 }).ghosts[0].gapS, 10);
  const end = stepGhosts(g, 150, { distanceM: 900, speedMps: 10 });
  assert.equal(end.ghosts[0].finished, true);
  assert.equal(end.others[0].distanceM, 1000, 'the ghost stops at the end of its record');
  assert.equal(end.others[0].speedKmh, 0);
});

test('stepGhosts: passing needs a sign change and 2m of separation; no repeat within 10 s', () => {
  const g = prepareGhosts([track('pb', '自己ベスト')]);
  // ゴーストが 3m 前 → 最初の確定(通知なし)
  assert.equal(stepGhosts(g, 10, { distanceM: 97, speedMps: 10 }).events.length, 0);
  // 1m 抜いただけでは確定しない
  assert.equal(stepGhosts(g, 11, { distanceM: 111, speedMps: 10 }).events.length, 0);
  // 2m 離れたら「抜いた」
  const ev = stepGhosts(g, 12, { distanceM: 122, speedMps: 10 }).events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'passed');
  assert.match(overtakeToast(ev[0]).title, /自己ベストを抜きました/);
  // 10秒以内に抜き返されても通知しない
  assert.equal(stepGhosts(g, 15, { distanceM: 140, speedMps: 10 }).events.length, 0);
  // 10秒後以降、再び抜くと通知する(直前の確定は「ゴーストが前」)
  const ev2 = stepGhosts(g, 23, { distanceM: 235, speedMps: 10 }).events;
  assert.equal(ev2.length, 1);
  assert.equal(ev2[0].kind, 'passed');
  const ev3 = stepGhosts(g, 40, { distanceM: 380, speedMps: 10 }).events;
  assert.equal(ev3[0].kind, 'passedBy');
  assert.match(overtakeToast(ev3[0]).title, /自己ベストに抜かれました/);
});

test('ghostSummary: one line for the dashboard, empty without ghosts', () => {
  assert.equal(ghostSummary([]), '');
  assert.equal(
    ghostSummary([{ name: '自己ベスト', gapM: -12.4, gapS: -1.24, ahead: false, finished: false }, { name: 'ケンタ', gapM: 30, gapS: 3, ahead: true, finished: true }]),
    'ゴースト: 自己ベスト −1.2s(12m 後方) / ケンタ +3.0s(30m 前方・記録終了)'
  );
});

test('ghostTimeS: the time spent on the goal dialog is excluded (while open and after continuing)', async () => {
  const { ghostTimeS } = await import('../../PandaCycleTrainer/js/ui/ghostRace.js');
  assert.equal(ghostTimeS({ ridingTimeS: 30, totalGoalPausedMs: 0, goalPauseStartedAt: null, nowMs: 0 }), 30);
  // ダイアログを開いて 8 秒(走行時間は進むが、ゴースト用の時間は止まる)
  assert.equal(ghostTimeS({ ridingTimeS: 38, totalGoalPausedMs: 0, goalPauseStartedAt: 1000, nowMs: 9000 }), 30);
  // 続けたあと 5 秒
  assert.equal(ghostTimeS({ ridingTimeS: 43, totalGoalPausedMs: 8000, goalPauseStartedAt: null, nowMs: 20000 }), 35);
  assert.equal(ghostTimeS({ ridingTimeS: 1, totalGoalPausedMs: 5000, goalPauseStartedAt: null, nowMs: 0 }), 0);
});
