// 旅のスナップショットの保存と世代管理(設計書5章)。
//
// 保存先は IndexedDB `PandaCycleExpeditionDB`(Trainer とは別)の `snapshots` ストア。
// 1件 = { id(自動採番), tripId, kind, day, savedAt, data(旅の状態そのもの) }。
// kind: 'auto'(30秒ごと)/'event'(出来事の後)/'rideEnd'(ライド終了)/'dayEnd'(その日の終わり)/'import'(読み込み)。
// 残すもの: 旅ごとに直近 KEEP_RECENT 件 + 直近 KEEP_DAY_ENDS 日ぶんの各日の最後の 'dayEnd'。壊れていたら1つ前から再開できる。
// (スナップショットは日誌をまるごと持つので、全部の日を残すと保存量が日数の2乗で増える。残す数を一定にして1次に抑える)
// 保存のたびに全件を読み直さないよう、各スナップショットの見出し(中身なし)を覚えておき、それで古い世代を選ぶ。
//
// IndexedDB の部分は薄い backend({ getAll, get, put, delete })に閉じ込め、世代の選び方などは純粋関数にしてある
// (Node のテストでは createMemoryBackend() を使う)。

import { migrateTrip } from './tripState.js';

export const DB_NAME = 'PandaCycleExpeditionDB';
export const DB_VERSION = 1;
export const STORE = 'snapshots';
export const KEEP_RECENT = 5;
/** 日の終わりのスナップショットを残す日数(この日数より前の日へは戻せないが、書き出したファイルからは戻せる)。 */
export const KEEP_DAY_ENDS = 7;

/**
 * 消してよいスナップショットの id を選ぶ(純粋関数)。
 * 旅ごとに、新しい順の KEEP_RECENT 件と、新しい方から KEEP_DAY_ENDS 日ぶんの各日の最後の dayEnd を残す。
 * snapshots は中身(data)が無い見出しだけでもよい。
 */
export function selectPrunable(snapshots, keepRecent = KEEP_RECENT, keepDayEnds = KEEP_DAY_ENDS) {
  const byTrip = new Map();
  for (const s of snapshots) {
    if (!byTrip.has(s.tripId)) byTrip.set(s.tripId, []);
    byTrip.get(s.tripId).push(s);
  }
  const prunable = [];
  for (const list of byTrip.values()) {
    const sorted = [...list].sort(newestFirst);
    const keep = new Set(sorted.slice(0, keepRecent).map((s) => s.id));
    const lastDayEnd = new Map();
    for (const s of sorted) {
      if (s.kind === 'dayEnd' && !lastDayEnd.has(s.day) && lastDayEnd.size < keepDayEnds) lastDayEnd.set(s.day, s.id);
    }
    for (const id of lastDayEnd.values()) keep.add(id);
    for (const s of sorted) if (!keep.has(s.id)) prunable.push(s.id);
  }
  return prunable;
}

/**
 * 再開に使うスナップショットを選ぶ(純粋関数)。新しい順に、読める(migrateTrip が通る)最初の1件。
 * @param {object[]} snapshots
 * @param {string} [tripId] 指定時はその旅だけ
 * @returns {{snapshot:object, trip:object, skipped:number} | null} skipped = 壊れていて飛ばした件数
 */
export function pickResume(snapshots, tripId) {
  const list = snapshots.filter((s) => !tripId || s.tripId === tripId).sort(newestFirst);
  let skipped = 0;
  for (const s of list) {
    const r = migrateTrip(s.data);
    if (r.ok) return { snapshot: s, trip: r.trip, skipped };
    skipped++;
  }
  return null;
}

function newestFirst(a, b) {
  return (b.savedAt - a.savedAt) || (b.id - a.id);
}

/** スナップショットの見出し(中身を除いた部分)。 */
export function snapshotMeta(s) {
  return { id: s.id, tripId: s.tripId, kind: s.kind, day: s.day, savedAt: s.savedAt };
}

/** 旅の保存の窓口。backend は createIdbBackend() か createMemoryBackend()。 */
export class TripStore {
  constructor(backend) {
    this.backend = backend;
    this._meta = null; // Promise<見出しの配列>。最初の保存で1回だけ全件から作り、以後は保存・削除のたびに直す
  }

  _metaList() {
    this._meta ??= this.backend.getAll().then((rows) => rows.map(snapshotMeta));
    return this._meta;
  }

