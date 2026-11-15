// 走行履歴を保存するIndexedDBラッパー。
// 要件定義書6章「IndexedDB/localStorageに走行履歴を保存」に対応。
// クラウド同期なし、端末・ブラウザ単位。スキーマ変更は必要になった時点で個別対応する方針。
// バージョン2で GPX から読み込んだ実在コースのストア(courses)を追加した。
// 既存の rides はそのまま残る(無いストアだけを作る)。
// 旧バージョンを開いたままの別タブがあると更新が保留(blocked)になり、Promise が永久に
// 返らなくなる(走行記録の保存も止まる)ため、blocked はエラーにし、こちらの接続は
// 別タブの更新要求(versionchange)で閉じるようにしている。

// バージョン3で走行記録を要約(rides)と毎秒のサンプル(rideSamples)に分け(レビュー Q10。合計距離や一覧は
// 要約だけ読めば済むように)、走行中の下書き(rideDraft。レビュー Q1)を足した。v2 までの記録は
// 更新のときにサンプルを rideSamples へ移す(rides には要約だけが残る。rideRecord.js)。
//
// 接続は1つを使い回す(以前は呼ぶたびに開いて閉じなかった)。書き込みはトランザクションの完了
// (oncomplete)を待ってから返す(要求の成功だけでは、ディスクへ書けたとは限らない)。

import { splitRecord, joinRecord } from './rideRecord.js';
import { workKjFromSamples } from '../utils/gourmet.js';

const DB_NAME = 'PandaCycleTrainerDB';
const DB_VERSION = 3;
const STORE_NAME = 'rides';
const SAMPLE_STORE = 'rideSamples';
const COURSE_STORE = 'courses';
const DRAFT_STORE = 'rideDraft';
const DRAFT_KEY = 'current';

let dbPromise = null;
/** 開いている接続(開き終わってから閉じるまで)。 */
let openHandle = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('startTime', 'startTime', { unique: false });
      }
      if (!db.objectStoreNames.contains(COURSE_STORE)) {
        db.createObjectStore(COURSE_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
      if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
        db.createObjectStore(SAMPLE_STORE);
        // v2 までの記録: サンプルを rideSamples へ移し、rides には要約だけを残す
        if (ev.oldVersion > 0) migrateSamples(tx);
      }
    };
    req.onblocked = () => reject(new Error('別のタブで PandaCycleTrainer が開いています。他のタブを閉じてから再読み込みしてください。'));
    req.onsuccess = () => {
      const db = req.result;
      openHandle = db;
      // 別のタブが新しい版で開こうとしたら閉じて譲る。閉じた接続は次の呼び出しで開き直す
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        openHandle = null;
      };
      db.onclose = () => {
        dbPromise = null;
        openHandle = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function migrateSamples(tx) {
  const rides = tx.objectStore(STORE_NAME);
  const samples = tx.objectStore(SAMPLE_STORE);
  rides.openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (!cursor) return;
    const rec = cursor.value;
    if (Array.isArray(rec.samples)) {
      const { summary, samples: list } = splitRecord(rec, workKjFromSamples);
      samples.put(list, rec.id);
      cursor.update(summary);
    }
    cursor.continue();
  };
}

/** 1つのトランザクションで fn(tx) を実行し、完了(oncomplete)したら fn の結果で解決する。 */
// 開いた接続があれば await を挟まずに使う(タブを閉じる直前の下書き保存を、イベントの中で同期的に始めるため)
async function withTx(stores, mode, fn) {
  const db = openHandle ?? (await openDb());
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    try {
      result = fn(tx);
    } catch (err) {
      tx.abort();
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました。'));
  });
}

/** 走行記録(samples 付き)を保存し、id を返す。要約とサンプルは同じトランザクションで書く。 */
export async function saveRide(record) {
  const { summary, samples } = splitRecord(record);
  return withTx([STORE_NAME, SAMPLE_STORE], 'readwrite', (tx) => {
    let id = null;
    const req = tx.objectStore(STORE_NAME).add(summary);
    req.onsuccess = () => {
      id = req.result;
      tx.objectStore(SAMPLE_STORE).put(samples, id);
    };
    return () => id;
  });
}

/** 走行記録の要約(サンプルなし。新しい順)。合計距離・一覧・自己ベストの判定に使う。 */
export async function getRideSummaries() {
  return withTx(STORE_NAME, 'readonly', (tx) => {
    let rides = [];
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      rides = req.result ?? [];
      rides.sort((a, b) => b.startTime - a.startTime);
    };
    return () => rides;
  });
}

