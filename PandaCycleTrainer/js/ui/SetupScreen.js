import { h, useState, useEffect, useMemo } from './h.js';
import { COURSE_PROFILES } from '../physics/courseProfiles.js';
import { PhysicsConstants } from '../physics/physicsConstants.js';
import {
  validateWeight,
  validateBikeWeight,
  validateDistance,
  validateCrr,
  validateCda,
  validateFtp,
  LIMITS,
} from '../utils/validation.js';
import {
  DEFAULT_FTP_W,
  loadEnvironment,
  saveEnvironment,
  loadGhostSelection,
  saveGhostSelection,
  loadFriendGhosts,
  loadPackEnabled,
  savePackEnabled,
  PB_GHOST_ID,
  MAX_GHOSTS,
} from '../storage/prefs.js';
import { getAllRides } from '../storage/db.js';
import { bestRecordFor, fromRecord } from '../storage/ghostTrack.js';
import { GHOST_COLORS } from './ghostRace.js';
import { TIME_OPTIONS, WEATHER_OPTIONS, supportsWeather } from './rideOptions.js';

/**
 * 初期セットアップ画面。
 * 要件定義書5章「初期セットアップ: 走行距離・体重・自転車重量・コース選択の入力と、
 * デバイス接続は任意の順序で実施可能。両方揃った時点で「開始」ボタンが活性化する」に対応。
 * 走行距離・体重・自転車重量・詳細設定(Crr/CdA/FTP)は前回値(prefs.js)を初期値にする。
 * 景観(時間帯・天候)は選んだ時点で保存する(描画品質と同じく、走行開始を待たない)。
 */
