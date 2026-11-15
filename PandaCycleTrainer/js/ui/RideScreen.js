import { h, useState, useRef, useEffect, useCallback } from './h.js';
import { SHOW_PERF } from './sceneHost.js';
import { gpuBackendMode } from '../three/gpuBackend.js';
import { PhysicsEngine } from '../physics/physicsEngine.js';
import { CourseEngine } from '../physics/courseEngine.js';
import { WakeLockManager } from '../utils/wakeLock.js';
import { Dashboard } from './Dashboard.js';
import { CityScene } from './CityScene.js';
import { LandscapeScene } from './LandscapeScene.js';
import { PondScene } from './PondScene.js';
import { AtamiScene } from './AtamiScene.js';
import { RealTownScene } from './RealTownScene.js';
import { REAL_TOWNS } from '../three/realTownLayout.js';
import { createCourseSeason, parseSeasonDate } from '../three/season.js';
import { FullscreenHud } from './FullscreenHud.js';
import {
  loadRenderQuality,
  saveRenderQuality,
  loadEnvironment,
  saveEnvironment,
  loadCameraView,
  saveCameraView,
  savePrefs,
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
import { createHappeningDirector, seedForCourse, DEFAULT_HAPPENING_WEIGHTS, landmarkActors } from '../three/happeningsLayout.js';
import { guideEventsBetween } from '../utils/tourGuide.js';
import { kcalFromWorkKj, gourmetLine, gourmetMilestone } from '../utils/gourmet.js';
import { citiesPassed, journeyToast, journeyTotalKm } from '../utils/journey.js';
import { getRideSummaries, saveRideDraft } from '../storage/db.js';
import { RideSession, splitSteps, CATCH_UP_MAX_S } from '../physics/rideSession.js';
import { DeviceProfile } from '../ble/deviceProfile.js';

const TOAST_MS = 4600;
// 走行中の下書き保存の間隔(クラッシュ・再読み込みで記録が消えないように。レビュー Q1)
const DRAFT_INTERVAL_MS = 30000;
// ダッシュボードの数値を書き換える間隔(毎フレームでは多すぎる。レビュー Q11)
const DISPLAY_INTERVAL_MS = 100;
// タブが裏にある間(描画が止まる)に走行を進める間隔
const BACKGROUND_STEP_MS = 1000;
// 3秒平均パワーの時定数(一次遅れ)
const POWER_AVG_TAU_S = 3;
// 景色の準備を待つ上限(これを過ぎたら景色の準備を待たずに走行を始める)
const SCENE_READY_TIMEOUT_MS = 60000;

// 走行を楽しくする通知(画面上部のバナーにも出す種類)
const FUN_TOAST_KINDS = ['happening', 'guide', 'journey', 'gourmet'];

const QUALITY_LABELS = { auto: '自動', ultra: '最高(実験)', high: '高', medium: '中', low: '低' };

/**
 * 走行中画面。物理演算ループ・BLEデータ購読・記録・一時停止/終了/ゴール処理を統括する。
 */
export function RideScreen({ ftmsClient, controlMode: initialControlMode, riderWeightKg, bikeWeightKg, crr, cdaM2, vehicle, courseProfile, goalDistanceKm, initialLoadRatioPercent, ftpW = DEFAULT_FTP_W, powerScale = 1, initialEnvironment, ghosts = [], packEnabled = false, onFinish, demo = false, onExitDemo }) {
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
  // 切断後、同じ機器へ自動でつなぎ直している間の表示(何回目か)。null なら試していない(レビュー F2)
  const [autoReconnect, setAutoReconnect] = useState(null);
  // 切断からつなぎ直せる(または終了する)までの間か(切断の知らせが重なっても1回として扱う)
  const disconnectFlowRef = useRef(false);
  // 下書き保存・保存の失敗(走行中に知らせる)
  const [draftError, setDraftError] = useState(false);
  const [communicationWarning, setCommunicationWarning] = useState(false);
  const [loadRatioPercent, setLoadRatioPercent] = useState(initialLoadRatioPercent);
  // 描画品質: 'auto'(自動調整) か 'ultra' / 'high' / 'medium' / 'low' の固定。activeTierは実際に適用中の段階。
  // 'ultra'(最高・実験)は全コースで選べる。景色ごとに、映り込む水面・実在の地形・高精細な影を足す。
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
  // 景色の季節: 走る日の実際の日付(端末の暦)とコースの場所で決める(走行中は変えない)。
  // 確認用に URL の ?date=YYYY-MM-DD で日付を変えられる。竜宮城(海の底)は季節なし(null)
  const seasonRef = useRef(undefined);
  if (seasonRef.current === undefined) {
    let now = null;
    try {
      now = parseSeasonDate(window.location.search);
    } catch {
      now = null;
    }
    seasonRef.current = createCourseSeason(courseProfile, now ?? new Date());
  }
  const season = seasonRef.current;
  const seasonLabel = season ? `${season.emoji} ${season.month}月${season.day}日・${season.name}` : null;
  const wakeLockRef = useRef(null);

  const rafIdRef = useRef(null);
  const lastFrameTimeRef = useRef(null);
  const isRunningRef = useRef(false); // 景色の準備中・paused/goal-dialog中はfalse
  const bgTimerRef = useRef(null);
  const lastSnapshotRef = useRef(null);
  const lastDisplayAtRef = useRef(-Infinity);
  const finishedRef = useRef(false);
  // 切断の前にユーザーが一時停止していたか(つなぎ直しても勝手に走り出さない)
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const pausedBeforeDisconnectRef = useRef(false);
  // 景色(3Dシーン)の準備ができるまでは走行を始めない(「読み込み中」を出す)。描画品質「最高(実験)」では
  // 実在の地形の読み込み・シェーダーのコンパイルで数秒かかり、その間に走り出すと画面が固まって見えるため。
  // 準備ができたら走行時間を0から数え始める。
  const [sceneReady, setSceneReady] = useState(false);
  const sceneReadyRef = useRef(false);
  const readyTimeoutRef = useRef(null);
  const warmFramesRef = useRef(0);
  // 準備中にトレーナーが切断された(再接続して doResume されるまで、準備ができても走り出さない)
  const holdStartRef = useRef(false);

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
  // GPX の実在コースでコーナー手前の減速中か(切り替わったときだけ state を更新してバナーを出す)
  const cornerBrakingRef = useRef(false);
  const [cornerBraking, setCornerBraking] = useState(false);
  const ghostsRef = useRef(null);
  if (ghostsRef.current === null) ghostsRef.current = prepareGhosts(ghosts);
  const power3sRef = useRef(null); // 3秒平均パワー(一次遅れ)。最初のフレームで現在値から始める
  // 沿道のハプニングと観光地コースの名所(見た目と通知だけ)。上野不忍池(池の上)は対象外
  const happeningsRef = useRef(null);
  if (happeningsRef.current === null) {
    happeningsRef.current = courseProfile.scenery === 'ueno'
      ? null
      : createHappeningDirector({
        seed: seedForCourse(courseProfile.id),
        weights: courseProfile.happenings === null ? null : courseProfile.happenings ?? DEFAULT_HAPPENING_WEIGHTS,
        profile: courseProfile,
      });
  }
  const prevKcalRef = useRef(0);
  // 観光ガイド・日本縦断の通過判定用に、前のフレームの距離を持つ
  const prevDistanceMRef = useRef(0);
  // バーチャル日本縦断: この走行より前の合計距離(km)。読み込むまで null(デモは数えない)
  const journeyBaseKmRef = useRef(null);

  // 走行の時間・毎秒の記録・仕事量(js/physics/rideSession.js。画面に依存しない部分)
  const sessionRef = useRef(null);
  if (sessionRef.current === null) sessionRef.current = new RideSession(Date.now());
  const draftTimerRef = useRef(null);
  const loadRatioRef = useRef(initialLoadRatioPercent);
  const lastControlCalculatedRef = useRef(0);
  const lastControlActualRef = useRef(0);
  // ゴールのダイアログを開いている間の時間は、record.ridingTimeS(リザルトの値)の定義は変えず、
  // ゴーストの再生・サンプルの rideTimeS・集団の時間だけから除く(RideSession の goalPause)。
  const goalHandledRef = useRef(false);
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
      // パワー補正の倍率(詳細設定)を掛ける。仮想速度・表示・記録はすべて補正後のパワー。
      if (s.instPowerW !== null && s.instPowerW !== undefined) latestPowerRef.current = s.instPowerW * powerScale;
      latestCadenceRef.current = s.instCadenceRpm;
      latestRealSpeedRef.current = s.instSpeedKmh;
      latestHeartRateRef.current = s.heartRateBpm;
    };
    const onCommWarning = (ev) => setCommunicationWarning(!!ev.detail.warning);
    const onDisconnected = () => {
      if (finishedRef.current) return;
      // つなぎ直しの最中(自動の再接続・再接続のダイアログ)に届いた切断は、同じ切断の続きとして無視する
      // (自動の再接続をもう一度始めると止まらなくなり、切断前の一時停止の状態も上書きしてしまう)
      if (disconnectFlowRef.current) return;
      disconnectFlowRef.current = true;
      if (!sceneReadyRef.current) holdStartRef.current = true;
      pausedBeforeDisconnectRef.current = pausedRef.current;
      doPause({ silent: true });
      tryAutoReconnect();
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
    // デモは走行記録を残さない。走行中は下書きを一定間隔と、タブを閉じる・裏に回すときに保存する
    const onHide = () => {
      if (document.visibilityState === 'hidden') saveDraft();
    };
    const onBeforeUnload = (e) => {
      if (finishedRef.current) return;
      saveDraft();
      // 走行中に閉じる・再読み込みしようとしたら確かめる(下書きは残るので次回に保存できる)
      e.preventDefault();
      e.returnValue = '';
    };
    if (!demo) {
      draftTimerRef.current = setInterval(saveDraft, DRAFT_INTERVAL_MS);
      document.addEventListener('visibilitychange', onHide);
      window.addEventListener('pagehide', saveDraft);
      window.addEventListener('beforeunload', onBeforeUnload);
    }
    // 景色がいつまでも準備できない(読み込みが止まった等)ときも、走行はできるようにする
    readyTimeoutRef.current = setTimeout(() => {
      if (!sceneReadyRef.current) console.warn('景色の準備が時間内に終わらなかったため、走行を始めます');
      handleSceneReady();
    }, SCENE_READY_TIMEOUT_MS);
    // 日本縦断の起点(これまでの走行記録の合計距離)。デモは記録しないので日本縦断も進めない
    let alive = true;
    if (!demo) {
      getRideSummaries()
        .then((rides) => { if (alive) journeyBaseKmRef.current = journeyTotalKm(rides); })
        .catch(() => { if (alive) journeyBaseKmRef.current = 0; });
    }

    return () => {
      alive = false;
      clearTimeout(readyTimeoutRef.current);
      stopLoop();
      clearInterval(draftTimerRef.current);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', saveDraft);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      wakeLockRef.current?.destroy();
      ftmsClient.removeEventListener('control-mode', onControlModeChanged);
      ftmsClient.removeEventListener('bike-data', onBikeData);
      ftmsClient.removeEventListener('communication-warning', onCommWarning);
      ftmsClient.removeEventListener('disconnected', onDisconnected);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 物理は描画(requestAnimationFrame)の間隔に関係なく実時間どおりに進める: 前回からの時間を 0.25 秒以下に
  // 刻んで進め(splitSteps)、タブが裏に回って描画が止まっている間はタイマーで進める(レビュー Q2)。
  const startLoop = () => {
    lastFrameTimeRef.current = performance.now();
    const tick = (now) => {
      rafIdRef.current = requestAnimationFrame(tick);
      runFrame(now, true);
    };
    rafIdRef.current = requestAnimationFrame(tick);
    bgTimerRef.current = setInterval(() => {
      if (document.hidden) runFrame(performance.now(), false);
    }, BACKGROUND_STEP_MS);
  };

  const runFrame = (now0, visible) => {
    // rAF の時刻はタイマーで進めた時刻より少し古いことがある(時間を戻して二重に数えない)
    const now = Math.max(now0, lastFrameTimeRef.current);
    const dt = (now - lastFrameTimeRef.current) / 1000;
    lastFrameTimeRef.current = now;
    if (isRunningRef.current) {
      // 端末のスリープなどで追いつける時間(CATCH_UP_MAX_S)より長く空いたら、その間は進めず、走行時間にも数えない
      if (dt > CATCH_UP_MAX_S) {
        const wall = Date.now();
        sessionRef.current.pause(wall - dt * 1000);
        sessionRef.current.resume(wall);
        return;
      }
      advance(dt, visible);
    } else if (!sceneReadyRef.current && visible) {
      drawWhileLoading();
    }
  };

  // 準備中はスタート地点を描き続けて、シーンに組み立て・初回描画を進めさせる(物理・時間は進めない)。
  // 最初の2フレームは描かない: 「読み込み中」の表示を先に画面へ出してから、重い初回描画に入る。
  const drawWhileLoading = () => {
    warmFramesRef.current += 1;
    if (warmFramesRef.current <= 2 || !cityRef.current) return;
    const drawArgs = {
      distanceKm: 0,
      speedKmh: 0,
      others: packRef.current.map(packOther),
      myLaneOffsetM: myLaneRef.current,
      // スタート地点の名所(ハプニングは走り出してから)
      actors: happeningsRef.current ? landmarkActors(courseProfile, 0) : undefined,
    };
    lastDrawArgsRef.current = drawArgs;
    cityRef.current.draw(drawArgs);
  };

  // シーンから「準備ができた」(または景色なしで走るしかない)と知らされたら走行を始める
  const handleSceneReady = () => {
    if (sceneReadyRef.current) return;
    sceneReadyRef.current = true;
    clearTimeout(readyTimeoutRef.current);
    sessionRef.current.start(Date.now());
    lastFrameTimeRef.current = performance.now();
    setSceneReady(true);
    if (holdStartRef.current) {
      // 準備中に切断された: 一時停止の扱いにして、再接続後の doResume で走り出す
      sessionRef.current.pause(Date.now());
      return;
    }
    isRunningRef.current = true;
  };

  const stopLoop = () => {
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = null;
    clearInterval(bgTimerRef.current);
    bgTimerRef.current = null;
  };

  /**
   * 前のフレームから dt 秒ぶん走行を進める。物理は 0.25 秒以下の刻みで何回か進め(simulate)、
   * 表示・描画・トレーナーへの指示は最後に1回だけ(present)。visible でなければ描画しない(タブが裏)。
   */
  const advance = (dt, visible) => {
    const { count, stepS } = splitSteps(dt);
    const nowMs = Date.now();
    const t0 = nowMs - count * stepS * 1000;
    const events = [];
    let happening = null;
    let ghostState = null;
    for (let i = 0; i < count; i++) {
      const r = simulate(stepS, t0 + stepS * 1000 * (i + 1), events);
      if (r.happening) happening = r.happening;
      ghostState = r.ghostState;
      lastSnapshotRef.current = r.snapshot;
      if (r.stop) break;
    }
    if (!lastSnapshotRef.current || !ghostState) return;
    present(lastSnapshotRef.current, ghostState, happening, events, visible);
  };

  /** 物理を1刻み(dt 秒、時刻 tMs)進める。通知は events に足す。ゴールで止まったら stop: true。 */
  const simulate = (dt, tMs, events) => {
    const physics = physicsRef.current;
    const courseEngine = courseEngineRef.current;
    const session = sessionRef.current;
    if (demo) {
      // 仮想ライダー: 現在の勾配に応じたパワー・ケイデンスを生成する
      const target = demoRiderTarget(physics.currentGradePercent, session.ridingS(tMs));
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
      stepPack(pack, dt, { gradeAtKm: courseEngine, crr, cdaM2, tSec: session.ghostS(tMs), me });
      draftingRef.current = isDrafting(me, pack);
      physics.setDraftFactor(draftingRef.current ? PhysicsConstants.DRAFT_CDA_FACTOR : 1);
      myLaneRef.current = stepLane(myLaneRef.current, laneTarget(me, pack), dt);
    }
    const snapshot = physics.step(dt);
    const powerNow = latestPowerRef.current ?? 0;
    power3sRef.current = power3sRef.current === null
      ? powerNow
      : power3sRef.current + (powerNow - power3sRef.current) * (1 - Math.exp(-Math.max(0, dt) / POWER_AVG_TAU_S));
    session.addWork(powerNow, dt);

    // ゴースト: 走行時間(一時停止を除く)で記録を再生し、差と抜いた/抜かれたを求める
    const ghostState = stepGhosts(ghostsRef.current, session.ghostS(tMs), { distanceM: snapshot.distanceM, speedMps: snapshot.speedKmh / 3.6 });
    for (const ev of ghostState.events) events.push(overtakeToast(ev));
    // 沿道のハプニング・名所(シーンへ actors として渡す)
    const happening = happeningsRef.current
      ? happeningsRef.current.step({ distanceM: snapshot.distanceM, speedMps: snapshot.speedKmh / 3.6, dt })
      : null;
    if (happening) events.push(...happening.events);

    // 毎秒の記録(走行時間の1秒ごと。デモは記録しない)
    if (!demo) {
      const sampled = session.maybeSample(tMs, {
        powerW: latestPowerRef.current,
        speedKmh: snapshot.speedKmh,
        cadenceRpm: latestCadenceRef.current,
        elevationM: snapshot.elevationM,
        gradePercent: snapshot.gradePercent,
        distanceM: snapshot.distanceM,
      });
      // 最初のサンプルを取ったら下書きを一度保存しておく(以後は一定間隔と、閉じる・裏に回すとき)
      if (sampled && session.samples.length === 1) saveDraft();
    }

    const distanceKm = snapshot.distanceM / 1000;
    let stop = false;
    if (demo && !courseProfile.fixedLength && courseEngine.isGoalReached(distanceKm)) {
      // デモはゴールで止まらず、そのまま次の周回へ(自動走行を続ける)。
      // ループしない実在コース(fixedLength)はデモでもゴールで止まる(下の分岐)。
      courseEngine.extendGoal();
      events.push({ kind: 'demoLap', kicker: 'デモ走行', title: 'ゴール！', sub: 'デモはそのまま次の周回を走ります。' });
    } else if (!goalHandledRef.current && courseEngine.isGoalReached(distanceKm)) {
      goalHandledRef.current = true;
      isRunningRef.current = false;
      session.goalPause(tMs);
      if (!demo) ftmsClient.pause();
      setShowGoalDialog(true);
      stop = true;
    }
    return { snapshot, ghostState, happening, stop };
  };

  /** 進めた結果を、トレーナーへの指示・通知・ダッシュボード・3D の景色に出す(1フレームに1回)。 */
  const present = (snapshot, ghostState, happening, events, visible) => {
    const courseEngine = courseEngineRef.current;
    const session = sessionRef.current;
    const nowMs = Date.now();
    if (snapshot.cornerBraking !== cornerBrakingRef.current) {
      cornerBrakingRef.current = snapshot.cornerBraking;
      setCornerBraking(snapshot.cornerBraking);
    }
    const distanceKm = snapshot.distanceM / 1000;

    // トレーナーへの負荷指示 (負荷率は実負荷指示のみに影響)。ゴールで止めたときは送らない
    const ratio = loadRatioRef.current / 100;
    if (demo || !isRunningRef.current) {
      // デモではトレーナーへ負荷指示を送らない
    } else if (controlModeRef.current === 'simulation') {
      const calculated = snapshot.gradePercent * ratio;
      lastControlCalculatedRef.current = calculated;
      const result = ftmsClient.setGrade(calculated);
      if (result && result.actual !== undefined) {
        lastControlActualRef.current = result.actual;
      }
    } else if (controlModeRef.current === 'erg') {
      // 目標Wはトレーナーの計るパワーで指示するので、パワー補正の倍率で割って戻す
      const requiredW = physicsRef.current.computeErgTargetWatts() / powerScale;
      const calculated = requiredW * ratio;
      lastControlCalculatedRef.current = calculated;
      const result = ftmsClient.setErgTarget(calculated);
      if (result && result.actual !== undefined) {
        lastControlActualRef.current = result.actual;
      }
    }

    // シーン・canvas に渡す他のライダー(ゴースト+集団)
    const pack = packRef.current;
    const others = pack.length > 0 ? ghostState.others.concat(pack.map(packOther)) : ghostState.others;

    // 観光ガイド・日本縦断・グルメ換算の通知
    const prevDistanceM = prevDistanceMRef.current;
    prevDistanceMRef.current = snapshot.distanceM;
    const kcal = kcalFromWorkKj(session.workJ / 1000);
    events.push(...guideEventsBetween(courseProfile, prevDistanceM, snapshot.distanceM));
    if (journeyBaseKmRef.current !== null) {
      const base = journeyBaseKmRef.current;
      for (const p of citiesPassed(base + prevDistanceM / 1000, base + snapshot.distanceM / 1000)) events.push(journeyToast(p));
    }
    const gourmetEvent = gourmetMilestone(prevKcalRef.current, kcal, courseProfile);
    prevKcalRef.current = kcal;
    if (gourmetEvent) events.push(gourmetEvent);
    // 同じフレームに複数あれば最後のものを出す(新しい通知が来たら差し替える既存の方針どおり)
    if (events.length > 0) showToast(events[events.length - 1]);

    // ダッシュボード/フルスクリーンHUD更新 (ref経由でDOM直接更新)。数値は毎秒10回で足りるので間引く
    // (ゴールで止まったフレームは必ず出す)
    const now = performance.now();
    if (visible && (now - lastDisplayAtRef.current >= DISPLAY_INTERVAL_MS || !isRunningRef.current)) {
      lastDisplayAtRef.current = now;
      // 次の500mの平均勾配(%) = 標高差(m) / 500m × 100
      const next500 = courseEngine.elevationDeltaM(distanceKm, distanceKm + 0.5) / 5;
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
        elapsedTime: fmtTime(session.elapsedS(nowMs)),
        ridingTime: fmtTime(session.ridingS(nowMs)),
        kcal: kcal.toFixed(0),
        gourmet: gourmetLine(kcal, courseProfile),
        loadRatio: String(loadRatioRef.current),
        ghosts: ghostState.ghosts,
        drafting: draftingRef.current,
        cornerBraking: !!snapshot.cornerBraking,
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
    }
    const drawArgs = {
      distanceKm,
      speedKmh: snapshot.speedKmh,
      others,
      // ケイデンスを受信していない(null)ときは undefined にしてシーン側の速度からの推定に任せる
      cadenceRpm: latestCadenceRef.current ?? undefined,
      myLaneOffsetM: myLaneRef.current,
      actors: happening ? happening.actors : lastDrawArgsRef.current?.actors,
    };
    lastDrawArgsRef.current = drawArgs;
    if (visible && cityRef.current) {
      cityRef.current.draw(drawArgs);
    }
  };

  // 通知を約4.6秒出す(新しい通知が来たら差し替える)
  const showToast = (t) => {
    setToast(t);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  /** ここまでの走行記録(保存する形)。 */
  const buildRecord = () => {
    const physics = physicsRef.current;
    return sessionRef.current.toRecord(Date.now(), {
      courseId: courseProfile.id,
      courseName: courseProfile.name,
      goalDistanceKm,
      totalDistanceM: physics.distanceM,
      elevationGainM: physics.elevationGainM,
    });
  };

  // 下書きを保存する(走り出してから、まだ終了していないときだけ)。失敗したら走行画面に知らせる
  const saveDraft = () => {
    if (demo || finishedRef.current || !sceneReadyRef.current || sessionRef.current.samples.length === 0) return;
    saveRideDraft(buildRecord()).then(
      () => setDraftError(false),
      (err) => {
        console.warn('走行の途中保存に失敗しました:', err);
        setDraftError(true);
      },
    );
  };

  const doPause = useCallback(({ silent } = {}) => {
    if (!isRunningRef.current) return;
    isRunningRef.current = false;
    sessionRef.current.pause(Date.now());
    if (!demo) ftmsClient.pause();
    wakeLockRef.current?.disable();
    if (!silent) setPaused(true);
  }, [ftmsClient]);

  const doResume = useCallback(() => {
    if (isRunningRef.current) return;
    if (!sceneReadyRef.current) {
      // まだ景色の準備中(準備中に切断→再接続した): 準備ができたら走り出す
      holdStartRef.current = false;
      return;
    }
    sessionRef.current.resume(Date.now());
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
    if (finishedRef.current) return;
    finishedRef.current = true;
    stopLoop();
    clearInterval(draftTimerRef.current);
    wakeLockRef.current?.disable();
    const record = buildRecord();

    // 走行終了後もBLE接続は保つ(次の走行で再ペアリング不要にするため。要件定義書1章の
    // 「毎回デバイス選択」をユーザーの指示で変更)。トレーナーは負荷0で待機させ、
    // 次の開始時に App が beginSession() で制御権を取り直す。
    ftmsClient.endSession();
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
    sessionRef.current.goalResume(Date.now());
    doResume();
  };

  const handleGoalFinish = () => {
    setShowGoalDialog(false);
    finalizeRide();
  };

  // つなぎ直せたら: 切断の前にユーザーが一時停止していたら一時停止のまま、ゴールのダイアログ表示中も
  // 走行を再開しない(実在コースでは終点の先へ進んでしまう)。それ以外は走行を再開する
  const afterReconnect = () => {
    disconnectFlowRef.current = false;
    setShowReconnectDialog(false);
    setAutoReconnect(null);
    if (!goalHandledRef.current && !pausedBeforeDisconnectRef.current) doResume();
  };

  // 切断されたら、同じ機器へ何回か自動でつなぎ直す(機器の選択画面なし。レビュー F2)。
  // 全部失敗したら再接続のダイアログを出す(ダイアログからは機器を選び直すか、終了して保存できる)
  const autoReconnectIdRef = useRef(0);
  const tryAutoReconnect = async () => {
    const id = ++autoReconnectIdRef.current;
    const attempts = ftmsClient.device ? DeviceProfile.AUTO_RECONNECT_ATTEMPTS : 0;
    for (let i = 1; i <= attempts; i++) {
      setAutoReconnect(i);
      await new Promise((r) => setTimeout(r, DeviceProfile.AUTO_RECONNECT_DELAY_MS));
      if (id !== autoReconnectIdRef.current || finishedRef.current) return;
      try {
        await ftmsClient.reconnect();
        if (id !== autoReconnectIdRef.current || finishedRef.current) return;
        afterReconnect();
        return;
      } catch (err) {
        console.warn(`自動の再接続に失敗しました(${i}/${attempts}):`, err);
      }
    }
    if (id !== autoReconnectIdRef.current || finishedRef.current) return;
    setAutoReconnect(null);
    setShowReconnectDialog(true);
  };

  const handleReconnect = async () => {
    autoReconnectIdRef.current++; // 自動の再接続は止める
    setReconnecting(true);
    setReconnectError(null);
    try {
      await ftmsClient.connect();
      afterReconnect();
    } catch (err) {
      setReconnectError(err.message ?? String(err));
    } finally {
      setReconnecting(false);
    }
  };

  // つなぎ直せないとき(トレーナーの電源が落ちた等)も、そこまでの記録を保存して終われる(レビュー F1)
  const handleDisconnectedFinish = () => {
    autoReconnectIdRef.current++;
    setShowReconnectDialog(false);
    finalizeRide();
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
        : h('p', { className: 'fs-env-note' }, `${courseProfile.name}は時間帯だけが反映されます。`)
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
      // WebGPU で描いているときは「描画品質・WebGPU」と出す(gpuBackend.js)
      h('span', { title: `${gpuBackendMode()?.startsWith('webgpu') ? 'WebGPU' : 'WebGL'} で描画中` },
        gpuBackendMode()?.startsWith('webgpu') ? '描画品質・WebGPU' : '描画品質'),
      h(
        'select', { value: qualityMode, onChange: handleQualityChange, 'aria-label': '描画品質' },
        ['auto', 'ultra', 'high', 'medium', 'low'].map((mode) =>
          h('option', { key: mode, value: mode },
            mode === 'auto' && activeTier ? `自動（現在: ${QUALITY_LABELS[activeTier]}）`
              // 最高(実験)が重すぎて自動で下げたときは「最高(実験)→高」のように実際の段階も出す
              : mode === qualityMode && activeTier && activeTier !== mode ? `${QUALITY_LABELS[mode]}→${QUALITY_LABELS[activeTier]}`
              : QUALITY_LABELS[mode])
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
    season,
    qualityMode,
    onQualityChange: setActiveTier,
    onReady: handleSceneReady,
  };
  const loadingUltra = qualityMode === 'ultra' || activeTier === 'ultra';

  return h(
    'div', { className: 'screen ride-screen' },
    demo && h('div', { className: 'banner banner-info demo-banner' }, '▶ デモ走行中（トレーナー未接続・自動走行。走行記録は保存されません）'),
    demo && toast?.kind === 'demoLap' && h('div', { className: 'banner banner-info' }, '🏁 ゴール！ デモはそのまま次の周回を走ります。'),
    toast?.kind === 'ghost' && h('div', { className: 'banner banner-info ghost-banner' }, `👻 ${toast.title}(${toast.sub})`),
    // 沿道のハプニング・観光ガイド・日本縦断・グルメ換算(フルスクリーン中は HUD の通知に出る)
    toast && FUN_TOAST_KINDS.includes(toast.kind) && !isFullscreen &&
      h('div', { className: `banner banner-info fun-banner fun-${toast.kind}`, role: 'status' },
        h('strong', null, `${toast.kicker} — ${toast.title}`),
        toast.sub && h('span', { className: 'fun-banner-sub' }, toast.sub)),
    communicationWarning && h('div', { className: 'banner banner-warning' }, '⚠ トレーナーとの通信が不安定です。'),
    autoReconnect !== null && h('div', { className: 'banner banner-warning', role: 'status' },
      `⚠ トレーナーとの接続が切れました。つなぎ直しています…(${autoReconnect}/${DeviceProfile.AUTO_RECONNECT_ATTEMPTS})走行は一時停止しています。`),
    draftError && h('div', { className: 'banner banner-warning', role: 'alert' }, '⚠ 走行の途中保存ができていません(ブラウザの保存領域を確認してください)。終了すると保存を試みます。'),
    cornerBraking && h('div', { className: 'banner banner-info corner-banner' }, '↪ コーナーのため減速中(曲がれる速度までブレーキ。トレーナーの負荷は変わりません)'),
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
          : courseProfile.scenery === 'atami'
            // 熱海は実在の街(PLATEAU の建物・国土地理院の地形と道路)を実在の座標に組んだ専用の景色
            ? h(AtamiScene, sceneProps)
            : REAL_TOWNS[courseProfile.scenery]
              // 京都・奈良・河口湖も実在の街(PLATEAU または国土地理院の建物の形・地形・道路)
              ? h(RealTownScene, { ...sceneProps, town: courseProfile.scenery })
              : h(LandscapeScene, { ...sceneProps, landscape: courseProfile.scenery }),
      // ?perf=1 のときだけ、描画の重さ(fps・描画命令・三角形・段階・解像度・描画の方式)を左下に出す
      SHOW_PERF && h(PerfPanel, { sceneRef: cityRef }),
      // 景色の準備ができるまでは走行を始めない(フルスクリーンでも見えるよう ride-stage の中に出す)
      !sceneReady &&
        h(
          'div', { className: 'scene-loading', role: 'status', 'aria-live': 'polite' },
          h('div', { className: 'scene-loading-spinner', 'aria-hidden': 'true' }),
          h('strong', null, '景色を読み込み中…'),
          h('span', null, '準備ができると走行が始まります(それまではペダルを回しても進みません)。'),
          loadingUltra && h('span', { className: 'scene-loading-note' }, '描画品質「最高(実験)」は、実在の地形の読み込みなどで準備に時間がかかります。')
        ),
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
            chips: [environmentLabel(environment, courseProfile), ...(seasonLabel ? [seasonLabel] : [])],
          },
          // H: 操作(一時停止・視点・環境・描画品質・全画面を終了)
          h(
            'div', { className: 'fs-toolbar' },
            h('button', { className: 'btn', onClick: handlePauseButton, disabled: !sceneReady || autoReconnect !== null }, paused ? '再開' : '一時停止'),
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
      qualitySelect('quality-select'),
      // 景色の季節は走る日の暦どおり(桜・新緑・紅葉・雪)
      seasonLabel && h('span', { className: 'season-chip', title: '景色の季節は今日の日付に合わせています' }, seasonLabel)
    ),
    h(Dashboard, { ref: dashboardRef, controlMode }),
    h(
      'div', { className: 'load-ratio-live' },
      h('label', null,
        `負荷率: ${loadRatioPercent}%`,
        h('input', {
          type: 'range', min: 0, max: 100, step: 1, value: loadRatioPercent,
          onChange: (e) => {
            const v = Number(e.target.value);
            setLoadRatioPercent(v);
            savePrefs({ loadRatioPercent: v }); // 走行中に変えた負荷率も次回の初期値にする
          },
        })
      )
    ),
    h(
      'div', { className: 'ride-controls' },
      h('button', { className: 'btn btn-secondary btn-large', onClick: handlePauseButton, disabled: !sceneReady || autoReconnect !== null }, paused ? '再開' : '一時停止'),
      h('button', { className: 'btn btn-danger btn-large', onClick: handleEndRequest }, demo ? 'デモを終了' : '終了')
    ),
    !demo && h('p', { className: 'guidance-note' }, '走行の記録は30秒ごとに途中保存しています。タブが閉じても、次に開いたときに保存できます。'),

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

    // 実在コース(fixedLength)はコース全長より先が無いので「続行」は出さない
    showGoalDialog && courseProfile.fixedLength &&
      h(ConfirmDialog, {
        title: 'ゴールしました！',
        message: demo ? 'コースを走り切りました。デモを終了します。' : 'コースを走り切りました。',
        confirmLabel: demo ? 'セットアップに戻る' : 'リザルトを見る',
        onConfirm: demo ? () => onExitDemo?.() : handleGoalFinish,
      }),

    showGoalDialog && !courseProfile.fixedLength &&
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
          : 'Bluetooth接続が切れ、自動でつなぎ直せませんでした。走行は一時停止しています。トレーナーの電源を確かめて再接続するか、ここまでの記録を保存して終了してください。',
        confirmLabel: reconnecting ? '接続中...' : '再接続する(機器を選ぶ)',
        onConfirm: handleReconnect,
        cancelLabel: demo ? undefined : '終了して保存する',
        onCancel: demo ? undefined : handleDisconnectedFinish,
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

function fmtOrDash(value, digits) {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return value.toFixed(digits);
}

/**
 * ?perf=1 のときの描画の重さ(1フレームの間隔・描画の処理時間・描画命令と三角形の数・品質の段階・画素の倍率・
 * 描画の方式。PandaCycleExpedition と同じ)。走行画面を再描画しないよう、この部品だけが0.5秒ごとに読み直す。
 */
function PerfPanel({ sceneRef }) {
  const [perf, setPerf] = useState(null);
  useEffect(() => {
    const id = setInterval(() => setPerf(sceneRef.current?.stats?.() ?? null), 500);
    return () => clearInterval(id);
  }, []);
  if (!perf) return null;
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  return h('div', { className: 'perf-panel' },
    `${f(1000 / perf.frameMs, 0)} fps(${f(perf.frameMs)} ms)・描画の処理 ${f(perf.drawMs)} ms`,
    h('br'), `描画命令 ${perf.calls}・三角形 ${(perf.triangles / 1e3).toFixed(0)} 千・${perf.tier ?? '-'}・画素 ×${f(perf.pixelRatio, 2)}・${perf.backend}`);
}
