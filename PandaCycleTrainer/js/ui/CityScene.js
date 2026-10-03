import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import {
  collectSceneObjects, mulberry32,
  ROAD_HALF_WIDTH_M, SIDEWALK_OUTER_M, CURB_HEIGHT_M, FLOOR_HEIGHT_M, BUILDING_STYLES,
  CROSSWALK_LENGTH_M, CROSS_STREET_WIDTH_M, INTERSECTION_LENGTH_M,
} from '../three/cityLayout.js';
import { buildElevationProfile, interpolateElevation } from '../three/roadElevation.js';
import { buildRouteFrame, toLocalInto, clampInsideOffset, curvatureAtM } from '../three/routeLayout.js';
import { createCityTextures, createFacadeMaterial, createFacadeGeometry, FACADE_TILE } from '../three/cityMaterials.js';
import {
  RIDER_X_M, bakeSky, mergeGeometries, buildCanopyGeometry, createAvatar, updateRiderAvatar,
  makePool, pushInstanceYawPitch, commitPool, setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene,
  setCameraFov, setAvatarVisible,
} from '../three/sceneKit.js';
import {
  createCineDirector, normalizeCameraView, riderRollRad, fpCameraRollRad, estimateCadenceRpm, fpBobM, fpFovDeg, CHASE_FOV_DEG,
} from '../three/cameraViews.js';
import { createEnvironmentController } from '../three/sceneEnvironment.js';
import { createOtherRiders } from '../three/otherRiders.js';

const { forwardRef, useImperativeHandle } = React;

// 描画ウィンドウ(現在位置から前後何mを描画するか)。遠方は大気遠近(フォグ)で溶かす。
const BEHIND_M = 20;
const AHEAD_M = 300;
const PROFILE_STEP_M = 6;
// 標高プロファイルと道路フレームで共有するサンプル範囲(毎フレーム作り直さないよう定数にする)
const WINDOW_OPTS = { behindM: BEHIND_M, aheadM: AHEAD_M, stepM: PROFILE_STEP_M };

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
// 目線視点(fp): 少し前・目の高さから、20m先の路面より少し上を見る
const FP_FORWARD_M = 0.25;
const FP_LOOKAHEAD_M = 20;
const FP_LOOK_HEIGHT_M = 1.25;
// cine 視点: 沿道カメラは左側の車道端(縁石から 0.3〜0.7m 内側)、ヘリは歩道の上空(建物に入らないよう)
const CINE_CURB_INSET_M = 0.3;
const CINE_CURB_SPREAD_M = 0.4;
const CINE_MAX_HEIGHT_M = 3.0;
const CINE_HELI_BACK_M = 16;
const CINE_HELI_LATERAL_M = 6;
const CINE_LOOK_HEIGHT_M = 1.0;

