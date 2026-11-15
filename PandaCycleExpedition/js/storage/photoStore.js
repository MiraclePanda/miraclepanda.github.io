// 旅の写真帳: 見どころに立ち寄ったときに撮った景色の小さな写真(JPEG の data URL、1枚 10〜20 KB ほど)。
//
// 旅のセーブデータ(スナップショット)には入れない(30 秒ごとの自動保存が重くならないように)。旅とは別の
// IndexedDB のデータベースに、旅 × 見どころごとに1枚(撮り直したら新しい方)で置く。旅の書き出しには入らない。

export const PHOTO_DB_NAME = 'PandaCycleExpeditionPhotos';
export const PHOTO_DB_VERSION = 1;
const STORE = 'photos';

/** 写真1枚の鍵。 */
export function photoKey(tripId, placeId) {
  return `${tripId}:${placeId}`;
}

/**
 * 写真の窓口。backend は createIdbPhotoBackend() か createMemoryPhotoBackend()。
 * 写真: { key, tripId, placeId, name, day, takenAt, dataUrl }
 */
export class PhotoStore {
  constructor(backend) {
    this.backend = backend;
  }

  /** 写真を残す(同じ旅・同じ見どころは置き換え)。 */
  async put({ tripId, placeId, name, day, dataUrl }, now = Date.now()) {
    if (!tripId || !placeId || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    const row = { key: photoKey(tripId, placeId), tripId, placeId, name, day, takenAt: now, dataUrl };
    await this.backend.put(row);
    return row;
  }

  /** すべての写真(撮った順)。tripId を渡すとその旅の分だけ。 */
  async list(tripId = null) {
    const rows = await this.backend.getAll();
    return rows.filter((r) => !tripId || r.tripId === tripId).sort((a, b) => a.takenAt - b.takenAt);
  }
}

export function createMemoryPhotoBackend() {
  const rows = new Map();
  return {
    async put(row) { rows.set(row.key, { ...row }); },
    async getAll() { return [...rows.values()].map((r) => ({ ...r })); },
  };
}

export function createIdbPhotoBackend(idb = globalThis.indexedDB) {
  let dbPromise = null;
  const open = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const req = idb.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
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
    put: (row) => run('readwrite', (st) => st.put(row)),
    getAll: () => run('readonly', (st) => st.getAll()),
  };
}

let shared = null;
/** アプリで1つの写真の窓口(IndexedDB が使えなければメモリ)。 */
export function sharedPhotoStore() {
  if (shared) return shared;
  try {
    shared = new PhotoStore(globalThis.indexedDB ? createIdbPhotoBackend() : createMemoryPhotoBackend());
  } catch {
    shared = new PhotoStore(createMemoryPhotoBackend());
  }
  return shared;
}

/**
 * 景色の canvas から小さな写真を作る(描いた直後に呼ぶ。WebGL・WebGPU の canvas は次の描画までに消えるため)。
 * @returns {string|null} JPEG の data URL。作れなければ null
 */
export function captureThumbnail(canvas, width = 320, quality = 0.72) {
  try {
    if (!canvas || !canvas.width || !canvas.height) return null;
    const w = Math.min(width, canvas.width);
    const hgt = Math.round((w * canvas.height) / canvas.width);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hgt;
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0, w, hgt);
    const url = c.toDataURL('image/jpeg', quality);
    return url.startsWith('data:image/jpeg') ? url : null;
  } catch {
    return null;
  }
}
