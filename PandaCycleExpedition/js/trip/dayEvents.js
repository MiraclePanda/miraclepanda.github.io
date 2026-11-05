// 1日の出来事: 天気、出会い、食事、宿、失敗のあとの救護(設計書4章)。純粋関数のみ。
//
// 出来事は旅の ID・日・場所から seed で決める(同じ旅の同じ日・同じ場所なら同じ出来事)。
// 区間の地点(places)の kind ごとの中身:
//   food / shop: { menu: [{ name, yen, satiety }] }
//   lodging:     { options: [{ kind: 'hotel'|'guesthouse'|'campsite'|'park', name, yen }] }
//   encounter:   { text, gift?: { name, satiety } }
//   sight:       { text }
//   town:        (救護で運ばれる先)

import { NODES } from '../data/catalog.js';
import { routesFrom, segmentSummary } from './network.js';
import { SURFACES } from '../physics/surfaces.js';
import { PhysicsConstants } from '../physics/physicsConstants.js';
import { nearestPlace } from '../physics/segmentRoute.js';
import { addRideEvent, endDay, passTripTime } from '../storage/tripState.js';
import { clamp100 } from './body.js';

// ---- seed ----

/** 文字列から 32bit の seed。 */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** seed から [0,1) の乱数列。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 天気 ----

export const WEATHER_LABELS = { sunny: '晴れ', cloudy: 'くもり', rain: '雨', squall: 'スコール' };

/**
 * その日の天気予報: 基本の天気と、スコールの時間帯(旅の時刻、分)。
 * @returns {{base:'sunny'|'cloudy'|'rain', squalls:{fromMin:number,toMin:number}[]}}
 */
export function forecastDay(tripId, day) {
  const rnd = mulberry32(hashSeed(`${tripId}:weather:${day}`));
  const r = rnd();
  const base = r < 0.5 ? 'sunny' : r < 0.82 ? 'cloudy' : 'rain';
  const squalls = [];
  const chance = base === 'sunny' ? 0.25 : base === 'cloudy' ? 0.45 : 0.3;
  if (rnd() < chance) {
    const fromMin = Math.round(8 * 60 + rnd() * 8 * 60); // 8:00〜16:00
    squalls.push({ fromMin, toMin: fromMin + 20 + Math.round(rnd() * 25) });
  }
  return { base, squalls };
}

/** 天気予報の一言(例: "くもり、13:20ごろスコール")。 */
export function forecastText(forecast) {
  const base = WEATHER_LABELS[forecast.base];
  if (forecast.squalls.length === 0) return base;
  const s = forecast.squalls[0].fromMin;
  return `${base}、${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}ごろスコール`;
}

/** 旅の時刻 minutes の天気と、物理に渡す条件。スコールの後1時間は路面が濡れたまま。 */
export function weatherAt(forecast, minutes) {
  const sq = forecast.squalls.find((s) => minutes >= s.fromMin && minutes < s.toMin);
  if (sq) return { kind: 'squall', wet: true, headwindMps: PhysicsConstants.SQUALL_HEADWIND_MPS };
  const after = forecast.squalls.some((s) => minutes >= s.toMin && minutes < s.toMin + 60);
  return { kind: forecast.base, wet: forecast.base === 'rain' || after, headwindMps: 0 };
}

// ---- 出会い ----

/** 道ばたの出会い(区間の決まった出会いに加えて、ところどころで起きる)。 */
export const ROADSIDE_ENCOUNTERS = [
  { text: '散歩中のおばあさん「その荷物でどこまで行くの?気をつけてね」' },
  { text: '軽トラのおじさん「この先はトンネルが続くから、ライトをつけてな」' },
  { text: '釣り帰りの人「今日は海が穏やかでいいね」' },
  { text: '地元の高校生が手を振ってくれた。' },
  { text: 'みかん農家さん「ひとつ持っていきな」', gift: { name: 'みかん', satiety: 6 } },
  { text: 'サイクリストとすれ違った。「グッドライド!」' },
  { text: '干物屋さん「試食していきなよ」', gift: { name: 'アジの干物の試食', satiety: 4 } },
];

