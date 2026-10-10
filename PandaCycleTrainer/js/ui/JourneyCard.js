import { h } from './h.js';
import {
  JOURNEY_CITIES, JOURNEY_TOTAL_KM, JOURNEY_MAP, journeyPosition, citiesPassed, projectLatLon,
} from '../utils/journey.js';

// 地図に名前を出す経由地(混み合わないよう主な所だけ)
const LABELED = new Set(['宗谷岬', '札幌', '函館', '仙台', '東京', '名古屋', '京都', '広島', '福岡', '佐多岬']);

/**
 * バーチャル日本縦断のカード(セットアップ画面・リザルト画面)。
 * これまでの合計距離で宗谷岬→佐多岬のどこまで来たかを、小さな地図(経由地を結んだ線)と文章で出す。
 * @param {object} props
 * @param {number|null} props.totalKm これまでの走行記録の合計距離(km)。読み込み中は null
 * @param {number} [props.rideKm] リザルト画面: 今回の走行距離(km)。今回通過した経由地を出す
 */
export function JourneyCard({ totalKm, rideKm }) {
  if (totalKm === null || totalKm === undefined) {
    return h('section', { className: 'card journey-card' }, h('h2', null, '🗾 バーチャル日本縦断'), h('p', { className: 'muted small' }, '読み込み中...'));
  }
  const pos = journeyPosition(totalKm);
  const passed = Number.isFinite(rideKm) && rideKm > 0 ? citiesPassed(totalKm - rideKm, totalKm) : [];
  const route = JOURNEY_CITIES.map((c) => projectLatLon(c.lat, c.lon));
  // 今の周で通った所までの線(進んだ分だけ色を変える)
  const doneRoute = route.slice(0, pos.nextIndex).concat([projectLatLon(pos.lat, pos.lon)]);
  const [mx, my] = projectLatLon(pos.lat, pos.lon);
  const toPoints = (pts) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  return h(
    'section', { className: 'card journey-card' },
    h('h2', null, '🗾 バーチャル日本縦断'),
    h(
      'div', { className: 'journey-body' },
      h(
        'svg',
        {
          className: 'journey-map', viewBox: `-8 -8 ${JOURNEY_MAP.width + 16} ${JOURNEY_MAP.height + 16}`,
          role: 'img', 'aria-label': `日本縦断の地図。現在地は${pos.from.name}と${pos.to.name}の間`,
        },
        h('polyline', { className: 'journey-route', points: toPoints(route) }),
        h('polyline', { className: 'journey-route-done', points: toPoints(doneRoute) }),
        JOURNEY_CITIES.map((c, i) => {
          const [x, y] = route[i];
          return h(
            'g', { key: c.name },
            h('circle', { className: c.km <= pos.kmInLap ? 'journey-city is-passed' : 'journey-city', cx: x, cy: y, r: 2.2 }),
            LABELED.has(c.name) && h('text', { className: 'journey-label', x: x + 4, y: y + 3 }, c.name)
          );
        }),
        h('circle', { className: 'journey-me', cx: mx, cy: my, r: 4.5 }),
        h('text', { className: 'journey-me-icon', x: mx, y: my - 7, textAnchor: 'middle' }, '🚲')
      ),
      h(
        'div', { className: 'journey-text' },
        h('p', { className: 'journey-now' },
          pos.lap > 1 && h('span', { className: 'journey-lap' }, `${pos.lap}周目`),
          `${pos.from.name} → ${pos.to.name}`),
        h('p', null, `次の${pos.to.name}まで あと `, h('strong', null, pos.kmToNext.toFixed(1)), ' km'),
        h('p', { className: 'muted small' },
          `宗谷岬から ${pos.kmInLap.toFixed(1)} km / ${JOURNEY_TOTAL_KM} km(${(pos.fraction * 100).toFixed(1)}%)`),
        h('div', { className: 'journey-bar', 'aria-hidden': 'true' }, h('div', { className: 'journey-bar-fill', style: { width: `${(pos.fraction * 100).toFixed(2)}%` } })),
        passed.length > 0 &&
          h('div', { className: 'journey-passed' },
            h('p', { className: 'field-title' }, '今回通過した所'),
            h('ul', null, passed.map((p) => h('li', { key: `${p.lap}-${p.city.name}` }, h('strong', null, p.city.name), ` — ${p.city.note}`)))),
        !Number.isFinite(rideKm) &&
          h('p', { className: 'muted small' }, 'これまでの走行記録の合計距離で日本列島を進みます(デモ走行は数えません)。走行中に経由地を通過するとお知らせします。')
      )
    )
  );
}
