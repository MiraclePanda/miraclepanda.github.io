import { h, useState, useEffect } from './h.js';
import { getAllRides, deleteRide } from '../storage/db.js';
import { downloadTcx } from '../storage/tcx.js';
import { fmtTime } from '../utils/format.js';
import { ConfirmDialog } from './Modal.js';
import { COURSE_PROFILES } from '../physics/courseProfiles.js';
import { fromTcx, trackEndS, DEFAULT_FRIEND_GHOST_NAME } from '../storage/ghostTrack.js';
import { loadFriendGhosts, saveFriendGhost, deleteFriendGhost, MAX_FRIEND_GHOSTS_PER_COURSE } from '../storage/prefs.js';

// ゴーストにできるコース(上野不忍池はゴースト対戦の対象外)
const GHOST_COURSES = COURSE_PROFILES.filter((c) => c.id !== 'ueno');

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
    h(FriendGhostImport),
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

/**
 * 友人のゴーストの読み込み(PR2+3 仕様 §5.2)。TCX ファイル → fromTcx → コースと名前を付けて
 * localStorage に保存する(コースごとに最大3件、古いものから消える)。一覧と削除も扱う。
 */
function FriendGhostImport() {
  const [list, setList] = useState(() => loadFriendGhosts());
  const [track, setTrack] = useState(null); // 読み込んだが未保存のトラック
  const [name, setName] = useState('');
  const [courseId, setCourseId] = useState(GHOST_COURSES[0].id);
  const [message, setMessage] = useState(null); // { error: boolean, text }
  const [fileKey, setFileKey] = useState(0); // 保存後にファイル選択欄を空に戻すため

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    setTrack(null);
    setMessage(null);
    if (!file) return;
    try {
      const parsed = fromTcx(await file.text());
      if (!parsed.points || parsed.points.length < 4) {
        setMessage({ error: true, text: 'TCX から時刻と距離(DistanceMeters)を読み取れませんでした。' });
        return;
      }
      setTrack(parsed);
      setName(file.name.replace(/\.tcx$/i, ''));
    } catch (err) {
      setMessage({ error: true, text: `ファイルを読み込めませんでした: ${err.message ?? err}` });
    }
  };

  const handleSave = () => {
    if (!track) return;
    const id = saveFriendGhost({ ...track, name: name.trim() || DEFAULT_FRIEND_GHOST_NAME, courseId });
    if (!id) {
      setMessage({ error: true, text: '保存できませんでした(ブラウザの保存領域が使えない可能性があります)。' });
      return;
    }
    setList(loadFriendGhosts());
    setTrack(null);
    setName('');
    setFileKey((k) => k + 1);
    setMessage({ error: false, text: 'ゴーストとして保存しました。セットアップ画面の「ゴースト対戦」で選べます。' });
  };

  const handleDelete = (id) => {
    deleteFriendGhost(id);
    setList(loadFriendGhosts());
  };

  const courseName = (id) => COURSE_PROFILES.find((c) => c.id === id)?.name ?? id;

  return h(
    'section', { className: 'card ghost-import' },
    h('h2', null, '友人のゴースト(TCX)'),
    h('p', { className: 'muted small' },
      `TCX を読み込んでゴーストにする: 友人が書き出した TCX ファイルを読み込み、走るコースを選んで保存します(コースごとに最大${MAX_FRIEND_GHOSTS_PER_COURSE}件。超えると古いものから消えます)。`),
    h(
      'label', { className: 'field' },
      h('span', null, 'TCX ファイル'),
      h('input', { key: fileKey, type: 'file', accept: '.tcx,application/vnd.garmin.tcx+xml,application/xml,text/xml', onChange: handleFile, 'aria-label': 'TCX ファイル' })
    ),
    track &&
      h(
        'div', { className: 'ghost-import-form' },
        h('p', { className: 'small' }, `読み込み結果: ${(track.points[track.points.length - 1] / 1000).toFixed(2)} km / ${fmtTime(trackEndS(track))}`),
        h(
          'label', { className: 'field' },
          h('span', null, 'ゴーストの名前'),
          h('input', { type: 'text', value: name, maxLength: 20, onChange: (e) => setName(e.target.value), 'aria-label': 'ゴーストの名前' })
        ),
        h(
          'label', { className: 'field' },
          h('span', null, '走るコース'),
          h(
            'select', { value: courseId, onChange: (e) => setCourseId(e.target.value), 'aria-label': '走るコース' },
            GHOST_COURSES.map((c) => h('option', { key: c.id, value: c.id }, c.name))
          )
        ),
        h('button', { className: 'btn btn-primary', onClick: handleSave }, 'ゴーストとして保存')
      ),
    message && h('p', { className: message.error ? 'error-text' : 'muted small' }, message.text),
    list.length === 0
      ? h('p', { className: 'muted small' }, '読み込んだゴーストはまだありません。')
      : h(
          'ul', { className: 'ghost-import-list' },
          list.map((g) =>
            h(
              'li', { key: g.id },
              h('span', null, h('strong', null, g.name), h('span', { className: 'muted small' },
                ` — ${courseName(g.courseId)} / ${(g.points[g.points.length - 1] / 1000).toFixed(2)} km / ${fmtTime(trackEndS(g))}`)),
              h('button', { className: 'btn btn-secondary btn-small', onClick: () => handleDelete(g.id), 'aria-label': `${g.name}のゴーストを削除` }, 'ゴーストを削除')
            )
          )
        )
  );
}
