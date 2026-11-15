// 1日の走行の進行: 物理・体・旅の時計・天気・出会い・店や宿の案内・道連れ・失敗と分かれ道の判定。
// 画面(js/ui/RideScreen.js)から切り出した部分で、3D・音・トレーナーの通信・保存には触れない
// (それらは画面が、ここが返す出来事 events を見て行う)。Node のテストからそのまま走らせられる。
//
// 時間の進め方: advance(経過秒) は実時間の経過をそのまま受け取り、MAX_STEP_SEC ごとに刻んで進める。
// 画面の描画が遅い端末や、タブが裏に回って描画が止まっている間も、旅は実時間どおりに進む
// (画面は描画のタイミングと、裏にいる間のタイマーの両方から呼ぶ)。
//
// 走行中の旅 this.trip は作業用の複製で、その場で書き換える(毎フレーム新しい旅を作らないため)。
// 保存(TripStore#save)はその時点の中身を JSON で複製するので、保存済みのものは後から変わらない。
// 体力・満腹度は表示と旅の判断だけ。トレーナーへの指示は trainerGradePercent() / ergTargetWatts()。

import { PhysicsEngine } from '../physics/physicsEngine.js';
import { packWeightKg, surfaceOf } from '../physics/surfaces.js';
import { createSegmentRoute, nextPlace, tunnelAtM } from '../physics/segmentRoute.js';
import {
  startRide, applyRideProgress, applyTripTime, chooseNextSegment, addRideEvent, pushRideSample,
} from '../storage/tripState.js';
import { routesFrom, cameFromSegmentId } from './network.js';
import { soaked } from './gear.js';
import { visitSight, stampFood } from './stamps.js';
import { stepBody, checkFailure, BODY } from './body.js';
import {
  forecastDay, weatherAt, WEATHER_LABELS, planEncounters, applyEncounter, eatMeal, eatSnack, failDay, MEAL_MINUTES, SNACK,
} from './dayEvents.js';
import { planCompanion, CompanionTalk, talkCeilingW, recordCompanion, recordCompanionMet } from './companion.js';
import { seasonOfDay, recentTaleIds } from './encounters.js';
import { seasonDayOfYear } from './season.js';

/** 1回に進める最大の時間(秒)。これより長い経過は刻んで進める。 */
export const MAX_STEP_SEC = 0.1;
/**
 * 1回の advance で取り戻す最大の時間(秒)。端末のスリープなどで空いた分は旅に入れない。
 * Chrome は裏に回って 5 分たったタブのタイマーを 1 分ごとにまとめることがあるので、その間隔は取り戻せる長さにする。
 */
export const MAX_CATCHUP_SEC = 75;
/** トレーナーからこの時間(ms)データが来なければ、パワーとケイデンスを 0 とみなす(止まっているのに進まないように)。 */
export const TRAINER_STALE_MS = 3000;
/** 地点の手前この距離(m)で、店・宿の案内を出す。 */
export const PROMPT_AHEAD_M = 80;
/** 案内を出したまま地点をこの距離(m)過ぎたら、案内を消す。 */
export const PROMPT_PAST_M = 150;

/** デモ(トレーナーなし)のパワー: 坂で少し踏み、下りで休む。 */
export function demoPower(grade) {
  return Math.min(320, Math.max(60, 150 + grade * 14));
}

/**
 * @typedef {{type:'toast', text:string} | {type:'prompt', place:object|null} | {type:'save', kind:string}
 *   | {type:'junction', routes:object[]} | {type:'finish', reason:string}} RideEvent
 */

