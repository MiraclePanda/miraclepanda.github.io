import { PhysicsConstants } from './physicsConstants.js';
import { applyCornerLimit } from './cornering.js';
import { DEFAULT_SURFACE, airDragN, extraGradePercent, rollingCrr } from './surfaces.js';

/**
 * 仮想空間の速度・距離・標高を求める物理演算エンジン。
 * Trainer の physicsEngine.js を取り込み、旅向けに変更(設計書3章):
 *  - 質量 = 体重 + 車体 + 荷物。Crr は区間の路面(route.surfaceAtKm)と濡れ具合で決まる
 *  - CdA はバッグ込み(既定 PhysicsConstants.LOADED_CDA)。スコール中は向かい風が入る
 *  - トレーナーへの勾配は trainerGradePercent()(道の勾配 + 旅で増えた抵抗の等価勾配)
 * Trainer から引き継いだ性質:
 *  - パワー・体重・自転車重量・コース傾斜度・転がり抵抗・空気抵抗からの
 *    力の釣り合い＋時間積分で速度・位置を算出(実測速度はUI参考表示のみ)
 *  - パワー0W時も慣性モデルで加減速を継続する
 *  - 速度は0未満にクランプ(逆走なし)
 *  - 標高は明示的な状態として保持する
 *  - 区間に速度の上限(route.speedLimitMpsAt)があればコーナー手前で減速する(cornering.js)
 */
/**
 * 走行中のライダーに働く力(N)を求める。PhysicsEngine.step() の力の釣り合い(テストからも使う)。
 *  - 重力: m·g·sinθ、転がり抵抗: Crr·m·g·cosθ(θ = atan(勾配))
 *  - 空気抵抗: ½·ρ·CdA·(v+w)·|v+w|(w = 向かい風、追い風は負)
 *  - 駆動力: P / max(v, MIN_SPEED_FOR_DRIVE_FORCE)(v=0 の特異点回避)
 * @param {object} p
 * @param {number} p.speedMps
 * @param {number} p.gradePercent
 * @param {number} p.massKg 体重+自転車重量+荷物
 * @param {number} p.crr
 * @param {number} p.cdaM2
 * @param {number} p.powerW
 * @param {number} [p.headwindMps=0] 向かい風(m/s)
 * @returns {{theta:number, fGravity:number, fRolling:number, fAir:number, fDrive:number, netForce:number}}
 */
export function computeForces({ speedMps, gradePercent, massKg, crr, cdaM2, powerW, headwindMps = 0 }) {
  const grade = gradePercent / 100;
  const theta = Math.atan(grade);

  const g = PhysicsConstants.GRAVITY;
  const mass = massKg;

  const fGravity = mass * g * Math.sin(theta);
  const fRolling = crr * mass * g * Math.cos(theta);
  const fAir = airDragN(cdaM2, speedMps, headwindMps);

  const effectiveSpeedForDrive = Math.max(speedMps, PhysicsConstants.MIN_SPEED_FOR_DRIVE_FORCE);
  const fDrive = powerW / effectiveSpeedForDrive;

  const netForce = fDrive - fGravity - fRolling - fAir;
  return { theta, fGravity, fRolling, fAir, fDrive, netForce };
}

export class PhysicsEngine {
  /**
   * @param {object} opts
   * @param {number} opts.riderWeightKg
   * @param {number} opts.bikeWeightKg 車体(荷物なし)
   * @param {number} [opts.packWeightKg=0] 荷物の合計(surfaces.js の packWeightKg)
   * @param {{gradeAtKm:(km:number)=>number, surfaceAtKm?:(km:number)=>string, speedLimitMpsAt?:(km:number)=>number}} opts.route
   *   区間(道の勾配・路面・コーナーの速度上限)。距離はその日のライドの開始地点からの km
   * @param {number} [opts.cdaM2] 省略時は PhysicsConstants.LOADED_CDA
   */
  constructor(opts) {
    this.riderWeightKg = opts.riderWeightKg;
    this.bikeWeightKg = opts.bikeWeightKg;
    this.route = opts.route;
    this.cdaM2 = opts.cdaM2 ?? PhysicsConstants.LOADED_CDA;
    this.setPackWeight(opts.packWeightKg ?? 0);

    this.speedMps = 0;
    this.distanceM = 0; // 走行距離(区間上の距離)
    this.elevationM = 0; // 現在標高(相対値、開始地点=0)
    this.elevationGainM = 0; // 累積獲得標高
    this.currentGradePercent = this.route.gradeAtKm(0);
    this.currentSurface = this._surfaceAt(0);
    this.currentCrr = rollingCrr(this.currentSurface, false);
    this.currentPowerW = 0;
    this._lastForces = { fGravity: 0, fRolling: 0, fAir: 0 };
    // 天候(setConditions)。wet = 雨の後で路面が濡れている、headwindMps = 向かい風
    this.wet = false;
    this.headwindMps = 0;
    // 直近のステップでコーナーのために減速したか(表示用)
    this.cornerBraking = false;
  }

