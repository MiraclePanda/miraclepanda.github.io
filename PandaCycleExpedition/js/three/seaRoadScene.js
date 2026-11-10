// 海沿いの道の3D(熱海→伊東の国道135号のような、左に海・右に山の道)。
//
// ライダーは原点に止まったまま、毎フレーム「ライダーの前後の見える範囲」を区間の地点から組み立て直す
// (地面は1枚の格子の頂点を上書き、置き物は InstancedMesh のプール)。置き物は区間の絶対位置から
// seed で決めるので、同じ地点はいつも同じ見た目になる。
// 道の左右へのうねりは見た目だけ(物理・トレーナーには関係しない)。

import THREE from './three.js';
import {
  RIDER_X_M, bakeSky, createAvatar, updateRiderAvatar, makePool, pushInstance, pushInstanceYawPitch, commitPool,
  setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene, applyRenderLook,
} from './sceneKit.js';
import { createPostFx } from './postFx.js';
import { gradeAtM, tunnelAtM } from '../physics/segmentRoute.js';

const AHEAD_M = 420;
const BEHIND_M = 30;
const ROW_STEP_M = 4;
const ROWS = Math.round((AHEAD_M + BEHIND_M) / ROW_STEP_M) + 1;
const ELEV_STEP_M = 10;

// 地面の格子の列: [道の中心からの x(m), 高さの決め方, 色]
// 高さ: 'road' = 道の高さ + dy、'sea' = 海面 + dy、'hill' = 道の高さ + dy + 起伏
const COLUMNS = [
  [-260, 'sea', -4, 0x2d5a6b], [-34, 'sea', -1.2, 0xc9b98f], [-16, 'sea', 1.2, 0x8c8a7d],
  [-7, 'road', -0.4, 0x6f7a5e], [-5.2, 'road', 0, 0x8a8a86], [-4.6, 'road', 0, 0xeeeeee],
  [-4.4, 'road', 0, 0x3b3d40], [4.4, 'road', 0, 0x3b3d40], [4.6, 'road', 0, 0xeeeeee],
  [5.2, 'road', 0, 0x8a8a86], [7, 'road', 0.4, 0x5d7a45], [14, 'hill', 4, 0x4f7040],
  [45, 'hill', 22, 0x3f6234], [130, 'hill', 70, 0x46683a], [300, 'hill', 140, 0x5a7350],
];

const SKY_BY_WEATHER = {
  sunny: { zenith: '#3b78c9', horizon: '#cfe6f7', ground: '#5d7a55', cloudCover: 0.15, fog: 0.0016 },
  cloudy: { zenith: '#7d8a99', horizon: '#c9d0d6', ground: '#5d6a58', cloudCover: 0.75, sunGlow: 0.5, fog: 0.0024 },
  rain: { zenith: '#4f5864', horizon: '#8e979f', ground: '#4a5448', cloudCover: 0.95, sunGlow: 0.25, fog: 0.004 },
  squall: { zenith: '#2f353d', horizon: '#646c74', ground: '#3b4239', cloudCover: 1, sunGlow: 0.1, fog: 0.007 },
};

/**
 * 区間の海の側に合わせた地面の列。seaSide: 'left'(既定。熱海→伊東のような南向きの東海岸)、
 * 'right'(逆向き)、'none'(山の道。両側とも山)。
 */
function columnsFor(seaSide) {
  if (seaSide === 'right') return COLUMNS.map(([x, ...r]) => [-x, ...r]).reverse();
  if (seaSide === 'none') {
    const right = COLUMNS.filter((c) => c[0] > 0);
    return [...right.map(([x, ...r]) => [-x, ...r]).reverse(), ...right];
  }
  return COLUMNS;
}

/** 区間の見た目のうねり(m)。絶対位置だけで決まる。 */
function curveX(m) {
  return 9 * Math.sin(m / 230) + 4 * Math.sin(m / 97 + 1);
}

