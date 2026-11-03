// 旅の状態(セーブデータの中身。設計書2章)と、1日の流れに沿った更新。純粋関数のみ。
//
// 旅の状態はふつうの JSON にできるオブジェクトで、更新関数は元を書き換えずに新しいオブジェクトを返す
// (保存中のスナップショットが後から書き換わらないように)。
// 体力 stamina・満腹度 satiety は表示と旅の判断のためのもので、物理・トレーナーへの指示には使わない。
// 満腹度は設計書の「空腹(0〜100)」と同じもの。100 = 満腹、0 = 何も食べていない(ハンガーノックの条件)。

import { DEFAULT_PACK } from '../physics/surfaces.js';

/** セーブデータの形式のバージョン。形を変えたら上げて、migrateTrip() に変換を足す。 */
export const SCHEMA_VERSION = 1;

/** 旅の中の時間の早回し倍率(設計書2章)。実際の走行1時間 = 旅の (倍率) 時間。 */
export const TIME_SCALES = [1, 2, 4, 6, 8];
export const DEFAULT_TIME_SCALE = 4;

/** 1日の出発時刻(0:00 からの分)。 */
export const DAY_START_MINUTES = 7 * 60;

export const WEATHER_KINDS = ['sunny', 'cloudy', 'rain', 'squall'];

/** 区間の表示名。区間データ(ステップ4)ができたらそちらへ移す。 */
const SEGMENT_LABELS = {
  'atami-ito': '熱海サンビーチ → 伊東',
};

/**
 * 新しい旅を始める。
 * @param {object} [o]
 * @param {string} [o.tripId] 省略時は時刻と乱数から作る
 * @param {number} [o.now] 作成時刻(ms)。テスト用
 */
