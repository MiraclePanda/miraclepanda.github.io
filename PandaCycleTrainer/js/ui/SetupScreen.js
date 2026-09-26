import { h, useState } from './h.js';
import { COURSE_PROFILES } from '../physics/courseProfiles.js';
import { validateWeight, validateBikeWeight, validateDistance, LIMITS } from '../utils/validation.js';

/**
 * 初期セットアップ画面。
 * 要件定義書5章「初期セットアップ: 走行距離・体重・自転車重量・コース選択の入力と、
 * デバイス接続は任意の順序で実施可能。両方揃った時点で「開始」ボタンが活性化する」に対応。
 */
export function SetupScreen({
  initialWeightKg,
  initialBikeWeightKg,
  deviceState,
  onConnectDevice,
  onDisconnectDevice,
  onStart,
  onOpenHistory,
}) {
  const [distanceKm, setDistanceKm] = useState('');
  const [weightKg, setWeightKg] = useState(initialWeightKg ?? '');
  const [bikeWeightKg, setBikeWeightKg] = useState(initialBikeWeightKg ?? '');
  const [courseId, setCourseId] = useState(COURSE_PROFILES[0].id);
  const [loadRatioPercent, setLoadRatioPercent] = useState(100);

  const distanceCheck = validateDistance(distanceKm);
  const weightCheck = validateWeight(weightKg);
  const bikeWeightCheck = validateBikeWeight(bikeWeightKg);

  const formValid = distanceCheck.valid && weightCheck.valid && bikeWeightCheck.valid && !!courseId;
  const canStart = formValid && deviceState.connected;

  const handleStart = () => {
    if (!canStart) return;
    onStart({
      distanceKm: Number(distanceKm),
      weightKg: Number(weightKg),
      bikeWeightKg: Number(bikeWeightKg),
      courseId,
      loadRatioPercent,
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
      'div', { className: 'start-bar' },
      h('button', { className: 'btn btn-primary btn-large', disabled: !canStart, onClick: handleStart }, '開始'),
      !canStart && h('p', { className: 'muted small' }, '入力内容とデバイス接続が両方完了すると開始できます。'),
      h('button', { className: 'btn btn-link', onClick: onOpenHistory }, '過去の走行記録を見る')
    )
  );
}

function modeLabel(mode) {
  if (mode === 'simulation') return 'Simulation Mode';
  if (mode === 'erg') return 'ERGモード(フォールバック)';
  return '--';
}
