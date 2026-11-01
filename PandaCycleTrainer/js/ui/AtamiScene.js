import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import { mulberry32, FLOOR_HEIGHT_M } from '../three/cityLayout.js';
import { createCityTextures, createFacadeMaterial, FACADE_TILE } from '../three/cityMaterials.js';
import { createCountryRoadTexture, createTerrainDetailTexture, createWaterNormalTexture } from '../three/landscapeMaterials.js';
import {
  loadAtamiData, createAtamiRoute, createTerrainSampler, seaSides, collectPromenade, yawFromDir, SUN_BEACH_T,
} from '../three/atamiRealLayout.js';
import {
  buildTerrainMesh, buildRouteMeshes, buildStreetGeometry, buildBuildingGeometries,
  buildPalmCrownGeometry, buildPromenadeLampGeometry, buildCastleGeometries,
} from '../three/atamiParts.js';
import { curvatureAtM } from '../three/routeLayout.js';
import {
  RIDER_X_M, bakeSky, createAvatar, updateRiderAvatar,
  makePool, pushInstance, commitPool, applyQuality, setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene,
  setCameraFov, setAvatarVisible,
} from '../three/sceneKit.js';
import {
  createCineDirector, normalizeCameraView, riderRollRad, fpCameraRollRad, estimateCadenceRpm, fpBobM, fpFovDeg, CHASE_FOV_DEG,
} from '../three/cameraViews.js';
import { createEnvironmentController } from '../three/sceneEnvironment.js';
import { createOtherRiders } from '../three/otherRiders.js';
import { createRoadsideActors } from '../three/roadsideActors.js';
import { createOcean } from '../three/oceanWater.js';
import { createRealTerrain } from '../three/realTerrain.js';
import { REAL_TERRAIN, GSI_ATTRIBUTION } from '../three/gsiTerrain.js';

const { forwardRef, useImperativeHandle } = React;

// 晴れた熱海の朝〜昼。太陽は南東(相模湾の上)、海面にきらめく。初島(約10km沖)まで見えるよう、フォグは薄め
const ATMO = {
  zenith: '#2f7ad6', horizon: '#d9e8f2', ground: '#a3b6bc', sunColor: '#fff4e0',
  // シーンの座標(東 +X、北 −Z)での太陽の向き: 南東の空、高度約35°
  sunDir: new THREE.Vector3(0.55, 0.62, 0.56).normalize(),
  hemiSky: 0xd4e6f7, hemiGround: 0x8a8272, fog: 0.00018, water: 0x2a6f93,
};
const SUN_INTENSITY = 2.6;
const HEMI_INTENSITY = 0.6;
const EXPOSURE = 1.05;
const BASE_ATMO = {
  zenith: ATMO.zenith, horizon: ATMO.horizon, ground: ATMO.ground, sunColor: ATMO.sunColor, sunDir: ATMO.sunDir.toArray(),
  sunIntensity: SUN_INTENSITY, hemiSky: ATMO.hemiSky, hemiGround: ATMO.hemiGround, hemiIntensity: HEMI_INTENSITY,
  fogDensity: ATMO.fog, exposure: EXPOSURE,
};

const WATER_SIZE_M = 50000;
const WATER_TILE_M = 18;
const CAMERA_FAR_M = 25000;
const ROAD_TILE_M = 12;
const PAVE_TILE_M = 2;
const SIDEWALK_M = 3;
const PROMENADE_M = 7; // サンビーチ沿いの海側の遊歩道
// 車線: 車道の左端からこの距離(m)を走る(左側通行)
const LANE_FROM_EDGE_M = 1.6;
// ハプニング・名所の配置は、半幅 NOMINAL_HALF_WIDTH_M の道路を前提にした横距離で来る
const NOMINAL_HALF_WIDTH_M = 3.5;
const OTHERS_BEHIND_M = 60;

