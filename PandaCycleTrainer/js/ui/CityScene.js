import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import {
  collectSceneObjects, mulberry32,
  ROAD_HALF_WIDTH_M, SIDEWALK_OUTER_M, CURB_HEIGHT_M, FLOOR_HEIGHT_M, BUILDING_STYLES,
  CROSSWALK_LENGTH_M, CROSS_STREET_WIDTH_M, INTERSECTION_LENGTH_M,
} from '../three/cityLayout.js';
import { buildElevationProfile, interpolateElevation } from '../three/roadElevation.js';
import { createCityTextures, createFacadeMaterial, createFacadeGeometry, FACADE_TILE } from '../three/cityMaterials.js';
import {
  RIDER_X_M, bakeSky, mergeGeometries, buildCanopyGeometry, buildRiderAvatar, updateRiderAvatar,
  makePool, pushInstance, commitPool, setupQuality, adaptQuality, resizeScene, disposeScene,
} from '../three/sceneKit.js';

const { forwardRef, useImperativeHandle } = React;

// 描画ウィンドウ(現在位置から前後何mを描画するか)。遠方は大気遠近(フォグ)で溶かす。
const BEHIND_M = 20;
const AHEAD_M = 300;
const PROFILE_STEP_M = 6;

// 敷地(歩道の外側)を左右どこまで敷くか。奥の列の建物より十分外側まで。
const GROUND_EXTENT_M = 120;
// 坂道で建物・店舗の足元が浮かないよう、地面下へ埋め込む深さ。
// 1階分にしておくと、外壁テクスチャの階の段がずれない。
const BUILDING_SINK_M = FLOOR_HEIGHT_M;
const ROOF_SLAB_M = 0.8;

const CAM_BACK_M = 6.5;
const CAM_HEIGHT_M = 2.6;
const CAM_LOOKAHEAD_M = 24;
const CAM_LOOKAHEAD_HEIGHT_M = 1.4;

// 空と大気。フォグ色は空シェーダーの地平線色と揃え、遠景が空に溶け込むようにする。
const SKY_ZENITH = '#3f78c2';
const SKY_HORIZON = '#c9d9e6';
const SKY_GROUND = '#9aa3a8';
const SUN_COLOR = '#fff1dc';
const SUN_DIR = new THREE.Vector3(-0.55, 0.72, 0.42).normalize(); // 左後方の高い太陽
const FOG_DENSITY = 0.0055;

// InstancedMeshの最大インスタンス数(描画ウィンドウに収まりうる数+余裕)。
const MAX_FACADES_PER_STYLE = 120;
const MAX_BUILDINGS = 260;
const MAX_ROOF_UNITS = 700;
const MAX_TREES = 120;
const CANOPY_BLOBS_PER_TREE = 3;
const MAX_LAMPS = 80;
const MAX_CARS = 70;
const MAX_INTERSECTIONS = 10;

// 地面リボンの断面。各セグメントは独立した頂点を持つ(縁石の角を鋭く保つため)。
// x0→x1の向きで表面の法線が決まる(上面は左→右、縁石面は車道側を向く順)。
const ROAD_SEGMENTS = [
  { x0: -ROAD_HALF_WIDTH_M, y0: 0, u0: 0, x1: ROAD_HALF_WIDTH_M, y1: 0, u1: 1 },
];
const SIDEWALK_SEGMENTS = [
  { x0: -SIDEWALK_OUTER_M, y0: CURB_HEIGHT_M, x1: -ROAD_HALF_WIDTH_M, y1: CURB_HEIGHT_M },
  { x0: -ROAD_HALF_WIDTH_M, y0: CURB_HEIGHT_M, x1: -ROAD_HALF_WIDTH_M, y1: 0, u0: 0, u1: 0.08 },
  { x0: ROAD_HALF_WIDTH_M, y0: 0, x1: ROAD_HALF_WIDTH_M, y1: CURB_HEIGHT_M, u0: 0, u1: 0.08 },
  { x0: ROAD_HALF_WIDTH_M, y0: CURB_HEIGHT_M, x1: SIDEWALK_OUTER_M, y1: CURB_HEIGHT_M },
];
const LOT_SEGMENTS = [
  { x0: -GROUND_EXTENT_M, y0: CURB_HEIGHT_M, x1: -SIDEWALK_OUTER_M, y1: CURB_HEIGHT_M },
  { x0: SIDEWALK_OUTER_M, y0: CURB_HEIGHT_M, x1: GROUND_EXTENT_M, y1: CURB_HEIGHT_M },
];
const ROAD_TILE_M = 10;
const SIDEWALK_TILE_M = 2;
const LOT_TILE_M = 6;
const ASPHALT_TILE_M = 8;

