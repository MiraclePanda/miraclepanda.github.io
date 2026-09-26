import { h, useState, useRef, useEffect, useCallback } from './h.js';
import { PhysicsEngine } from '../physics/physicsEngine.js';
import { CourseEngine } from '../physics/courseEngine.js';
import { WakeLockManager } from '../utils/wakeLock.js';
import { Dashboard } from './Dashboard.js';
import { CityScene } from './CityScene.js';
import { ConfirmDialog } from './Modal.js';
import { fmtTime } from '../utils/format.js';

const SAMPLE_INTERVAL_MS = 1000;

/**
 * 走行中画面。物理演算ループ・BLEデータ購読・記録・一時停止/終了/ゴール処理を統括する。
 */
export function RideScreen({ ftmsClient, controlMode: initialControlMode, riderWeightKg, bikeWeightKg, courseProfile, goalDistanceKm, initialLoadRatioPercent, onFinish }) {
  const [paused, setPaused] = useState(false);
  // 表示用のcontrolMode。トレーナー再接続で変わりうるため、ftmsClientの
  // 'control-mode'イベントを購読して更新する(高頻度ループはcontrolModeRefを参照)。
  const [controlMode, setControlMode] = useState(initialControlMode);
  const controlModeRef = useRef(initialControlMode);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const [showReconnectDialog, setShowReconnectDialog] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState(null);
  const [communicationWarning, setCommunicationWarning] = useState(false);
  const [loadRatioPercent, setLoadRatioPercent] = useState(initialLoadRatioPercent);

  const dashboardRef = useRef(null);
  const cityRef = useRef(null);

  const physicsRef = useRef(null);
  const courseEngineRef = useRef(null);
  const wakeLockRef = useRef(null);

  const rafIdRef = useRef(null);
  const lastFrameTimeRef = useRef(null);
  const isRunningRef = useRef(true); // paused/goal-dialog中はfalse

  const latestPowerRef = useRef(0);
  const latestCadenceRef = useRef(null);
  const latestRealSpeedRef = useRef(null);
  const latestHeartRateRef = useRef(null);

  const startTimeRef = useRef(Date.now());
  const totalPausedMsRef = useRef(0);
  const pauseStartedAtRef = useRef(null);
  const samplesRef = useRef([]);
  const sampleIntervalRef = useRef(null);
  const loadRatioRef = useRef(initialLoadRatioPercent);
  const lastControlCalculatedRef = useRef(0);
  const lastControlActualRef = useRef(0);
  const goalHandledRef = useRef(false);

  useEffect(() => {
    loadRatioRef.current = loadRatioPercent;
  }, [loadRatioPercent]);

  // CitySceneへpropとして渡す都合上、レンダー時点で同期的に生成する
  // (useEffect内で生成すると初回描画のprops更新が反映されないため)。
  if (!courseEngineRef.current) {
    courseEngineRef.current = new CourseEngine(courseProfile, goalDistanceKm);
    physicsRef.current = new PhysicsEngine({
      riderWeightKg,
      bikeWeightKg,
      courseEngine: courseEngineRef.current,
    });
  }

  // 初期化
  useEffect(() => {
    wakeLockRef.current = new WakeLockManager();
    wakeLockRef.current.enable();

    const onBikeData = (ev) => {
      const s = ev.detail;
      if (s.instPowerW !== null && s.instPowerW !== undefined) latestPowerRef.current = s.instPowerW;
      latestCadenceRef.current = s.instCadenceRpm;
      latestRealSpeedRef.current = s.instSpeedKmh;
      latestHeartRateRef.current = s.heartRateBpm;
    };
    const onCommWarning = (ev) => setCommunicationWarning(!!ev.detail.warning);
    const onDisconnected = () => {
      doPause({ silent: true });
      setShowReconnectDialog(true);
    };
    const onControlModeChanged = (ev) => {
      controlModeRef.current = ev.detail.mode;
      setControlMode(ev.detail.mode);
    };

    ftmsClient.addEventListener('bike-data', onBikeData);
    ftmsClient.addEventListener('communication-warning', onCommWarning);
    ftmsClient.addEventListener('disconnected', onDisconnected);
    ftmsClient.addEventListener('control-mode', onControlModeChanged);

    startLoop();
    startSampling();

    return () => {
      stopLoop();
      stopSampling();
      wakeLockRef.current?.disable();
      ftmsClient.removeEventListener('control-mode', onControlModeChanged);
      ftmsClient.removeEventListener('bike-data', onBikeData);
      ftmsClient.removeEventListener('communication-warning', onCommWarning);
      ftmsClient.removeEventListener('disconnected', onDisconnected);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startLoop = () => {
    lastFrameTimeRef.current = performance.now();
    const tick = (now) => {
      const dt = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;
      if (isRunningRef.current) {
        stepPhysics(dt);
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  };

  const stopLoop = () => {
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;
  };

  const stepPhysics = (dt) => {
    const physics = physicsRef.current;
    const courseEngine = courseEngineRef.current;
    physics.setCurrentPower(latestPowerRef.current);
    const snapshot = physics.step(dt);
    const distanceKm = snapshot.distanceM / 1000;

    // トレーナーへの負荷指示 (負荷率は実負荷指示のみに影響)
    const ratio = loadRatioRef.current / 100;
    if (controlModeRef.current === 'simulation') {
      const calculated = snapshot.gradePercent * ratio;
      lastControlCalculatedRef.current = calculated;
      const result = ftmsClient.setGrade(calculated);
      if (result && result.actual !== undefined) {
        lastControlActualRef.current = result.actual;
      }
    } else if (controlModeRef.current === 'erg') {
      const requiredW = physics.computeErgTargetWatts();
      const calculated = requiredW * ratio;
      lastControlCalculatedRef.current = calculated;
      const result = ftmsClient.setErgTarget(calculated);
      if (result && result.actual !== undefined) {
        lastControlActualRef.current = result.actual;
      }
    }

    // ダッシュボード更新 (高頻度、ref経由でDOM直接更新)
    if (dashboardRef.current) {
      dashboardRef.current.update({
        power: fmtOrDash(latestPowerRef.current, 0),
        cadence: fmtOrDash(latestCadenceRef.current, 0),
        virtualSpeed: fmtOrDash(snapshot.speedKmh, 1),
        realSpeed: fmtOrDash(latestRealSpeedRef.current, 1),
        heartRate: fmtOrDash(latestHeartRateRef.current, 0),
        courseGrade: fmtOrDash(snapshot.gradePercent, 1),
        controlCalculated: fmtOrDash(lastControlCalculatedRef.current, 1),
        controlActual: fmtOrDash(lastControlActualRef.current, 1),
        distanceDone: fmtOrDash(distanceKm, 2),
        distanceRemaining: fmtOrDash(courseEngine.remainingKm(distanceKm), 2),
        elevation: fmtOrDash(snapshot.elevationM, 0),
        elevationGain: fmtOrDash(snapshot.elevationGainM, 0),
        elapsedTime: fmtTime(getElapsedTimeS()),
        ridingTime: fmtTime(getRidingTimeS()),
      });
    }
    if (cityRef.current) {
      cityRef.current.draw({ distanceKm, speedKmh: snapshot.speedKmh });
    }

    if (!goalHandledRef.current && courseEngine.isGoalReached(distanceKm)) {
      goalHandledRef.current = true;
      isRunningRef.current = false;
      ftmsClient.pause();
      setShowGoalDialog(true);
    }
  };

  const getElapsedTimeS = () => (Date.now() - startTimeRef.current) / 1000;
  const getRidingTimeS = () => {
    const pausedMs = totalPausedMsRef.current + (pauseStartedAtRef.current ? Date.now() - pauseStartedAtRef.current : 0);
    return Math.max(0, (Date.now() - startTimeRef.current - pausedMs) / 1000);
  };

  const startSampling = () => {
    sampleIntervalRef.current = setInterval(() => {
      if (!isRunningRef.current) return;
      const physics = physicsRef.current;
      samplesRef.current.push({
        tOffsetS: getElapsedTimeS(),
        powerW: latestPowerRef.current ?? 0,
        speedKmh: physics.speedMps * 3.6,
        cadenceRpm: latestCadenceRef.current ?? 0,
        elevationM: physics.elevationM,
        gradePercent: physics.currentGradePercent,
        distanceM: physics.distanceM,
      });
    }, SAMPLE_INTERVAL_MS);
  };
  const stopSampling = () => {
    if (sampleIntervalRef.current) clearInterval(sampleIntervalRef.current);
    sampleIntervalRef.current = null;
  };

  const doPause = useCallback(({ silent } = {}) => {
    if (!isRunningRef.current) return;
    isRunningRef.current = false;
    pauseStartedAtRef.current = Date.now();
    ftmsClient.pause();
    wakeLockRef.current?.disable();
    if (!silent) setPaused(true);
  }, [ftmsClient]);

  const doResume = useCallback(() => {
    if (isRunningRef.current) return;
    if (pauseStartedAtRef.current) {
      totalPausedMsRef.current += Date.now() - pauseStartedAtRef.current;
      pauseStartedAtRef.current = null;
    }
    lastFrameTimeRef.current = performance.now();
    isRunningRef.current = true;
    ftmsClient.resume();
    wakeLockRef.current?.enable();
    setPaused(false);
  }, [ftmsClient]);

  const handlePauseButton = () => {
    if (paused) doResume();
    else doPause();
  };

  const handleEndRequest = () => setShowEndConfirm(true);

  const finalizeRide = () => {
    stopLoop();
    stopSampling();
    wakeLockRef.current?.disable();
    const physics = physicsRef.current;
    const samples = samplesRef.current;
    const avgPowerW = average(samples.map((s) => s.powerW));
    const avgSpeedKmh = average(samples.map((s) => s.speedKmh));
    const avgCadenceRpm = average(samples.map((s) => s.cadenceRpm));

    const record = {
      courseId: courseProfile.id,
      courseName: courseProfile.name,
      goalDistanceKm,
      startTime: startTimeRef.current,
      endTime: Date.now(),
      elapsedTimeS: getElapsedTimeS(),
      ridingTimeS: getRidingTimeS(),
      totalDistanceM: physics.distanceM,
      elevationGainM: physics.elevationGainM,
      avgPowerW,
      avgSpeedKmh,
      avgCadenceRpm,
      samples,
    };

    // 要件定義書1章「毎回の走行開始時にネイティブのデバイス選択ダイアログを表示」に
    // 対応するため、走行終了時にBLE接続を切断し、次回は再度手動選択させる。
    ftmsClient.disconnect();
    onFinish(record);
  };

  const handleEndConfirm = () => {
    setShowEndConfirm(false);
    finalizeRide();
  };

  const handleGoalContinue = () => {
    setShowGoalDialog(false);
    courseEngineRef.current.extendGoal();
    goalHandledRef.current = false;
    doResume();
  };

  const handleGoalFinish = () => {
    setShowGoalDialog(false);
    finalizeRide();
  };

  const handleReconnect = async () => {
    setReconnecting(true);
    setReconnectError(null);
    try {
      await ftmsClient.connect();
      setShowReconnectDialog(false);
      doResume();
    } catch (err) {
      setReconnectError(err.message ?? String(err));
    } finally {
      setReconnecting(false);
    }
  };

  return h(
    'div', { className: 'screen ride-screen' },
    communicationWarning && h('div', { className: 'banner banner-warning' }, '⚠ トレーナーとの通信が不安定です。'),
    h(CityScene, { ref: cityRef, courseEngine: courseEngineRef.current }),
    h(Dashboard, { ref: dashboardRef, controlMode }),
    h(
      'div', { className: 'load-ratio-live' },
      h('label', null,
        `負荷率: ${loadRatioPercent}%`,
        h('input', {
          type: 'range', min: 0, max: 100, step: 1, value: loadRatioPercent,
          onChange: (e) => setLoadRatioPercent(Number(e.target.value)),
        })
      )
    ),
    h(
      'div', { className: 'ride-controls' },
      h('button', { className: 'btn btn-secondary btn-large', onClick: handlePauseButton }, paused ? '再開' : '一時停止'),
      h('button', { className: 'btn btn-danger btn-large', onClick: handleEndRequest }, '終了')
    ),
    h('p', { className: 'guidance-note' }, '走行中はタブを閉じないでください。リロード・タブクローズ時のセッション復元機能はありません。'),

    showEndConfirm &&
      h(ConfirmDialog, {
        title: '走行を終了しますか？',
        message: 'リザルト画面に移動します。この操作は取り消せません。',
        confirmLabel: '終了する',
        cancelLabel: 'キャンセル',
        danger: true,
        onConfirm: handleEndConfirm,
        onCancel: () => setShowEndConfirm(false),
      }),

    showGoalDialog &&
      h(ConfirmDialog, {
        title: 'ゴールしました！',
        message: '続けて走行しますか？',
        confirmLabel: '続行する',
        cancelLabel: '終了してリザルトを見る',
        onConfirm: handleGoalContinue,
        onCancel: handleGoalFinish,
      }),

    showReconnectDialog &&
      h(ConfirmDialog, {
        title: '接続が切断されました',
        message: reconnectError
          ? `再接続に失敗しました: ${reconnectError}`
          : 'Bluetooth接続が切れました。走行は一時停止しています。再接続してください。',
        confirmLabel: reconnecting ? '接続中...' : '再接続する',
        onConfirm: handleReconnect,
      })
  );
}

function average(arr) {
  if (!arr || arr.length === 0) return 0;
  const sum = arr.reduce((a, b) => a + (b ?? 0), 0);
  return sum / arr.length;
}

function fmtOrDash(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return value.toFixed(digits);
}