const CAM_BACK_M = 6.5;
const CAM_HEIGHT_M = 3.2;
const CAM_LOOKAHEAD_M = 26;
const CAM_LOOKAHEAD_HEIGHT_M = 1.2;
const FP_FORWARD_M = 0.25;
const FP_LOOKAHEAD_M = 20;
const FP_LOOK_HEIGHT_M = 1.25;
const CINE_ROADSIDE_MIN_M = 0.2;
const CINE_ROADSIDE_SPREAD_M = 0.4;
const CINE_HELI_BACK_M = 16;
const CINE_HELI_LATERAL_M = 12;
const CINE_HELI_CLEARANCE_M = 4;
const CINE_LOOK_HEIGHT_M = 1.0;
const CASTLE_SCALE = 1.0;
const MAX_PARASOLS = 140;

/**
 * 熱海サンビーチコースの3Dビュー。国道135号の海岸沿いの実在の道を、PLATEAU の建物 LOD1・
 * 国土地理院の標高と道路中心線(tools/atami-plateau/build.py が js/data/atami-plateau.json に変換)で描く。
 * LandscapeScene と同じ draw({ distanceKm, speedKmh, cadenceRpm, others, myLaneOffsetM, actors }) 契約。
 *
 * PondScene と同じく、世界は実在の座標(原点 = スタート地点、東 +X・北 −Z)に1度だけ組み立てて固定し、
 * 毎フレームはライダー・カメラ・影の範囲・他のライダー・ハプニングだけを動かす。データは非同期に読むので、
 * 読み終わるまでは空だけを描く(canvas の data-atami-data = loading / ready / error)。
 */
export const AtamiScene = forwardRef(function AtamiScene({ courseEngine, vehicle = 'bike', qualityMode = 'auto', onQualityChange, environment, cameraView = 'chase' }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const attributionRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
  const [dataError, setDataError] = useState(false);
  const onQualityChangeRef = useRef(onQualityChange);
  onQualityChangeRef.current = onQualityChange;

  useImperativeHandle(ref, () => ({
    draw({ distanceKm, speedKmh, cadenceRpm, others, myLaneOffsetM, actors }) {
      const s = sceneRef.current;
      if (!s) return;
      try {
        adaptQuality(s);
        drawFrame(s, distanceKm, speedKmh ?? 0, cadenceRpm, others, Number.isFinite(myLaneOffsetM) ? myLaneOffsetM : 0, actors);
      } catch (err) {
        setRenderError(String(err));
      }
    },
    resize() {
      if (sceneRef.current) resizeScene(sceneRef.current);
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !courseEngine) return;
    let st;
    try {
      st = initScene(canvas, courseEngine, vehicle);
      sceneRef.current = st;
    } catch (err) {
      setRenderError(String(err));
      return;
    }
    st.attributionEl = attributionRef.current;
    st.onQualityChange = (tierName) => onQualityChangeRef.current?.(tierName);
    st.appliedQualityMode = qualityMode;
    st.envSetting = environment;
    st.cam.view = normalizeCameraView(cameraView);
    // 世界ができるまでは走行環境の切り替え(窓の夜度などを拾う)を作らない
    canvas.dataset.atamiData = 'loading';
    loadAtamiData().then(
      (data) => {
        if (st.disposed) return;
        try {
          buildWorld(st, data);
          canvas.dataset.atamiData = 'ready';
          canvas.dataset.buildings = String(st.buildingCount);
        } catch (err) {
          setRenderError(String(err));
        }
      },
      (err) => {
        if (st.disposed) return;
        console.warn('熱海の街のデータを読み込めませんでした:', err);
        canvas.dataset.atamiData = 'error';
        setDataError(true);
      }
    );
    const resize = () => resizeScene(st);
    setupQuality(st, qualityMode);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      st.disposed = true;
      st.ocean?.dispose();
      st.realTerrain?.dispose();
      disposeScene(st);
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s || s.appliedQualityMode === qualityMode) return;
    s.appliedQualityMode = qualityMode;
    setQualityMode(s, qualityMode);
  }, [qualityMode]);

  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.envSetting = environment;
    s.env?.set(environment);
  }, [environment?.time, environment?.weather]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.cam.view = normalizeCameraView(cameraView);
  }, [cameraView]);

  return h(
    'div', { className: 'city-scene-wrap' },
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas', 'data-scenery': 'atami', 'data-vehicle': vehicle }),
    h('div', { ref: attributionRef, className: 'scene-attribution' }),
    dataError && h('div', { className: 'city-scene-fallback' }, '熱海の街のデータを読み込めませんでした(通信を確認してください)。走行と記録は続けられます。'),
    renderError &&
      h(
        'div', { className: 'city-scene-fallback' },
        '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。'
      )
  );
});

