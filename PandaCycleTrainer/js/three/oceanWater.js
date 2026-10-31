// 映り込む海(実験。熱海サンビーチの描画品質「最高(実験)」で使う)。
//
// 水面のマテリアルを差し替え、
// - 法線マップを大小2枚、別の向き・速さで流して重ね、波が動いて見えるようにする
// - 水面で鏡映しにしたカメラからシーン(空・ホテル・ヤシ・山並み)を半分の解像度で描いておき、
//   水面の各点を鏡のカメラへ投影した位置から読んで、波で揺らしながらフレネル(浅い角度ほど強く)で重ねる
// ので、ホテル街や空が海面に揺れて映る。シーンを毎フレームもう1回描くため重い(高性能なGPU向け)。
// 平面の水面(LandscapeScene の water。root の Y 回転だけを受ける)を前提にしている。

import THREE from './three.js';

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
    },
    /** 映り込みを描く(本描画の前に毎フレーム呼ぶ)。t は秒。 */
    render(renderer, scene, camera, t) {
      if (!enabled || !water.visible) return;
      uniforms.uTime.value = t;
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
    },
  };
}
