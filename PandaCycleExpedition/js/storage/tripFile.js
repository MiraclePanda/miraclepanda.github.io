// 旅全体を1つの JSON ファイルに書き出し/読み込みする(設計書5章)。
// 別の端末やブラウザで読み込んで、そこから旅を続けられる。
// ファイルには形式名とスキーマのバージョンを入れ、読み込み時は migrateTrip() で今の形式にそろえて確かめる。

import { migrateTrip } from './tripState.js';

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
  return migrateTrip(obj.trip);
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
 * @returns {Promise<{ok:true, trip:object} | {ok:false, error:string}>}
 */
export async function importTripFile(file, store) {
  const r = parseTripFile(await file.text());
  if (r.ok) await store.save(r.trip, 'import');
  return r;
}