export class RideSession {
  /**
   * @param {object} o
   * @param {object} o.trip 旅(走行中の記録があれば続きから)。元の旅は書き換えない
   * @param {object} o.segment 勾配つきの区間(network.loadSegment 済み)
   * @param {boolean} [o.demo] トレーナーなしのデモ(パワーは demoPower、走行記録の点は残さない)
   * @param {number} [o.nowMs] 開始時刻(テスト用)
   */
  constructor({ trip, segment, demo = false, nowMs = Date.now() }) {
    this.segment = segment;
    this.demo = demo;
    this.trip = structuredClone(startRide(trip, nowMs));
    const t = this.trip;
    const ride = t.ride;
    this.route = createSegmentRoute(segment, t.position.segmentM - ride.distanceM);
    this.physics = new PhysicsEngine({
      riderWeightKg: t.rider.weightKg, bikeWeightKg: t.bike.weightKg, packWeightKg: packWeightKg(t.bike.pack), route: this.route,
    });
    this.physics.distanceM = ride.distanceM;
    this.physics.elevationGainM = ride.elevationGainM;
    this.rideSeconds = ride.rideSeconds;
    this.forecast = forecastDay(t.tripId, t.day);
    // 道ばたの出会いは、その日の季節(景色と同じ季節の設定)と最近の日誌に出た話も見て選ぶ
    this.season = seasonOfDay(seasonDayOfYear(t.settings.season));
    this.encounters = planEncounters(segment, t.tripId, t.day, { season: this.season, recentIds: recentTaleIds(t) });
    this.encIdx = firstIndex(this.encounters, (e) => e.atM > t.position.segmentM);
    this.places = (segment.places ?? []).filter((p) => p.kind !== 'encounter');
    this.placeIdx = firstIndex(this.places, (p) => p.atM - PROMPT_AHEAD_M > t.position.segmentM);
    // 道連れ: しばらく並走して話してくれる(会話できる楽なペースの目安。表示だけ)
    const plan = planCompanion(segment, t, t.position.segmentM);
    this.talk = plan ? new CompanionTalk({ plan, trip: t }) : null;
    this.running = true; // false = 休憩中(旅の時間は進み、体力が少し戻る)
    this.ended = false; // その日を終えた・次の区間へ移った後は何も進めない
    this.junction = null; // 区間の終点で選べる道(選ぶまでは休憩と同じ)
    this.prompt = null; // 出している店・宿・見どころの案内
    this.trainerOffline = false; // トレーナーとの接続が切れている(つなぎ直すまで走り出せない)
    this.lastWeather = null;
    this.warnedHungry = t.rider.satiety < BODY.HUNGRY_BELOW;
    this.inTunnel = null;
    this.lastSurface = null;
    this.powerW = 0; // 直近のパワー(補正後。デモは demoPower)
    this.trainer = { powerW: 0, cadenceRpm: 0, atMs: -Infinity };
    this.weather = weatherAt(this.forecast, t.clockMinutes);
    this._events = [];
  }

  // ---- 入力 ----

  /** トレーナーから届いた値(Indoor Bike Data)。null の項目は前の値のまま。 */
  setTrainerData({ powerW, cadenceRpm }, nowMs = Date.now()) {
    if (Number.isFinite(powerW)) this.trainer.powerW = powerW;
    if (Number.isFinite(cadenceRpm)) this.trainer.cadenceRpm = cadenceRpm;
    this.trainer.atMs = nowMs;
  }

  /** トレーナーとの接続が切れた: 止まって休憩にし、つなぎ直すまで走り出せない。 */
  trainerLost() {
    this.trainerOffline = true;
    this.trainer = { powerW: 0, cadenceRpm: 0, atMs: -Infinity };
    this.running = false;
    this.physics.speedMps = 0;
    this._emit({ type: 'save', kind: 'event' });
  }

  /** トレーナーにつなぎ直した(走り出すのは利用者が「走り出す」を押してから)。 */
  trainerRestored() {
    this.trainerOffline = false;
  }

  /** いまのケイデンス(表示・走行記録用)。デモは 85 rpm、データが途切れたら 0。 */
  cadenceRpm(nowMs = Date.now()) {
    if (this.demo) return 85;
    return nowMs - this.trainer.atMs > TRAINER_STALE_MS ? 0 : this.trainer.cadenceRpm;
  }

