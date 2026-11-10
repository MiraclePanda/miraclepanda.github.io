// 走行画面: 物理・体・旅の時計・天気・出来事を requestAnimationFrame で進め、3D と HUD に出す。
//
// 毎フレームの値(速度・距離・旅の状態)は ref に持ち、React の再描画は HUD の 4Hz 更新だけにする。
// 物理のループは mount 時に1回だけ作るので、ループの中で読む値はすべて ref から読む(古い値を掴まないように)。
// 体力・満腹度は表示と旅の判断だけ。トレーナーへは PhysicsEngine#trainerGradePercent()(荷物・路面・風の上乗せ込み)。

import { h, useState, useEffect, useRef } from './h.js';
import { PhysicsEngine } from '../physics/physicsEngine.js';
import { packWeightKg, surfaceOf } from '../physics/surfaces.js';
import { createSegmentRoute, nextPlace, tunnelAtM } from '../physics/segmentRoute.js';
import { startRide, updateRide, passTripTime, fmtClock, chooseNextSegment, addRideEvent, addRideSample } from '../storage/tripState.js';
import { routesFrom, segmentSummary, nodeName, cameFromSegmentId, loadSegment } from '../trip/network.js';
import { soaked } from '../trip/gear.js';
import { visitSight, stampFood, SIGHT_VISIT_MINUTES } from '../trip/stamps.js';
import { AutoSaver } from '../storage/autosave.js';
import { stepBody, checkFailure, satietyLabel, sustainableWatts, BODY } from '../trip/body.js';
import {
  forecastDay, weatherAt, WEATHER_LABELS, planEncounters, applyEncounter, eatMeal, eatSnack, canAfford, failDay, SNACK,
} from '../trip/dayEvents.js';
import { planCompanion, CompanionTalk, talkCeilingW, recordCompanion, recordCompanionMet } from '../trip/companion.js';
import { createSeaRoadScene } from '../three/seaRoadScene.js';
import { createRealRoadScene } from '../three/realRoadScene.js';
import { createWebGPURenderer } from '../three/gpuBackend.js';
import { createSeason, seasonDayOfYear } from '../trip/season.js';
import { seasonOfDay, recentTaleIds } from '../trip/encounters.js';
import { loadScenery, loadPanorama } from '../three/sceneryData.js';
import { RideMap } from './RideMap.js';
import { nextCameraView } from '../three/cameraViews.js';
import { WakeLockManager } from '../utils/wakeLock.js';
import {
  loadRenderQuality, saveRenderQuality, RENDER_QUALITY_VALUES, loadShowRideMap, saveShowRideMap,
  loadCameraView, saveCameraView, loadSoundOn, saveSoundOn,
} from '../storage/prefs.js';
import { soundMix } from '../utils/soundMix.js';
import { createSoundscape } from '../utils/soundscape.js';

