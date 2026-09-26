import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandQueue } from '../../PandaCycleTrainer/js/ble/commandQueue.js';
import { DeviceProfile } from '../../PandaCycleTrainer/js/ble/deviceProfile.js';

test('コマンドは直列に実行される', async () => {
  const q = new CommandQueue({ retryDelayMs: 1 });
  const log = [];
  const task = (id, ms) => async () => {
    log.push(`start${id}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end${id}`);
    return id;
  };
  const results = await Promise.all([q.enqueue(task(1, 10)), q.enqueue(task(2, 1))]);
  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(log, ['start1', 'end1', 'start2', 'end2']);
});

test('失敗はリトライされ、上限で破棄される', async () => {
  let discarded = 0;
  const q = new CommandQueue({ maxRetries: 3, retryDelayMs: 1, onCommandDiscarded: () => discarded++ });
  let calls = 0;
  await assert.rejects(q.enqueue(async () => { calls++; throw new Error('x'); }));
  assert.equal(calls, 3);
  assert.equal(discarded, 1);
});

test('enqueueLatest は未実行の同一keyコマンドを置き換える', async () => {
  const q = new CommandQueue({ retryDelayMs: 1 });
  const sent = [];
  const blocker = q.enqueue(() => new Promise((r) => setTimeout(r, 10)));
  const a = q.enqueueLatest('grade', async () => sent.push(1));
  const b = q.enqueueLatest('grade', async () => sent.push(2));
  await assert.rejects(a, /superseded/);
  await Promise.all([blocker, b]);
  assert.deepEqual(sent, [2]);
});

test('DeviceProfile の範囲値が自己矛盾していない', () => {
  assert.ok(DeviceProfile.GRADE_MIN_PERCENT < 0 && DeviceProfile.GRADE_MAX_PERCENT > 0);
  assert.ok(DeviceProfile.ERG_MIN_WATTS < DeviceProfile.ERG_MAX_WATTS);
  assert.ok(DeviceProfile.COMMAND_MAX_RETRIES >= 1);
});