  /**
   * 休憩する/走り出す。分かれ道で選んでいる間と、トレーナーの接続が切れている間は走り出せない。
   * @returns {boolean} 切り替えたか
   */
  setRunning(on) {
    if (this.ended || this.junction || (on && this.trainerOffline && !this.demo)) return false;
    if (this.running === on) return false;
    this.running = on;
    if (!on) this._emit({ type: 'save', kind: 'event' });
    return true;
  }

  // ---- 時間を進める ----

  /**
   * 実時間 elapsedSec 秒ぶん進める(MAX_STEP_SEC ごとに刻む。MAX_CATCHUP_SEC を超える分は捨てる)。
   * @returns {RideEvent[]} この間に起きた出来事(画面が表示・保存・トレーナーへの指示に使う)
   */
  advance(elapsedSec, nowMs = Date.now()) {
    let left = Math.min(Math.max(0, Number.isFinite(elapsedSec) ? elapsedSec : 0), MAX_CATCHUP_SEC);
    while (left > 1e-6 && !this.ended) {
      const dt = Math.min(MAX_STEP_SEC, left);
      left -= dt;
      this._step(dt, nowMs);
    }
    return this.drainEvents();
  }

  /** たまった出来事を取り出す(取り出したものは消える)。 */
  drainEvents() {
    const out = this._events;
    this._events = [];
    return out;
  }

  _emit(e) {
    this._events.push(e);
  }

  _toast(text) {
    this._emit({ type: 'toast', text });
  }

  _step(dt, nowMs) {
    const t = this.trip;
    const tripMinutes = (dt * t.settings.timeScale) / 60;
    const w = weatherAt(this.forecast, t.clockMinutes);
    this.weather = w;
    const physics = this.physics;
    let power = 0;
    if (this.running) {
      const fresh = nowMs - this.trainer.atMs <= TRAINER_STALE_MS;
      power = this.demo ? demoPower(physics.currentGradePercent) : (fresh ? this.trainer.powerW : 0) * (t.settings.powerScale ?? 1);
      // デモでは、道連れと並走中は話せるペースで走る
      if (this.demo && this.talk?.phase === 'together') power = Math.min(power, talkCeilingW(t.rider.stamina, t.rider.ftpW));
      physics.setCurrentPower(power);
      physics.setConditions(w);
      const snap = physics.step(dt);
      this.rideSeconds += dt;
      applyRideProgress(t, { distanceM: snap.distanceM, rideSeconds: this.rideSeconds, elevationGainM: snap.elevationGainM }, nowMs);
      // 走行記録(TCX 用、5 走行秒ごと)。デモのパワーは作り物なので残さない
      if (!this.demo) pushRideSample(t, { powerW: power, cadenceRpm: this.cadenceRpm(nowMs) });
      t.rider = stepBody(t.rider, { tripMinutes, powerW: power, ftpW: t.rider.ftpW, soaked: soaked(t, w.kind) });
    } else {
      // 休憩: 旅の時間は進み、体力が少し戻る
      applyTripTime(t, tripMinutes, nowMs);
      t.rider = stepBody(t.rider, { tripMinutes, powerW: 0, ftpW: t.rider.ftpW, resting: true });
    }
    this.powerW = power;
    this._checkEvents(w, power, dt);
    this._checkEnd();
  }