/** 0〜1 の決定的な乱数(整数のセル番号から)。 */
function cellRand(i, salt) {
  let h = Math.imul((i | 0) ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} segment 区間データ
 * @param {{qualityMode?:string, onQualityChange?:(tier:string)=>void}} [opts]
 *   qualityMode: 'auto' | 'ultra' | 'high' | 'medium' | 'low'。onQualityChange には実際に使っている段階が届く。
 */
export function createSeaRoadScene(canvas, segment, { qualityMode = 'auto', onQualityChange } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  applyRenderLook(renderer);
  const postFx = createPostFx(renderer);
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xcfe6f7, 0.0016);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 3000);

  const hemi = new THREE.HemisphereLight(0xdfefff, 0x4a5a40, 0.9);
  const sunLight = new THREE.DirectionalLight(0xfff1d6, 1.6);
  sunLight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunLight.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25, near: 1, far: 120 });
  scene.add(hemi, sunLight, sunLight.target);

  // 区間の絶対標高(m)を ELEV_STEP_M ごとに積分した表
  const elevTable = new Float32Array(Math.ceil(segment.lengthM / ELEV_STEP_M) + 2);
  elevTable[0] = segment.startElevM ?? 0;
  for (let i = 1; i < elevTable.length; i++) {
    const g = gradeAtM(segment, (i - 0.5) * ELEV_STEP_M);
    elevTable[i] = elevTable[i - 1] + ELEV_STEP_M * Math.sin(Math.atan(g / 100));
  }
  const absElev = (m) => {
    const x = Math.min(Math.max(m, 0), segment.lengthM) / ELEV_STEP_M;
    const i = Math.min(Math.floor(x), elevTable.length - 2);
    return elevTable[i] + (elevTable[i + 1] - elevTable[i]) * (x - i);
  };

  // ---- 地面の格子 ----
  const seaSide = segment.seaSide ?? 'left';
  const COLS = columnsFor(seaSide);
  const land = seaSide === 'right' ? -1 : 1; // 山側(建物・電柱・木の側)の向き。x の符号
  const cols = COLS.length;
  const ground = new THREE.BufferGeometry();
  const pos = new Float32Array(ROWS * cols * 3);
  const col = new Float32Array(ROWS * cols * 3);
  const c = new THREE.Color();
  for (let r = 0; r < ROWS; r++) {
    for (let k = 0; k < cols; k++) {
      c.setHex(COLS[k][3]);
      col.set([c.r, c.g, c.b], (r * cols + k) * 3);
    }
  }
  const index = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let k = 0; k < cols - 1; k++) {
      const a = r * cols + k;
      index.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  ground.setIndex(index);
  ground.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  ground.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const groundMesh = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  groundMesh.receiveShadow = true;
  groundMesh.frustumCulled = false;
  scene.add(groundMesh);

  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({ color: 0x1f5f86, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.92 }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.x = -land * (2000 + 14); // 海側の端が道の中心から 14m(海岸)
  sea.visible = seaSide !== 'none';
  scene.add(sea);

  // ---- 置き物のプール ----
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
  const pools = {
    dash: makePool(box, std(0xf2f2f2), 60, { cast: false }),
    rail: makePool(box, std(0xd8d8d0, { metalness: 0.4 }), 260),
    pole: makePool(box, std(0x8b8378), 30),
    house: makePool(box, std(0xffffff), 220),
    roof: makePool(box, std(0xffffff), 220),
    tunnel: makePool(box, std(0x77746c), 360, { cast: false }),
    lamp: makePool(box, std(0xffd27a, { emissive: 0xffb43a, emissiveIntensity: 1.5 }), 60, { cast: false }),
  };
  const trunkPool = makePool(new THREE.CylinderGeometry(0.15, 0.2, 1, 6).translate(0, 0.5, 0), std(0x5b4632), 400);
  const crownPool = makePool(new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0), std(0xffffff), 400);
  for (const p of [...Object.values(pools), trunkPool, crownPool]) scene.add(p.mesh);

  // 町の範囲(建物を並べる区間): 地点の前後 town は 450m、そのほかは 120m
  const townRanges = (segment.places ?? [])
    .filter((p) => ['town', 'food', 'shop', 'lodging'].includes(p.kind))
    .map((p) => ({ from: p.atM - (p.kind === 'town' ? 450 : 120), to: p.atM + (p.kind === 'town' ? 450 : 120), place: p }));
  const inTown = (m) => townRanges.find((t) => m >= t.from && m <= t.to) ?? null;

  // ---- ライダー(荷物を積んだグラベルバイク) ----
  const rider = createAvatar();
  const bagMat = std(0x2f3a2c);
  for (const [w, hgt, d, y, z] of [[0.34, 0.2, 0.2, 0.92, -0.62], [0.16, 0.2, 0.42, 0.98, 0.42], [0.06, 0.2, 0.42, 0.62, -0.12]]) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), bagMat);
    bag.position.set(0, y, z);
    bag.castShadow = true;
    rider.group.add(bag);
  }
  scene.add(rider.group);

  // ---- 雨 ----
  const RAIN_N = 1800;
  const rainPos = new Float32Array(RAIN_N * 3);
  for (let i = 0; i < RAIN_N; i++) rainPos.set([(Math.random() - 0.5) * 60, Math.random() * 25, -Math.random() * 60 + 8], i * 3);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rain = new THREE.Points(rainGeo, new THREE.PointsMaterial({ color: 0xaab4c0, size: 0.08, transparent: true, opacity: 0.7 }));
  rain.visible = false;
  rain.frustumCulled = false;
  scene.add(rain);

  const s = {
    renderer, scene, camera, canvas, sunLight, textures: [], sky: null, clock: new THREE.Clock(),
    skyKey: null, disposed: false, onQualityChange,
    // 最高: 影の範囲を広げ(遠くの電柱・建物まで影が落ちる)、画面の解像度を端末いっぱいまで上げる。
    // 影マップを 4096 にするのは sceneKit の applyQuality がする。
    onUltraChange(on) {
      const r = on ? 45 : 25;
      Object.assign(sunLight.shadow.camera, { left: -r, right: r, top: r, bottom: -r, far: on ? 160 : 120 });
      sunLight.shadow.camera.updateProjectionMatrix();
      if (on) renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
    },
  };

  function rebakeSky(kind, clockMinutes) {
    const hour = Math.floor(clockMinutes / 60);
    const key = `${kind}:${Math.min(Math.max(hour, 6), 18)}`;
    if (key === s.skyKey) return;
    s.skyKey = key;
    const w = SKY_BY_WEATHER[kind] ?? SKY_BY_WEATHER.sunny;
    // 太陽: 6時に東(左・海側)の地平線、12時に南の空高く、18時に西(右・山側)へ沈む
    const t = Math.min(Math.max((clockMinutes - 6 * 60) / (12 * 60), 0), 1);
    const sunDir = new THREE.Vector3(-Math.cos(t * Math.PI), Math.sin(t * Math.PI) * 0.75 + 0.05, -0.5).normalize();
    const evening = Math.max(0, (clockMinutes - 15.5 * 60) / 90);
    const horizon = new THREE.Color(w.horizon).lerp(new THREE.Color('#f2a35e'), Math.min(evening, 1) * (kind === 'sunny' ? 0.8 : 0.3));
    const old = s.sky;
    s.sky = bakeSky(renderer, {
      zenith: w.zenith, horizon: `#${horizon.getHexString()}`, ground: w.ground, sunColor: '#fff2d2', sunDir,
      cloudCover: w.cloudCover, sunGlow: w.sunGlow ?? 1, night: Math.max(0, Math.min(1, (clockMinutes - 17 * 60) / 60)),
    });
    scene.background = s.sky.background;
    if (scene.environment) scene.environment = s.sky.getEnvironment();
    old?.dispose();
    scene.fog.color.copy(horizon);
    scene.fog.density = w.fog;
    sunLight.position.copy(sunDir).multiplyScalar(60);
    sunLight.intensity = 1.7 * (w.sunGlow ?? 1) * Math.max(0.15, Math.sin(t * Math.PI));
    hemi.intensity = 0.55 + 0.45 * (w.sunGlow ?? 1);
    rain.visible = kind === 'rain' || kind === 'squall';
  }

  rebakeSky('sunny', 7 * 60);
  setupQuality(s, qualityMode);

  /**
   * 1フレーム描く。
   * @param {{segmentM:number, speedKmh:number, gradePercent:number, weatherKind:string, clockMinutes:number}} f
   */
  function draw({ segmentM, speedKmh, gradePercent, weatherKind, clockMinutes }) {
    if (s.disposed) return;
    rebakeSky(weatherKind, clockMinutes);
    const m0 = segmentM;
    const e0 = absElev(m0);
    const cx0 = curveX(m0);

    // 地面
    for (let r = 0; r < ROWS; r++) {
      const d = -BEHIND_M + r * ROW_STEP_M;
      const m = m0 + d;
      const ey = absElev(m) - e0;
      const cx = curveX(m) - cx0;
      for (let k = 0; k < cols; k++) {
        const [x, mode, dy] = COLS[k];
        let y;
        if (mode === 'road') y = ey + dy;
        else if (mode === 'sea') y = Math.min(-e0 + dy, ey - 0.6);
        else y = ey + dy * (0.8 + 0.4 * Math.sin(m / 140 + k) * Math.sin(m / 53 + k * 2));
        const i = (r * cols + k) * 3;
        pos[i] = x + cx + RIDER_X_M + 2.2;
        pos[i + 1] = y;
        pos[i + 2] = -d;
      }
    }
    ground.attributes.position.needsUpdate = true;
    ground.computeVertexNormals();
    sea.position.y = -e0;

    const roadX = (d) => curveX(m0 + d) - cx0 + RIDER_X_M + 2.2;
    const roadY = (d) => absElev(m0 + d) - e0;

    // 中央線(10m ごとに 5m の破線。絶対位置にそろえるので走ると流れる)
    for (let mm = Math.ceil((m0 - BEHIND_M) / 10) * 10; mm < m0 + 200; mm += 10) {
      const d = mm - m0;
      pushInstance(pools.dash, roadX(d + 2.5), roadY(d + 2.5) + 0.02, -(d + 2.5), 0.14, 0.02, 5, 0, 0);
    }

    // トンネル・ガードレール・電柱
    for (let mm = Math.ceil((m0 - BEHIND_M) / 4) * 4; mm < m0 + AHEAD_M; mm += 4) {
      const d = mm - m0;
      const x = roadX(d);
      const y = roadY(d);
      const yaw = Math.atan2(roadX(d + 4) - x, 4);
      const pitch = Math.atan2(roadY(d + 4) - y, 4);
      if (tunnelAtM(segment, mm)) {
        pushInstance(pools.tunnel, x - 5.6, y, -(d + 2), 0.6, 5.5, 4.2, 0, yaw);
        pushInstance(pools.tunnel, x + 5.6, y, -(d + 2), 0.6, 5.5, 4.2, 0, yaw);
        pushInstance(pools.tunnel, x, y + 5.5, -(d + 2), 11.8, 0.5, 4.2, 0, yaw);
        if (mm % 12 === 0) pushInstance(pools.lamp, x - 4.8, y + 4.6, -(d + 2), 0.2, 0.15, 1.2, 0, yaw);
        continue;
      }
      if (d < 260 && !inTown(mm)) {
        pushInstance(pools.rail, x - land * 5.3, y, -d, 0.12, 0.75, 0.12, 0, 0);
        pushInstanceYawPitch(pools.rail, x - land * 5.25, y + 0.55, -(d + 2), 0.05, 0.3, 4.05, yaw, pitch);
      }
      if (mm % 36 === 0 && d < 300) pushInstance(pools.pole, x + land * 6, y, -d, 0.3, 9, 0.3, 0, 0);
    }

    // 町の建物(右の山側、海側にも少し)と、木
    for (let cell = Math.floor((m0 - BEHIND_M) / 12); cell * 12 < m0 + AHEAD_M; cell++) {
      const mm = cell * 12;
      const d = mm - m0;
      if (tunnelAtM(segment, mm)) continue;
      const x = roadX(d);
      const y = roadY(d);
      const town = inTown(mm);
      if (town) {
        const big = town.place.kind === 'lodging' && Math.abs(mm - town.place.atM) < 30;
        for (const side of [1, -1]) {
          if (side < 0 && cellRand(cell, 7) < 0.5) continue;
          const w = 6 + cellRand(cell, side + 3) * 6;
          const h = big && side > 0 ? 22 : 4 + cellRand(cell, side + 5) * (side > 0 ? 9 : 5);
          const off = side * land * (8.5 + w / 2 + cellRand(cell, side + 9) * 3);
          const hue = [0xe8e2d6, 0xd9cdb8, 0xc7cdd1, 0xf1ece4, 0xb9a88f][Math.floor(cellRand(cell, side + 11) * 5)];
          pushInstance(pools.house, x + off, y - 0.5, -(d + 6), w, h + 0.5, 8, 0, 0, hue);
          pushInstance(pools.roof, x + off, y + h, -(d + 6), w + 0.4, 0.5, 8.4, 0, 0, side > 0 ? 0x4d5560 : 0x6b4a3a);
        }
      } else {
        for (let j = 0; j < (seaSide === 'none' ? 6 : 3); j++) {
          if (cellRand(cell, 20 + j) < 0.35) continue;
          const off = (j < 3 ? land : -land) * (12 + (j % 3) * 14 + cellRand(cell, 30 + j) * 10);
          const hgt = 4 + cellRand(cell, 40 + j) * 5;
          const ty = y + (Math.abs(off) - 7) * 0.45;
          pushInstance(trunkPool, x + off, ty, -(d + cellRand(cell, 50 + j) * 10), 1, hgt * 0.4, 1, 0, 0);
          pushInstance(crownPool, x + off, ty + hgt * 0.3, -(d + cellRand(cell, 50 + j) * 10), hgt * 0.35, hgt * 0.8, hgt * 0.35, 0, 0,
            cellRand(cell, 60 + j) < 0.5 ? 0x2f5a2a : 0x3e6b30);
        }
      }
    }
    for (const p of [...Object.values(pools), trunkPool, crownPool]) commitPool(p);

    // ライダー・カメラ・影
    const pitch = -Math.atan(gradePercent / 100);
    rider.group.position.x = roadX(0) - 2.2;
    updateRiderAvatar(rider, s.clock, speedKmh, pitch);
    const rx = rider.group.position.x;
    camera.position.set(rx + 0.3, 2.3, 5.2);
    camera.lookAt(roadX(25) - 2.2, roadY(25) + 1.0, -25);
    sunLight.target.position.set(rx, 0, -8);
    sunLight.position.copy(sunLight.target.position).add(sunLight.position.clone().sub(sunLight.target.position).normalize().multiplyScalar(60));

    if (rain.visible) {
      const fall = (weatherKind === 'squall' ? 22 : 12) * (rider.dt ?? 0.016);
      for (let i = 0; i < RAIN_N; i++) {
        let yv = rainPos[i * 3 + 1] - fall;
        if (yv < 0) yv += 25;
        rainPos[i * 3 + 1] = yv;
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    adaptQuality(s);
    postFx.begin(s.postOn);
    renderer.render(scene, camera);
    postFx.end();
  }

  return {
    draw,
    resize: () => resizeScene(s),
    /** 走行中に描画品質を切り替える。 */
    setQualityMode: (mode) => setQualityMode(s, mode),
    dispose() {
      s.disposed = true;
      postFx.dispose();
      disposeScene(s);
    },
  };
}
