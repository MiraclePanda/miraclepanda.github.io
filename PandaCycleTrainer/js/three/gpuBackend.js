// 描画の方式(WebGPU / WebGL)を選ぶ。
//
// どちらで描くかは設定画面の「描画の方式」で選ぶ(prefs.js の loadGpuBackend。既定は WebGL。端末ごとに覚える)。
// 前は WebGPU を使える端末では WebGPU で描いていたが、three.js の WebGPU 用の描き方は1つの物を描くたびの
// CPU の手間が大きく、PandaCycleExpedition の確認では Intel N100 のパソコンで WebGL のほうが約 1.5 倍速かった
// (2026-11-15、ユーザーの実機)。WebGPU を選んでも使えない端末では WebGL で描く。
// ソフトウェアで動く代替の GPU(isFallbackAdapter)は遅いので選ばない。
// 判定は起動時と、方式を選び直したとき(prepareGpuBackend)。景色は startSceneRenderer でレンダラーを受け取る。
//
// WebGPU では GLSL の差し替え(onBeforeCompile)や ShaderMaterial が使えないので、独自の描き方
// (建物の窓・ゴースト・水面の映り込み・海底の光と昆布・遠景の実在の地形・仕上げのエフェクト)は
// それぞれのファイルで TSL(three.js のノードの書き方)版も持つ。threeWebGPU() が null でなければ TSL 版も用意する
// (WebGL のレンダラーは *Node の設定を無視し、WebGPU のレンダラーは onBeforeCompile を無視するので、両方持たせてよい)。
// 空(sceneKit.js の bakeSky)だけは GLSL のまま、画面に出さない WebGL で焼いて WebGPU に渡す。
//
// URL の ?gpu=webgpu / ?gpu=webgl は設定画面の選択より優先する(確認用)。?gpu=webgpu-gl は WebGPU 用の描き方(ノード・TSL)を
// WebGL2 の上で動かす確認用(ヘッドレスのブラウザでは WebGPU の画面が出ないため)。
import THREE, { loadThreeWebGPU } from './three.js';

let decided = null; // 'webgpu' | 'webgpu-gl' | 'webgl'(決まるまで null)
let pending = null;
let gpuModule = null;
let wanted = null; // いま決めている(決めた)方式の希望('webgpu' | 'webgpu-gl' | 'webgl')

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

/** want('webgpu' | 'webgpu-gl')で描けるかを確かめ、使う方式と(WebGPU なら)three.js の WebGPU 版を返す。 */
async function detect(want) {
  const forced = forcedBackend();
  try {
    if (want !== 'webgpu-gl') {
      if (!navigator.gpu) return { mode: 'webgl', module: null };
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { mode: 'webgl', module: null };
      const fallback = adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter;
      if (fallback && forced !== 'webgpu') return { mode: 'webgl', module: null };
    }
    return { mode: want, module: await loadThreeWebGPU() };
  } catch (err) {
    console.warn('WebGPU を使えないので WebGL で描きます:', err);
    return { mode: 'webgl', module: null };
  }
}

/** 走行画面で WebGPU を試すか。URL の ?gpu= があればそれ、無ければ設定画面で選んだ方式 choice('webgl' | 'webgpu')。 */
export function wantsWebGPU(choice) {
  const forced = forcedBackend();
  if (forced) return forced !== 'webgl';
  return choice === 'webgpu';
}

/** この端末のブラウザに WebGPU があるか(設定画面の選択欄の表示用。実際に使えるかは作ってみるまで分からない)。 */
export function hasWebGPU() {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * 描画の方式を決める。choice は設定画面の「描画の方式」('webgl' | 'webgpu')。URL の ?gpu= があればそちらを使う。
 * 起動時と、方式を選び直したときに呼ぶ(同じ希望なら何度呼んでもよい)。次に組み立てる景色から使われる。
 */
export function prepareGpuBackend(choice = 'webgl') {
  const forced = forcedBackend();
  const want = forced ?? (choice === 'webgpu' ? 'webgpu' : 'webgl');
  if (want === wanted && (decided || pending)) return decided ? Promise.resolve(decided) : pending;
  wanted = want;
  decided = null;
  gpuModule = null;
  pending = null;
  // WebGL、または WebGPU の無いブラウザでは待たずに決める(景色をすぐ組み立てられるように)
  if (want === 'webgl' || (want === 'webgpu' && !hasWebGPU())) {
    decided = 'webgl';
    return Promise.resolve(decided);
  }
  const p = detect(want).then(({ mode, module }) => {
    // 待つ間に選び直されたら、新しい方の結果だけを使う
    if (pending !== p) return decided ?? mode;
    pending = null;
    decided = mode;
    gpuModule = module;
    return mode;
  });
  pending = p;
  return p;
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
 * @param {() => void} [onRetry] WebGPU の初期化に失敗したとき。一度 WebGPU に使った canvas では WebGL を作れない
 *   ことがあるので、渡されていれば新しい canvas で組み直してもらう(以後は WebGL。レビュー Q13)。
 *   渡されていなければ同じ canvas で WebGL を試す
 * @returns {() => void}
 */
export function startSceneRenderer(canvas, mount, onError, onRetry) {
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
      if (onRetry) {
        onRetry();
        return;
      }
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
  else (pending ?? prepareGpuBackend()).then(start);
  return () => {
    alive = false;
    cleanup?.();
  };
}