export function SetupScreen({
  initialDistanceKm,
  initialWeightKg,
  initialBikeWeightKg,
  initialCrr,
  initialCdaM2,
  initialVehicle,
  initialFtpW,
  deviceState,
  onConnectDevice,
  onDisconnectDevice,
  onStart,
  onDemo,
  onOpenHistory,
}) {
  const [distanceKm, setDistanceKm] = useState(initialDistanceKm ?? '');
  const [weightKg, setWeightKg] = useState(initialWeightKg ?? '');
  const [bikeWeightKg, setBikeWeightKg] = useState(initialBikeWeightKg ?? '');
  const [courseId, setCourseId] = useState(COURSE_PROFILES[0].id);
  const [loadRatioPercent, setLoadRatioPercent] = useState(100);
  const [vehicle, setVehicle] = useState(initialVehicle ?? 'bike');
  // コースで乗り物が固定されている場合(上野不忍池=スワンボート)。ユーザーの選択(vehicle)は
  // 変えずに残し、他のコースへ切り替えたら元の選択に戻る。
  const fixedVehicle = COURSE_PROFILES.find((c) => c.id === courseId)?.fixedVehicle ?? null;
  const effectiveVehicle = fixedVehicle ?? vehicle;
  const [crr, setCrr] = useState(initialCrr ?? PhysicsConstants.CRR);
  const [cdaM2, setCdaM2] = useState(initialCdaM2 ?? PhysicsConstants.CDA);
  const [ftpW, setFtpW] = useState(initialFtpW ?? DEFAULT_FTP_W);
  const [environment, setEnvironment] = useState(loadEnvironment);
  const courseProfile = COURSE_PROFILES.find((c) => c.id === courseId);
  // ゴースト対戦: 過去の記録(自己ベストの候補)と、読み込んだ友人のゴースト(コース一致のみ)
  const [rides, setRides] = useState(null);
  const [ghostSelection, setGhostSelection] = useState(loadGhostSelection);
  const [packEnabled, setPackEnabled] = useState(loadPackEnabled);
  useEffect(() => {
    let alive = true;
    getAllRides().then((list) => alive && setRides(list)).catch(() => alive && setRides([]));
    return () => { alive = false; };
  }, []);
  const changeEnvironment = (patch) => {
    const next = { ...environment, ...patch };
    setEnvironment(next);
    saveEnvironment(next);
  };

  const distanceCheck = validateDistance(distanceKm);
  const weightCheck = validateWeight(weightKg);
  const bikeWeightCheck = validateBikeWeight(bikeWeightKg);
  const crrCheck = validateCrr(crr);
  const cdaCheck = validateCda(cdaM2);
  const ftpCheck = validateFtp(ftpW);
  const advancedValid = crrCheck.valid && cdaCheck.valid && ftpCheck.valid;
  const isDefaultCoefficients = Number(crr) === PhysicsConstants.CRR && Number(cdaM2) === PhysicsConstants.CDA;
  // 既定値から変えている(または範囲外の)場合は最初から開いておき、閉じたまま気付かないのを防ぐ。
  const [advancedOpen, setAdvancedOpen] = useState(!isDefaultCoefficients || !advancedValid);

  // 上野不忍池は集団・ゴーストの対象外(周回の短いスワンボートコースのため)
  const ghostsSupported = courseId !== 'ueno';
  const pbRecord = useMemo(
    () => (rides && distanceCheck.valid ? bestRecordFor(rides, courseId, Number(distanceKm)) : null),
    [rides, courseId, distanceKm, distanceCheck.valid]
  );
  const friendGhosts = useMemo(() => (ghostsSupported ? loadFriendGhosts(courseId) : []), [courseId, ghostsSupported]);
  const pbReason = rides === null
    ? '記録を読み込み中...'
    : !distanceCheck.valid
      ? '走行距離を入力すると選べます。'
      : pbRecord
        ? null
        : `このコースで${Number(distanceKm)}km以上走った記録がありません。`;
  const toggleGhost = (id) => {
    // このコースで使えるものを基準に切り替える(別コース用の古い選択はここで外れる)
    const next = activeGhostIds.includes(id)
      ? activeGhostIds.filter((x) => x !== id)
      : [...activeGhostIds, id].slice(0, MAX_GHOSTS);
    setGhostSelection(next);
    saveGhostSelection(next);
  };
  // 実際に使えるものだけを選択順に並べる(自己ベストがない・別コースの友人は除く)
  const activeGhostIds = ghostsSupported
    ? ghostSelection.filter((id) => (id === PB_GHOST_ID ? !!pbRecord : friendGhosts.some((g) => g.id === id)))
    : [];
  const buildGhostTracks = () =>
    activeGhostIds.map((id) => {
      if (id === PB_GHOST_ID) return { ...fromRecord(pbRecord), id, color: GHOST_COLORS.pb };
      const g = friendGhosts.find((x) => x.id === id);
      return { id: g.id, name: g.name, courseId: g.courseId, points: g.points, color: GHOST_COLORS.friend };
    });

  const formValid =
    distanceCheck.valid && weightCheck.valid && bikeWeightCheck.valid && advancedValid && !!courseId;
  const canStart = formValid && deviceState.connected;

  // デモはトレーナー接続不要(入力内容が正しければ押せる)
  const canDemo = formValid;
  const buildConfig = () => ({
    distanceKm: Number(distanceKm),
    weightKg: Number(weightKg),
    bikeWeightKg: Number(bikeWeightKg),
    courseId,
    loadRatioPercent,
    vehicle: effectiveVehicle,
    preferredVehicle: vehicle, // 記憶するのはユーザー自身の選択
    crr: Number(crr),
    cdaM2: Number(cdaM2),
    ftpW: Number(ftpW),
    environment,
    ghosts: buildGhostTracks(),
    packEnabled: ghostsSupported && packEnabled, // 上野は集団なし
  });

  const handleStart = () => {
    if (!canStart) return;
    onStart(buildConfig());
  };

  const handleDemo = () => {
    if (!canDemo) return;
    onDemo(buildConfig());
  };

  return h(
    'div',
    { className: 'screen setup-screen' },
    h('h1', null, 'PandaCycleTrainer'),
    h('p', { className: 'subtitle' }, 'CYCPLUS DC1 対応 仮想サイクリング'),

    h(
      'section', { className: 'card' },
      h('h2', null, '① スマートトレーナー接続'),
      deviceState.connected
        ? h(
            'div', { className: 'device-status connected' },
            h('p', null, '接続中: ', h('strong', null, deviceState.deviceName)),
            h('p', { className: 'muted' }, '制御モード: ', modeLabel(deviceState.controlMode)),
            h('button', { className: 'btn btn-secondary', onClick: onDisconnectDevice }, '切断する')
          )
        : h(
            'div', { className: 'device-status' },
            h(
              'button',
              { className: 'btn btn-primary', onClick: onConnectDevice, disabled: deviceState.connecting },
              deviceState.connecting ? '接続中...' : 'トレーナーに接続する'
            ),
            deviceState.error && h('p', { className: 'error-text' }, deviceState.error)
          ),
      h(
        'p', { className: 'guidance-note' },
        '毎回の走行開始時に、お使いのデバイスをその都度選択してください。'
      )
    ),

    h(
      'section', { className: 'card' },
      h('h2', null, '② 走行設定'),
      h(
        'label', { className: 'field' },
        h('span', null, `走行距離 (km) — ${LIMITS.distanceKm.min}〜${LIMITS.distanceKm.max}`),
        h('input', {
          type: 'number',
          inputMode: 'decimal',
          min: LIMITS.distanceKm.min,
          max: LIMITS.distanceKm.max,
          step: '0.1',
          value: distanceKm,
          onChange: (e) => setDistanceKm(e.target.value),
          placeholder: '例: 20',
        }),
        !distanceCheck.valid && distanceKm !== '' && h('span', { className: 'error-text' }, distanceCheck.message)
      ),
      h(
        'label', { className: 'field' },
        h('span', null, `体重 (kg) — ${LIMITS.weightKg.min}〜${LIMITS.weightKg.max}`),
        h('input', {
          type: 'number',
          inputMode: 'decimal',
          min: LIMITS.weightKg.min,
          max: LIMITS.weightKg.max,
          step: '0.1',
          value: weightKg,
          onChange: (e) => setWeightKg(e.target.value),
        }),
        !weightCheck.valid && weightKg !== '' && h('span', { className: 'error-text' }, weightCheck.message)
      ),
      h(
        'label', { className: 'field' },
        h('span', null, `自転車重量 (kg) — ${LIMITS.bikeWeightKg.min}〜${LIMITS.bikeWeightKg.max}`),
        h('input', {
          type: 'number',
          inputMode: 'decimal',
          min: LIMITS.bikeWeightKg.min,
          max: LIMITS.bikeWeightKg.max,
          step: '0.1',
          value: bikeWeightKg,
          onChange: (e) => setBikeWeightKg(e.target.value),
        }),
        !bikeWeightCheck.valid && bikeWeightKg !== '' && h('span', { className: 'error-text' }, bikeWeightCheck.message)
      ),
      h(
        'label', { className: 'field' },
        h('span', null, `負荷率 (トレーナーへの実負荷指示のみに影響): ${loadRatioPercent}%`),
        h('input', {
          type: 'range',
          min: 0,
          max: 100,
          step: 1,
          value: loadRatioPercent,
          onChange: (e) => setLoadRatioPercent(Number(e.target.value)),
        }),
        h('span', { className: 'muted small' }, '※ 距離・速度・タイム計算は常に実コース傾斜度(100%)で計算されます。')
      ),
      h(
        'details',
        {
          className: 'advanced-settings',
          open: advancedOpen,
          onToggle: (e) => setAdvancedOpen(e.currentTarget.open),
        },
        h('summary', null, '詳細設定（転がり抵抗・空気抵抗係数・FTP）'),
        h(
          'div', { className: 'advanced-grid' },
          h(
            'label', { className: 'field' },
            h('span', null, `転がり抵抗係数 Crr — ${LIMITS.crr.min}〜${LIMITS.crr.max}`),
            h('input', {
              type: 'number',
              inputMode: 'decimal',
              min: LIMITS.crr.min,
              max: LIMITS.crr.max,
              step: '0.0005',
              value: crr,
              onChange: (e) => setCrr(e.target.value),
            }),
            !crrCheck.valid && h('span', { className: 'error-text' }, crrCheck.message)
          ),
          h(
            'label', { className: 'field' },
            h('span', null, `空気抵抗係数 CdA (m²) — ${LIMITS.cdaM2.min}〜${LIMITS.cdaM2.max}`),
            h('input', {
              type: 'number',
              inputMode: 'decimal',
              min: LIMITS.cdaM2.min,
              max: LIMITS.cdaM2.max,
              step: '0.01',
              value: cdaM2,
              onChange: (e) => setCdaM2(e.target.value),
            }),
            !cdaCheck.valid && h('span', { className: 'error-text' }, cdaCheck.message)
          ),
          h(
            'label', { className: 'field' },
            h('span', null, `FTP (W) — ${LIMITS.ftpW.min}〜${LIMITS.ftpW.max}`),
            h('input', {
              type: 'number',
              inputMode: 'numeric',
              min: LIMITS.ftpW.min,
              max: LIMITS.ftpW.max,
              step: '1',
              value: ftpW,
              onChange: (e) => setFtpW(e.target.value),
            }),
            !ftpCheck.valid && h('span', { className: 'error-text' }, ftpCheck.message)
          )
        ),
        h(
          'p', { className: 'muted small' },
          `FTP(既定 ${DEFAULT_FTP_W}W)は、フルスクリーン表示のパワーゾーン(7段)の基準にだけ使います。`
        ),
        h(
          'p', { className: 'muted small' },
          `既定値: Crr ${PhysicsConstants.CRR}（ロードバイク＋スマートトレーナー相当）／ CdA ${PhysicsConstants.CDA}m²（ドロップバー姿勢相当）。`,
          '仮想速度の物理演算と、Simulation Mode時にトレーナーへ送る係数の両方に使われます。'
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'btn btn-secondary btn-small',
            disabled: isDefaultCoefficients,
            onClick: () => {
              setCrr(PhysicsConstants.CRR);
              setCdaM2(PhysicsConstants.CDA);
            },
          },
          '既定値に戻す'
        )
      )
    ),

    h(
      'section', { className: 'card' },
      h('h2', null, '③ コース選択'),
      h(
        'div', { className: 'course-list' },
        COURSE_PROFILES.map((c) =>
          h(
            'label',
            { key: c.id, className: `course-option ${courseId === c.id ? 'selected' : ''}` },
            h('input', {
              type: 'radio',
              name: 'course',
              value: c.id,
              checked: courseId === c.id,
              onChange: () => setCourseId(c.id),
            }),
            h('div', null, h('strong', null, c.name), h('p', { className: 'muted small' }, c.description))
          )
        )
      )
    ),

    h(
      'section', { className: 'card' },
      h('h2', null, '④ オプション'),
      h('p', { className: 'field-title' }, 'バイク種別'),
      h(
        'div', { className: 'course-list vehicle-list' },
        VEHICLE_OPTIONS.map((v) =>
          h(
            'label',
            { key: v.id, className: `vehicle-option ${effectiveVehicle === v.id ? 'selected' : ''}${fixedVehicle ? ' locked' : ''}` },
            h('input', {
              type: 'radio',
              name: 'vehicle',
              value: v.id,
              checked: effectiveVehicle === v.id,
              disabled: !!fixedVehicle,
              onChange: () => setVehicle(v.id),
            }),
            h('div', null, h('strong', null, v.name), h('p', { className: 'muted small' }, v.description))
          )
        )
      ),
      fixedVehicle && h('p', { className: 'vehicle-lock-note' }, '🦢 上野不忍池コースはスワンボートで池を周回するため、バイク種別はスワンボートに固定されます。'),
      h('p', { className: 'field-title' }, '景観'),
      segmented('時間帯', 'envTime', TIME_OPTIONS, environment.time, (id) => changeEnvironment({ time: id })),
      supportsWeather(courseProfile)
        ? segmented('天候', 'envWeather', WEATHER_OPTIONS, environment.weather, (id) => changeEnvironment({ weather: id }))
        : h('p', { className: 'muted small' }, '上野不忍池コースは時間帯だけが反映されます(天候は変わりません)。'),
      h('p', { className: 'muted small' }, '※ 走行中の3D表示の見た目だけが変わります。速度・距離の計算やトレーナーの負荷は変わりません。景観は走行中にも切り替えられます。'),

      h('p', { className: 'field-title' }, '集団走行'),
      ghostsSupported
        ? h(
            'label', { className: `ghost-option pack-option${packEnabled ? ' selected' : ''}` },
            h('input', {
              type: 'checkbox',
              name: 'pack',
              checked: packEnabled,
              onChange: (e) => {
                setPackEnabled(e.target.checked);
                savePackEnabled(e.target.checked);
              },
            }),
            h('div', null,
              h('strong', null, '仮想の集団(5人)と走る'),
              h('p', { className: 'muted small' }, '前のライダーの後ろ(0.5〜6m)につくと「ドラフティング中」になり、空気抵抗が約3分の1減って同じパワーでも速く進みます。トレーナーへ送る勾配は変わりません。'))
          )
        : h('p', { className: 'muted small' }, '上野不忍池コースでは集団走行はできません。'),

      h('p', { className: 'field-title' }, 'ゴースト対戦'),
      ghostsSupported
        ? h(
            'div', { className: 'ghost-select' },
            ghostOption({
              id: PB_GHOST_ID,
              name: '自己ベスト',
              color: GHOST_COLORS.pb,
              checked: activeGhostIds.includes(PB_GHOST_ID),
              disabled: !pbRecord || (!activeGhostIds.includes(PB_GHOST_ID) && activeGhostIds.length >= MAX_GHOSTS),
              note: pbReason ?? `この距離で一番速かった記録(${new Date(pbRecord.startTime).toLocaleDateString('ja-JP')})と走ります。`,
              onToggle: toggleGhost,
            }),
            friendGhosts.map((g) =>
              ghostOption({
                id: g.id,
                name: g.name,
                color: GHOST_COLORS.friend,
                checked: activeGhostIds.includes(g.id),
                disabled: !activeGhostIds.includes(g.id) && activeGhostIds.length >= MAX_GHOSTS,
                note: `読み込んだ友人のゴースト(${(g.points[g.points.length - 1] / 1000).toFixed(2)}km)`,
                onToggle: toggleGhost,
              })
            ),
            friendGhosts.length === 0 &&
              h('p', { className: 'muted small' }, '友人のゴーストは「過去の走行記録」画面で TCX ファイルから読み込めます(コースごとに最大3件)。'),
            h('p', { className: 'muted small' }, `最大${MAX_GHOSTS}人まで選べます。選ばなければゴーストなしで走ります。ゴーストは記録どおりのペースで走るだけで、負荷には影響しません。`)
          )
        : h('p', { className: 'muted small' }, '上野不忍池コースではゴースト対戦はできません。')
    ),

    h(
      'div', { className: 'start-bar' },
      h(
        'div', { className: 'start-buttons' },
        h('button', { className: 'btn btn-primary btn-large', disabled: !canStart, onClick: handleStart }, '開始'),
        h('button', { className: 'btn btn-secondary btn-large', disabled: !canDemo, onClick: handleDemo }, 'デモ')
      ),
      !canStart && h('p', { className: 'muted small' }, '入力内容とデバイス接続が両方完了すると開始できます。'),
      h('p', { className: 'muted small' }, 'デモはトレーナーに接続せず、選んだ設定・コース・オプションで自動走行します(走行記録は保存されません)。'),
      h('button', { className: 'btn btn-link', onClick: onOpenHistory }, '過去の走行記録を見る')
    )
  );
}