/** 道の情報を教えてもらう地点: 区間の終点のこの距離手前から、300 m おきに。 */
export const ROAD_TIP_BEFORE_END_M = 2500;

/**
 * 区間の終点の町から先の道について、地元の人が教えてくれる話(分かれ道で選ぶ材料)。
 * 来た道を引き返す向きは除く。長さ・上りのきつさ・宿と店・未舗装の路面から決める。
 * @returns {{toName:string, segmentId:string, text:string}[]}
 */
export function roadTips(segment) {
  return routesFrom(segment.to, segment.id).filter((r) => !r.back).map((r) => {
    const s = segmentSummary(r.segment);
    const perKm = s.climbM / Math.max(1, s.lengthKm);
    const parts = [`${r.toName}へ行くなら ${Math.round(s.lengthKm)} km。`];
    parts.push(perKm > 25 ? '上りがきつい峠道だよ。' : perKm > 10 ? 'アップダウンが続くよ。' : 'ほとんど平らだよ。');
    parts.push(s.lodgings === 0 ? '途中に宿はないから、テントがあると安心だね。' : `途中に泊まれる所が ${s.lodgings} か所あるよ。`);
    if (s.foods === 0) parts.push('店がないから、食料を積んでいきな。');
    const unpaved = s.surfaces.filter((k) => SURFACES[k]?.unpaved).map((k) => SURFACES[k].label);
    if (unpaved.length) parts.push(`${unpaved.join('や')}があって、雨のあとは泥になるよ。`);
    if (s.tunnels >= 5) parts.push('トンネルが多いから、ライトをつけてな。');
    return { toName: r.toName, segmentId: r.segmentId, text: `地元の人「${parts.join('')}」` };
  });
}

/** 道ばたの出会いは 1km ごとにこの確率で起きる。 */
export const ROADSIDE_CHANCE_PER_KM = 0.3;

/**
 * その日の出会いの一覧(区間上の地点の昇順)。区間の encounter 地点と、seed で決まる道ばたの出会い。
 * @returns {{atM:number, text:string, gift?:{name:string, satiety:number}, id:string}[]}
 */
export function planEncounters(segment, tripId, day) {
  const out = [];
  for (const p of segment.places ?? []) {
    if (p.kind === 'encounter') out.push({ atM: p.atM, text: p.text, gift: p.gift, id: p.id });
  }
  const rnd = mulberry32(hashSeed(`${tripId}:encounter:${segment.id}:${day}`));
  for (let km = 1; km * 1000 < segment.lengthM; km++) {
    const hit = rnd() < ROADSIDE_CHANCE_PER_KM;
    const pick = Math.floor(rnd() * ROADSIDE_ENCOUNTERS.length);
    const offset = rnd() * 800;
    if (!hit) continue;
    const atM = km * 1000 + offset - 400;
    // 区間の決まった出会いのすぐ近くでは起こさない
    if (out.some((e) => Math.abs(e.atM - atM) < 300)) continue;
    out.push({ ...ROADSIDE_ENCOUNTERS[pick], atM, id: `roadside-${km}` });
  }
  // 終点が近づいたら、この先の分かれ道の話を聞く(区間の決まった出会いの近くと、ほかの出会いは避ける)
  const tips = roadTips(segment);
  tips.forEach((tip, i) => {
    const atM = Math.max(0, segment.lengthM - ROAD_TIP_BEFORE_END_M + i * 300);
    for (let k = out.length - 1; k >= 0; k--) if (Math.abs(out[k].atM - atM) < 250 && out[k].id.startsWith('roadside-')) out.splice(k, 1);
    out.push({ atM, text: tip.text, id: `tip-${tip.segmentId}`, tip: true });
  });
  return out.sort((a, b) => a.atM - b.atM);
}

