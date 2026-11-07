import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import { mulberry32 } from '../three/cityLayout.js';
import {
  getLandscape, roadEdgeM, roadCenterX, roadSlopeX, lateralX,
  createElevationSampler, createFloorModel, terrainHeightM, terrainColor, collectLandscapeObjects,
} from '../three/landscapeLayout.js';
import { createLandscapeTextures } from '../three/landscapeMaterials.js';
import { createAnchoredRoute, headingAtM, lateralSigmaM, curvatureAtM, hasCurve } from '../three/routeLayout.js';
import {
  RIDER_X_M, bakeSky, mergeGeometries, buildCanopyGeometry, createAvatar, updateRiderAvatar,
  makePool, pushInstance, pushInstanceYawPitch, commitPool, setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene,
  setCameraFov, setAvatarVisible,
  reportReadyAfterDraw,
} from '../three/sceneKit.js';
import {
  createCineDirector, normalizeCameraView, riderRollRad, fpCameraRollRad, estimateCadenceRpm, fpBobM, fpFovDeg, CHASE_FOV_DEG,
  AERIAL_BACK_M, AERIAL_HEIGHT_M, AERIAL_SIDE_M, AERIAL_LOOKAHEAD_M, AERIAL_LOOK_HEIGHT_M, AERIAL_FOV_DEG,
} from '../three/cameraViews.js';
import { createEnvironmentController } from '../three/sceneEnvironment.js';
import { seasonalTree } from '../three/seasonLook.js';
import { createOtherRiders } from '../three/otherRiders.js';
import { createRoadsideActors } from '../three/roadsideActors.js';
import { clearZones, inClearZone } from '../three/roadsideLayout.js';
import { landmarkActors } from '../three/happeningsLayout.js';
import { createBackdrop } from '../three/backdrops.js';
import { createOcean } from '../three/oceanWater.js';
import { createRealTerrain } from '../three/realTerrain.js';
import { REAL_TERRAIN, GSI_ATTRIBUTION } from '../three/gsiTerrain.js';
import { buildTourParts, placeTourObjects } from '../three/tourParts.js';

const { forwardRef, useImperativeHandle } = React;

const fract01 = (x) => x - Math.floor(x);

// 景色ごとの空・光・大気。フォグ色は空の地平線色と揃え、遠景が空に溶け込むようにする。
const ATMOSPHERE = {
  lakeside: {
    zenith: '#3a7cc9', horizon: '#d3e3ee', ground: '#8ea39a', sunColor: '#fff3de',
    // 左前方やや高めの太陽: 左手に広がる湖面に日差しがきらめく
    sunDir: new THREE.Vector3(-0.5, 0.6, -0.62).normalize(),
    hemiSky: 0xcfe2f5, hemiGround: 0x6f7a5a, fog: 0.00042, water: 0x2d5f78,
  },
  mountain: {
    zenith: '#2c6cc6', horizon: '#d6e4ef', ground: '#8f9a9c', sunColor: '#fff1dc',
    // 左後方の高い太陽: 正面の山並みが順光で立体的に見える
    sunDir: new THREE.Vector3(-0.45, 0.72, 0.3).normalize(),
    hemiSky: 0xd2e1f3, hemiGround: 0x6a6a5c, fog: 0.00034, water: 0x3a6c70,
  },
  // 秋晴れの京都: 左前方の太陽が通りの町家に斜めの日差しを落とす。京都タワー・西山が霞みすぎないよう薄めのフォグ
  kyoto: {
    zenith: '#3576c8', horizon: '#dfe6ea', ground: '#9a9a92', sunColor: '#fff0d8',
    sunDir: new THREE.Vector3(-0.42, 0.6, -0.55).normalize(),
    hemiSky: 0xd6e2ef, hemiGround: 0x7a7466, fog: 0.00028, water: 0x3d6460,
  },
  nara: {
    zenith: '#3a7cc9', horizon: '#dbe5ea', ground: '#90a08a', sunColor: '#fff2dc',
    sunDir: new THREE.Vector3(-0.45, 0.6, -0.55).normalize(),
    hemiSky: 0xd0e2f2, hemiGround: 0x6f7a5a, fog: 0.00032, water: 0x3c5f58,
  },
  kawaguchiko: {
    zenith: '#3a7cc9', horizon: '#d3e3ee', ground: '#8ea39a', sunColor: '#fff3de',
    sunDir: new THREE.Vector3(-0.5, 0.6, -0.62).normalize(),
    hemiSky: 0xcfe2f5, hemiGround: 0x6f7a5a, fog: 0.00032, water: 0x2d6075,
  },
  // 竜宮城の海底: 真上から差し込む光と、青く霞む海の中(見通し約320m)。空は水面を見上げた色で焼き(underwater)、
  // 時間帯は海の中の色(palettes)で変える。夜は深海の暗さ
  ryugu: {
    zenith: '#86d8ec', horizon: '#0e5876', ground: '#05283c', sunColor: '#d2f4ff',
    sunDir: new THREE.Vector3(-0.2, 0.93, -0.3).normalize(),
    hemiSky: 0x7fcbe0, hemiGround: 0x1d4a5c, fog: 0.0062, water: 0x1f6f8a,
    underwater: true,
    palettes: {
      morning: { zenith: '#a6dccf', horizon: '#1f5d78', ground: '#0b2f40', sunColor: '#ffe2b8', hemiSky: 0xa9d6d0, hemiGround: 0x1e3e48, cloud: '#ffffff' },
      sunset: { zenith: '#e8a27e', horizon: '#2a4a6a', ground: '#10283a', sunColor: '#ffb27a', hemiSky: 0xd8a890, hemiGround: 0x1a2a38, cloud: '#ffffff' },
      night: { zenith: '#0a2440', horizon: '#03111f', ground: '#010811', sunColor: '#7fa6d8', hemiSky: 0x2c4a78, hemiGround: 0x061018, cloud: '#ffffff' },
    },
  },
};

// 光の強さ・露出(全景色共通)
const SUN_INTENSITY = 2.6;
const HEMI_INTENSITY = 0.6;
const EXPOSURE = 1.05;

/** 走行環境(時間帯・天候)の基準 = 「昼・晴れ」の値(environmentPresets.js の resolveEnvironment に渡す)。 */
function baseAtmo(atmo) {
  return {
    zenith: atmo.zenith, horizon: atmo.horizon, ground: atmo.ground, sunColor: atmo.sunColor, sunDir: atmo.sunDir.toArray(),
    sunIntensity: SUN_INTENSITY, hemiSky: atmo.hemiSky, hemiGround: atmo.hemiGround, hemiIntensity: HEMI_INTENSITY,
    fogDensity: atmo.fog, exposure: EXPOSURE,
    ...(atmo.underwater ? { underwater: true, palettes: atmo.palettes } : {}),
  };
}

// 近景(道路・樹木・ガードレール)を描く範囲。地形はさらに遠く(FAR_AHEAD_M)まで敷く。
const NEAR_BEHIND_M = 40;
const NEAR_AHEAD_M = 330;
// 世界(地形・道路・配置物)はライダーがこの距離進むごとに組み直す。間のフレームは
// グループの平行移動・回転だけで描くため、毎フレームの負荷は非常に小さい。
const REBUILD_M = 16;
const ROW_STEP_NEAR_M = 4;
const ROW_STEP_MID_M = 20;
const MID_AHEAD_M = 1000;
const ROW_STEP_FAR_M = 100;
const FAR_AHEAD_M = 3600;
const FAR_BEHIND_M = 200;
const FAR_TREE_AHEAD_M = 1200;