/**
 * Three.jsによる3D都市サイクリングビュー。
 * 手続き生成したテクスチャ(窓・レンガ・アスファルト・歩道ブロック等)、
 * 太陽光の影、空のグラデーションと雲、大気遠近(フォグ)、空を映り込ませる
 * 環境マップで、現実の街並みに近い見た目を目指している。
 * 走行距離・コース勾配に応じて街並みと道路の起伏をリアルタイムに生成・描画する。
 *
 * 高頻度描画(requestAnimationFrame)のためReactの再レンダリングは経由せず、
 * ref経由のdraw()呼び出しで直接Three.jsシーンを更新・描画する
 * (Dashboardと同じ設計方針)。
 */
export const CityScene = forwardRef(function CityScene({ courseEngine }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [renderError, setRenderError] = useState(null);

  useImperativeHandle(ref, () => ({
    draw({ distanceKm, speedKmh }) {
      const s = sceneRef.current;
      if (!s || !courseEngine) return;
      try {
        adaptQuality(s);
        drawFrame(s, courseEngine, distanceKm, speedKmh ?? 0);
      } catch (err) {
        // 実行時にWebGLコンテキストロスト等が起きても、アプリ全体を
        // 巻き込んでクラッシュさせない。
        setRenderError(String(err));
      }
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let scene3d;
    try {
      scene3d = initScene(canvas);
      sceneRef.current = scene3d;
    } catch (err) {
      setRenderError(String(err));
      return;
    }

    const resize = () => resizeScene(scene3d);
    setupQuality(scene3d);
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      disposeScene(scene3d);
      sceneRef.current = null;
    };
  }, []);

  return h(
    'div', { className: 'city-scene-wrap' },
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas' }),
    renderError &&
      h(
        'div', { className: 'city-scene-fallback' },
        '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。'
      )
  );
});

// ---- シーン初期化 ----

function initScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(SKY_HORIZON), FOG_DENSITY);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, AHEAD_M * 1.5);

  // 空は静的(太陽・雲とも動かない)なので、シェーダーで描いた空を初期化時に1度だけ
  // キューブマップ(背景用)とPMREM環境マップ(窓ガラスへの映り込み用)へ焼き込む。
  // 毎フレーム空の全画素でノイズを計算するより大幅に軽い。
  const sky = bakeSky(renderer, { zenith: SKY_ZENITH, horizon: SKY_HORIZON, ground: SKY_GROUND, sunColor: SUN_COLOR, sunDir: SUN_DIR });
  scene.background = sky.background;
  scene.environmentIntensity = 0.8;
  // 環境マップ(PMREM)は、それを使う品質段階になったときに初めて生成する(applyQuality)。

  const hemiLight = new THREE.HemisphereLight(0xcfe0f5, 0x77736a, 0.55);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(SUN_COLOR), 2.6);
  // 世界はライダー中心で毎フレーム組み直すため、太陽と影カメラは固定でよい。
  sunLight.target.position.set(0, 0, -60);
  sunLight.position.copy(sunLight.target.position).addScaledVector(SUN_DIR, 180);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -90, right: 90, top: 110, bottom: -110, near: 10, far: 420 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.04;
  scene.add(hemiLight, sunLight, sunLight.target);

  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = createCityTextures(anisotropy);

  // ---- 地面(毎フレーム頂点を書き換えるリボン) ----
  const road = buildRibbon(ROAD_SEGMENTS, new THREE.MeshStandardMaterial({ map: tex.road, roughness: 0.92 }), {
    uScale: 1, vTileM: ROAD_TILE_M,
  });
  const sidewalk = buildRibbon(SIDEWALK_SEGMENTS, new THREE.MeshStandardMaterial({ map: tex.sidewalk, roughness: 0.85 }), {
    uScale: 1 / SIDEWALK_TILE_M, vTileM: SIDEWALK_TILE_M,
  });
  const lot = buildRibbon(LOT_SEGMENTS, new THREE.MeshStandardMaterial({ map: tex.lot, roughness: 0.9 }), {
    uScale: 1 / LOT_TILE_M, vTileM: LOT_TILE_M,
  });
  scene.add(road.mesh, sidewalk.mesh, lot.mesh);

  // ---- 交差点(交差道路の帯+横断歩道) ----
  const crossStreetMat = new THREE.MeshStandardMaterial({
    // alphaTestは横断歩道と揃えてシェーダーを共通化するため(不透明テクスチャなので見た目に影響なし)。
    map: tex.asphalt, alphaTest: 0.5, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  const crossStreets = makePool(buildCrossStreetGeometry(), crossStreetMat, MAX_INTERSECTIONS, { cast: false });
  const crosswalkGeo = new THREE.PlaneGeometry(ROAD_HALF_WIDTH_M * 2, CROSSWALK_LENGTH_M);
  crosswalkGeo.rotateX(-Math.PI / 2);
  const crosswalkMat = new THREE.MeshStandardMaterial({
    map: tex.crosswalk, alphaTest: 0.5, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  const crosswalks = makePool(crosswalkGeo, crosswalkMat, MAX_INTERSECTIONS * 2, { cast: false });
  scene.add(crossStreets.mesh, crosswalks.mesh);

  // ---- 建物 ----
  const facadeGeo = createFacadeGeometry();
  const facades = {};
  for (const style of BUILDING_STYLES) {
    const bayM = style === 'glass' ? 1.8 : FLOOR_HEIGHT_M;
    const material = createFacadeMaterial({
      ...tex.facades[style],
      bayM, floorM: FLOOR_HEIGHT_M, tileBays: FACADE_TILE.cellBays, tileFloors: FACADE_TILE.cellFloors, sinkM: BUILDING_SINK_M,
    });
    facades[style] = makePool(facadeGeo, material, MAX_FACADES_PER_STYLE);
    scene.add(facades[style].mesh);
  }
  const storefrontMat = createFacadeMaterial({
    ...tex.storefront,
    bayM: 4, floorM: FLOOR_HEIGHT_M, tileBays: FACADE_TILE.cellBays, tileFloors: 1, sinkM: BUILDING_SINK_M,
  });
  const storefronts = makePool(facadeGeo, storefrontMat, MAX_BUILDINGS, { cast: false });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roofs = makePool(boxGeo, new THREE.MeshStandardMaterial({ color: 0x8e8b85, roughness: 0.9 }), MAX_BUILDINGS);
  const roofUnits = makePool(boxGeo, new THREE.MeshStandardMaterial({ color: 0xb4b3ae, roughness: 0.6, metalness: 0.2 }), MAX_ROOF_UNITS);
  scene.add(storefronts.mesh, roofs.mesh, roofUnits.mesh);

  // ---- 街路樹・街灯・駐車車両 ----
  const trunkGeo = new THREE.CylinderGeometry(0.1, 0.16, 1, 7).translate(0, 0.5, 0);
  const trunks = makePool(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 }), MAX_TREES);
  const canopies = makePool(buildCanopyGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.95 }), MAX_TREES * CANOPY_BLOBS_PER_TREE);
  const lamps = makePool(buildLampGeometry(), new THREE.MeshStandardMaterial({ color: 0x3a3e44, roughness: 0.45, metalness: 0.6 }), MAX_LAMPS);
  const car = buildCarGeometries();
  const carBodies = makePool(car.body, new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.55 }), MAX_CARS);
  const carGlass = makePool(car.glass, new THREE.MeshStandardMaterial({ color: 0x1c232a, roughness: 0.08, metalness: 0.8 }), MAX_CARS);
  const carWheels = makePool(car.wheels, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 }), MAX_CARS);
  scene.add(trunks.mesh, canopies.mesh, lamps.mesh, carBodies.mesh, carGlass.mesh, carWheels.mesh);

  const rider = buildRiderAvatar();
  scene.add(rider.group);

  return {
    canvas, renderer, scene, camera, sky, sunLight, textures: tex.all,
    road, sidewalk, lot, crossStreets, crosswalks,
    facades, storefronts, roofs, roofUnits,
    trunks, canopies, lamps, carBodies, carGlass, carWheels,
    rider,
    clock: new THREE.Clock(),
  };
}