// ---- 初期化(データを待たずに作れるもの) ----

function initScene(canvas, courseEngine, vehicle) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(ATMO.horizon), ATMO.fog);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, CAMERA_FAR_M);
  camera.position.set(0, 10, 20);
  camera.lookAt(0, 5, 0);

  const sky = bakeSky(renderer, ATMO);
  scene.background = sky.background;
  scene.environmentIntensity = 0.8;

  const hemiLight = new THREE.HemisphereLight(ATMO.hemiSky, ATMO.hemiGround, HEMI_INTENSITY);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(ATMO.sunColor), SUN_INTENSITY);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 10, far: 520 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.05;
  scene.add(hemiLight, sunLight, sunLight.target);

  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const textures = [];

  // 海(相模湾)。海面 = 標高 0
  const waterNormal = createWaterNormalTexture();
  textures.push(waterNormal);
  waterNormal.repeat.set(WATER_SIZE_M / WATER_TILE_M, WATER_SIZE_M / WATER_TILE_M);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(WATER_SIZE_M, WATER_SIZE_M).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: ATMO.water, roughness: 0.07, metalness: 0, normalMap: waterNormal, normalScale: new THREE.Vector2(0.35, 0.35) })
  );
  water.frustumCulled = false;
  water.receiveShadow = true;
  scene.add(water);

  const rider = createAvatar(vehicle);
  scene.add(rider.group);

  const world = new THREE.Group();
  world.name = 'atami-world';
  scene.add(world);

  const st = {
    canvas, renderer, scene, camera, sky, hemiLight, sunLight, textures, anisotropy,
    water, waterNormal, ocean: createOcean(water), realTerrain: null, ultraOn: false,
    onUltraChange: (on) => setUltra(st, on),
    world, rider, ready: false,
    profile: courseEngine.profile, courseEngine,
    loopM: courseEngine.profile.loopLengthKm * 1000,
    others: createOtherRiders(world, vehicle, textures),
    actors: createRoadsideActors(world, textures),
    cam: { view: 'chase', crankRad: 0, director: createCineDirector() },
    clock: new THREE.Clock(),
    startedAt: performance.now(),
  };
  st.actorPlace = (gapM, lateralM, speedMps, out) => placeOnRoad(st, st.actorDist + gapM, actorLateral(st, st.actorDist + gapM, lateralM), out);
  st.actorGround = (gapM, lateralM) => groundAboveRoadM(st, st.actorDist + gapM, actorLateral(st, st.actorDist + gapM, lateralM));
  return st;
}

// ---- 世界の組み立て(データを読んだ後に1回) ----

