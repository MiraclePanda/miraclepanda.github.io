// ホーム: 新しい旅を始める/続きから再開、トレーナー接続、旅の書き出し・読み込み、日誌。

import { h, useState, useEffect, useRef } from './h.js';
import { createTrip, resumeLabel, fmtClock, TIME_SCALES, chooseNextSegment, takeTransfer } from '../storage/tripState.js';
import {
  routesFrom, nodeName, currentNode, cameFromSegmentId, transfersFrom, segmentArrivingAt, getSegment,
} from '../trip/network.js';
import { routeLabel } from './RideScreen.js';
import { TripMap } from './TripMap.js';
import { stampProgress } from '../trip/stamps.js';
import { gearOptions, shipHome, buyGear, buyFood, atTown, FOOD } from '../trip/gear.js';
import { downloadTrip, importTripFile } from '../storage/tripFile.js';
import { validateWeight, validateBikeWeight, validateFtp, validatePowerScale } from '../utils/validation.js';
import { packWeightKg } from '../physics/surfaces.js';
import { satietyLabel } from '../trip/body.js';
import { forecastDay, forecastText } from '../trip/dayEvents.js';
import { fmtTime } from '../utils/format.js';
import { HeroArt } from './HeroArt.js';

const km = (m) => (m / 1000).toFixed(1);

export function HomeScreen({ trip, segment, store, persistent, notice, client, onTripChange, onRide }) {
  const [conn, setConn] = useState(client.isConnected ? { name: client.device?.name, mode: client.controlMode } : null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

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
    const r = await importTripFile(file, store);
    if (r.ok) onTripChange(r.trip);
    else setError(`読み込めませんでした: ${r.error}`);
  }

  async function changeSetting(patch) {
    const t = { ...trip, settings: { ...trip.settings, ...patch } };
    await store.save(t, 'event');
    onTripChange(t);
  }

  const header = [
    h(HeroArt, { key: 'h' },
      h('p', { className: 'hero-kicker' }, '自分の脚だけで、日本を旅する'),
      h('h1', null, 'PandaCycleExpedition'),
      h('p', { className: 'sub' }, trip ? `${trip.day}日目・旅の距離 ${km(trip.position.totalM)} km。今日はどこまで行こう。` : '荷物を積んだグラベルバイクで、熱海から旅に出る。')),
    !persistent && h('p', { key: 'p', className: 'err' }, 'このブラウザでは旅を保存できません。こまめに書き出してください。'),
    notice && h('p', { key: 'n', className: 'err' }, notice),
    error && h('p', { key: 'e', className: 'err' }, error),
  ];
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', ref: fileRef, style: { display: 'none' }, onChange: onImport });

  if (!trip) {
    return h('div', { className: 'page' }, ...header,
      h(NewTripForm, { store, onTripChange }),
      h('div', { className: 'card' },
        h('h2', null, '書き出した旅の続きから'),
        h('p', { className: 'muted' }, '別の端末やブラウザで書き出した旅のファイル(.json)を読み込みます。'),
        h('button', { onClick: () => fileRef.current.click() }, '旅を読み込む'), importInput));
  }

  const finished = !trip.ride && trip.position.segmentM >= segment.lengthM - 1;
  const midRide = !!trip.ride;
  const timeScaleLocked = midRide;
  return h('div', { className: 'page' }, ...header,
    h('div', { className: 'card depart' },
      h('h2', null, finished ? `${trip.day}日目の朝・${nodeName(segment.to)}` : resumeLabel(trip, segment.name)),
      finished && h(NextRoutes, { trip, segment, store, onTripChange }),
      h('div', { className: 'grid' },
        stat('体力', `${Math.round(trip.rider.stamina)}`),
        stat('満腹度', `${Math.round(trip.rider.satiety)}(${satietyLabel(trip.rider.satiety)})`),
        stat('所持金', `${trip.wallet.yen.toLocaleString()} 円`),
        stat('荷物', `${packWeightKg(trip.bike.pack).toFixed(1)} kg(食料 ${(trip.bike.pack.food ?? 0).toFixed(2)} kg)`),
        stat('旅の距離', `${km(trip.position.totalM)} km`),
        stat(midRide ? '今日の天気予報' : `${trip.day}日目の天気予報`, forecastText(forecastDay(trip.tripId, trip.day))),
        stat('区間', `${segment.name}(残り ${km(Math.max(0, segment.lengthM - trip.position.segmentM))} km)`)),
      h('h2', null, 'トレーナー'),
      h('div', { className: 'row' },
        conn
          ? h('span', null, `接続中: ${conn.name ?? '(名前なし)'}(${conn.mode === 'erg' ? 'ERG' : 'シミュレーション'}モード)`)
          : h('button', { onClick: connect, disabled: busy }, busy ? '接続中...' : 'トレーナーに接続'),
      ),
      h('div', { className: 'row', style: { marginTop: '12px' } },
        h('button', { className: 'primary go', disabled: finished || !conn, onClick: () => onRide(false) }, midRide ? '続きを走る' : '出発する'),
        h('button', { disabled: finished, onClick: () => onRide(true) }, 'デモで走る(トレーナーなし)')),
      h('h2', null, '設定'),
      h('div', { className: 'grid' },
        h('label', { className: 'field' }, '旅の時間の早回し',
          h('select', {
            value: trip.settings.timeScale, disabled: timeScaleLocked,
            onChange: (e) => changeSetting({ timeScale: Number(e.target.value) }),
          }, TIME_SCALES.map((x) => h('option', { key: x, value: x }, `${x}倍(走行1時間 = 旅の${x}時間)`)))),
        h(NumberSetting, {
          label: 'パワー補正の倍率', value: trip.settings.powerScale ?? 1, step: 0.05, validate: validatePowerScale,
          onSave: (v) => changeSetting({ powerScale: v }),
        })),
      timeScaleLocked && h('p', { className: 'muted' }, '早回しの倍率は走行の途中では変えられません(翌朝から変えられます)。')),
    !midRide && h(GearCard, { trip, segment, store, onTripChange }),
    !midRide && h(TransferCard, { trip, segment, store, onTripChange }),
    h('div', { className: 'card' },
      h('h2', null, '旅の記録'),
      h('p', { className: 'muted' }, '旅は走行中30秒ごとに自動で保存されます。ブラウザのデータは消えることがあるので、ときどき書き出しておくと安心です。'),
      h('div', { className: 'row' },
        h('button', { onClick: () => downloadTrip(trip) }, '旅を書き出す'),
        h('button', { onClick: () => fileRef.current.click() }, '旅を読み込む'),
        h('button', {
          onClick: () => { if (confirm('新しい旅を始めますか?(いまの旅は書き出していなければ戻せなくなります)')) onTripChange(null); },
        }, '新しい旅を始める')),
      importInput),
    h(TripMapCard, { trip }));
}

