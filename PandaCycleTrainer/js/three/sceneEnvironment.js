// 走行環境(時間帯・天候)をシーンへ反映する共通部品(CityScene / LandscapeScene / PondScene)。
//
// - 値は environmentPresets.js の resolveEnvironment で求める(景観ごとの「昼・晴れ」の値が基準)。
// - 空は切替時に1回だけ bakeSky() で焼き直し、古い空(キューブマップ・環境マップ)は dispose する。
//   毎フレームのシェーダー空にはしない。
// - 光・霧・露出・路面の濡れ・窓の明かり・ヘッドライト・雨の濃さは、約1.5秒かけて draw() 内で補間する。
// - 「昼・晴れ」のまま一度も切り替えなければ、シーンには何も書き込まない(従来と同じ見た目・同じ draw call)。
//   雨粒のメッシュは初めて雨になったときに作り、ヘッドライトは夜度が0の間は非表示(ライト数に数えられない)。

import THREE from './three.js';
import { bakeSky } from './sceneKit.js';
import { resolveEnvironment, normalizeEnvironment, sameSky } from './environmentPresets.js';

const TRANSITION_MS = 1500;

// 雨: カメラ周辺の四方 RAIN_AREA_M に雨粒(線分)を降らせる。品質段階(high/medium/low)ごとの本数。
const RAIN_AREA_M = 70;
const RAIN_TOP_M = 25;
const RAIN_BOTTOM_M = -5;
const RAIN_DROPS_BY_QUALITY = [2600, 1200, 0];
const RAIN_FALL_MPS = 24;
const RAIN_STREAK_M = 0.7;
const RAIN_OPACITY = 0.38;

// 路面の濡れ: 粗さを WET_ROUGHNESS へ、色を WET_DARKEN 倍へ(濡れ度 1 のとき)
const WET_ROUGHNESS = 0.25;
const WET_DARKEN = 0.62;

// 夜のヘッドライト(影なし)。ライダーのアバターの子にして、前方の路面を照らす。
const HEADLIGHT_INTENSITY = 2.6;
const HEADLIGHT_DISTANCE_M = 60;

const lerp = (a, b, t) => a + (b - a) * t;

/** 補間用の状態(Three.js の色・ベクトル)を resolveEnvironment の結果から作る。 */
function toState(v) {
  return {
    sunColor: new THREE.Color(v.sunColor),
    sunIntensity: v.sunIntensity,
    sunDir: new THREE.Vector3().fromArray(v.sunDir),
    hemiSky: new THREE.Color(v.hemiSky),
    hemiGround: new THREE.Color(v.hemiGround),
    hemiIntensity: v.hemiIntensity,
    fogColor: new THREE.Color(v.horizon),
    fogDensity: v.fogDensity,
    exposure: v.exposure,
    night: v.night,
    wet: v.wet,
    rain: v.rain,
  };
}

function cloneState(st) {
  return {
    ...st,
    sunColor: st.sunColor.clone(), sunDir: st.sunDir.clone(),
    hemiSky: st.hemiSky.clone(), hemiGround: st.hemiGround.clone(), fogColor: st.fogColor.clone(),
  };
}

function lerpStateInto(out, a, b, t) {
  out.sunColor.lerpColors(a.sunColor, b.sunColor, t);
  out.sunDir.lerpVectors(a.sunDir, b.sunDir, t).normalize();
  out.hemiSky.lerpColors(a.hemiSky, b.hemiSky, t);
  out.hemiGround.lerpColors(a.hemiGround, b.hemiGround, t);
  out.fogColor.lerpColors(a.fogColor, b.fogColor, t);
  for (const k of ['sunIntensity', 'hemiIntensity', 'fogDensity', 'exposure', 'night', 'wet', 'rain']) out[k] = lerp(a[k], b[k], t);
  return out;
}

