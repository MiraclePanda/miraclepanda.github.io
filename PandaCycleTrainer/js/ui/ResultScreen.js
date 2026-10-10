import { h, useState, useEffect } from './h.js';
import { fmtTime } from '../utils/format.js';
import { downloadTcx } from '../storage/tcx.js';
import { getAllRides } from '../storage/db.js';
import { getCourseProfile } from '../physics/courseProfiles.js';
import { recordKcal, gourmetVerdict } from '../utils/gourmet.js';
import { journeyTotalKm } from '../utils/journey.js';
import { JourneyCard } from './JourneyCard.js';

/**
 * リザルト画面。
 * 要件定義書5章「経過時間(休憩含む)と走行時間(休憩除く)を分けて表示」に対応。
 */
export function ResultScreen({ record, onBackToSetup, onOpenHistory }) {
  // 日本縦断: 今回の記録を含む合計距離(保存に失敗した記録は一覧に無いので足す)
  const [totalKm, setTotalKm] = useState(null);
  const rideKm = record.totalDistanceM / 1000;
  useEffect(() => {
    let alive = true;
    getAllRides()
      .then((rides) => alive && setTotalKm(journeyTotalKm(rides) + (record.id == null ? rideKm : 0)))
      .catch(() => alive && setTotalKm(rideKm));
    return () => { alive = false; };
  }, []);
  // 実在コース(gpx-)は名物が無いので定番の食べ物だけ
  const verdict = gourmetVerdict(recordKcal(record), record.courseId?.startsWith('gpx-') ? null : getCourseProfile(record.courseId));

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
      'section', { className: 'card gourmet-card' },
      h('h2', null, '🍜 今日のごほうび'),
      h('p', { className: 'gourmet-kcal' }, '消費カロリー(目安) ', h('strong', null, Math.round(verdict.kcal)), ' kcal'),
      h('p', { className: 'gourmet-headline' }, `${verdict.headline}を消費しました`),
      h('p', null, verdict.comment),
      h(
        'ul', { className: 'gourmet-list' },
        verdict.items.map((it) =>
          h('li', { key: it.name, className: it.local ? 'is-local' : '' },
            h('span', null, it.local ? `${it.name}(名物)` : it.name),
            h('strong', null, `${it.amount}${it.unit}`)))
      ),
      h('p', { className: 'muted small' }, 'ペダルを回した仕事量から、体の効率を約24%として推定した目安です。')
    ),
    h(JourneyCard, { totalKm, rideKm }),
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