// 空と大気。フォグ色は空シェーダーの地平線色と揃え、遠景が空に溶け込むようにする。
const SKY_ZENITH = '#3f78c2';
const SKY_HORIZON = '#c9d9e6';
const SKY_GROUND = '#9aa3a8';
const SUN_COLOR = '#fff1dc';
const SUN_DIR = new THREE.Vector3(-0.55, 0.72, 0.42).normalize(); // 左後方の高い太陽
const FOG_DENSITY = 0.0055;
const SUN_INTENSITY = 2.6;
const HEMI_SKY = 0xcfe0f5;
const HEMI_GROUND = 0x77736a;
const HEMI_INTENSITY = 0.55;
const EXPOSURE = 1.05;
// 走行環境(時間帯・天候)の基準 = 「昼・晴れ」の値(environmentPresets.js の resolveEnvironment に渡す)
const BASE_ATMO = {
  zenith: SKY_ZENITH, horizon: SKY_HORIZON, ground: SKY_GROUND, sunColor: SUN_COLOR, sunDir: SUN_DIR.toArray(),
  sunIntensity: SUN_INTENSITY, hemiSky: HEMI_SKY, hemiGround: HEMI_GROUND, hemiIntensity: HEMI_INTENSITY,
  fogDensity: FOG_DENSITY, exposure: EXPOSURE,
};

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
export const CityScene = forwardRef(function CityScene({ courseEngine, vehicle = 'bike', qualityMode = 'auto', onQualityChange, environment, cameraView = 'chase' }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
  // 品質段階の変化(自動調整による段階変更を含む)を親へ通知する。最新のコールバックを参照するためrefで持つ。
  const onQualityChangeRef = useRef(onQualityChange);
  onQualityChangeRef.current = onQualityChange;

  useImperativeHandle(ref, () => ({
    draw({ distanceKm, speedKmh, cadenceRpm, others, myLaneOffsetM }) {
      const s = sceneRef.current;
      if (!s || !courseEngine) return;
      try {
        adaptQuality(s);
        drawFrame(s, courseEngine, distanceKm, speedKmh ?? 0, cadenceRpm, others, Number.isFinite(myLaneOffsetM) ? myLaneOffsetM : 0);
      } catch (err) {
        // 実行時にWebGLコンテキストロスト等が起きても、アプリ全体を
        // 巻き込んでクラッシュさせない。
        setRenderError(String(err));
      }
    },
    /** フルスクリーン切替などでキャンバスの表示サイズが変わった時に呼ぶ。 */
    resize() {
      if (sceneRef.current) resizeScene(sceneRef.current);
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let scene3d;
    try {
      scene3d = initScene(canvas, vehicle);
      sceneRef.current = scene3d;
    } catch (err) {
      setRenderError(String(err));
      return;
    }

    // 走行環境(時間帯・天候)。昼・晴れなら何もしない(従来の見た目のまま)。
    scene3d.env = createEnvironmentController(scene3d, {
      base: BASE_ATMO, hemiLight: scene3d.hemiLight, sunLight: scene3d.sunLight,
      wetMaterials: [scene3d.road.mesh.material, scene3d.crossStreets.mesh.material],
      headlightParent: scene3d.rider.group,
    });
    scene3d.env.set(environment, { immediate: true });
    scene3d.cam.view = normalizeCameraView(cameraView);

    const resize = () => resizeScene(scene3d);
    scene3d.onQualityChange = (tierName) => onQualityChangeRef.current?.(tierName);
    scene3d.appliedQualityMode = qualityMode;
    setupQuality(scene3d, qualityMode);
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      disposeScene(scene3d);
      sceneRef.current = null;
    };
  }, []);

  // 走行中に描画品質のモードが変更されたら適用する(初回はsetupQualityで適用済み)。
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || s.appliedQualityMode === qualityMode) return;
    s.appliedQualityMode = qualityMode;
    setQualityMode(s, qualityMode);
  }, [qualityMode]);

  // 走行中に時間帯・天候が変わったら、空を焼き直し、光・霧などを約1.5秒かけて切り替える。
  useEffect(() => {
    sceneRef.current?.env.set(environment);
  }, [environment?.time, environment?.weather]);

  // 視点の切り替え(即時)。次の draw() から反映される。
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.cam.view = normalizeCameraView(cameraView);
  }, [cameraView]);

  return h(
    'div', { className: 'city-scene-wrap' },
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas', 'data-vehicle': vehicle }),
    renderError &&
      h(
        'div', { className: 'city-scene-fallback' },
        '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。'
      )
  );
});

// ---- シーン初期化 ----

function initScene(canvas, vehicle) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
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

  const hemiLight = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(SUN_COLOR), SUN_INTENSITY);
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
    // 敷地は横に広いので、カーブ内側で曲率半径を超えて裏返らないよう横オフセットを丸める。
    clampInside: true,
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

  const rider = createAvatar(vehicle);
  scene.add(rider.group);

  const s = {
    canvas, renderer, scene, camera, sky, hemiLight, sunLight, textures: tex.all,
    road, sidewalk, lot, crossStreets, crosswalks,
    facades, storefronts, roofs, roofUnits,
    trunks, canopies, lamps, carBodies, carGlass, carWheels,
    rider,
    // 視点: view = 'chase' | 'fp' | 'cine'、crankRad = 目線の揺れ用のクランク角、director = cine のショット切り替え
    cam: { view: 'chase', crankRad: 0, director: createCineDirector() },
    clock: new THREE.Clock(),
    // 道路フレーム(buildRouteFrame の戻り値)。毎フレーム配列と要素を使い回して GC を抑える。
    routeFrame: [],
  };
  s.place = placer(s);
  // 他のライダー(ゴースト・集団)。プールは初めて描画範囲に入ったときに作る
  s.others = createOtherRiders(scene, vehicle, s.textures);
  return s;
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

