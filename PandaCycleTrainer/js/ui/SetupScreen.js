import { h, useState } from './h.js';
import { COURSE_PROFILES } from '../physics/courseProfiles.js';
import { PhysicsConstants } from '../physics/physicsConstants.js';
import {
  validateWeight,
  validateBikeWeight,
  validateDistance,
  validateCrr,
  validateCda,
  LIMITS,
} from '../utils/validation.js';

/**
 * 初期セットアップ画面。
 * 要件定義書5章「初期セットアップ: 走行距離・体重・自転車重量・コース選択の入力と、
 * デバイス接続は任意の順序で実施可能。両方揃った時点で「開始」ボタンが活性化する」に対応。
 * 走行距離・体重・自転車重量・詳細設定(Crr/CdA)は前回値(prefs.js)を初期値にする。
 */
export function SetupScreen({
  initialDistanceKm,
  initialWeightKg,
  initialBikeWeightKg,
  initialCrr,
  initialCdaM2,
  initialVehicle,
  deviceState,
  onConnectDevice,
  onDisconnectDevice,
  onStart,
  onOpenHistory,
}) {
  const [distanceKm, setDistanceKm] = useState(initialDistanceKm ?? '');
  const [weightKg, setWeightKg] = useState(initialWeightKg ?? '');
  const [bikeWeightKg, setBikeWeightKg] = useState(initialBikeWeightKg ?? '');
  const [courseId, setCourseId] = useState(COURSE_PROFILES[0].id);
  const [loadRatioPercent, setLoadRatioPercent] = useState(100);
  const [vehicle, setVehicle] = useState(initialVehicle ?? 'bike');
  const [crr, setCrr] = useState(initialCrr ?? PhysicsConstants.CRR);
  const [cdaM2, setCdaM2] = useState(initialCdaM2 ?? PhysicsConstants.CDA);

  const distanceCheck = validateDistance(distanceKm);
  const weightCheck = validateWeight(weightKg);
  const bikeWeightCheck = validateBikeWeight(bikeWeightKg);
  const crrCheck = validateCrr(crr);
  const cdaCheck = validateCda(cdaM2);
  const advancedValid = crrCheck.valid && cdaCheck.valid;
  const isDefaultCoefficients = Number(crr) === PhysicsConstants.CRR && Number(cdaM2) === PhysicsConstants.CDA;
  // 既定値から変えている(または範囲外の)場合は最初から開いておき、閉じたまま気付かないのを防ぐ。
  const [advancedOpen, setAdvancedOpen] = useState(!isDefaultCoefficients || !advancedValid);

  const formValid =
    distanceCheck.valid && weightCheck.valid && bikeWeightCheck.valid && advancedValid && !!courseId;
  const canStart = formValid && deviceState.connected;

  const handleStart = () => {
    if (!canStart) return;
    onStart({
      distanceKm: Number(distanceKm),
      weightKg: Number(weightKg),
      bikeWeightKg: Number(bikeWeightKg),
      courseId,
      loadRatioPercent,
      vehicle,
      crr: Number(crr),
      cdaM2: Number(cdaM2),
    });
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
        h('summary', null, '詳細設定（転がり抵抗・空気抵抗係数）'),
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
          )
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
            { key: v.id, className: `vehicle-option ${vehicle === v.id ? 'selected' : ''}` },
            h('input', {
              type: 'radio',
              name: 'vehicle',
              value: v.id,
              checked: vehicle === v.id,
              onChange: () => setVehicle(v.id),
            }),
            h('div', null, h('strong', null, v.name), h('p', { className: 'muted small' }, v.description))
          )
        )
      ),
      h('p', { className: 'muted small' }, '※ 走行中の3D表示の見た目だけが変わります。速度・距離の計算やトレーナーの負荷は変わりません。')
    ),

    h(
      'div', { className: 'start-bar' },
      h('button', { className: 'btn btn-primary btn-large', disabled: !canStart, onClick: handleStart }, '開始'),
      !canStart && h('p', { className: 'muted small' }, '入力内容とデバイス接続が両方完了すると開始できます。'),
      h('button', { className: 'btn btn-link', onClick: onOpenHistory }, '過去の走行記録を見る')
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
