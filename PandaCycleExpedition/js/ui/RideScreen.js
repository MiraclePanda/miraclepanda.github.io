// 走行画面: 物理・体・旅の時計・天気・出来事を requestAnimationFrame で進め、3D と HUD に出す。
//
// 毎フレームの値(速度・距離・旅の状態)は ref に持ち、React の再描画は HUD の 4Hz 更新だけにする。
// 物理のループは mount 時に1回だけ作るので、ループの中で読む値はすべて ref から読む(古い値を掴まないように)。
// 体力・満腹度は表示と旅の判断だけ。トレーナーへは PhysicsEngine#trainerGradePercent()(荷物・路面・風の上乗せ込み)。

import { h, useState, useEffect, useRef } from './h.js';
import { RideSession } from '../trip/rideSession.js';
import { segmentSummary, nodeName, loadSegment } from '../trip/network.js';
import { SIGHT_VISIT_MINUTES } from '../trip/stamps.js';
import { sustainableWatts, satietyLabel } from '../trip/body.js';
import { canAfford, canHelp, SNACK, HELP_WORK } from '../trip/dayEvents.js';
import { createSeaRoadScene } from '../three/seaRoadScene.js';
import { createRealRoadScene } from '../three/realRoadScene.js';
import { sceneCanvas, sharedWebGPURenderer } from '../three/gpuBackend.js';
import { createSeason } from '../trip/season.js';
import { loadScenery, loadPanorama } from '../three/sceneryData.js';
import { RideMap } from './RideMap.js';
import { nextCameraView } from '../three/cameraViews.js';
import { WakeLockManager } from '../utils/wakeLock.js';
import {
  loadRenderQuality, saveRenderQuality, RENDER_QUALITY_VALUES, loadShowRideMap, saveShowRideMap,
  loadCameraView, saveCameraView, loadSoundOn, saveSoundOn, forgetAutoQuality,
} from '../storage/prefs.js';
import { AutoSaver } from '../storage/autosave.js';
import { sharedPhotoStore, captureThumbnail } from '../storage/photoStore.js';
import { fmtClock } from '../storage/tripState.js';
import { soundMix } from '../utils/soundMix.js';
import { createSoundscape } from '../utils/soundscape.js';

const TOAST_MS = 6000;
const QUALITY_LABELS = { auto: '自動', ultra: '最高', high: '高', medium: '中', low: '低' };
/** タブが裏にあって描画が止まっている間も、旅をこの間隔(ms)で進める。 */
const HIDDEN_TICK_MS = 250;
/** URL に ?perf=1 をつけたときだけ、描画の重さの計測を出す。 */
const SHOW_PERF = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('perf') === '1';
  } catch {
    return false;
  }
})();