function buildRibbon(segments, material, { uScale, vTileM, clampInside = false }) {
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return { mesh, geometry, segments, uScale, vTileM, sampleCount: 0, clampInside };
}

/**
 * リボンの頂点を道路の向き(frame)に沿って並べ直す。
 * frame は profile と同じ opts で作るので、同じインデックスのサンプルが同じ alongM を指す。
 */
function updateRibbon(ribbon, profile, frame, distanceM) {
  const { geometry, segments, uScale, vTileM, clampInside } = ribbon;
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
    // toLocal(frame, alongM, x) と同じ計算(道路中心 + 右ベクトル·x)をサンプルから直接行う。
    // 直線フレームでは x = seg.x, z = −alongM となり、従来の頂点と一致する。
    const f = frame[i];
    const rx = Math.cos(f.yaw);
    const rz = -Math.sin(f.yaw);
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const idx = i * vertsPerSample + s * 2;
      const x0 = clampInside ? clampInsideOffset(f.k, seg.x0) : seg.x0;
      const x1 = clampInside ? clampInsideOffset(f.k, seg.x1) : seg.x1;
      pos.setXYZ(idx, f.x + rx * x0, elevM + seg.y0, f.z + rz * x0);
      pos.setXYZ(idx + 1, f.x + rx * x1, elevM + seg.y1, f.z + rz * x1);
      uv.setXY(idx, seg.u0 ?? seg.x0 * uScale, v);
      uv.setXY(idx + 1, seg.u1 ?? seg.x1 * uScale, v);
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.computeVertexNormals();
}

// ---- 毎フレームの更新 ----

// toLocalInto の出力先(配置ループ・カメラで使い回す)
const _local = { x: 0, z: 0, yaw: 0 };

function drawFrame(s, courseEngine, distanceKm, speedKmh, cadenceRpm, others, myLaneM) {
  const distanceM = distanceKm * 1000;
  const profile = buildElevationProfile((km) => courseEngine.gradeAtKm(km), distanceKm, WINDOW_OPTS);
  // 平面上のカーブ。標高プロファイルと同じ opts で作り、同じインデックスが同じ alongM を指すようにする。
  // curve のないコースでは直線フレームになり、配置は従来(x = xOffsetM, z = −alongM)と一致する。
  const curve = courseEngine.profile.curve ?? [];
  const loopM = courseEngine.profile.loopLengthKm * 1000;
  const frame = buildRouteFrame(curve, loopM, distanceM, WINDOW_OPTS, s.routeFrame);
  s.routeFrame = frame;
  const elevAt = (relAlongM) => interpolateElevation(profile, relAlongM);
  const pitchAt = (relAlongM) => Math.atan((elevAt(relAlongM + 1.5) - elevAt(relAlongM - 1.5)) / 3);

  updateRibbon(s.road, profile, frame, distanceM);
  updateRibbon(s.sidewalk, profile, frame, distanceM);
  updateRibbon(s.lot, profile, frame, distanceM);

  // 配置物は cityLayout の alongM / xOffsetM のまま受け取り、place() でワールド座標へ変換する。
  const { place } = s;
  const objects = collectSceneObjects(distanceM - BEHIND_M, distanceM + AHEAD_M);
  updateIntersections(s, objects.intersections, distanceM, elevAt, pitchAt, place);
  updateBuildings(s, objects.buildings, distanceM, elevAt, place);
  updateStreetFurniture(s, objects, distanceM, elevAt, pitchAt, place);
  // カーブでは内側へ傾ける(直線・curve のないコースでは k = 0 で従来どおり)
  const roll = riderRollRad(curvatureAtM(curve, loopM, distanceM), speedKmh / 3.6);
  // 自分のアバターの横移動(集団を避ける)。0 なら従来の位置
  s.rider.group.position.x = RIDER_X_M + myLaneM;
  updateRiderAvatar(s.rider, s.clock, speedKmh, pitchAt(0), roll);
  updateOthers(s, others, distanceM, elevAt, pitchAt, curve, loopM);
  updateCamera(s, elevAt, frame, { distanceM, speedKmh, cadenceRpm, roll, riderX: RIDER_X_M + myLaneM });
  // 走行環境の補間と雨粒(カメラ位置を使うのでカメラの後)。太陽の向きは時間帯で変わる(昼は初期化時と同じ値)。
  s.env.update();
  s.sunLight.position.copy(s.sunLight.target.position).addScaledVector(s.env.sunDir, 180);

  s.renderer.render(s.scene, s.camera);
}