export function createTrip({
  tripId, now = Date.now(), riderWeightKg = 70, ftpW = 200, bikeWeightKg = 11,
  pack = DEFAULT_PACK, yen = 30000, timeScale = DEFAULT_TIME_SCALE, segmentId = 'atami-ito',
} = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tripId: tripId ?? `trip-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    createdAt: now,
    updatedAt: now,
    settings: { timeScale: normalizeTimeScale(timeScale) },
    position: { segmentId, segmentM: 0, totalM: 0 },
    day: 1,
    clockMinutes: DAY_START_MINUTES,
    rider: { weightKg: riderWeightKg, ftpW, stamina: 100, satiety: 80 },
    bike: { weightKg: bikeWeightKg, tire: 'gravel', pack: { ...pack } },
    wallet: { yen },
    weather: { kind: 'sunny', wet: false },
    ride: null, // 走行中の1日の記録(終わると log に移る)。途中で落ちてもここから再開できる
    log: [],
  };
}

/** 早回し倍率を TIME_SCALES のどれかにそろえる(不正値は既定の4倍)。 */
export function normalizeTimeScale(x) {
  return TIME_SCALES.includes(x) ? x : DEFAULT_TIME_SCALE;
}

/** その日のライドを始める(走行中の記録がもうあれば、それを続ける=落ちた後の再開)。 */
export function startRide(trip, now = Date.now()) {
  if (trip.ride) return trip;
  return {
    ...trip,
    updatedAt: now,
    ride: {
      day: trip.day,
      startedAt: now,
      startTotalM: trip.position.totalM,
      startClockMinutes: trip.clockMinutes,
      distanceM: 0,
      rideSeconds: 0,
      elevationGainM: 0,
      extraMinutes: 0, // 走らずに過ぎた旅の時間(休憩・食事など。passTripTime)
      meals: [],
      encounters: [],
      incidents: [],
    },
  };
}

/**
 * 走行の進み具合を反映する(物理の積算値をそのまま渡す。差分ではない)。
 * 位置は走った距離だけ、旅の時計は 走行秒 × 早回し倍率 だけ進む(距離は倍率で増やさない)。
 * @param {object} trip
 * @param {{distanceM:number, rideSeconds:number, elevationGainM:number}} p その日のライド開始からの積算
 */
export function updateRide(trip, { distanceM, rideSeconds, elevationGainM }, now = Date.now()) {
  const r = trip.ride;
  if (!r) return trip;
  const d = Math.max(0, finite(distanceM, r.distanceM));
  const s = Math.max(0, finite(rideSeconds, r.rideSeconds));
  const gainM = Math.max(0, finite(elevationGainM, r.elevationGainM));
  const deltaM = d - r.distanceM;
  return {
    ...trip,
    updatedAt: now,
    position: {
      ...trip.position,
      segmentM: trip.position.segmentM + deltaM,
      totalM: r.startTotalM + d,
    },
    clockMinutes: r.startClockMinutes + (r.extraMinutes ?? 0) + (s * trip.settings.timeScale) / 60,
    ride: { ...r, distanceM: d, rideSeconds: s, elevationGainM: gainM },
  };
}

/** 走らずに旅の時間を進める(一時停止中の休憩、食事など)。minutes は旅の時間。 */
export function passTripTime(trip, minutes, now = Date.now()) {
  if (!trip.ride || !(minutes > 0)) return trip;
  return {
    ...trip,
    updatedAt: now,
    clockMinutes: trip.clockMinutes + minutes,
    ride: { ...trip.ride, extraMinutes: (trip.ride.extraMinutes ?? 0) + minutes },
  };
}

/**
 * その日の出来事を記録する(食事・出会い・失敗など)。旅の時刻を添える。
 * @param {'meals'|'encounters'|'incidents'} kind
 * @param {object} entry 例: { name: '干物定食', yen: 1500 }
 */
export function addRideEvent(trip, kind, entry, now = Date.now()) {
  if (!trip.ride || !['meals', 'encounters', 'incidents'].includes(kind)) return trip;
  const item = { ...entry, atMinutes: trip.clockMinutes, atTotalM: trip.position.totalM };
  return { ...trip, updatedAt: now, ride: { ...trip.ride, [kind]: [...trip.ride[kind], item] } };
}

/**
 * 1日を終える: 走行中の記録を日誌に移し、翌朝 7:00 に進める。
 * @param {object} trip
 * @param {{lodging:{kind:string, name?:string, yen?:number}}} p 泊まった場所
 */
export function endDay(trip, { lodging }, now = Date.now()) {
  const r = trip.ride ?? startRide(trip, now).ride;
  const entry = {
    day: trip.day,
    startedAt: r.startedAt,
    endedAt: now,
    distanceM: r.distanceM,
    rideSeconds: r.rideSeconds,
    elevationGainM: r.elevationGainM,
    endClockMinutes: trip.clockMinutes,
    endTotalM: trip.position.totalM,
    meals: r.meals,
    encounters: r.encounters,
    incidents: r.incidents,
    lodging: lodging ?? null,
  };
  return {
    ...trip,
    updatedAt: now,
    day: trip.day + 1,
    clockMinutes: DAY_START_MINUTES,
    ride: null,
    log: [...trip.log, entry],
  };
}

/** 旅の時刻の表示(例: "13:05")。 */
export function fmtClock(minutes) {
  const m = Math.max(0, Math.floor(minutes)) % (24 * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** 起動時に出す「◯日目・◯◯から再開」。 */
export function resumeLabel(trip) {
  const seg = SEGMENT_LABELS[trip.position.segmentId] ?? trip.position.segmentId;
  const km = (trip.position.segmentM / 1000).toFixed(1);
  const where = trip.ride ? `走行の途中(${seg} ${km}km 地点)` : `${seg} ${km}km 地点`;
  return `${trip.day}日目・${where}から再開(旅の時刻 ${fmtClock(trip.clockMinutes)})`;
}

/**
 * 読み込んだデータを今の形式にそろえ、壊れていないか確かめる。
 * @returns {{ok:true, trip:object} | {ok:false, error:string}}
 */
export function migrateTrip(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '旅のデータではありません。' };
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || v < 1) return { ok: false, error: '旅のデータのバージョンがありません。' };
  if (v > SCHEMA_VERSION) {
    return { ok: false, error: `新しいバージョン(${v})のアプリで保存された旅です。アプリを更新してください。` };
  }
  // v1 が最初の形式。形を変えたらここに if (v === 1) { ... v = 2 } のように変換を足す。
  const trip = raw;
  const error = checkTrip(trip);
  return error ? { ok: false, error } : { ok: true, trip };
}

function checkTrip(t) {
  if (typeof t.tripId !== 'string' || !t.tripId) return 'tripId がありません。';
  if (!Number.isInteger(t.day) || t.day < 1) return '旅の日数が不正です。';
  if (!Number.isFinite(t.clockMinutes)) return '旅の時刻が不正です。';
  const p = t.position;
  if (!p || typeof p.segmentId !== 'string' || !Number.isFinite(p.segmentM) || !Number.isFinite(p.totalM)) {
    return '旅の位置が不正です。';
  }
  if (!t.settings || !TIME_SCALES.includes(t.settings.timeScale)) return '早回し倍率が不正です。';
  if (!t.rider || !Number.isFinite(t.rider.weightKg)) return '体重が不正です。';
  if (!t.bike || !Number.isFinite(t.bike.weightKg) || typeof t.bike.pack !== 'object') return '自転車・荷物が不正です。';
  if (!t.wallet || !Number.isFinite(t.wallet.yen)) return '所持金が不正です。';
  if (!Array.isArray(t.log)) return '日誌が不正です。';
  if (t.ride !== null && (typeof t.ride !== 'object' || !Number.isFinite(t.ride.distanceM))) return '走行中の記録が不正です。';
  return null;
}

function finite(x, fallback) {
  return Number.isFinite(x) ? x : fallback;
}