// 路肩外縁からの横方向の列の位置(m)。道路付近は細かく、遠くほど粗くする。
const OUTER_COLUMNS_M = [0.4, 1, 2, 3.5, 5.5, 8, 11, 15, 20, 27, 36, 48, 64, 85, 110, 145, 190, 250, 330, 430, 560, 720, 920, 1170, 1480, 1850, 2300, 2850, 3500];
const HILL_MAX_COLUMN_M = 2300;

const ROAD_STEP_M = 3;
const ROAD_TILE_M = 12;
const SHOULDER_TILE_M = 2;
const TERRAIN_TILE_M = 5;
const WATER_TILE_M = 18;
// 海は水平線まで見えるので、水面とカメラの描画距離は十分大きくとる。
const WATER_SIZE_M = 50000;
// 描画品質「最高(実験)」で水面を映り込む水面にする景色(水面が見えるもの。熱海は AtamiScene。京都・奈良は水面を地形の下に
// 隠しているだけ、竜宮城は海の中なので対象外。描く手間が倍になるので見えない水面には使わない)
const REFLECTIVE_WATER = new Set(['lakeside', 'mountain', 'kawaguchiko']);
const CAMERA_FAR_M = 25000;
const GUARDRAIL_POST_SPACING_M = 4;
const WALL_SEGMENT_M = 4;

const CAM_BACK_M = 6.5;
const CAM_HEIGHT_M = 3.2;
const CAM_LOOKAHEAD_M = 26;
const CAM_LOOKAHEAD_HEIGHT_M = 1.2;
// 注視点をライダーより少し谷/湖側へ寄せ、見下ろす景色が画面に入るようにする。
const CAM_LOOK_LATERAL_M = RIDER_X_M - 0.8;
// 目線視点(fp): 少し前・目の高さから、20m先の路面より少し上を見る
const FP_FORWARD_M = 0.25;
const FP_LOOKAHEAD_M = 20;
const FP_LOOK_HEIGHT_M = 1.25;
// cine 視点: 沿道カメラは谷側の車道端から 0.2〜0.6m 外(路肩の上)、ヘリはライダーの後ろ16m・横12m。どちらも地形より上に置く
const CINE_ROADSIDE_MIN_M = 0.2;
const CINE_ROADSIDE_SPREAD_M = 0.4;
const CINE_HELI_BACK_M = 16;
const CINE_HELI_LATERAL_M = 12;
const CINE_HELI_CLEARANCE_M = 4;
const CINE_LOOK_HEIGHT_M = 1.0;

const MAX_TREES = 500;
const CANOPY_BLOBS_PER_TREE = 3;
const MAX_FAR_TREES = 1400;
const MAX_ROCKS = 200;
const MAX_GUARDRAIL = 160;
const MAX_DELINEATORS = 40;
const MAX_WALL_SEGMENTS = 140;
const MAX_HOUSES = 220; // 京都は町並みの奥まで家が建ち並ぶ
const MAX_BOATS = 16;

/**
 * 丘陵(湖を見下ろす湖畔の丘陵地)・山岳(谷と雪を頂く山並み)コースの3Dビュー。
 * CitySceneと同じくref経由のdraw({distanceKm, speedKmh})で描画する。
 *
 * 地形・道路・配置物は絶対距離に固定した格子で生成し、REBUILD_Mごとに組み直す。
 * 組み直しの間は、ライダーを原点に保つよう世界全体のグループを平行移動し、
 * 道路のカーブの向きに合わせて回転させるだけで描画する。
 *
 * 道路のカーブは2通り(配置アダプター、createPlacement):
 * - コースプロファイルに curve があるコース(丘陵・山岳)は routeLayout.js の
 *   createAnchoredRoute で、組み直しのアンカー地点を原点とする平面上のカーブ道路に沿って置く。
 * - curve がないコースは従来どおり景色側の L.curves による横ずらしの蛇行
 *   (lateralX/roadCenterX/roadSlopeX)。見た目を変えないため、計算式もそのまま使う。
 */
