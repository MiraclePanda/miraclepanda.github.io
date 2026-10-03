import { h, useState, useRef, useEffect, useCallback } from './h.js';
import { PhysicsEngine } from '../physics/physicsEngine.js';
import { CourseEngine } from '../physics/courseEngine.js';
import { WakeLockManager } from '../utils/wakeLock.js';
import { Dashboard } from './Dashboard.js';
import { CityScene } from './CityScene.js';
import { LandscapeScene } from './LandscapeScene.js';
import { PondScene } from './PondScene.js';
import { FullscreenHud } from './FullscreenHud.js';
import {
  loadRenderQuality,
  saveRenderQuality,
  loadEnvironment,
  saveEnvironment,
  loadCameraView,
  saveCameraView,
  DEFAULT_FTP_W,
} from '../storage/prefs.js';
import { powerZone } from '../utils/zones.js';
import { prepareGhosts, stepGhosts, overtakeToast, ghostSummary, ghostTimeS } from './ghostRace.js';
import { createPack, stepPack, isDrafting, laneTarget, stepLane } from '../physics/packRiders.js';
import { PhysicsConstants } from '../physics/physicsConstants.js';
import {
  TIME_OPTIONS,
  WEATHER_OPTIONS,
  VIEW_LABELS,
  supportsWeather,
  effectiveView,
  nextView,
  environmentLabel,
} from './rideOptions.js';
import { demoRiderTarget, smoothDemoPower } from '../physics/demoRider.js';
import { ConfirmDialog } from './Modal.js';
import { fmtTime } from '../utils/format.js';

const SAMPLE_INTERVAL_MS = 1000;
const TOAST_MS = 4600;
// 3秒平均パワーの時定数(一次遅れ)
const POWER_AVG_TAU_S = 3;

const QUALITY_LABELS = { auto: '自動', high: '高', medium: '中', low: '低' };

/**
 * 走行中画面。物理演算ループ・BLEデータ購読・記録・一時停止/終了/ゴール処理を統括する。
 */
