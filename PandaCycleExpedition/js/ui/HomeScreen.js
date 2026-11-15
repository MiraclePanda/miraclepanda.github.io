// ホーム: コースの一覧を中心にした1つの画面。コースを押すと、そのコースの旅(続きを走る)か旅立つ欄が開き、
// 開いている旅の荷物・電車/船・地図と日誌・設定と記録は下のタブにまとめる。トレーナー接続は上の帯。

import { h, useState, useEffect, useRef } from './h.js';
import { createTrip, resumeLabel, fmtClock, TIME_SCALES, chooseNextSegment, takeTransfer, migrateTrip } from '../storage/tripState.js';
import {
  routesFrom, nodeName, currentNode, cameFromSegmentId, transfersFrom, segmentArrivingAt, getSegment, courseChoices, courseLinks,
  REVERSE_SUFFIX,
} from '../trip/network.js';
import { routeLabel } from './RideScreen.js';
import { TripMap } from './TripMap.js';
import { stampProgress } from '../trip/stamps.js';
import { gearOptions, gearConfirmText, shipHome, buyGear, buyFood, atTown, FOOD } from '../trip/gear.js';
import { downloadTrip, importTripFile } from '../storage/tripFile.js';
import { requestPersistentStorage } from '../storage/tripStore.js';
import { validateWeight, validateBikeWeight, validateFtp, validatePowerScale } from '../utils/validation.js';
import { SEASON_MODES, SEASON_LABELS, normalizeSeasonMode } from '../trip/season.js';
import { packWeightKg } from '../physics/surfaces.js';
import { satietyLabel } from '../trip/body.js';
import { forecastDay, forecastText } from '../trip/dayEvents.js';
import { fmtTime } from '../utils/format.js';
import { HeroArt } from './HeroArt.js';
import { trackForDay, downloadTrackTcx } from '../storage/tcx.js';
import { courseProgress, courseMark, tripCourseId, tripsByCourse } from '../trip/courseProgress.js';
import { travelerJournal, withCompanionsFrom, inheritTrip } from '../trip/journal.js';
import { sharedPhotoStore } from '../storage/photoStore.js';
import { loadGpuBackend, saveGpuBackend } from '../storage/prefs.js';
import { hasWebGPU } from '../three/gpuBackend.js';

const km = (m) => (m / 1000).toFixed(1);