/** ゴーストの選択肢(チェックボックス)。 */
function ghostOption({ id, name, color, checked, disabled, note, onToggle }) {
  return h(
    'label', { key: id, className: `ghost-option${checked ? ' selected' : ''}${disabled && !checked ? ' disabled' : ''}` },
    h('input', { type: 'checkbox', name: 'ghost', value: id, checked, disabled: disabled && !checked, onChange: () => onToggle(id) }),
    h('span', { className: 'ghost-dot', style: { boxShadow: `inset 0 0 0 2px ${color}` } }),
    h('div', null, h('strong', null, name), h('p', { className: 'muted small' }, note))
  );
}

/** 小さな選択肢の横並び(ラジオボタン)。 */
function segmented(title, name, options, value, onChange) {
  return h(
    'div', { className: 'segmented-field', role: 'radiogroup', 'aria-label': title },
    h('span', { className: 'segmented-title' }, title),
    h(
      'div', { className: 'segmented' },
      options.map((o) =>
        h(
          'label', { key: o.id, className: `segmented-option${value === o.id ? ' selected' : ''}` },
          h('input', { type: 'radio', name, value: o.id, checked: value === o.id, onChange: () => onChange(o.id) }),
          h('span', null, o.label)
        )
      )
    )
  );
}

const VEHICLE_OPTIONS = [
  { id: 'bike', name: '標準', description: 'ロードバイクで走ります。' },
  { id: 'swan', name: 'スワンボート', description: 'パロディモード。上野・不忍池のような足漕ぎスワンボートで道路を進みます。' },
];

function modeLabel(mode) {
  if (mode === 'simulation') return 'Simulation Mode';
  if (mode === 'erg') return 'ERGモード(フォールバック)';
  return '--';
}