const TOAST_MS = 6000;
const QUALITY_LABELS = { auto: '自動', ultra: '最高', high: '高', medium: '中', low: '低' };
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
  const [junction, setJunction] = useState(null);
  const junctionRef = useRef(null);
  const ctxRef = useRef(null);
  const sceneRef = useRef(null);
  const [qualityMode, setQualityMode] = useState(loadRenderQuality);
  const [cameraView, setCameraView] = useState(loadCameraView);
  const [activeTier, setActiveTier] = useState(null);
  const [gpuBackend, setGpuBackend] = useState(false); // 景色を WebGPU で描いているか
  // 景色データ: undefined = 読み込み中、null = 無い(簡易の景色)、object = 実在の地形・建物
  const [scenery, setScenery] = useState(undefined);
  const [showMap, setShowMap] = useState(loadShowRideMap);
  // スマホ(狭い画面・横向き)では帯を細くたたむ。計器と道具はそれぞれ押すと広がる(広い画面では常に全部出す)
  const [hudOpen, setHudOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const mapApiRef = useRef(null);
  const [soundOn, setSoundOn] = useState(loadSoundOn);
  const soundRef = useRef(null);

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
    // 道ばたの出会いは、その日の季節(景色と同じ季節の設定)と最近の日誌に出た話も見て選ぶ
    const encounters = planEncounters(segment, trip.tripId, trip.day, {
      season: seasonOfDay(seasonDayOfYear(trip.settings.season)), recentIds: recentTaleIds(trip),
    });
    const seaSide = !!segment.seaSide && segment.seaSide !== 'none';
    let encIdx = encounters.findIndex((e) => e.atM > trip.position.segmentM);
    if (encIdx < 0) encIdx = encounters.length;
    const places = (segment.places ?? []).filter((p) => p.kind !== 'encounter');
    let placeIdx = places.findIndex((p) => p.atM - PROMPT_AHEAD_M > trip.position.segmentM);
    if (placeIdx < 0) placeIdx = places.length;
    // 道連れ: しばらく並走して話してくれる(会話できる楽なペースの目安。表示だけ)
    const companionPlan = planCompanion(segment, trip, trip.position.segmentM);
    const talk = companionPlan ? new CompanionTalk({ plan: companionPlan, trip }) : null;
    const allPlaces = segment.places ?? [];
    let lastWeather = null;
    let warnedHungry = trip.rider.satiety < BODY.HUNGRY_BELOW;
    let inTunnel = null;
    let lastSurface = null;

    // 走行中の音(ファイルを使わずに作る)。出発のボタンを押した後なので、そのまま鳴らせる
    const season = seasonOfDay(seasonDayOfYear(trip.settings.season));
    let sound = null;
    try {
      sound = createSoundscape({ enabled: loadSoundOn() });
      sound?.resume();
    } catch {
      sound = null;
    }
    soundRef.current = sound;
    let lastSound = 0;

    const saver = new AutoSaver({ store, getTrip: () => tripRef.current });
    saver.start();
    const wake = new WakeLockManager();
    wake.enable().catch(() => {});

    // 景色データ(国土地理院の地形・建物)を読んでから 3D を作る。読めなければ簡易の海沿いの景色にする。
    // 読み込みの間も走行・記録は進む(3D が出ていないだけ)。
    let scene = null;
    let alive = true;
    Promise.all([loadScenery(segment), loadPanorama()]).then(async ([sc, panorama]) => {
      if (!alive) return;
      // 実在の景色は、WebGPU を使える端末なら WebGPU で描く(使えなければ null → WebGL)
      const gpuRenderer = sc ? await createWebGPURenderer(canvasRef.current) : null;
      if (!alive) {
        gpuRenderer?.dispose();
        return;
      }
      setGpuBackend(!!gpuRenderer);
      setScenery(sc);
      const opts = { qualityMode: loadRenderQuality(), onQualityChange: setActiveTier, cameraView: loadCameraView() };
      try {
        // 景色の季節(既定は実際の今日の日付)。区間の原点の経緯度で桜・紅葉の進み具合と日の出入りを決める
        const season = sc ? createSeason({ mode: tripRef.current.settings.season, latDeg: sc.origin[1], lonDeg: sc.origin[0] }) : null;
        scene = sc ? createRealRoadScene(canvasRef.current, segment, sc, { ...opts, panorama, season, renderer: gpuRenderer }) : createSeaRoadScene(canvasRef.current, segment, opts);
        sceneRef.current = scene;
      } catch (e) {
        setWarning(`3D を表示できません(${e.message})。走行と記録は続けられます。`);
      }
    });
    const onResize = () => scene?.resize();
    window.addEventListener('resize', onResize);
    // 景色の枠は上下の帯の高さで変わる(帯の折り返しなど)ので、枠の大きさの変化でも描き直す
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    ro?.observe(canvasRef.current.parentElement);

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
        const r = stampFood(eatMeal(tripRef.current, place, item), place, item);
        tripRef.current = r.trip;
        physics.speedMps = 0; // 止まって食べた
        toast(`${place.name}で${item.name}を食べた(${item.yen.toLocaleString()} 円、旅の時間 30 分)${r.added ? '。スタンプ帳に記録' : ''}`);
        saver.saveNow('event');
      },
      visit(place) {
        const r = visitSight(tripRef.current, place);
        tripRef.current = r.trip;
        physics.speedMps = 0;
        toast(`${place.name}に立ち寄って写真を撮った(旅の時間 ${SIGHT_VISIT_MINUTES} 分)${r.added ? '。スタンプ帳に記録' : ''}`);
        saver.saveNow('event');
      },
      snack() {
        const before = tripRef.current;
        tripRef.current = eatSnack(before);
        if (tripRef.current === before) toast('補給食が残っていません。');
        else { toast('補給食を食べた(満腹度 +12)'); saver.saveNow('event'); }
      },
      /** 分かれ道で次の区間を選ぶ: 走行の記録はそのまま、新しい区間で走行画面を作り直す。 */
      async continueOn(segmentId) {
        if (endedRef.current) return;
        endedRef.current = true;
        const t = chooseNextSegment(tripRef.current, segmentId);
        tripRef.current = t;
        await store.save(t, 'event').catch(() => {});
        onEnd(t, 'continue');
      },
      togglePause() {
        if (junctionRef.current) return;
        runningRef.current = !runningRef.current;
        setPaused(!runningRef.current);
        if (!demo) (runningRef.current ? client.resume() : client.pause()).catch(() => {});
        if (!runningRef.current) saver.saveNow('event');
      },
    };

    // ---- 毎フレーム ----
    let last = performance.now();
    let lastHud = 0;
    let lastMap = 0;
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
        // デモでは、道連れと並走中は話せるペースで走る
        if (demo && talk?.phase === 'together') power = Math.min(power, talkCeilingW(t.rider.stamina, t.rider.ftpW));
        if (demo) cadenceRef.current = 85;
        physics.setCurrentPower(power);
        physics.setConditions(w);
        const snap = physics.step(dt);
        rideSeconds += dt;
        t = updateRide(t, { distanceM: snap.distanceM, rideSeconds, elevationGainM: snap.elevationGainM });
        // 走行記録(TCX 用、5 走行秒ごと)。デモのパワーは作り物なので残さない
        if (!demo) t = addRideSample(t, { powerW: power, cadenceRpm: cadenceRef.current });
        t = { ...t, rider: stepBody(t.rider, { tripMinutes, powerW: power, ftpW: t.rider.ftpW, soaked: soaked(t, w.kind) }) };
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
          toast((w.kind === 'squall' ? 'スコールが来た!強い向かい風と雨。' : `天気が変わった: ${WEATHER_LABELS[w.kind]}`)
            + (soaked(t, w.kind) ? '雨具がないので体が冷えて、疲れやすい。' : ''));
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
        if (p.kind === 'food' || p.kind === 'shop' || p.kind === 'lodging' || p.kind === 'sight') showPrompt(p);
        else if (p.text) toast(p.text);
        else if (p.kind === 'town') toast(`${p.name}に入った。`);
      }
      if (promptRef.current && segM > promptRef.current.atM + 150) showPrompt(null);
      const tunnel = tunnelAtM(segment, segM);
      if (tunnel && tunnel !== inTunnel) toast(`${tunnel.name}に入った。`);
      inTunnel = tunnel;
      // 路面が変わったら知らせる(最初の1回は出発地点の路面なので、未舗装のときだけ)
      const surf = physics.currentSurface;
      if (surf !== lastSurface) {
        const sv = surfaceOf(surf);
        if (lastSurface !== null || sv.unpaved) {
          toast(sv.unpaved ? `ここから${sv.label}。${physics.wet ? '雨でぬかるんで、ペダルが重い。' : 'タイヤが砂利を噛む音。'}` : `舗装路に戻った。`);
        }
        lastSurface = surf;
      }
      if (talk) {
        const said = talk.step({
          dtSec: dt, powerW: power, ceilingW: talkCeilingW(t.rider.stamina, t.rider.ftpW), segM,
          moving: runningRef.current && !endedRef.current, weatherKind: w.kind, inTunnel: !!tunnel, places: allPlaces,
        });
        const c = talk.companion;
        if (said.joined) toast(`${c.name}(${c.who})が隣に並んだ。`);
        if (said.chapterDone !== undefined) tripRef.current = t = recordCompanion(t, c.id, said.chapterDone + 1);
        if (said.left) {
          t = recordCompanionMet(t, c.id);
          tripRef.current = t = addRideEvent(t, 'encounters', {
            id: `companion-${c.id}`, text: `${c.name}と ${(said.togetherM / 1000).toFixed(1)} km 一緒に走った`,
          });
          saver.saveNow('event');
        }
      }
      if (!warnedHungry && t.rider.satiety < BODY.HUNGRY_BELOW) {
        warnedHungry = true;
        toast('お腹がすいてきた。補給食か、店で何か食べよう。');
      }

      if (!endedRef.current) {
        const failure = checkFailure(t.rider, t.clockMinutes);
        if (failure) finish(failure);
        else if (!junctionRef.current && route.finished(physics.distanceM)) {
          // 区間の終点 = 町の分かれ道。次の道があれば止まって選ぶ(選ぶまでは休憩と同じ扱い)
          const routes = routesFrom(segment.to, cameFromSegmentId(t));
          if (routes.length === 0) finish('arrived');
          else {
            // 選んだらすぐ走り出せるように、次の区間のデータを先に読んでおく
            for (const r of routes) loadSegment(r.segmentId).catch(() => {});
            junctionRef.current = routes;
            setJunction(routes);
            showPrompt(null);
            runningRef.current = false;
            setPaused(true);
            physics.speedMps = 0;
            if (!demo) client.pause().catch(() => {});
            saver.saveNow('event');
          }
        }
      }

      scene?.draw({
        segmentM: segM, speedKmh: physics.speedMps * 3.6, gradePercent: physics.currentGradePercent,
        weatherKind: w.kind, clockMinutes: t.clockMinutes, cadenceRpm: cadenceRef.current,
      });

      if (sound && now - lastSound > 100) {
        lastSound = now;
        const speedKmh = runningRef.current ? physics.speedMps * 3.6 : 0;
        sound.update(soundMix({
          speedKmh, unpaved: surfaceOf(physics.currentSurface).unpaved, seaSide, inTunnel: !!tunnel,
          weatherKind: w.kind, season, clockMinutes: t.clockMinutes,
        }), speedKmh);
      }

      if (now - lastMap > 500) {
        lastMap = now;
        mapApiRef.current?.draw(segM);
      }

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
          talk: talk?.view() ?? null,
          talkCeilingW: talkCeilingW(t.rider.stamina, t.rider.ftpW),
        });
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      saver.stop();
      wake.disable().catch(() => {});
      if (!demo) {
        client.removeEventListener('bike-data', onBike);
        client.removeEventListener('disconnected', onDisc);
        if (client.isConnected) client.endSession().catch(() => {});
      }
      alive = false;
      scene?.dispose();
      sceneRef.current = null;
      sound?.dispose();
      soundRef.current = null;
    };
  }, []);

  function toggleMap() {
    setShowMap((v) => {
      saveShowRideMap(!v);
      return !v;
    });
  }

  function toggleSound() {
    setSoundOn((v) => {
      saveSoundOn(!v);
      soundRef.current?.setEnabled(!v);
      return !v;
    });
  }

  function changeView() {
    setCameraView((v) => {
      const next = nextCameraView(v);
      saveCameraView(next);
      sceneRef.current?.setCameraView?.(next);
      return next;
    });
  }
  // V キーでも視点を切り替える(入力欄・選択欄の操作中は除く)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key !== 'v' && e.key !== 'V') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName ?? '')) return;
      changeView();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function changeQuality(mode) {
    setQualityMode(mode);
    saveRenderQuality(mode);
    sceneRef.current?.setQualityMode(mode);
  }

  const ctx = ctxRef.current;
  const t = tripRef.current;
  // 上の帯(旅の計器)・景色・下の帯(旅の道具)の3段。帯には景色を重ねない
  return h('div', { className: `ride${hudOpen ? ' hud-open' : ''}${toolsOpen ? ' tools-open' : ''}` },
    h(Hud, {
      hud, ftpW: t?.rider.ftpW ?? 200, demo, day: t?.day ?? initialTrip.day, title: segment.name,
      onToggle: () => setHudOpen((v) => !v),
    }),
    h('div', { className: 'ride-stage' },
    h('canvas', { ref: canvasRef }),
    h('div', { className: 'toasts' },
      warning && h('div', { className: 'toast' }, warning),
      paused && !warning && !junction && h('div', { className: 'toast' }, '休憩中(旅の時間は進み、体力が少しずつ戻ります)'),
      scenery === undefined && h('div', { className: 'toast' }, '景色を読み込み中…'),
      toasts.map((x) => h('div', { key: x.id, className: 'toast' }, x.text))),
    showMap && h(RideMap, { segment, scenery: scenery ?? null, apiRef: mapApiRef }),
    // 画面下の中央: 道連れの話(字幕のように)と、その下に店・宿・分かれ道の案内を重ならないように積む
    h('div', { className: 'ride-bottom' },
    hud?.talk && h(CompanionPanel, { talk: hud.talk, ceilingW: hud.talkCeilingW }),
    junction && h(JunctionPrompt, {
      here: nodeName(segment.to), routes: junction,
      onChoose: (id) => ctx.continueOn(id),
      onStay: () => ctx.finish('arrived'),
    }),
    prompt && t && h(PlacePrompt, {
      place: prompt, trip: t,
      onEat: (item) => { ctx.eat(prompt, item); showPrompt(null); },
      onVisit: () => { ctx.visit(prompt); showPrompt(null); },
      onStay: () => { showPrompt(null); ctx.finish('stop'); },
      onClose: () => showPrompt(null),
    })),
    h('div', { className: 'attribution' }, scenery ? `${scenery.attribution}・地理院タイル(シームレス空中写真)` : (segment.attribution ?? ''))),
    h('div', { className: 'ride-bar' },
      h('button', { className: 'primary', onClick: () => ctx?.togglePause(), disabled: !!junction }, paused ? '走り出す' : '休憩する'),
      // スマホでたたんだ帯を広げる(広い画面では出さない)
      h('button', { className: 'ride-more', onClick: () => setToolsOpen((v) => !v), 'aria-expanded': toolsOpen },
        toolsOpen ? 'たたむ ▾' : 'ほかの操作 ▴'),
      h('button', { className: 'ride-extra', onClick: () => ctx?.snack(), disabled: !t || (t.bike.pack.food ?? 0) < SNACK.kg }, '補給食を食べる'),
      h('button', { className: 'ride-extra', onClick: () => ctx?.finish('stop') }, '今日はここまで(宿を探す)'),
      h('button', { className: 'ride-extra', onClick: () => ctx?.finish('exit') }, 'ホームに戻る'),
      // 地図・視点・描画品質は1つのまとまりにして、帯の右端に寄せる
      h('div', { className: 'ride-bar-tools' },
      h('button', { onClick: toggleMap, 'aria-pressed': showMap }, showMap ? '地図を隠す' : '地図を表示'),
      h('button', { onClick: toggleSound, 'aria-pressed': soundOn, title: '風・波・砂利・虫の声などの音' }, soundOn ? '音: 入' : '音: 切'),
      scenery && h('button', { onClick: changeView, title: '視点を切り替える(V キー)' }, `視点: ${VIEW_LABELS[cameraView]}`),
      // 描画品質は押すたびに 自動 → 最高 → 高 → 中 → 低 → 自動 と切り替える
      h('button', {
        className: 'ride-extra',
        onClick: () => changeQuality(RENDER_QUALITY_VALUES[(RENDER_QUALITY_VALUES.indexOf(qualityMode) + 1) % RENDER_QUALITY_VALUES.length]),
        title: `描画品質を切り替える(${gpuBackend ? 'WebGPU' : 'WebGL'} で描画中)`,
      }, `品質: ${qualityMode === 'auto' && activeTier ? `自動(${QUALITY_LABELS[activeTier]})`
        // 最高で重すぎて自動で下げたときは「最高→高」のように実際の段階も出す
        : activeTier && activeTier !== qualityMode ? `${QUALITY_LABELS[qualityMode]}→${QUALITY_LABELS[activeTier]}`
        : QUALITY_LABELS[qualityMode]}${gpuBackend ? '・WebGPU' : ''}`))));
}