  _checkEvents(w, power, dt) {
    let t = this.trip;
    const segM = t.position.segmentM;
    if (this.lastWeather !== w.kind) {
      if (this.lastWeather !== null) {
        this._toast((w.kind === 'squall' ? 'スコールが来た!強い向かい風と雨。' : `天気が変わった: ${WEATHER_LABELS[w.kind]}`)
          + (soaked(t, w.kind) ? '雨具がないので体が冷えて、疲れやすい。' : ''));
      }
      this.lastWeather = w.kind;
    }
    while (this.encIdx < this.encounters.length && this.encounters[this.encIdx].atM <= segM) {
      const e = this.encounters[this.encIdx++];
      this.trip = t = applyEncounter(t, e);
      this._toast(e.gift ? `${e.text}(${e.gift.name}をもらった)` : e.text);
      this._emit({ type: 'save', kind: 'event' });
    }
    while (this.placeIdx < this.places.length && this.places[this.placeIdx].atM - PROMPT_AHEAD_M <= segM) {
      const p = this.places[this.placeIdx++];
      if (p.kind === 'food' || p.kind === 'shop' || p.kind === 'lodging' || p.kind === 'sight') this._setPrompt(p);
      else if (p.text) this._toast(p.text);
      else if (p.kind === 'town') this._toast(`${p.name}に入った。`);
    }
    if (this.prompt && segM > this.prompt.atM + PROMPT_PAST_M) this._setPrompt(null);
    const tunnel = tunnelAtM(this.segment, segM);
    if (tunnel && tunnel !== this.inTunnel) this._toast(`${tunnel.name}に入った。`);
    this.inTunnel = tunnel;
    // 路面が変わったら知らせる(最初の1回は出発地点の路面なので、未舗装のときだけ)
    const surf = this.physics.currentSurface;
    if (surf !== this.lastSurface) {
      const sv = surfaceOf(surf);
      if (this.lastSurface !== null || sv.unpaved) {
        this._toast(sv.unpaved ? `ここから${sv.label}。${this.physics.wet ? '雨でぬかるんで、ペダルが重い。' : 'タイヤが砂利を噛む音。'}` : '舗装路に戻った。');
      }
      this.lastSurface = surf;
    }
    if (this.talk) {
      const said = this.talk.step({
        dtSec: dt, powerW: power, ceilingW: talkCeilingW(t.rider.stamina, t.rider.ftpW), segM,
        moving: this.running, weatherKind: w.kind, inTunnel: !!tunnel, places: this.segment.places ?? [],
      });
      const c = this.talk.companion;
      if (said.joined) this._toast(`${c.name}(${c.who})が隣に並んだ。`);
      if (said.chapterDone !== undefined) this.trip = t = recordCompanion(t, c.id, said.chapterDone + 1);
      if (said.left) {
        t = recordCompanionMet(t, c.id);
        this.trip = t = addRideEvent(t, 'encounters', {
          id: `companion-${c.id}`, text: `${c.name}と ${(said.togetherM / 1000).toFixed(1)} km 一緒に走った`,
        });
        this._emit({ type: 'save', kind: 'event' });
      }
    }
    if (!this.warnedHungry && t.rider.satiety < BODY.HUNGRY_BELOW) {
      this.warnedHungry = true;
      this._toast('お腹がすいてきた。補給食か、店で何か食べよう。');
    }
  }

  _checkEnd() {
    const t = this.trip;
    const failure = checkFailure(t.rider, t.clockMinutes);
    if (failure) {
      this.ended = true;
      this.running = false;
      this._emit({ type: 'finish', reason: failure });
      return;
    }
    if (this.junction || !this.route.finished(this.physics.distanceM)) return;
    // 区間の終点 = 町の分かれ道。次の道があれば止まって選ぶ(選ぶまでは休憩と同じ扱い)
    const routes = routesFrom(this.segment.to, cameFromSegmentId(t));
    if (routes.length === 0) {
      this.ended = true;
      this.running = false;
      this._emit({ type: 'finish', reason: 'arrived' });
      return;
    }
    this.junction = routes;
    this._setPrompt(null);
    this.running = false;
    this.physics.speedMps = 0;
    this._emit({ type: 'junction', routes });
    this._emit({ type: 'save', kind: 'event' });
  }

  _setPrompt(p) {
    this.prompt = p;
    this._emit({ type: 'prompt', place: p });
  }

  // ---- 走行中の操作 ----

  /** 店で食べる。食べられたら true。 */
  eat(place, item) {
    const before = this.trip;
    const ate = eatMeal(before, place, item);
    if (ate === before) return false;
    const r = stampFood(ate, place, item);
    this.trip = r.trip;
    this.physics.speedMps = 0; // 止まって食べた
    this._toast(`${place.name}で${item.name}を食べた(${item.yen.toLocaleString()} 円、旅の時間 ${MEAL_MINUTES} 分)${r.added ? '。スタンプ帳に記録' : ''}`);
    this._setPrompt(null);
    this._emit({ type: 'save', kind: 'event' });
    return true;
  }

