// 描画の方式(WebGPU / WebGL)を選ぶ。
//
// WebGPU を使える端末(多くのパソコン、Android 12 以上の一部)では WebGPU で描き、使えなければ今まで通り
// WebGL で描く。WebGPU は描く物が多い場面(実在の街の建物・木、森)で CPU の負担が軽い。
// ソフトウェアで動く代替の GPU(isFallbackAdapter)は遅いので選ばない。
// 判定はアプリの起動時に一度だけ(prepareGpuBackend)。景色は startSceneRenderer でレンダラーを受け取る。
//
// WebGPU では GLSL の差し替え(onBeforeCompile)や ShaderMaterial が使えないので、独自の描き方
// (建物の窓・ゴースト・水面の映り込み・海底の光と昆布・遠景の実在の地形・仕上げのエフェクト)は
// それぞれのファイルで TSL(three.js のノードの書き方)版も持つ。threeWebGPU() が null でなければ TSL 版も用意する
// (WebGL のレンダラーは *Node の設定を無視し、WebGPU のレンダラーは onBeforeCompile を無視するので、両方持たせてよい)。
// 空(sceneKit.js の bakeSky)だけは GLSL のまま、画面に出さない WebGL で焼いて WebGPU に渡す。
//
// URL の ?gpu=webgpu / ?gpu=webgl で固定できる(確認用)。?gpu=webgpu-gl は WebGPU 用の描き方(ノード・TSL)を
// WebGL2 の上で動かす確認用(ヘッドレスのブラウザでは WebGPU の画面が出ないため)。
import THREE, { loadThreeWebGPU } from './three.js';

let decided = null; // 'webgpu' | 'webgpu-gl' | 'webgl'(決まるまで null)
let pending = null;
let gpuModule = null;

/** 読み込んだ WebGPU 版の three.js(WebGPU で描くと決まった後だけ。WebGL なら null)。 */
export function threeWebGPU() {
  return gpuModule;
}

/** 決まった描画の方式('webgpu' / 'webgpu-gl' / 'webgl')。まだ決まっていなければ null。 */
export function gpuBackendMode() {
  return decided;
}

/**
 * WebGPU で、TSL のノードを持たせたマテリアルを他のマテリアルと取り違えないようにする。
 * WebGPURenderer はマテリアルの組み立て結果(テクスチャ・uniform の結びつけを含む)を、マテリアルの設定から作る
 * キーで使い回すが、ノードの中身(どのテクスチャ・どの uniform か)はキーに入らない。マテリアルごとに別のキーにする。
 */
export function uniqueNodeKey(material, tag) {
  material.customProgramCacheKey = () => `${tag}-${material.uuid}`;
}

function forcedBackend() {
  try {
    const v = new URLSearchParams(window.location.search).get('gpu');
    return ['webgpu', 'webgl', 'webgpu-gl'].includes(v) ? v : null;
  } catch {
    return null;
  }
}

async function detect() {
  const forced = forcedBackend();
  if (forced === 'webgl') return 'webgl';
  try {
    if (forced !== 'webgpu-gl') {
      if (!navigator.gpu) return 'webgl';
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return 'webgl';
      const fallback = adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
      if (fallback && forced !== 'webgpu') return 'webgl';
    }
    gpuModule = await loadThreeWebGPU();
    return forced === 'webgpu-gl' ? 'webgpu-gl' : 'webgpu';
  } catch (err) {
    console.warn('WebGPU を使えないので WebGL で描きます:', err);
    gpuModule = null;
    return 'webgl';
  }
}

/** 描画の方式を決める(何度呼んでもよい。アプリの起動時に呼んでおく)。 */
export function prepareGpuBackend() {
  if (decided) return Promise.resolve(decided);
  if (!pending) {
    // WebGPU の無いブラウザでは待たずに決める(景色をすぐ組み立てられるように)
    const forced = forcedBackend();
    if (forced === 'webgl' || (!forced && typeof navigator !== 'undefined' && !navigator.gpu)) {
      decided = 'webgl';
      return Promise.resolve(decided);
    }
    pending = detect().then((mode) => {
      decided = mode;
      return mode;
    });
  }
  return pending;
}

function createWebGL(canvas) {
  return new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
}

/**
 * 景色のレンダラーを用意して mount(renderer) を呼ぶ。WebGL ならその場で(同期)、WebGPU なら初期化を待ってから呼ぶ。
 * mount が返した後片付けの関数を含め、返り値の関数でまとめて片付けられる(useEffect の後片付けにそのまま返す)。
 * @param {HTMLCanvasElement} canvas
 * @param {(renderer: object) => (void|(() => void))} mount
 * @param {(err: unknown) => void} onError レンダラーを作れなかったとき
 * @returns {() => void}
 */
export function startSceneRenderer(canvas, mount, onError) {
  let alive = true;
  let cleanup = null;
  let renderer = null;
  const run = (r) => {
    if (!alive) {
      r.dispose();
      return;
    }
    canvas.dataset.gpu = r.isWebGPURenderer ? (r.backend?.isWebGPUBackend ? 'webgpu' : 'webgpu-gl') : 'webgl';
    cleanup = mount(r) ?? null;
  };
  const start = () => {
    if (!alive) return;
    if (decided === 'webgl' || !gpuModule) {
      try {
        renderer = createWebGL(canvas);
      } catch (err) {
        onError(err);
        return;
      }
      run(renderer);
      return;
    }
    const W = gpuModule;
    renderer = new W.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance', forceWebGL: decided === 'webgpu-gl' });
    renderer.init().then(
      () => {
        // WebGPU を作れず WebGPURenderer の中で WebGL2 に切り替わった場合は使わない(今の WebGL の描き方の方が速い)
        if (decided === 'webgpu' && !renderer.backend?.isWebGPUBackend) throw new Error('WebGPU の初期化に失敗');
        run(renderer);
      },
    ).catch((err) => {
      if (!alive) return;
      console.warn('WebGPU を使えないので WebGL で描きます:', err);
      try {
        renderer?.dispose();
      } catch {
        // 片付けの失敗は無視(この後 WebGL で作り直す)
      }
      // 以後の景色も WebGL で描く
      decided = 'webgl';
      gpuModule = null;
      try {
        renderer = createWebGL(canvas);
      } catch (e) {
        onError(e);
        return;
      }
      run(renderer);
    });
  };
  if (decided) start();
  else prepareGpuBackend().then(start);
  return () => {
    alive = false;
    cleanup?.();
  };
}