/**
 * @param {object} s シーン状態({ renderer, scene, camera, sky, qualityIndex, ... })。s.sky は焼き直しで差し替える
 * @param {object} opts
 * @param {import('./environmentPresets.js').BaseAtmo} opts.base 景観の「昼・晴れ」の値
 * @param {THREE.HemisphereLight} opts.hemiLight
 * @param {THREE.DirectionalLight} opts.sunLight
 * @param {THREE.MeshStandardMaterial[]} [opts.wetMaterials] 雨で濡れる路面
 * @param {{material: THREE.MeshStandardMaterial, night: number}[]} [opts.glowMaterials] 夜に emissiveIntensity を night 倍まで上げる
 * @param {THREE.Object3D} [opts.headlightParent] ヘッドライトを付けるアバターのグループ(前方 = −Z)
 * @param {boolean} [opts.weather=true] false なら天候は常に晴れ(時間帯のみ反映。上野不忍池)
 */
export function createEnvironmentController(s, { base, hemiLight, sunLight, wetMaterials = [], glowMaterials = [], headlightParent = null, weather = true }) {
  // 窓の夜度 uniform(cityMaterials.js の外壁マテリアルが userData.night に持つ)
  const nightUniforms = [];
  s.scene.traverse((obj) => {
    const m = obj.material;
    if (m && m.userData && m.userData.night && !nightUniforms.includes(m.userData.night)) nightUniforms.push(m.userData.night);
  });
  const wet = wetMaterials.map((material) => ({ material, roughness: material.roughness, color: material.color.clone() }));
  const glow = glowMaterials.map(({ material, night }) => ({ material, base: material.emissiveIntensity, night }));

  let headlight = null;
  if (headlightParent) {
    headlight = new THREE.SpotLight(0xfff1dc, 0, HEADLIGHT_DISTANCE_M, 0.45, 0.6, 0);
    headlight.castShadow = false;
    headlight.position.set(0, 1.15, -0.5);
    headlight.target.position.set(0, 0, -16);
    // 夜度0の間は非表示にして、ライト数(=シェーダー構成)を従来のままにする
    headlight.visible = false;
    headlightParent.add(headlight, headlight.target);
  }

  const baseResolved = resolveEnvironment(base, 'noon', 'clear');
  let bakedSky = baseResolved; // いま焼いてある空の値
  let current = toState(baseResolved);
  let from = current;
  let target = current;
  let startedAt = null; // 補間中なら開始時刻
  let dirty = false; // 一度でも基準から変えたか(変えていなければシーンに何も書かない)
  let key = 'noon/clear';
  let rain = null;
  let lastUpdateAt = null;

  const sunDir = current.sunDir.clone();

  function rebakeSky(v) {
    if (sameSky(v, bakedSky)) return;
    const old = s.sky;
    s.sky = bakeSky(s.renderer, {
      zenith: v.zenith, horizon: v.horizon, ground: v.ground, sunColor: v.sunColor,
      sunDir: new THREE.Vector3().fromArray(v.sunDir),
      cloudCover: v.cloudCover, cloud: v.cloud, sunGlow: v.sunGlow, night: v.night,
    });
    s.scene.background = s.sky.background;
    // 環境マップを使う品質段階なら、新しい空から作り直す(使わない段階では作らない)
    if (s.scene.environment) s.scene.environment = s.sky.getEnvironment();
    old.dispose();
    bakedSky = v;
  }

  function apply(st) {
    sunLight.color.copy(st.sunColor);
    sunLight.intensity = st.sunIntensity;
    sunDir.copy(st.sunDir);
    hemiLight.color.copy(st.hemiSky);
    hemiLight.groundColor.copy(st.hemiGround);
    hemiLight.intensity = st.hemiIntensity;
    s.scene.fog.color.copy(st.fogColor);
    s.scene.fog.density = st.fogDensity;
    s.renderer.toneMappingExposure = st.exposure;
    for (const w of wet) {
      w.material.roughness = st.wet === 0 ? w.roughness : lerp(w.roughness, WET_ROUGHNESS, st.wet);
      w.material.color.copy(w.color);
      if (st.wet !== 0) w.material.color.multiplyScalar(lerp(1, WET_DARKEN, st.wet));
    }
    for (const u of nightUniforms) u.value = st.night;
    for (const g of glow) g.material.emissiveIntensity = st.night === 0 ? g.base : g.base * lerp(1, g.night, st.night);
    if (headlight) {
      headlight.intensity = HEADLIGHT_INTENSITY * st.night;
      headlight.visible = st.night > 0.01;
    }
  }

  function ensureRain() {
    if (rain) return rain;
    const max = RAIN_DROPS_BY_QUALITY[0];
    const offsets = new Float32Array(max * 3);
    // 雨粒の配置は見た目だけなので固定の擬似乱数で決める(毎回同じ)
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < max; i++) {
      offsets[i * 3] = (rand() - 0.5) * RAIN_AREA_M;
      offsets[i * 3 + 1] = RAIN_BOTTOM_M + rand() * (RAIN_TOP_M - RAIN_BOTTOM_M);
      offsets[i * 3 + 2] = (rand() - 0.5) * RAIN_AREA_M;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 6), 3));
    const material = new THREE.LineBasicMaterial({ color: 0xb8c2d6, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.LineSegments(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    s.scene.add(mesh); // シーンに入れておけば disposeScene でジオメトリ・マテリアルも解放される
    rain = { mesh, geometry, material, offsets };
    return rain;
  }

  function updateRain(st, dt) {
    const count = RAIN_DROPS_BY_QUALITY[s.qualityIndex ?? 0] ?? 0;
    if (st.rain <= 0.001 || count === 0) {
      if (rain) rain.mesh.visible = false;
      return;
    }
    const r = ensureRain();
    r.mesh.visible = true;
    r.material.opacity = RAIN_OPACITY * st.rain;
    r.mesh.position.copy(s.camera.position);
    const pos = r.geometry.attributes.position.array;
    const o = r.offsets;
    const span = RAIN_TOP_M - RAIN_BOTTOM_M;
    for (let i = 0; i < count; i++) {
      let y = o[i * 3 + 1] - dt * RAIN_FALL_MPS;
      if (y < RAIN_BOTTOM_M) y += span;
      o[i * 3 + 1] = y;
      const x = o[i * 3];
      const z = o[i * 3 + 2];
      const j = i * 6;
      pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
      pos[j + 3] = x; pos[j + 4] = y + RAIN_STREAK_M; pos[j + 5] = z + 0.08;
    }
    r.geometry.attributes.position.needsUpdate = true;
    r.geometry.setDrawRange(0, count * 2);
  }

  return {
    /** 現在の太陽の方向(シーンが太陽光の位置を決めるのに使う。基準のままなら baseAtmo.sunDir と同じ値)。 */
    sunDir,
    /**
     * 環境を変える。immediate なら補間せずにすぐ反映する(マウント時)。
     * @param {{time?:string, weather?:string}} env
     */
    set(env, { immediate = false } = {}) {
      const { time, weather: w } = normalizeEnvironment(env);
      const weatherId = weather ? w : 'clear';
      const nextKey = `${time}/${weatherId}`;
      if (nextKey === key) return;
      key = nextKey;
      const v = resolveEnvironment(base, time, weatherId);
      rebakeSky(v);
      dirty = true;
      from = cloneState(current);
      target = toState(v);
      if (immediate) {
        current = cloneState(target);
        startedAt = null;
        apply(target);
      } else {
        startedAt = performance.now();
      }
    },
    /** draw() でカメラを動かした後・描画の直前に呼ぶ。補間を進め、雨粒をカメラの周りへ動かす。 */
    update() {
      if (!dirty) return;
      const now = performance.now();
      const dt = lastUpdateAt === null ? 0 : Math.min(0.1, Math.max(0, (now - lastUpdateAt) / 1000));
      lastUpdateAt = now;
      if (startedAt !== null) {
        const p = Math.min(1, (now - startedAt) / TRANSITION_MS);
        if (p >= 1) {
          // 終点は目標値をそのまま使う(昼・晴れへ戻したとき基準値と完全に一致させる)
          current = cloneState(target);
          startedAt = null;
          apply(target);
        } else {
          const e = p * p * (3 - 2 * p);
          lerpStateInto(current, from, target, e);
          apply(current);
        }
      }
      updateRain(current, dt);
    },
  };
}
