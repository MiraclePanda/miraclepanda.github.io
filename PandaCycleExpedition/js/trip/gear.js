// 装備と買い物: 町でテント・寝袋・雨具を家へ送ったり買ったり、食料を買い足したりする。純粋関数のみ。
//
// 荷物の重さは物理の質量に入る(設計書3章)ので、軽くして速く走るか、テント泊できる装備で安く旅するかを選べる。
// テントが無いと公園・キャンプ場に泊まれず(dayEvents.lodgingOptions)、雨具が無いと雨で体力が早く減る(body.stepBody)。

import { DEFAULT_PACK } from '../physics/surfaces.js';
import { NODES } from '../data/segments/index.js';
import { canAfford } from './dayEvents.js';

/**
 * 送ったり買ったりできる装備。kg は買ったときの重さ。
 * effect = 持っているとできること、without = 持っていないとどうなるか(画面の説明と確認ダイアログに使う)。
 */
export const GEAR = {
  tent: {
    label: 'テント', kg: DEFAULT_PACK.tent, buyYen: 15000, shipYen: 1500,
    effect: '公園・キャンプ場に泊まれる', without: '公園・キャンプ場に泊まれず、宿は有料の宿か野宿だけになります',
  },
  sleepingBag: {
    label: '寝袋', kg: DEFAULT_PACK.sleepingBag, buyYen: 9000, shipYen: 1200,
    effect: 'テント泊でよく眠れる', without: 'テント泊で寒くてよく眠れず、体力の回復が半分になります',
  },
  rainwear: {
    label: '雨具', kg: DEFAULT_PACK.rainwear, buyYen: 5000, shipYen: 800,
    effect: '雨の中でも疲れにくい', without: '雨やスコールの中で体が冷えて、体力が早く減ります',
  },
};

/** 食料の値段(1 kg あたり)と、積める上限(kg)。 */
export const FOOD = { yenPerKg: 1200, stepKg: 0.5, maxKg: 4 };

/** 店のある町にいるか(区間の町・店の地点か、区間の端の町の近く)。 */
export const SHOP_RANGE_M = 1500;
export function atTown(segment, m) {
  const near = (segment.places ?? []).some((p) => (p.kind === 'town' || p.kind === 'shop') && Math.abs(p.atM - m) <= SHOP_RANGE_M);
  const end = (m <= SHOP_RANGE_M && NODES[segment.from]) || (segment.lengthM - m <= SHOP_RANGE_M && NODES[segment.to]);
  return near || !!end;
}

const has = (trip, key) => (trip.bike.pack[key] ?? 0) > 0;
const withPack = (trip, patch, yen) => ({
  ...trip,
  bike: { ...trip.bike, pack: { ...trip.bike.pack, ...patch } },
  wallet: { yen: trip.wallet.yen - yen },
});

/** 装備ごとにできること(UI 用)。 */
export function gearOptions(trip) {
  return Object.entries(GEAR).map(([key, g]) => {
    const owned = has(trip, key);
    const yen = owned ? g.shipYen : g.buyYen;
    return { key, ...g, owned, yen, action: owned ? 'ship' : 'buy', affordable: canAfford(trip, yen) };
  });
}

/** 装備を家へ送る(荷物が軽くなる)。できなければ元の旅を返す。 */
export function shipHome(trip, key) {
  const g = GEAR[key];
  if (!g || !has(trip, key) || !canAfford(trip, g.shipYen)) return trip;
  return withPack(trip, { [key]: 0 }, g.shipYen);
}

/** 装備を買う。 */
export function buyGear(trip, key) {
  const g = GEAR[key];
  if (!g || has(trip, key) || !canAfford(trip, g.buyYen)) return trip;
  return withPack(trip, { [key]: g.kg }, g.buyYen);
}

/** 送る・買う前の確認文。送った装備は旅の途中では戻らず、買い直すしかないことを伝える。 */
export function gearConfirmText(trip, key) {
  const g = GEAR[key];
  if (!g) return '';
  if (has(trip, key)) {
    return `${g.label}を家へ送りますか?\n`
      + `送料 ${g.shipYen.toLocaleString()} 円で、荷物が ${g.kg} kg 軽くなります。\n`
      + `送ると${g.without}。\n`
      + `旅の途中では戻ってこないので、また使うときは ${g.buyYen.toLocaleString()} 円で買い直します。`;
  }
  return `${g.label}を買いますか?\n`
    + `${g.buyYen.toLocaleString()} 円で、荷物が ${g.kg} kg 重くなります(${g.effect}ようになります)。`;
}

/** 食料を stepKg だけ買い足す(上限まで)。 */
export function buyFood(trip) {
  const food = trip.bike.pack.food ?? 0;
  const kg = Math.min(FOOD.stepKg, FOOD.maxKg - food);
  const yen = Math.round(kg * FOOD.yenPerKg);
  if (kg <= 1e-9 || !canAfford(trip, yen)) return trip;
  return withPack(trip, { food: Math.round((food + kg) * 1000) / 1000 }, yen);
}

/** 雨具なしで雨・スコールの中を走っているか(体力が早く減る)。 */
export function soaked(trip, weatherKind) {
  return (weatherKind === 'rain' || weatherKind === 'squall') && !has(trip, 'rainwear');
}