export const LandscapeScene = forwardRef(function LandscapeScene({ courseEngine, landscape, vehicle = 'bike', qualityMode = 'auto', onQualityChange, onReady, environment, cameraView = 'chase', season = null }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  // 実在の地形(最高(実験))を出している間の出典表示。毎フレームの再描画を避けるため DOM を直接書き換える
  const attributionRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
  // 品質段階の変化(自動調整による段階変更を含む)を親へ通知する。最新のコールバックを参照するためrefで持つ。
  const onQualityChangeRef = useRef(onQualityChange);
  onQualityChangeRef.current = onQualityChange;
  // 景色の準備ができたら1回だけ知らせる(RideScreen はそれまで走行を始めない)
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // 3D 表示が使えない(WebGL の初期化・描画の失敗)ときは景色なしで走れるよう、準備完了として知らせる
  useEffect(() => {
    if (renderError) onReadyRef.current?.();
  }, [renderError]);

  useImperativeHandle(ref, () => ({
    draw({ distanceKm, speedKmh, cadenceRpm, others, myLaneOffsetM, actors }) {
      const s = sceneRef.current;
      if (!s) return;
      try {
        adaptQuality(s);
        drawFrame(s, distanceKm, speedKmh ?? 0, cadenceRpm, others, Number.isFinite(myLaneOffsetM) ? myLaneOffsetM : 0, actors);
        reportReadyAfterDraw(s);
      } catch (err) {
        // 実行時にWebGLコンテキストロスト等が起きても、アプリ全体を巻き込んでクラッシュさせない。
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
    if (!canvas || !courseEngine) return;

    let scene3d;
    try {
      scene3d = initScene(canvas, courseEngine, getLandscape(landscape), vehicle);
      // 走る日の季節(竜宮城の海底は null)。地形・木の色は次の組み立て(rebuild)から使う
      scene3d.season = scene3d.L.underwater ? null : season;
      sceneRef.current = scene3d;
      scene3d.onReady = () => onReadyRef.current?.();
    } catch (err) {
      setRenderError(String(err));
      return;
    }

    // 走行環境(時間帯・天候)。昼・晴れなら何もしない(従来の見た目のまま)。
    const pools = scene3d.pools;
    scene3d.env = createEnvironmentController(scene3d, {
      base: baseAtmo(scene3d.atmo), hemiLight: scene3d.hemiLight, sunLight: scene3d.sunLight,
      wetMaterials: [scene3d.road.material],
      // 夜はデリニエーター(視線誘導標)の反射を明るくする
      glowMaterials: [
        { material: pools.delineatorLens.mesh.material, night: 4 },
        ...(scene3d.tour ? scene3d.tour.glowMaterials : []),
      ],
      headlightParent: scene3d.rider.group,
      // 海の底に雨は降らない(時間帯だけ反映)
      weather: !scene3d.L.underwater,
      season: scene3d.season,
    });
    scene3d.env.set(environment, { immediate: true });
    scene3d.cam.view = normalizeCameraView(cameraView);

    const resize = () => resizeScene(scene3d);
    scene3d.attributionEl = attributionRef.current;
    scene3d.onQualityChange = (tierName) => onQualityChangeRef.current?.(tierName);
    scene3d.appliedQualityMode = qualityMode;
    setupQuality(scene3d, qualityMode);
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      // 差し替え中の水面マテリアル・実在の地形の写真はシーンをたどっても見つからないので先に解放する
      scene3d.ocean?.dispose();
      scene3d.realTerrain?.dispose();
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
    sceneRef.current?.env?.set(environment);
  }, [environment?.time, environment?.weather]);

  // 視点の切り替え(即時)。次の draw() から反映される。
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.cam.view = normalizeCameraView(cameraView);
  }, [cameraView]);

  return h(
    'div', { className: 'city-scene-wrap' },
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas', 'data-scenery': getLandscape(landscape).id, 'data-vehicle': vehicle }),
    h('div', { ref: attributionRef, className: 'scene-attribution', hidden: true }),
    renderError &&
      h(
        'div', { className: 'city-scene-fallback' },
        '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。'
      )
  );
});

// ---- シーン初期化 ----

function initScene(canvas, courseEngine, L, vehicle) {
  const atmo = ATMOSPHERE[L.id];
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(atmo.horizon), atmo.fog);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, CAMERA_FAR_M);

  const sky = bakeSky(renderer, atmo);
  scene.background = sky.background;
  scene.environmentIntensity = 0.8;

  const hemiLight = new THREE.HemisphereLight(atmo.hemiSky, atmo.hemiGround, HEMI_INTENSITY);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(atmo.sunColor), SUN_INTENSITY);
  sunLight.target.position.set(0, 0, -60);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -90, right: 90, top: 110, bottom: -110, near: 10, far: 420 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.05;
  scene.add(hemiLight, sunLight, sunLight.target);

  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = createLandscapeTextures(L, anisotropy);

  // root: 道路の向きに合わせた回転 / inner: ライダーを原点に置く平行移動
  const root = new THREE.Group();
  const inner = new THREE.Group();
  root.add(inner);
  scene.add(root);

  const terrain = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.terrain, roughness: 0.96 })
  );
  terrain.receiveShadow = true;
  terrain.frustumCulled = false;
  const road = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: tex.road, roughness: 0.9 }));
  road.receiveShadow = true;
  road.frustumCulled = false;
  const shoulder = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: tex.shoulder, roughness: 1 }));
  shoulder.receiveShadow = true;
  shoulder.frustumCulled = false;
  inner.add(terrain, road, shoulder);

  // 水面(湖/川)。無限に広い平面として扱うため、回転だけ受けるrootに置き高さは毎フレーム合わせる。
  tex.water.repeat.set(WATER_SIZE_M / WATER_TILE_M, WATER_SIZE_M / WATER_TILE_M);
  const waterGeo = new THREE.PlaneGeometry(WATER_SIZE_M, WATER_SIZE_M);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeo,
    new THREE.MeshStandardMaterial({
      color: atmo.water, roughness: 0.07, metalness: 0, normalMap: tex.water, normalScale: new THREE.Vector2(0.35, 0.35),
    })
  );
  water.frustumCulled = false;
  // 竜宮城の海底は海の中なので、湖・海の水面は描かない
  water.visible = !L.underwater;
  root.add(water);

  // ---- 配置物のプール ----
  const trunkGeo = new THREE.CylinderGeometry(0.1, 0.16, 1, 7).translate(0, 0.5, 0);
  const trunks = makePool(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 }), MAX_TREES);
  const canopies = makePool(buildCanopyGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.95 }), MAX_TREES * CANOPY_BLOBS_PER_TREE);
  const conifers = makePool(buildConiferGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.95 }), MAX_TREES);
  const farCones = makePool(new THREE.ConeGeometry(1, 1, 6, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 1 }), MAX_FAR_TREES, { cast: false });
  const farBlobs = makePool(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 1 }), MAX_FAR_TREES, { cast: false });
  const rocks = makePool(buildRockGeometry(), new THREE.MeshStandardMaterial({ color: 0x8a867d, roughness: 0.95 }), MAX_ROCKS);
  const railMat = new THREE.MeshStandardMaterial({ color: 0xd4d8dc, roughness: 0.35, metalness: 0.6 });
  const railPosts = makePool(new THREE.CylinderGeometry(0.06, 0.06, 1, 8).translate(0, 0.5, 0), railMat, MAX_GUARDRAIL);
  const railBeams = makePool(new THREE.BoxGeometry(0.06, 0.32, 1), railMat, MAX_GUARDRAIL);
  const delineatorPosts = makePool(new THREE.BoxGeometry(0.08, 1, 0.08).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5 }), MAX_DELINEATORS);
  const delineatorLens = makePool(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xff8a1f, emissive: 0x7a3000, roughness: 0.3 }), MAX_DELINEATORS, { cast: false });
  const walls = makePool(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ map: tex.wall, roughness: 0.95 }), MAX_WALL_SEGMENTS);
  const houseBodies = makePool(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ roughness: 0.85 }), MAX_HOUSES);
  const houseRoofs = makePool(buildGableRoofGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }), MAX_HOUSES);
  const boatHulls = makePool(new THREE.BoxGeometry(2, 0.7, 6).translate(0, 0.2, 0), new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.4 }), MAX_BOATS, { cast: false });
  const boatSails = makePool(buildSailGeometry(), new THREE.MeshStandardMaterial({ color: 0xfbfbf8, roughness: 0.6, side: THREE.DoubleSide }), MAX_BOATS, { cast: false });
  inner.add(
    trunks.mesh, canopies.mesh, conifers.mesh, farCones.mesh, farBlobs.mesh, rocks.mesh,
    railPosts.mesh, railBeams.mesh, delineatorPosts.mesh, delineatorLens.mesh, walls.mesh,
    houseBodies.mesh, houseRoofs.mesh, boatHulls.mesh, boatSails.mesh
  );

  // 観光地コース(京都・奈良・河口湖・竜宮城の海底)の町並み・名物。海底は地形・砂の道に水面の光の模様を重ねる
  // (テクスチャ座標1あたりのメートルと、沿う向きの繰り返しの長さ)
  const tour = L.tour
    ? buildTourParts(inner, L, atmo.water, {
      causticTargets: [
        { material: terrain.material, scale: [TERRAIN_TILE_M, TERRAIN_TILE_M], periodM: TERRAIN_TILE_M },
        { material: road.material, scale: [L.roadHalfWidthM * 2, ROAD_TILE_M], periodM: ROAD_TILE_M },
      ],
    })
    : null;
  if (tour) tex.all.push(...tour.textures);

  const rider = createAvatar(vehicle);
  scene.add(rider.group);

  const elev = createElevationSampler((km) => courseEngine.gradeAtKm(km));
  const loopM = courseEngine.profile.loopLengthKm * 1000;
  const floor = createFloorModel(elev, loopM, L.valley.minDropM, { fixedLength: !!courseEngine.profile.fixedLength });
  const curve = courseEngine.profile.curve;

  // 空と一緒に回る遠景(富士山など)。コースプロファイルの backdrop で選ぶ。シーンに入れるので disposeScene で解放される
  const backdrop = createBackdrop(courseEngine.profile.backdrop);
  if (backdrop) scene.add(backdrop.object);

  // 描画品質「最高(実験)」(sceneKit の s.ultra): 水面の見える景色は映り込む水面に、実在の場所をモデルにした
  // 景色(河口湖・京都・奈良)は国土地理院のタイルから作る実在の地形の遠景を足す
  const ocean = REFLECTIVE_WATER.has(L.id) ? createOcean(water) : null;
  const realCfg = REAL_TERRAIN[L.id] ?? null;
  const realTerrain = realCfg
    ? createRealTerrain(realCfg, { anisotropy, onStatus: () => updateUltraStatus(st) })
    : null;
  if (realTerrain) scene.add(realTerrain.object);

  const st = {
    L, atmo, canvas, renderer, scene, camera, sky, hemiLight, sunLight, textures: tex.all, waterNormal: tex.water,
    ocean, realTerrain, realCfg, ultraOn: false,
    onUltraChange: (on) => setUltra(st, on),
    root, inner, terrain, road, shoulder, water,
    pools: {
      trunks, canopies, conifers, farCones, farBlobs, rocks, railPosts, railBeams,
      delineatorPosts, delineatorLens, walls, houseBodies, houseRoofs, boatHulls, boatSails,
      ...(tour ? tour.pools : {}),
    },
    tour,
    rider, elev, floor,
    // 他のライダー(ゴースト・集団)。世界と一緒に動くよう inner に置く。プールは初めて描画範囲に入ったときに作る
    others: createOtherRiders(inner, vehicle, tex.all),
    // curve があるコースだけ平面カーブの道路(route モード)。null なら従来の L.curves(legacy モード)。
    curve: hasCurve(curve) ? curve : null,
    loopM,
    cols: terrainColumns(L),
    anchorS: null, anchorElev: 0,
    placement: null,
    // route モードの水面の模様用: ライダーの道路中心の位置を、方位を積分して追う(さざ波を地面に固定する)
    waterOdo: { s: null, x: 0, z: 0 },
    // 視点: view = 'chase' | 'aerial' | 'fp' | 'cine'、crankRad = 目線の揺れ用のクランク角、director = cine のショット切り替え
    cam: { view: 'chase', crankRad: 0, director: createCineDirector() },
    clock: new THREE.Clock(),
    startedAt: performance.now(),
    profile: courseEngine.profile,
    // 沿道のハプニング・名所。他のライダーと同じく inner に置く。模型は初めて出るときに作る
    actors: createRoadsideActors(inner, tex.all),
    backdrop,
  };
  st.actorPlace = actorPlacer(st);
  st.actorGround = (gapM, lateralM) => groundOffsetM(st, st.actorDist + gapM, lateralM);
  return st;
}

