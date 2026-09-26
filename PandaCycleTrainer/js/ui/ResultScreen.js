import { h } from './h.js';
import { fmtTime } from '../utils/format.js';
import { downloadTcx } from '../storage/tcx.js';

/**
 * リザルト画面。
 * 要件定義書5章「経過時間(休憩含む)と走行時間(休憩除く)を分けて表示」に対応。
 */
export function ResultScreen({ record, onBackToSetup, onOpenHistory }) {
  return h(
    'div', { className: 'screen result-screen' },
    h('h1', null, 'リザルト'),
    h(
      'section', { className: 'card' },
      h('h2', null, record.courseName),
      h(
        'div', { className: 'result-grid' },
        resultTile('走行距離', (record.totalDistanceM / 1000).toFixed(2), 'km'),
        resultTile('獲得標高', Math.round(record.elevationGainM), 'm'),
        resultTile('経過時間(休憩含む)', fmtTime(record.elapsedTimeS), ''),
        resultTile('走行時間(休憩除く)', fmtTime(record.ridingTimeS), ''),
        resultTile('平均パワー', Math.round(record.avgPowerW), 'W'),
        resultTile('平均速度', record.avgSpeedKmh.toFixed(1), 'km/h'),
        resultTile('平均ケイデンス', Math.round(record.avgCadenceRpm), 'rpm')
      ),
      h('p', { className: 'muted small' }, '平均パワー・平均速度は0W区間も含めた単純平均です(Stravaの標準的な算出方式に合わせています)。')
    ),
    h(
      'section', { className: 'card' },
      h('h2', null, 'エクスポート'),
      h('button', { className: 'btn btn-primary', onClick: () => downloadTcx(record) }, 'TCX形式でエクスポート'),
      h(
        'p', { className: 'guidance-note' },
        'GPS座標は含まれません。Strava上ではGPSなしの「屋内(Indoor)ライド」として取り込まれます。',
        h('br'),
        '「バーチャルライド」として分類したい場合は、アップロード後にStravaの編集画面でアクティビティ種別を変更してください。'
      )
    ),
    h(
      'div', { className: 'start-bar' },
      h('button', { className: 'btn btn-primary', onClick: onBackToSetup }, 'セットアップ画面に戻る'),
      h('button', { className: 'btn btn-link', onClick: onOpenHistory }, '過去の走行記録を見る')
    )
  );
}

function resultTile(label, value, unit) {
  return h(
    'div', { className: 'dash-tile' },
    h('div', { className: 'dash-label' }, label),
    h('div', { className: 'dash-value' }, h('span', null, value), unit && h('span', { className: 'dash-unit' }, unit))
  );
}