  /** 見どころに立ち寄る。 */
  visit(place, minutes) {
    const r = visitSight(this.trip, place);
    this.trip = r.trip;
    this.physics.speedMps = 0;
    this._toast(`${place.name}に立ち寄って写真を撮った(旅の時間 ${minutes} 分)${r.added ? '。スタンプ帳に記録' : ''}`);
    this._setPrompt(null);
    this._emit({ type: 'save', kind: 'event' });
  }

  /** 荷物の補給食を食べる。食べられたら true。 */
  snack() {
    const before = this.trip;
    this.trip = eatSnack(before);
    if (this.trip === before) {
      this._toast('補給食が残っていません。');
      return false;
    }
    this._toast(`補給食を食べた(満腹度 +${SNACK.satiety})`);
    this._emit({ type: 'save', kind: 'event' });
    return true;
  }

  /** 案内を閉じる(通り過ぎる)。 */
  dismissPrompt() {
    this._setPrompt(null);
  }

  /** 分かれ道で次の区間を選ぶ: 走行の記録はそのままの旅を返す(画面が新しい区間で作り直す)。 */
  continueOn(segmentId, nowMs = Date.now()) {
    this.ended = true;
    this.running = false;
    this.trip = chooseNextSegment(this.trip, segmentId, nowMs);
    return this.trip;
  }

  /**
   * その日を終える。失敗(ハンガーノック・疲労・日没)なら救護・野宿まで済ませた旅、それ以外は今の旅を返す
   * (宿は 1日の終わりの画面で選ぶ)。
   * @returns {{trip:object, failed:boolean}}
   */
  endDay(reason) {
    this.ended = true;
    this.running = false;
    const failed = ['hungerKnock', 'exhausted', 'sunset'].includes(reason);
    if (failed) this.trip = failDay(this.trip, this.segment, reason);
    return { trip: this.trip, failed };
  }

  // ---- 表示・トレーナー ----

  /** Simulation モードでトレーナーへ送る勾配(%)。 */
  trainerGradePercent() {
    return this.physics.trainerGradePercent();
  }

  /** ERG モードでトレーナーへ送る目標パワー(W。パワー補正の倍率で割り戻す)。 */
  ergTargetWatts() {
    return this.physics.computeErgTargetWatts() / (this.trip.settings.powerScale ?? 1);
  }

  /** 計器に出す値。 */
  view(nowMs = Date.now()) {
    const t = this.trip;
    const segM = t.position.segmentM;
    return {
      speedKmh: this.physics.speedMps * 3.6,
      powerW: this.powerW,
      cadence: this.cadenceRpm(nowMs),
      grade: this.physics.currentGradePercent,
      trainerGrade: this.physics.trainerGradePercent(),
      surface: surfaceOf(this.physics.currentSurface).label,
      unpaved: surfaceOf(this.physics.currentSurface).unpaved,
      todayKm: this.physics.distanceM / 1000,
      remainKm: this.route.remainingM(this.physics.distanceM) / 1000,
      clock: t.clockMinutes,
      weatherKind: this.weather.kind,
      weather: WEATHER_LABELS[this.weather.kind],
      stamina: t.rider.stamina,
      satiety: t.rider.satiety,
      yen: t.wallet.yen,
      food: t.bike.pack.food ?? 0,
      next: nextPlace(this.segment, segM + 1, ['town', 'food', 'shop', 'lodging']),
      segM,
      inTunnel: !!this.inTunnel,
      talk: this.talk?.view() ?? null,
      talkCeilingW: talkCeilingW(t.rider.stamina, t.rider.ftpW),
    };
  }
}

function firstIndex(list, pred) {
  const i = list.findIndex(pred);
  return i < 0 ? list.length : i;
}