function buildWorld(st, data) {
  const { world, anisotropy, textures } = st;
  const route = createAtamiRoute(data.route);
  const heightAt = createTerrainSampler(data);
  const sides = seaSides(data.route, heightAt);
  st.data = data;
  st.route = route;
  st.heightAt = heightAt;
  st.sides = sides;

  // 地形(近景 10m 格子、遠景 80m 格子は近景の範囲をくり抜く)
  const detail = createTerrainDetailTexture(anisotropy);
  textures.push(detail);
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96 });
  const t = data.terrain;
  const innerBox = { x0: t.x0, y0: t.y0, x1: t.x0 + (t.nx - 1) * t.step, y1: t.y0 + (t.ny - 1) * t.step };
  st.innerBox = innerBox;
  const inner = buildTerrainMesh(data.terrain, groundMat, { buildings: data.buildings, route, sides });
  const outer = buildTerrainMesh(data.outer, groundMat, { skipBox: innerBox });
  outer.traverse((m) => {
    m.receiveShadow = false;
  });
  world.add(inner, outer);
  st.outerTerrain = outer;

  // 走るルート(車道・歩道)
  const roadTex = createCountryRoadTexture(4, 'white-dashed', anisotropy);
  const city = createCityTextures(anisotropy);
  textures.push(roadTex, ...city.all);
  const sideOf = (tt) => sides[Math.min(sides.length - 1, Math.max(0, Math.round(tt / data.route.stepM)))];
  const promenadeSide = (tt) => (tt >= SUN_BEACH_T[0] - 80 && tt <= SUN_BEACH_T[1] + 520 ? sideOf(tt) : 0);
  const routeGeo = buildRouteMeshes(route, {
    roadTileM: ROAD_TILE_M,
    paveTileM: PAVE_TILE_M,
    sidewalkAt: (tt, side) => (promenadeSide(tt) === side ? PROMENADE_M : SIDEWALK_M),
  });
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const road = new THREE.Mesh(routeGeo.road, roadMat);
  const walkMat = new THREE.MeshStandardMaterial({ map: city.sidewalk, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const walk = new THREE.Mesh(routeGeo.sidewalk, walkMat);
  road.receiveShadow = true;
  walk.receiveShadow = true;
  world.add(road, walk);
  st.road = road;

  // 道路網
  const streetMat = new THREE.MeshStandardMaterial({ color: 0x5d6064, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const streets = new THREE.Mesh(buildStreetGeometry(data.streets, heightAt), streetMat);
  streets.receiveShadow = true;
  world.add(streets);

  // 建物(熱海城の位置の建物は天守に置き換える)
  const castle = data.landmarks.find((l) => l.kind === 'castle');
  const skip = castle
    ? (i) => {
      const r = data.buildings[i].ring;
      let cx = 0;
      let cy = 0;
      for (const [x, y] of r) {
        cx += x;
        cy += y;
      }
      return Math.hypot(cx / r.length - castle.x, cy / r.length - castle.y) < 14;
    }
    : null;
  const blds = buildBuildingGeometries(data.buildings, heightAt, { skip });
  st.buildingCount = blds.count;
  for (const [style, geos] of blds.walls) {
    const bayM = style === 'glass' ? 1.8 : FLOOR_HEIGHT_M;
    const mat = createFacadeMaterial({
      ...city.facades[style], bayM, floorM: FLOOR_HEIGHT_M, tileBays: FACADE_TILE.cellBays, tileFloors: FACADE_TILE.cellFloors, sinkM: 0,
    });
    mat.vertexColors = true;
    for (const g of geos) {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      world.add(m);
    }
  }
  const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  for (const g of blds.roofs) {
    const m = new THREE.Mesh(g, roofMat);
    m.castShadow = true;
    m.receiveShadow = true;
    world.add(m);
  }
  if (castle) world.add(buildCastle(castle, heightAt));

  // 海沿いの遊歩道: ヤシ並木・街灯、砂浜のパラソル
  const prom = collectPromenade(data.route, sides);
  const pools = buildPromenadePools(world, prom);
  placePromenade(st, pools, prom);
  st.pools = pools;

  // 描画品質「最高(実験)」: 映り込む海と、国土地理院のタイルの実在の地形の遠景(近景の範囲の外だけ)
  const cfg = {
    ...REAL_TERRAIN.atami,
    origin: data.origin,
    innerBox: { minX: innerBox.x0, maxX: innerBox.x1, minZ: -innerBox.y1, maxZ: -innerBox.y0 },
  };
  st.realCfg = cfg;
  st.realTerrain = createRealTerrain(cfg, { anisotropy, onStatus: () => updateAttribution(st) });
  st.scene.add(st.realTerrain.object);

  // 走行環境(時間帯・天候)。窓の夜度を拾うため建物を置いた後に作る
  st.env = createEnvironmentController(st, {
    base: BASE_ATMO, hemiLight: st.hemiLight, sunLight: st.sunLight,
    wetMaterials: [roadMat, walkMat, streetMat],
    glowMaterials: [{ material: pools.lampGlobes.mesh.material, night: 6 }],
    headlightParent: st.rider.group,
  });
  st.env.set(st.envSetting, { immediate: true });
  st.ready = true;
  // 品質段階(影・環境マップの有無に合わせた金属度など)を、後から加えたマテリアルにも当て直す
  applyQuality(st, st.qualityIndex ?? 0);
  if (st.ultraOn) st.realTerrain.load();
  updateAttribution(st);
}

function buildCastle(c, heightAt) {
  const g = buildCastleGeometries();
  const group = new THREE.Group();
  const add = (geo, color, rough, metal = 0) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }));
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  add(g.stone, 0x9a958a, 1);
  add(g.walls, 0xf3f1ea, 0.7);
  add(g.roofs, 0x3b4850, 0.6, 0.2);
  const ground = Math.min(c.base, heightAt(c.x, c.y));
  group.position.set(c.x, ground - 2, -c.y);
  group.rotation.y = c.yaw;
  group.scale.setScalar(CASTLE_SCALE);
  return group;
}