export function RideScreen({ trip: initialTrip, segment, store, client, demo, onEnd }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const sessionRef = useRef(null);
  const [hud, setHud] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [prompt, setPrompt] = useState(null);
  const [paused, setPaused] = useState(false);
  const [warning, setWarning] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [offline, setOffline] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [junction, setJunction] = useState(null);
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
  const [perf, setPerf] = useState(null);

  function toast(text) {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), TOAST_MS);
  }

  useEffect(() => {
    // ---- 準備: 1日の進行(走行中の記録があれば続きから) ----
    const session = new RideSession({ trip: initialTrip, segment, demo });
    sessionRef.current = session;
    const seaSide = !!segment.seaSide && segment.seaSide !== 'none';
    let ended = false;

    // 走行中の音(ファイルを使わずに作る)。出発のボタンを押した後なので、そのまま鳴らせる
    let sound = null;
    try {
      sound = createSoundscape({ enabled: loadSoundOn() });
      sound?.resume();
    } catch {
      sound = null;
    }
    soundRef.current = sound;
    let lastSound = 0;

    const saver = new AutoSaver({ store, getTrip: () => session.trip });
    saver.start();
    const wake = new WakeLockManager();
    wake.enable().catch(() => {});

    // 景色データ(国土地理院の地形・建物)を読んでから 3D を作る。読めなければ簡易の海沿いの景色にする。
    // 読み込みの間も走行・記録は進む(3D が出ていないだけ)。シェーダーの組み立てまで済ませてから出す
    let scene = null;
    let alive = true;
    Promise.all([loadScenery(segment), loadPanorama()]).then(async ([sc, panorama]) => {
      if (!alive) return;
      // 実在の景色は、WebGPU を使える端末なら WebGPU で描く(使えなければ null → WebGL)
      const gpuRenderer = sc ? await sharedWebGPURenderer() : null;
      if (!alive) return;
      setGpuBackend(!!gpuRenderer);
      // 景色の canvas と描画の土台は走行画面を作り直しても同じものを使う(分かれ道で次の区間に入るたびに
      // WebGL の文脈・WebGPU の機器を作り直して止まらないように)。大きさを測れるよう、作る前に枠へ入れる
      const canvas = gpuRenderer ? gpuRenderer.domElement : sceneCanvas('webgl');
      canvasRef.current = canvas;
      stageRef.current?.prepend(canvas);
      const opts = {
        qualityMode: loadRenderQuality(), onQualityChange: setActiveTier, cameraView: loadCameraView(),
      };
      // 自動調整は走行ごとに測り直す。前の版が覚えていた「下げた段階」は消す(次からずっと低い画質で始まっていた)
      forgetAutoQuality();
      try {
        // 景色の季節(既定は実際の今日の日付)。区間の原点の経緯度で桜・紅葉の進み具合と日の出入りを決める
        const season = sc ? createSeason({ mode: session.trip.settings.season, latDeg: sc.origin[1], lonDeg: sc.origin[0] }) : null;
        const sc3 = sc
          ? createRealRoadScene(canvas, segment, sc, { ...opts, panorama, season, renderer: gpuRenderer, startM: session.trip.position.segmentM })
          : createSeaRoadScene(canvas, segment, opts);
        await sc3.prepare?.();
        if (!alive) { sc3.dispose(); return; }
        scene = sc3;
        sceneRef.current = scene;
      } catch (e) {
        setWarning(`3D を表示できません(${e.message})。走行と記録は続けられます。`);
      }
      setScenery(sc);
    });
    const onResize = () => scene?.resize();
    window.addEventListener('resize', onResize);
    // 景色の枠は上下の帯の高さで変わる(帯の折り返しなど)ので、枠の大きさの変化でも描き直す
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    ro?.observe(stageRef.current);

    // ---- トレーナー ----
    const onBike = (ev) => {
      const d = ev.detail;
      session.setTrainerData({ powerW: d.instPowerW ?? NaN, cadenceRpm: d.instCadenceRpm ?? NaN });
    };
    const onDisc = () => {
      // パワーを 0 にして止まり、つなぎ直すまで走り出せない(最後のパワーのまま進まないように)
      session.trainerLost();
      setPaused(true);
      setOffline(true);
      handle(session.drainEvents());
    };
    if (!demo) {
      client.addEventListener('bike-data', onBike);
      client.addEventListener('disconnected', onDisc);
      if (!client.isConnected) onDisc();
      else client.beginSession().catch((e) => setWarning(e.message));
    }

    // ---- 出来事の処理(表示・保存・トレーナー) ----
    function handle(events) {
      for (const e of events) {
        if (e.type === 'toast') toast(e.text);
        else if (e.type === 'prompt') setPrompt(e.place);
        else if (e.type === 'save') saver.saveNow(e.kind);
        else if (e.type === 'junction') {
          // 選んだらすぐ走り出せるように、次の区間のデータを先に読んでおく
          for (const r of e.routes) loadSegment(r.segmentId).catch(() => {});
          setJunction(e.routes);
          setPaused(true);
          if (!demo) client.pause().catch(() => {});
        } else if (e.type === 'finish') finish(e.reason);
      }
    }

    // ---- 1日を終える ----
    async function finish(reason) {
      if (ended) return;
      ended = true;
      const { trip: t, failed } = session.endDay(reason);
      if (failed) await store.save(t, 'dayEnd').catch(() => {});
      else await saver.saveNow('rideEnd');
      onEnd(t, reason);
    }

    // 見どころで撮る写真: 次に景色を描いた直後に canvas から撮る(描いたあとに消える canvas のため)
    let photoPending = null;
    function takePhoto() {
      const p = photoPending;
      photoPending = null;
      const dataUrl = captureThumbnail(canvasRef.current);
      if (!dataUrl) return;
      sharedPhotoStore().put({ tripId: session.trip.tripId, placeId: p.id, name: p.name, day: session.trip.day, dataUrl })
        .then(() => toast(`写真帳に「${p.name}」の写真を残した。`)).catch(() => {});
    }

    // 走行中の操作(ボタン)から使う
    ctxRef.current = {
      finish,
      eat(place, item) { session.eat(place, item); handle(session.drainEvents()); },
      visit(place) {
        session.visit(place, SIGHT_VISIT_MINUTES);
        if (scene) photoPending = place;
        handle(session.drainEvents());
      },
      help(place) { session.help(place); handle(session.drainEvents()); },
      snack() { session.snack(); handle(session.drainEvents()); },
      dismissPrompt() { session.dismissPrompt(); handle(session.drainEvents()); },
      /** 分かれ道で次の区間を選ぶ: 走行の記録はそのまま、新しい区間で走行画面を作り直す。 */
      async continueOn(segmentId) {
        if (ended) return;
        ended = true;
        const t = session.continueOn(segmentId);
        await store.save(t, 'event').catch(() => {});
        onEnd(t, 'continue');
      },
      togglePause() {
        const on = !session.running;
        if (!session.setRunning(on)) return;
        setPaused(!on);
        if (!demo) (on ? client.resume() : client.pause()).catch(() => {});
        handle(session.drainEvents());
      },
      /** 走行画面のまま、トレーナーにつなぎ直す(ボタンを押したときだけ。機器の選択が出る)。 */
      async reconnect() {
        setReconnecting(true);
        try {
          await client.connect();
          session.trainerRestored();
          setOffline(false);
          setWarning(null);
          client.pause().catch(() => {}); // 「走り出す」を押すまでは休憩のまま
        } catch (e) {
          setWarning(`つなぎ直せませんでした: ${e.message}`);
        } finally {
          setReconnecting(false);
        }
      },
    };

    // ---- 時間を進める: 描画のタイミングで進め、タブが裏にある間はタイマーで進める ----
    let lastSim = performance.now();
    function simulate(now) {
      const events = session.advance((now - lastSim) / 1000);
      lastSim = now;
      if (!demo && client.isConnected && session.running) {
        if (client.controlMode === 'erg') client.setErgTarget(session.ergTargetWatts());
        else client.setGrade(session.trainerGradePercent());
      }
      handle(events);
    }
    const hiddenTimer = setInterval(() => {
      if (document.hidden) simulate(performance.now());
    }, HIDDEN_TICK_MS);
    // タブを閉じる・裏に回るときは、その時点を保存する(30 秒ごとの自動保存を待たない)
    const onHide = () => { if (document.visibilityState === 'hidden' && !ended) saver.saveNow('event'); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    let lastHud = 0;
    let lastMap = 0;
    let raf = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      simulate(now);
      const v = session.view();
      scene?.draw({
        segmentM: v.segM, speedKmh: v.speedKmh, gradePercent: v.grade,
        weatherKind: v.weatherKind, clockMinutes: v.clock, cadenceRpm: v.cadence,
      });
      if (photoPending && scene) takePhoto();
      if (sound && now - lastSound > 100) {
        lastSound = now;
        const speedKmh = session.running ? v.speedKmh : 0;
        sound.update(soundMix({
          speedKmh, unpaved: v.unpaved, seaSide, inTunnel: v.inTunnel, weatherKind: v.weatherKind, season: session.season, clockMinutes: v.clock,
        }), speedKmh);
      }
      if (now - lastMap > 500) {
        lastMap = now;
        mapApiRef.current?.draw(v.segM);
      }
      if (now - lastHud > 250) {
        lastHud = now;
        setHud(v);
        // 保存に失敗し続けていたら走行中に知らせる(書き出しを勧める)
        setSaveError(saver.lastError ? saver.lastError.message ?? String(saver.lastError) : null);
        if (SHOW_PERF) setPerf(scene?.stats?.() ?? null);
      }
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(hiddenTimer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      saver.stop();
      wake.destroy();
      if (!demo) {
        client.removeEventListener('bike-data', onBike);
        client.removeEventListener('disconnected', onDisc);
        if (client.isConnected) client.endSession().catch(() => {});
      }
      alive = false;
      scene?.dispose();
      sceneRef.current = null;
      canvasRef.current?.remove();
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
  const t = sessionRef.current?.trip;
  // 航空写真を地面に貼るのは 最高・高 の実在の景色だけ(そのときだけ出典に出す)
  const photoOn = !!scenery && (activeTier === 'high' || activeTier === 'ultra');
  // 上の帯(旅の計器)・景色・下の帯(旅の道具)の3段。帯には景色を重ねない
  return h('div', { className: `ride${hudOpen ? ' hud-open' : ''}${toolsOpen ? ' tools-open' : ''}` },
    h(Hud, {
      hud, ftpW: t?.rider.ftpW ?? 200, demo, day: t?.day ?? initialTrip.day, title: segment.name,
      onToggle: () => setHudOpen((v) => !v),
    }),
    // 景色の canvas は走行画面をまたいで使い回すので、mount 時にこの枠へ差し込む
    h('div', { className: 'ride-stage', ref: stageRef },
    h('div', { className: 'toasts' },
      offline && !demo && h('div', { className: 'toast warn' },
        'トレーナーとの接続が切れました。止まって休憩しています(旅の時計も止まっています。ここまでの旅は保存されています)。 ',
        h('button', { onClick: () => ctx?.reconnect(), disabled: reconnecting }, reconnecting ? '接続中...' : 'つなぎ直す')),
      warning && h('div', { className: 'toast' }, warning),
      saveError && h('div', { className: 'toast warn' }, `旅を保存できていません(${saveError})。ホームの「設定と記録」から書き出しておいてください。`),
      paused && !warning && !offline && !junction && h('div', { className: 'toast' }, '休憩中(旅の時間は早回しなしで実際の時間どおりに進み、体力が少しずつ戻ります)'),
      scenery === undefined && h('div', { className: 'toast' }, '景色を読み込み中…'),
      toasts.map((x) => h('div', { key: x.id, className: 'toast' }, x.text))),
    showMap && h(RideMap, { segment, scenery: scenery ?? null, apiRef: mapApiRef }),
    perf && h(PerfPanel, { perf }),
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
      onEat: (item) => ctx.eat(prompt, item),
      onVisit: () => ctx.visit(prompt),
      onHelp: () => ctx.help(prompt),
      onStay: () => { ctx.dismissPrompt(); ctx.finish('stop'); },
      onClose: () => ctx.dismissPrompt(),
    })),
    h('div', { className: 'attribution' }, scenery
      ? `${scenery.attribution}${photoOn ? '・地理院タイル(シームレス空中写真)' : ''}`
      : (segment.attribution ?? ''))),
    h('div', { className: 'ride-bar' },
      h('button', { className: 'primary', onClick: () => ctx?.togglePause(), disabled: !!junction || (offline && !demo && paused) }, paused ? '走り出す' : '休憩する'),
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

/** ?perf=1 のときの描画の重さ(1フレームの間隔・描画の処理時間・描画命令と三角形の数)。 */
function PerfPanel({ perf }) {
  const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
  return h('div', { className: 'perf-panel' },
    `${f(1000 / perf.frameMs, 0)} fps(${f(perf.frameMs)} ms)・描画の処理 ${f(perf.drawMs)} ms`,
    h('br'), `描画命令 ${perf.calls}・三角形 ${(perf.triangles / 1e3).toFixed(0)} 千・${perf.tier}・画素 ×${f(perf.pixelRatio, 2)}・${perf.backend}`);
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
    cell('旅の時刻', fmtClock(hud.clock), h('span', null, ` ${hud.weather}・日の入り ${fmtClock(hud.sunset)}`)),
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
    h('div', { className: 'muted' }, 'この先どちらへ行く?(選ぶまでは休憩していて、旅の時計も止まっています)'),
    routes.map((r) => h('div', { key: r.segmentId, className: 'row' },
      h('button', { className: r.back ? '' : 'primary', onClick: () => onChoose(r.segmentId) }, routeLabel(r)))),
    h('div', { className: 'row' }, h('button', { onClick: onStay }, `${here}で今日の宿を探す`)));
}

function PlacePrompt({ place, trip, onEat, onVisit, onHelp, onStay, onClose }) {
  const work = HELP_WORK.kinds[place.kind];
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
      work && canHelp(trip, place) && h('button', { onClick: onHelp, title: `体力 -${HELP_WORK.stamina}・満腹度 -${HELP_WORK.satiety}` },
        `手伝う(${HELP_WORK.minutes} 分・お礼 ${work.yen.toLocaleString()} 円)`),
      h('button', { onClick: onClose }, '通り過ぎる')));
}
