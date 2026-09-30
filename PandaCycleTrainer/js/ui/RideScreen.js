import { h, useState, useRef, useEffect, useCallback } from './h.js';
import { PhysicsEngine } from '../physics/physicsEngine.js';
import { CourseEngine } from '../physics/courseEngine.js';
import { WakeLockManager } from '../utils/wakeLock.js';
import { Dashboard } from './Dashboard.js';
import { CityScene } from './CityScene.js';
import { LandscapeScene } from './LandscapeScene.js';
import { PondScene } from './PondScene.js';
import { FullscreenHud } from './FullscreenHud.js';
import { loadRenderQuality, saveRenderQuality } from '../storage/prefs.js';
import { demoRiderTarget, smoothDemoPower } from '../physics/demoRider.js';
import { ConfirmDialog } from './Modal.js';
import { fmtTime } from '../utils/format.js';

const SAMPLE_INTERVAL_MS = 1000;

const QUALITY_LABELS = { auto: '自動', high: '高', medium: '中', low: '低' };

/**
 * 走行中画面。物理演算ループ・BLEデータ購読・記録・一時停止/終了/ゴール処理を統括する。
 */
export function RideScreen({ ftmsClient, controlMode: initialControlMode, riderWeightKg, bikeWeightKg, crr, cdaM2, vehicle, courseProfile, goalDistanceKm, initialLoadRatioPercent, onFinish, demo = false, onExitDemo }) {
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
  // 描画品質: 'auto'(自動調整) か 'high' / 'medium' / 'low' の固定。activeTierは実際に適用中の段階。
  const [qualityMode, setQualityMode] = useState(loadRenderQuality);
  const [activeTier, setActiveTier] = useState(null);
  // フルスクリーン: Fullscreen APIで全画面化できた場合(native)と、APIが無い/拒否された
  // 場合のCSSによる全画面表示(pseudo)の2通り。
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);
  const isFullscreen = nativeFullscreen || pseudoFullscreen;
  const stageRef = useRef(null);
  const hudRef = useRef(null);
  const isFullscreenRef = useRef(false);
  isFullscreenRef.current = isFullscreen;
  const lastHudValuesRef = useRef(null);

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
  // デモ走行: トレーナーを使わず仮想ライダーのパワーで自動走行する(記録はしない)
  const [demoLapNotice, setDemoLapNotice] = useState(false);
  const demoLapTimerRef = useRef(null);

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
      crr,
      cdaM2,
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

    // デモ中はトレーナーのデータ・切断を一切扱わない(接続済みのトレーナーがあっても無視する)
    if (!demo) {
      ftmsClient.addEventListener('bike-data', onBikeData);
      ftmsClient.addEventListener('communication-warning', onCommWarning);
      ftmsClient.addEventListener('disconnected', onDisconnected);
      ftmsClient.addEventListener('control-mode', onControlModeChanged);
    }

    startLoop();
    if (!demo) startSampling(); // デモは走行記録を残さない

    return () => {
      stopLoop();
      stopSampling();
      if (demoLapTimerRef.current) clearTimeout(demoLapTimerRef.current);
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
    if (demo) {
      // 仮想ライダー: 現在の勾配に応じたパワー・ケイデンスを生成する
      const target = demoRiderTarget(physics.currentGradePercent, getRidingTimeS());
      latestPowerRef.current = smoothDemoPower(latestPowerRef.current, target.targetPowerW, dt);
      latestCadenceRef.current = target.cadenceRpm;
    }
    physics.setCurrentPower(latestPowerRef.current);
    const snapshot = physics.step(dt);
    const distanceKm = snapshot.distanceM / 1000;

    // トレーナーへの負荷指示 (負荷率は実負荷指示のみに影響)
    const ratio = loadRatioRef.current / 100;
    if (demo) {
      // デモではトレーナーへ負荷指示を送らない
    } else if (controlModeRef.current === 'simulation') {
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

    // ダッシュボード/フルスクリーンHUD更新 (高頻度、ref経由でDOM直接更新)
    const values = {
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
      loadRatio: String(loadRatioRef.current),
    };
    lastHudValuesRef.current = values;
    if (dashboardRef.current) {
      dashboardRef.current.update(values);
    }
    if (isFullscreenRef.current && hudRef.current) {
      hudRef.current.update(values);
    }
    if (cityRef.current) {
      cityRef.current.draw({ distanceKm, speedKmh: snapshot.speedKmh });
    }

    if (demo && courseEngine.isGoalReached(distanceKm)) {
      // デモはゴールで止まらず、そのまま次の周回へ(自動走行を続ける)
      courseEngine.extendGoal();
      setDemoLapNotice(true);
      if (demoLapTimerRef.current) clearTimeout(demoLapTimerRef.current);
      demoLapTimerRef.current = setTimeout(() => setDemoLapNotice(false), 4000);
    } else if (!goalHandledRef.current && courseEngine.isGoalReached(distanceKm)) {
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
    if (!demo) ftmsClient.pause();
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
    if (!demo) ftmsClient.resume();
    wakeLockRef.current?.enable();
    setPaused(false);
  }, [ftmsClient]);

  const handlePauseButton = () => {
    if (paused) doResume();
    else doPause();
  };

  const handleEndRequest = () => {
    if (demo) {
      // デモは記録を残さないので確認なしでセットアップ画面へ戻る
      onExitDemo?.();
      return;
    }
    setShowEndConfirm(true);
  };

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

  // ---- フルスクリーン ----
  const enterFullscreen = async () => {
    const stage = stageRef.current;
    if (stage && stage.requestFullscreen) {
      try {
        await stage.requestFullscreen({ navigationUI: 'hide' });
        return;
      } catch (e) {
        // 拒否された(埋め込み表示・ブラウザ設定等)場合はCSSによる全画面表示にする
      }
    }
    setPseudoFullscreen(true);
  };

  const exitFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setPseudoFullscreen(false);
  };

  useEffect(() => {
    const onChange = () => setNativeFullscreen(!!stageRef.current && document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      // 走行終了(画面遷移)時にフルスクリーンのまま残さない
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    // 表示サイズが変わったので3D描画の解像度を合わせ、HUDに最新値を入れておく
    // (一時停止中は物理ループが止まっていてHUDが更新されないため)。
    const id = requestAnimationFrame(() => {
      cityRef.current?.resize();
      if (isFullscreen && hudRef.current && lastHudValuesRef.current) hudRef.current.update(lastHudValuesRef.current);
    });
    return () => cancelAnimationFrame(id);
  }, [isFullscreen]);

  useEffect(() => {
    if (!pseudoFullscreen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setPseudoFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pseudoFullscreen]);

  // ダイアログはフルスクリーン要素の外に描かれて見えなくなるため、表示時は全画面を解除する。
  useEffect(() => {
    if (showEndConfirm || showGoalDialog || showReconnectDialog) exitFullscreen();
  }, [showEndConfirm, showGoalDialog, showReconnectDialog]);

  // ---- 描画品質 ----
  const handleQualityChange = (e) => {
    const mode = e.target.value;
    setQualityMode(mode);
    saveRenderQuality(mode);
  };

  const qualitySelect = (className) =>
    h(
      'label', { className },
      h('span', null, '描画品質'),
      h(
        'select', { value: qualityMode, onChange: handleQualityChange, 'aria-label': '描画品質' },
        ['auto', 'high', 'medium', 'low'].map((mode) =>
          h('option', { key: mode, value: mode },
            mode === 'auto' && activeTier ? `自動（現在: ${QUALITY_LABELS[activeTier]}）` : QUALITY_LABELS[mode])
        )
      )
    );

  const sceneProps = {
    ref: cityRef,
    courseEngine: courseEngineRef.current,
    // コースで乗り物が決まっている場合(上野不忍池=スワンボート)はそちらを優先する
    vehicle: courseProfile.fixedVehicle ?? vehicle,
    qualityMode,
    onQualityChange: setActiveTier,
  };

  return h(
    'div', { className: 'screen ride-screen' },
    demo && h('div', { className: 'banner banner-info demo-banner' }, '▶ デモ走行中（トレーナー未接続・自動走行。走行記録は保存されません）'),
    demo && demoLapNotice && h('div', { className: 'banner banner-info' }, '🏁 ゴール！ デモはそのまま次の周回を走ります。'),
    communicationWarning && h('div', { className: 'banner banner-warning' }, '⚠ トレーナーとの通信が不安定です。'),
    h(
      'div',
      {
        ref: stageRef,
        className: `ride-stage${isFullscreen ? ' is-fullscreen' : ''}${pseudoFullscreen ? ' is-pseudo-fullscreen' : ''}`,
      },
      // 平坦コースは街並み、丘陵・山岳コースは湖畔/山岳の景観(どちらも同じdraw()契約)
      !courseProfile.scenery || courseProfile.scenery === 'city'
        ? h(CityScene, sceneProps)
        : courseProfile.scenery === 'ueno'
          ? h(PondScene, sceneProps)
          : h(LandscapeScene, { ...sceneProps, landscape: courseProfile.scenery }),
      isFullscreen && h(FullscreenHud, { ref: hudRef, paused, communicationWarning }),
      isFullscreen &&
        h(
          'div', { className: 'fs-toolbar' },
          h('button', { className: 'btn', onClick: handlePauseButton }, paused ? '再開' : '一時停止'),
          qualitySelect('fs-quality'),
          h('button', { className: 'btn', onClick: exitFullscreen, 'aria-label': 'フルスクリーンを終了' }, '全画面を終了')
        )
    ),
    h(
      'div', { className: 'scene-toolbar' },
      h('button', { className: 'btn btn-secondary', onClick: enterFullscreen }, '⛶ フルスクリーン'),
      qualitySelect('quality-select')
    ),
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
      h('button', { className: 'btn btn-danger btn-large', onClick: handleEndRequest }, demo ? 'デモを終了' : '終了')
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