  /** 荷物の重さを変える(食料・水の消費や補給)。不正値は 0。 */
  setPackWeight(kg) {
    this.packWeightKg = Number.isFinite(kg) && kg > 0 ? kg : 0;
    this.totalMassKg = this.riderWeightKg + this.bikeWeightKg + this.packWeightKg;
  }

  /**
   * 天候による条件をセットする。スコールなら headwindMps に PhysicsConstants.SQUALL_HEADWIND_MPS を渡す。
   * @param {{wet?:boolean, headwindMps?:number}} c
   */
  setConditions({ wet = false, headwindMps = 0 } = {}) {
    this.wet = !!wet;
    this.headwindMps = Number.isFinite(headwindMps) ? headwindMps : 0;
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
    const gradePercent = this.route.gradeAtKm(distanceKm);
    this.currentGradePercent = gradePercent;
    this.currentSurface = this._surfaceAt(distanceKm);
    this.currentCrr = rollingCrr(this.currentSurface, this.wet);
    const mass = this.totalMassKg;
    const { theta, fGravity, fRolling, fAir, netForce } = computeForces({
      speedMps: this.speedMps,
      gradePercent,
      massKg: mass,
      crr: this.currentCrr,
      cdaM2: this.cdaM2,
      powerW: this.currentPowerW,
      headwindMps: this.headwindMps,
    });
    const acceleration = netForce / mass;
    this._lastForces = { fGravity, fRolling, fAir };

    let newSpeed = this.speedMps + acceleration * dt;
    newSpeed = clamp(newSpeed, 0, PhysicsConstants.MAX_SPEED_MPS);
    // 区間のコーナーでは、曲がれる速度まで手前からブレーキをかける(cornering.js)。
    // トレーナーへ送る勾配は変えない(ペダルを踏んでいても速度だけが抑えられる)。
    // 1ステップで進む先(高速だと6m以上)の上限も見て、上限区間への進入が1ステップ遅れないようにする。
    const limit = typeof this.route.speedLimitMpsAt === 'function'
      ? Math.min(
        this.route.speedLimitMpsAt(distanceKm),
        this.route.speedLimitMpsAt(distanceKm + (newSpeed * dt) / 1000),
      )
      : Infinity;
    const cornered = applyCornerLimit(this.speedMps, newSpeed, limit, dt);
    newSpeed = cornered.speedMps;
    this.cornerBraking = cornered.braking;

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

  /**
   * Simulation モードでトレーナーへ送る勾配(%): 道の勾配 + 旅で増えた抵抗の等価勾配(surfaces.js)。
   * 上下限のクランプは FtmsClient 側(DeviceProfile)で行う。荷物の分は質量の差として入る。
   */
  trainerGradePercent() {
    return this.currentGradePercent + extraGradePercent({
      speedMps: this.speedMps,
      gradePercent: this.currentGradePercent,
      baseMassKg: this.riderWeightKg + this.bikeWeightKg,
      packKg: this.packWeightKg,
      crr: this.currentCrr,
      cdaM2: this.cdaM2,
      headwindMps: this.headwindMps,
    });
  }

  _surfaceAt(km) {
    return typeof this.route.surfaceAtKm === 'function' ? this.route.surfaceAtKm(km) : DEFAULT_SURFACE;
  }

  _snapshot() {
    return {
      speedMps: this.speedMps,
      speedKmh: this.speedMps * 3.6,
      distanceM: this.distanceM,
      elevationM: this.elevationM,
      elevationGainM: this.elevationGainM,
      gradePercent: this.currentGradePercent,
      surface: this.currentSurface,
      crr: this.currentCrr,
      cornerBraking: this.cornerBraking,
    };
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
