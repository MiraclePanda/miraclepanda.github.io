// 走行セッション: 走行の時間の数え方・物理を進める刻み・毎秒の記録・走行記録の組み立て(レビュー Q5)。
//
// 画面(RideScreen)から切り出した、DOM・React・BLE に依存しない部分。時刻は呼び出し側が渡す
// (Date.now() の ms)ので、Node で時間を進めながらテストできる。
//
// - 時間: 経過時間(休憩含む)・走行時間(一時停止を除く)・ゴースト用の走行時間(さらにゴールの
//   ダイアログを開いていた時間も除く)。要件定義書5章の「経過時間と走行時間を分けて表示」。
// - 刻み: 前のフレームからの時間を STEP_MAX_S 以下に等分して物理を何回か進める(splitSteps)。
//   以前は1フレームに1回だけ進め、PhysicsEngine の dt 上限(0.25 秒)で切り捨てていたので、
//   フレームが遅い・タブが裏に回って描画が止まると、走行時間は進むのに距離が進まなかった(レビュー Q2)。
//   裏に回っている間は画面側がタイマーで呼ぶ(ブラウザが間隔を延ばしても、空いた分を刻んで追いつく)。
// - 記録: 走行時間の1秒ごとに1サンプル(物理を進めた刻みの中で取るので、裏にあっても抜けない)。

/** 物理を1回に進める時間の上限(秒)。PhysicsEngine の dt 上限と同じ。 */
export const STEP_MAX_S = 0.25;
/** 1回で追いつく時間の上限(秒)。これより長く空いた分(端末のスリープなど)は進めない。 */
export const CATCH_UP_MAX_S = 120;
/** 毎秒の記録の間隔(ms)。 */
export const SAMPLE_INTERVAL_MS = 1000;

/**
 * dt 秒を STEP_MAX_S 以下に等分した刻みの数と1刻みの長さ。dt が CATCH_UP_MAX_S を超えたら進めない(0 刻み)。
 * @returns {{ count: number, stepS: number }}
 */
export function splitSteps(dtS) {
  if (!Number.isFinite(dtS) || dtS <= 0 || dtS > CATCH_UP_MAX_S) return { count: 0, stepS: 0 };
  const count = Math.ceil(dtS / STEP_MAX_S - 1e-9);
  return { count, stepS: dtS / count };
}

export class RideSession {
  /** @param {number} nowMs 作った時刻(準備ができたら start() で数え直す) */
  constructor(nowMs) {
    this.startMs = nowMs;
    this.totalPausedMs = 0;
    this.pauseStartedAt = null;
    this.totalGoalPausedMs = 0;
    this.goalPauseStartedAt = null;
    this.samples = [];
    this.nextSampleMs = null;
    this.workJ = 0;
  }

  /** 走行を始める(景色の準備ができた時点を 0 にする)。 */
  start(nowMs) {
    this.startMs = nowMs;
    this.totalPausedMs = 0;
    this.pauseStartedAt = null;
    this.nextSampleMs = nowMs + SAMPLE_INTERVAL_MS;
  }

  get isPausedClock() {
    return this.pauseStartedAt !== null;
  }

  pause(nowMs) {
    if (this.pauseStartedAt === null) this.pauseStartedAt = nowMs;
  }

  resume(nowMs) {
    if (this.pauseStartedAt === null) return;
    this.totalPausedMs += nowMs - this.pauseStartedAt;
    this.pauseStartedAt = null;
    // 止まっていた間の分のサンプルは取らない(再開から1秒後に次を取る)
    this.nextSampleMs = nowMs + SAMPLE_INTERVAL_MS;
  }

  /** ゴールのダイアログを開いた(走行時間は進むが、ゴーストの時間は止める)。 */
  goalPause(nowMs) {
    if (this.goalPauseStartedAt === null) this.goalPauseStartedAt = nowMs;
  }

  goalResume(nowMs) {
    if (this.goalPauseStartedAt === null) return;
    this.totalGoalPausedMs += nowMs - this.goalPauseStartedAt;
    this.goalPauseStartedAt = null;
    // ダイアログを開いていた間のサンプルは取らない(再開から1秒後に次を取る)
    this.nextSampleMs = nowMs + SAMPLE_INTERVAL_MS;
  }

  elapsedS(nowMs) {
    return Math.max(0, (nowMs - this.startMs) / 1000);
  }

  ridingS(nowMs) {
    const paused = this.totalPausedMs + (this.pauseStartedAt !== null ? nowMs - this.pauseStartedAt : 0);
    return Math.max(0, (nowMs - this.startMs - paused) / 1000);
  }

  /** ゴースト再生・サンプルの rideTimeS 用: 走行時間 − ゴールのダイアログを開いていた時間。 */
  ghostS(nowMs) {
    const goal = this.totalGoalPausedMs + (this.goalPauseStartedAt !== null ? nowMs - this.goalPauseStartedAt : 0);
    return Math.max(0, this.ridingS(nowMs) - goal / 1000);
  }

  /** ペダルを回した仕事量を足す(負のパワーは数えない)。 */
  addWork(powerW, dtS) {
    if (Number.isFinite(powerW) && powerW > 0 && Number.isFinite(dtS) && dtS > 0) this.workJ += powerW * dtS;
  }

  /**
   * 刻みの時刻 tMs が次の記録の時刻を過ぎていたら、そのときの値でサンプルを1つ取る。
   * @param {number} tMs
   * @param {{powerW:number|null, speedKmh:number, cadenceRpm:number|null,
   *   elevationM:number, gradePercent:number, distanceM:number}} v
   */
  maybeSample(tMs, v) {
    if (this.nextSampleMs === null || tMs < this.nextSampleMs) return false;
    const s = {
      tOffsetS: this.elapsedS(tMs),
      powerW: v.powerW ?? 0,
      speedKmh: v.speedKmh,
      cadenceRpm: v.cadenceRpm ?? 0,
      elevationM: v.elevationM,
      gradePercent: v.gradePercent,
      distanceM: v.distanceM,
      rideTimeS: this.ghostS(tMs),
    };
    this.samples.push(s);
    // 1刻みに1サンプルまで(追いつく刻みは 0.25 秒なので、裏にあった間も1秒ごとに取れる)
    this.nextSampleMs += SAMPLE_INTERVAL_MS;
    if (this.nextSampleMs <= tMs) this.nextSampleMs = tMs + SAMPLE_INTERVAL_MS;
    return true;
  }

  /**
   * 走行記録(IndexedDB に保存する形)を組み立てる。
   * @param {number} nowMs
   * @param {{courseId:string, courseName:string, goalDistanceKm:number, totalDistanceM:number, elevationGainM:number}} info
   */
  toRecord(nowMs, info) {
    const samples = this.samples.slice();
    return {
      courseId: info.courseId,
      courseName: info.courseName,
      goalDistanceKm: info.goalDistanceKm,
      startTime: this.startMs,
      endTime: nowMs,
      elapsedTimeS: this.elapsedS(nowMs),
      ridingTimeS: this.ridingS(nowMs),
      totalDistanceM: info.totalDistanceM,
      elevationGainM: info.elevationGainM,
      avgPowerW: average(samples.map((s) => s.powerW)),
      avgSpeedKmh: average(samples.map((s) => s.speedKmh)),
      avgCadenceRpm: average(samples.map((s) => s.cadenceRpm)),
      // ペダルを回した仕事量(kJ)。消費カロリーのグルメ換算に使う
      workKj: this.workJ / 1000,
      samples,
    };
  }
}

function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + (b ?? 0), 0) / arr.length;
}
