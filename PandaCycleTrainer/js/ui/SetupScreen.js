import { h, useState, useEffect, useMemo, useRef } from './h.js';
import { ConfirmDialog } from './Modal.js';
import { COURSE_PROFILES } from '../physics/courseProfiles.js';
import { PhysicsConstants } from '../physics/physicsConstants.js';
import { buildRealCourse, suggestScenery } from '../physics/realCourse.js';
import { CourseEngine } from '../physics/courseEngine.js';
import { parseGpx } from '../storage/gpx.js';
import {
  validateWeight,
  validateBikeWeight,
  validateDistance,
  validateCrr,
  validateCda,
  validateFtp,
  validatePowerScale,
  maxDistanceForCourse,
  LIMITS,
} from '../utils/validation.js';
import {
  DEFAULT_FTP_W,
  DEFAULT_POWER_SCALE,
  savePrefs,
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
import { getAllRides, getAllCourses, saveCourse, deleteCourse, updateCourseScenery } from '../storage/db.js';
import { bestRecordFor, fromRecord } from '../storage/ghostTrack.js';
import { GHOST_COLORS } from './ghostRace.js';
import { TIME_OPTIONS, WEATHER_OPTIONS, supportsWeather } from './rideOptions.js';
import { JourneyCard } from './JourneyCard.js';
import { journeyTotalKm } from '../utils/journey.js';

/**
 * 初期セットアップ画面。
 * 要件定義書5章「初期セットアップ: 走行距離・体重・自転車重量・コース選択の入力と、
 * デバイス接続は任意の順序で実施可能。両方揃った時点で「開始」ボタンが活性化する」に対応。
 * 走行距離・体重・自転車重量・詳細設定(Crr/CdA/FTP)は前回値(prefs.js)を初期値にする。
 * 景観(時間帯・天候)は選んだ時点で保存する(描画品質と同じく、走行開始を待たない)。
 * ③ コース選択では GPX ファイルから実在コースを読み込める(IndexedDB に保存し、次回以降も選べる)。
 * 実在コースはループしないため、走行距離はコース全長以下に制限し、選んだ時点で全長を入れる。
 * 入力・選択(走行距離・体重・自転車重量・負荷率・詳細設定・コース・バイク種別)は、変更した時点で
 * 正しい値だけを prefs.js に保存し、次回はそこから始める(実在コースの全長は走行距離として保存しない)。
 */
export function SetupScreen({
  initialDistanceKm,
  initialWeightKg,
  initialBikeWeightKg,
  initialCrr,
  initialCdaM2,
  initialVehicle,
  initialFtpW,
  initialPowerScale,
  initialCourseId,
  initialLoadRatioPercent,
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
  // 前回のコース。GPX の実在コース('gpx-<id>')は一覧の読み込み後に存在を確かめる(下の useEffect)。
  const [courseId, setCourseId] = useState(() =>
    initialCourseId && (initialCourseId.startsWith('gpx-') || COURSE_PROFILES.some((c) => c.id === initialCourseId))
      ? initialCourseId
      : COURSE_PROFILES[0].id
  );
  // GPX から読み込んだ実在コース(db.js のレコード)。読み込み中は null。
  const [savedCourses, setSavedCourses] = useState(null);
  const [gpxMessage, setGpxMessage] = useState(null); // { error: boolean, text }
  const [gpxBusy, setGpxBusy] = useState(false);
  const [gpxFileKey, setGpxFileKey] = useState(0); // 読み込み後にファイル選択欄を空に戻すため
  const allCourses = useMemo(
    () => [...COURSE_PROFILES, ...(savedCourses ?? []).map((r) => r.profile)],
    [savedCourses]
  );
  const [loadRatioPercent, setLoadRatioPercent] = useState(initialLoadRatioPercent ?? 100);
  const [vehicle, setVehicle] = useState(initialVehicle ?? 'bike');
  // コースで乗り物が固定されている場合(上野不忍池=スワンボート)。ユーザーの選択(vehicle)は
  // 変えずに残し、他のコースへ切り替えたら元の選択に戻る。
  const fixedVehicle = allCourses.find((c) => c.id === courseId)?.fixedVehicle ?? null;
  const effectiveVehicle = fixedVehicle ?? vehicle;
  const [crr, setCrr] = useState(initialCrr ?? PhysicsConstants.CRR);
  const [cdaM2, setCdaM2] = useState(initialCdaM2 ?? PhysicsConstants.CDA);
  const [ftpW, setFtpW] = useState(initialFtpW ?? DEFAULT_FTP_W);
  const [powerScale, setPowerScale] = useState(initialPowerScale ?? DEFAULT_POWER_SCALE);
  const [environment, setEnvironment] = useState(loadEnvironment);
  const courseProfile = allCourses.find((c) => c.id === courseId) ?? COURSE_PROFILES[0];
  const maxDistanceKm = courseProfile.fixedLength ? maxDistanceForCourse(courseProfile.loopLengthKm) : undefined;
  // 実在コースを選ぶ前に入っていた走行距離。組み込みコースへ戻したら元に戻す
  // (実在コースの全長を、組み込みコース用の前回値として残さないため)。
  const builtinDistanceRef = useRef(null);
  const [pendingDelete, setPendingDelete] = useState(null); // 削除確認中のレコード
  // ゴースト対戦: 過去の記録(自己ベストの候補)と、読み込んだ友人のゴースト(コース一致のみ)
  const [rides, setRides] = useState(null);
  const [ghostSelection, setGhostSelection] = useState(loadGhostSelection);
  const [packEnabled, setPackEnabled] = useState(loadPackEnabled);
  useEffect(() => {
    let alive = true;
    getAllRides().then((list) => alive && setRides(list)).catch(() => alive && setRides([]));
    getAllCourses().then((list) => alive && setSavedCourses(list)).catch(() => alive && setSavedCourses([]));
    return () => { alive = false; };
  }, []);

  // 実在コースの一覧が読み込めたら、前回選んでいたコースを確かめる(削除済みなら既定のコースへ。
  // 実在コースなら選んだときと同じく走行距離をコース全長にする)。最初の1回だけ。
  const restoredCourseRef = useRef(false);
  useEffect(() => {
    if (savedCourses === null || restoredCourseRef.current) return;
    restoredCourseRef.current = true;
    const c = allCourses.find((x) => x.id === courseId);
    if (!c) {
      setCourseId(COURSE_PROFILES[0].id);
    } else if (c.fixedLength) {
      // この時点の走行距離は組み込みコース用の前回値(実在コースの距離は保存しないため)
      builtinDistanceRef.current = distanceKm;
      setDistanceKm(String(maxDistanceForCourse(c.loopLengthKm)));
    }
  }, [savedCourses]);

  const selectCourse = (c) => {
    setCourseId(c.id);
    if (c.fixedLength) {
      // 実在コースは全長を走るのを基本にする(短くしたければ入力し直せる)
      if (!courseProfile.fixedLength) builtinDistanceRef.current = distanceKm;
      setDistanceKm(String(maxDistanceForCourse(c.loopLengthKm)));
    } else if (courseProfile.fixedLength && builtinDistanceRef.current !== null) {
      setDistanceKm(builtinDistanceRef.current);
      builtinDistanceRef.current = null;
    }
  };

  const handleGpxFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    setGpxMessage(null);
    if (!file) return;
    setGpxBusy(true);
    try {
      const gpx = parseGpx(await file.text());
      const name = gpx.name || file.name.replace(/\.gpx$/i, '');
      const { profile, stats } = buildRealCourse(gpx.points, { name });
      const record = await saveCourse({ name: profile.name, fileName: file.name, profile, stats });
      setSavedCourses((list) => [record, ...(list ?? [])]);
      selectCourse(record.profile);
      setGpxMessage({ error: false, text: `「${record.name}」を読み込みました。` });
    } catch (err) {
      setGpxMessage({ error: true, text: `GPX ファイルを読み込めませんでした: ${err.message ?? err}` });
    } finally {
      setGpxBusy(false);
      setGpxFileKey((k) => k + 1);
    }
  };

  const handleSceneryChange = async (record, scenery) => {
    try {
      const updated = await updateCourseScenery(record.id, scenery);
      setSavedCourses((list) => (list ?? []).map((r) => (r.id === updated.id ? updated : r)));
    } catch (err) {
      setGpxMessage({ error: true, text: `景色を変更できませんでした: ${err.message ?? err}` });
    }
  };

  const handleDeleteCourse = async (record) => {
    try {
      await deleteCourse(record.id);
    } catch (err) {
      setGpxMessage({ error: true, text: `削除できませんでした: ${err.message ?? err}` });
      return;
    }
    setSavedCourses((list) => (list ?? []).filter((r) => r.id !== record.id));
    if (courseId === record.profile.id) selectCourse(COURSE_PROFILES[0]);
    setGpxMessage(null);
  };
  // 選択・入力を変更した時点で保存する(範囲外の値は prefs.js 側で無視される)。
  useEffect(() => {
    const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
    const courseKnown = allCourses.some((c) => c.id === courseId);
    savePrefs({
      // 実在コースの走行距離(コース全長)は、組み込みコース用の前回値として残さない
      distanceKm: courseProfile.fixedLength || !validateDistance(distanceKm).valid ? undefined : num(distanceKm),
      weightKg: validateWeight(weightKg).valid ? num(weightKg) : undefined,
      bikeWeightKg: validateBikeWeight(bikeWeightKg).valid ? num(bikeWeightKg) : undefined,
      crr: validateCrr(crr).valid ? num(crr) : undefined,
      cdaM2: validateCda(cdaM2).valid ? num(cdaM2) : undefined,
      ftpW: validateFtp(ftpW).valid ? num(ftpW) : undefined,
      powerScale: validatePowerScale(powerScale).valid ? num(powerScale) : undefined,
      vehicle, // 上野不忍池で固定されるスワンボートではなく、ユーザー自身の選択
      // 実在コースの一覧を読み込む前は、まだ確かめていない前回のコースをそのまま残す
      courseId: courseKnown ? courseId : undefined,
      loadRatioPercent,
    });
  }, [distanceKm, weightKg, bikeWeightKg, crr, cdaM2, ftpW, powerScale, vehicle, courseId, loadRatioPercent, savedCourses]);

  const changeEnvironment = (patch) => {
    const next = { ...environment, ...patch };
    setEnvironment(next);
    saveEnvironment(next);
  };

  const distanceCheck = validateDistance(distanceKm, maxDistanceKm);
  const weightCheck = validateWeight(weightKg);
  const bikeWeightCheck = validateBikeWeight(bikeWeightKg);
  const crrCheck = validateCrr(crr);
  const cdaCheck = validateCda(cdaM2);
  const ftpCheck = validateFtp(ftpW);
  const powerScaleCheck = validatePowerScale(powerScale);
  const advancedValid = crrCheck.valid && cdaCheck.valid && ftpCheck.valid && powerScaleCheck.valid;
  const isDefaultCoefficients = Number(crr) === PhysicsConstants.CRR && Number(cdaM2) === PhysicsConstants.CDA &&
    Number(powerScale) === DEFAULT_POWER_SCALE;
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
    courseProfile,
    loadRatioPercent,
    vehicle: effectiveVehicle,
    preferredVehicle: vehicle, // 記憶するのはユーザー自身の選択
    crr: Number(crr),
    cdaM2: Number(cdaM2),
    ftpW: Number(ftpW),
    powerScale: Number(powerScale),
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
        h('span', null, maxDistanceKm === undefined
          ? `走行距離 (km) — ${LIMITS.distanceKm.min}〜${LIMITS.distanceKm.max}`
          : `走行距離 (km) — ${LIMITS.distanceKm.min}〜${maxDistanceKm}(コース全長)`),
        h('input', {
          type: 'number',
          inputMode: 'decimal',
          'aria-label': '走行距離',
          min: LIMITS.distanceKm.min,
          max: maxDistanceKm ?? LIMITS.distanceKm.max,
          step: maxDistanceKm === undefined ? '0.1' : 'any',
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
        h('summary', null, '詳細設定（転がり抵抗・空気抵抗係数・FTP・パワー補正）'),
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
          ),
          h(
            'label', { className: 'field' },
            h('span', null, `パワー補正の倍率 — ${LIMITS.powerScale.min}〜${LIMITS.powerScale.max}`),
            h('input', {
              type: 'number',
              inputMode: 'decimal',
              min: LIMITS.powerScale.min,
              max: LIMITS.powerScale.max,
              step: '0.05',
              value: powerScale,
              onChange: (e) => setPowerScale(e.target.value),
              'aria-label': 'パワー補正の倍率',
            }),
            !powerScaleCheck.valid && h('span', { className: 'error-text' }, powerScaleCheck.message)
          )
        ),
        h(
          'p', { className: 'muted small' },
          `パワー補正の倍率(既定 ${DEFAULT_POWER_SCALE})は、トレーナーが送ってくるパワーに掛けます。トレーナーのパワーが実際より小さく、`,
          '仮想速度が実測速度(参考)よりずっと遅いときに上げてください(例: 2 で2倍)。仮想速度・表示・記録のパワーに効き、勾配の負荷は変わりません。'
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
              onChange: () => selectCourse(c),
            }),
            h('div', null,
              h('strong', null, c.name, c.tag && h('span', { className: 'gpx-badge tour-badge' }, c.tag)),
              h('p', { className: 'muted small' }, c.description))
          )
        ),
        (savedCourses ?? []).map((r) =>
          h(
            'div', { key: r.profile.id, className: `course-option gpx-course ${courseId === r.profile.id ? 'selected' : ''}` },
            h(
              'label', { className: 'gpx-course-main' },
              h('input', {
                type: 'radio',
                name: 'course',
                value: r.profile.id,
                checked: courseId === r.profile.id,
                onChange: () => selectCourse(r.profile),
              }),
              h(
                'div', null,
                h('strong', null, r.name, h('span', { className: 'gpx-badge' }, '実在コース')),
                h('p', { className: 'muted small' }, gpxStatsLine(r.stats)),
                h(ElevationChart, { profile: r.profile })
              )
            ),
            h('button', {
              type: 'button',
              className: 'btn btn-secondary btn-small',
              onClick: () => setPendingDelete(r),
              'aria-label': `${r.name}を削除`,
            }, '削除'),
            // 景色は選択中のコースだけ変更できる(ラベルの入れ子を避けるため main の外に置く)
            courseId === r.profile.id &&
              h(
                'div', { className: 'gpx-scenery' },
                segmented(
                  '景色',
                  `scenery-${r.id}`,
                  GPX_SCENERY_OPTIONS.map((o) => ({ ...o, label: o.id === suggestScenery(r.stats) ? `${o.label}(おすすめ)` : o.label })),
                  r.profile.scenery,
                  (id) => handleSceneryChange(r, id)
                )
              )
          )
        )
      ),
      h(
        'div', { className: 'gpx-import' },
        h(
          'label', { className: 'field' },
          h('span', null, '実在コースを GPX ファイルから読み込む'),
          h('input', {
            key: gpxFileKey,
            type: 'file',
            accept: '.gpx,application/gpx+xml,application/xml,text/xml',
            disabled: gpxBusy,
            onChange: handleGpxFile,
            'aria-label': 'GPX ファイル',
          })
        ),
        gpxMessage && h('p', { className: gpxMessage.error ? 'error-text' : 'muted small' }, gpxMessage.text),
        h('p', { className: 'muted small' },
          'Strava・RideWithGPS・Garmin Connect などで作成・書き出したルートの GPX を使えます。勾配は GPX の標高から計算し、景色は起伏に合わせて街並み・湖畔・山岳から自動で選ばれ、コースを選ぶと変更できます。',
          '実在コースはループしないため、走行距離はコース全長までです。位置情報は勾配と道の曲がり方の計算にだけ使い、走行記録や TCX には含めません。')
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

    // バーチャル日本縦断(これまでの走行記録の合計距離)
    h(JourneyCard, { totalKm: rides === null ? null : journeyTotalKm(rides) }),

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
    ),

    pendingDelete &&
      h(ConfirmDialog, {
        title: `「${pendingDelete.name}」を削除しますか？`,
        message: '同じ GPX を読み込み直しても別のコースとして扱われ、このコースで走った記録は自己ベストのゴーストに使えなくなります(走行記録自体は残ります)。',
        confirmLabel: '削除する',
        cancelLabel: 'キャンセル',
        danger: true,
        onConfirm: () => {
          const r = pendingDelete;
          setPendingDelete(null);
          handleDeleteCourse(r);
        },
        onCancel: () => setPendingDelete(null),
      })
  );
}

