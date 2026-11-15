// 旅全体を1つの JSON ファイルに書き出し/読み込みする(設計書5章)。
// 別の端末やブラウザで読み込んで、そこから旅を続けられる。
// ファイルには形式名とスキーマのバージョンを入れ、読み込み時は migrateTrip() で今の形式にそろえて確かめる。

import { migrateTrip } from './tripState.js';
import { SEGMENTS } from '../data/catalog.js';

const REVERSE_SUFFIX = '~rev'; // js/trip/network.js と同じ(storage から trip へは依存しない)
/** 区間 id(逆向きも可)が今のアプリの区間一覧にあるか。 */
export function knownSegment(id, segments = SEGMENTS) {
  return typeof id === 'string' && !!segments[id.endsWith(REVERSE_SUFFIX) ? id.slice(0, -REVERSE_SUFFIX.length) : id];
}

export const FILE_FORMAT = 'PandaCycleExpedition-trip';

/** 書き出す JSON の文字列(純粋関数)。 */
export function serializeTrip(trip, now = Date.now()) {
  return JSON.stringify({
    format: FILE_FORMAT,
    schemaVersion: trip.schemaVersion,
    exportedAt: new Date(now).toISOString(),
    trip,
  }, null, 2);
}

/**
 * 読み込んだ文字列から旅を取り出す(純粋関数)。
 * @returns {{ok:true, trip:object} | {ok:false, error:string}}
 */
export function parseTripFile(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON として読めないファイルです。' };
  }
  if (!obj || obj.format !== FILE_FORMAT) return { ok: false, error: 'PandaCycleExpedition の旅のファイルではありません。' };
  const r = migrateTrip(obj.trip);
  if (!r.ok) return r;
  // 区間を作り直して id が変わった・別の版で作られた旅は、走れないまま読み込まない
  const unknown = [r.trip.position.segmentId, ...r.trip.legs.map((l) => l.segmentId)].find((id) => !knownSegment(id));
  if (unknown) return { ok: false, error: `このアプリには無い区間(${unknown})を走っている旅です。アプリを更新してください。` };
  return r;
}

/** ファイル名(例: expedition-day3-2026-11-03.json)。 */
export function tripFileName(trip, now = Date.now()) {
  return `expedition-day${trip.day}-${new Date(now).toISOString().slice(0, 10)}.json`;
}

/** ブラウザで旅のファイルをダウンロードさせる。 */
export function downloadTrip(trip) {
  const blob = new Blob([serializeTrip(trip)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = tripFileName(trip);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 選ばれたファイル(<input type="file"> の File)を読み、TripStore に 'import' として保存する。
 * confirm(trip) が false を返したら保存しない(今の旅を置き換える前に確かめる)。
 * @param {(trip:object)=>boolean|Promise<boolean>} [confirm]
 * @returns {Promise<{ok:true, trip:object} | {ok:false, error:string, cancelled?:boolean}>}
 */
export async function importTripFile(file, store, confirm = () => true) {
  const r = parseTripFile(await file.text());
  if (!r.ok) return r;
  if (!(await confirm(r.trip))) return { ok: false, cancelled: true, error: '読み込みをやめました。' };
  // 読み込んだ旅をいちばん新しい旅にする(前の世代は残るので「前の保存に戻す」で戻せる)
  const t = { ...r.trip, updatedAt: Date.now() };
  await store.save(t, 'import');
  return { ok: true, trip: t };
}
