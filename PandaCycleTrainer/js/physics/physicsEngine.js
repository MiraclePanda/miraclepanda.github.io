import { PhysicsConstants } from './physicsConstants.js';

/**
 * 仮想空間の速度・距離・標高を求める物理演算エンジン。
 * 要件定義書3章に対応:
 *  - パワー・体重・自転車重量・コース傾斜度・転がり抵抗・空気抵抗からの
 *    力の釣り合い＋時間積分で速度・位置を算出(実測速度はUI参考表示のみ)
 *  - パワー0W時も慣性モデルで加減速を継続する
 *  - 速度は0未満にクランプ(逆走なし)
 *  - 標高は明示的な状態として保持する
 */
export class PhysicsEngine {
  /**
   * @param {object} opts
   * @param {number} opts.riderWeightKg
   * @param {number} opts.bikeWeightKg
   * @param {CourseEngine} opts.courseEngine
   */
  constructor(opts) {
    this.riderWeightKg = opts.riderWeightKg;
    this.bikeWeightKg = opts.bikeWeightKg;
    this.courseEngine = opts.courseEngine;

    this.totalMassKg = this.riderWeightKg + this.bikeWeightKg;
    this.speedMps = 0;
    this.distanceM = 0; // 走行距離(コース上の距離)
    this.elevationM = 0; // 現在標高(相対値、開始地点=0)
    this.elevationGainM = 0; // 累積獲得標高
    this.currentGradePercent = this.courseEngine.gradeAtKm(0);
    this.currentPowerW = 0;
    this._lastForces = { fGravity: 0, fRolling: 0, fAir: 0 };
  }

  /** 直近のBLE受信パワー値をセットする(ティックごとに使い回される)。 */
  setCurrentPower(watts) {
    this.currentPowerW = watts ?? 0;
  }

  /**
   * dt秒分の物理演算を1ステップ進める。requestAnimationFrame等から
   * 高頻度で呼び出すことを想定。
   * @param {number} dtSeconds
   * @returns {{speedMps:number, distanceM:number, elevationM:number, gradePercent:number}}
   */
  step(dtSeconds) {
    if (dtSeconds <= 0 || !Number.isFinite(dtSeconds)) {
      return this._snapshot();
    }
    // 大きすぎるdt(タブが非アクティブだった等)は物理破綻防止のため丸める。
    const dt = Math.min(dtSeconds, 0.25);

    const distanceKm = this.distanceM / 1000;
    const gradePercent = this.courseEngine.gradeAtKm(distanceKm);
    this.currentGradePercent = gradePercent;
    const grade = gradePercent / 100;
    const theta = Math.atan(grade);

    const g = PhysicsConstants.GRAVITY;
    const mass = this.totalMassKg;

    const fGravity = mass * g * Math.sin(theta);
    const fRolling = PhysicsConstants.CRR * mass * g * Math.cos(theta);
    const relativeAirSpeed = Math.max(0, this.speedMps - PhysicsConstants.WIND_SPEED_MPS);
    const fAir = 0.5 * PhysicsConstants.AIR_DENSITY * PhysicsConstants.CDA * relativeAirSpeed * relativeAirSpeed;

    const effectiveSpeedForDrive = Math.max(this.speedMps, PhysicsConstants.MIN_SPEED_FOR_DRIVE_FORCE);
    const fDrive = this.currentPowerW / effectiveSpeedForDrive;

    const netForce = fDrive - fGravity - fRolling - fAir;
    const acceleration = netForce / mass;
    this._lastForces = { fGravity, fRolling, fAir };

    let newSpeed = this.speedMps + acceleration * dt;
    newSpeed = clamp(newSpeed, 0, PhysicsConstants.MAX_SPEED_MPS);

    const distanceDeltaM = newSpeed * dt;
    const elevationDeltaM = distanceDeltaM * Math.sin(theta);

    this.speedMps = newSpeed;
    this.distanceM += distanceDeltaM;
    this.elevationM += elevationDeltaM;
    if (elevationDeltaM > 0) {
      this.elevationGainM += elevationDeltaM;
    }

    return this._snapshot();
  }

  /**
   * ERGモード用: 現在のgradeを走行する際に必要な目標パワー(W)を逆算する。
   * 停止付近では基準速度(ERG_REFERENCE_SPEED_MPS)を用いて0張り付きを回避する。
   * 注: ERGモードでの負荷換算式は実機未検証の暫定仕様(要件定義書8章)。
   */
  computeErgTargetWatts() {
    const referenceSpeed = Math.max(this.speedMps, PhysicsConstants.ERG_REFERENCE_SPEED_MPS);
    const { fGravity, fRolling, fAir } = this._lastForces;
    const watts = (fGravity + fRolling + fAir) * referenceSpeed;
    return Math.max(0, watts);
  }

  _snapshot() {
    return {
      speedMps: this.speedMps,
      speedKmh: this.speedMps * 3.6,
      distanceM: this.distanceM,
      elevationM: this.elevationM,
      elevationGainM: this.elevationGainM,
      gradePercent: this.currentGradePercent,
    };
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