export function RideScreen({ ftmsClient, controlMode: initialControlMode, riderWeightKg, bikeWeightKg, crr, cdaM2, vehicle, courseProfile, goalDistanceKm, initialLoadRatioPercent, ftpW = DEFAULT_FTP_W, initialEnvironment, ghosts = [], packEnabled = false, onFinish, demo = false, onExitDemo }) {
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
  // 景観(時間帯・天候)と視点。走行中に切り替えたら保存し、次の走行でも同じ設定から始める。
  const [environment, setEnvironment] = useState(() => initialEnvironment ?? loadEnvironment());
  const [cameraView, setCameraView] = useState(() => effectiveView(loadCameraView(), courseProfile));
  const [showEnvPanel, setShowEnvPanel] = useState(false);
  const lastDrawArgsRef = useRef(null); // 最後に draw へ渡した引数(一時停止中の再描画用)
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
  // ゴースト対戦: 選んだ記録の再生(物理演算なし)。抜いた/抜かれたの判定状態も持つ
  // 集団走行(仮想の5人、上野は対象外)。自分のドラフティング判定と車線(集団を避ける横移動)も持つ
  const packRef = useRef(null);
  if (packRef.current === null) packRef.current = packEnabled && courseProfile.scenery !== 'ueno' ? createPack({ startDistanceM: 0 }) : [];
  const myLaneRef = useRef(0);
  const draftingRef = useRef(false);
  const ghostsRef = useRef(null);
  if (ghostsRef.current === null) ghostsRef.current = prepareGhosts(ghosts);
  const power3sRef = useRef(null); // 3秒平均パワー(一次遅れ)。最初のフレームで現在値から始める

  const startTimeRef = useRef(Date.now());
  const totalPausedMsRef = useRef(0);
  const pauseStartedAtRef = useRef(null);
  const samplesRef = useRef([]);
  const sampleIntervalRef = useRef(null);
  const loadRatioRef = useRef(initialLoadRatioPercent);
  const lastControlCalculatedRef = useRef(0);
  const lastControlActualRef = useRef(0);
  const goalHandledRef = useRef(false);
  // ゴールのダイアログを開いている間の時間。record.ridingTimeS(リザルトの値)の定義は変えず、
  // ゴーストの再生・サンプルの rideTimeS・集団の時間だけ、この待ち時間を除いて進める。
  const goalPauseStartedAtRef = useRef(null);
  const totalGoalPausedMsRef = useRef(0);
  // 通知(フルスクリーンHUDのG区画に出すトースト)。{ kind, kicker, title, sub, tone } | null
  // デモ走行の周回(kind: 'demoLap')は非フルスクリーン時のバナーにも出す。
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

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
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
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
    // 集団: 自分を含めて判定してから進める。自分のドラフティング(ゴーストは含めない)は
    // physics.step の前に空気抵抗へ反映する。シミュレーションモードで送る勾配は変えない
    // (ERG は computeErgTargetWatts が fAir を使うので自然に目標Wが下がる)。
    const pack = packRef.current;
    if (pack.length > 0) {
      const me = { distanceM: physics.distanceM, laneOffsetM: myLaneRef.current, speedMps: physics.speedMps };
      stepPack(pack, dt, { gradeAtKm: courseEngine, crr, cdaM2, tSec: getGhostTimeS(), me });
      draftingRef.current = isDrafting(me, pack);
      physics.setDraftFactor(draftingRef.current ? PhysicsConstants.DRAFT_CDA_FACTOR : 1);
      myLaneRef.current = stepLane(myLaneRef.current, laneTarget(me, pack), dt);
    }
    const snapshot = physics.step(dt);
    const distanceKm = snapshot.distanceM / 1000;
    const powerNow = latestPowerRef.current ?? 0;
    power3sRef.current = power3sRef.current === null
      ? powerNow
      : power3sRef.current + (powerNow - power3sRef.current) * (1 - Math.exp(-Math.max(0, dt) / POWER_AVG_TAU_S));
    // 次の500mの平均勾配(%) = 標高差(m) / 500m × 100
    const next500 = courseEngine.elevationDeltaM(distanceKm, distanceKm + 0.5) / 5;

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

    // ゴースト: 走行時間(一時停止を除く)で記録を再生し、差と抜いた/抜かれたを求める
    const ghostState = stepGhosts(ghostsRef.current, getGhostTimeS(), { distanceM: snapshot.distanceM, speedMps: snapshot.speedKmh / 3.6 });
    for (const ev of ghostState.events) showToast(overtakeToast(ev));

    // シーン・canvas に渡す他のライダー(ゴースト+集団)
    const others = pack.length > 0 ? ghostState.others.concat(pack.map(packOther)) : ghostState.others;

    // ダッシュボード/フルスクリーンHUD更新 (高頻度、ref経由でDOM直接更新)
    const values = {
      power: fmtOrDash(latestPowerRef.current, 0),
      power3s: fmtOrDash(power3sRef.current, 0),
      powerZone: powerZone(power3sRef.current, ftpW),
      next500Grade: fmtOrDash(next500, 1),
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
      ghosts: ghostState.ghosts,
      drafting: draftingRef.current,
      ghostSummary: ghostSummary(ghostState.ghosts),
      // canvas 描画用の数値(フルスクリーンHUDのコースマップ・標高プロファイル)
      raw: {
        distanceM: snapshot.distanceM,
        speedMps: snapshot.speedKmh / 3.6,
        gradePercent: snapshot.gradePercent,
        elevationM: snapshot.elevationM,
        powerW: latestPowerRef.current,
        others,
      },
    };
    lastHudValuesRef.current = values;
    if (dashboardRef.current) {
      dashboardRef.current.update(values);
    }
    if (isFullscreenRef.current && hudRef.current) {
      hudRef.current.update(values);
    }
    const drawArgs = {
      distanceKm,
      speedKmh: snapshot.speedKmh,
      others,
      // ケイデンスを受信していない(null)ときは undefined にしてシーン側の速度からの推定に任せる
      cadenceRpm: latestCadenceRef.current ?? undefined,
      myLaneOffsetM: myLaneRef.current,
    };
    lastDrawArgsRef.current = drawArgs;
    if (cityRef.current) {
      cityRef.current.draw(drawArgs);
    }

    if (demo && courseEngine.isGoalReached(distanceKm)) {
      // デモはゴールで止まらず、そのまま次の周回へ(自動走行を続ける)
      courseEngine.extendGoal();
      showToast({ kind: 'demoLap', kicker: 'デモ走行', title: 'ゴール！', sub: 'デモはそのまま次の周回を走ります。' });
    } else if (!goalHandledRef.current && courseEngine.isGoalReached(distanceKm)) {
      goalHandledRef.current = true;
      isRunningRef.current = false;
      goalPauseStartedAtRef.current = Date.now();
      ftmsClient.pause();
      setShowGoalDialog(true);
    }
  };

  // 通知を約4.6秒出す(新しい通知が来たら差し替える)
  const showToast = (t) => {
    setToast(t);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  const getElapsedTimeS = () => (Date.now() - startTimeRef.current) / 1000;
  const getRidingTimeS = () => {
    const pausedMs = totalPausedMsRef.current + (pauseStartedAtRef.current ? Date.now() - pauseStartedAtRef.current : 0);
    return Math.max(0, (Date.now() - startTimeRef.current - pausedMs) / 1000);
  };

  // ゴースト再生用の走行時間 = 走行時間 − ゴールのダイアログを開いていた時間
  const getGhostTimeS = () =>
    ghostTimeS({
      ridingTimeS: getRidingTimeS(),
      totalGoalPausedMs: totalGoalPausedMsRef.current,
      goalPauseStartedAt: goalPauseStartedAtRef.current,
      nowMs: Date.now(),
    });

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
        rideTimeS: getGhostTimeS(), // 一時停止・ゴール待ちを除いた走行時間(ゴーストの再生に使う)
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
    if (goalPauseStartedAtRef.current !== null) {
      totalGoalPausedMsRef.current += Date.now() - goalPauseStartedAtRef.current;
      goalPauseStartedAtRef.current = null;
    }
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

  // ---- 景観・視点 ----
  const changeEnvironment = (patch) => {
    const next = { ...environment, ...patch };
    setEnvironment(next);
    saveEnvironment(next);
  };
  const cameraViewRef = useRef(cameraView);
  cameraViewRef.current = cameraView;
  const cycleView = useCallback(() => {
    const next = nextView(cameraViewRef.current, courseProfile);
    cameraViewRef.current = next;
    setCameraView(next);
    saveCameraView(next);
  }, [courseProfile]);

  // V キーで視点を切り替える(入力欄・選択欄の操作中は無視)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'v' && e.key !== 'V') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      cycleView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleView]);

  const viewButton = (className) =>
    h('button', { className, onClick: cycleView, 'aria-label': '視点を切り替える', title: '視点を切り替える(V キー)' },
      h('span', null, `視点 · ${VIEW_LABELS[cameraView]}`), h('span', { className: 'fs-key' }, 'V'));

  const envPanel = () =>
    h(
      'div', { className: 'fs-env-panel', role: 'dialog', 'aria-label': '環境' },
      h(
        'div', { className: 'fs-env-head' },
        h('span', null, '環境'),
        h('button', { className: 'fs-env-close', onClick: () => setShowEnvPanel(false) }, '閉じる')
      ),
      envRow('時間帯', TIME_OPTIONS, environment.time, (id) => changeEnvironment({ time: id })),
      supportsWeather(courseProfile)
        ? envRow('天候', WEATHER_OPTIONS, environment.weather, (id) => changeEnvironment({ weather: id }))
        : h('p', { className: 'fs-env-note' }, '上野不忍池コースは時間帯だけが反映されます。')
    );

  // 一時停止中(ゴールのダイアログ中も含む)はループが draw を呼ばないため、視点・環境を
  // 切り替えたら最後の引数で1回だけ描き直して切り替えを見せる(物理は進めない)。
  useEffect(() => {
    if (isRunningRef.current || !lastDrawArgsRef.current) return undefined;
    const id = requestAnimationFrame(() => {
      if (!isRunningRef.current && lastDrawArgsRef.current) cityRef.current?.draw(lastDrawArgsRef.current);
    });
    return () => cancelAnimationFrame(id);
  }, [cameraView, environment]);

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
    // 景観と視点(シーン側が未対応でも渡すだけで害はない)
    environment,
    cameraView,
    qualityMode,
    onQualityChange: setActiveTier,
  };

  return h(
    'div', { className: 'screen ride-screen' },
    demo && h('div', { className: 'banner banner-info demo-banner' }, '▶ デモ走行中（トレーナー未接続・自動走行。走行記録は保存されません）'),
    demo && toast?.kind === 'demoLap' && h('div', { className: 'banner banner-info' }, '🏁 ゴール！ デモはそのまま次の周回を走ります。'),
    toast?.kind === 'ghost' && h('div', { className: 'banner banner-info ghost-banner' }, `👻 ${toast.title}(${toast.sub})`),
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
      isFullscreen &&
        h(
          FullscreenHud,
          {
            ref: hudRef,
            paused,
            communicationWarning,
            courseProfile,
            courseEngine: courseEngineRef.current,
            toast,
            demo,
            // デモはトレーナーへ送らない。ERGは目標W、シミュレーションは勾配%
            controlUnit: demo ? null : controlMode === 'erg' ? 'W' : '%',
            ftpW,
            chips: [environmentLabel(environment, courseProfile)],
          },
          // H: 操作(一時停止・視点・環境・描画品質・全画面を終了)
          h(
            'div', { className: 'fs-toolbar' },
            h('button', { className: 'btn', onClick: handlePauseButton }, paused ? '再開' : '一時停止'),
            viewButton('btn fs-view-btn'),
            h(
              'button',
              { className: `btn fs-env-btn${showEnvPanel ? ' is-open' : ''}`, onClick: () => setShowEnvPanel((o) => !o), 'aria-expanded': showEnvPanel },
              h('span', null, `環境 · ${environmentLabel(environment, courseProfile)}`)
            ),
            showEnvPanel && envPanel(),
            qualitySelect('fs-quality'),
            h('button', { className: 'btn', onClick: exitFullscreen, 'aria-label': 'フルスクリーンを終了' }, '全画面を終了')
          )
        )
    ),
    h(
      'div', { className: 'scene-toolbar' },
      h('button', { className: 'btn btn-secondary', onClick: enterFullscreen }, '⛶ フルスクリーン'),
      viewButton('btn btn-secondary scene-view-btn'),
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

/** 集団のライダー → シーン・canvas 用の others の要素。 */
function packOther(r) {
  return {
    id: r.id,
    kind: 'pack',
    distanceM: r.distanceM,
    laneOffsetM: r.laneOffsetM,
    speedKmh: r.speedMps * 3.6,
    cadenceRpm: r.cadenceRpm,
    color: r.color,
    label: r.name,
  };
}

function envRow(title, options, value, onChange) {
  return h(
    'div', { className: 'fs-env-row', role: 'radiogroup', 'aria-label': title },
    h('div', { className: 'fs-env-title' }, title),
    h(
      'div', { className: 'fs-env-seg' },
      options.map((o) =>
        h('button', {
          key: o.id,
          type: 'button',
          role: 'radio',
          'aria-checked': value === o.id,
          className: value === o.id ? 'is-selected' : '',
          onClick: () => onChange(o.id),
        }, o.label)
      )
    )
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