/** 実在コースの集計の1行表示。 */
function gpxStatsLine(stats) {
  const km = `${stats.distanceKm.toFixed(2)} km`;
  if (!stats.hasElevation) return `${km} ・ 標高データなし(平坦として走ります)`;
  return `${km} ・ 獲得標高 ${Math.round(stats.ascentM)} m ・ 最大勾配 ${stats.maxGradePercent.toFixed(1)}%`;
}

// 実在コースで選べる景色。熱海・上野は専用の地形・周回ルートを持つので対象外。
const GPX_SCENERY_OPTIONS = [
  { id: 'city', label: '街並み' },
  { id: 'lakeside', label: '湖畔' },
  { id: 'mountain', label: '山岳' },
];

const CHART_W = 280;
const CHART_H = 56;

/** 実在コースの標高断面(勾配プロファイルを積分した形。走行中の勾配と同じもの)。 */
function ElevationChart({ profile }) {
  const path = useMemo(() => {
    const engine = new CourseEngine(profile, profile.loopLengthKm);
    const L = profile.loopLengthKm;
    const n = 100;
    const elev = [0];
    for (let i = 1; i <= n; i++) elev.push(elev[i - 1] + engine.elevationDeltaM(((i - 1) / n) * L, (i / n) * L));
    const min = Math.min(...elev);
    const range = Math.max(Math.max(...elev) - min, 20); // 平坦なコースが大きく波打って見えないよう最低20m幅
    const pts = elev.map((e, i) => `${((i / n) * CHART_W).toFixed(1)},${(CHART_H - 2 - ((e - min) / range) * (CHART_H - 6)).toFixed(1)}`);
    return `M0,${CHART_H} L${pts.join(' L')} L${CHART_W},${CHART_H} Z`;
  }, [profile]);
  return h(
    'svg', { className: 'elevation-chart', viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': '標高断面' },
    h('path', { d: path })
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