function buildPromenadePools(world, prom) {
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.4 });
  const lamp = buildPromenadeLampGeometry();
  const pools = {
    palmTrunks: makePool(new THREE.CylinderGeometry(0.26, 0.42, 1, 10).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x7c6a52, roughness: 1 }), prom.palms.length + 1),
    palmCrowns: makePool(buildPalmCrownGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide }), prom.palms.length + 1),
    lampPoles: makePool(lamp.pole, new THREE.MeshStandardMaterial({ color: 0x40474d, roughness: 0.5, metalness: 0.5 }), prom.lamps.length + 1),
    lampGlobes: makePool(lamp.globes, new THREE.MeshStandardMaterial({ color: 0xfaf8f0, emissive: 0x555247, roughness: 0.3 }), prom.lamps.length + 1, { cast: false }),
    parasolCanopies: makePool(new THREE.ConeGeometry(1.25, 0.55, 12, 1, true), new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }), MAX_PARASOLS),
    parasolPoles: makePool(new THREE.CylinderGeometry(0.025, 0.025, 2.3, 6).translate(0, 1.15, 0), white, MAX_PARASOLS),
  };
  for (const p of Object.values(pools)) world.add(p.mesh);
  return pools;
}

const PARASOL_COLORS = [0xe8412f, 0xf6f4ee, 0x2f6fd0, 0xf3c318, 0x2aa37a, 0xef7fa0];

function placePromenade(st, p, prom) {
  const { route, heightAt } = st;
  const c = {};
  for (const pm of prom.palms) {
    route.center(pm.t, c);
    const x = c.x + c.ty * pm.e;
    const y = c.y - c.tx * pm.e;
    const height = 7.5 * pm.scale;
    pushInstance(p.palmTrunks, x, c.z - 0.1, -y, pm.scale, height, pm.scale, 0, 0);
    pushInstance(p.palmCrowns, x, c.z - 0.1 + height, -y, pm.scale, pm.scale, pm.scale, 0, pm.yaw, 0x557f33);
  }
  for (const lp of prom.lamps) {
    route.center(lp.t, c);
    const x = c.x + c.ty * lp.e;
    const y = c.y - c.tx * lp.e;
    const yaw = yawFromDir(c.tx, c.ty);
    pushInstance(p.lampPoles, x, c.z + 0.15, -y, 1, 1, 1, 0, yaw + Math.PI / 2);
    pushInstance(p.lampGlobes, x, c.z + 0.15, -y, 1, 1, 1, 0, yaw + Math.PI / 2);
  }
  // 砂浜のパラソル(乾いた砂の上だけ)
  const rand = mulberry32(3907);
  let count = 0;
  for (let t = SUN_BEACH_T[0] + 20; t < SUN_BEACH_T[1] - 20 && count < MAX_PARASOLS; t += 4) {
    if (rand() > 0.55) continue;
    const side = st.sides[Math.round(t / st.data.route.stepM)] || 1;
    route.center(t, c);
    const u = c.hw + PROMENADE_M + 8 + rand() * 45;
    const x = c.x + c.ty * side * u;
    const y = c.y - c.tx * side * u;
    const g = heightAt(x, y);
    if (g < 1.2 || g > 3.8) continue;
    const tilt = (rand() - 0.5) * 0.25;
    pushInstance(p.parasolPoles, x, g - 0.3, -y, 1, 1, 1, tilt, 0);
    pushInstance(p.parasolCanopies, x, g + 2.05, -y - Math.sin(tilt) * 2, 1, 1, 1, tilt, 0, PARASOL_COLORS[Math.floor(rand() * PARASOL_COLORS.length)]);
    count++;
  }
  for (const pool of Object.values(p)) commitPool(pool);
}

