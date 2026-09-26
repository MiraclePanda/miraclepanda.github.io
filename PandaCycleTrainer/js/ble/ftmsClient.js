import * as C from './ftmsConstants.js';
import { DeviceProfile } from './deviceProfile.js';
import { CommandQueue } from './commandQueue.js';
import { ValidationLimits, PhysicsConstants } from '../physics/physicsConstants.js';

/**
 * CYCPLUS DC1 (およびFTMS準拠スマートトレーナー全般) との
 * BLE通信を担うクライアント。
 *
 * 実装方針は要件定義書2章・3章・8章に準拠:
 *  - Simulation Mode優先、非対応時はERGモードへフォールバック
 *  - Basic Resistance Modeのみの場合は非対応として扱う
 *  - 接続確立時は Request Control -> (必要なら)Start or Resume
 *    -> 初回パラメータ送信、の順序を厳守
 *  - Control Point操作はコマンドキュー化して逐次実行
 *  - gradeは変化量が閾値を超えた時のみ再送信
 */
export class FtmsClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.controlPointChar = null;
    this.indoorBikeDataChar = null;

    this.controlMode = null; // 'simulation' | 'erg' | null
    this.supportedFeatures = null;

    this.lastSentGradePercent = null;
    this.lastSentErgWatts = null;
    this.prePauseTarget = null; // { mode, value } 一時停止前の目標値
    this.isPaused = false;

    this._pendingControlResponse = null;
    this._lastValidSample = null;

    this.queue = new CommandQueue({
      maxRetries: DeviceProfile.COMMAND_MAX_RETRIES,
      retryDelayMs: DeviceProfile.COMMAND_RETRY_DELAY_MS,
      onCommandError: (err, attempt) => {
        this._emit('command-error', { err, attempt });
      },
      onCommandDiscarded: (meta, err) => {
        this._emit('communication-warning', { warning: true, meta, err });
      },
      onCommandRecovered: () => {
        this._emit('communication-warning', { warning: false });
      },
    });

    this._onDisconnected = this._onDisconnected.bind(this);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get isConnected() {
    return !!(this.server && this.server.connected);
  }

  /**
   * デバイス選択ダイアログを表示し、FTMS対応デバイスへ接続する。
   * 要件定義書1章「毎回の走行開始時にネイティブのデバイス選択ダイアログを表示し、
   * 手動選択する(getDevices()等の自動再接続機能は使わない)」に対応。
   */
  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('このブラウザはWeb Bluetooth APIに対応していません。');
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [C.FTMS_SERVICE] }],
      optionalServices: [
        C.USER_DATA_SERVICE,
        C.CYCLING_POWER_SERVICE,
        C.CSC_SERVICE,
      ],
    });

    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);

    this.server = await this.device.gatt.connect();
    const ftmsService = await this.server.getPrimaryService(C.FTMS_SERVICE);

    // Fitness Machine Feature を読み、対応モードを判定する。
    try {
      const featureChar = await ftmsService.getCharacteristic(C.CHAR_FTMS_FEATURE);
      const featureValue = await featureChar.readValue();
      this.supportedFeatures = this._parseFeature(featureValue);
    } catch (e) {
      // Featureが読めない機種も存在しうるため、読めない場合は
      // Control Point送信時のレスポンスコードで実質的に判定する。
      this.supportedFeatures = null;
      this._emit('warning', { message: 'Fitness Machine Featureの読み取りに失敗しました。' });
    }

    this.controlMode = this._decideControlMode(this.supportedFeatures);
    if (this.controlMode === 'unsupported') {
      await this.disconnect();
      throw new Error(
        'このトレーナーはSimulation Mode/ERGモードのいずれにも対応していないため、本アプリの対象外です。'
      );
    }

    // Indoor Bike Data の購読
    this.indoorBikeDataChar = await ftmsService.getCharacteristic(C.CHAR_INDOOR_BIKE_DATA);
    await this.indoorBikeDataChar.startNotifications();
    this.indoorBikeDataChar.addEventListener('characteristicvaluechanged', (ev) => {
      const sample = this._parseIndoorBikeData(ev.target.value);
      this._emit('bike-data', sample);
    });

    // Control Point の購読 (indicateで応答を受け取る)
    this.controlPointChar = await ftmsService.getCharacteristic(C.CHAR_FTMS_CONTROL_POINT);
    await this.controlPointChar.startNotifications();
    this.controlPointChar.addEventListener('characteristicvaluechanged', (ev) => {
      this._handleControlPointResponse(ev.target.value);
    });

    // 接続確立シーケンス: Request Control -> Start or Resume -> 初回パラメータ
    await this.queue.enqueue(() => this._requestControl(), { name: 'request-control' });
    await this.queue.enqueue(() => this._startOrResume(), { name: 'start-or-resume' });

    // Simulation Mode優先で初回パラメータを送信し、拒否された場合はERGへフォールバックする。
    // Basic Resistance Modeのみの機種は、ERGも拒否されるため最終的にunsupportedとして扱う。
    if (this.controlMode === 'simulation') {
      try {
        await this.queue.enqueue(() => this._sendSimulationParams(0), { name: 'initial-sim' });
        this.lastSentGradePercent = 0;
      } catch (e) {
        this._emit('warning', { message: 'Simulation Modeが拒否されたため、ERGモードにフォールバックします。' });
        this.controlMode = 'erg';
      }
    }
    if (this.controlMode === 'erg') {
      try {
        await this.queue.enqueue(() => this._sendErgTarget(0), { name: 'initial-erg' });
        this.lastSentErgWatts = 0;
      } catch (e) {
        await this.disconnect();
        throw new Error(
          'このトレーナーはSimulation Mode/ERGモードのいずれにも対応していないため(Basic Resistance Modeのみの可能性があります)、本アプリの対象外です。'
        );
      }
    }
    this._emit('control-mode', { mode: this.controlMode });

    // User Data Service (体重書き込み) はベストエフォート。失敗しても致命的ではない。
    this._emit('connected', { deviceName: this.device.name ?? '(不明なデバイス)' });
    return { deviceName: this.device.name, controlMode: this.controlMode };
  }

  async disconnect() {
    this.queue.clear();
    try {
      if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
    } catch (e) {
      /* noop */
    }
  }

  _onDisconnected() {
    this._emit('disconnected', {});
  }

  _parseFeature(dataView) {
    const fitnessFeatures = dataView.getUint32(0, true);
    const targetSettingFeatures = dataView.getUint32(4, true);
    return {
      simulationSupported: C.bitSet(targetSettingFeatures, C.TARGET_SIMULATION_SUPPORTED),
      powerTargetSupported: C.bitSet(targetSettingFeatures, C.TARGET_POWER_SUPPORTED),
      resistanceTargetSupported: C.bitSet(targetSettingFeatures, C.TARGET_RESISTANCE_SUPPORTED),
      powerMeasurementSupported: C.bitSet(fitnessFeatures, C.FEATURE_POWER_MEASUREMENT),
      cadenceSupported: C.bitSet(fitnessFeatures, C.FEATURE_CADENCE_SUPPORTED),
    };
  }

  /**
   * 制御モードの優先順位判定。
   * Simulation Mode優先 -> ERGモードへフォールバック
   * -> Basic Resistance Modeのみの場合はサポート対象外。
   */
  _decideControlMode(features) {
    if (!features) {
      // Featureが読めなかった場合はSimulationを楽観的に試み、
      // Control Point応答がOpCode非対応であればERGにフォールバックする
      // (フォールバックは実際の応答を見てから_sendSimulationParamsの
      //  呼び出し元で処理する運用とし、ここではsimulationを仮決定する)。
      return 'simulation';
    }
    if (features.simulationSupported) return 'simulation';
    if (features.powerTargetSupported) return 'erg';
    return 'unsupported';
  }

  // ---- Control Point commands ----

  async _writeControlPointAndAwait(bytes, opcode) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._pendingControlResponse = null;
        reject(new Error(`Control Point応答タイムアウト (opcode=0x${opcode.toString(16)})`));
      }, DeviceProfile.COMMAND_RESPONSE_TIMEOUT_MS);

      this._pendingControlResponse = { opcode, resolve: (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      }, reject: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      } };

      this.controlPointChar.writeValueWithResponse(bytes).catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._pendingControlResponse = null;
        reject(err);
      });
    });
  }

  _handleControlPointResponse(dataView) {
    if (dataView.byteLength < 3) return;
    const responseOp = dataView.getUint8(0);
    if (responseOp !== C.OP_RESPONSE_CODE) return;
    const requestOp = dataView.getUint8(1);
    const resultCode = dataView.getUint8(2);

    const pending = this._pendingControlResponse;
    if (!pending || pending.opcode !== requestOp) {
      // 対応する待受がない応答は無視(FTMS Statusの通知経路が別にある場合など)
      return;
    }
    this._pendingControlResponse = null;
    if (resultCode === C.RESULT_SUCCESS) {
      pending.resolve(resultCode);
    } else {
      pending.reject(new Error(`Control Point失敗 opcode=0x${requestOp.toString(16)} result=0x${resultCode.toString(16)}`));
    }
  }

  async _requestControl() {
    const bytes = new Uint8Array([C.OP_REQUEST_CONTROL]);
    return this._writeControlPointAndAwait(bytes, C.OP_REQUEST_CONTROL);
  }

  async _startOrResume() {
    const bytes = new Uint8Array([C.OP_START_OR_RESUME]);
    try {
      return await this._writeControlPointAndAwait(bytes, C.OP_START_OR_RESUME);
    } catch (err) {
      // 既にStarted状態などで拒否される機種もあるため、
      // Start or Resumeの失敗は致命的エラーとしない。
      this._emit('warning', { message: 'Start or Resumeコマンドが受理されませんでした(継続します)。' });
      return null;
    }
  }

  async _sendSimulationParams(gradePercent) {
    const clamped = clamp(gradePercent, DeviceProfile.GRADE_MIN_PERCENT, DeviceProfile.GRADE_MAX_PERCENT);
    const bytes = new ArrayBuffer(7);
    const view = new DataView(bytes);
    view.setUint8(0, C.OP_SET_INDOOR_BIKE_SIMULATION_PARAMS);
    view.setInt16(1, Math.round(DeviceProfile.WIND_SPEED_MPS * 1000), true); // 0.001 m/s
    view.setInt16(3, Math.round(clamped * 100), true); // 0.01 %
    // Crr: resolution 0.0001, Cw(CdA): resolution 0.01 kg/m
    view.setUint8(5, Math.round(PhysicsConstants.CRR / 0.0001) & 0xff);
    view.setUint8(6, Math.round(PhysicsConstants.CDA / 0.01) & 0xff);
    await this._writeControlPointAndAwait(new Uint8Array(bytes), C.OP_SET_INDOOR_BIKE_SIMULATION_PARAMS);
    return clamped;
  }

  async _sendErgTarget(watts) {
    const clamped = clamp(Math.round(watts), DeviceProfile.ERG_MIN_WATTS, DeviceProfile.ERG_MAX_WATTS);
    const bytes = new ArrayBuffer(3);
    const view = new DataView(bytes);
    view.setUint8(0, C.OP_SET_TARGET_POWER);
    view.setInt16(1, clamped, true);
    await this._writeControlPointAndAwait(new Uint8Array(bytes), C.OP_SET_TARGET_POWER);
    return clamped;
  }

  /**
   * grade指示。変化量が閾値を超えた場合のみ実際に送信する。
   * 戻り値: 実際に送信したか否か、送信値。
   */
  setGrade(gradePercent) {
    if (this.controlMode !== 'simulation' || this.isPaused) return null;
    const clamped = clamp(gradePercent, DeviceProfile.GRADE_MIN_PERCENT, DeviceProfile.GRADE_MAX_PERCENT);
    if (
      this.lastSentGradePercent !== null &&
      Math.abs(clamped - this.lastSentGradePercent) < DeviceProfile.GRADE_RESEND_THRESHOLD_PERCENT
    ) {
      return { sent: false, calculated: gradePercent, actual: this.lastSentGradePercent };
    }
    this.lastSentGradePercent = clamped;
    this.queue.enqueueLatest('control-target', () => this._sendSimulationParams(clamped), { name: 'set-grade' }).catch(() => {});
    return { sent: true, calculated: gradePercent, actual: clamped };
  }

  setErgTarget(watts) {
    if (this.controlMode !== 'erg' || this.isPaused) return null;
    const clamped = clamp(Math.round(watts), DeviceProfile.ERG_MIN_WATTS, DeviceProfile.ERG_MAX_WATTS);
    if (
      this.lastSentErgWatts !== null &&
      Math.abs(clamped - this.lastSentErgWatts) < DeviceProfile.ERG_RESEND_THRESHOLD_WATTS
    ) {
      return { sent: false, calculated: watts, actual: this.lastSentErgWatts };
    }
    this.lastSentErgWatts = clamped;
    this.queue.enqueueLatest('control-target', () => this._sendErgTarget(clamped), { name: 'set-erg' }).catch(() => {});
    return { sent: true, calculated: watts, actual: clamped };
  }

  /** 一時停止: トレーナーへ無負荷相当を送信し、直前の目標値を保存する。 */
  async pause() {
    if (this.isPaused) return;
    if (this.controlMode === 'simulation') {
      this.prePauseTarget = { mode: 'simulation', value: this.lastSentGradePercent ?? 0 };
    } else if (this.controlMode === 'erg') {
      this.prePauseTarget = { mode: 'erg', value: this.lastSentErgWatts ?? 0 };
    }
    this.isPaused = true;
    if (!this.isConnected) return; // 切断中は無駄な送信・警告を出さない
    if (this.controlMode === 'simulation') {
      this.lastSentGradePercent = 0;
      this.queue.enqueueLatest('control-target', () => this._sendSimulationParams(0), { name: 'pause-zero' }).catch(() => {});
    } else if (this.controlMode === 'erg') {
      this.lastSentErgWatts = 0;
      this.queue.enqueueLatest('control-target', () => this._sendErgTarget(0), { name: 'pause-zero' }).catch(() => {});
    }
  }

  /** 再開: 一時停止直前の目標値へ復元する。 */
  async resume() {
    if (!this.isPaused) return;
    this.isPaused = false;
    if (this.prePauseTarget?.mode === 'simulation') {
      this.lastSentGradePercent = this.prePauseTarget.value;
      this.queue
        .enqueueLatest('control-target', () => this._sendSimulationParams(this.prePauseTarget.value), { name: 'resume-restore' })
        .catch(() => {});
    } else if (this.prePauseTarget?.mode === 'erg') {
      this.lastSentErgWatts = this.prePauseTarget.value;
      this.queue
        .enqueueLatest('control-target', () => this._sendErgTarget(this.prePauseTarget.value), { name: 'resume-restore' })
        .catch(() => {});
    }
    this.prePauseTarget = null;
  }

  /**
   * FTMS User Data Service (体重書き込み) をベストエフォートで試みる。
   * 対応有無は実機確認が必要な項目のため、失敗しても例外を投げず
   * { supported: boolean } を返すのみとする。
   */
  async tryWriteUserWeight(weightKg) {
    try {
      const udsService = await this.server.getPrimaryService(C.USER_DATA_SERVICE);
      const userIndexChar = await udsService.getCharacteristic(C.CHAR_USER_INDEX);
      await userIndexChar.readValue();

      const controlPointChar = await udsService.getCharacteristic(C.CHAR_USER_CONTROL_POINT).catch(() => null);
      if (controlPointChar) {
        await controlPointChar.startNotifications().catch(() => {});
        // Register New User (consent code 0) -> Consent
        try {
          await controlPointChar.writeValueWithResponse(new Uint8Array([C.UCP_REGISTER_NEW_USER, 0x00]));
        } catch (e) {
          /* 一部機種は未対応の場合がある */
        }
      }

      const weightChar = await udsService.getCharacteristic(C.CHAR_UDS_WEIGHT).catch(() => null);
      if (!weightChar) {
        return { supported: false, reason: 'weight characteristic not found' };
      }
      // Weight characteristic resolution: 0.005kg (Bluetooth SIG "Weight" 0x2A98)
      const raw = Math.round(weightKg / 0.005);
      const buf = new Uint8Array(2);
      new DataView(buf.buffer).setUint16(0, raw, true);
      await weightChar.writeValueWithResponse(buf);
      return { supported: true };
    } catch (err) {
      return { supported: false, reason: String(err) };
    }
  }

  // ---- Indoor Bike Data parsing ----

  _parseIndoorBikeData(dataView) {
    let offset = 0;
    const flags = dataView.getUint16(offset, true);
    offset += 2;

    const sample = {
      instSpeedKmh: null,
      avgSpeedKmh: null,
      instCadenceRpm: null,
      avgCadenceRpm: null,
      totalDistanceM: null,
      resistanceLevel: null,
      instPowerW: null,
      avgPowerW: null,
      heartRateBpm: null,
      elapsedTimeS: null,
      remainingTimeS: null,
    };

    const moreDataFlagSet = C.bitSet(flags, C.IBD_FLAG_MORE_DATA);
    if (!moreDataFlagSet) {
      sample.instSpeedKmh = dataView.getUint16(offset, true) * 0.01;
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_AVG_SPEED)) {
      sample.avgSpeedKmh = dataView.getUint16(offset, true) * 0.01;
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_INST_CADENCE)) {
      sample.instCadenceRpm = dataView.getUint16(offset, true) * 0.5;
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_AVG_CADENCE)) {
      sample.avgCadenceRpm = dataView.getUint16(offset, true) * 0.5;
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_TOTAL_DISTANCE)) {
      // uint24
      const b0 = dataView.getUint8(offset);
      const b1 = dataView.getUint8(offset + 1);
      const b2 = dataView.getUint8(offset + 2);
      sample.totalDistanceM = b0 | (b1 << 8) | (b2 << 16);
      offset += 3;
    }
    if (C.bitSet(flags, C.IBD_FLAG_RESISTANCE_LEVEL)) {
      sample.resistanceLevel = dataView.getInt16(offset, true);
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_INST_POWER)) {
      sample.instPowerW = dataView.getInt16(offset, true);
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_AVG_POWER)) {
      sample.avgPowerW = dataView.getInt16(offset, true);
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_EXPENDED_ENERGY)) {
      // Total(uint16 kcal) + Per hour(uint16) + Per minute(uint8) : 5 bytes、本アプリでは未使用
      offset += 5;
    }
    if (C.bitSet(flags, C.IBD_FLAG_HEART_RATE)) {
      sample.heartRateBpm = dataView.getUint8(offset);
      offset += 1;
    }
    if (C.bitSet(flags, C.IBD_FLAG_METABOLIC_EQUIVALENT)) {
      offset += 1;
    }
    if (C.bitSet(flags, C.IBD_FLAG_ELAPSED_TIME)) {
      sample.elapsedTimeS = dataView.getUint16(offset, true);
      offset += 2;
    }
    if (C.bitSet(flags, C.IBD_FLAG_REMAINING_TIME)) {
      sample.remainingTimeS = dataView.getUint16(offset, true);
      offset += 2;
    }

    const validated = validateSample(sample, this._lastValidSample);
    this._lastValidSample = validated;
    return validated;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 明らかに物理的にありえない値を除外する簡易バリデーション。
 * 要件定義書3章「異常値バリデーション」に対応。
 * 上限を超える値は直前の有効値で置換する(直前値がなければnull)。
 */
function validateSample(sample, lastValid) {
  const out = { ...sample };
  if (out.instPowerW !== null && (out.instPowerW < 0 || out.instPowerW > ValidationLimits.MAX_POWER_W)) {
    out.instPowerW = lastValid?.instPowerW ?? null;
  }
  if (
    out.instCadenceRpm !== null &&
    (out.instCadenceRpm < 0 || out.instCadenceRpm > ValidationLimits.MAX_CADENCE_RPM)
  ) {
    out.instCadenceRpm = lastValid?.instCadenceRpm ?? null;
  }
  if (
    out.heartRateBpm !== null &&
    (out.heartRateBpm < 0 || out.heartRateBpm > ValidationLimits.MAX_HEART_RATE_BPM)
  ) {
    out.heartRateBpm = null;
  }
  return out;
}