  /**
   * 旅の状態を1件保存し、古い世代を消す。
   * @param {object} trip
   * @param {string} kind
   */
  async save(trip, kind = 'auto', now = Date.now()) {
    const snapshot = {
      tripId: trip.tripId,
      kind,
      day: trip.day,
      savedAt: now,
      // 保存した後に旅の状態が変わっても、保存済みの中身は変わらないように複製する
      data: JSON.parse(JSON.stringify(trip)),
    };
    const meta = await this._metaList();
    const id = await this.backend.put(snapshot);
    meta.push(snapshotMeta({ ...snapshot, id }));
    await this._deleteIds(selectPrunable(meta.filter((m) => m.tripId === trip.tripId)));
    return id;
  }

  async _deleteIds(ids) {
    if (ids.length === 0) return;
    const meta = await this._metaList();
    const gone = new Set(ids);
    for (const id of ids) await this.backend.delete(id);
    for (let i = meta.length - 1; i >= 0; i--) if (gone.has(meta[i].id)) meta.splice(i, 1);
  }

  /** 起動時の再開: いちばん新しい読めるスナップショット(なければ null)。 */
  async latest(tripId) {
    const all = await this.backend.getAll();
    this._meta = Promise.resolve(all.map(snapshotMeta)); // ほかのタブ・直接の書き込みも拾い直す
    return pickResume(all, tripId);
  }

  /** 旅のスナップショットの見出し(新しい順)。「前の保存に戻す」の一覧に使う。 */
  async listSnapshots(tripId) {
    return (await this._metaList()).filter((m) => m.tripId === tripId).sort(newestFirst);
  }

  /** スナップショット1件を読んで今の形式にそろえる。読めなければ { ok:false }。 */
  async readSnapshot(id) {
    const row = await this.backend.get(id);
    return row ? migrateTrip(row.data) : { ok: false, error: '保存が見つかりません。' };
  }

  /**
   * 旅の古い世代を消し、いちばん新しい1件だけ残す(走り直して使わなくなった旅。コース一覧の印のために1件は残す)。
   */
  async compactTrip(tripId) {
    const list = await this.listSnapshots(tripId);
    await this._deleteIds(list.slice(1).map((m) => m.id));
  }

  /** 保存されている旅の一覧(旅ごとに最新の1件。中身つき)。全件ではなく、旅ごとの最新だけを読む。 */
  async listTrips() {
    const latestByTrip = new Map();
    for (const m of [...(await this._metaList())].sort(newestFirst)) {
      if (!latestByTrip.has(m.tripId)) latestByTrip.set(m.tripId, m);
    }
    const rows = await Promise.all([...latestByTrip.values()].map((m) => this.backend.get(m.id)));
    return rows.filter(Boolean);
  }

  /** 旅のスナップショットを全部消す。 */
  async deleteTrip(tripId) {
    await this._deleteIds((await this.listSnapshots(tripId)).map((m) => m.id));
  }
}

/** テスト用・IndexedDB が使えないとき用の、メモリだけの backend。 */
export function createMemoryBackend() {
  const rows = new Map();
  let nextId = 1;
  return {
    async put(row) {
      const id = nextId++;
      rows.set(id, { ...row, id });
      return id;
    },
    async getAll() {
      return [...rows.values()].map((r) => ({ ...r }));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : undefined;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

/** IndexedDB の backend。ブラウザでのみ使える。 */
export function createIdbBackend(idb = globalThis.indexedDB) {
  let dbPromise = null;
  const open = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const st = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          st.createIndex('tripId', 'tripId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  };
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  return {
    put: (row) => run('readwrite', (st) => st.add(row)),
    getAll: () => run('readonly', (st) => st.getAll()),
    get: (id) => run('readonly', (st) => st.get(id)),
    delete: (id) => run('readwrite', (st) => st.delete(id)),
  };
}

/**
 * ブラウザに、この端末の保存データを容量不足などで勝手に消さないよう頼む(旅を始めるときに呼ぶ)。
 * 対応していない・断られたときは何もしない(書き出しを勧める表示はそのまま)。
 * @returns {Promise<boolean>} 保護されたか
 */
export async function requestPersistentStorage(storage = globalThis.navigator?.storage) {
  try {
    if (!storage?.persist) return false;
    if (await storage.persisted?.()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
