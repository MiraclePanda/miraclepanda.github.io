// 映り込む水面(実験。描画品質「最高(実験)」で、熱海の海・湖畔/山岳/河口湖の湖・不忍池で使う)。
//
// 水面のマテリアルを差し替え、
// - 法線マップを大小2枚、別の向き・速さで流して重ね、波が動いて見えるようにする
// - 水面で鏡映しにしたカメラからシーン(空・ホテル・ヤシ・山並み)を半分の解像度で描いておき、
//   水面の各点を鏡のカメラへ投影した位置から読んで、波で揺らしながらフレネル(浅い角度ほど強く)で重ねる
// ので、ホテル街や空が海面に揺れて映る。シーンを毎フレームもう1回描くため重い(高性能なGPU向け)。
// 平面の水面(LandscapeScene の water。root の Y 回転だけを受ける)を前提にしている。
// WebGPU で描くときは同じ見た目を TSL で作る(oceanNodes)。映り込みは three.js の reflector(斜めの近接面で
// 水面より下を切る鏡のカメラ。本描画の中で自動で描かれる)を使うので、render() は時刻を進めるだけ。

import THREE from './three.js';
import { threeWebGPU, uniqueNodeKey } from './gpuBackend.js';

const REFLECTION_SCALE = 0.5; // 映り込み用の描画の解像度(画面に対する比)
const DISTORTION = 0.02; // 波による映り込みの揺れ
const REFLECT_STRENGTH = 0.65;

/**
 * @param {THREE.Mesh} water 水面(MeshStandardMaterial、normalMap 付き)
 * @returns {{ setEnabled(on: boolean): void, render(renderer, scene, camera, t: number): void, enabled: boolean, dispose(): void }}
 */
