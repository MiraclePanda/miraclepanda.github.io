// 旅人の手帳: コースごとに別々の旅を、まとめて振り返る(走った距離の累計・日本一周の進み具合・スタンプ帳・
// 道連れの話の続き)。純粋関数のみ。新しい記録は持たず、保存に残っている旅(旅ごとの最新)から求める。
//
// 旅はコースごとに別々のまま(コースを切り替えると、そのコースの旅の体力・所持金・荷物に戻る)。手帳は
// それを横に並べて足し合わせるだけなので、どのコースから走っても、走った分はここに積み上がっていく。

import { courseChoices } from './network.js';
import { courseProgress, tripCourseId } from './courseProgress.js';
import { allStamps } from './stamps.js';
import { COMPANIONS } from './companion.js';

/**
 * 道連れの話の進み具合を、いくつもの旅でまとめる(章はいちばん進んだもの、会った回数は合計)。
 * 新しい旅を始めるとき・旅を切り替えるときに、その旅の companions にする(別のコースの旅でも話の続きから)。
 * @param {object[]} trips
 * @returns {Record<string, {chapter:number, met:number}>}
 */
export function mergedCompanions(trips) {
  const out = {};
  for (const t of trips) {
    for (const [id, c] of Object.entries(t?.companions ?? {})) {
      const prev = out[id] ?? { chapter: 0, met: 0 };
      out[id] = { chapter: Math.max(prev.chapter, c.chapter ?? 0), met: prev.met + (c.met ?? 0) };
    }
  }
  return out;
}

/**
 * 旅の companions を、ほかの旅で進んだ話の続きにそろえる(会った回数はその旅のまま)。
 * @returns {object} 変わらなければ元の旅
 */
export function withCompanionsFrom(trip, trips) {
  const merged = mergedCompanions(trips);
  const own = trip.companions ?? {};
  let changed = false;
  const next = { ...own };
  for (const [id, c] of Object.entries(merged)) {
    const mine = own[id] ?? { chapter: 0, met: 0 };
    if (c.chapter > mine.chapter) {
      next[id] = { ...mine, chapter: c.chapter };
      changed = true;
    }
  }
  return changed ? { ...trip, companions: next } : trip;
}

/** 旅で走った距離(m)。電車・船で移った分と、救護で運ばれた分は入らない(旅の累積距離 totalM と同じ)。 */
function tripDistanceM(trip) {
  return Math.max(0, trip?.position?.totalM ?? 0);
}

/** 旅でデモ(トレーナーなし)で走った距離(m)。 */
function tripDemoM(trip) {
  return (trip?.legs ?? []).reduce((a, l) => a + (l.demoM ?? 0), 0);
}

/**
 * 旅人の手帳の中身。
 * @param {object[]} trips 保存に残っている旅(旅ごとの最新)。今開いている旅も含める
 */
export function travelerJournal(trips) {
  const list = trips.filter(Boolean);
  const courses = courseChoices();
  const progress = courseProgress(list);
  const main = courses.filter((c) => !c.side);
  const mainM = main.reduce((a, c) => a + c.lengthM, 0);
  const mainDoneM = main.reduce((a, c) => a + Math.min(c.lengthM, progress.get(c.segmentId)?.bestM ?? 0), 0);
  // スタンプ: 同じスタンプはいちばん早く押した旅のものを残す
  const stamps = new Map();
  for (const t of list) {
    const course = tripCourseId(t);
    for (const s of t.stamps ?? []) {
      const prev = stamps.get(s.id);
      if (!prev || (t.createdAt ?? 0) < prev.createdAt) stamps.set(s.id, { ...s, course, createdAt: t.createdAt ?? 0 });
    }
  }
  const { sights, foods } = allStamps();
  const got = (m) => [...m.keys()].filter((id) => stamps.has(id)).length;
  const companions = mergedCompanions(list);
  return {
    trips: list.length,
    // 旅の日数: 日誌に残った日 + 走行の途中の日
    days: list.reduce((a, t) => a + (t.log?.length ?? 0) + (t.ride ? 1 : 0), 0),
    distanceM: list.reduce((a, t) => a + tripDistanceM(t), 0),
    demoM: list.reduce((a, t) => a + tripDemoM(t), 0),
    elevationGainM: list.reduce((a, t) => a + (t.log ?? []).reduce((b, d) => b + (d.elevationGainM ?? 0), 0) + (t.ride?.elevationGainM ?? 0), 0),
    courses: {
      total: courses.length,
      done: courses.filter((c) => progress.get(c.segmentId)?.done).length,
      partial: courses.filter((c) => progress.get(c.segmentId) && !progress.get(c.segmentId).done).length,
    },
    // 日本一周の道筋(寄り道を除いた本線)のうち、走ったことのある長さ
    mainLine: { doneM: mainDoneM, totalM: mainM },
    stamps: {
      list: [...stamps.values()].sort((a, b) => a.createdAt - b.createdAt || a.day - b.day),
      sights: { got: got(sights), total: sights.size },
      foods: { got: got(foods), total: foods.size },
    },
    companions: COMPANIONS.filter((c) => companions[c.id]).map((c) => ({
      id: c.id, name: c.name, who: c.who, met: companions[c.id].met,
      chapter: Math.min(companions[c.id].chapter, c.chapters.length), chapters: c.chapters.length,
    })),
  };
}

/**
 * 前の旅を引き継いで新しいコースの旅を始める: 所持金・荷物(食料も)・スタンプ帳・道連れの話を持っていき、
 * 日数は前の旅の続き(翌朝)から数える。体力・満腹度は朝の値(新しい旅の初期値)のまま。前の旅はそのまま残る。
 * @param {object} fresh createTrip で作った新しい旅
 * @param {object} prev 引き継ぐ旅
 */
export function inheritTrip(fresh, prev) {
  if (!prev) return fresh;
  return {
    ...fresh,
    day: prev.day + (prev.ride ? 1 : 0),
    wallet: { yen: prev.wallet.yen },
    bike: { ...fresh.bike, pack: { ...prev.bike.pack } },
    stamps: [...(prev.stamps ?? [])],
    companions: { ...(prev.companions ?? {}) },
    inheritedFrom: { tripId: prev.tripId, course: tripCourseId(prev), day: prev.day },
  };
}