/** 旅の地図と日誌。日誌の日をタップすると、その日に走った道が地図で光る。 */
function TripMapCard({ trip }) {
  const [day, setDay] = useState(null);
  return h('div', null,
    h('div', { className: 'card' },
      h('h2', null, '旅の地図'),
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
    const arrive = segmentArrivingAt(tr.to);
    const seg = getSegment(arrive);
    if (!seg) return;
    const t = takeTransfer(trip, tr, arrive, seg.lengthM);
    if (t === trip) return;
    await store.save(t, 'event').catch(() => {});
    onTripChange(t);
  }
  return h('div', { className: 'card' },
    h('h2', null, `${nodeName(node)}から電車・船で移る`),
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
  return h('div', { className: 'card' },
    h('h2', null, '荷物を見直す'),
    !inTown && h('p', { className: 'muted' }, '店のある町にいないので、ここでは送ったり買ったりできません。'),
    h('p', { className: 'muted' }, 'テントがないと公園やキャンプ場に泊まれず、寝袋がないとテント泊でよく眠れません。雨具がないと雨の中で疲れやすくなります。荷物が軽いほど坂は楽です。'),
    gearOptions(trip).map((g) => h('div', { key: g.key, className: 'row', style: { justifyContent: 'space-between', margin: '4px 0' } },
      h('span', null, `${g.label}(${g.kg} kg)・${g.owned ? '持っている' : '持っていない'}`),
      h('button', {
        disabled: !inTown || !g.affordable,
        onClick: () => apply(g.owned ? shipHome(trip, g.key) : buyGear(trip, g.key)),
      }, g.owned ? `家へ送る(${g.shipYen.toLocaleString()} 円)` : `買う(${g.buyYen.toLocaleString()} 円)`))),
    h('div', { className: 'row', style: { justifyContent: 'space-between', margin: '4px 0' } },
      h('span', null, `食料 ${food.toFixed(2)} kg(最大 ${FOOD.maxKg} kg)`),
      h('button', { disabled: !inTown || food >= FOOD.maxKg - 1e-9, onClick: () => apply(buyFood(trip)) },
        `${FOOD.stepKg} kg 買い足す(${Math.round(FOOD.stepKg * FOOD.yenPerKg).toLocaleString()} 円)`)));
}

/** スタンプ帳: 立ち寄った見どころと、食べた名物。 */
function StampBook({ trip }) {
  const p = stampProgress(trip);
  const stamps = trip.stamps ?? [];
  const list = (kind) => stamps.filter((s) => s.kind === kind)
    .map((s) => `${s.name}${s.place ? `(${s.place})` : ''}・${s.day}日目`).join('、') || 'まだありません';
  return h('div', { className: 'card' },
    h('h2', null, 'スタンプ帳'),
    h('p', { className: 'stamp-count' }, '見どころ', h('b', null, p.sights.got), `/ ${p.sights.total}・名物`, h('b', null, p.foods.got), `/ ${p.foods.total}`),
    h('div', null, h('b', null, '立ち寄った見どころ: '), list('sight')),
    h('div', null, h('b', null, '食べた名物: '), list('food')),
    h('p', { className: 'muted' }, '見どころの前で「立ち寄る」を選ぶか、店で食べるとスタンプが押されます。'));
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

function NewTripForm({ store, onTripChange }) {
  const [f, setF] = useState({ weight: '70', bike: '11', ftp: '200', timeScale: 4 });
  const checks = [validateWeight(f.weight), validateBikeWeight(f.bike), validateFtp(f.ftp)];
  const ok = checks.every((c) => c.valid);
  const field = (key, label) => h('label', { className: 'field' }, label,
    h('input', { type: 'number', value: f[key], onChange: (e) => setF({ ...f, [key]: e.target.value }) }));
  async function start() {
    const t = createTrip({
      riderWeightKg: Number(f.weight), bikeWeightKg: Number(f.bike), ftpW: Number(f.ftp), timeScale: Number(f.timeScale),
    });
    await store.save(t, 'event');
    onTripChange(t);
  }
  return h('div', { className: 'card depart' },
    h('h2', null, '旅の支度'),
    h('p', { className: 'muted' }, '1日目は熱海サンビーチを朝7時に出発し、国道135号で伊東を目指します。荷物(テント・寝袋・食料・水など)は約14kg、所持金は3万円です。自転車の重さは荷物を積まない状態で入れてください。'),
    h('div', { className: 'grid' },
      field('weight', '体重(kg)'), field('bike', '自転車の重さ(kg)'), field('ftp', 'FTP(W)'),
      h('label', { className: 'field' }, '旅の時間の早回し',
        h('select', { value: f.timeScale, onChange: (e) => setF({ ...f, timeScale: Number(e.target.value) }) },
          TIME_SCALES.map((x) => h('option', { key: x, value: x }, `${x}倍`))))),
    checks.filter((c) => !c.valid).map((c, i) => h('p', { key: i, className: 'err' }, c.message)),
    h('div', { className: 'row', style: { marginTop: '10px' } }, h('button', { className: 'primary go', disabled: !ok, onClick: start }, '旅立つ')));
}

function TripLog({ trip, selectedDay, onSelect }) {
  if (trip.log.length === 0) return null;
  return h('div', { className: 'card' },
    h('h2', null, '日誌'),
    [...trip.log].reverse().map((d) => h('div', {
      key: d.day, className: `log-day clickable${d.day === selectedDay ? ' selected' : ''}`, onClick: () => onSelect?.(d.day),
    },
      h('b', null, `${d.day}日目`), ' ',
      h('span', { className: 'muted' }, `${km(d.distanceM)} km・走行 ${fmtTime(d.rideSeconds)}・獲得標高 ${Math.round(d.elevationGainM)} m・${fmtClock(d.endClockMinutes)} 着`),
      d.meals.length > 0 && h('div', null, `食べたもの: ${d.meals.map((m) => m.name).join('、')}`),
      d.encounters.length > 0 && h('div', null, `出会い: ${d.encounters.length} 回`),
      d.incidents.map((x, i) => h('div', { key: i, className: 'err' }, x.text)),
      (trip.legs ?? []).filter((l) => l.transfer?.day === d.day).map((l, i) => h('div', { key: `tr${i}` }, `移動: ${l.transfer.name}で${nodeName(l.transfer.to)}へ`)),
      d.lodging && h('div', null, `泊まった場所: ${d.lodging.name}${d.lodging.yen ? `(${d.lodging.yen.toLocaleString()} 円)` : ''}`))));
}
