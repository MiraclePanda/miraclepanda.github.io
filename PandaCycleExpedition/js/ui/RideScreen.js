// 走行画面: 物理・体・旅の時計・天気・出来事を requestAnimationFrame で進め、3D と HUD に出す。
//
// 毎フレームの値(速度・距離・旅の状態)は ref に持ち、React の再描画は HUD の 4Hz 更新だけにする。
// 物理のループは mount 時に1回だけ作るので、ループの中で読む値はすべて ref から読む(古い値を掴まないように)。
// 体力・満腹度は表示と旅の判断だけ。トレーナーへは PhysicsEngine#trainerGradePercent()(荷物・路面・風の上乗せ込み)。

import { h, useState, useEffect, useRef } from './h.js';
import { PhysicsEngine } from '../physics/physicsEngine.js';
import { packWeightKg, surfaceOf } from '../physics/surfaces.js';
import { createSegmentRoute, nextPlace, tunnelAtM } from '../physics/segmentRoute.js';
import { startRide, updateRide, passTripTime, fmtClock } from '../storage/tripState.js';
import { AutoSaver } from '../storage/autosave.js';
import { stepBody, checkFailure, satietyLabel, sustainableWatts, BODY } from '../trip/body.js';
import {
  forecastDay, weatherAt, WEATHER_LABELS, planEncounters, applyEncounter, eatMeal, eatSnack, canAfford, failDay, SNACK,
} from '../trip/dayEvents.js';
import { createSeaRoadScene } from '../three/seaRoadScene.js';
import { WakeLockManager } from '../utils/wakeLock.js';

const TOAST_MS = 6000;
/** 地点の手前この距離(m)で、店・宿の案内を出す。 */
const PROMPT_AHEAD_M = 80;

/** デモ(トレーナーなし)のパワー: 坂で少し踏み、下りで休む。 */
function demoPower(grade) {
  return Math.min(320, Math.max(60, 150 + grade * 14));
}