const VIEW_LABELS = { chase: '後ろ', fp: '目線', high: '上空' };

function Hud({ hud, ftpW, demo, day, title, onToggle }) {
  const head = h('div', { className: 'hud-title' }, h('small', null, `旅の ${day} 日目`), h('b', null, title));
  // スマホでは帯を押すと全部の計器を広げる/たたむ(広い画面では押しても何も変わらない)
  const box = (...children) => h('div', { className: 'hud', onClick: onToggle }, ...children);
  if (!hud) return box(head);
  const meter = (v) => h('div', { className: `meter${v < 25 ? ' low' : ''}` }, h('i', { style: { width: `${Math.max(0, Math.min(100, v))}%` } }));
  // key: スマホでたたんだときにも出す計器('wide' は横向きのときだけ)。ほかは広げたときだけ
  const cell = (label, value, extra, key) => h('div', { className: key ? `cell key${key === 'wide' ? ' wide' : ''}` : 'cell' }, h('span', null, label), h('b', null, value), extra);
  return box(
    head,
    cell('速度', `${hud.speedKmh.toFixed(1)} km/h`, null, true),
    cell(demo ? 'パワー(デモ)' : 'パワー', `${Math.round(hud.powerW)} W`, h('span', null, ` 目安 ${sustainableWatts(hud.stamina, ftpW)}W`), true),
    cell('勾配', `${hud.grade.toFixed(1)}%`, h('span', null, ` 体感 ${hud.trainerGrade.toFixed(1)}%`), true),
    cell('路面', hud.surface),
    cell('今日', `${hud.todayKm.toFixed(2)} km`, h('span', null, ` 残り ${hud.remainKm.toFixed(1)} km`), 'wide'),
    cell('旅の時刻', fmtClock(hud.clock), h('span', null, ` ${hud.weather}`)),
    cell('体力', `${Math.round(hud.stamina)}`, meter(hud.stamina), true),
    cell('満腹度', `${Math.round(hud.satiety)}`, h('div', null, meter(hud.satiety), h('span', null, satietyLabel(hud.satiety)))),
    cell('所持金', `${hud.yen.toLocaleString()} 円`, h('span', null, ` 食料 ${hud.food.toFixed(2)}kg`)),
    hud.next && cell('この先', hud.next.name, h('span', null, ` ${((hud.next.atM - hud.segM) / 1000).toFixed(1)} km`)),
    h('div', { className: 'hud-more', 'aria-hidden': true }));
}

