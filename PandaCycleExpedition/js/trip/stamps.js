// スタンプ帳: 見どころに立ち寄ったり、名物を食べたりすると記録が残る。表示と旅の楽しみだけで、物理・トレーナーには関係しない。純粋関数のみ。
//
// 旅の状態の stamps: [{ id, kind: 'sight'|'food', name, place?, day, atTotalM }](無い古いデータは空とみなす)。
// 見どころの id は区間の地点の id(逆向きの区間でも同じ)、名物は 'food:' + 料理名。

import { SEGMENTS } from '../data/segments/index.js';
import { passTripTime } from '../storage/tripState.js';

/** 見どころに立ち寄るのにかかる旅の時間(分)。 */
export const SIGHT_VISIT_MINUTES = 15;

/** スタンプを押す(同じ id は1回だけ)。押せたかどうかも返す。 */
export function addStamp(trip, { id, kind, name, place }) {
  const stamps = trip.stamps ?? [];
  if (stamps.some((s) => s.id === id)) return { trip, added: false };
  const s = { id, kind, name, day: trip.day, atTotalM: Math.round(trip.position.totalM) };
  if (place) s.place = place;
  return { trip: { ...trip, stamps: [...stamps, s] }, added: true };
}

/** 見どころに立ち寄る: 旅の時間が少し過ぎ、スタンプを押す。 */
export function visitSight(trip, place) {
  const t = passTripTime(trip, SIGHT_VISIT_MINUTES);
  return addStamp(t, { id: place.id, kind: 'sight', name: place.name });
}

/** 名物を食べたスタンプ。 */
export function stampFood(trip, place, item) {
  return addStamp(trip, { id: `food:${item.name}`, kind: 'food', name: item.name, place: place.name });
}

/** 旅で集められるスタンプの全体(すべての区間の見どころと名物)。 */
export function allStamps() {
  const sights = new Map();
  const foods = new Map();
  for (const s of Object.values(SEGMENTS)) {
    for (const p of s.places ?? []) {
      if (p.kind === 'sight') sights.set(p.id, p.name);
      if (p.kind === 'food' || p.kind === 'shop') for (const m of p.menu ?? []) foods.set(`food:${m.name}`, m.name);
    }
  }
  return { sights, foods };
}

/** スタンプ帳の集まり具合。 */
export function stampProgress(trip) {
  const { sights, foods } = allStamps();
  const got = new Set((trip.stamps ?? []).map((s) => s.id));
  const count = (m) => [...m.keys()].filter((id) => got.has(id)).length;
  return { sights: { got: count(sights), total: sights.size }, foods: { got: count(foods), total: foods.size } };
}
