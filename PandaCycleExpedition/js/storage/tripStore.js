// 旅のスナップショットの保存と世代管理(設計書5章)。
//
// 保存先は IndexedDB `PandaCycleExpeditionDB`(Trainer とは別)の `snapshots` ストア。
// 1件 = { id(自動採番), tripId, kind, day, savedAt, data(旅の状態そのもの) }。
// kind: 'auto'(30秒ごと)/'event'(出来事の後)/'rideEnd'(ライド終了)/'dayEnd'(その日の終わり)/'import'(読み込み)。
// 残すもの: 旅ごとに直近 KEEP_RECENT 件 + 各日の最後の 'dayEnd'。壊れていたら1つ前から再開できる。
//
// IndexedDB の部分は薄い backend({ getAll, put, delete })に閉じ込め、世代の選び方などは純粋関数にしてある
// (Node のテストでは createMemoryBackend() を使う)。

import { migrateTrip } from './tripState.js';

export const DB_NAME = 'PandaCycleExpeditionDB';
export const DB_VERSION = 1;
export const STORE = 'snapshots';
export const KEEP_RECENT = 5;

/**
 * 消してよいスナップショットの id を選ぶ(純粋関数)。
 * 旅ごとに、新しい順の KEEP_RECENT 件と、各日の最後の dayEnd を残す。
 */
export function selectPrunable(snapshots, keepRecent = KEEP_RECENT) {
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
      if (s.kind === 'dayEnd' && !lastDayEnd.has(s.day)) lastDayEnd.set(s.day, s.id);
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

/** 旅の保存の窓口。backend は createIdbBackend() か createMemoryBackend()。 */
export class TripStore {
  constructor(backend) {
    this.backend = backend;
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
    const id = await this.backend.put(snapshot);
    const all = await this.backend.getAll();
    for (const old of selectPrunable(all)) await this.backend.delete(old);
    return id;
  }

  /** 起動時の再開: いちばん新しい読めるスナップショット(なければ null)。 */
  async latest(tripId) {
    return pickResume(await this.backend.getAll(), tripId);
  }

  /** 保存されている旅の一覧(旅ごとに最新の1件)。 */
  async listTrips() {
    const latestByTrip = new Map();
    for (const s of (await this.backend.getAll()).sort(newestFirst)) {
      if (!latestByTrip.has(s.tripId)) latestByTrip.set(s.tripId, s);
    }
    return [...latestByTrip.values()];
  }

  /** 旅のスナップショットを全部消す。 */
  async deleteTrip(tripId) {
    for (const s of await this.backend.getAll()) {
      if (s.tripId === tripId) await this.backend.delete(s.id);
    }
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
    delete: (id) => run('readwrite', (st) => st.delete(id)),
  };
}
