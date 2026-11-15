// 描画の方式(WebGPU / WebGL)を選ぶ。
//
// どちらで描くかはホームの「描画の方式」で選ぶ(prefs.js の loadGpuBackend。既定は WebGL)。
// 前は WebGPU を使える端末では WebGPU で描いていたが、three.js の WebGPU 用の描き方は1つの物を描くたびの
// CPU の手間が大きく(ヘッドレスで同じ景色を描いて CPU の時間が WebGL の約 4 倍)、Intel N100 のパソコンでは
// WebGL のほうが約 1.5 倍速かった(2026-11-15、ユーザーの実機)。WebGPU を選んでも使えない端末では WebGL で描く。
// ソフトウェアで動く代替の GPU(isFallbackAdapter)は遅いので選ばない。
// URL の ?gpu=webgpu / ?gpu=webgl はホームの選択より優先する(確認用)。?gpu=webgpu-gl は WebGPU 用の描き方(ノード・TSL)を
// WebGL2 の上で動かす確認用(ヘッドレスのブラウザでは WebGPU の画面が出ないため)。
import { loadThreeWebGPU } from './three.js';

let gpuModule = null;

/** 読み込んだ WebGPU 版の three.js(createWebGPURenderer が成功した後だけ。無ければ null)。 */
export function threeWebGPU() {
  return gpuModule;
}

function forcedBackend() {
  try {
    const v = new URLSearchParams(window.location.search).get('gpu');
    return ['webgpu', 'webgl', 'webgpu-gl'].includes(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * WebGPU が使えれば、canvas に WebGPURenderer を作って初期化まで済ませて返す。使えなければ null
 * (呼び出し側は WebGL で描く)。失敗しても例外は投げない。
 * @returns {Promise<object|null>} WebGPURenderer
 */
export async function createWebGPURenderer(canvas) {
  const forced = forcedBackend();
  if (forced === 'webgl') return null;
  try {
    if (forced === 'webgpu-gl') {
      const W = await loadThreeWebGPU();
      const renderer = new W.WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
      await renderer.init();
      gpuModule = W;
      return renderer;
    }
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    if (adapter.info?.isFallbackAdapter && forced !== 'webgpu') return null;
    const W = await loadThreeWebGPU();
    const renderer = new W.WebGPURenderer({ canvas, antialias: true });
    await renderer.init();
    // WebGPU を作れず WebGL2 に切り替わった場合は使わない(今の WebGL の描き方の方が速い)
    if (!renderer.backend?.isWebGPUBackend) {
      renderer.dispose();
      return null;
    }
    gpuModule = W;
    return renderer;
  } catch {
    return null;
  }
}

// ---- 走行画面をまたいで使い回す canvas と描画の土台 ----
// 走行画面は区間ごと(分かれ道で次の区間へ進むたび)に作り直すが、canvas と描画の土台(WebGL の文脈・WebGPU の
// 機器)は使い回す。作り直すと、そのたびに文脈・機器の準備で止まり、ブラウザによっては文脈の数の上限
// (古いものから捨てられる)にも当たる。WebGPU と WebGL は同じ canvas では使えないので、canvas は方式ごとに分ける。

/**
 * 走行画面で WebGPU を試すか。URL の ?gpu= があればそれ、無ければホームで選んだ方式 choice('webgl' | 'webgpu')。
 */
export function wantsWebGPU(choice) {
  const forced = forcedBackend();
  if (forced) return forced !== 'webgl';
  return choice === 'webgpu';
}

/** この端末のブラウザに WebGPU があるか(ホームの選択欄の注意書き用。実際に使えるかは作ってみるまで分からない)。 */
export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

const canvases = {};
/** 方式('webgpu' | 'webgl')ごとの、使い回す景色の canvas。 */
export function sceneCanvas(kind) {
  canvases[kind] ??= document.createElement('canvas');
  return canvases[kind];
}

let gpuRendererPromise = null;
/**
 * 使い回す WebGPURenderer(初期化済み)。WebGPU を使えなければ null。機器を失ったら次の呼び出しで作り直す。
 * @returns {Promise<object|null>}
 */
export function sharedWebGPURenderer() {
  gpuRendererPromise ??= createWebGPURenderer(sceneCanvas('webgpu')).then((r) => {
    if (r) {
      r.onDeviceLost = () => {
        gpuRendererPromise = null;
        delete canvases.webgpu;
      };
    }
    return r;
  });
  return gpuRendererPromise;
}