export function createOcean(water) {
  const baseMaterial = water.material;
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const mirror = new THREE.PerspectiveCamera();
  const mirrorVP = new THREE.Matrix4();
  const uniforms = {
    uReflection: { value: target.texture },
    uMirrorVP: { value: mirrorVP },
    uTime: { value: 0 },
    uDistortion: { value: DISTORTION },
    uReflectStrength: { value: REFLECT_STRENGTH },
  };

  const material = baseMaterial.clone();
  material.roughness = 0.05;
  material.normalScale = new THREE.Vector2(0.4, 0.4);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOceanWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvOceanWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vOceanWorld;
        uniform sampler2D uReflection;
        uniform mat4 uMirrorVP;
        uniform float uTime;
        uniform float uDistortion;
        uniform float uReflectStrength;`
      )
      // 細かいさざ波(元の法線マップ。模様は LandscapeScene が地面に固定して流す)+ 大きなうねり(別の向きへ流す)
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
        vec3 mapN2 = texture2D( normalMap, vNormalMapUv * 0.37 + vec2( uTime * 0.0061, - uTime * 0.0043 ) ).xyz * 2.0 - 1.0;
        mapN = vec3( ( mapN.xy + mapN2.xy * 0.6 ) * normalScale, 1.0 );
        normal = normalize( tbn * normalize( mapN ) );`
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        {
          vec4 clipR = uMirrorVP * vec4( vOceanWorld, 1.0 );
          vec2 ruv = clipR.xy / clipR.w * 0.5 + 0.5;
          ruv += normal.xy * uDistortion;
          // 海の色を少し乗せる(真っ白な空がそのまま映って氷のように見えないように)
          vec3 refl = texture2D( uReflection, clamp( ruv, 0.001, 0.999 ) ).rgb * mix( vec3( 1.0 ), diffuse * 2.2, 0.35 );
          float cosT = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
          float fresnel = 0.02 + 0.98 * pow( 1.0 - cosT, 5.0 );
          gl_FragColor.rgb = mix( gl_FragColor.rgb, refl, clamp( fresnel * uReflectStrength, 0.0, 1.0 ) );
        }`
      );
  };
  material.customProgramCacheKey = () => 'ocean-water-v1';
  const W = threeWebGPU();
  const gpu = W ? oceanNodes(W, material, water, uniforms) : null;

  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const size = new THREE.Vector2();
  const p = new THREE.Vector3();
  const d = new THREE.Vector3();
  const look = new THREE.Vector3();
  let enabled = false;

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      water.material = on ? material : baseMaterial;
      // WebGPU の鏡は水面の子に置いた target の位置・向きで映す(切っている間は外して描かせない)
      if (gpu) {
        if (on) water.add(gpu.target);
        else water.remove(gpu.target);
      }
    },
    /** 映り込みを描く(本描画の前に毎フレーム呼ぶ)。t は秒。 */
    render(renderer, scene, camera, t) {
      if (!enabled || !water.visible) return;
      uniforms.uTime.value = t;
      if (renderer.isWebGPURenderer) {
        if (gpu) gpu.time.value = t;
        return;
      }
      renderer.getDrawingBufferSize(size);
      const w = Math.max(1, Math.round(size.x * REFLECTION_SCALE));
      const hgt = Math.max(1, Math.round(size.y * REFLECTION_SCALE));
      if (target.width !== w || target.height !== hgt) target.setSize(w, hgt);

      // 水面で鏡映しにしたカメラ(水面の上下で位置と視線の上下を反転)
      water.updateWorldMatrix(true, false);
      const h = water.matrixWorld.elements[13];
      camera.updateMatrixWorld();
      camera.getWorldPosition(p);
      camera.getWorldDirection(d);
      mirror.copy(camera, false);
      mirror.position.set(p.x, 2 * h - p.y, p.z);
      look.set(p.x + d.x * 100, 2 * h - (p.y + d.y * 100), p.z + d.z * 100);
      mirror.up.set(0, 1, 0);
      mirror.lookAt(look);
      mirror.updateMatrixWorld();
      mirror.projectionMatrix.copy(camera.projectionMatrix);
      mirrorVP.multiplyMatrices(mirror.projectionMatrix, mirror.matrixWorldInverse);

      // 水面より下は描かない(海底・砂浜の水中部分が映り込まないように)。影は本描画で更新する
      clipPlane.constant = -(h - 0.3);
      const prev = {
        target: renderer.getRenderTarget(),
        planes: renderer.clippingPlanes,
        shadowAuto: renderer.shadowMap.autoUpdate,
      };
      water.visible = false;
      renderer.clippingPlanes = [clipPlane];
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, mirror);
      renderer.setRenderTarget(prev.target);
      renderer.clippingPlanes = prev.planes;
      renderer.shadowMap.autoUpdate = prev.shadowAuto;
      water.visible = true;
    },
    dispose() {
      if (enabled) water.material = baseMaterial;
      material.dispose();
      target.dispose();
      gpu?.target.removeFromParent();
      gpu?.reflection.dispose?.();
    },
  };
}

/**
 * WebGPU 用: 水面のマテリアルに、GLSL 版と同じ「大小 2 枚の法線マップ + 揺れる映り込み + フレネル」を
 * TSL のノードで持たせる(WebGPU のレンダラーがノードのマテリアルへ変換するときに引き継がれる)。
 */
function oceanNodes(W, material, water, uniforms) {
  const {
    texture, uv, uniform, vec2, vec3, vec4, float, mix, dot, pow, clamp, normalMap,
    reflector, output, normalView, positionViewDirection,
  } = W.TSL;
  const time = uniform(0);
  const map = material.normalMap;
  // 法線マップの模様は地面に固定して流す(LandscapeScene が offset を動かす)ので、repeat/offset を毎フレーム読む
  const baseUv = uv().mul(uniform(map.repeat)).add(uniform(map.offset));
  const n1 = texture(map, baseUv).xy.mul(2).sub(1);
  const n2 = texture(map, baseUv.mul(0.37).add(vec2(time.mul(0.0061), time.mul(-0.0043)))).xy.mul(2).sub(1);
  material.normalNode = normalMap(vec3(n1.add(n2.mul(0.6)).mul(0.5).add(0.5), 1), uniform(material.normalScale));

  const reflection = reflector({ resolutionScale: 0.5 });
  // 鏡の面は target の XY 面(法線 +Z)。水面(上向き)の子にして上を向ける
  reflection.target.rotateX(-Math.PI / 2);
  const n = normalView;
  reflection.uvNode = reflection.uvNode.add(n.xy.mul(uniforms.uDistortion.value));
  const diffuse = uniform(material.color);
  const refl = reflection.rgb.mul(mix(vec3(1), diffuse.mul(2.2), 0.35));
  const cosT = clamp(dot(n, positionViewDirection), 0, 1);
  const fresnel = float(0.02).add(pow(float(1).sub(cosT), 5).mul(0.98));
  material.outputNode = vec4(mix(output.rgb, refl, clamp(fresnel.mul(uniforms.uReflectStrength.value), 0, 1)), output.a);
  uniqueNodeKey(material, 'ocean-water');
  return { time, target: reflection.target, reflection };
}