/** 出会いを旅に記録する(差し入れがあれば満腹度が上がる)。 */
export function applyEncounter(trip, enc) {
  let t = addRideEvent(trip, 'encounters', { id: enc.id, text: enc.text, gift: enc.gift?.name });
  if (enc.gift) t = { ...t, rider: { ...t.rider, satiety: clamp100(t.rider.satiety + enc.gift.satiety) } };
  return t;
}

// ---- 食事 ----

/** 店で食べる時間(旅の分)。 */
export const MEAL_MINUTES = 30;
/** 荷物の補給食 1回分(kg)・満腹度・かかる時間(旅の分)。 */
export const SNACK = { kg: 0.25, satiety: 12, minutes: 5 };

/** その店で食べられるか(所持金)。 */
export function canAfford(trip, yen) {
  return trip.wallet.yen >= yen;
}

/** 店で食べる: 所持金が減り、満腹度が上がり、旅の時間が MEAL_MINUTES 進む。 */
export function eatMeal(trip, place, item) {
  if (!canAfford(trip, item.yen)) return trip;
  let t = addRideEvent(trip, 'meals', { place: place.name, name: item.name, yen: item.yen });
  t = passTripTime(t, MEAL_MINUTES);
  return {
    ...t,
    wallet: { yen: t.wallet.yen - item.yen },
    rider: { ...t.rider, satiety: clamp100(t.rider.satiety + item.satiety), zeroSatietyMinutes: 0 },
  };
}

/** 荷物の食料を食べる(食料が足りなければ何もしない)。荷物が軽くなる。 */
export function eatSnack(trip) {
  const food = trip.bike.pack.food ?? 0;
  if (food < SNACK.kg - 1e-9) return trip;
  let t = addRideEvent(trip, 'meals', { place: '道ばた', name: '補給食', yen: 0 });
  t = passTripTime(t, SNACK.minutes);
  return {
    ...t,
    bike: { ...t.bike, pack: { ...t.bike.pack, food: Math.round((food - SNACK.kg) * 1000) / 1000 } },
    rider: { ...t.rider, satiety: clamp100(t.rider.satiety + SNACK.satiety), zeroSatietyMinutes: 0 },
  };
}

// ---- 宿 ----

/** 宿の種類ごとの翌朝の回復。stamina は加算(hotel は全回復)、satiety は翌朝の値。 */
export const LODGING_EFFECTS = {
  hotel: { label: 'ホテル・旅館', staminaTo: 100, satiety: 90, needsTent: false },
  guesthouse: { label: 'ゲストハウス', staminaAdd: 60, satiety: 75, needsTent: false },
  campsite: { label: 'キャンプ場(テント)', staminaAdd: 45, needsTent: true },
  park: { label: '公園(テント)', staminaAdd: 35, needsTent: true },
  bivouac: { label: '野宿(テントなし)', staminaAdd: 10, needsTent: false },
  rescue: { label: '救護所', staminaTo: 40, satiety: 50, needsTent: false },
};
/** テント泊で荷物の食料を夕食・朝食にする量(kg)と、そのときの翌朝の満腹度。 */
export const CAMP_MEAL = { kg: 0.5, satiety: 70, hungrySatiety: 35 };
/** 宿を探せる範囲(今いる地点の前後、m)。 */
export const LODGING_RANGE_M = 1500;

const hasTent = (trip) => (trip.bike.pack.tent ?? 0) > 0;

/**
 * 今いる地点で選べる宿。区間の lodging 地点の近く(LODGING_RANGE_M)の宿と、テントがあれば公園、いつでも野宿。
 * @returns {{kind:string, name:string, yen:number, available:boolean, reason:string|null}[]}
 */
