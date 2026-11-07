import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import { FLOOR_HEIGHT_M } from '../three/cityLayout.js';
import { createCityTextures, createTownFacadeTextures, createFacadeMaterial, FACADE_TILE } from '../three/cityMaterials.js';
import { createCountryRoadTexture, createTerrainDetailTexture, createWaterNormalTexture } from '../three/landscapeMaterials.js';
import { createAtamiRoute, createTerrainSampler } from '../three/atamiRealLayout.js';
import { REAL_TOWNS, loadTownData, townGroundColor, analyzeGrid, planTrees, waterLevelAt, waterCells, townBuildingLook } from '../three/realTownLayout.js';
import { buildTerrainMesh, buildRouteMeshes, buildStreetGeometry, buildBuildingGeometries } from '../three/atamiParts.js';
import {
  bakeSky, createAvatar, makePool, pushInstance, commitPool, mergeGeometries,
  applyQuality, setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene,
  reportReadyAfterDraw,
} from '../three/sceneKit.js';
import { createCineDirector, normalizeCameraView } from '../three/cameraViews.js';
import { createEnvironmentController } from '../three/sceneEnvironment.js';
import { seasonalTree, seasonalGround } from '../three/seasonLook.js';
import { createOtherRiders } from '../three/otherRiders.js';
import { createRoadsideActors } from '../three/roadsideActors.js';
import { createOcean } from '../three/oceanWater.js';
import { createRealTerrain } from '../three/realTerrain.js';
import { REAL_TERRAIN, GSI_ATTRIBUTION } from '../three/gsiTerrain.js';
import { placeOnRoad, actorLateral, groundAboveRoadM, updateRide } from './realSceneShared.js';
import { SIGHT_FOOTPRINTS } from '../three/roadsideLayout.js';

const { forwardRef, useImperativeHandle } = React;

// 晴れた日。太陽は南東の空(高さ・空の色・霞は走る日の季節で sceneEnvironment が変える)
const ATMO = {
  zenith: '#2f74d0', horizon: '#dbe7f0', ground: '#a7b0a0', sunColor: '#fff2dc',
  sunDir: new THREE.Vector3(0.5, 0.6, 0.62).normalize(),
  hemiSky: 0xd4e4f5, hemiGround: 0x7d7a68,
};
const SUN_INTENSITY = 2.6;
const HEMI_INTENSITY = 0.62;
const EXPOSURE = 1.05;

const WATER_TILE_M = 18;
const CAMERA_FAR_M = 40000;
const ROAD_TILE_M = 12;
const PAVE_TILE_M = 2;
const SIDEWALK_M = 2;
const MAX_TREES = 16000;
// 木の色(palette ごと)。季節があるときは park(夏の緑)を走る日の季節の色にする
const TREE_COLORS = {
  autumn: { broad: [0xc8452a, 0xe0802a, 0xd9b23a, 0x8f3a22, 0x5d7a32, 0x6b8a3a], conifer: [0x2f4a2a, 0x37552f, 0x2a4226] },
  park: { broad: [0x4f7a2e, 0x5d8a35, 0x6b9440, 0x47702a, 0xa8822e], conifer: [0x2f4a2a, 0x37552f, 0x2a4226] },
};

/**
 * 実在の街の観光地コース(京都・東山/奈良公園/富士山・河口湖)の3Dビュー。熱海(AtamiScene)と同じく、
 * 世界を実在の座標(原点 = スタート地点、東 +X・北 −Z)に1度だけ組み立てて固定し、毎フレームはライダー・
 * カメラ・影の範囲・他のライダー・ハプニングと名所(actors)だけを動かす。データ(tools/real-towns/build.py が
 * 作る js/data/<id>-town.json)は非同期に読むので、読み終わるまでは空だけを描く(canvas の data-town-data)。
 * 名所(大鳥居・五重塔・大仏殿など)はコースの landmarks として、ハプニングと同じ actors で届く。
 */