export function RideScreen({ trip: initialTrip, segment, store, client, demo, onEnd }) {
  const canvasRef = useRef(null);
  const tripRef = useRef(null);
  const runningRef = useRef(true);
  const powerRef = useRef(0);
  const cadenceRef = useRef(0);
  const promptRef = useRef(null);
  const endedRef = useRef(false);
  const [hud, setHud] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [prompt, setPrompt] = useState(null);
  const [paused, setPaused] = useState(false);
  const [warning, setWarning] = useState(null);
  const ctxRef = useRef(null);

  function toast(text) {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), TOAST_MS);
  }

  function showPrompt(p) {
    promptRef.current = p;
    setPrompt(p);
  }

  useEffect(() => {
    // ---- 準備: 走行中の記録を続ける(落ちた後の再開)か、その日のライドを始める ----
    let trip = startRide(initialTrip);
    tripRef.current = trip;
    const ride = trip.ride;
    const route = createSegmentRoute(segment, trip.position.segmentM - ride.distanceM);
    const physics = new PhysicsEngine({
      riderWeightKg: trip.rider.weightKg,
      bikeWeightKg: trip.bike.weightKg,
      packWeightKg: packWeightKg(trip.bike.pack),
      route,
    });
    physics.distanceM = ride.distanceM;
    physics.elevationGainM = ride.elevationGainM;
    let rideSeconds = ride.rideSeconds;
    const forecast = forecastDay(trip.tripId, trip.day);
    const encounters = planEncounters(segment, trip.tripId, trip.day);
    let encIdx = encounters.findIndex((e) => e.atM > trip.position.segmentM);
    if (encIdx < 0) encIdx = encounters.length;
    const places = (segment.places ?? []).filter((p) => p.kind !== 'encounter');
    let placeIdx = places.findIndex((p) => p.atM - PROMPT_AHEAD_M > trip.position.segmentM);
    if (placeIdx < 0) placeIdx = places.length;
    let lastWeather = null;
    let warnedHungry = trip.rider.satiety < BODY.HUNGRY_BELOW;
    let inTunnel = null;

    const saver = new AutoSaver({ store, getTrip: () => tripRef.current });
    saver.start();
    const wake = new WakeLockManager();
    wake.enable().catch(() => {});

    let scene = null;
    try {
      scene = createSeaRoadScene(canvasRef.current, segment);
    } catch (e) {
      setWarning(`3D を表示できません(${e.message})。走行と記録は続けられます。`);
    }
    const onResize = () => scene?.resize();
    window.addEventListener('resize', onResize);

    // ---- トレーナー ----
    const onBike = (ev) => {
      const d = ev.detail;
      if (d.instPowerW !== null && d.instPowerW !== undefined) powerRef.current = d.instPowerW;
      if (d.instCadenceRpm !== null && d.instCadenceRpm !== undefined) cadenceRef.current = d.instCadenceRpm;
    };
    const onDisc = () => {
      runningRef.current = false;
      setPaused(true);
      setWarning('トレーナーとの接続が切れました。ホームに戻って接続し直してください(ここまでの旅は保存されています)。');
      saver.saveNow('event');
    };
    if (!demo) {
      client.addEventListener('bike-data', onBike);
      client.addEventListener('disconnected', onDisc);
      client.beginSession().catch((e) => setWarning(e.message));
    }

    // ---- 1日を終える ----
    async function finish(reason) {
      if (endedRef.current) return;
      endedRef.current = true;
      runningRef.current = false;
      let t = tripRef.current;
      if (['hungerKnock', 'exhausted', 'sunset'].includes(reason)) {
        t = failDay(t, segment, reason);
        tripRef.current = t;
        await store.save(t, 'dayEnd').catch(() => {});
      } else {
        await saver.saveNow('rideEnd');
      }
      onEnd(t, reason);
    }

    // 走行中の操作(ボタン)から使う
    ctxRef.current = {
      finish,
      eat(place, item) {
        tripRef.current = eatMeal(tripRef.current, place, item);
        physics.speedMps = 0; // 止まって食べた
        toast(`${place.name}で${item.name}を食べた(${item.yen.toLocaleString()} 円、旅の時間 30 分)`);
        saver.saveNow('event');
      },
      snack() {
        const before = tripRef.current;
        tripRef.current = eatSnack(before);
        if (tripRef.current === before) toast('補給食が残っていません。');
        else { toast('補給食を食べた(満腹度 +12)'); saver.saveNow('event'); }
      },
      togglePause() {
        runningRef.current = !runningRef.current;
        setPaused(!runningRef.current);
        if (!demo) (runningRef.current ? client.resume() : client.pause()).catch(() => {});
        if (!runningRef.current) saver.saveNow('event');
      },
    };

    // ---- 毎フレーム ----
    let last = performance.now();
    let lastHud = 0;
    let raf = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      let t = tripRef.current;
      const scale = t.settings.timeScale;
      const tripMinutes = (dt * scale) / 60;
      const w = weatherAt(forecast, t.clockMinutes);
      let power = 0;
      if (runningRef.current && !endedRef.current) {
        power = demo ? demoPower(physics.currentGradePercent) : powerRef.current * (t.settings.powerScale ?? 1);
        if (demo) cadenceRef.current = 85;
        physics.setCurrentPower(power);
        physics.setConditions(w);
        const snap = physics.step(dt);
        rideSeconds += dt;
        t = updateRide(t, { distanceM: snap.distanceM, rideSeconds, elevationGainM: snap.elevationGainM });
        t = { ...t, rider: stepBody(t.rider, { tripMinutes, powerW: power, ftpW: t.rider.ftpW }) };
        if (!demo && client.isConnected) {
          if (client.controlMode === 'erg') client.setErgTarget(physics.computeErgTargetWatts() / (t.settings.powerScale ?? 1));
          else client.setGrade(physics.trainerGradePercent());
        }
      } else if (!endedRef.current) {
        // 一時停止 = 休憩。旅の時間は進み、体力が少し戻る
        t = passTripTime(t, tripMinutes);
        t = { ...t, rider: stepBody(t.rider, { tripMinutes, powerW: 0, ftpW: t.rider.ftpW, resting: true }) };
      }
      tripRef.current = t;
      const segM = t.position.segmentM;

      // 出来事
      if (lastWeather !== w.kind) {
        if (lastWeather !== null) {
          toast(w.kind === 'squall' ? 'スコールが来た!強い向かい風と雨。' : `天気が変わった: ${WEATHER_LABELS[w.kind]}`);
        }
        lastWeather = w.kind;
      }
      while (encIdx < encounters.length && encounters[encIdx].atM <= segM) {
        const e = encounters[encIdx++];
        tripRef.current = t = applyEncounter(t, e);
        toast(e.gift ? `${e.text}(${e.gift.name}をもらった)` : e.text);
        saver.saveNow('event');
      }
      while (placeIdx < places.length && places[placeIdx].atM - PROMPT_AHEAD_M <= segM) {
        const p = places[placeIdx++];
        if (p.kind === 'food' || p.kind === 'shop' || p.kind === 'lodging') showPrompt(p);
        else if (p.text) toast(p.text);
        else if (p.kind === 'town') toast(`${p.name}に入った。`);
      }
      if (promptRef.current && segM > promptRef.current.atM + 150) showPrompt(null);
      const tunnel = tunnelAtM(segment, segM);
      if (tunnel && tunnel !== inTunnel) toast(`${tunnel.name}に入った。`);
      inTunnel = tunnel;
      if (!warnedHungry && t.rider.satiety < BODY.HUNGRY_BELOW) {
        warnedHungry = true;
        toast('お腹がすいてきた。補給食か、店で何か食べよう。');
      }

      if (!endedRef.current) {
        const failure = checkFailure(t.rider, t.clockMinutes);
        if (failure) finish(failure);
        else if (route.finished(physics.distanceM)) finish('arrived');
      }

      scene?.draw({
        segmentM: segM, speedKmh: physics.speedMps * 3.6, gradePercent: physics.currentGradePercent,
        weatherKind: w.kind, clockMinutes: t.clockMinutes,
      });

      if (now - lastHud > 250) {
        lastHud = now;
        setHud({
          speedKmh: physics.speedMps * 3.6,
          powerW: power,
          cadence: cadenceRef.current,
          grade: physics.currentGradePercent,
          trainerGrade: physics.trainerGradePercent(),
          surface: surfaceOf(physics.currentSurface).label,
          todayKm: physics.distanceM / 1000,
          remainKm: route.remainingM(physics.distanceM) / 1000,
          clock: t.clockMinutes,
          weather: WEATHER_LABELS[w.kind],
          stamina: t.rider.stamina,
          satiety: t.rider.satiety,
          yen: t.wallet.yen,
          food: t.bike.pack.food ?? 0,
          next: nextPlace(segment, segM + 1, ['town', 'food', 'shop', 'lodging']),
          segM,
        });
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      saver.stop();
      wake.disable().catch(() => {});
      if (!demo) {
        client.removeEventListener('bike-data', onBike);
        client.removeEventListener('disconnected', onDisc);
        if (client.isConnected) client.endSession().catch(() => {});
      }
      scene?.dispose();
    };
  }, []);

  const ctx = ctxRef.current;
  const t = tripRef.current;
  return h('div', { className: 'ride' },
    h('canvas', { ref: canvasRef }),
    hud && h(Hud, { hud, ftpW: t?.rider.ftpW ?? 200, demo }),
    h('div', { className: 'toasts' },
      warning && h('div', { className: 'toast' }, warning),
      paused && !warning && h('div', { className: 'toast' }, '休憩中(旅の時間は進み、体力が少しずつ戻ります)'),
      toasts.map((x) => h('div', { key: x.id, className: 'toast' }, x.text))),
    prompt && t && h(PlacePrompt, {
      place: prompt, trip: t,
      onEat: (item) => { ctx.eat(prompt, item); showPrompt(null); },
      onStay: () => { showPrompt(null); ctx.finish('stop'); },
      onClose: () => showPrompt(null),
    }),
    h('div', { className: 'attribution' }, segment.attribution ?? ''),
    h('div', { className: 'ride-bar' },
      h('button', { onClick: () => ctx?.togglePause() }, paused ? '走り出す' : '休憩する'),
      h('button', { onClick: () => ctx?.snack(), disabled: !t || (t.bike.pack.food ?? 0) < SNACK.kg }, '補給食を食べる'),
      h('button', { onClick: () => ctx?.finish('stop') }, '今日はここまで(宿を探す)'),
      h('button', { onClick: () => ctx?.finish('exit') }, 'ホームに戻る')));
}