export function lodgingOptions(trip, segment, m) {
  const opts = [];
  const add = (o) => { if (!opts.some((x) => x.name === o.name)) opts.push(o); };
  for (const p of segment.places ?? []) {
    if (p.kind !== 'lodging' || Math.abs(p.atM - m) > LODGING_RANGE_M) continue;
    for (const o of p.options ?? []) add({ ...o, placeId: p.id });
  }
  // 区間の端の町の宿(逆向きに走って着いたときも泊まれる)
  if (segment.lengthM - m <= LODGING_RANGE_M) for (const o of NODES[segment.to]?.lodging ?? []) add({ ...o, placeId: segment.to });
  if (m <= LODGING_RANGE_M) for (const o of NODES[segment.from]?.lodging ?? []) add({ ...o, placeId: segment.from });
  if (!opts.some((o) => o.kind === 'park')) opts.push({ kind: 'park', name: '近くの公園', yen: 0 });
  opts.push({ kind: 'bivouac', name: '近くの公園で野宿', yen: 0 });
  return opts.map((o) => {
    const eff = LODGING_EFFECTS[o.kind];
    let reason = null;
    if (eff.needsTent && !hasTent(trip)) reason = 'テントがありません';
    else if (!canAfford(trip, o.yen)) reason = 'お金が足りません';
    return { ...o, label: eff.label, available: reason === null, reason };
  });
}

/**
 * 宿に泊まって1日を終える。日誌に記録し、翌朝の体力・満腹度・所持金・荷物を決める。
 * テント泊では荷物の食料を食べる(足りなければお腹がすいたまま朝を迎える)。
 */
export function stayAt(trip, option) {
  const eff = LODGING_EFFECTS[option.kind] ?? LODGING_EFFECTS.bivouac;
  const yen = Math.min(trip.wallet.yen, option.yen ?? 0);
  let pack = trip.bike.pack;
  let satiety = eff.satiety;
  if (satiety === undefined) {
    const food = pack.food ?? 0;
    if (option.kind !== 'bivouac' && food >= CAMP_MEAL.kg - 1e-9) {
      pack = { ...pack, food: Math.round((food - CAMP_MEAL.kg) * 1000) / 1000 };
      satiety = CAMP_MEAL.satiety;
    } else {
      satiety = Math.min(trip.rider.satiety, CAMP_MEAL.hungrySatiety) - (option.kind === 'bivouac' ? 10 : 0);
    }
  }
  // 寝袋なしのテント泊は寒くてよく眠れない(回復が半分)
  const noBag = eff.needsTent && !((trip.bike.pack.sleepingBag ?? 0) > 0);
  const stamina = eff.staminaTo ?? trip.rider.stamina + eff.staminaAdd * (noBag ? 0.5 : 1);
  const t = endDay(trip, { lodging: { kind: option.kind, name: option.name, yen } });
  return {
    ...t,
    wallet: { yen: t.wallet.yen - yen },
    bike: { ...t.bike, pack },
    rider: { ...t.rider, stamina: clamp100(stamina), satiety: clamp100(satiety), zeroSatietyMinutes: 0 },
  };
}

/** 失敗ごとの日誌の文と、救護の費用(円)。 */
export const FAILURES = {
  hungerKnock: { text: 'ハンガーノックで倒れ、救護された', yen: 8000 },
  exhausted: { text: '疲れ果てて動けなくなり、救護された', yen: 8000 },
  sunset: { text: '宿を決めないまま日が暮れた', yen: 0 },
};

/**
 * 失敗で1日を終える。ハンガーノック・疲労は最寄りの町の救護所へ運ばれ(位置もその町へ)、
 * 治療と宿代を払う(足りなければある分だけ)。日没は近くの公園で野宿(テントがあればテント泊)。
 */
export function failDay(trip, segment, failure) {
  const f = FAILURES[failure];
  const t = addRideEvent(trip, 'incidents', { kind: failure, text: f.text });
  if (failure === 'sunset') {
    return stayAt(t, hasTent(t) ? { kind: 'park', name: '近くの公園', yen: 0 } : { kind: 'bivouac', name: '近くの公園で野宿', yen: 0 });
  }
  const town = nearestPlace(segment, t.position.segmentM, ['town']);
  const moved = town
    ? { ...t, position: { ...t.position, segmentM: town.atM, totalM: t.position.totalM + (town.atM - t.position.segmentM) } }
    : t;
  return stayAt(moved, { kind: 'rescue', name: `${town?.name ?? '近くの町'}の救護所`, yen: f.yen });
}