/**
 * 道路沿いの配置関数を作る。従来の pushInstance(pool, xOffsetM, y, −rel, sx, sy, sz, rotX, rotY, c) を
 * place(pool, rel, xOffsetM, y, sx, sy, sz, rotX, rotY, c) に置き換え、
 * toLocalInto で位置を、道路の向き(yaw)を rotY に足して向きを道路に沿わせる。
 * フレームは毎フレーム更新される s.routeFrame を参照する(関数自体はシーン生成時に1回だけ作る)。
 * ヨー→ピッチの順(YXZ)で回すので、坂の途中のカーブでも物体は道路の向きのまま前後に傾く
 * (rotX と rotY の一方が 0 なら従来の XYZ 順と同じ行列になる)。
 * 建物の屋上設備のように物体ローカルのオフセット(dx: 右, dz: 後ろ)を持つものは、
 * 本体と同じ yaw で回してから足し、本体と一体で回るようにする。
 */
function placer(s) {
  // 配置物ごとにオブジェクトを作らないよう、変換結果は使い回しの _local に受ける。
  return function place(pool, rel, xOffsetM, y, sx, sy, sz, rotX = 0, rotY = 0, colorHex, dx = 0, dz = 0) {
    const p = toLocalInto(s.routeFrame, rel, xOffsetM, _local);
    let x = p.x;
    let z = p.z;
    if (dx !== 0 || dz !== 0) {
      // Three.js の rotation.y = yaw と同じ回転(直線では yaw = 0 で従来の足し算と一致)
      const c = Math.cos(p.yaw);
      const sn = Math.sin(p.yaw);
      x += dx * c + dz * sn;
      z += -dx * sn + dz * c;
    }
    pushInstanceYawPitch(pool, x, y, z, sx, sy, sz, rotY + p.yaw, rotX, colorHex);
  };
}

function updateIntersections(s, intersections, distanceM, elevAt, pitchAt, place) {
  // 交差道路・横断歩道は中心の位置と向きで置く(道路に直交のまま)。
  for (const { alongM } of intersections) {
    const rel = alongM - distanceM;
    const streetCenter = rel + CROSSWALK_LENGTH_M + CROSS_STREET_WIDTH_M / 2;
    place(s.crossStreets, streetCenter, 0, elevAt(streetCenter), 1, 1, 1, pitchAt(streetCenter));
    for (const cwCenter of [rel + CROSSWALK_LENGTH_M / 2, rel + INTERSECTION_LENGTH_M - CROSSWALK_LENGTH_M / 2]) {
      place(s.crosswalks, cwCenter, 0, elevAt(cwCenter) + 0.01, 1, 1, 1, pitchAt(cwCenter));
    }
  }
  commitPool(s.crossStreets);
  commitPool(s.crosswalks);
}

function updateBuildings(s, buildings, distanceM, elevAt, place) {
  for (const b of buildings) {
    const rel = b.alongM - distanceM;
    const groundY = elevAt(rel) + CURB_HEIGHT_M;
    const baseY = groundY - BUILDING_SINK_M;

    // 本体: X=奥行き, Z=間口(道路沿いの長さ)。外壁シェーダーがこのスケールから窓を並べる。
    // カーブでは道路の向き(yaw)で回り、間口が道路に沿う。
    place(s.facades[b.style], rel, b.xOffsetM, baseY, b.depth, b.height + BUILDING_SINK_M, b.width, 0, 0, b.tint);
    if (b.storefront) {
      place(s.storefronts, rel, b.xOffsetM, baseY, b.depth + 0.3, FLOOR_HEIGHT_M + BUILDING_SINK_M, b.width + 0.3);
    }
    // 屋上のパラペット(外壁より少し張り出したスラブ)と屋上設備
    const roofY = groundY + b.height;
    place(s.roofs, rel, b.xOffsetM, roofY, b.depth + 0.35, ROOF_SLAB_M, b.width + 0.35);
    for (const u of b.roofUnits) {
      // 屋上設備は建物ローカルのオフセットとして本体と同じ向きで回す。
      place(s.roofUnits, rel, b.xOffsetM, roofY + ROOF_SLAB_M * 0.5, u.sizeX, u.sizeY, u.sizeZ, 0, 0, undefined, u.u * b.depth, u.v * b.width);
    }
  }
  for (const style of BUILDING_STYLES) commitPool(s.facades[style]);
  commitPool(s.storefronts);
  commitPool(s.roofs);
  commitPool(s.roofUnits);
}

