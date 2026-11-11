// postFx.js(描画の仕上げ)の WebGPU 版。中身・強さ(POST_FX)・使い方(begin → 描く → end)は同じで、
// シェーダーを GLSL ではなく TSL(three.js のノードの書き方)で書いている。
// トーンマッピングと sRGB 変換は、画面へ描くときに WebGPURenderer が自動でかける。
import THREE from './three.js';
import { POST_FX } from './postFx.js';

/**
 * @param {object} renderer WebGPURenderer
 * @param {object} W WebGPU 版の three.js(threeWebGPU())
 */
export function createPostFxGpu(renderer, W) {
  const {
    Fn, texture, uv, uniform, vec2, vec3, vec4, float, max, min, clamp, mix, dot, pow, smoothstep,
  } = W.TSL;
  const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
  const sceneRT = new W.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const half = [new W.RenderTarget(1, 1, rtOpts), new W.RenderTarget(1, 1, rtOpts)];
  const quarter = [new W.RenderTarget(1, 1, rtOpts), new W.RenderTarget(1, 1, rtOpts)];
  const size = new THREE.Vector2();
  let w = 0;
  let h = 0;
  let active = false;

  const quad = new W.QuadMesh();
  const make = (fragment) => {
    const m = new W.NodeMaterial();
    m.fragmentNode = fragment;
    m.depthTest = false;
    m.depthWrite = false;
    return m;
  };

  // 明るい所を抜き出す(半分の解像度へ 4 点平均で縮める)
  const uTexel = uniform(new THREE.Vector2());
  const brightTex = texture(sceneRT.texture);
  const bright = make(Fn(() => {
    const p = uv();
    const c = brightTex.sample(p.add(uTexel.mul(vec2(-0.5, -0.5)))).rgb
      .add(brightTex.sample(p.add(uTexel.mul(vec2(0.5, -0.5)))).rgb)
      .add(brightTex.sample(p.add(uTexel.mul(vec2(-0.5, 0.5)))).rgb)
      .add(brightTex.sample(p.add(uTexel.mul(vec2(0.5, 0.5)))).rgb)
      .mul(0.25);
    const l = max(c.r, max(c.g, c.b));
    const knee = float(POST_FX.bloomKnee);
    const soft0 = clamp(l.sub(POST_FX.bloomThreshold).add(knee), 0, knee.mul(2));
    const soft = soft0.mul(soft0).div(knee.mul(4).add(1e-4));
    const k = max(soft, l.sub(POST_FX.bloomThreshold)).div(max(l, 1e-4));
    return vec4(min(c.mul(k), vec3(16)), 1);
  })());

  // 9 タップのガウスぼかし(入力のテクスチャと向きを差し替えて使い回す)
  const uDir = uniform(new THREE.Vector2());
  const blurTex = texture(half[0].texture);
  const blur = make(Fn(() => {
    const p = uv();
    const c = blurTex.sample(p).rgb.mul(0.2270270270)
      .add(blurTex.sample(p.add(uDir.mul(1.3846153846))).rgb.mul(0.3162162162))
      .add(blurTex.sample(p.sub(uDir.mul(1.3846153846))).rgb.mul(0.3162162162))
      .add(blurTex.sample(p.add(uDir.mul(3.2307692308))).rgb.mul(0.0702702703))
      .add(blurTex.sample(p.sub(uDir.mul(3.2307692308))).rgb.mul(0.0702702703));
    return vec4(c, 1);
  })());

  // 合成(光のにじみ・コントラスト・彩度・周辺減光)。画面へ出すときにトーンマッピングされる
  const uAspect = uniform(1);
  const composite = make(Fn(() => {
    const p = uv();
    let c = texture(sceneRT.texture).sample(p).rgb
      .add(texture(half[0].texture).sample(p).rgb.add(texture(quarter[0].texture).sample(p).rgb.mul(0.8)).mul(POST_FX.bloomStrength));
    c = pow(max(c, vec3(0)).div(0.18), vec3(POST_FX.contrast)).mul(0.18);
    const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = max(mix(vec3(l), c, POST_FX.saturation), vec3(0));
    const d = p.sub(0.5).mul(vec2(uAspect, 1));
    c = c.mul(float(1).sub(smoothstep(0.35, 1.0, dot(d, d).mul(2.2)).mul(POST_FX.vignette)));
    return vec4(c, 1);
  })());

  function ensureSize() {
    renderer.getDrawingBufferSize(size);
    const nw = Math.max(1, Math.floor(size.x));
    const nh = Math.max(1, Math.floor(size.y));
    if (nw === w && nh === h) return;
    w = nw;
    h = nh;
    sceneRT.setSize(w, h);
    for (const t of half) t.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    for (const t of quarter) t.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    uAspect.value = w / h;
  }

  function draw(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  }

  function blurPair([a, b]) {
    blurTex.value = a.texture;
    uDir.value.set(1 / a.width, 0);
    draw(blur, b);
    blurTex.value = b.texture;
    uDir.value.set(0, 1 / a.height);
    draw(blur, a);
  }

  return {
    begin(enabled) {
      active = !!enabled;
      if (active) ensureSize();
      renderer.setRenderTarget(active ? sceneRT : null);
    },
    end() {
      if (!active) return;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      // renderer.info.render は景色の描画の値のまま残す(postFx.js と同じ)
      const info = { ...renderer.info.render };
      uTexel.value.set(1 / w, 1 / h);
      draw(bright, half[0]);
      blurPair(half);
      blurTex.value = half[0].texture;
      uDir.value.set(0, 0); // 縮小だけ
      draw(blur, quarter[0]);
      blurPair(quarter);
      blurPair(quarter);
      draw(composite, null);
      Object.assign(renderer.info.render, info);
      renderer.autoClear = autoClear;
    },
    dispose() {
      sceneRT.dispose();
      for (const t of [...half, ...quarter]) t.dispose();
      for (const m of [bright, blur, composite]) m.dispose();
    },
  };
}