/** 走行記録1件をサンプルごと(TCX の書き出し・ゴースト用)。無ければ null。 */
export async function getRide(id) {
  return withTx([STORE_NAME, SAMPLE_STORE], 'readonly', (tx) => {
    let summary = null;
    let samples = null;
    tx.objectStore(STORE_NAME).get(id).onsuccess = (e) => {
      summary = e.target.result ?? null;
    };
    tx.objectStore(SAMPLE_STORE).get(id).onsuccess = (e) => {
      samples = e.target.result ?? null;
    };
    // 移す前の形(rides に samples が残っている)でも読めるように
    return () => (summary && Array.isArray(summary.samples) ? summary : joinRecord(summary, samples));
  });
}

export async function deleteRide(id) {
  return withTx([STORE_NAME, SAMPLE_STORE], 'readwrite', (tx) => {
    tx.objectStore(STORE_NAME).delete(id);
    tx.objectStore(SAMPLE_STORE).delete(id);
  });
}

// ---- 走行中の下書き(レビュー Q1) ----
// 走行中は一定間隔で、そこまでの記録(samples 付き)を1件だけ下書きとして上書きする。
// 正常に終了して保存したら消す。タブのクラッシュ・再読み込みで残った下書きは、次に開いたときに
// 「前回の走行を保存しますか」と出して記録にできる(App.js)。

/** 下書きを上書き保存する。 */
export async function saveRideDraft(record) {
  return withTx(DRAFT_STORE, 'readwrite', (tx) => {
    tx.objectStore(DRAFT_STORE).put({ savedAt: Date.now(), record }, DRAFT_KEY);
  });
}

/** 残っている下書き({ savedAt, record })。無ければ null。 */
export async function loadRideDraft() {
  return withTx(DRAFT_STORE, 'readonly', (tx) => {
    let v = null;
    tx.objectStore(DRAFT_STORE).get(DRAFT_KEY).onsuccess = (e) => {
      v = e.target.result ?? null;
    };
    return () => v;
  });
}

export async function clearRideDraft() {
  return withTx(DRAFT_STORE, 'readwrite', (tx) => {
    tx.objectStore(DRAFT_STORE).delete(DRAFT_KEY);
  });
}

/** ブラウザに保存データを消さないよう頼む(断られても動く。レビュー F6 の一部)。 */
export function requestPersistentStorage() {
  try {
    return navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

// ---- GPX から読み込んだ実在コース ----
// レコード: { id, name, fileName, importedAt, profile, stats }
// profile は realCourse.js の buildRealCourse() の結果(座標は持たない。勾配と見た目用の curve のみ)。
// profile.id は保存時に採番した id から 'gpx-<id>' にする(走行記録の courseId・自己ベストのゴーストに使う)。

/** 実在コースを保存し、profile.id を確定させたレコードを返す。 */
export async function saveCourse({ name, fileName, profile, stats }) {
  const db = await openDb();
  const base = { name, fileName: fileName ?? null, importedAt: Date.now(), stats };
  // 採番(add)と profile.id の確定(put)を同じトランザクションで行う(途中で失敗しても id の無いレコードを残さない)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_STORE, 'readwrite');
    const store = tx.objectStore(COURSE_STORE);
    let record = null;
    const req = store.add({ ...base, profile });
    req.onsuccess = () => {
      const id = req.result;
      record = { ...base, id, profile: { ...profile, id: courseProfileId(id), name } };
      store.put(record);
    };
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました。'));
  });
}

/** 保存済みの実在コース(読み込みが新しい順)。 */
export async function getAllCourses() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_STORE, 'readonly');
    const req = tx.objectStore(COURSE_STORE).getAll();
    req.onsuccess = () => {
      const list = req.result ?? [];
      list.sort((a, b) => b.importedAt - a.importedAt);
      resolve(list);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 実在コースの景色(profile.scenery)を変更して保存し、更新後のレコードを返す。 */
export async function updateCourseScenery(id, scenery) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_STORE, 'readwrite');
    const store = tx.objectStore(COURSE_STORE);
    let record = null;
    const req = store.get(id);
    req.onsuccess = () => {
      if (!req.result) return;
      record = { ...req.result, profile: { ...req.result.profile, scenery } };
      store.put(record);
    };
    tx.oncomplete = () => (record ? resolve(record) : reject(new Error('コースが見つかりません。')));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました。'));
  });
}

export async function deleteCourse(id) {
  return withTx(COURSE_STORE, 'readwrite', (tx) => {
    tx.objectStore(COURSE_STORE).delete(id);
  });
}

export function courseProfileId(id) {
  return `gpx-${id}`;
}