function updateStreetFurniture(s, { trees, lamps, cars }, distanceM, elevAt, pitchAt, place) {
  for (const t of trees) {
    const rel = t.alongM - distanceM;
    const groundY = elevAt(rel) + CURB_HEIGHT_M;
    place(s.trunks, rel, t.xOffsetM, groundY, t.scale, 3.4 * t.scale, t.scale);
    // 樹冠は複数の葉の塊で構成する。形は木ごとのseedで決定的に決める。
    const rand = mulberry32(t.seed);
    for (let i = 0; i < CANOPY_BLOBS_PER_TREE; i++) {
      const r = (1.3 + rand() * 0.6) * t.scale;
      const ox = (rand() - 0.5) * 1.4 * t.scale;
      const oz = (rand() - 0.5) * 1.4 * t.scale;
      const oy = (3.6 + i * 0.7 + rand() * 0.4) * t.scale;
      // ぶれ(ox, oz)は小さいので道路沿いの座標のまま足す(z + oz は alongM − oz)。
      place(s.canopies, rel - oz, t.xOffsetM + ox, groundY + oy, r, r, r, 0, rand() * Math.PI, t.leafColor);
    }
  }
  for (const l of lamps) {
    const rel = l.alongM - distanceM;
    place(s.lamps, rel, l.xOffsetM, elevAt(rel) + CURB_HEIGHT_M, 1, 1, 1, 0, l.side > 0 ? 0 : Math.PI);
  }
  for (const c of cars) {
    const rel = c.alongM - distanceM;
    const y = elevAt(rel);
    const pitch = pitchAt(rel);
    place(s.carBodies, rel, c.xOffsetM, y, 1, 1, 1, pitch, 0, c.color);
    place(s.carGlass, rel, c.xOffsetM, y, 1, 1, 1, pitch, 0);
    place(s.carWheels, rel, c.xOffsetM, y, 1, 1, 1, pitch, 0);
  }
  commitPool(s.trunks);
  commitPool(s.canopies);
  commitPool(s.lamps);
  commitPool(s.carBodies);
  commitPool(s.carGlass);
  commitPool(s.carWheels);
}

// 他のライダーの配置の出力先(使い回し)
const _otherLocal = { x: 0, z: 0, yaw: 0 };

/** 他のライダー(ゴースト・集団)を道路に沿って置く。向き・標高・坂・カーブでの傾きも道路に合わせる。 */
function updateOthers(s, others, distanceM, elevAt, pitchAt, curve, loopM) {
  s.others.update(others, distanceM, {
    dt: s.rider.dt ?? 0,
    qualityIndex: s.qualityIndex ?? 0,
    riderX: RIDER_X_M,
    // 道路(標高プロファイル・道路フレーム)は後方 BEHIND_M までしか作らないので、それより後ろの人は描かない
    behindM: BEHIND_M,
    place(gapM, lateralM, speedMps, out) {
      const p = toLocalInto(s.routeFrame, gapM, lateralM, _otherLocal);
      out.x = p.x;
      out.z = p.z;
      out.yaw = p.yaw;
      out.y = elevAt(gapM);
      out.pitch = pitchAt(gapM);
      out.roll = riderRollRad(curvatureAtM(curve, loopM, distanceM + gapM), speedMps);
      return out;
    },
  });
  const { pack, ghosts, labels } = s.others.stats;
  const tag = `${pack}/${ghosts}/${labels}`;
  if (s.canvas.dataset.others !== tag) s.canvas.dataset.others = tag;
}