function Hud({ hud, ftpW, demo }) {
  const meter = (v) => h('div', { className: `meter${v < 25 ? ' low' : ''}` }, h('i', { style: { width: `${Math.max(0, Math.min(100, v))}%` } }));
  const cell = (label, value, extra) => h('div', { className: 'cell' }, h('span', null, label), h('b', null, value), extra);
  return h('div', { className: 'hud' },
    cell('速度', `${hud.speedKmh.toFixed(1)} km/h`),
    cell(demo ? 'パワー(デモ)' : 'パワー', `${Math.round(hud.powerW)} W`, h('span', null, ` 目安 ${sustainableWatts(hud.stamina, ftpW)}W`)),
    cell('勾配', `${hud.grade.toFixed(1)}%`, h('span', null, ` 体感 ${hud.trainerGrade.toFixed(1)}%`)),
    cell('路面', hud.surface),
    cell('今日', `${hud.todayKm.toFixed(2)} km`, h('span', null, ` 残り ${hud.remainKm.toFixed(1)} km`)),
    cell('旅の時刻', fmtClock(hud.clock), h('span', null, ` ${hud.weather}`)),
    cell('体力', `${Math.round(hud.stamina)}`, meter(hud.stamina)),
    cell('満腹度', `${Math.round(hud.satiety)}`, h('div', null, meter(hud.satiety), h('span', null, satietyLabel(hud.satiety)))),
    cell('所持金', `${hud.yen.toLocaleString()} 円`, h('span', null, ` 食料 ${hud.food.toFixed(2)}kg`)),
    hud.next && cell('この先', hud.next.name, h('span', null, ` ${((hud.next.atM - hud.segM) / 1000).toFixed(1)} km`)));
}

function PlacePrompt({ place, trip, onEat, onStay, onClose }) {
  return h('div', { className: 'prompt' },
    h('b', null, place.name), place.text && h('div', { className: 'muted' }, place.text),
    (place.menu ?? []).length > 0 && h('div', { className: 'row' },
      place.menu.map((item) => h('button', {
        key: item.name, disabled: !canAfford(trip, item.yen), onClick: () => onEat(item),
      }, `${item.name}(${item.yen.toLocaleString()} 円)`))),
    h('div', { className: 'row' },
      place.kind === 'lodging' && h('button', { className: 'primary', onClick: onStay }, 'ここで今日の宿を探す'),
      h('button', { onClick: onClose }, '通り過ぎる')));
}