// ---- ジオメトリ生成ヘルパー ----

/** 針葉樹(高さ約10m、幹は別プール)。4段の円錐を重ねる。 */
function buildConiferGeometry() {
  const tiers = [
    [2.0, 4.0, 1.2],
    [1.6, 3.6, 3.4],
    [1.15, 3.2, 5.4],
    [0.7, 2.6, 7.4],
  ];
  return mergeGeometries(tiers.map(([r, hgt, y]) => new THREE.ConeGeometry(r, hgt, 9, 1).translate(0, y + hgt / 2, 0)));
}

/** 岩: 多面体を位置依存のノイズで歪ませる。 */
function buildRockGeometry() {
  const geo = new THREE.DodecahedronGeometry(1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = 1 + 0.22 * Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.3 - x) + 0.12 * Math.sin(y * 5.3 + z * 4.1);
    pos.setXYZ(i, x * n * 1.2, y * n * 0.7, z * n);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 切妻屋根(単位サイズ: 幅1×奥行き1×高さ1、棟はZ方向)。 */
function buildGableRoofGeometry() {
  const p = [
    // 左右の屋根面
    [-0.5, 0, 0.5], [0, 1, 0.5], [0, 1, -0.5], [-0.5, 0, 0.5], [0, 1, -0.5], [-0.5, 0, -0.5],
    [0.5, 0, 0.5], [0.5, 0, -0.5], [0, 1, -0.5], [0.5, 0, 0.5], [0, 1, -0.5], [0, 1, 0.5],
    // 妻側の三角
    [-0.5, 0, 0.5], [0.5, 0, 0.5], [0, 1, 0.5],
    [0.5, 0, -0.5], [-0.5, 0, -0.5], [0, 1, -0.5],
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p.flat(), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(p.length * 2).fill(0), 2));
  geo.computeVertexNormals();
  return geo;
}

/** ヨットの帆(三角形、マストの位置が原点)。 */
function buildSailGeometry() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.6, 1.2, 0, 8, 0.4, 0, 0.6, -2.4], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0], 2));
  geo.computeVertexNormals();
  return geo;
}

// ---- 世界の組み直し ----

function terrainRows(anchorS) {
  const rows = [];
  const nearStart = anchorS - NEAR_BEHIND_M;
  const nearEnd = anchorS + NEAR_AHEAD_M + REBUILD_M;
  for (let s = Math.ceil((anchorS - FAR_BEHIND_M) / ROW_STEP_MID_M) * ROW_STEP_MID_M; s < nearStart; s += ROW_STEP_MID_M) rows.push(s);
  for (let s = Math.ceil(nearStart / ROW_STEP_NEAR_M) * ROW_STEP_NEAR_M; s <= nearEnd; s += ROW_STEP_NEAR_M) rows.push(s);
  const midEnd = anchorS + MID_AHEAD_M;
  for (let s = Math.floor(nearEnd / ROW_STEP_MID_M) * ROW_STEP_MID_M + ROW_STEP_MID_M; s <= midEnd; s += ROW_STEP_MID_M) rows.push(s);
  for (let s = Math.floor(midEnd / ROW_STEP_FAR_M) * ROW_STEP_FAR_M + ROW_STEP_FAR_M; s <= anchorS + FAR_AHEAD_M; s += ROW_STEP_FAR_M) rows.push(s);
  return rows;
}

function terrainColumns(L) {
  const edge = roadEdgeM(L);
  const valley = OUTER_COLUMNS_M.map((u) => -(edge + u)).reverse();
  const hill = OUTER_COLUMNS_M.filter((u) => u <= HILL_MAX_COLUMN_M).map((u) => edge + u);
  return [...valley, -edge, -(L.roadHalfWidthM + 0.6), L.roadHalfWidthM + 0.6, edge, ...hill];
}

/** 頂点数が変わった時だけ属性とインデックスを確保し直す。 */
function ensureGrid(geometry, rowCount, colCount, withColor) {
  const vertexCount = rowCount * colCount;
  const pos = geometry.attributes.position;
  if (pos && pos.count === vertexCount && geometry.userData.cols === colCount) return;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
  if (withColor) geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
  const indices = [];
  for (let r = 0; r < rowCount - 1; r++) {
    for (let c = 0; c < colCount - 1; c++) {
      const a = r * colCount + c;
      const b = a + 1;
      const c2 = a + colCount;
      const d = c2 + 1;
      indices.push(a, b, c2, b, d, c2);
    }
  }
  geometry.setIndex(indices);
  geometry.userData.cols = colCount;
}

const _col = new THREE.Color();

// 組み直し時のアンカー前後に、平面カーブの経路を積分しておく範囲(地形の行の範囲+余裕)。
const ROUTE_BEHIND_M = FAR_BEHIND_M + 2 * REBUILD_M;
const ROUTE_AHEAD_M = FAR_AHEAD_M + 2 * REBUILD_M;
const ROUTE_STEP_M = 4;

/**
 * 配置アダプター。アンカー基準の座標(inner の中)で、絶対距離 s・道路中心から右へ d の点の
 * 位置 {x, z} と、その点での道路の向き yaw(配置物の回転に足す。正 = 左向き)を返す place(s, d) と、
 * ライダー・カメラ用の riderFrame / offset を持つ。
 *
 * - route モード: createAnchoredRoute。横に遠い点ほど中心線の位置を平滑化した経路に沿うので、
 *   横 ±数km の地形格子もカーブの内側で折り重ならない(平滑化は絶対距離の格子上で行い、組み直しで跳ばない)。
 * - legacy モード: 従来の lateralX/roadCenterX/roadSlopeX をそのまま使う(数値も従来と同一)。
 */
