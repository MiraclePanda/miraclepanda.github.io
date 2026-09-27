import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import { mulberry32 } from '../three/cityLayout.js';
import {
  getLandscape, roadEdgeM, roadCenterX, roadSlopeX, lateralX,
  createElevationSampler, createFloorModel, terrainHeightM, terrainColor, collectLandscapeObjects,
} from '../three/landscapeLayout.js';
import { createLandscapeTextures } from '../three/landscapeMaterials.js';
import {
  RIDER_X_M, bakeSky, mergeGeometries, buildCanopyGeometry, buildRiderAvatar, updateRiderAvatar,
  makePool, pushInstance, pushInstanceYawPitch, commitPool, setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene,
} from '../three/sceneKit.js';

const { forwardRef, useImperativeHandle } = React;

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
};

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
const WATER_SIZE_M = 12000;
const GUARDRAIL_POST_SPACING_M = 4;
const WALL_SEGMENT_M = 4;

const CAM_BACK_M = 6.5;
const CAM_HEIGHT_M = 3.2;
const CAM_LOOKAHEAD_M = 26;
const CAM_LOOKAHEAD_HEIGHT_M = 1.2;
// 注視点をライダーより少し谷/湖側へ寄せ、見下ろす景色が画面に入るようにする。
const CAM_LOOK_LATERAL_M = RIDER_X_M - 0.8;

const MAX_TREES = 500;
const CANOPY_BLOBS_PER_TREE = 3;
const MAX_FAR_TREES = 1400;
const MAX_ROCKS = 200;
const MAX_GUARDRAIL = 160;
const MAX_DELINEATORS = 40;
const MAX_WALL_SEGMENTS = 140;
const MAX_HOUSES = 24;
const MAX_BOATS = 16;

/**
 * 丘陵(湖を見下ろす湖畔の丘陵地)・山岳(谷と雪を頂く山並み)コースの3Dビュー。
 * CitySceneと同じくref経由のdraw({distanceKm, speedKmh})で描画する。
 *
 * 地形・道路・配置物は絶対距離に固定した格子で生成し、REBUILD_Mごとに組み直す。
 * 組み直しの間は、ライダーを原点に保つよう世界全体のグループを平行移動し、
 * 道路のカーブの向きに合わせて回転させるだけで描画する。
 */
