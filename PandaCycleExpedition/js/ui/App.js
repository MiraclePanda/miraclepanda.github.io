// 画面の切り替え: ホーム(開始・再開・書き出し/読み込み)→ 走行 → 1日の終わり(宿選び・日誌)→ ホーム。
// 旅の状態はここで持ち、保存は TripStore(IndexedDB。使えなければメモリ)に任せる。

import { h, useState, useEffect, useRef } from './h.js';
import { FtmsClient } from '../ble/ftmsClient.js';
import { TripStore, createIdbBackend, createMemoryBackend } from '../storage/tripStore.js';
import { getSegment, isSegmentLoaded, loadSegment } from '../trip/network.js';
import { HomeScreen } from './HomeScreen.js';
import { RideScreen } from './RideScreen.js';
import { DayEndScreen } from './DayEndScreen.js';

function createStore() {
  try {
    if (globalThis.indexedDB) return { store: new TripStore(createIdbBackend()), persistent: true };
  } catch { /* 下へ */ }
  return { store: new TripStore(createMemoryBackend()), persistent: false };
}

export function App() {
  const storeRef = useRef(null);
  storeRef.current ??= createStore();
  const clientRef = useRef(null);
  clientRef.current ??= new FtmsClient();
  const [trip, setTrip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [screen, setScreen] = useState({ name: 'home' });
  const [rideKey, setRideKey] = useState(0);
  const { store, persistent } = storeRef.current;

  useEffect(() => {
    store.latest().then((r) => {
      if (r) {
        setTrip(r.trip);
        if (r.skipped > 0) setNotice(`最新の保存データが壊れていたため、1つ前(${r.skipped}件前)から再開します。`);
      }
    }).catch((e) => setNotice(`保存データを読めませんでした: ${e.message}`)).finally(() => setLoading(false));
  }, []);

  // 今いる区間の全データ(勾配・細かい地図)は、その区間に来たときに読む
  const segmentId = trip?.position.segmentId ?? null;
  const [segLoad, setSegLoad] = useState({ id: null, error: null, n: 0 });
  useEffect(() => {
    if (!segmentId || isSegmentLoaded(segmentId)) return;
    loadSegment(segmentId).then(() => setSegLoad((s) => ({ ...s, id: segmentId, error: null })))
      .catch((e) => setSegLoad((s) => ({ ...s, error: e.message })));
  }, [segmentId, segLoad.n]);
  const segment = segmentId && isSegmentLoaded(segmentId) ? getSegment(segmentId) : null;

  if (loading) return h('div', { className: 'page' }, h('p', null, '旅の記録を読み込み中...'));
  // 道のデータを読めないとき(通信できない・区間が無くなった)も、ホームは出す: 別のコースの旅への切り替えと、
  // この旅の書き出しはできるようにする(走ることだけができない)
  if (segmentId && !segment && !segLoad.error) {
    return h('div', { className: 'page' }, h('p', null, '道のデータを読み込み中...'));
  }
  const segmentError = segmentId && !segment
    ? { message: segLoad.error, retry: () => setSegLoad((s) => ({ ...s, error: null, n: s.n + 1 })) }
    : null;

  if (screen.name === 'ride' && trip && segment) {
    return h(RideScreen, {
      key: rideKey,
      trip, segment, store, client: clientRef.current, demo: screen.demo,
      onEnd: (t, reason) => {
        setTrip(t);
        // 分かれ道で次の区間を選んだ: その日の走行を続けたまま、新しい区間で走行画面を作り直す
        if (reason === 'continue') { setRideKey((k) => k + 1); return; }
        setScreen(reason === 'exit' ? { name: 'home' } : { name: 'dayEnd', reason, demo: screen.demo });
      },
    });
  }
  if (screen.name === 'dayEnd' && trip && segment) {
    return h(DayEndScreen, {
      trip, segment, store, reason: screen.reason,
      onDone: (t, message) => { setTrip(t); if (message) setNotice(message); setScreen({ name: 'home' }); },
      onBackToRide: () => { setRideKey((k) => k + 1); setScreen({ name: 'ride', demo: screen.demo }); },
    });
  }
  return h(HomeScreen, {
    trip, segment, segmentError, store, persistent, notice, client: clientRef.current,
    onTripChange: (t) => { setTrip(t); setNotice(null); },
    onRide: (demo) => { setRideKey((k) => k + 1); setScreen({ name: 'ride', demo }); },
  });
}