// ---- 道路上の位置 ----

/** 1周の中の位置 s での車道の半幅(m)。 */
function halfWidthAt(st, s) {
  return st.route.place(s, 0, _p).hw;
}

const _p = {};

/** 他のライダー・自分の横位置: RIDER_X_M 基準の横距離を、実際の道幅の左車線へずらす。 */
function riderLateral(st, s, lateralM) {
  return lateralM + (-(halfWidthAt(st, s) - LANE_FROM_EDGE_M) - RIDER_X_M);
}

/** ハプニング・名所の横距離(半幅 3.5m の道路基準)を、実際の道幅に合わせて外へずらす。 */
function actorLateral(st, s, lateralM) {
  const extra = halfWidthAt(st, s) - NOMINAL_HALF_WIDTH_M;
  return Math.abs(lateralM) > 0.5 ? lateralM + Math.sign(lateralM) * extra : lateralM;
}

/** 道路上の地点(1周の中の位置 s、横距離 d)を other/actor の place の形(シーン座標と向き)で返す。 */
function placeOnRoad(st, s, d, out) {
  const q = st.route.place(s, d, _p);
  out.x = q.x;
  out.y = q.z;
  out.z = -q.y;
  out.yaw = yawFromDir(q.fx, q.fy);
  out.pitch = pitchAt(st, s);
  out.roll = 0;
  return out;
}

function pitchAt(st, s) {
  const a = st.route.place(s - 1.5, 0, _pa).z;
  const b = st.route.place(s + 1.5, 0, _pb).z;
  return Math.atan((b - a) / 3);
}
const _pa = {};
const _pb = {};

/** 道路上の地点 (s, d) の地面の、路面からの高さ(歩道 0.15m、それより外は地形。海より下は海面)。 */
function groundAboveRoadM(st, s, d) {
  const q = st.route.place(s, d, _p);
  const roadZ = q.z;
  if (Math.abs(d) <= q.hw) return 0;
  if (Math.abs(d) <= q.hw + SIDEWALK_M) return 0.15;
  return Math.max(0, st.heightAt(q.x, q.y)) - roadZ;
}

/** 道路上の地点(1周の中の位置 s・横距離 d・路面からの高さ)のシーン座標。 */
function worldPoint(st, s, d, heightM) {
  const q = st.route.place(s, d, _p);
  return [q.x, q.z + heightM, -q.y];
}

// ---- 毎フレーム ----