/** 道連れの話: 吹き出し。話せるペースの目安も出す(超えると話が一休みになるだけで、罰はない)。 */
function CompanionPanel({ talk, ceilingW }) {
  return h('div', { className: `companion${talk.pace === 'hard' ? ' hard' : ''}` },
    h('div', { className: 'companion-head' },
      h('b', null, talk.name),
      !talk.gone && h('span', null, talk.pace === 'hard' ? `息が上がってる…(話せるペース 〜${ceilingW}W)` : `話せるペース 〜${ceilingW}W`)),
    h('div', { className: 'companion-text' }, talk.text ?? '(景色を眺めながら、並んで走っている)'));
}

/** 分かれ道の案内の1行(ホームの朝の出発前にも使う)。 */
export function routeLabel(r) {
  const s = segmentSummary(r.segment);
  const parts = [`${s.lengthKm.toFixed(1)} km`, `獲得標高 ${s.climbM} m`, `宿 ${s.lodgings} か所`, `店 ${s.foods} か所`];
  if (s.tunnels) parts.push(`トンネル ${s.tunnels} 本`);
  return `${r.toName}へ${r.back ? '(来た道を戻る)' : ''}: ${parts.join('・')}`;
}

function JunctionPrompt({ here, routes, onChoose, onStay }) {
  return h('div', { className: 'prompt' },
    h('b', null, `${here}に着いた。分かれ道`),
    h('div', { className: 'muted' }, 'この先どちらへ行く?(選ぶまでは休憩しています)'),
    routes.map((r) => h('div', { key: r.segmentId, className: 'row' },
      h('button', { className: r.back ? '' : 'primary', onClick: () => onChoose(r.segmentId) }, routeLabel(r)))),
    h('div', { className: 'row' }, h('button', { onClick: onStay }, `${here}で今日の宿を探す`)));
}

function PlacePrompt({ place, trip, onEat, onVisit, onStay, onClose }) {
  const stamped = (trip.stamps ?? []).some((s) => s.id === place.id);
  return h('div', { className: 'prompt' },
    h('b', null, place.name), place.text && h('div', { className: 'muted' }, place.text),
    (place.menu ?? []).length > 0 && h('div', { className: 'row' },
      place.menu.map((item) => h('button', {
        key: item.name, disabled: !canAfford(trip, item.yen), onClick: () => onEat(item),
      }, `${item.name}(${item.yen.toLocaleString()} 円)`))),
    h('div', { className: 'row' },
      place.kind === 'lodging' && h('button', { className: 'primary', onClick: onStay }, 'ここで今日の宿を探す'),
      place.kind === 'sight' && h('button', { className: 'primary', onClick: onVisit },
        `立ち寄る(写真を撮る・${SIGHT_VISIT_MINUTES} 分)${stamped ? '・スタンプ済み' : ''}`),
      h('button', { onClick: onClose }, '通り過ぎる')));
}
