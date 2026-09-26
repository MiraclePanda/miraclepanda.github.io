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

  const handleStart = useCallback((config) => {
    savePrefs({ weightKg: config.weightKg, bikeWeightKg: config.bikeWeightKg });
    // FTMS User Data Service (体重書き込み) はベストエフォート。結果は待たずに進める。
    ftmsClientRef.current.tryWriteUserWeight(config.weightKg).catch(() => {});
    setSessionConfig({
      ...config,
      courseProfile: getCourseProfile(config.courseId),
    });
    setScreen('riding');
  }, []);

  const handleRideFinish = useCallback(async (record) => {
    setDeviceState({ connected: false, connecting: false, deviceName: null, controlMode: null, error: null });
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

  if (screen === 'setup') {
    return h(SetupScreen, {
      initialWeightKg: prefs.weightKg,
      initialBikeWeightKg: prefs.bikeWeightKg,
      deviceState,
      onConnectDevice: handleConnectDevice,
      onDisconnectDevice: handleDisconnectDevice,
      onStart: handleStart,
      onOpenHistory: openHistory,
    });
  }

  if (screen === 'riding' && sessionConfig) {
    return h(RideScreen, {
      key: sessionConfig.startedAt ?? 'ride',
      ftmsClient: ftmsClientRef.current,
      controlMode: deviceState.controlMode,
      riderWeightKg: sessionConfig.weightKg,
      bikeWeightKg: sessionConfig.bikeWeightKg,
      courseProfile: sessionConfig.courseProfile,
      goalDistanceKm: sessionConfig.distanceKm,
      initialLoadRatioPercent: sessionConfig.loadRatioPercent,
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

  return h(SetupScreen, {
    initialWeightKg: prefs.weightKg,
    initialBikeWeightKg: prefs.bikeWeightKg,
    deviceState,
    onConnectDevice: handleConnectDevice,
    onDisconnectDevice: handleDisconnectDevice,
    onStart: handleStart,
    onOpenHistory: openHistory,
  });
}