function drawFrame(st, distanceKm, speedKmh, cadenceRpm, others, myLaneM, actors) {
  const t = (performance.now() - st.startedAt) / 1000;
  st.waterNormal.offset.set((t * 0.004) % 1, (t * 0.01) % 1);
  if (!st.ready) {
    st.renderer.render(st.scene, st.camera);
    return;
  }
  const dist = distanceKm * 1000;
  const riderX = riderLateral(st, dist, RIDER_X_M + myLaneM);
  const pos = worldPoint(st, dist, riderX, 0);
  st.rider.group.position.set(pos[0], pos[1], pos[2]);
  st.rider.group.rotation.y = yawFromDir(_p.fx, _p.fy);
  const k = curvatureAtM(st.profile.curve, st.loopM, ((dist % st.loopM) + st.loopM) % st.loopM);
  const roll = riderRollRad(k, speedKmh / 3.6);
  updateRiderAvatar(st.rider, st.clock, speedKmh, pitchAt(st, dist), roll);

  // 影はライダーの周りだけ描けばよいので、影カメラごとライダーに付いていく
  st.sunLight.target.position.set(pos[0], pos[1], pos[2]);
  st.sunLight.position.set(pos[0], pos[1], pos[2]).addScaledVector(st.env.sunDir, 220);

  st.others.update(others, dist, {
    dt: st.rider.dt ?? 0,
    qualityIndex: st.qualityIndex ?? 0,
    riderX: RIDER_X_M,
    behindM: OTHERS_BEHIND_M,
    place(gapM, lateralM, speedMps, out) {
      const s = dist + gapM;
      placeOnRoad(st, s, riderLateral(st, s, lateralM), out);
      out.roll = riderRollRad(curvatureAtM(st.profile.curve, st.loopM, ((s % st.loopM) + st.loopM) % st.loopM), speedMps);
      return out;
    },
  });
  const { pack, ghosts, labels } = st.others.stats;
  const tag = `${pack}/${ghosts}/${labels}`;
  if (st.canvas.dataset.others !== tag) st.canvas.dataset.others = tag;

  st.actorDist = dist;
  st.actors.update(actors, dist, {
    place: st.actorPlace,
    groundAboveRoadM: st.actorGround,
    roadHalfWidthM: NOMINAL_HALF_WIDTH_M,
    dt: st.rider.dt ?? 0,
    qualityIndex: st.qualityIndex ?? 0,
    behindM: OTHERS_BEHIND_M,
  });
  const atag = String(st.actors.stats.count);
  if (st.canvas.dataset.actors !== atag) st.canvas.dataset.actors = atag;

  updateCamera(st, dist, { speedKmh, cadenceRpm, roll, riderX });
  st.env.update();
  st.realTerrain.update({
    enabled: st.ultraOn, skyHeading: 0, baseY: 0,
    sunDir: st.env.sunDir, hemiLight: st.hemiLight, sunLight: st.sunLight, fog: st.scene.fog,
  });
  // 実在の地形(写真付き)が出ている間は、遠景の格子は隠す(重なってちらつかないように)
  st.outerTerrain.visible = !st.realTerrain.object.visible;
  st.ocean.render(st.renderer, st.scene, st.camera, t);
  st.renderer.render(st.scene, st.camera);
}

// Uターンの前後では、道路に沿った注視点が後ろ(折り返した先)になってしまうので、ライダーの向きの
// 正面を見るカメラに切り替える(TURN_CAMERA_NEAR_M 以内は完全に、TURN_CAMERA_FAR_M までで元に戻す)
const TURN_CAMERA_NEAR_M = 14;
const TURN_CAMERA_FAR_M = 45;

function turnCameraWeight(st, dist) {
  const d = st.route.turnDistanceM(dist);
  const k = Math.min(1, Math.max(0, (TURN_CAMERA_FAR_M - d) / (TURN_CAMERA_FAR_M - TURN_CAMERA_NEAR_M)));
  return k * k * (3 - 2 * k);
}

/** ライダーの位置から、ライダーの向きに沿って前へ ahead・右へ side・高さ up の点(シーン座標)。 */
function headingPoint(st, dist, riderX, ahead, side, up) {
  const q = st.route.place(dist, riderX, _p);
  const x = q.x + q.fx * ahead + q.fy * side;
  const y = q.y + q.fy * ahead - q.fx * side;
  return [x, q.z + up, -y];
}

