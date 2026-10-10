// 走行履歴を保存するIndexedDBラッパー。
// 要件定義書6章「IndexedDB/localStorageに走行履歴を保存」に対応。
// クラウド同期なし、端末・ブラウザ単位。スキーマ変更は必要になった時点で個別対応する方針。
// バージョン2で GPX から読み込んだ実在コースのストア(courses)を追加した。
// 既存の rides はそのまま残る(無いストアだけを作る)。
// 旧バージョンを開いたままの別タブがあると更新が保留(blocked)になり、Promise が永久に
// 返らなくなる(走行記録の保存も止まる)ため、blocked はエラーにし、こちらの接続は
// 別タブの更新要求(versionchange)で閉じるようにしている。

const DB_NAME = 'PandaCycleTrainerDB';
const DB_VERSION = 2;
const STORE_NAME = 'rides';
const COURSE_STORE = 'courses';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('startTime', 'startTime', { unique: false });
      }
      if (!db.objectStoreNames.contains(COURSE_STORE)) {
        db.createObjectStore(COURSE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onblocked = () => reject(new Error('別のタブで PandaCycleTrainer が開いています。他のタブを閉じてから再読み込みしてください。'));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveRide(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllRides() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => {
      const rides = req.result ?? [];
      rides.sort((a, b) => b.startTime - a.startTime);
      resolve(rides);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getRide(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRide(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
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
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_STORE, 'readwrite');
    const req = tx.objectStore(COURSE_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function courseProfileId(id) {
  return `gpx-${id}`;
}