export const LandscapeScene = forwardRef(function LandscapeScene({ courseEngine, landscape, qualityMode = 'auto', onQualityChange }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
  // 品質段階の変化(自動調整による段階変更を含む)を親へ通知する。最新のコールバックを参照するためrefで持つ。
  const onQualityChangeRef = useRef(onQualityChange);
  onQualityChangeRef.current = onQualityChange;

  useImperativeHandle(ref, () => ({
    draw({ distanceKm, speedKmh }) {
      const s = sceneRef.current;
      if (!s) return;
      try {
        adaptQuality(s);
        drawFrame(s, distanceKm, speedKmh ?? 0);
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
      scene3d = initScene(canvas, courseEngine, getLandscape(landscape));
      sceneRef.current = scene3d;
    } catch (err) {
      setRenderError(String(err));
      return;
    }

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

  return h(
    'div', { className: 'city-scene-wrap' },
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas', 'data-scenery': getLandscape(landscape).id }),
    renderError &&
      h(
        'div', { className: 'city-scene-fallback' },
        '3D表示を利用できません(WebGL非対応の可能性があります)。走行データはダッシュボードでご確認ください。'
      )
  );
});

// ---- シーン初期化 ----

function initScene(canvas, courseEngine, L) {
  const atmo = ATMOSPHERE[L.id];
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(atmo.horizon), atmo.fog);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 7000);

  const sky = bakeSky(renderer, atmo);
  scene.background = sky.background;
  scene.environmentIntensity = 0.8;

  const hemiLight = new THREE.HemisphereLight(atmo.hemiSky, atmo.hemiGround, 0.6);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(atmo.sunColor), 2.6);
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

  const rider = buildRiderAvatar();
  scene.add(rider.group);

  const elev = createElevationSampler((km) => courseEngine.gradeAtKm(km));
  const floor = createFloorModel(elev, courseEngine.profile.loopLengthKm * 1000, L.valley.minDropM);

  return {
    L, atmo, canvas, renderer, scene, camera, sky, sunLight, textures: tex.all, waterNormal: tex.water,
    root, inner, terrain, road, shoulder, water,
    pools: {
      trunks, canopies, conifers, farCones, farBlobs, rocks, railPosts, railBeams,
      delineatorPosts, delineatorLens, walls, houseBodies, houseRoofs, boatHulls, boatSails,
    },
    rider, elev, floor,
    anchorS: null, anchorElev: 0,
    clock: new THREE.Clock(),
    startedAt: performance.now(),
  };
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

function rebuildWorld(st, anchorS) {
  const { L, elev } = st;
  st.anchorS = anchorS;
  st.anchorElev = elev.elevAt(anchorS);
  const floorM = st.floor.floorAt(anchorS);

  buildTerrain(st, anchorS, floorM);
  buildRoad(st, anchorS);
  placeObjects(st, anchorS, floorM);
}

function buildTerrain(st, anchorS, floorM) {
  const { L, elev, anchorElev } = st;
  const rows = terrainRows(anchorS);
  const cols = terrainColumns(L);
  const geometry = st.terrain.geometry;
  ensureGrid(geometry, rows.length, cols.length, true);
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const vBase = ((anchorS % TERRAIN_TILE_M) + TERRAIN_TILE_M) % TERRAIN_TILE_M;
  const heights = new Float32Array(rows.length * cols.length);
  for (let r = 0; r < rows.length; r++) {
    const s = rows[r];
    const roadE = elev.elevAt(s);
    const z = -(s - anchorS);
    const v = (vBase + (s - anchorS)) / TERRAIN_TILE_M;
    for (let c = 0; c < cols.length; c++) {
      const d = cols[c];
      const i = r * cols.length + c;
      const hgt = terrainHeightM(L, d, s, roadE, floorM);
      heights[i] = hgt;
      const x = lateralX(L, s, d);
      pos.setXYZ(i, x, hgt - anchorElev, z);
      uv.setXY(i, x / TERRAIN_TILE_M, v);
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
      const [cr, cg, cb] = terrainColor(L, cols[c], rows[r], heights[i], floorM, normals.getY(i));
      _col.setRGB(cr, cg, cb, THREE.SRGBColorSpace);
      color.setXYZ(i, _col.r, _col.g, _col.b);
    }
  }
  color.needsUpdate = true;
}

function buildRoad(st, anchorS) {
  const { L, elev, anchorElev } = st;
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
      const cx = roadCenterX(L, s);
      const v = (vBase + (s - anchorS)) / tileM;
      for (let c = 0; c < cols.length; c++) {
        const i = r * cols.length + c;
        pos.setXYZ(i, cx + cols[c].x, y, -(s - anchorS));
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
  const { L, elev, anchorElev, pools: p } = st;
  const from = anchorS - NEAR_BEHIND_M;
  const to = anchorS + NEAR_AHEAD_M + REBUILD_M;
  const objects = collectLandscapeObjects(L, from, to, { farToM: anchorS + FAR_TREE_AHEAD_M });
  const edge = roadEdgeM(L);

  const groundAt = (s, d) => terrainHeightM(L, d, s, elev.elevAt(s), floorM);
  const local = (s, d, hgt) => [lateralX(L, s, d), hgt - anchorElev, -(s - anchorS)];
  const roadYaw = (s) => -Math.atan(roadSlopeX(L, s));
  const steepness = (s, d, hgt) => Math.abs(groundAt(s, d + Math.sign(d) * 1.5) - hgt) / 1.5;
  const treeOk = (s, d, hgt) => {
    if (hgt < floorM + 1.2) return false; // 水中・水際
    if (L.treeline !== null && hgt - floorM > L.treeline) return false;
    return steepness(s, d, hgt) < L.trees.maxSlope;
  };

  for (const t of objects.trees) {
    const hgt = groundAt(t.s, t.d);
    if (!treeOk(t.s, t.d, hgt)) continue;
    const [x, y, z] = local(t.s, t.d, hgt);
    if (t.kind === 'conifer') {
      pushInstance(p.trunks, x, y - 0.3, z, t.scale * 1.2, 1.8 * t.scale, t.scale * 1.2);
      pushInstance(p.conifers, x, y, z, t.scale, t.scale, t.scale, 0, t.seed % 7, t.color);
    } else {
      pushInstance(p.trunks, x, y - 0.3, z, t.scale, 3.6 * t.scale, t.scale);
      const rand = mulberry32(t.seed);
      for (let i = 0; i < CANOPY_BLOBS_PER_TREE; i++) {
        const r = (1.5 + rand() * 0.7) * t.scale;
        const ox = (rand() - 0.5) * 1.6 * t.scale;
        const oz = (rand() - 0.5) * 1.6 * t.scale;
        const oy = (3.8 + i * 0.8 + rand() * 0.4) * t.scale;
        pushInstance(p.canopies, x + ox, y + oy, z + oz, r, r, r, 0, rand() * Math.PI, t.color);
      }
    }
  }

  for (const t of objects.farTrees) {
    const hgt = groundAt(t.s, t.d);
    if (!treeOk(t.s, t.d, hgt)) continue;
    const [x, y, z] = local(t.s, t.d, hgt);
    if (t.kind === 'conifer') {
      pushInstance(p.farCones, x, y - 0.5, z, 2.2 * t.scale, 9 * t.scale, 2.2 * t.scale, 0, 0, t.color);
    } else {
      pushInstance(p.farBlobs, x, y + 2.6 * t.scale, z, 3 * t.scale, 3.2 * t.scale, 3 * t.scale, 0, 0, t.color);
    }
  }

  for (const r of objects.rocks) {
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
    const [x, y, z] = local(dl.s, dl.d, elev.elevAt(dl.s));
    pushInstance(p.delineatorPosts, x, y - 0.05, z, 1, 1.15, 1);
    pushInstance(p.delineatorLens, x, y + 1.0, z + 0.05, 1, 1, 1, 0, roadYaw(dl.s) + Math.PI / 2);
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
      pushInstanceYawPitch(p.walls, (x0 + x1) / 2 + 0.25, yMid - 0.4, (z0 + z1) / 2, 0.5, w.heightM + 0.4, Math.hypot(dx, y1 - y0, dz) + 0.02, Math.atan2(-dx, -dz), 0);
    }
  }

  for (const hs of objects.houses) {
    const hgt = groundAt(hs.s, hs.d);
    if (hgt < floorM + 2 || steepness(hs.s, hs.d, hgt) > 0.45) continue;
    const [x, y, z] = local(hs.s, hs.d, hgt);
    const yaw = roadYaw(hs.s) + hs.yaw;
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

  for (const pool of Object.values(p)) commitPool(pool);
}

// ---- 毎フレームの更新 ----

const _sun = new THREE.Vector3();

function drawFrame(st, distanceKm, speedKmh) {
  const { L, elev } = st;
  const dist = distanceKm * 1000;
  if (st.anchorS === null || Math.abs(dist - st.anchorS) > REBUILD_M) {
    rebuildWorld(st, Math.round(dist / ROW_STEP_NEAR_M) * ROW_STEP_NEAR_M);
  }
  const riderElev = elev.elevAt(dist);
  const heading = Math.atan(roadSlopeX(L, dist));
  st.root.rotation.y = heading;
  st.inner.position.set(-roadCenterX(L, dist), st.anchorElev - riderElev, dist - st.anchorS);

  // 水面: 高さは毎フレーム(組み直し時点の地形とのずれは数cm)、さざ波の模様は絶対位置に固定
  st.water.position.y = st.floor.floorAt(dist) - riderElev;
  const t = (performance.now() - st.startedAt) / 1000;
  st.waterNormal.offset.set((roadCenterX(L, dist) / WATER_TILE_M + t * 0.004) % 1, (-dist / WATER_TILE_M + t * 0.01) % 1);

  // 空・太陽は地形と一緒に回す(カーブで向きが変わると太陽の方向も変わる)
  st.scene.backgroundRotation.y = heading;
  st.scene.environmentRotation.y = heading;
  _sun.copy(st.atmo.sunDir).applyAxisAngle(THREE.Object3D.DEFAULT_UP, heading);
  st.sunLight.position.copy(st.sunLight.target.position).addScaledVector(_sun, 180);

  const pitch = Math.atan((elev.elevAt(dist + 1.5) - elev.elevAt(dist - 1.5)) / 3);
  const riderPos = worldPoint(st, dist, dist, RIDER_X_M, 0);
  st.rider.group.position.set(riderPos[0], riderPos[1], riderPos[2]);
  updateRiderAvatar(st.rider, st.clock, speedKmh, pitch);

  const cam = worldPoint(st, dist, dist - CAM_BACK_M, RIDER_X_M + 0.4, CAM_HEIGHT_M);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const look = worldPoint(st, dist, dist + CAM_LOOKAHEAD_M, CAM_LOOK_LATERAL_M, CAM_LOOKAHEAD_HEIGHT_M);
  st.camera.lookAt(look[0], look[1], look[2]);

  st.renderer.render(st.scene, st.camera);
}

/** 道路上の地点(絶対距離s・中心からの横距離d・路面からの高さ)を、ライダー基準のワールド座標へ。 */
function worldPoint(st, dist, s, d, heightM) {
  const { L, elev } = st;
  const px = roadCenterX(L, s) + d - roadCenterX(L, dist);
  const py = elev.elevAt(s) - elev.elevAt(dist) + heightM;
  const pz = -(s - dist);
  const a = st.root.rotation.y;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [px * cos + pz * sin, py, -px * sin + pz * cos];
}
