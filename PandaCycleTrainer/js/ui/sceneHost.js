// 3D の景色(CityScene / LandscapeScene / PondScene / AtamiScene / RealTownScene)に共通の React 側の仕組み
// (レビュー Q6)。以前は5つの景色がそれぞれ同じ処理を写して持っていたので、直すたびに5か所を揃える必要があった。
//
// - レンダラーを用意して組み立て(startSceneRenderer)、品質・走行環境・視点を当て、画面の大きさに合わせる
// - draw() の例外を受けて「3D表示を利用できません」にし、走行は景色なしで続ける(準備完了として知らせる)
// - 3D の描画(WebGL の文脈・WebGPU の機器)が失われたら、新しい canvas で組み立て直す(レビュー Q12)。
//   WebGPU の初期化に失敗したときも、新しい canvas で WebGL として組み立て直す(レビュー Q13)
// - URL に ?perf=1 を付けたときは、1フレームの間隔・描画の処理時間を測る(stats()。走行画面の計測の表示)
//
// 景色ごとに違うのは、組み立て(build)・毎フレームの描画(draw)・景色固有の後片付け(dispose)だけ。
// 走行中の値は React の state を通さず、ref の draw() に直接渡す(毎フレームの再描画を避ける。CLAUDE.md)。

import { h, useRef, useEffect, useState } from './h.js';
import { startSceneRenderer } from '../three/gpuBackend.js';
import {
  setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene, reportReadyAfterDraw,
  frameStatsBegin, frameStatsEnd, sceneStats,
} from '../three/sceneKit.js';
import { normalizeCameraView } from '../three/cameraViews.js';

const { useImperativeHandle } = React;

/** 3D の描画が失われたときに組み立て直す回数の上限(これを超えたら景色なしで走る)。 */
const MAX_REBUILDS = 3;

/** URL に ?perf=1 を付けたときだけ、描画の重さを測る。 */
export const SHOW_PERF = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('perf') === '1';
  } catch {
    return false;
  }
})();

const RENDER_ERROR_TEXT = '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。';

/**
 * @param {object} ref forwardRef の ref(draw / resize / stats を持たせる)
 * @param {object} props 景色の props(qualityMode, environment, cameraView, onQualityChange, onReady)
 * @param {object} spec
 * @param {boolean} [spec.enabled=true] 組み立ててよいか(コースが無いうちは false)
 * @param {boolean} [spec.allowCine=true] 視点「シネマ」を使えるか(池は使わない)
 * @param {(canvas: HTMLCanvasElement, renderer: object, host: object) => object} spec.build
 *   景色を組み立てて状態 st を返す。host は { live, attributionEl, onReady, setRenderError, setDataError }
 * @param {(st: object, args: object) => void} spec.draw 1フレームを描く
 * @param {(st: object) => void} [spec.dispose] disposeScene の前に呼ぶ景色固有の後片付け
 */
