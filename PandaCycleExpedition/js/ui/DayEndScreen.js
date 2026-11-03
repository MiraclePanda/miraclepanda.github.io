// 1日の終わり: 宿を選ぶ(着いた・ここまでにした)か、失敗の結果を見て、日誌の1日分を表示する。

import { h, useState } from './h.js';
import { lodgingOptions, stayAt, FAILURES, LODGING_EFFECTS } from '../trip/dayEvents.js';
import { fmtClock } from '../storage/tripState.js';
import { fmtTime } from '../utils/format.js';

export function DayEndScreen({ trip, segment, store, reason, onDone, onBackToRide }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const failed = !!FAILURES[reason];

  // 失敗(救護・野宿)はもう1日が終わっている。日誌の最後の日を見せる
  if (failed || !trip.ride) {
    const d = trip.log[trip.log.length - 1];
    return h('div', { className: 'page' },
      h('h1', null, `${d.day}日目の終わり`),
      failed && h('p', { className: 'err' }, FAILURES[reason].text + '。'),
      h(DaySummary, { d }),
      h('p', null, `翌朝: 体力 ${Math.round(trip.rider.stamina)}・満腹度 ${Math.round(trip.rider.satiety)}・所持金 ${trip.wallet.yen.toLocaleString()} 円`),
      h('button', { className: 'primary', onClick: () => onDone(trip) }, 'ホームへ'));
  }

  const opts = lodgingOptions(trip, segment, trip.position.segmentM);
  async function choose(o) {
    setSaving(true);
    const t = stayAt(trip, o);
    try {
      await store.save(t, 'dayEnd');
      onDone(t);
    } catch (e) {
      setError(`保存できませんでした: ${e.message}。旅を書き出しておいてください。`);
      setSaving(false);
      onDone(t);
    }
  }
  return h('div', { className: 'page' },
    h('h1', null, reason === 'arrived' ? `${segment.goalName ?? '終点'}に着いた!` : `${trip.day}日目、ここまで`),
    h('p', { className: 'sub' }, `旅の時刻 ${fmtClock(trip.clockMinutes)}・今日 ${(trip.ride.distanceM / 1000).toFixed(1)} km・所持金 ${trip.wallet.yen.toLocaleString()} 円`),
    error && h('p', { className: 'err' }, error),
    h('div', { className: 'card' },
      h('h2', null, '今夜の宿'),
      opts.map((o, i) => h('div', { key: i, className: 'row', style: { justifyContent: 'space-between', margin: '6px 0' } },
        h('div', null, h('b', null, o.name), ' ', h('span', { className: 'muted' }, `${o.label}・${o.yen ? `${o.yen.toLocaleString()} 円` : '無料'}・${effectText(o.kind)}`),
          o.reason && h('div', { className: 'err' }, o.reason)),
        h('button', { disabled: !o.available || saving, onClick: () => choose(o) }, 'ここに泊まる')))),
    reason !== 'arrived' && h('button', { onClick: onBackToRide, disabled: saving }, 'もう少し走る'));
}

function effectText(kind) {
  const e = LODGING_EFFECTS[kind];
  if (e.staminaTo === 100) return '体力が全快・夕食と朝食つき';
  if (kind === 'guesthouse') return '体力 +60・朝食つき';
  if (kind === 'bivouac') return 'ほとんど休めない';
  return `体力 +${e.staminaAdd}・荷物の食料で夕食と朝食`;
}

function DaySummary({ d }) {
  return h('div', { className: 'card' },
    h('div', null, `${(d.distanceM / 1000).toFixed(1)} km・走行 ${fmtTime(d.rideSeconds)}・獲得標高 ${Math.round(d.elevationGainM)} m`),
    d.meals.length > 0 && h('div', null, `食べたもの: ${d.meals.map((m) => m.name).join('、')}`),
    d.encounters.map((e, i) => h('div', { key: i, className: 'muted' }, e.text)),
    d.lodging && h('div', null, `泊まった場所: ${d.lodging.name}`));
}
