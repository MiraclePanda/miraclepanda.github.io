import { h, useState, useRef, useCallback, useEffect } from './h.js';
import { FtmsClient } from '../ble/ftmsClient.js';
import { getCourseProfile } from '../physics/courseProfiles.js';
import { loadPrefs, savePrefs } from '../storage/prefs.js';
import { saveRide } from '../storage/db.js';
import { isBluetoothSupported, isSecureContextOk, UnsupportedGuidance } from './CompatibilityGate.js';
import { SetupScreen } from './SetupScreen.js';
import { RideScreen } from './RideScreen.js';
import { ResultScreen } from './ResultScreen.js';
import { HistoryScreen } from './HistoryScreen.js';

export function App() {
  const [screen, setScreen] = useState('setup'); // 'setup' | 'riding' | 'result' | 'history'
  const [prevScreen, setPrevScreen] = useState('setup');
  const [deviceState, setDeviceState] = useState({ connected: false, connecting: false, deviceName: null, controlMode: null, error: null });
  const [sessionConfig, setSessionConfig] = useState(null);
  const [lastRecord, setLastRecord] = useState(null);

  const ftmsClientRef = useRef(null);
  if (!ftmsClientRef.current) {
    ftmsClientRef.current = new FtmsClient();
  }
  const prefs = loadPrefs();
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // 走行画面以外(セットアップ・リザルト等)で予期せず切断された場合に表示状態を追従させる。
  // 走行中の切断はRideScreen自身が一時停止・再接続ダイアログで処理する。
  useEffect(() => {
    const client = ftmsClientRef.current;
    const onDisconnected = () => {
      if (screenRef.current === 'riding') return;
      setDeviceState({ connected: false, connecting: false, deviceName: null, controlMode: null, error: null });
    };
    client.addEventListener('disconnected', onDisconnected);
    return () => client.removeEventListener('disconnected', onDisconnected);
  }, []);

  const handleConnectDevice = useCallback(async () => {
    setDeviceState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const result = await ftmsClientRef.current.connect();
      setDeviceState({ connected: true, connecting: false, deviceName: result.deviceName || '(不明なデバイス)', controlMode: result.controlMode, error: null });
    } catch (err) {
      if (err?.name === 'NotFoundError') {
        // ユーザーがデバイス選択をキャンセルした場合はエラー表示不要。
        setDeviceState((s) => ({ ...s, connecting: false }));
        return;
      }
      setDeviceState({ connected: false, connecting: false, deviceName: null, controlMode: null, error: err.message ?? String(err) });
    }
  }, []);

  const handleDisconnectDevice = useCallback(() => {
    ftmsClientRef.current.disconnect();
    setDeviceState({ connected: false, connecting: false, deviceName: null, controlMode: null, error: null });
  }, []);

  const handleStart = useCallback(async (config) => {
    // セットアップ画面は変更した時点で保存しているが、開始した設定は念のためここでも保存する
    savePrefs({
      // 実在コースの走行距離(コース全長)は組み込みコース用の前回値として残さない
      distanceKm: config.courseProfile?.fixedLength ? undefined : config.distanceKm,
      weightKg: config.weightKg,
      bikeWeightKg: config.bikeWeightKg,
      crr: config.crr,
      cdaM2: config.cdaM2,
      vehicle: config.preferredVehicle ?? config.vehicle,
      ftpW: config.ftpW,
      powerScale: config.powerScale,
      courseId: config.courseId,
      loadRatioPercent: config.loadRatioPercent,
    });
    // 前の走行のあと接続を保っている場合は、制御権を取り直してトレーナーを負荷制御に戻す。
    // 失敗したら接続を切り、セットアップ画面でつなぎ直してもらう。
    const client = ftmsClientRef.current;
    if (client.sessionEnded) {
      setDeviceState((s) => ({ ...s, connecting: true, error: null }));
      try {
        await client.beginSession();
        setDeviceState((s) => ({ ...s, connecting: false, controlMode: client.controlMode }));
      } catch (err) {
        await client.disconnect();
        setDeviceState({ connected: false, connecting: false, deviceName: null, controlMode: null, error: err.message ?? String(err) });
        return;
      }
    }
    // 詳細設定のCrr/CdAはSimulation Modeでトレーナーにも送る(物理演算側はRideScreenへ渡す)。
    ftmsClientRef.current.setSimulationCoefficients({ crr: config.crr, cdaM2: config.cdaM2 });
    // FTMS User Data Service (体重書き込み) はベストエフォート。結果は待たずに進める。
    ftmsClientRef.current.tryWriteUserWeight(config.weightKg).catch(() => {});
    setSessionConfig({
      ...config,
      // GPX の実在コースはセットアップ画面が profile ごと渡す
      courseProfile: config.courseProfile ?? getCourseProfile(config.courseId),
    });
    setScreen('riding');
  }, []);

  // デモ: トレーナー接続不要。設定は保存せず、トレーナーにも何も送らない。
  const handleDemo = useCallback((config) => {
    setSessionConfig({
      ...config,
      // GPX の実在コースはセットアップ画面が profile ごと渡す
      courseProfile: config.courseProfile ?? getCourseProfile(config.courseId),
      demo: true,
    });
    setScreen('riding');
  }, []);

  const handleDemoExit = useCallback(() => {
    setScreen('setup');
  }, []);

  const handleRideFinish = useCallback(async (record) => {
    // 接続は保つ(RideScreen が endSession() 済み)。走行中の再接続でモードが変わっていることがあるので
    // 表示はクライアントの現在値に合わせる。途中で切れていれば未接続に戻す。
    const client = ftmsClientRef.current;
    setDeviceState(client.isConnected
      ? { connected: true, connecting: false, deviceName: client.device?.name || '(不明なデバイス)', controlMode: client.controlMode, error: null }
      : { connected: false, connecting: false, deviceName: null, controlMode: null, error: null });
    let id = null;
    try {
      id = await saveRide(record);
    } catch (e) {
      // IndexedDB保存失敗時もリザルト表示自体は継続する。
    }
    setLastRecord({ ...record, id });
    setScreen('result');
  }, []);

  const openHistory = useCallback(() => {
    setPrevScreen(screen);
    setScreen('history');
  }, [screen]);

  const closeHistory = useCallback(() => {
    setScreen(prevScreen);
  }, [prevScreen]);

  if (!isBluetoothSupported() || !isSecureContextOk()) {
    return h(UnsupportedGuidance);
  }

  const setupProps = {
    initialDistanceKm: prefs.distanceKm,
    initialWeightKg: prefs.weightKg,
    initialBikeWeightKg: prefs.bikeWeightKg,
    initialCrr: prefs.crr,
    initialCdaM2: prefs.cdaM2,
    initialVehicle: prefs.vehicle,
    initialFtpW: prefs.ftpW,
    initialPowerScale: prefs.powerScale,
    initialCourseId: prefs.courseId,
    initialLoadRatioPercent: prefs.loadRatioPercent,
    deviceState,
    onConnectDevice: handleConnectDevice,
    onDisconnectDevice: handleDisconnectDevice,
    onStart: handleStart,
    onDemo: handleDemo,
    onOpenHistory: openHistory,
  };

  if (screen === 'setup') {
    return h(SetupScreen, setupProps);
  }

  if (screen === 'riding' && sessionConfig) {
    return h(RideScreen, {
      key: sessionConfig.startedAt ?? 'ride',
      ftmsClient: ftmsClientRef.current,
      controlMode: deviceState.controlMode,
      riderWeightKg: sessionConfig.weightKg,
      bikeWeightKg: sessionConfig.bikeWeightKg,
      crr: sessionConfig.crr,
      cdaM2: sessionConfig.cdaM2,
      vehicle: sessionConfig.vehicle,
      courseProfile: sessionConfig.courseProfile,
      goalDistanceKm: sessionConfig.distanceKm,
      initialLoadRatioPercent: sessionConfig.loadRatioPercent,
      ftpW: sessionConfig.ftpW,
      powerScale: sessionConfig.powerScale,
      initialEnvironment: sessionConfig.environment,
      ghosts: sessionConfig.ghosts,
      packEnabled: !!sessionConfig.packEnabled,
      demo: !!sessionConfig.demo,
      onExitDemo: handleDemoExit,
      onFinish: handleRideFinish,
    });
  }

  if (screen === 'result' && lastRecord) {
    return h(ResultScreen, {
      record: lastRecord,
      onBackToSetup: () => setScreen('setup'),
      onOpenHistory: openHistory,
    });
  }

  if (screen === 'history') {
    return h(HistoryScreen, { onBack: closeHistory });
  }

  return h(SetupScreen, setupProps);
}
