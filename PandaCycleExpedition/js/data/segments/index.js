// 区間データの一覧と、区間をつなぐ町(ノード)。旅の位置(position.segmentId)からひく。
// 区間は from → to の向きで生成してあり、逆向きにも走れる(js/trip/network.js が向きを反転した区間を作る)。
import { ATAMI_ITO } from './atamiIto.js';
import { ITO_SHIMODA } from './itoShimoda.js';
import { SHIMODA_TOI } from './shimodaToi.js';
import { SHIMIZU_MIHO } from './shimizuMiho.js';

export const SEGMENTS = {
  [ATAMI_ITO.id]: ATAMI_ITO,
  [ITO_SHIMODA.id]: ITO_SHIMODA,
  [SHIMODA_TOI.id]: SHIMODA_TOI,
  [SHIMIZU_MIHO.id]: SHIMIZU_MIHO,
};

/**
 * 区間の端になる町。name は案内に出す名前、lodging はその町の宿(どちら向きの区間で着いても泊まれるように、
 * 区間の地点とは別に町が持つ。名前は旅の演出で、実在の宿ではない)。
 */
export const NODES = {
  atami: { name: '熱海', lodging: [
    { kind: 'hotel', name: '熱海の温泉ホテル', yen: 12000 }, { kind: 'guesthouse', name: '熱海のゲストハウス', yen: 4500 }] },
  ito: { name: '伊東', lodging: [
    { kind: 'hotel', name: '伊東の温泉旅館', yen: 9800 }, { kind: 'guesthouse', name: '伊東のゲストハウス', yen: 4500 }] },
  shimoda: { name: '下田', lodging: [
    { kind: 'hotel', name: '下田の温泉旅館', yen: 10500 }, { kind: 'guesthouse', name: '下田のゲストハウス', yen: 4800 }] },
  toi: { name: '土肥', lodging: [
    { kind: 'hotel', name: '土肥の温泉旅館', yen: 10000 }, { kind: 'guesthouse', name: '土肥のゲストハウス', yen: 5000 }] },
  // ここから静岡(駿河湾の向こう側)。次の地方へは清水から区間を足していく
  shimizu: { name: '清水', lodging: [
    { kind: 'hotel', name: '清水港のホテル', yen: 8500 }, { kind: 'guesthouse', name: '清水のゲストハウス', yen: 4200 }] },
  miho: { name: '三保の松原', lodging: [
    { kind: 'guesthouse', name: '三保の民宿', yen: 6000 }, { kind: 'campsite', name: '三保のキャンプ場', yen: 1500 }] },
};

/**
 * 走らずに町から町へ移る手段(輪行=自転車を袋に入れて電車に乗る、フェリー)。どちら向きにも使える。
 * minutes は旅の時間、yen は自転車の分も含めた運賃(旅の演出の目安で、実際の時刻表・運賃ではない)。
 */
export const TRANSFERS = [
  { id: 'jr-ito', kind: 'train', name: 'JR伊東線(輪行)', a: 'atami', b: 'ito', minutes: 25, yen: 330 },
  { id: 'izukyu', kind: 'train', name: '伊豆急行(輪行)', a: 'ito', b: 'shimoda', minutes: 65, yen: 1700 },
  { id: 'suruga-ferry', kind: 'ferry', name: '駿河湾のフェリー', a: 'toi', b: 'shimizu', minutes: 75, yen: 3200 },
];
