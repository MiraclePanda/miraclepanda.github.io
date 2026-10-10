// 空と一緒に回る遠景(LandscapeScene が使う)。現在は 'fuji' = 富士山だけ。
//
// 富士山は十数km先の山なので、シーンのフォグ(FogExp2)にそのまま任せると完全に霞んで消えてしまう。
// そこでフォグは使わず(fog: false)、自前のシェーダーで
// - 半球光・太陽光の色と強さ(走行環境の時間帯・天候で変わる)で簡単な陰影をつけ、
// - フォグ色(= 地平線の色)へ距離と高さに応じて溶かす(大気遠近。麓ほど霞む)
// ので、夜は暗く、雨の日は霞んで見える。色はシーンの値を毎フレーム読むだけで、
// 走行環境のコントローラー(sceneEnvironment.js)には手を入れない。
//
// 位置は「回転前の進行方向の座標」での固定の向き(左前方の湖の向こう)×距離で決め、
// LandscapeScene が空の背景を回すのと同じ角度(skyHeading)で、ライダーのまわりに回す。
// 山の形は回転対称なので、どの向きから見ても同じ富士山の姿になる(雪の筋だけは山に固定して一緒に回す)。

import THREE from './three.js';

// 富士山の大きさ(m)と置き方。カメラの far(25km)に収まるよう、山の奥の裾まで 24km 以内にする
const FUJI_HEIGHT_M = 3700;
const FUJI_BASE_RADIUS_M = 9500;
const FUJI_DISTANCE_M = 14500;
const FUJI_SINK_M = 400; // 麓を湖面の下まで沈める
// 回転前の座標での向き(左前方)
const FUJI_DIR = new THREE.Vector3(-0.5, 0, -0.87).normalize();
// 大気遠近: フォグ密度 × 距離 × この係数 を光学的な厚さとして霞ませる(実際のフォグより弱く)
const HAZE_SCALE = 0.065;
const HAZE_MAX = 0.92;

/** 富士山の断面(下から上へ)。中腹から上ほど急な凹んだ裾野と、平らな山頂(お鉢)。 */
function fujiProfile() {
  const pts = [new THREE.Vector2(FUJI_BASE_RADIUS_M * 1.05, -FUJI_SINK_M)];
  const topR = FUJI_BASE_RADIUS_M * 0.065;
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const u = i / n; // 0 = 裾、1 = 山頂の縁
    const r = FUJI_BASE_RADIUS_M + (topR - FUJI_BASE_RADIUS_M) * u;
    // 裾はなだらか、山頂近くは約33°
    const y = FUJI_HEIGHT_M * Math.pow(u, 1.9);
    pts.push(new THREE.Vector2(r, y));
  }
  // 火口の縁から少しくぼんだ平らな山頂
  pts.push(new THREE.Vector2(topR * 0.75, FUJI_HEIGHT_M - 25));
  pts.push(new THREE.Vector2(0.001, FUJI_HEIGHT_M - 45));
  return pts;
}

function createFujiMaterial() {
  return new THREE.ShaderMaterial({
    fog: false,
    lights: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSun: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uHaze: { value: new THREE.Color(0.8, 0.85, 0.9) },
      uHazeAmount: { value: 0.4 },
      uHeight: { value: FUJI_HEIGHT_M },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSun;
      uniform vec3 uAmbient;
      uniform vec3 uHaze;
      uniform float uHazeAmount;
      uniform float uHeight;
      varying vec3 vNormalW;
      varying vec3 vLocal;
      void main() {
        float h = clamp(vLocal.y / uHeight, 0.0, 1.0);
        float ang = atan(vLocal.x, vLocal.z);
        // 雪の下端: ギザギザの縁と、谷筋に沿って下へ伸びる雪の筋
        float edge = 0.6 + 0.045 * sin(ang * 9.0) + 0.03 * sin(ang * 23.0 + 1.3) + 0.015 * sin(ang * 51.0 + 0.4);
        edge -= 0.16 * pow(max(0.0, sin(ang * 14.0 + 0.7)), 10.0);
        edge -= 0.09 * pow(max(0.0, sin(ang * 31.0 + 2.1)), 14.0);
        float snow = step(edge, h);
        // 山肌: 麓は濃い森の緑がかった色、上は青みがかった灰色
        vec3 rock = mix(vec3(0.075, 0.1, 0.085), vec3(0.11, 0.13, 0.19), smoothstep(0.12, 0.45, h));
        vec3 albedo = mix(rock, vec3(0.86, 0.89, 0.93), snow);
        vec3 n = normalize(vNormalW);
        float diffuse = max(dot(n, normalize(uSunDir)), 0.0);
        vec3 color = albedo * (uAmbient + uSun * diffuse);
        // 大気遠近: 麓ほど霞む
        float haze = clamp(uHazeAmount * mix(1.0, 0.72, h), 0.0, 1.0);
        color = mix(color, uHaze, haze);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

const _dir = new THREE.Vector3();
const _sun = new THREE.Vector3();

/**
 * 遠景を作る。未知の kind なら null。
 * @param {string} kind 'fuji'
 * @returns {{ object: THREE.Object3D, update: Function, dispose: Function } | null}
 */
export function createBackdrop(kind) {
  if (kind !== 'fuji') return null;
  const geometry = new THREE.LatheGeometry(fujiProfile(), 96);
  const material = createFujiMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'backdrop-fuji';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // 空より手前・地形(遠景の丘)より奥。フォグを使わないので描画順は深度だけで決まる
  mesh.frustumCulled = false;
  const u = material.uniforms;
  return {
    object: mesh,
    /**
     * 毎フレーム、カメラを動かした後に呼ぶ。
     * @param {object} p
     * @param {number} p.skyHeading 空の背景の回転(scene.backgroundRotation.y と同じ値)
     * @param {number} p.baseY 麓の高さ(ライダー基準の座標。湖面の高さ)
     * @param {THREE.Vector3} p.sunDir 太陽の向き(回転前。環境コントローラーの sunDir)
     * @param {THREE.HemisphereLight} p.hemiLight
     * @param {THREE.DirectionalLight} p.sunLight
     * @param {THREE.FogExp2} p.fog
     */
    update({ skyHeading, baseY, sunDir, hemiLight, sunLight, fog }) {
      _dir.copy(FUJI_DIR).applyAxisAngle(THREE.Object3D.DEFAULT_UP, skyHeading);
      mesh.position.set(_dir.x * FUJI_DISTANCE_M, baseY, _dir.z * FUJI_DISTANCE_M);
      mesh.rotation.y = skyHeading;
      // 光は山に固定した向きで受ける(回転前の太陽の向きを、山と同じだけ回す)
      _sun.copy(sunDir).applyAxisAngle(THREE.Object3D.DEFAULT_UP, skyHeading);
      u.uSunDir.value.copy(_sun);
      // 太陽・半球光の強さに応じた明るさ(夜は暗く、曇りは陰影が弱く)
      u.uSun.value.copy(sunLight.color).multiplyScalar(sunLight.intensity * 0.42);
      u.uAmbient.value.copy(hemiLight.color).multiplyScalar(hemiLight.intensity * 0.75);
      u.uHaze.value.copy(fog.color);
      u.uHazeAmount.value = Math.min(HAZE_MAX, 1 - Math.exp(-fog.density * FUJI_DISTANCE_M * HAZE_SCALE));
    },
    dispose() {
      mesh.parent?.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