function createPlacement(st, anchorS) {
  const { L, curve } = st;
  if (!curve) {
    // 向きは s だけで決まるので、同じ行(同じ s)の列をまとめて置く地形格子では1回だけ求める
    let yawS = NaN;
    let yaw = 0;
    return {
      route: null,
      place: (s, d) => {
        if (s !== yawS) {
          yawS = s;
          yaw = -Math.atan(roadSlopeX(L, s));
        }
        return { x: lateralX(L, s, d), z: -(s - anchorS), yaw };
      },
      placeAt: null,
      // ライダー地点の道路中心(アンカー基準)と、進行方向を −Z に戻す root の回転
      riderFrame: (dist) => ({ x: roadCenterX(L, dist), z: -(dist - anchorS), rot: Math.atan(roadSlopeX(L, dist)) }),
      // 道路上の地点 (s, d) のライダー地点からの相対位置(回転前)
      offset: (dist, s, d) => [roadCenterX(L, s) + d - roadCenterX(L, dist), -(s - dist)],
    };
  }
  const route = createAnchoredRoute(curve, st.loopM, anchorS, { behindM: ROUTE_BEHIND_M, aheadM: ROUTE_AHEAD_M, stepM: ROUTE_STEP_M });
  const cols = st.cols;
  const last = cols.length - 2;
  /**
   * 任意の横距離 d の配置物用。平滑化の σ は d ごとに箱フィルタをかけ直すことになるので、
   * 道路近く(σ = 0)以外は地形の列(σ が限られた種類)の間を線形補間する。
   * 地形メッシュ自体も列の間は線形なので、配置物が地表の位置とずれない。
   */
  const placeAt = (s, d) => {
    if (lateralSigmaM(d) === 0) return route.place(s, d);
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cols[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const d0 = cols[lo];
    const d1 = cols[lo + 1];
    const a = route.place(s, d0);
    if (d === d0) return a;
    const b = route.place(s, d1);
    const t = (d - d0) / (d1 - d0); // 列の外側は端の2列から外挿
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: a.yaw + (b.yaw - a.yaw) * t };
  };
  return {
    route,
    // アンカー地点の絶対方位 H(anchorS)。組み直しごとに1回だけ求め、水面の向きに使う
    anchorHeading: headingAtM(curve, st.loopM, anchorS),
    place: route.place,
    placeAt,
    riderFrame: (dist) => {
      const p = route.place(dist, 0);
      // 左カーブで向きが増えるので、ライダーの進行方向を −Z に戻すには逆向きに回す
      return { x: p.x, z: p.z, rot: -route.headingAt(dist) };
    },
    offset: (dist, s, d) => {
      const p = route.place(dist, 0);
      const q = route.place(s, d);
      return [q.x - p.x, q.z - p.z];
    },
  };
}

function rebuildWorld(st, anchorS) {
  const { L, elev } = st;
  st.anchorS = anchorS;
  st.anchorElev = elev.elevAt(anchorS);
  st.placement = createPlacement(st, anchorS);
  const floorM = st.floor.floorAt(anchorS);

  buildTerrain(st, anchorS, floorM);
  buildRoad(st, anchorS);
  placeObjects(st, anchorS, floorM);
}

function buildTerrain(st, anchorS, floorM) {
  const { L, elev, anchorElev, placement } = st;
  const rows = terrainRows(anchorS);
  const cols = st.cols;
  const curved = placement.route !== null;
  const geometry = st.terrain.geometry;
  ensureGrid(geometry, rows.length, cols.length, true);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const vBase = ((anchorS % TERRAIN_TILE_M) + TERRAIN_TILE_M) % TERRAIN_TILE_M;
  const heights = new Float32Array(rows.length * cols.length);
  for (let r = 0; r < rows.length; r++) {
    const s = rows[r];
    const roadE = elev.elevAt(s);
    const v = (vBase + (s - anchorS)) / TERRAIN_TILE_M;
    for (let c = 0; c < cols.length; c++) {
      const d = cols[c];
      const i = r * cols.length + c;
      const hgt = terrainHeightM(L, d, s, roadE, floorM);
      heights[i] = hgt;
      const p = placement.place(s, d);
      pos.setXYZ(i, p.x, hgt - anchorElev, p.z);
      // route モードの x はアンカーごとに回転した座標なので、模様は横距離 d に固定する
      uv.setXY(i, (curved ? d : p.x) / TERRAIN_TILE_M, v);
    }
  }
  pos.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  const color = geometry.attributes.color;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols.length; c++) {
      const i = r * cols.length + c;
      const [cr, cg, cb] = terrainColor(L, cols[c], rows[r], heights[i], floorM, normals.getY(i), st.season);
      _col.setRGB(cr, cg, cb, THREE.SRGBColorSpace);
      color.setXYZ(i, _col.r, _col.g, _col.b);
    }
  }
  color.needsUpdate = true;
}