export function HomeScreen({ trip, segment, segmentError, store, persistent, notice, client, onTripChange, onRide }) {
  const [conn, setConn] = useState(client.isConnected ? { name: client.device?.name, mode: client.controlMode } : null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  // これまでの旅(保存に残っている旅ごとの最新)。コースごとの旅と「途中まで/完走」の印に使う
  const [pastTrips, setPastTrips] = useState([]);
  useEffect(() => {
    let alive = true;
    store.listTrips().then((list) => { if (alive) setPastTrips(list.map((s) => s.data)); }).catch(() => {});
    return () => { alive = false; };
  }, [store, trip?.tripId]);
  const allTrips = [...pastTrips.filter((t) => t && t.tripId !== trip?.tripId), ...(trip ? [trip] : [])];
  const progress = courseProgress(allTrips);
  // 旅はコースごとに別々。コースを選ぶと、そのコースの旅に切り替わる
  const courseTrips = tripsByCourse(allTrips);
  const courses = courseChoices();
  const [sel, setSel] = useState(() => tripCourseId(trip) ?? courses[0]?.segmentId);
  const selId = courses.some((c) => c.segmentId === sel) ? sel : courses[0]?.segmentId;
  const active = trip && tripCourseId(trip) === selId; // 選んだコースの旅を開いている

  useEffect(() => {
    const onDisc = () => setConn(null);
    client.addEventListener('disconnected', onDisc);
    return () => client.removeEventListener('disconnected', onDisc);
  }, [client]);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const r = await client.connect();
      setConn({ name: r.deviceName, mode: r.controlMode });
    } catch (e) {
      setError(`接続できませんでした: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function onImport(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    // 同じコースの旅があれば置き換わるので、何日目の旅を何日目の旅で置き換えるかを見せて確かめる
    const r = await importTripFile(file, store, (t) => {
      const same = courseTrips.get(tripCourseId(t));
      const now = same ? `今のこのコースの旅は ${same.day}日目です。` : 'このコースの旅はまだありません。';
      return confirm(`「${getSegment(t.position.segmentId)?.name ?? t.position.segmentId}」の ${t.day}日目の旅を読み込みますか?\n${now}\n`
        + '読み込んだ旅が続きになります(今の旅は「設定と記録」の「前の保存に戻す」から戻せます)。');
    });
    if (r.ok) { setSel(tripCourseId(r.trip)); onTripChange(r.trip); } else if (!r.cancelled) setError(`読み込めませんでした: ${r.error}`);
  }

  /** コースを選ぶ。そのコースの旅があれば、その旅に切り替える(次に開いたときもこの旅から)。 */
  async function select(id) {
    setSel(id);
    setError(null);
    const saved = courseTrips.get(id);
    if (!saved || saved.tripId === trip?.tripId) return;
    const r = migrateTrip(saved);
    if (!r.ok) { setError(`この旅は読み込めませんでした: ${r.error}`); return; }
    // 道連れの話は、ほかのコースの旅で聞いた続きから(旅人の手帳と同じ進み具合にそろえる)
    const t = { ...withCompanionsFrom(r.trip, allTrips), updatedAt: Date.now() };
    await store.save(t, 'event').catch(() => {});
    onTripChange(t);
  }

  /**
   * 選んだコースで新しい旅を始める(前の旅があれば、最初から走り直し)。inherit を渡すと、その旅の所持金・荷物・
   * スタンプ帳・日数を引き継ぐ。道連れの話はいつも、これまでの旅で聞いた続きから。
   */
  async function startTrip(id, body, inherit = null) {
    const t = inheritTrip(createTrip({ ...body, segmentId: id }), inherit);
    const powerScale = latestTrip(allTrips)?.settings.powerScale;
    const t2 = withCompanionsFrom(powerScale ? { ...t, settings: { ...t.settings, powerScale } } : t, allTrips);
    // 走り直す前の旅は、コース一覧の印のために最新の1件だけ残して古い世代を消す
    const old = courseTrips.get(id);
    await store.save(t2, 'event');
    if (old) await store.compactTrip(old.tripId).catch(() => {});
    // 何ヶ月も続く旅なので、ブラウザに保存データを消さないよう頼む(断られても旅は始められる)
    requestPersistentStorage();
    onTripChange(t2);
  }

  const importInput = h('input', { type: 'file', accept: 'application/json,.json', ref: fileRef, style: { display: 'none' }, onChange: onImport });
  return h('div', { className: 'page' },
    h('div', { className: 'trainer-bar' },
      h('span', { className: 'trainer-conn' },
        h('b', null, 'トレーナー'),
        conn
          ? h('span', { className: 'trainer-on' }, `接続中: ${conn.name ?? '(名前なし)'}(${conn.mode === 'erg' ? 'ERG' : 'シミュレーション'}モード)`)
          : h('button', { onClick: connect, disabled: busy }, busy ? '接続中...' : '接続する')),
      h(BackendPicker)),
    h(HeroArt, { compact: true },
      h('p', { className: 'hero-kicker' }, '自分の脚だけで、日本を旅する'),
      h('h1', null, 'PandaCycleExpedition')),
    !persistent && h('p', { className: 'err' }, 'このブラウザでは旅を保存できません。こまめに書き出してください。'),
    notice && h('p', { className: 'err' }, notice),
    error && h('p', { className: 'err' }, error),
    h('div', { className: 'card depart' },
      h('h2', null, 'コースを選ぶ'),
      h('p', { className: 'muted' }, 'コースごとに別々の旅です。コースを押すと、そのコースの旅の続き(日数・体力・所持金・荷物)に切り替わります。つなげていくと日本一周。'),
      h(CourseList, {
        courses, selectedId: selId, progress, courseTrips, onSelect: select,
        renderPanel: (c) => (active && !segment
          ? h(SegmentMissingPanel, { trip, error: segmentError })
          : active
          ? h(TripPanel, { trip, segment, store, conn, onTripChange, onRide, onRestart: (body) => startTrip(c.segmentId, body) })
          : h(StartPanel, {
            course: c, defaults: latestTrip(allTrips), here: tripsHere(courseTrips, c.segmentId),
            onStart: (body, inherit) => startTrip(c.segmentId, body, inherit), onImport: () => fileRef.current.click(),
            onOpen: (courseId) => select(courseId),
          })),
      }),
      h(CourseLegend, { progress })),
    h(JournalCard, { trips: allTrips }),
    active && h(TripTabs, { trip, segment, store, onTripChange, courseName: courses.find((c) => c.segmentId === selId)?.name, onImport: () => fileRef.current.click() }),
    importInput);
}

/** 旅の今いる区間のデータを読めないとき: 走れないことと、できること(再読み込み・書き出し・ほかのコース)を出す。 */
/** 描画の方式(WebGL / WebGPU)の選択。端末ごとに覚え、次に走るときから使う。 */
function BackendPicker() {
  const [value, setValue] = useState(loadGpuBackend);
  const gpu = hasWebGPU();
  return h('label', { className: 'backend-pick', title: 'WebGPU を選んでも、使えない端末では WebGL で描きます' },
    '描画の方式',
    h('select', {
      value,
      onChange: (e) => {
        saveGpuBackend(e.target.value);
        setValue(e.target.value);
      },
    },
    h('option', { value: 'webgl' }, 'WebGL(標準)'),
    h('option', { value: 'webgpu' }, gpu ? 'WebGPU(試験的)' : 'WebGPU(この端末では使えません)')));
}

function SegmentMissingPanel({ trip, error }) {
  const known = !!getSegment(trip.position.segmentId);
  return h('div', { className: 'course-panel' },
    h('div', { className: 'panel-title' }, `${trip.day}日目の旅`),
    h('p', { className: 'err' }, known
      ? `道のデータを読めませんでした(${error?.message ?? '通信できません'})。通信できる所でもう一度読み込んでください。`
      : `この旅の区間(${trip.position.segmentId})は、このアプリにはありません。アプリを更新してください。`),
    h('p', { className: 'muted' }, 'ほかのコースは上の一覧から選べます。この旅は下の「設定と記録」から書き出せます。'),
    known && error?.retry && h('div', { className: 'row' }, h('button', { onClick: error.retry }, 'もう一度読み込む')));
}

/** いちばん新しく更新した旅(新しい旅の体重・自転車・設定の初期値に使う)。 */
function latestTrip(trips) {
  return trips.reduce((a, t) => (!a || (t.updatedAt ?? 0) > (a.updatedAt ?? 0) ? t : a), null);
}

/** 選んだコースの旅: いまの状態、出発ボタン、最初から走り直す(画面の中で確認)。 */
function TripPanel({ trip, segment, store, conn, onTripChange, onRide, onRestart }) {
  const [asking, setAsking] = useState(false);
  const finished = !trip.ride && trip.position.segmentM >= segment.lengthM - 1;
  const midRide = !!trip.ride;
  return h('div', { className: 'course-panel' },
    h('div', { className: 'panel-title' }, finished ? `${trip.day}日目の朝・${nodeName(segment.to)}` : resumeLabel(trip, segment.name)),
    h('div', { className: 'grid' },
      stat('体力', `${Math.round(trip.rider.stamina)}`),
      stat('満腹度', `${Math.round(trip.rider.satiety)}(${satietyLabel(trip.rider.satiety)})`),
      stat('所持金', `${trip.wallet.yen.toLocaleString()} 円`),
      stat('荷物', `${packWeightKg(trip.bike.pack).toFixed(1)} kg(食料 ${(trip.bike.pack.food ?? 0).toFixed(2)} kg)`),
      stat(midRide ? '今日の天気予報' : `${trip.day}日目の天気予報`, forecastText(forecastDay(trip.tripId, trip.day))),
      stat('区間', `${segment.name}(残り ${km(Math.max(0, segment.lengthM - trip.position.segmentM))} km)`)),
    finished && h(NextRoutes, { trip, segment, store, onTripChange }),
    !finished && h('div', { className: 'row' },
      h('button', { className: 'primary go', disabled: !conn, onClick: () => onRide(false) }, midRide ? '続きを走る' : '出発する'),
      h('button', { onClick: () => onRide(true), title: 'デモで走った分も旅に残り、日誌とコースの印に「デモ」と出ます' }, 'デモで走る(トレーナーなし)'),
      !conn && h('span', { className: 'muted' }, '走るには上でトレーナーに接続します。')),
    asking
      ? h('div', { className: 'inline-confirm' },
        h('div', null, `このコースの旅(${trip.day}日目まで)を終えて、1日目の朝から新しく旅立ちますか? 体力・所持金・荷物も最初からになります。走った印は残ります。`),
        h('div', { className: 'row' },
          h('button', {
            className: 'primary',
            onClick: () => onRestart({ riderWeightKg: trip.rider.weightKg, bikeWeightKg: trip.bike.weightKg, ftpW: trip.rider.ftpW, timeScale: trip.settings.timeScale }),
          }, '最初から旅立つ'),
          h('button', { onClick: () => setAsking(false) }, 'やめる')))
      : h('button', { className: 'link', onClick: () => setAsking(true) }, 'このコースを最初から走り直す'));
}

/** 旅のないコース: 体と自転車(前回の値)を確かめて旅立つ。前の旅を引き継ぐこともできる。 */
function StartPanel({ course, defaults, here = [], onStart, onImport, onOpen }) {
  const seg = getSegment(course.segmentId);
  const [inherit, setInherit] = useState(!!defaults);
  const [f, setF] = useState({
    weight: String(defaults?.rider.weightKg ?? 70), bike: String(defaults?.bike.weightKg ?? 11),
    ftp: String(defaults?.rider.ftpW ?? 200), timeScale: defaults?.settings.timeScale ?? 4,
  });
  const checks = [validateWeight(f.weight), validateBikeWeight(f.bike), validateFtp(f.ftp)];
  const ok = checks.every((c) => c.valid);
  const field = (key, label) => h('label', { className: 'field' }, label,
    h('input', { type: 'number', value: f[key], onChange: (e) => setF({ ...f, [key]: e.target.value }) }));
  const form = h('div', { className: 'grid' },
    field('weight', '体重(kg)'), field('bike', '自転車の重さ(kg・荷物なし)'), field('ftp', 'FTP(W)'),
    h('label', { className: 'field' }, '旅の時間の早回し',
      h('select', { value: f.timeScale, onChange: (e) => setF({ ...f, timeScale: Number(e.target.value) }) },
        TIME_SCALES.map((x) => h('option', { key: x, value: x }, `${x}倍`)))));
  const body = () => ({ riderWeightKg: Number(f.weight), bikeWeightKg: Number(f.bike), ftpW: Number(f.ftp), timeScale: Number(f.timeScale) });
  return h('div', { className: 'course-panel' },
    // ほかのコースから分かれ道を通ってこのコースに来ている旅があれば、その旅を開ける
    here.map((x) => h('div', { key: x.trip.tripId, className: 'here-note' },
      `📍 「${getSegment(x.courseId)?.name ?? x.courseId}」の旅(${x.trip.day}日目)が、いまこのコースの ${km(x.trip.position.segmentM)} km 地点にいます。`,
      h('button', { className: 'link', onClick: () => onOpen(x.courseId) }, 'その旅を開いて続きを走る'))),
    h('div', null, inherit && defaults
      ? `${nodeName(seg.from)}を朝7時に出発し、${seg.goalName}を目指します。`
      : `このコースの旅はまだありません。1日目は${nodeName(seg.from)}を朝7時に出発し、${seg.goalName}を目指します。荷物(テント・寝袋・食料・水など)は約14 kg、所持金は3万円です。`),
    defaults && h('label', { className: 'check' },
      h('input', { type: 'checkbox', checked: inherit, onChange: (e) => setInherit(e.target.checked) }),
      ` 前の旅(${getSegment(tripCourseId(defaults))?.name ?? ''}・${defaults.day}日目)を引き継ぐ: 所持金 ${defaults.wallet.yen.toLocaleString()} 円・荷物 ${packWeightKg(defaults.bike.pack).toFixed(1)} kg・スタンプ ${(defaults.stamps ?? []).length} 個、日数は ${defaults.day + (defaults.ride ? 1 : 0)}日目の朝から`),
    // 初めての旅は入力欄を開いておく。2回目からは前回の値を使い、直したいときだけ開く
    defaults
      ? h('details', null, h('summary', null, `体と自転車(前回の値: 体重 ${f.weight} kg・自転車 ${f.bike} kg・FTP ${f.ftp} W・早回し ${f.timeScale}倍)`), form)
      : form,
    checks.filter((c) => !c.valid).map((c, i) => h('p', { key: i, className: 'err' }, c.message)),
    h('div', { className: 'row' },
      h('button', {
        className: 'primary go', disabled: !ok,
        onClick: () => onStart(body(), inherit ? defaults : null),
      }, inherit && defaults ? '引き継いで旅立つ' : 'このコースで旅立つ'),
      !defaults && h('button', { className: 'link', onClick: onImport }, '書き出した旅を読み込む')));
}

const TABS = [['gear', '荷物'], ['transfer', '電車・船'], ['map', '地図と日誌'], ['settings', '設定と記録']];

/** 開いている旅の手帳: 荷物・電車/船・地図と日誌・設定と記録をタブで。 */
function TripTabs({ trip, segment, store, onTripChange, courseName, onImport }) {
  const [tab, setTab] = useState('gear');
  const midRide = !!trip.ride;
  async function changeSetting(patch) {
    const t = { ...trip, settings: { ...trip.settings, ...patch } };
    await store.save(t, 'event');
    onTripChange(t);
  }
  const morningOnly = h('p', { className: 'muted' }, '走行の途中です。荷物の見直しや電車・船は、その日を終えた翌朝からできます。');
  let body;
  const noSegment = h('p', { className: 'muted' }, '道のデータを読めないので、荷物の見直しや電車・船は使えません。');
  if (!segment && (tab === 'gear' || tab === 'transfer')) body = noSegment;
  else if (tab === 'gear') body = midRide ? morningOnly : h(GearCard, { trip, segment, store, onTripChange });
  else if (tab === 'transfer') {
    const node = currentNode(trip, segment);
    body = midRide ? morningOnly
      : node && transfersFrom(node).length > 0 ? h(TransferCard, { trip, segment, store, onTripChange })
        : h('p', { className: 'muted' }, '今いる所からは電車・船に乗れません(乗れる駅・港のある町にいる朝に使えます)。');
  } else if (tab === 'map') body = h(TripMapCard, { trip });
  else {
    body = h('section', { className: 'pane' },
      h('div', { className: 'grid' },
        h('label', { className: 'field' }, '旅の時間の早回し',
          h('select', {
            value: trip.settings.timeScale, disabled: midRide,
            onChange: (e) => changeSetting({ timeScale: Number(e.target.value) }),
          }, TIME_SCALES.map((x) => h('option', { key: x, value: x }, `${x}倍(走行1時間 = 旅の${x}時間)`)))),
        h(NumberSetting, {
          label: 'パワー補正の倍率', value: trip.settings.powerScale ?? 1, step: 0.05, validate: validatePowerScale,
          onSave: (v) => changeSetting({ powerScale: v }),
        }),
        h('label', { className: 'field' }, '景色の季節',
          h('select', {
            value: normalizeSeasonMode(trip.settings.season),
            onChange: (e) => changeSetting({ season: e.target.value }),
          }, SEASON_MODES.map((x) => h('option', { key: x, value: x }, SEASON_LABELS[x]))))),
      h('p', { className: 'muted' }, '「実際の今日の日付」では、走る日の季節がそのまま景色に出ます(桜・新緑・紅葉・冬枯れ、富士山の雪、日の出と日の入り)。桜や紅葉は南北・山の高さで時期がずれます。'),
      midRide && h('p', { className: 'muted' }, '早回しの倍率は走行の途中では変えられません(翌朝から変えられます)。'),
      h('h3', null, '旅の記録'),
      h('p', { className: 'muted' }, '旅は走行中30秒ごとに自動で保存されます。ブラウザのデータは消えることがあるので、ときどき書き出しておくと安心です。書き出すのは、このコースの旅です。'),
      h('div', { className: 'row' },
        h('button', { onClick: () => downloadTrip(trip) }, '旅を書き出す'),
        h('button', { onClick: onImport }, '旅を読み込む')),
      h(RestoreSnapshots, { trip, store, onTripChange }));
  }
  return h('div', { className: 'card' },
    h('h2', null, `「${courseName ?? ''}」の旅の手帳`),
    h('div', { className: 'tabs', role: 'tablist' },
      TABS.map(([k, label]) => h('button', {
        key: k, type: 'button', role: 'tab', 'aria-selected': tab === k, className: `tab${tab === k ? ' on' : ''}`, onClick: () => setTab(k),
      }, label))),
    h('div', { className: 'tab-body' }, body));
}

const SNAPSHOT_KINDS = { auto: '走行中の自動保存', event: '出来事の後', rideEnd: '走行の終わり', dayEnd: '日の終わり', import: '読み込み' };

/** 前の保存に戻す: この旅の残っている世代(直近と、最近の日の終わり)から選んで、その時点を続きにする。 */
function RestoreSnapshots({ trip, store, onTripChange }) {
  const [list, setList] = useState(null);
  const [msg, setMsg] = useState(null);
  async function open() {
    setMsg(null);
    setList((await store.listSnapshots(trip.tripId).catch(() => [])).slice(1)); // いちばん新しいのは今の状態
  }
  async function restore(m) {
    const when = new Date(m.savedAt).toLocaleString('ja-JP');
    if (!confirm(`${when} の保存(${m.day}日目・${SNAPSHOT_KINDS[m.kind] ?? m.kind})に戻しますか?\n今の状態も保存に残るので、あとでまた戻せます。`)) return;
    const r = await store.readSnapshot(m.id);
    if (!r.ok) { setMsg(`この保存は読めませんでした: ${r.error}`); return; }
    const t = { ...r.trip, updatedAt: Date.now() };
    await store.save(t, 'import');
    setList(null);
    onTripChange(t);
  }
  return h('div', null,
    h('h3', null, '前の保存に戻す'),
    list === null
      ? h('button', { className: 'link', onClick: open }, '残っている保存を見る')
      : list.length === 0 ? h('p', { className: 'muted' }, '戻せる保存はまだありません。')
      : list.map((m) => h('div', { key: m.id, className: 'row', style: { margin: '4px 0' } },
        h('button', { onClick: () => restore(m) },
          `${new Date(m.savedAt).toLocaleString('ja-JP')}・${m.day}日目・${SNAPSHOT_KINDS[m.kind] ?? m.kind}`))),
    msg && h('p', { className: 'err' }, msg));
}

/** 旅の地図と日誌。日誌の日をタップすると、その日に走った道が地図で光る。 */
function TripMapCard({ trip }) {
  const [day, setDay] = useState(null);
  return h('div', null,
    h('section', { className: 'pane' },
      h('h3', null, '旅の地図'),
      h(TripMap, { trip, highlightDay: day }),
      h('p', { className: 'muted map-legend' }, '太い線 = 走ってきた道、細い線 = まだ走っていない道、点線 = 電車・船、丸 = 今いる場所、四角 = 泊まった場所。日誌の日をタップすると、その日の道が光ります。')),
    h(StampBook, { trip }),
    h(TripLog, { trip, selectedDay: day, onSelect: (d) => setDay(d === day ? null : d) }));
}

/** 電車・船で移る(朝、町にいるときだけ)。 */
function TransferCard({ trip, segment, store, onTripChange }) {
  const node = currentNode(trip, segment);
  const list = node ? transfersFrom(node) : [];
  if (list.length === 0) return null;
  async function take(tr) {
    if (!confirm(`${tr.name}で${tr.toName}へ移りますか?\n運賃 ${tr.yen.toLocaleString()} 円で、旅の時間が ${tr.minutes} 分進みます。\n乗った区間は走った距離に入りません。`)) return;
    const arrive = segmentArrivingAt(tr.to);
    const seg = getSegment(arrive);
    if (!seg) return;
    const t = takeTransfer(trip, tr, arrive, seg.lengthM);
    if (t === trip) return;
    await store.save(t, 'event').catch(() => {});
    onTripChange(t);
  }
  return h('section', { className: 'pane' },
    h('h3', null, `${nodeName(node)}から電車・船で移る`),
    h('p', { className: 'muted' }, '自転車を袋に入れて電車に乗る(輪行)か、船に積んで渡ります。走った距離には入らず、旅の時間とお金を使います。'),
    list.map((tr) => h('div', { key: tr.id, className: 'row', style: { margin: '4px 0' } },
      h('button', { disabled: trip.wallet.yen < tr.yen, onClick: () => take(tr) },
        `${tr.name}で${tr.toName}へ(${tr.minutes} 分・${tr.yen.toLocaleString()} 円)`))));
}

/** 荷物を見直す(朝、町にいるときだけ): 装備を家へ送る・買う、食料を買い足す。 */
function GearCard({ trip, segment, store, onTripChange }) {
  const inTown = atTown(segment, trip.position.segmentM);
  async function apply(t) {
    if (t === trip) return;
    await store.save(t, 'event').catch(() => {});
    onTripChange(t);
  }
  const food = trip.bike.pack.food ?? 0;
  return h('section', { className: 'pane' },
    h('h3', null, '荷物を見直す'),
    !inTown && h('p', { className: 'muted' }, '店のある町にいないので、ここでは送ったり買ったりできません。'),
    h('p', { className: 'muted' }, '荷物が軽いほど坂は楽です。使わない装備は家へ送って軽くできますが、旅の途中では戻ってこないので、また使うときは買い直します。'),
    gearOptions(trip).map((g) => h('div', { key: g.key, className: 'row', style: { justifyContent: 'space-between', margin: '4px 0' } },
      h('span', null, `${g.label}(${g.kg} kg)・${g.owned ? '積んでいる' : '積んでいない'}`,
        h('br'), h('small', { className: 'muted' }, g.owned ? `${g.effect}。` : `ないので${g.without}。`)),
      h('button', {
        disabled: !inTown || !g.affordable,
        onClick: () => { if (confirm(gearConfirmText(trip, g.key))) apply(g.owned ? shipHome(trip, g.key) : buyGear(trip, g.key)); },
      }, g.owned ? `家へ送る(${g.shipYen.toLocaleString()} 円)` : `買う(${g.buyYen.toLocaleString()} 円)`))),
    h('div', { className: 'row', style: { justifyContent: 'space-between', margin: '4px 0' } },
      h('span', null, `食料 ${food.toFixed(2)} kg(最大 ${FOOD.maxKg} kg)`,
        h('br'), h('small', { className: 'muted' }, '補給食やテント泊の夕食・朝食で減ります。')),
      h('button', { disabled: !inTown || food >= FOOD.maxKg - 1e-9, onClick: () => apply(buyFood(trip)) },
        `${FOOD.stepKg} kg 買い足す(${Math.round(FOOD.stepKg * FOOD.yenPerKg).toLocaleString()} 円)`)));
}

/** スタンプ帳: 立ち寄った見どころと、食べた名物。立ち寄ったときに撮った写真も並べる。 */
function StampBook({ trip }) {
  const photos = usePhotos(trip.tripId);
  const p = stampProgress(trip);
  const stamps = trip.stamps ?? [];
  const list = (kind) => stamps.filter((s) => s.kind === kind)
    .map((s) => `${s.name}${s.place ? `(${s.place})` : ''}・${s.day}日目`).join('、') || 'まだありません';
  return h('section', { className: 'pane' },
    h('h3', null, 'スタンプ帳'),
    h('p', { className: 'stamp-count' }, '見どころ', h('b', null, p.sights.got), `/ ${p.sights.total}・名物`, h('b', null, p.foods.got), `/ ${p.foods.total}`),
    h('div', null, h('b', null, '立ち寄った見どころ: '), list('sight')),
    h('div', null, h('b', null, '食べた名物: '), list('food')),
    h(PhotoStrip, { photos }),
    h('p', { className: 'muted' }, '見どころの前で「立ち寄る」を選ぶか、店で食べるとスタンプが押されます。立ち寄ると、そのときの景色が写真帳に残ります(この端末だけ。旅の書き出しには入りません)。'));
}

/** 写真帳の写真(tripId を渡すとその旅の分、null ならすべて)。 */
function usePhotos(tripId) {
  const [photos, setPhotos] = useState([]);
  useEffect(() => {
    let alive = true;
    sharedPhotoStore().list(tripId).then((l) => { if (alive) setPhotos(l); }).catch(() => {});
    return () => { alive = false; };
  }, [tripId]);
  return photos;
}

function PhotoStrip({ photos }) {
  if (!photos.length) return null;
  return h('div', { className: 'photo-strip' },
    photos.map((p) => h('figure', { key: p.key },
      h('img', { src: p.dataUrl, alt: p.name, loading: 'lazy' }),
      h('figcaption', null, `${p.name}・${p.day}日目`))));
}

/** 旅人の手帳: コースごとの旅をまとめた累計・日本一周の地図・スタンプ・道連れの話・写真。 */
function JournalCard({ trips }) {
  const photos = usePhotos(null);
  if (trips.length === 0) return null;
  const j = travelerJournal(trips);
  const pct = j.mainLine.totalM ? Math.round((j.mainLine.doneM / j.mainLine.totalM) * 100) : 0;
  return h('div', { className: 'card journal' },
    h('h2', null, '旅人の手帳'),
    h('p', { className: 'muted' }, 'これまでのすべての旅(コースごとの旅)を合わせた記録です。'),
    h('div', { className: 'grid' },
      stat('走った距離', `${km(j.distanceM)} km${j.demoM > 1 ? `(うちデモ ${km(j.demoM)} km)` : ''}`),
      stat('旅の日数', `${j.days} 日・旅 ${j.trips} 本`),
      stat('獲得標高', `${Math.round(j.elevationGainM).toLocaleString()} m`),
      stat('日本一周の道', `${km(j.mainLine.doneM)} / ${km(j.mainLine.totalM)} km(${pct}%)`),
      stat('コース', `★ ${j.courses.done}・☆ ${j.courses.partial} / ${j.courses.total}`),
      stat('スタンプ', `見どころ ${j.stamps.sights.got}/${j.stamps.sights.total}・名物 ${j.stamps.foods.got}/${j.stamps.foods.total}`)),
    h('details', null, h('summary', null, '日本一周の地図'),
      h(TripMap, { trips }),
      h('p', { className: 'muted map-legend' }, '太い線 = どれかの旅で走った道、丸 = それぞれの旅の今いる場所。')),
    j.companions.length > 0 && h('div', null, h('b', null, '道連れの話: '),
      j.companions.map((c) => `${c.name}(${c.met} 回・${c.chapter >= c.chapters ? '話を聞き終えた' : `${c.chapter}/${c.chapters} 章`})`).join('、'),
      h('div', { className: 'muted' }, '道連れの話は、別のコースの旅でも続きから聞けます。')),
    j.stamps.list.length > 0 && h('div', null, h('b', null, 'スタンプ: '),
      j.stamps.list.map((s) => s.name).join('、')),
    h(PhotoStrip, { photos }));
}

/** 区間の終点で朝を迎えた: 今日走る道を選ぶ。 */
function NextRoutes({ trip, segment, store, onTripChange }) {
  const routes = routesFrom(segment.to, cameFromSegmentId(trip));
  if (routes.length === 0) {
    return h('p', null, `${nodeName(segment.to)}に着きました。この先の区間は準備中です。日誌を振り返ったり、旅を書き出したりできます。`);
  }
  async function choose(id) {
    const t = chooseNextSegment(trip, id);
    await store.save(t, 'event').catch(() => {});
    onTripChange(t);
  }
  return h('div', null,
    h('p', null, '今日はどちらへ走る?'),
    routes.map((r) => h('div', { key: r.segmentId, className: 'row', style: { margin: '4px 0' } },
      h('button', { className: r.back ? '' : 'primary', onClick: () => choose(r.segmentId) }, routeLabel(r)))));
}

function stat(label, value) {
  return h('div', { key: label, className: 'stat' }, h('div', { className: 'muted' }, label), h('div', null, value));
}

function NumberSetting({ label, value, step, validate, onSave }) {
  const [v, setV] = useState(String(value));
  const r = validate(v);
  return h('label', { className: 'field' }, label,
    h('input', {
      type: 'number', step, value: v,
      onChange: (e) => setV(e.target.value),
      onBlur: () => { if (r.valid && Number(v) !== value) onSave(Number(v)); },
    }),
    !r.valid && h('span', { className: 'err' }, r.message));
}

const MARKS = {
  partial: { icon: '☆', text: '途中まで' },
  done: { icon: '★', text: '完走' },
};

/**
 * コースの一覧。日本一周の順に並び、地方ごとに見出しをつける。どのコースからでも始められる。
 * 一度でも走ったコースには「途中まで」、終点まで走ったコースには「完走」の印をつける(progress は courseProgress())。
 */
function CourseList({ courses, selectedId, progress, courseTrips, onSelect, renderPanel }) {
  const list = [];
  const links = courseLinks(courses);
  const where = tripsWhere(courseTrips);
  courses.forEach((c, i) => {
    // 前のコースの終点から、このコースの出発の町へ電車・船で渡る(地方の見出しより前に出す)
    const link = links.get(c.segmentId);
    if (link) list.push(h('li', { key: `l-${c.segmentId}`, className: 'course-link' }, linkText(link)));
    if (i === 0 || courses[i - 1].regionName !== c.regionName) list.push(h('li', { key: `r-${c.regionName}`, className: 'course-region' }, c.regionName));
    const sel = c.segmentId === selectedId;
    const mark = courseMark(progress, c.segmentId);
    const demo = mark && progress.get(c.segmentId)?.demo;
    const saved = courseTrips?.get(c.segmentId);
    // 旅が今いるコース(分かれ道で先へ進んだ旅は、始めたコースではなく今いるコースに印をつける)
    const here = where.get(c.segmentId) ?? [];
    list.push(h('li', { key: c.segmentId },
      h('button', {
        type: 'button', className: `course${sel ? ' selected' : ''}${mark ? ` ${mark}` : ''}`, 'aria-expanded': sel,
        onClick: () => onSelect(c.segmentId),
      },
      h('span', { className: 'course-no' }, c.no),
      h('span', { className: 'course-name' }, c.name,
        c.side && h('span', { className: 'course-side' }, '寄り道'),
        c.unpavedM > 0 && h('span', { className: 'course-gravel' }, `砂利道 ${km(c.unpavedM)} km`),
        mark && h('span', { className: `course-mark ${mark}`, title: demo ? `${MARKS[mark].text}(デモで走っただけ)` : MARKS[mark].text },
          `${MARKS[mark].icon} ${MARKS[mark].text}${demo ? '(デモ)' : ''}`),
        saved && h('span', { className: 'course-trip' }, `旅 ${saved.day}日目`),
        here.map((x) => h('span', { key: x.trip.tripId, className: 'course-here', title: `「${getSegment(x.courseId)?.name ?? ''}」の旅が今ここにいます` },
          x.courseId === c.segmentId ? '📍 いまここ' : `📍 ${nodeName(getSegment(x.courseId)?.from)}からの旅がここ`))),
      h('span', { className: 'course-stat' }, `${km(c.lengthM)} km・上り ${c.climbM} m${saved ? `・旅は今 ${tripWhere(saved).replace(/^\d+日目・/, '')}` : ''}`)),
      sel && renderPanel?.(c)));
  });
  return h('ul', { className: 'course-list' }, list);
}

const LINK_ICONS = { ferry: '⛴', train: '🚃' };

/** コースのつながりの1行(例: ⛴ 土肥 → 清水 駿河湾のフェリーで渡る・75 分・3,200 円)。 */
function linkText(l) {
  if (l.kind === 'gap') return `… ${l.fromName}から${l.toName}までの道は準備中`;
  const how = l.kind === 'ferry' ? 'で渡る' : 'で移る';
  return `${LINK_ICONS[l.kind] ?? '→'} ${l.fromName} → ${l.toName}  ${l.name}${how}・${l.minutes} 分・${l.yen.toLocaleString()} 円`;
}

function CourseLegend({ progress }) {
  if (!progress || progress.size === 0) return null;
  return h('p', { className: 'muted course-legend' },
    `${MARKS.partial.icon} ${MARKS.partial.text} = 少しでも走ったことがあるコース、${MARKS.done.icon} ${MARKS.done.text} = 終点まで走ったコース(これまでの旅も含む。デモで走っただけなら「(デモ)」)。📍 = 旅が今いるコース。`);
}

const baseCourseId = (id) => (id?.endsWith(REVERSE_SUFFIX) ? id.slice(0, -REVERSE_SUFFIX.length) : id);

/** コース(順方向の区間 id)→ そこに今いる旅の一覧 [{ trip, courseId(旅を始めたコース) }]。 */
function tripsWhere(courseTrips) {
  const out = new Map();
  for (const [courseId, t] of courseTrips ?? []) {
    const at = baseCourseId(t.position.segmentId);
    if (!out.has(at)) out.set(at, []);
    out.get(at).push({ trip: t, courseId });
  }
  return out;
}

/** このコースに今いる、ほかのコースから来た旅。 */
function tripsHere(courseTrips, segmentId) {
  return (tripsWhere(courseTrips).get(segmentId) ?? []).filter((x) => x.courseId !== segmentId);
}

/** 旅の短い説明(例: 3日目・伊東 → 下田 12.3 km 地点)。 */
function tripWhere(t) {
  const seg = getSegment(t.position.segmentId);
  return `${t.day}日目・${seg ? `${seg.name} ${km(t.position.segmentM)} km 地点` : ''}`;
}

function TripLog({ trip, selectedDay, onSelect }) {
  if (trip.log.length === 0) return null;
  return h('section', { className: 'pane' },
    h('h3', null, '日誌'),
    [...trip.log].reverse().map((d) => h('div', {
      key: d.day, className: `log-day clickable${d.day === selectedDay ? ' selected' : ''}`, onClick: () => onSelect?.(d.day),
    },
      h('b', null, `${d.day}日目`), ' ',
      d.demo && h('span', { className: 'demo-tag', title: 'トレーナーなしのデモで走った日' }, d.demoM >= d.distanceM - 1 ? 'デモ' : `デモ ${km(d.demoM)} km を含む`), ' ',
      h('span', { className: 'muted' }, `${km(d.distanceM)} km・走行 ${fmtTime(d.rideSeconds)}・獲得標高 ${Math.round(d.elevationGainM)} m・${fmtClock(d.endClockMinutes)} 着`),
      d.meals.length > 0 && h('div', null, `食べたもの: ${d.meals.map((m) => m.name).join('、')}`),
      d.encounters.some((e) => !e.work) && h('div', null, `出会い: ${d.encounters.filter((e) => !e.work).length} 回`),
      d.encounters.filter((e) => e.work).map((e, i) => h('div', { key: `w${i}` }, `${e.text}(${(e.yen ?? 0).toLocaleString()} 円)`)),
      d.incidents.map((x, i) => h('div', { key: i, className: 'err' }, x.text)),
      (trip.legs ?? []).filter((l) => l.transfer?.day === d.day).map((l, i) => h('div', { key: `tr${i}` }, `移動: ${l.transfer.name}で${nodeName(l.transfer.to)}へ`)),
      d.lodging && h('div', null, `泊まった場所: ${d.lodging.name}${d.lodging.yen ? `(${d.lodging.yen.toLocaleString()} 円)` : ''}`),
      trackForDay(trip, d.day) && h('button', {
        className: 'link',
        onClick: (e) => { e.stopPropagation(); downloadTrackTcx(trackForDay(trip, d.day)); },
      }, 'この日の走行記録を保存(TCX)'))));
}
