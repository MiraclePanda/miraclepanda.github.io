import { h, useState, useEffect } from './h.js';
import { getAllRides, deleteRide } from '../storage/db.js';
import { downloadTcx } from '../storage/tcx.js';
import { fmtTime } from '../utils/format.js';
import { ConfirmDialog } from './Modal.js';

/**
 * 過去の走行記録一覧画面。
 * 要件定義書6章「アプリ内に「過去の走行記録一覧」画面を用意する」に対応。
 */
export function HistoryScreen({ onBack }) {
  const [rides, setRides] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    const list = await getAllRides();
    setRides(list);
  };

  const handleDeleteConfirm = async () => {
    if (deleteTarget != null) {
      await deleteRide(deleteTarget);
      setDeleteTarget(null);
      load();
    }
  };

  return h(
    'div', { className: 'screen history-screen' },
    h('h1', null, '過去の走行記録'),
    h('button', { className: 'btn btn-secondary', onClick: onBack }, '戻る'),
    rides === null && h('p', null, '読み込み中...'),
    rides && rides.length === 0 && h('p', { className: 'muted' }, 'まだ走行記録がありません。'),
    rides &&
      rides.length > 0 &&
      h(
        'div', { className: 'ride-list' },
        rides.map((r) =>
          h(
            'div', { key: r.id, className: 'card ride-list-item' },
            h('div', null,
              h('strong', null, r.courseName),
              h('span', { className: 'muted small' }, ` — ${new Date(r.startTime).toLocaleString('ja-JP')}`)
            ),
            h(
              'div', { className: 'ride-list-stats' },
              h('span', null, `${(r.totalDistanceM / 1000).toFixed(2)} km`),
              h('span', null, fmtTime(r.ridingTimeS)),
              h('span', null, `平均${Math.round(r.avgPowerW)}W`)
            ),
            h(
              'div', { className: 'ride-list-actions' },
              h('button', { className: 'btn btn-secondary', onClick: () => downloadTcx(r) }, 'TCXエクスポート'),
              h('button', { className: 'btn btn-danger', onClick: () => setDeleteTarget(r.id) }, '削除')
            )
          )
        )
      ),
    deleteTarget != null &&
      h(ConfirmDialog, {
        title: '走行記録を削除しますか？',
        message: 'この操作は取り消せません。',
        confirmLabel: '削除する',
        cancelLabel: 'キャンセル',
        danger: true,
        onConfirm: handleDeleteConfirm,
        onCancel: () => setDeleteTarget(null),
      })
  );
}