function mix(a, b, w) {
  return w <= 0 ? a : [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
}

function updateCamera(st, dist, { speedKmh, cadenceRpm, roll, riderX }) {
  const { view } = st.cam;
  setAvatarVisible(st.rider, view !== 'fp');
  const w = turnCameraWeight(st, dist);
  if (view === 'fp') {
    const bob = fpBobM(st.cam, cadenceRpm ?? estimateCadenceRpm(speedKmh), st.rider.dt ?? 0);
    const eyeUp = st.rider.camera.eyeM + bob;
    const eye = mix(worldPoint(st, dist + FP_FORWARD_M, riderX, eyeUp), headingPoint(st, dist, riderX, FP_FORWARD_M, 0, eyeUp), w);
    st.camera.position.set(eye[0], eye[1], eye[2]);
    const look = mix(worldPoint(st, dist + FP_LOOKAHEAD_M, riderX, FP_LOOK_HEIGHT_M), headingPoint(st, dist, riderX, FP_LOOKAHEAD_M, 0, FP_LOOK_HEIGHT_M), w);
    st.camera.lookAt(look[0], look[1], look[2]);
    st.camera.rotateZ(fpCameraRollRad(roll));
    setCameraFov(st.camera, fpFovDeg(speedKmh / 3.6));
    return;
  }
  if (view === 'cine') {
    updateCineCamera(st, dist, riderX);
    return;
  }
  setCameraFov(st.camera, CHASE_FOV_DEG);
  const { sideM, raiseM, backM } = st.rider.camera;
  const back = CAM_BACK_M + backM;
  const up = CAM_HEIGHT_M + raiseM;
  const cam = mix(worldPoint(st, dist - back, riderX + 0.4 + sideM, up), headingPoint(st, dist, riderX, -back, 0.4 + sideM, up), w);
  // 坂の途中でカメラが地面に埋まらないよう、地形より上に置く
  const groundY = st.heightAt(cam[0], -cam[2]);
  cam[1] = Math.max(cam[1], groundY + 1.5);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const look = mix(
    worldPoint(st, dist + CAM_LOOKAHEAD_M, riderX - 0.8, CAM_LOOKAHEAD_HEIGHT_M),
    headingPoint(st, dist, riderX, CAM_LOOKAHEAD_M, -0.8, CAM_LOOKAHEAD_HEIGHT_M),
    w
  );
  st.camera.lookAt(look[0], look[1], look[2]);
}

/** cine 視点: 沿道の固定カメラ(海側の歩道の上)とヘリ視点から、ライダーを追って映す。 */
function updateCineCamera(st, dist, riderX) {
  const shot = st.cam.director.update(performance.now() / 1000, dist);
  let s;
  let d;
  let up;
  if (shot.type === 'heli') {
    s = dist - CINE_HELI_BACK_M;
    d = riderX + shot.side * CINE_HELI_LATERAL_M;
    up = Math.max(shot.heightM, groundAboveRoadM(st, s, d) + CINE_HELI_CLEARANCE_M);
  } else {
    s = shot.s;
    d = -(halfWidthAt(st, s) + CINE_ROADSIDE_MIN_M + shot.lateralU * CINE_ROADSIDE_SPREAD_M);
    up = Math.max(0, groundAboveRoadM(st, s, d)) + shot.heightM;
  }
  const cam = worldPoint(st, s, d, up);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const look = worldPoint(st, dist, riderX, CINE_LOOK_HEIGHT_M);
  st.camera.lookAt(look[0], look[1], look[2]);
  setCameraFov(st.camera, shot.fovDeg);
  st.canvas.dataset.cineShot = `${shot.index}:${shot.type}`;
}

// ---- 最高(実験)と出典 ----

function setUltra(st, on) {
  st.ultraOn = on;
  st.ocean?.setEnabled(on);
  if (on && st.ready) st.realTerrain.load();
  updateAttribution(st);
}

/** 出典(PLATEAU・国土地理院)は常に出す。最高(実験)の実在の地形の読み込み状態も添える。 */
function updateAttribution(st) {
  const el = st.attributionEl;
  const status = st.realTerrain?.status ?? 'idle';
  if (st.canvas) st.canvas.dataset.realTerrain = st.ultraOn ? status : 'off';
  if (!el) return;
  const base = st.data?.attribution ?? '3D都市モデル: 国土交通省 PLATEAU/地形・道路: 国土地理院';
  let extra = '';
  if (st.ultraOn && status === 'ready') extra = `/遠景の${GSI_ATTRIBUTION}`;
  else if (st.ultraOn && status === 'loading') extra = '(遠景の実在の地形を読み込み中…)';
  else if (st.ultraOn && status === 'error') extra = '(遠景の実在の地形を読み込めませんでした)';
  el.textContent = base + extra;
}