// ---- ジオメトリ生成ヘルパー ----

function buildCrossStreetGeometry() {
  // 交差道路: 両側の敷地を横切る帯(歩道高さ)と、本線上の交差点部分(白線を隠す)。
  const half = CROSS_STREET_WIDTH_M / 2;
  const top = CURB_HEIGHT_M + 0.02;
  const strips = [
    [-GROUND_EXTENT_M, -ROAD_HALF_WIDTH_M, top],
    [-ROAD_HALF_WIDTH_M, ROAD_HALF_WIDTH_M, 0.015],
    [ROAD_HALF_WIDTH_M, GROUND_EXTENT_M, top],
  ];
  const positions = [];
  const uvs = [];
  const normals = [];
  for (const [x0, x1, y] of strips) {
    const quad = [[x0, half], [x1, half], [x0, -half], [x1, half], [x1, -half], [x0, -half]];
    for (const [x, z] of quad) {
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      uvs.push(x / ASPHALT_TILE_M, z / ASPHALT_TILE_M);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

function buildLampGeometry() {
  // 車道側(-X方向)へアームを伸ばした街灯。反対側はY軸180°回転で使う。
  const base = new THREE.CylinderGeometry(0.15, 0.18, 0.6, 10).translate(0, 0.3, 0);
  const pole = new THREE.CylinderGeometry(0.055, 0.085, 7, 10).translate(0, 3.5, 0);
  const arm = new THREE.BoxGeometry(1.6, 0.07, 0.07).translate(-0.8, 6.92, 0);
  const head = new THREE.BoxGeometry(0.6, 0.14, 0.3).translate(-1.55, 6.84, 0);
  return mergeGeometries([base, pole, arm, head]);
}

function buildCarGeometries() {
  // 進行方向(Z)に長い、ハッチバック/セダンの中間程度の簡易形状。
  const body = mergeGeometries([
    new THREE.BoxGeometry(1.75, 0.66, 4.4).translate(0, 0.62, 0),
    new THREE.BoxGeometry(1.6, 0.08, 2.1).translate(0, 1.54, 0.25),
    new THREE.BoxGeometry(1.7, 0.1, 0.3).translate(0, 0.98, -1.9),
  ]);
  const glass = new THREE.BoxGeometry(1.62, 0.56, 2.4).translate(0, 1.23, 0.25);
  const wheelParts = [];
  for (const x of [-0.78, 0.78]) {
    for (const z of [-1.4, 1.35]) {
      wheelParts.push(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16).rotateZ(Math.PI / 2).translate(x, 0.32, z));
    }
  }
  return { body, glass, wheels: mergeGeometries(wheelParts) };
}

// ---- 地面リボン ----

function buildRibbon(segments, material, { uScale, vTileM }) {
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return { mesh, geometry, segments, uScale, vTileM, sampleCount: 0 };
}

function updateRibbon(ribbon, profile, distanceM) {
  const { geometry, segments, uScale, vTileM } = ribbon;
  const sampleCount = profile.length;
  const vertsPerSample = segments.length * 2;
  if (ribbon.sampleCount !== sampleCount) {
    // サンプル数はウィンドウ定数から決まるため、通常は初回のみ確保する。
    const vertexCount = sampleCount * vertsPerSample;
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
    const indices = [];
    for (let i = 0; i < sampleCount - 1; i++) {
      for (let s = 0; s < segments.length; s++) {
        const a = i * vertsPerSample + s * 2;
        const b = a + 1;
        const c = a + vertsPerSample;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    geometry.setIndex(indices);
    ribbon.sampleCount = sampleCount;
  }

  // テクスチャ座標は絶対距離に固定する(白線や舗装の目地が路面と一緒に流れるように)。
  // 大きな距離でもfloat精度を失わないよう、タイル長で剰余を取っておく。
  const vBase = ((distanceM % vTileM) + vTileM) % vTileM;
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < sampleCount; i++) {
    const { alongM, elevM } = profile[i];
    const v = (vBase + alongM) / vTileM;
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const idx = i * vertsPerSample + s * 2;
      pos.setXYZ(idx, seg.x0, elevM + seg.y0, -alongM);
      pos.setXYZ(idx + 1, seg.x1, elevM + seg.y1, -alongM);
      uv.setXY(idx, seg.u0 ?? seg.x0 * uScale, v);
      uv.setXY(idx + 1, seg.u1 ?? seg.x1 * uScale, v);
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.computeVertexNormals();
}

// ---- 毎フレームの更新 ----

function drawFrame(s, courseEngine, distanceKm, speedKmh) {
  const distanceM = distanceKm * 1000;
  const profile = buildElevationProfile(
    (km) => courseEngine.gradeAtKm(km),
    distanceKm,
    { behindM: BEHIND_M, aheadM: AHEAD_M, stepM: PROFILE_STEP_M }
  );
  const elevAt = (relAlongM) => interpolateElevation(profile, relAlongM);
  const pitchAt = (relAlongM) => Math.atan((elevAt(relAlongM + 1.5) - elevAt(relAlongM - 1.5)) / 3);

  updateRibbon(s.road, profile, distanceM);
  updateRibbon(s.sidewalk, profile, distanceM);
  updateRibbon(s.lot, profile, distanceM);

  const objects = collectSceneObjects(distanceM - BEHIND_M, distanceM + AHEAD_M);
  updateIntersections(s, objects.intersections, distanceM, elevAt, pitchAt);
  updateBuildings(s, objects.buildings, distanceM, elevAt);
  updateStreetFurniture(s, objects, distanceM, elevAt, pitchAt);
  updateRiderAvatar(s.rider, s.clock, speedKmh, pitchAt(0));
  updateCamera(s, elevAt);

  s.renderer.render(s.scene, s.camera);
}

function updateIntersections(s, intersections, distanceM, elevAt, pitchAt) {
  for (const { alongM } of intersections) {
    const rel = alongM - distanceM;
    const streetCenter = rel + CROSSWALK_LENGTH_M + CROSS_STREET_WIDTH_M / 2;
    pushInstance(s.crossStreets, 0, elevAt(streetCenter), -streetCenter, 1, 1, 1, pitchAt(streetCenter));
    for (const cwCenter of [rel + CROSSWALK_LENGTH_M / 2, rel + INTERSECTION_LENGTH_M - CROSSWALK_LENGTH_M / 2]) {
      pushInstance(s.crosswalks, 0, elevAt(cwCenter) + 0.01, -cwCenter, 1, 1, 1, pitchAt(cwCenter));
    }
  }
  commitPool(s.crossStreets);
  commitPool(s.crosswalks);
}

function updateBuildings(s, buildings, distanceM, elevAt) {
  for (const b of buildings) {
    const rel = b.alongM - distanceM;
    const z = -rel;
    const groundY = elevAt(rel) + CURB_HEIGHT_M;
    const baseY = groundY - BUILDING_SINK_M;

    // 本体: X=奥行き, Z=間口(道路沿いの長さ)。外壁シェーダーがこのスケールから窓を並べる。
    pushInstance(s.facades[b.style], b.xOffsetM, baseY, z, b.depth, b.height + BUILDING_SINK_M, b.width, 0, 0, b.tint);
    if (b.storefront) {
      pushInstance(s.storefronts, b.xOffsetM, baseY, z, b.depth + 0.3, FLOOR_HEIGHT_M + BUILDING_SINK_M, b.width + 0.3);
    }
    // 屋上のパラペット(外壁より少し張り出したスラブ)と屋上設備
    const roofY = groundY + b.height;
    pushInstance(s.roofs, b.xOffsetM, roofY, z, b.depth + 0.35, ROOF_SLAB_M, b.width + 0.35);
    for (const u of b.roofUnits) {
      pushInstance(s.roofUnits, b.xOffsetM + u.u * b.depth, roofY + ROOF_SLAB_M * 0.5, z + u.v * b.width, u.sizeX, u.sizeY, u.sizeZ);
    }
  }
  for (const style of BUILDING_STYLES) commitPool(s.facades[style]);
  commitPool(s.storefronts);
  commitPool(s.roofs);
  commitPool(s.roofUnits);
}

function updateStreetFurniture(s, { trees, lamps, cars }, distanceM, elevAt, pitchAt) {
  for (const t of trees) {
    const rel = t.alongM - distanceM;
    const groundY = elevAt(rel) + CURB_HEIGHT_M;
    const z = -rel;
    pushInstance(s.trunks, t.xOffsetM, groundY, z, t.scale, 3.4 * t.scale, t.scale);
    // 樹冠は複数の葉の塊で構成する。形は木ごとのseedで決定的に決める。
    const rand = mulberry32(t.seed);
    for (let i = 0; i < CANOPY_BLOBS_PER_TREE; i++) {
      const r = (1.3 + rand() * 0.6) * t.scale;
      const ox = (rand() - 0.5) * 1.4 * t.scale;
      const oz = (rand() - 0.5) * 1.4 * t.scale;
      const oy = (3.6 + i * 0.7 + rand() * 0.4) * t.scale;
      pushInstance(s.canopies, t.xOffsetM + ox, groundY + oy, z + oz, r, r, r, 0, rand() * Math.PI, t.leafColor);
    }
  }
  for (const l of lamps) {
    const rel = l.alongM - distanceM;
    pushInstance(s.lamps, l.xOffsetM, elevAt(rel) + CURB_HEIGHT_M, -rel, 1, 1, 1, 0, l.side > 0 ? 0 : Math.PI);
  }
  for (const c of cars) {
    const rel = c.alongM - distanceM;
    const y = elevAt(rel);
    const pitch = pitchAt(rel);
    pushInstance(s.carBodies, c.xOffsetM, y, -rel, 1, 1, 1, pitch, 0, c.color);
    pushInstance(s.carGlass, c.xOffsetM, y, -rel, 1, 1, 1, pitch, 0);
    pushInstance(s.carWheels, c.xOffsetM, y, -rel, 1, 1, 1, pitch, 0);
  }
  commitPool(s.trunks);
  commitPool(s.canopies);
  commitPool(s.lamps);
  commitPool(s.carBodies);
  commitPool(s.carGlass);
  commitPool(s.carWheels);
}

function updateCamera(s, elevAt) {
  const camY = elevAt(-CAM_BACK_M) + CAM_HEIGHT_M;
  s.camera.position.set(RIDER_X_M + 0.4, camY, CAM_BACK_M);
  const lookY = elevAt(CAM_LOOKAHEAD_M) + CAM_LOOKAHEAD_HEIGHT_M;
  s.camera.lookAt(RIDER_X_M * 0.4, lookY, -CAM_LOOKAHEAD_M);
}