export function useSceneHost(ref, props, spec) {
  const { qualityMode, environment, cameraView } = props;
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const attributionRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
  const [dataError, setDataError] = useState(false);
  // 組み立て直しの回(canvas の key。変わると新しい canvas で組み立て直す)と、その間の案内
  const [generation, setGeneration] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const rebuildsRef = useRef(0);
  const specRef = useRef(spec);
  specRef.current = spec;
  // 品質段階の変化(自動調整による段階変更を含む)を親へ通知する。最新のコールバックを参照するため ref で持つ
  const onQualityChangeRef = useRef(props.onQualityChange);
  onQualityChangeRef.current = props.onQualityChange;
  // 景色の準備ができたら知らせる(RideScreen はそれまで走行を始めない。2回目以降は RideScreen が無視する)
  const onReadyRef = useRef(props.onReady);
  onReadyRef.current = props.onReady;
  // 組み立てのときの最新の値(WebGPU の初期化を待つ間に変わってもよいように ref で読む)
  const live = useRef({});
  live.current = { qualityMode, environment, cameraView };
  const allowCine = spec.allowCine ?? true;
  const enabled = spec.enabled ?? true;

  // 3D 表示が使えない(WebGL の初期化・描画の失敗)ときは景色なしで走れるよう、準備完了として知らせる
  useEffect(() => {
    if (renderError) onReadyRef.current?.();
  }, [renderError]);

  useImperativeHandle(ref, () => ({
    draw(args) {
      const s = sceneRef.current;
      if (!s || s.lost) return;
      try {
        if (SHOW_PERF) frameStatsBegin(s);
        adaptQuality(s);
        specRef.current.draw(s, args);
        reportReadyAfterDraw(s);
        if (SHOW_PERF) frameStatsEnd(s);
      } catch (err) {
        // 実行時の描画の失敗でアプリ全体を巻き込まない(走行と記録は続ける)
        console.error('3D の描画に失敗しました:', err);
        setRenderError(String(err));
      }
    },
    /** フルスクリーン切替などでキャンバスの表示サイズが変わった時に呼ぶ。 */
    resize() {
      if (sceneRef.current) resizeScene(sceneRef.current);
    },
    /** 直近の描画の重さ(?perf=1 のときだけ測る)。 */
    stats() {
      return sceneRef.current ? sceneStats(sceneRef.current) : null;
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return undefined;
    // 新しい canvas で組み立て直す(描画が失われた・WebGPU の初期化に失敗した)
    const rebuild = (reason) => {
      if (rebuildsRef.current >= MAX_REBUILDS) {
        setRenderError(reason);
        return;
      }
      rebuildsRef.current++;
      setGeneration((g) => g + 1);
    };
    return startSceneRenderer(canvas, (renderer) => {
      let st;
      try {
        st = specRef.current.build(canvas, renderer, {
          live: live.current,
          attributionEl: attributionRef.current,
          onReady: () => onReadyRef.current?.(),
          setRenderError,
          setDataError,
        });
      } catch (err) {
        console.error('3D の景色を組み立てられませんでした:', err);
        setRenderError(String(err));
        return undefined;
      }
      sceneRef.current = st;
      const v = live.current;
      st.attributionEl ??= attributionRef.current;
      st.onReady = () => onReadyRef.current?.();
      st.onQualityChange = (tierName) => onQualityChangeRef.current?.(tierName);
      st.appliedQualityMode = v.qualityMode;
      st.envSetting = v.environment;
      st.env?.set(v.environment, { immediate: true });
      st.cam.view = normalizeCameraView(v.cameraView, allowCine);
      setupQuality(st, v.qualityMode);
      setRebuilding(false);

      const resize = () => resizeScene(st);
      window.addEventListener('resize', resize);
      // 描画が失われた: WebGL の文脈(GPU のリセット・メモリ不足・長時間の裏)/ WebGPU の機器
      const onLost = (e) => {
        e?.preventDefault?.();
        if (st.lost || st.disposed) return;
        st.lost = true;
        console.warn('3D の描画が失われたので、組み立て直します');
        setRebuilding(true);
        rebuild('3D の描画が繰り返し失われました');
      };
      canvas.addEventListener('webglcontextlost', onLost);
      if (renderer.isWebGPURenderer) renderer.onDeviceLost = onLost;

      return () => {
        window.removeEventListener('resize', resize);
        canvas.removeEventListener('webglcontextlost', onLost);
        st.disposed = true;
        try {
          specRef.current.dispose?.(st);
          disposeScene(st);
        } catch (err) {
          // 失われた描画の後片付けは失敗してもよい(新しい canvas で作り直す)
          console.warn('3D の景色の後片付けに失敗しました:', err);
        }
        if (sceneRef.current === st) sceneRef.current = null;
      };
    }, (err) => setRenderError(String(err)), () => rebuild('WebGPU の初期化に失敗しました'));
  }, [generation, enabled]);

  // 走行中に描画品質のモードが変更されたら適用する(初回は setupQuality で適用済み)。
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || s.appliedQualityMode === qualityMode) return;
    s.appliedQualityMode = qualityMode;
    setQualityMode(s, qualityMode);
  }, [qualityMode]);

  // 走行中に時間帯・天候が変わったら、空を焼き直し、光・霧などを約1.5秒かけて切り替える。
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.envSetting = environment;
    s.env?.set(environment);
  }, [environment?.time, environment?.weather]);

  // 視点の切り替え(即時)。次の draw() から反映される。
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.cam.view = normalizeCameraView(cameraView, allowCine);
  }, [cameraView]);

  /**
   * 景色の外枠(canvas・出典・案内)。canvasProps は canvas の属性(data-scenery など)。
   * @param {object} canvasProps
   * @param {{attribution?: boolean|'hidden', dataErrorText?: string}} [opts]
   */
  const shell = (canvasProps, opts = {}) => h(
    'div', { className: 'city-scene-wrap' },
    h('canvas', { key: generation, ref: canvasRef, className: 'city-scene-canvas', ...canvasProps }),
    opts.attribution && h('div', { ref: attributionRef, className: 'scene-attribution', hidden: opts.attribution === 'hidden' }),
    dataError && opts.dataErrorText && h('div', { className: 'city-scene-fallback' }, opts.dataErrorText),
    rebuilding && !renderError && h('div', { className: 'city-scene-fallback scene-rebuilding' }, '3D表示を作り直しています…(走行と記録は続いています)'),
    renderError && h('div', { className: 'city-scene-fallback' }, RENDER_ERROR_TEXT)
  );

  return { shell, sceneRef };
}
