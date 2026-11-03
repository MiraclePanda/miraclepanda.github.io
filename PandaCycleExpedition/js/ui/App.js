// 画面の切り替え: ホーム(開始・再開・書き出し/読み込み)→ 走行 → 1日の終わり(宿選び・日誌)→ ホーム。
// 旅の状態はここで持ち、保存は TripStore(IndexedDB。使えなければメモリ)に任せる。

import { h, useState, useEffect, useRef } from './h.js';
import { FtmsClient } from '../ble/ftmsClient.js';
import { TripStore, createIdbBackend, createMemoryBackend } from '../storage/tripStore.js';
import { getSegment } from '../data/segments/index.js';
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

  const segment = trip ? getSegment(trip.position.segmentId) : null;

  if (loading) return h('div', { className: 'page' }, h('p', null, '旅の記録を読み込み中...'));

  if (screen.name === 'ride' && trip && segment) {
    return h(RideScreen, {
      key: rideKey,
      trip, segment, store, client: clientRef.current, demo: screen.demo,
      onEnd: (t, reason) => { setTrip(t); setScreen(reason === 'exit' ? { name: 'home' } : { name: 'dayEnd', reason, demo: screen.demo }); },
    });
  }
  if (screen.name === 'dayEnd' && trip && segment) {
    return h(DayEndScreen, {
      trip, segment, store, reason: screen.reason,
      onDone: (t) => { setTrip(t); setScreen({ name: 'home' }); },
      onBackToRide: () => { setRideKey((k) => k + 1); setScreen({ name: 'ride', demo: screen.demo }); },
    });
  }
  return h(HomeScreen, {
    trip, segment, store, persistent, notice, client: clientRef.current,
    onTripChange: (t) => { setTrip(t); setNotice(null); },
    onRide: (demo) => { setRideKey((k) => k + 1); setScreen({ name: 'ride', demo }); },
  });
}