function updateCamera(s, elevAt, frame, motion) {
  const { view } = s.cam;
  setAvatarVisible(s.rider, view !== 'fp');
  if (view === 'fp') {
    updateFirstPersonCamera(s, elevAt, frame, motion);
    return;
  }
  if (view === 'cine') {
    updateCineCamera(s, elevAt, frame, motion);
    return;
  }
  setCameraFov(s.camera, CHASE_FOV_DEG);
  // アバターごとの補正(スワンボートは斜め後ろ上から見る)
  const { sideM, raiseM, backM } = s.rider.camera;
  const camBack = CAM_BACK_M + backM;
  const camY = elevAt(-camBack) + CAM_HEIGHT_M + raiseM;
  // カメラも道路に沿わせる(後方・前方の道路上の点から見る。直線では従来の位置と一致)。
  // 自分のアバターの横移動に追従する(myLaneOffsetM = 0 なら riderX = RIDER_X_M で従来と同じ)
  const p = toLocalInto(frame, -camBack, motion.riderX + 0.4 + sideM, _local);
  s.camera.position.set(p.x, camY, p.z);
  const lookY = elevAt(CAM_LOOKAHEAD_M) + CAM_LOOKAHEAD_HEIGHT_M;
  const q = toLocalInto(frame, CAM_LOOKAHEAD_M, RIDER_X_M * 0.4 + (motion.riderX - RIDER_X_M), _local);
  s.camera.lookAt(q.x, lookY, q.z);
}

/** 目線視点: ライダーの目の位置から前方を見る。ケイデンスで上下に揺れ、カーブでは傾きの半分だけ傾く。 */
function updateFirstPersonCamera(s, elevAt, frame, { speedKmh, cadenceRpm, roll, riderX }) {
  const cadence = cadenceRpm ?? estimateCadenceRpm(speedKmh);
  const bob = fpBobM(s.cam, cadence, s.rider.dt ?? 0);
  const p = toLocalInto(frame, FP_FORWARD_M, riderX, _local);
  s.camera.position.set(p.x, elevAt(FP_FORWARD_M) + s.rider.camera.eyeM + bob, p.z);
  const q = toLocalInto(frame, FP_LOOKAHEAD_M, riderX, _local);
  s.camera.lookAt(q.x, elevAt(FP_LOOKAHEAD_M) + FP_LOOK_HEIGHT_M, q.z);
  s.camera.rotateZ(fpCameraRollRad(roll));
  setCameraFov(s.camera, fpFovDeg(speedKmh / 3.6));
}

/** cine 視点: 沿道の固定カメラ(歩道の上)とヘリ視点から、ライダーを追って映す。 */
function updateCineCamera(s, elevAt, frame, { distanceM, riderX }) {
  const shot = s.cam.director.update(performance.now() / 1000, distanceM);
  if (shot.type === 'heli') {
    const p = toLocalInto(frame, -CINE_HELI_BACK_M, shot.side * CINE_HELI_LATERAL_M, _local);
    s.camera.position.set(p.x, elevAt(-CINE_HELI_BACK_M) + shot.heightM, p.z);
  } else {
    const rel = shot.s - distanceM;
    // ライダーと同じ左側の車道端(縁石の内側)。歩道の上は街灯・街路樹に、右側は駐車車両に遮られやすい
    const x = -(ROAD_HALF_WIDTH_M - CINE_CURB_INSET_M - shot.lateralU * CINE_CURB_SPREAD_M);
    const p = toLocalInto(frame, rel, x, _local);
    // 街路樹の樹冠(地上約3.6m〜)より下に抑え、高い沿道カメラでも葉越しにならないようにする
    s.camera.position.set(p.x, elevAt(rel) + Math.min(shot.heightM, CINE_MAX_HEIGHT_M), p.z);
  }
  const q = toLocalInto(frame, 0, riderX, _local);
  s.camera.lookAt(q.x, elevAt(0) + CINE_LOOK_HEIGHT_M, q.z);
  setCameraFov(s.camera, shot.fovDeg);
  s.canvas.dataset.cineShot = `${shot.index}:${shot.type}`;
}
