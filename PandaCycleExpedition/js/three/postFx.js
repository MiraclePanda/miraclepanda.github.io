// 描画の仕上げ(ポストエフェクト)。描画品質「高」「最高」だけで使う。
//
// 景色をいったん HDR(半精度浮動小数)の画面外バッファへ描き、
//   1. 明るい所だけを抜き出して縮小・ぼかし(光のにじみ = ブルーム。海のきらめき・日なたの白壁・街灯)
//   2. 元の絵に重ね、彩度・コントラストを少し整え、画面の四隅をわずかに暗くする(周辺減光)
//   3. 最後にトーンマッピング(renderer.toneMapping)と sRGB 変換をして画面へ出す
// の順で仕上げる。画面外バッファは MSAA(4 サンプル)なので、直接描くときと同じく縁はなめらか。
//
// three.js の examples(EffectComposer 等)は素の 'three' を import していて importmap なしでは
// 読めないため、three.js 本体だけで書いている。
// 使い方: 毎フレーム begin(有効か) → いつも通り renderer.clear()/render() → end()。
// 無効のときは begin が画面へ直接描くように戻すだけで、何も足さない。
import THREE from './three.js';

/** 光のにじみ・色の整えの強さ。値は見た目で決めた(物理・トレーナーには関係しない)。 */
export const POST_FX = {
  bloomThreshold: 1.0, // これより明るい(トーンマッピング前の線形の輝度)所がにじむ
  bloomKnee: 0.5, // しきい値のまわりをなめらかにする幅
  bloomStrength: 0.22,
  saturation: 1.08,
  contrast: 1.04,
  vignette: 0.22, // 四隅をどれだけ暗くするか(0 = なし)
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// 明るい所を抜き出す(ソフトしきい値)。半分の解像度へ縮めながら 4 点平均でちらつきを抑える。
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = 0.25 * (
    texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb +
    texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb +
    texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb +
    texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb);
  float l = max(c.r, max(c.g, c.b));
  float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * w, vec3(16.0)), 1.0);
}`;

// 9 タップのガウスぼかし(線形補間を使って 5 回の読み出しで済ませる)。uDir で縦横を切り替える。
const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

// 合成して画面へ。tonemapping/colorspace の chunk は、画面へ描くときに renderer の設定で中身が決まる。
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float uBloom;
uniform float uSaturation;
uniform float uContrast;
uniform float uVignette;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  c += uBloom * (texture2D(tBloom1, vUv).rgb + 0.8 * texture2D(tBloom2, vUv).rgb);
  // コントラストは中間の明るさ(線形 0.18)を軸に、彩度は輝度を軸に少しだけ強める
  c = max(vec3(0.0), 0.18 * pow(max(c, vec3(0.0)) / 0.18, vec3(uContrast)));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(vec3(0.0), mix(vec3(l), c, uSaturation));
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  c *= 1.0 - uVignette * smoothstep(0.35, 1.0, dot(d, d) * 2.2);
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{begin(enabled:boolean):void, end():void, dispose():void}}
 */
export function createPostFx(renderer) {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);

  const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
  let sceneRT = null;
  const half = [new THREE.WebGLRenderTarget(1, 1, rtOpts), new THREE.WebGLRenderTarget(1, 1, rtOpts)];
  const quarter = [new THREE.WebGLRenderTarget(1, 1, rtOpts), new THREE.WebGLRenderTarget(1, 1, rtOpts)];
  const size = new THREE.Vector2();
  let w = 0;
  let h = 0;

  const pass = (fragmentShader, uniforms, toneMapped = false) => new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped,
  });
  const bright = pass(BRIGHT_FRAG, {
    tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
    uThreshold: { value: POST_FX.bloomThreshold }, uKnee: { value: POST_FX.bloomKnee },
  });
  const blur = pass(BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
  const composite = pass(COMPOSITE_FRAG, {
    tScene: { value: null }, tBloom1: { value: half[0].texture }, tBloom2: { value: quarter[0].texture },
    uBloom: { value: POST_FX.bloomStrength }, uSaturation: { value: POST_FX.saturation },
    uContrast: { value: POST_FX.contrast }, uVignette: { value: POST_FX.vignette }, uAspect: { value: 1 },
  }, true);

  let active = false;

  function ensureSize() {
    renderer.getDrawingBufferSize(size);
    const nw = Math.max(1, Math.floor(size.x));
    const nh = Math.max(1, Math.floor(size.y));
    if (sceneRT && nw === w && nh === h) return;
    w = nw;
    h = nh;
    if (!sceneRT) {
      sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
      composite.uniforms.tScene.value = sceneRT.texture;
    } else {
      sceneRT.setSize(w, h);
    }
    for (const t of half) t.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    for (const t of quarter) t.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    composite.uniforms.uAspect.value = w / h;
  }

  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  }

  /** 横・縦の順にぼかす(結果は pair[0])。 */
  function blurPair(pair) {
    const [a, b] = pair;
    blur.uniforms.tSrc.value = a.texture;
    blur.uniforms.uDir.value.set(1 / a.width, 0);
    draw(blur, b);
    blur.uniforms.tSrc.value = b.texture;
    blur.uniforms.uDir.value.set(0, 1 / a.height);
    draw(blur, a);
  }

  return {
    /** これから描く景色の行き先を決める(有効なら画面外バッファ、無効なら画面)。 */
    begin(enabled) {
      active = !!enabled;
      if (active) ensureSize();
      renderer.setRenderTarget(active ? sceneRT : null);
    },
    /** 有効なら仕上げをして画面へ出す。 */
    end() {
      if (!active) return;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      bright.uniforms.tSrc.value = sceneRT.texture;
      bright.uniforms.uTexel.value.set(1 / w, 1 / h);
      draw(bright, half[0]);
      blurPair(half);
      blur.uniforms.tSrc.value = half[0].texture;
      blur.uniforms.uDir.value.set(0, 0); // 縮小だけ(ぼかし幅 0 = そのまま写す)
      draw(blur, quarter[0]);
      blurPair(quarter);
      blurPair(quarter);
      draw(composite, null);
      renderer.autoClear = autoClear;
    },
    dispose() {
      sceneRT?.dispose();
      for (const t of [...half, ...quarter]) t.dispose();
      for (const m of [bright, blur, composite]) m.dispose();
      quad.geometry.dispose();
    },
  };
}