function buildRoad(st, anchorS) {
  const { L, elev, anchorElev, placement } = st;
  const half = L.roadHalfWidthM;
  const edge = roadEdgeM(L);
  const roadCols = [{ x: -half, u: 0 }, { x: half, u: 1 }];
  // 路肩は左右2本の帯(各2頂点)。車道より3cm低くして段差をつける。
  const shoulderCols = [
    { x: -edge, u: 0 }, { x: -half, u: (edge - half) / SHOULDER_TILE_M },
    { x: half, u: 0 }, { x: edge, u: (edge - half) / SHOULDER_TILE_M },
  ];
  const first = Math.ceil((anchorS - NEAR_BEHIND_M) / ROAD_STEP_M) * ROAD_STEP_M;
  const rows = [];
  for (let s = first; s <= anchorS + NEAR_AHEAD_M + REBUILD_M; s += ROAD_STEP_M) rows.push(s);

  const fill = (mesh, cols, tileM, yOffset, quadPairs) => {
    const geometry = mesh.geometry;
    const vertexCount = rows.length * cols.length;
    if (!geometry.attributes.position || geometry.attributes.position.count !== vertexCount) {
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
      const indices = [];
      for (let r = 0; r < rows.length - 1; r++) {
        for (const [c0, c1] of quadPairs) {
          const a = r * cols.length + c0;
          const b = r * cols.length + c1;
          const c = a + cols.length;
          const d = b + cols.length;
          indices.push(a, b, c, b, d, c);
        }
      }
      geometry.setIndex(indices);
    }
    const pos = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    const vBase = ((anchorS % tileM) + tileM) % tileM;
    for (let r = 0; r < rows.length; r++) {
      const s = rows[r];
      const y = elev.elevAt(s) - anchorElev + yOffset;
      const v = (vBase + (s - anchorS)) / tileM;
      for (let c = 0; c < cols.length; c++) {
        const i = r * cols.length + c;
        // legacy では lateralX = roadCenterX + 横距離(|d| ≤ 150m は完全追従)で従来と同じ値
        const p = placement.place(s, cols[c].x);
        pos.setXYZ(i, p.x, y, p.z);
        uv.setXY(i, cols[c].u, v);
      }
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    geometry.computeVertexNormals();
  };
  fill(st.road, roadCols, ROAD_TILE_M, 0, [[0, 1]]);
  fill(st.shoulder, shoulderCols, SHOULDER_TILE_M, -0.03, [[0, 1], [2, 3]]);
}

function placeObjects(st, anchorS, floorM) {
  const { L, elev, anchorElev, pools: p, placement } = st;
  const from = anchorS - NEAR_BEHIND_M;
  const to = anchorS + NEAR_AHEAD_M + REBUILD_M;
  const objects = collectLandscapeObjects(L, from, to, { farToM: anchorS + FAR_TREE_AHEAD_M });
  const edge = roadEdgeM(L);
  // 名所(大鳥居の柱・五重塔の基壇)のある所には木・岩・家を置かない(名所のないコースでは空)
  const zones = clearZones(landmarkActors(st.profile, anchorS, NEAR_BEHIND_M + REBUILD_M, FAR_TREE_AHEAD_M), L.roadHalfWidthM);
  const blocked = (s, d, r) => zones.length > 0 && inClearZone(zones, s, d, r, r);

  const groundAt = (s, d) => terrainHeightM(L, d, s, elev.elevAt(s), floorM);
  // [x, y, z, 道路の向き]。配置物の回転は「元の回転 + 道路の向き」にする。
  const placeAt = placement.placeAt ?? placement.place;
  const local = (s, d, hgt) => {
    const q = placeAt(s, d);
    return [q.x, hgt - anchorElev, q.z, q.yaw];
  };
  const steepness = (s, d, hgt) => Math.abs(groundAt(s, d + Math.sign(d) * 1.5) - hgt) / 1.5;
  const treeOk = (s, d, hgt) => {
    if (hgt < floorM + 1.2) return false; // 水中・水際
    if (L.treeline !== null && hgt - floorM > L.treeline) return false;
    return steepness(s, d, hgt) < L.trees.maxSlope;
  };

  for (const t of objects.trees) {
    if (blocked(t.s, t.d, 2 * t.scale)) continue;
    const hgt = groundAt(t.s, t.d);
    if (!treeOk(t.s, t.d, hgt)) continue;
    const [x, y, z] = local(t.s, t.d, hgt);
    // 走る日の季節の色(山の上ほど紅葉が早く、雪線より上の木は雪をかぶる)。道ばたの落葉樹の1割は桜
    const look = seasonalTree(st.season, t.color, hgt, (t.seed % 9973) / 9973, { conifer: t.kind === 'conifer', sakura: 0.1 });
    if (t.kind === 'conifer') {
      pushInstance(p.trunks, x, y - 0.3, z, t.scale * 1.2, 1.8 * t.scale, t.scale * 1.2);
      pushInstance(p.conifers, x, y, z, t.scale, t.scale, t.scale, 0, t.seed % 7, look.color);
    } else {
      pushInstance(p.trunks, x, y - 0.3, z, t.scale, 3.6 * t.scale, t.scale);
      const rand = mulberry32(t.seed);
      for (let i = 0; i < CANOPY_BLOBS_PER_TREE; i++) {
        const r = (1.5 + rand() * 0.7) * t.scale * look.scale;
        const ox = (rand() - 0.5) * 1.6 * t.scale;
        const oz = (rand() - 0.5) * 1.6 * t.scale;
        const oy = (3.8 + i * 0.8 + rand() * 0.4) * t.scale;
        pushInstance(p.canopies, x + ox, y + oy, z + oz, r, r, r, 0, rand() * Math.PI, look.color);
      }
    }
  }

  for (const t of objects.farTrees) {
    if (blocked(t.s, t.d, 3 * t.scale)) continue;
    const hgt = groundAt(t.s, t.d);
    if (!treeOk(t.s, t.d, hgt)) continue;
    const [x, y, z] = local(t.s, t.d, hgt);
    const look = seasonalTree(st.season, t.color, hgt, fract01(t.s * 0.0137 + t.d * 0.071), { conifer: t.kind === 'conifer' });
    if (t.kind === 'conifer') {
      pushInstance(p.farCones, x, y - 0.5, z, 2.2 * t.scale, 9 * t.scale, 2.2 * t.scale, 0, 0, look.color);
    } else {
      const k = look.scale;
      pushInstance(p.farBlobs, x, y + 2.6 * t.scale, z, 3 * t.scale * k, 3.2 * t.scale * k, 3 * t.scale * k, 0, 0, look.color);
    }
  }

  for (const r of objects.rocks) {
    if (blocked(r.s, r.d, r.size)) continue;
    const hgt = groundAt(r.s, r.d);
    if (hgt < floorM + 0.5) continue;
    const [x, y, z] = local(r.s, r.d, hgt);
    pushInstance(p.rocks, x, y - r.size * 0.25, z, r.size, r.size, r.size, r.tilt, r.yaw, 0xffffff);
  }

  // ガードレール(谷側の路肩外寄り)。支柱を等間隔に立て、隣り合う支柱の頭をビームで結ぶ。
  const railD = -(edge - 0.4);
  for (const run of objects.guardrailRuns) {
    let prev = null;
    for (let s = Math.ceil(run.fromS / GUARDRAIL_POST_SPACING_M) * GUARDRAIL_POST_SPACING_M; s <= run.toS; s += GUARDRAIL_POST_SPACING_M) {
      const [x, y, z] = local(s, railD, elev.elevAt(s));
      pushInstance(p.railPosts, x, y - 0.1, z, 1, 0.85, 1);
      if (prev) {
        const dx = x - prev[0];
        const dy = y - prev[1];
        const dz = z - prev[2];
        const len = Math.hypot(dx, dy, dz);
        pushInstanceYawPitch(p.railBeams, (x + prev[0]) / 2, (y + prev[1]) / 2 + 0.6, (z + prev[2]) / 2, 1, 1, len, Math.atan2(-dx, -dz), Math.asin(dy / len));
      }
      prev = [x, y, z];
    }
  }

  for (const dl of objects.delineators) {
    const [x, y, z, yaw] = local(dl.s, dl.d, elev.elevAt(dl.s));
    pushInstance(p.delineatorPosts, x, y - 0.05, z, 1, 1.15, 1);
    // レンズは支柱の 5cm 手前(進行方向の逆側)。route モードは前方 (−sin yaw, 0, −cos yaw) の逆向きへずらす
    const lx = placement.route ? 0.05 * Math.sin(yaw) : 0;
    const lz = placement.route ? 0.05 * Math.cos(yaw) : 0.05;
    pushInstance(p.delineatorLens, x + lx, y + 1.0, z + lz, 1, 1, 1, 0, yaw + Math.PI / 2);
  }

  // 擁壁(山側の路肩の外、切土面の前)
  for (const w of objects.walls) {
    for (let s = Math.ceil(w.fromS / WALL_SEGMENT_M) * WALL_SEGMENT_M; s + WALL_SEGMENT_M <= w.toS; s += WALL_SEGMENT_M) {
      const mid = s + WALL_SEGMENT_M / 2;
      const [x0, y0, z0] = local(s, edge + 0.1, elev.elevAt(s));
      const [x1, y1, z1] = local(s + WALL_SEGMENT_M, edge + 0.1, elev.elevAt(s + WALL_SEGMENT_M));
      const [, yMid] = local(mid, edge, elev.elevAt(mid));
      const dx = x1 - x0;
      const dz = z1 - z0;
      const yaw = Math.atan2(-dx, -dz);
      // 壁厚の半分だけ山側(道路の右)へ。legacy は従来どおり x 方向にずらす
      const ox = placement.route ? 0.25 * Math.cos(yaw) : 0.25;
      const oz = placement.route ? -0.25 * Math.sin(yaw) : 0;
      pushInstanceYawPitch(p.walls, (x0 + x1) / 2 + ox, yMid - 0.4, (z0 + z1) / 2 + oz, 0.5, w.heightM + 0.4, Math.hypot(dx, y1 - y0, dz) + 0.02, yaw, 0);
    }
  }

  for (const hs of objects.houses) {
    if (blocked(hs.s, hs.d, Math.max(hs.widthM, hs.depthM) / 2)) continue;
    const hgt = groundAt(hs.s, hs.d);
    if (hgt < floorM + 2 || steepness(hs.s, hs.d, hgt) > 0.45) continue;
    const [x, y, z, roadYaw] = local(hs.s, hs.d, hgt);
    const yaw = roadYaw + hs.yaw;
    pushInstance(p.houseBodies, x, y - 1.2, z, hs.depthM, hs.heightM + 1.2, hs.widthM, 0, yaw, hs.wall);
    pushInstance(p.houseRoofs, x, y + hs.heightM, z, hs.depthM + 0.9, 2.2, hs.widthM + 0.9, 0, yaw, hs.roof);
  }

  for (const b of objects.boats) {
    if (groundAt(b.s, b.d) > floorM - 1) continue; // 陸地・浅瀬には置かない
    const [x, , z] = local(b.s, b.d, floorM);
    const y = floorM - anchorElev;
    pushInstance(p.boatHulls, x, y, z, b.scale, b.scale, b.scale, 0, b.yaw);
    pushInstance(p.boatSails, x, y, z, b.scale, b.scale, b.scale, 0, b.yaw);
  }

  if (objects.tour) placeTourObjects(st, objects.tour, { groundAt, local, blocked, floorM });

  for (const pool of Object.values(p)) commitPool(pool);
}

// ---- 毎フレームの更新 ----

const _sun = new THREE.Vector3();

function drawFrame(st, distanceKm, speedKmh, cadenceRpm, others, myLaneM, actors) {
  const { L, elev } = st;
  const dist = distanceKm * 1000;
  if (st.anchorS === null || Math.abs(dist - st.anchorS) > REBUILD_M) {
    rebuildWorld(st, Math.round(dist / ROW_STEP_NEAR_M) * ROW_STEP_NEAR_M);
  }
  const riderElev = elev.elevAt(dist);
  // ライダー地点の道路中心を原点へ平行移動し、進行方向が −Z になるよう回す
  const frame = st.placement.riderFrame(dist);
  const heading = frame.rot;
  st.root.rotation.y = heading;
  st.inner.position.set(-frame.x, st.anchorElev - riderElev, -frame.z);

  // 水面: 高さは毎フレーム(組み直し時点の地形とのずれは数cm)、さざ波の模様は絶対位置に固定
  st.water.position.y = st.floor.floorAt(dist) - riderElev;
  const t = (performance.now() - st.startedAt) / 1000;
  if (st.placement.route) {
    // 水面は root に置くので、アンカーの絶対方位だけ戻して向きを地面に固定し(組み直しで模様が回らない)、
    // 模様のずれはライダーの道路中心の位置(方位の積分)で与える。
    st.water.rotation.y = -st.placement.anchorHeading;
    const w = advanceWaterOdometer(st, dist);
    st.waterNormal.offset.set((w.x / WATER_TILE_M + t * 0.004) % 1, (w.z / WATER_TILE_M + t * 0.01) % 1);
  } else {
    st.waterNormal.offset.set((roadCenterX(L, dist) / WATER_TILE_M + t * 0.004) % 1, (-dist / WATER_TILE_M + t * 0.01) % 1);
  }

  // 空・太陽は地形と一緒に回す(カーブで向きが変わると太陽の方向も変わる)。
  // route モードの root の回転はアンカー基準(−(H(dist) − H(anchorS)))で、組み直しのたびに基準が変わるので、
  // 空・環境・太陽にはライダーの絶対方位 −H(dist) を使う(= root の回転 − H(anchorS)。組み直しをまたいで連続)。
  // legacy の root の回転はもともと絶対方位なので従来どおり。
  const skyHeading = st.placement.route ? -headingAtM(st.curve, st.loopM, dist) : heading;
  st.scene.backgroundRotation.y = skyHeading;
  st.scene.environmentRotation.y = skyHeading;
  // 太陽の向きは走行環境の時間帯で変わる(昼は景色ごとの atmo.sunDir と同じ値)
  _sun.copy(st.env.sunDir).applyAxisAngle(THREE.Object3D.DEFAULT_UP, skyHeading);
  st.sunLight.position.copy(st.sunLight.target.position).addScaledVector(_sun, 180);

  const pitch = Math.atan((elev.elevAt(dist + 1.5) - elev.elevAt(dist - 1.5)) / 3);
  // 自分のアバターの横移動(集団を避ける)。0 なら従来の位置
  const riderX = RIDER_X_M + myLaneM;
  const riderPos = worldPoint(st, dist, dist, riderX, 0);
  st.rider.group.position.set(riderPos[0], riderPos[1], riderPos[2]);
  // カーブでは内側へ傾ける(curve のないコース・直線では k = 0 で従来どおり)
  const roll = riderRollRad(st.curve ? curvatureAtM(st.curve, st.loopM, dist) : 0, speedKmh / 3.6);
  updateRiderAvatar(st.rider, st.clock, speedKmh, pitch, roll);
  updateOthers(st, others, dist);
  updateActors(st, actors, dist);
  updateCamera(st, dist, { speedKmh, cadenceRpm, roll, riderX });
  // 竜宮城の海底: 魚の群れ・マンタ・泡、昆布の揺れ・水面の光の模様
  if (st.tour?.animate) st.tour.animate(st, t);

  // 走行環境の補間と雨粒(カメラ位置を使うのでカメラの後)
  st.env.update();
  // 遠景は空と同じだけ回し、麓を湖面の高さに置く。色は走行環境を反映した後の光・フォグから決める
  if (st.backdrop) {
    st.backdrop.update({
      skyHeading, baseY: st.water.position.y, sunDir: st.env.sunDir,
      hemiLight: st.hemiLight, sunLight: st.sunLight, fog: st.scene.fog,
    });
  }
  if (st.realTerrain) {
    st.realTerrain.update({
      enabled: st.ultraOn, skyHeading,
      // 基準面: 海・湖の景色は水面、京都・奈良はライダーのいる道路の高さ
      baseY: st.realCfg.anchor === 'origin' ? st.rider.group.position.y : st.water.position.y,
      sunDir: st.env.sunDir, hemiLight: st.hemiLight, sunLight: st.sunLight, fog: st.scene.fog,
    });
    const real = st.realTerrain.object.visible;
    // 実在の地形に本物の富士山があるので、手続き生成のものは隠す
    if (st.realCfg.hideBackdrop && st.backdrop) st.backdrop.object.visible = !real;
  }
  st.ocean?.render(st.renderer, st.scene, st.camera, t);
  st.renderer.render(st.scene, st.camera);
}

/** 描画品質「最高(実験)」の入り切り(sceneKit の applyQuality から呼ばれる。影の解像度は sceneKit が変える)。 */
function setUltra(st, on) {
  st.ultraOn = on;
  st.ocean?.setEnabled(on);
  if (on) st.realTerrain?.load();
  updateUltraStatus(st);
}

/** 実在の地形の読み込み状態を canvas の data 属性と出典表示に反映する。 */
function updateUltraStatus(st) {
  if (!st?.realTerrain) return;
  const status = st.realTerrain.status;
  st.canvas.dataset.realTerrain = st.ultraOn ? status : 'off';
  const el = st.attributionEl;
  if (!el) return;
  if (st.ultraOn && status === 'ready') {
    el.textContent = GSI_ATTRIBUTION;
    el.hidden = false;
  } else if (st.ultraOn && status === 'error') {
    el.textContent = '実在の地形を読み込めませんでした(通信を確認してください)';
    el.hidden = false;
  } else if (st.ultraOn && status === 'loading') {
    el.textContent = '実在の地形を読み込み中…';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/**
 * 他のライダー(ゴースト・集団)を inner(アンカー基準の座標)に置く。地形・配置物と同じ placement で、
 * 向き・標高・坂・カーブでの傾きを道路に合わせる。
 */
function updateOthers(st, others, dist) {
  const { elev, placement } = st;
  st.others.update(others, dist, {
    dt: st.rider.dt ?? 0,
    qualityIndex: st.qualityIndex ?? 0,
    riderX: RIDER_X_M,
    // 道路は組み直しのアンカーの後方 NEAR_BEHIND_M(40m)から作るので、その手前(道路のある所)までに抑える
    // (アンカーは自分の前後 16m 以内でずれるため、自分基準の後方範囲は 24〜56m の間で変わる。上限 40m)
    behindM: dist - (st.anchorS - NEAR_BEHIND_M),
    place(gapM, lateralM, speedMps, out) {
      const s = dist + gapM;
      const p = placement.place(s, lateralM);
      out.x = p.x;
      out.z = p.z;
      out.yaw = p.yaw;
      out.y = elev.elevAt(s) - st.anchorElev;
      out.pitch = Math.atan((elev.elevAt(s + 1.5) - elev.elevAt(s - 1.5)) / 3);
      out.roll = riderRollRad(st.curve ? curvatureAtM(st.curve, st.loopM, s) : 0, speedMps);
      return out;
    },
  });
  const { pack, ghosts, labels } = st.others.stats;
  const tag = `${pack}/${ghosts}/${labels}`;
  if (st.canvas.dataset.others !== tag) st.canvas.dataset.others = tag;
}

/**
 * 沿道のハプニング・名所の配置関数(他のライダーの place と同じ形。傾き roll は使わない)。
 * inner(アンカー基準の座標)に置く。五重塔のように道路から離れた物は placeAt で地形の格子に合わせる。
 */
function actorPlacer(st) {
  return function placeActor(gapM, lateralM, speedMps, out) {
    const { elev, placement } = st;
    const s = st.actorDist + gapM;
    const p = (placement.placeAt ?? placement.place)(s, lateralM);
    out.x = p.x;
    out.z = p.z;
    out.yaw = p.yaw;
    out.y = elev.elevAt(s) - st.anchorElev;
    out.pitch = Math.atan((elev.elevAt(s + 1.5) - elev.elevAt(s - 1.5)) / 3);
    out.roll = 0;
    return out;
  };
}

/** 沿道のハプニング・名所を inner に置く。地面は山側の斜面・湖側の下り斜面に合わせる。 */
function updateActors(st, actors, dist) {
  st.actorDist = dist;
  st.actors.update(actors, dist, {
    place: st.actorPlace,
    groundAboveRoadM: st.actorGround,
    roadHalfWidthM: st.L.roadHalfWidthM,
    dt: st.rider.dt ?? 0,
    qualityIndex: st.qualityIndex ?? 0,
    // 他のライダーと同じく、道路のある所(組み直しのアンカーの後方 NEAR_BEHIND_M)まで
    behindM: dist - (st.anchorS - NEAR_BEHIND_M),
  });
  const tag = String(st.actors.stats.count);
  if (st.canvas.dataset.actors !== tag) st.canvas.dataset.actors = tag;
}

/**
 * 道路上の地点 (s, d) の地面の、路面からの高さ(m、負なら路面より低い)。車道・路肩は 0、
 * 水面より低い所は水面の高さとする。
 */
function groundOffsetM(st, s, d) {
  const { L } = st;
  const edge = roadEdgeM(L);
  const a = Math.abs(d);
  if (a <= edge) return 0;
  const roadE = st.elev.elevAt(s);
  const floorM = st.floor.floorAt(s);
  return Math.max(floorM, terrainHeightM(L, d, s, roadE, floorM)) - roadE;
}

function updateCamera(st, dist, { speedKmh, cadenceRpm, roll, riderX }) {
  const { view } = st.cam;
  setAvatarVisible(st.rider, view !== 'fp');
  if (view === 'fp') {
    // 目線視点: ケイデンスで上下に揺れ、カーブでは傾きの半分だけ傾く
    const bob = fpBobM(st.cam, cadenceRpm ?? estimateCadenceRpm(speedKmh), st.rider.dt ?? 0);
    const eye = worldPoint(st, dist, dist + FP_FORWARD_M, riderX, st.rider.camera.eyeM + bob);
    st.camera.position.set(eye[0], eye[1], eye[2]);
    const look = worldPoint(st, dist, dist + FP_LOOKAHEAD_M, riderX, FP_LOOK_HEIGHT_M);
    st.camera.lookAt(look[0], look[1], look[2]);
    st.camera.rotateZ(fpCameraRollRad(roll));
    setCameraFov(st.camera, fpFovDeg(speedKmh / 3.6));
    return;
  }
  if (view === 'cine') {
    updateCineCamera(st, dist, riderX);
    return;
  }
  // chase(斜め後ろ)と aerial(後方上空)は同じ組み方で、後ろの距離・高さ・注視点・画角だけが違う
  const aerial = view === 'aerial';
  setCameraFov(st.camera, aerial ? AERIAL_FOV_DEG : CHASE_FOV_DEG);
  // アバターごとの補正(スワンボートは斜め後ろ上から見る)
  const { sideM, raiseM, backM } = st.rider.camera;
  // 自分のアバターの横移動に追従する(myLaneOffsetM = 0 なら riderX = RIDER_X_M で従来と同じ)
  const back = (aerial ? AERIAL_BACK_M : CAM_BACK_M) + backM;
  const cam = worldPoint(st, dist, dist - back, riderX + 0.4 + sideM + (aerial ? AERIAL_SIDE_M : 0), (aerial ? AERIAL_HEIGHT_M : CAM_HEIGHT_M) + raiseM);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const lookAhead = aerial ? AERIAL_LOOKAHEAD_M : CAM_LOOKAHEAD_M;
  const look = worldPoint(st, dist, dist + lookAhead, CAM_LOOK_LATERAL_M + (riderX - RIDER_X_M), aerial ? AERIAL_LOOK_HEIGHT_M : CAM_LOOKAHEAD_HEIGHT_M);
  st.camera.lookAt(look[0], look[1], look[2]);
}

/** 道路上の地点 (s, d) の地表の、路面からの高さ(m)。谷側(路面より低い)は 0 とする。 */
function groundAboveRoadM(st, s, d) {
  const roadE = st.elev.elevAt(s);
  return Math.max(0, terrainHeightM(st.L, d, s, roadE, st.floor.floorAt(s)) - roadE);
}

/** cine 視点: 沿道の固定カメラとヘリ視点から、ライダーを追って映す(山側の斜面に埋もれないよう地形より上に置く)。 */
function updateCineCamera(st, dist, riderX) {
  const shot = st.cam.director.update(performance.now() / 1000, dist);
  let s;
  let d;
  let up;
  if (shot.type === 'heli') {
    s = dist - CINE_HELI_BACK_M;
    d = RIDER_X_M + shot.side * CINE_HELI_LATERAL_M;
    up = Math.max(shot.heightM, groundAboveRoadM(st, s, d) + CINE_HELI_CLEARANCE_M);
  } else {
    // 沿道カメラは谷側(湖・海側。d < 0)の路肩の上に置く: 山側は擁壁や斜面に、路肩の外は
    // ガードレール・ヤシ並木に遮られてライダーが見えないことが多い
    s = shot.s;
    d = -(st.L.roadHalfWidthM + CINE_ROADSIDE_MIN_M + shot.lateralU * CINE_ROADSIDE_SPREAD_M);
    up = groundAboveRoadM(st, s, d) + shot.heightM;
  }
  const cam = worldPoint(st, dist, s, d, up);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const look = worldPoint(st, dist, dist, riderX, CINE_LOOK_HEIGHT_M);
  st.camera.lookAt(look[0], look[1], look[2]);
  setCameraFov(st.camera, shot.fovDeg);
  st.canvas.dataset.cineShot = `${shot.index}:${shot.type}`;
}

/**
 * route モードの水面の模様用に、ライダーの道路中心の位置(進行方向の絶対方位で積分した平面座標)を進める。
 * 見た目だけの近似なので、大きな距離の飛び(ループの周回・巻き戻し)では位置を進めずに距離だけ合わせる。
 */
function advanceWaterOdometer(st, dist) {
  const w = st.waterOdo;
  const ds = w.s === null ? 0 : dist - w.s;
  if (Math.abs(ds) <= 200) {
    const hMid = headingAtM(st.curve, st.loopM, dist - ds / 2);
    w.x -= Math.sin(hMid) * ds;
    w.z -= Math.cos(hMid) * ds;
  }
  w.s = dist;
  return w;
}

/** 道路上の地点(絶対距離s・中心からの横距離d・路面からの高さ)を、ライダー基準のワールド座標へ。 */
function worldPoint(st, dist, s, d, heightM) {
  const { elev } = st;
  const [px, pz] = st.placement.offset(dist, s, d);
  const py = elev.elevAt(s) - elev.elevAt(dist) + heightM;
  const a = st.root.rotation.y;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [px * cos + pz * sin, py, -px * sin + pz * cos];
}
