// 描画の方式(WebGPU / WebGL)を選ぶ。
//
// WebGPU を使える端末(多くのパソコン、Android 12 以上の一部)では WebGPU で描き、使えなければ今まで通り
// WebGL で描く。WebGPU は描く物が多い場面(森の木、建物)で CPU の負担が軽い。
// ソフトウェアで動く代替の GPU(isFallbackAdapter)は遅いので選ばない。
// URL の ?gpu=webgpu / ?gpu=webgl で固定できる(確認用)。?gpu=webgpu-gl は WebGPU 用の描き方(ノード・TSL)を
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