export const RealTownScene = forwardRef(function RealTownScene({ courseEngine, town, vehicle = 'bike', qualityMode = 'auto', onQualityChange, onReady, environment, cameraView = 'chase', season = null }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const attributionRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
  const [dataError, setDataError] = useState(false);
  const onQualityChangeRef = useRef(onQualityChange);
  onQualityChangeRef.current = onQualityChange;
  // 景色の準備ができたら1回だけ知らせる(RideScreen はそれまで走行を始めない)
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // 3D 表示が使えない(WebGL の初期化・描画の失敗)ときは景色なしで走れるよう、準備完了として知らせる
  useEffect(() => {
    if (renderError) onReadyRef.current?.();
  }, [renderError]);
  const label = REAL_TOWNS[town]?.label ?? '街';

  useImperativeHandle(ref, () => ({
    draw({ distanceKm, speedKmh, cadenceRpm, others, myLaneOffsetM, actors }) {
      const s = sceneRef.current;
      if (!s) return;
      try {
        adaptQuality(s);
        drawFrame(s, distanceKm, speedKmh ?? 0, cadenceRpm, others, Number.isFinite(myLaneOffsetM) ? myLaneOffsetM : 0, actors);
        reportReadyAfterDraw(s);
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
      st = initScene(canvas, courseEngine, town, vehicle);
      st.season = season;
      sceneRef.current = st;
    } catch (err) {
      setRenderError(String(err));
      return;
    }
    st.attributionEl = attributionRef.current;
    st.onQualityChange = (tierName) => onQualityChangeRef.current?.(tierName);
    st.onReady = () => onReadyRef.current?.();
    st.appliedQualityMode = qualityMode;
    st.envSetting = environment;
    st.cam.view = normalizeCameraView(cameraView);
    canvas.dataset.townData = 'loading';
    loadTownData(town).then(
      (data) => {
        if (st.disposed) return;
        try {
          buildWorld(st, data);
          canvas.dataset.townData = 'ready';
          canvas.dataset.buildings = String(st.buildingCount);
          canvas.dataset.trees = String(st.treeCount);
        } catch (err) {
          setRenderError(String(err));
        }
      },
      (err) => {
        if (st.disposed) return;
        console.warn('実在の街のデータを読み込めませんでした:', err);
        canvas.dataset.townData = 'error';
        setDataError(true);
        // 街のデータが無くても走行と記録は続けられるので、走行を始める
        onReadyRef.current?.();
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
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas', 'data-scenery': town, 'data-real-town': town, 'data-vehicle': vehicle }),
    h('div', { ref: attributionRef, className: 'scene-attribution' }),
    dataError && h('div', { className: 'city-scene-fallback' }, `${label}のデータを読み込めませんでした(通信を確認してください)。走行と記録は続けられます。`),
    renderError &&
      h(
        'div', { className: 'city-scene-fallback' },
        '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。'
      )
  );
});

// ---- 初期化(データを待たずに作れるもの) ----

function initScene(canvas, courseEngine, town, vehicle) {
  const cfg = REAL_TOWNS[town];
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const atmo = { ...ATMO, fog: cfg.fog };
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(atmo.horizon), atmo.fog);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, CAMERA_FAR_M);
  camera.position.set(0, 10, 20);
  camera.lookAt(0, 5, 0);

  const sky = bakeSky(renderer, atmo);
  scene.background = sky.background;
  scene.environmentIntensity = 0.8;

  const hemiLight = new THREE.HemisphereLight(atmo.hemiSky, atmo.hemiGround, HEMI_INTENSITY);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(atmo.sunColor), SUN_INTENSITY);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 10, far: 520 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.05;
  scene.add(hemiLight, sunLight, sunLight.target);

  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const textures = [];
  const waterNormal = createWaterNormalTexture();
  textures.push(waterNormal);

  const rider = createAvatar(vehicle);
  scene.add(rider.group);
  const world = new THREE.Group();
  world.name = 'town-world';
  scene.add(world);

  const st = {
    canvas, renderer, scene, camera, sky, hemiLight, sunLight, textures, anisotropy,
    town, townCfg: cfg,
    baseAtmo: {
      zenith: atmo.zenith, horizon: atmo.horizon, ground: atmo.ground, sunColor: atmo.sunColor, sunDir: atmo.sunDir.toArray(),
      sunIntensity: SUN_INTENSITY, hemiSky: atmo.hemiSky, hemiGround: atmo.hemiGround, hemiIntensity: HEMI_INTENSITY,
      fogDensity: atmo.fog, exposure: EXPOSURE,
    },
    waterNormal, waters: [], ocean: null, realTerrain: null, ultraOn: false,
    onUltraChange: (on) => setUltra(st, on),
    world, rider, ready: false,
    profile: courseEngine.profile, courseEngine,
    loopM: courseEngine.profile.loopLengthKm * 1000,
    sidewalkM: SIDEWALK_M,
    groundFloor: null,
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
  const { world, anisotropy, textures, townCfg } = st;
  const route = createAtamiRoute(data.route);
  const heightAt = createTerrainSampler(data);
  st.data = data;
  st.route = route;
  st.heightAt = heightAt;
  // 水の中(池・湖の底)の地面は水面の高さ(浮見堂の柱・ハプニングが水底に沈まないように)
  st.groundFloor = data.waters.length ? (x, y, g) => Math.max(g, waterLevelAt(data, x, y) ?? -Infinity) : null;

  // 名所の位置(地図座標)。PLATEAU・地理院の建物はデータを作るときに除いてある。木もここには置かない
  const clear = sightClearZones(st);

  // 地形(近景・遠景)
  const info = analyzeGrid(data, route, heightAt, townCfg.forest);
  const palette = townCfg.palette;
  const t = data.terrain;
  const depthAt = (x, y, hh) => {
    const lv = waterLevelAt(data, x, y);
    return lv === null ? -99 : lv - hh;
  };
  const detail = createTerrainDetailTexture(anisotropy);
  textures.push(detail);
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96 });
  const innerBox = { x0: t.x0, y0: t.y0, x1: t.x0 + (t.nx - 1) * t.step, y1: t.y0 + (t.ny - 1) * t.step };
  const inner = buildTerrainMesh(data.terrain, groundMat, {
    buildings: data.buildings,
    colorAt: (k, hh, normalY, built, noise) => {
      const i = k % t.nx;
      const j = Math.floor(k / t.nx);
      const x = t.x0 + i * t.step;
      const y = t.y0 + j * t.step;
      return townGroundColor(palette, normalY, built, depthAt(x, y, hh), info.forest[k], noise, st.season, hh);
    },
  });
  const o = data.outer;
  const outer = buildTerrainMesh(data.outer, groundMat, {
    skipBox: innerBox,
    colorAt: (k, hh, normalY, built, noise) => {
      const x = o.x0 + (k % o.nx) * o.step;
      const y = o.y0 + Math.floor(k / o.nx) * o.step;
      const forest = Math.min(1, Math.max(0, (0.995 - normalY) / 0.02));
      // 富士山の上の方は森林限界より上の砂礫。雪は走る日の雪線より上(夏は無く、冬は裾野近くまで)。
      // 季節が無ければ頂上付近だけ初冠雪
      if (!st.season && hh > 3300) return [0.93, 0.94, 0.96];
      if (hh > 2500) return seasonalGround(st.season, [0.42 + (noise - 0.5) * 0.05, 0.33, 0.3], hh, 0, 0);
      return townGroundColor(palette, normalY, 0, depthAt(x, y, hh), forest, noise, st.season, hh);
    },
  });
  outer.traverse((m) => {
    m.receiveShadow = false;
  });
  world.add(inner, outer);
  st.outerTerrain = outer;
  st.innerBox = innerBox;

  // 湖・池の水面(水面の格子のセルだけをつないだメッシュ。岸の斜面と交わって水際になる)
  data.waters.forEach((w, k) => {
    const cells = waterCells(data, k);
    if (cells.length === 0) return;
    const pos = new Float32Array(cells.length * 12);
    const idx = [];
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    cells.forEach(([ax, ay, bx, by], c) => {
      pos.set([ax, 0, -ay, bx, 0, -ay, bx, 0, -by, ax, 0, -by], c * 12);
      const v = c * 4;
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      minX = Math.min(minX, ax); maxX = Math.max(maxX, bx);
      minY = Math.min(minY, ay); maxY = Math.max(maxY, by);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const uv = new Float32Array(cells.length * 8);
    for (let v = 0; v < cells.length * 4; v++) {
      uv[v * 2] = pos[v * 3] / WATER_TILE_M;
      uv[v * 2 + 1] = -pos[v * 3 + 2] / WATER_TILE_M;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const nrmAttr = new Float32Array(cells.length * 12);
    for (let v = 0; v < cells.length * 4; v++) nrmAttr[v * 3 + 1] = 1;
    geo.setAttribute('normal', new THREE.BufferAttribute(nrmAttr, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x2f6a80, roughness: 0.07, metalness: 0, normalMap: st.waterNormal, normalScale: new THREE.Vector2(0.3, 0.3) })
    );
    mesh.position.y = w.level;
    mesh.receiveShadow = true;
    world.add(mesh);
    st.waters.push({ mesh, area: (maxX - minX) * (maxY - minY) });
  });
  // 映り込む水面(最高(実験))は一番大きな湖・池だけ
  const biggest = st.waters.reduce((a, b) => (!a || b.area > a.area ? b : a), null);
  if (biggest) st.ocean = createOcean(biggest.mesh);

  // 走るルート(池の上のルートは車道を描かない)
  const city = createCityTextures(anisotropy);
  textures.push(...city.all);
  const wetMaterials = [];
  if (!data.route.onWater) {
    const roadTex = createCountryRoadTexture(Math.max(2, avgHalfWidth(data.route)), 'white-dashed', anisotropy);
    textures.push(roadTex);
    const routeGeo = buildRouteMeshes(route, { roadTileM: ROAD_TILE_M, paveTileM: PAVE_TILE_M, sidewalkAt: () => SIDEWALK_M });
    const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const walkMat = new THREE.MeshStandardMaterial({ map: city.sidewalk, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const road = new THREE.Mesh(routeGeo.road, roadMat);
    const walk = new THREE.Mesh(routeGeo.sidewalk, walkMat);
    road.receiveShadow = true;
    walk.receiveShadow = true;
    world.add(road, walk);
    wetMaterials.push(roadMat, walkMat);
  }

  // 道路網
  const streetMat = new THREE.MeshStandardMaterial({ color: 0x66686b, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const streets = new THREE.Mesh(buildStreetGeometry(data.streets, (x, y) => Math.max(heightAt(x, y), waterLevelAt(data, x, y) ?? -1e9)), streetMat);
  streets.receiveShadow = true;
  world.add(streets);
  wetMaterials.push(streetMat);

  // 建物(低い家は切妻屋根。京都は京町家の格子の外壁も)
  const townFac = createTownFacadeTextures(anisotropy);
  textures.push(...townFac.all);
  const facades = { ...city.facades, ...townFac.facades };
  const blds = buildBuildingGeometries(data.buildings, heightAt, {
    look: (b, i) => townBuildingLook(st.town, b, i),
    gable: (b, look) => look.gable,
  });
  st.buildingCount = blds.count;
  for (const [style, geos] of blds.walls) {
    const bayM = style === 'glass' ? 1.8 : FLOOR_HEIGHT_M;
    const mat = createFacadeMaterial({
      ...facades[style], bayM, floorM: FLOOR_HEIGHT_M, tileBays: FACADE_TILE.cellBays, tileFloors: FACADE_TILE.cellFloors, sinkM: 0,
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
  const pitchedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide });
  for (const [g, mat] of [...blds.roofs.map((g) => [g, roofMat]), ...blds.pitched.map((g) => [g, pitchedMat])]) {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    world.add(m);
  }

  // 木(森・公園の木・紅葉)
  const trees = planTrees(data, route, heightAt, info, townCfg.forest, { clear, maxTrees: MAX_TREES, seed: hashString(st.town) });
  st.treeCount = trees.length;
  // 季節があれば夏の緑(park)から走る日の季節の色にする(placeTrees)
  placeTrees(st, trees, st.season ? TREE_COLORS.park : TREE_COLORS[palette] ?? TREE_COLORS.autumn);

  // 描画品質「最高(実験)」: 映り込む水面と、国土地理院のタイルの実在の地形の遠景(近景の範囲の外だけ)
  const base = REAL_TERRAIN[st.town] ?? {};
  const lake = data.waters.length ? biggest.mesh.position.y : null;
  const cfg = {
    ...base,
    origin: data.origin,
    bearingDeg: 0,
    anchor: lake !== null && base.anchor === 'water' ? 'water' : 'sea',
    waterLevelM: lake ?? undefined,
    innerRadiusM: 0,
    minDistM: 0,
    openSideX: undefined,
    innerBox: { minX: innerBox.x0, maxX: innerBox.x1, minZ: -innerBox.y1, maxZ: -innerBox.y0 },
  };
  st.realBaseY = cfg.anchor === 'water' ? lake : 0;
  st.realTerrain = createRealTerrain(cfg, { anisotropy, season: st.season, onStatus: () => updateAttribution(st) });
  st.scene.add(st.realTerrain.object);

  // 走行環境(時間帯・天候)。窓の夜度を拾うため建物を置いた後に作る
  st.env = createEnvironmentController(st, {
    base: st.baseAtmo, hemiLight: st.hemiLight, sunLight: st.sunLight,
    wetMaterials,
    headlightParent: st.rider.group,
    season: st.season,
  });
  st.env.set(st.envSetting, { immediate: true });
  st.ready = true;
  applyQuality(st, st.qualityIndex ?? 0);
  if (st.ultraOn) {
    st.realTerrain.load();
    st.ocean?.setEnabled(true);
  }
  updateAttribution(st);
}

function avgHalfWidth(route) {
  let s = 0;
  for (let i = 0; i < route.n; i++) s += route.halfWidth[i];
  return s / route.n;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 名所のまわりの、木を置かない円(地図座標)。1周目の landmarks の位置から。 */
function sightClearZones(st) {
  const out = [];
  const marks = Array.isArray(st.profile.landmarks) ? st.profile.landmarks : [];
  const q = {};
  for (const m of marks) {
    const fp = SIGHT_FOOTPRINTS[m.kind];
    const s = m.km * 1000;
    const hw = st.route.place(s, 0, q).hw;
    const side = Math.sign(m.side || 0);
    const lat = side === 0 ? 0 : side * (hw + Math.max(m.lateralM ?? 0, fp ? fp.halfLatM + 1.5 : 0));
    st.route.place(s, lat, q);
    out.push({ x: q.x, y: q.y, r: fp ? Math.max(fp.halfAlongM, fp.halfLatM) + 6 : 8 });
  }
  return out;
}

function placeTrees(st, trees, colors) {
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 6).translate(0, 0.5, 0);
  const broadGeo = mergeGeometries([
    new THREE.IcosahedronGeometry(1, 1).scale(1.6, 1.25, 1.6).translate(0, 4.4, 0),
    new THREE.IcosahedronGeometry(1, 1).scale(1.15, 1, 1.15).translate(0.5, 5.6, 0.3),
  ]);
  const coniferGeo = mergeGeometries([
    [2.0, 4.0, 1.4], [1.55, 3.4, 3.6], [1.05, 3.0, 5.6], [0.6, 2.4, 7.6],
  ].map(([r, hh, y]) => new THREE.ConeGeometry(r, hh, 8, 1).translate(0, y + hh / 2, 0)));
  const nBroad = trees.filter((t) => !t.conifer).length;
  const pools = {
    trunks: makePool(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 }), trees.length + 1, { cast: false }),
    broad: makePool(broadGeo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), nBroad + 1, { cast: false }),
    conifer: makePool(coniferGeo, new THREE.MeshStandardMaterial({ roughness: 0.95 }), trees.length - nBroad + 1, { cast: false }),
  };
  // 落葉樹のうち桜の割合(町なか・公園の桜。春に満開になる)
  const sakura = st.townCfg.sakura ?? 0.12;
  for (const t of trees) {
    const s = t.scale;
    const yaw = t.tone * Math.PI * 2;
    const r1 = (t.tone * 7919) % 1;
    if (t.conifer) {
      pushInstance(pools.trunks, t.x, t.z - 0.3, -t.y, s * 1.2, 2 * s, s * 1.2);
      const base = colors.conifer[Math.floor(t.tone * colors.conifer.length) % colors.conifer.length];
      pushInstance(pools.conifer, t.x, t.z, -t.y, s, s, s, 0, yaw, seasonalTree(st.season, base, t.z, r1, { conifer: true }).color);
    } else {
      pushInstance(pools.trunks, t.x, t.z - 0.3, -t.y, s, 4 * s, s);
      const look = seasonalTree(st.season, colors.broad[Math.floor(t.tone * 997) % colors.broad.length], t.z, r1, { sakura });
      const k = s * look.scale;
      pushInstance(pools.broad, t.x, t.z, -t.y, k, s, k, 0, yaw, look.color);
    }
  }
  for (const p of Object.values(pools)) {
    commitPool(p);
    st.world.add(p.mesh);
  }
}

// ---- 毎フレーム ----

function drawFrame(st, distanceKm, speedKmh, cadenceRpm, others, myLaneM, actors) {
  const t = (performance.now() - st.startedAt) / 1000;
  st.waterNormal.offset.set((t * 0.004) % 1, (t * 0.01) % 1);
  if (!st.ready) {
    st.renderer.render(st.scene, st.camera);
    return;
  }
  updateRide(st, distanceKm * 1000, speedKmh, cadenceRpm, others, myLaneM, actors);
  st.env.update();
  st.realTerrain.update({
    enabled: st.ultraOn, skyHeading: 0, baseY: st.realBaseY,
    sunDir: st.env.sunDir, hemiLight: st.hemiLight, sunLight: st.sunLight, fog: st.scene.fog,
  });
  st.outerTerrain.visible = !st.realTerrain.object.visible;
  if (st.ocean) st.ocean.render(st.renderer, st.scene, st.camera, t);
  st.renderer.render(st.scene, st.camera);
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
  const base = st.data?.attribution ?? '地形・道路: 国土地理院';
  let extra = '';
  if (st.ultraOn && status === 'ready') extra = `/遠景の${GSI_ATTRIBUTION}`;
  else if (st.ultraOn && status === 'loading') extra = '(遠景の実在の地形を読み込み中…)';
  else if (st.ultraOn && status === 'error') extra = '(遠景の実在の地形を読み込めませんでした)';
  el.textContent = base + extra;
}
