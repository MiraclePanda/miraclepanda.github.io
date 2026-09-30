import { h, useRef, useEffect, useState } from './h.js';
import THREE from '../three/three.js';
import { mulberry32, FLOOR_HEIGHT_M } from '../three/cityLayout.js';
import { createCityTextures, createFacadeMaterial, createFacadeGeometry, FACADE_TILE } from '../three/cityMaterials.js';
import { createWaterNormalTexture, createRetainingWallTexture, createTerrainDetailTexture } from '../three/landscapeMaterials.js';
import {
  shoreR, polar, routeAt, boatAt, collectPondObjects, groundHeightAt, groundHeightAtPolar, isParkSector,
  EMBANKMENT_M,
} from '../three/pondLayout.js';
import {
  bakeSky, mergeGeometries, buildCanopyGeometry, buildSwanBoat, createAvatar, updateRiderAvatar,
  makePool, pushInstance, commitPool, setupQuality, setQualityMode, adaptQuality, resizeScene, disposeScene,
} from '../three/sceneKit.js';

const { forwardRef, useImperativeHandle } = React;

// 秋晴れの東京。遠景のビル群やスカイツリーが霞む程度の大気
const ATMO = {
  zenith: '#3677c8', horizon: '#dde6ee', ground: '#a4aeb2', sunColor: '#fff2dc',
  sunDir: new THREE.Vector3(-0.5, 0.62, 0.4).normalize(),
};
const FOG_DENSITY = 0.00055;
const WATER_COLOR = 0x46705f; // 都心の池らしい緑がかった水
const WATER_SIZE_M = 8000;
const WATER_TILE_M = 14;

const CAM_BACK_M = 6.5;
const CAM_HEIGHT_M = 2.8;
const CAM_LOOKAHEAD_M = 26;
const CAM_LOOKAHEAD_HEIGHT_M = 1.2;
// 注視点は進路の正面(池の中央=左手と、柳の岸=右手の両方が画面に入る)
const CAM_LOOK_LEFT_M = 0;

// 地面(池の周り)の極座標グリッド: 岸からの距離(m)
const GROUND_OFFSETS_M = [0, 0.8, 1.2, 6.5, 7.5, 12, 20, 32, 48, 70, 100, 140, 190, 260, 350, 480, 650, 900, 1300, 1900];
const GROUND_ANGLES = 360;
const GROUND_TILE_M = 5;
const WALL_TILE_M = 4;

/** ワールド座標(X=東, Z=-北)。 */
const world = (x, y, hgt = 0) => new THREE.Vector3(x, hgt, -y);

/**
 * 上野・不忍池コースの3Dビュー。池を反時計回りに周回するスワンボートを描く。
 * CitySceneと同じくref経由のdraw({distanceKm, speedKmh})で描画する。
 *
 * 池とその周り(岸の柳・遊歩道・弁天堂・蓮池・ボート乗り場・上野公園の森・市街地のビル・
 * スカイツリー)は1周1.2kmの小さな世界なので、初期化時に1度だけ組み立てて固定し、
 * 毎フレームはボート・カメラ・影の範囲・他のスワンボートだけを動かす。
 */
export const PondScene = forwardRef(function PondScene({ courseEngine, vehicle = 'swan', qualityMode = 'auto', onQualityChange }, ref) {
  const canvasRef = useRef(null);
  const sceneRef = useRef(null);
  const [renderError, setRenderError] = useState(null);
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
    if (!canvas) return;

    let scene3d;
    try {
      scene3d = initScene(canvas, vehicle);
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
    h('canvas', { ref: canvasRef, className: 'city-scene-canvas', 'data-scenery': 'ueno', 'data-vehicle': vehicle }),
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
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(new THREE.Color(ATMO.horizon), FOG_DENSITY);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, 6000);

  const sky = bakeSky(renderer, ATMO);
  scene.background = sky.background;
  scene.environmentIntensity = 0.8;

  const hemiLight = new THREE.HemisphereLight(0xd0e2f4, 0x7a7564, 0.6);
  const sunLight = new THREE.DirectionalLight(new THREE.Color(ATMO.sunColor), 2.5);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunLight.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 10, far: 420 });
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.05;
  scene.add(hemiLight, sunLight, sunLight.target);

  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const textures = [];
  const track = (t) => {
    textures.push(t);
    return t;
  };
  const city = createCityTextures(anisotropy);
  textures.push(...city.all);
  const waterNormal = track(createWaterNormalTexture());
  const stone = track(createRetainingWallTexture(anisotropy));
  const detail = track(createTerrainDetailTexture(anisotropy));

  // 水面
  waterNormal.repeat.set(WATER_SIZE_M / WATER_TILE_M, WATER_SIZE_M / WATER_TILE_M);
  const waterGeo = new THREE.PlaneGeometry(WATER_SIZE_M, WATER_SIZE_M).rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({
    color: WATER_COLOR, roughness: 0.1, metalness: 0, normalMap: waterNormal, normalScale: new THREE.Vector2(0.25, 0.25),
  }));
  water.receiveShadow = true;
  scene.add(water);

  scene.add(buildGround(detail));
  scene.add(buildEmbankment(stone));

  const objects = collectPondObjects();
  const pools = buildPools(scene, city);
  placeStatic(pools, objects);

  // 弁天堂・ボート乗り場・スカイツリー
  scene.add(buildBentendo(objects.bentendo));
  scene.add(buildPier(objects.pier));
  scene.add(buildSkytree(objects.skytree));

  // 係留中と周回中の他のスワンボート(本物と同じモデル)
  const moored = objects.moored.map((m) => {
    const boat = buildSwanBoat();
    boat.group.position.copy(world(m.x, m.y));
    boat.group.rotation.y = yawFromHeading(m.yaw);
    scene.add(boat.group);
    return boat;
  });
  const others = objects.boats.map((b) => {
    const boat = buildSwanBoat();
    scene.add(boat.group);
    return { def: b, boat };
  });

  // 上野不忍池コースはスワンボート固定(万一 'bike' が渡っても池の上なのでスワンにする)
  const rider = createAvatar(vehicle === 'bike' ? 'swan' : vehicle);
  scene.add(rider.group);

  return {
    canvas, renderer, scene, camera, sky, sunLight, textures, waterNormal,
    moored, others, rider,
    clock: new THREE.Clock(),
    startedAt: performance.now(),
  };
}

/** 地図上の方位(東=0, 反時計回り) → アバター/モデルのY回転(モデルは-Zが前)。 */
function yawFromHeading(heading) {
  const fx = Math.cos(heading);
  const fz = -Math.sin(heading);
  return Math.atan2(-fx, -fz);
}

/** 池の周りの地面: 岸からの距離の同心リングと方位の極座標グリッド。頂点カラーで区域を塗る。 */
function buildGround(detail) {
  const cols = GROUND_ANGLES + 1; // 継ぎ目のUVを連続させるため最初の列を複製
  const rows = GROUND_OFFSETS_M.length;
  const pos = new Float32Array(cols * rows * 3);
  const uv = new Float32Array(cols * rows * 2);
  const col = new Float32Array(cols * rows * 3);
  const c = new THREE.Color();
  for (let r = 0; r < rows; r++) {
    const offset = GROUND_OFFSETS_M[r];
    for (let a = 0; a < cols; a++) {
      const theta = (a / GROUND_ANGLES) * Math.PI * 2;
      const rad = shoreR(theta) + offset;
      const p = polar(theta, rad);
      const hgt = groundHeightAtPolar(theta, offset);
      const i = r * cols + a;
      pos.set([p.x, hgt, -p.y], i * 3);
      uv.set([p.x / GROUND_TILE_M, p.y / GROUND_TILE_M], i * 2);
      const park = isParkSector(theta);
      let rgb;
      if (offset < 1) rgb = [0.62, 0.6, 0.56]; // 護岸の笠石
      else if (offset < 7) rgb = [0.7, 0.66, 0.58]; // 池畔の遊歩道
      else if (offset < (park ? 60 : 30)) rgb = [0.4, 0.55, 0.28]; // 芝生
      else if (park) rgb = [0.3, 0.42, 0.22]; // 上野公園の森の林床
      else rgb = [0.55, 0.55, 0.53]; // 市街地
      c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      col.set([c.r, c.g, c.b], i * 3);
    }
  }
  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let a = 0; a < cols - 1; a++) {
      const i0 = r * cols + a;
      const i1 = i0 + 1;
      const i2 = i0 + cols;
      const i3 = i2 + 1;
      // θ増加方向(反時計回り)と外向きで、上向きの面になる巻き順
      idx.push(i0, i1, i2, i1, i3, i2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.95, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

/** 石積みの護岸(水面下から遊歩道の高さまでの垂直な帯)。 */
function buildEmbankment(stone) {
  const n = GROUND_ANGLES + 1;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  let arc = 0;
  let prev = null;
  for (let a = 0; a < n; a++) {
    const theta = (a / GROUND_ANGLES) * Math.PI * 2;
    const p = polar(theta, shoreR(theta));
    if (prev) arc += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
    pos.set([p.x, -0.8, -p.y, p.x, EMBANKMENT_M, -p.y], a * 6);
    uv.set([arc / WALL_TILE_M, 0, arc / WALL_TILE_M, (EMBANKMENT_M + 0.8) / 3], a * 4);
  }
  const idx = [];
  for (let a = 0; a < n - 1; a++) {
    const b0 = a * 2;
    idx.push(b0, b0 + 2, b0 + 1, b0 + 1, b0 + 2, b0 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: stone, roughness: 0.95, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

/** 柳: 細い幹と、上から垂れ下がる枝葉(縦長の樹冠+裾広がりのすだれ)。 */
function buildWillowCrownGeometry() {
  const crown = new THREE.SphereGeometry(1, 14, 10).scale(2.6, 2.2, 2.6).translate(0, 5.6, 0);
  const curtain = new THREE.CylinderGeometry(2.3, 3.4, 4.2, 16, 3, true).translate(0, 3.6, 0);
  const pos = curtain.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // すだれの裾をぎざぎざにして、垂れた枝らしく見せる
    const y = pos.getY(i);
    if (y < 2) {
      const ang = Math.atan2(pos.getZ(i), pos.getX(i));
      pos.setY(i, y - 0.6 * Math.abs(Math.sin(ang * 7)));
    }
  }
  curtain.computeVertexNormals();
  return mergeGeometries([crown, curtain]);
}

function buildConeTreeGeometry() {
  return mergeGeometries([
    new THREE.ConeGeometry(2.2, 5, 9).translate(0, 3.5, 0),
    new THREE.ConeGeometry(1.6, 4, 9).translate(0, 6.2, 0),
    new THREE.ConeGeometry(0.9, 3, 9).translate(0, 8.4, 0),
  ]);
}

function buildLampGeometry() {
  return mergeGeometries([
    new THREE.CylinderGeometry(0.1, 0.14, 0.4, 10).translate(0, 0.2, 0),
    new THREE.CylinderGeometry(0.05, 0.07, 3.6, 10).translate(0, 1.8, 0),
    new THREE.CylinderGeometry(0.22, 0.14, 0.5, 8).translate(0, 3.85, 0), // 灯具
    new THREE.ConeGeometry(0.3, 0.25, 8).translate(0, 4.22, 0),
  ]);
}

function buildPools(scene, city) {
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const pools = {
    trunks: makePool(new THREE.CylinderGeometry(0.12, 0.2, 1, 8).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 1 }), 1400),
    willows: makePool(buildWillowCrownGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide }), 200),
    canopies: makePool(buildCanopyGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.95 }), 3000),
    cones: makePool(buildConeTreeGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.95 }), 400),
    lamps: makePool(buildLampGeometry(), new THREE.MeshStandardMaterial({ color: 0x33393e, roughness: 0.5, metalness: 0.5 }), 60),
    lotus: makePool(new THREE.CircleGeometry(1, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ roughness: 0.7, side: THREE.DoubleSide }), 1600, { cast: false }),
    lotusBuds: makePool(new THREE.SphereGeometry(0.16, 8, 6).scale(1, 1.4, 1), new THREE.MeshStandardMaterial({ color: 0xf2a6c2, roughness: 0.6 }), 160, { cast: false }),
    roofs: makePool(box, new THREE.MeshStandardMaterial({ color: 0x8e8b85, roughness: 0.9 }), 200),
  };
  const facadeGeo = createFacadeGeometry();
  for (const style of ['stucco', 'concrete', 'glass', 'brick']) {
    const bayM = style === 'glass' ? 1.8 : FLOOR_HEIGHT_M;
    pools[`bld_${style}`] = makePool(facadeGeo, createFacadeMaterial({
      ...city.facades[style], bayM, floorM: FLOOR_HEIGHT_M, tileBays: FACADE_TILE.cellBays, tileFloors: FACADE_TILE.cellFloors, sinkM: FLOOR_HEIGHT_M,
    }), 120);
  }
  for (const p of Object.values(pools)) scene.add(p.mesh);
  return pools;
}

function placeStatic(p, o) {
  for (const w of o.willows) {
    const g = groundHeightAt(w.x, w.y);
    const v = world(w.x, w.y, g);
    pushInstance(p.trunks, v.x, v.y - 0.2, v.z, w.scale, 5 * w.scale, w.scale);
    pushInstance(p.willows, v.x, v.y, v.z, w.scale, w.scale, w.scale, 0, (w.seed % 628) / 100, 0x8fb04e);
  }
  const blobs = (t, v) => {
    const rand = mulberry32(t.seed);
    for (let i = 0; i < 3; i++) {
      const r = (1.7 + rand() * 0.8) * t.scale;
      pushInstance(p.canopies, v.x + (rand() - 0.5) * 2 * t.scale, v.y + (3.8 + i * 0.9 + rand() * 0.5) * t.scale, v.z + (rand() - 0.5) * 2 * t.scale, r, r * 0.85, r, 0, rand() * Math.PI, t.color);
    }
  };
  for (const t of o.cherries) {
    const v = world(t.x, t.y, groundHeightAt(t.x, t.y));
    pushInstance(p.trunks, v.x, v.y - 0.2, v.z, t.scale * 1.2, 3.6 * t.scale, t.scale * 1.2);
    blobs(t, v);
  }
  for (const t of o.parkTrees) {
    const v = world(t.x, t.y, groundHeightAt(t.x, t.y));
    if (t.conifer) {
      pushInstance(p.trunks, v.x, v.y - 0.2, v.z, t.scale, 2 * t.scale, t.scale);
      pushInstance(p.cones, v.x, v.y, v.z, t.scale * 1.2, t.scale * 1.4, t.scale * 1.2, 0, 0, t.color);
    } else {
      pushInstance(p.trunks, v.x, v.y - 0.2, v.z, t.scale * 1.3, 4.2 * t.scale, t.scale * 1.3);
      blobs({ ...t, scale: t.scale * 1.4 }, v);
    }
  }
  for (const l of o.lamps) {
    const v = world(l.x, l.y, EMBANKMENT_M);
    pushInstance(p.lamps, v.x, v.y, v.z, 1, 1, 1);
  }
  const rand = mulberry32(77);
  for (const lf of o.lotus) {
    // 蓮の葉は茎で水面から持ち上がる(高さはまちまち)
    const v = world(lf.x, lf.y, 0.05 + rand() * rand() * 0.9);
    const green = rand() < 0.5 ? 0x5a8a35 : 0x4d7a30;
    pushInstance(p.lotus, v.x, v.y, v.z, lf.size, 1, lf.size, lf.tilt, lf.yaw, green);
    if (rand() < 0.08) pushInstance(p.lotusBuds, v.x + 0.3, v.y + 0.6, v.z, 1, 1, 1);
  }
  for (const b of o.buildings) {
    const g = groundHeightAt(b.x, b.y);
    const v = world(b.x, b.y, g);
    const yaw = -b.theta; // 池の方(中心)へ正面を向ける
    const height = b.floors * FLOOR_HEIGHT_M;
    pushInstance(p[`bld_${b.style}`], v.x, g - FLOOR_HEIGHT_M, v.z, b.depthM, height + FLOOR_HEIGHT_M, b.widthM, 0, yaw, b.tint);
    pushInstance(p.roofs, v.x, g + height, v.z, b.depthM + 0.4, 0.7, b.widthM + 0.4, 0, yaw);
  }
  for (const pool of Object.values(p)) commitPool(pool);
}

/** 弁天堂: 石の基壇の上に朱塗りの八角堂と黒い瓦屋根、頂に宝珠。 */
function buildBentendo(site) {
  const group = new THREE.Group();
  const add = (geo, color, y, opts = {}) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.7, metalness: opts.metalness ?? 0 }));
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };
  add(new THREE.CylinderGeometry(12, 13, 1.4, 8), 0x9a958a, 0.7, { roughness: 1 });
  add(new THREE.CylinderGeometry(8.5, 8.5, 5, 8), 0xc0392b, 3.9);
  add(new THREE.CylinderGeometry(9.2, 9.2, 0.6, 8), 0x2e2a26, 6.6);
  add(new THREE.ConeGeometry(12.5, 5.5, 8), 0x3a3f44, 9.6, { roughness: 0.55, metalness: 0.2 });
  add(new THREE.CylinderGeometry(0.4, 0.6, 1.4, 8), 0x3a3f44, 12.8);
  add(new THREE.SphereGeometry(0.7, 12, 10), 0xd4a93a, 13.9, { roughness: 0.3, metalness: 0.7 });
  group.position.copy(world(site.x, site.y, EMBANKMENT_M));
  group.rotation.y = Math.PI / 8;
  return group;
}

/** ボート乗り場の桟橋(板張りの床と杭)。 */
function buildPier(pier) {
  const group = new THREE.Group();
  const length = pier.fromR - pier.toR;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(pier.widthM, 0.35, length), new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 }));
  deck.position.set(0, EMBANKMENT_M - 0.3, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, roughness: 1 });
  for (let i = 0; i <= 4; i++) {
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.2, 8), postMat);
      post.position.set(side * (pier.widthM / 2 - 0.3), -0.3, -length / 2 + (i / 4) * length);
      group.add(post);
    }
  }
  const mid = polar(pier.theta, (pier.fromR + pier.toR) / 2);
  group.position.copy(world(mid.x, mid.y));
  group.rotation.y = yawFromHeading(pier.theta + Math.PI); // 岸から池の中心へ突き出す
  return group;
}

/** 遠景の東京スカイツリー(霞んだシルエット)。 */
function buildSkytree(site) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.6, metalness: 0.3 });
  const part = (geo, y) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    group.add(m);
  };
  part(new THREE.CylinderGeometry(6, 34, 450, 12), 225);
  part(new THREE.CylinderGeometry(20, 20, 26, 16), 350);
  part(new THREE.CylinderGeometry(9, 9, 150, 12), 500);
  part(new THREE.CylinderGeometry(14, 14, 12, 16), 450);
  part(new THREE.CylinderGeometry(2, 3, 140, 8), 634 - 70);
  group.position.copy(world(site.x, site.y, 0));
  return group;
}

// ---- 毎フレームの更新 ----

const _right = new THREE.Vector3();

function routeWorld(s) {
  const r = routeAt(s);
  return { pos: world(r.x, r.y, 0), heading: r.heading };
}

function drawFrame(st, distanceKm, speedKmh) {
  const dist = distanceKm * 1000;
  const here = routeWorld(dist);

  // スワンボート(ライダー)
  st.rider.group.position.copy(here.pos);
  st.rider.group.rotation.y = yawFromHeading(here.heading);
  updateRiderAvatar(st.rider, st.clock, speedKmh, 0);

  // カメラ: 斜め後ろ上から(アバターごとの補正込み)。池の中心側(左)を少し多めに見る
  const { sideM, raiseM, backM } = st.rider.camera;
  const behind = routeWorld(dist - CAM_BACK_M - backM);
  _right.set(Math.sin(behind.heading), 0, Math.cos(behind.heading));
  st.camera.position.copy(behind.pos).addScaledVector(_right, 0.4 + sideM);
  st.camera.position.y = CAM_HEIGHT_M + raiseM;
  const ahead = routeWorld(dist + CAM_LOOKAHEAD_M);
  _right.set(Math.sin(ahead.heading), 0, Math.cos(ahead.heading));
  const look = ahead.pos.clone().addScaledVector(_right, -CAM_LOOK_LEFT_M);
  st.camera.lookAt(look.x, CAM_LOOKAHEAD_HEIGHT_M, look.z);

  // 影はボートの周りだけ描けばよいので、影カメラごとボートに付いていく
  st.sunLight.target.position.copy(here.pos);
  st.sunLight.position.copy(here.pos).addScaledVector(ATMO.sunDir, 180);

  // 他のスワンボート(ゆっくり反時計回り)と、係留中のボートの揺れ
  const t = (performance.now() - st.startedAt) / 1000;
  for (const { def, boat } of st.others) {
    const b = boatAt(def, t);
    boat.group.position.copy(world(b.x, b.y));
    boat.group.rotation.y = yawFromHeading(b.heading);
    bob(boat, t + def.phase * 10, 1.2);
  }
  st.moored.forEach((boat, i) => bob(boat, t + i * 1.7, 0.6));

  st.waterNormal.offset.set((t * 0.004) % 1, (t * 0.007) % 1);
  st.renderer.render(st.scene, st.camera);
}

function bob(boat, t, amp) {
  boat.bobber.position.y = Math.sin(t * 1.6) * 0.025 * amp;
  boat.bobber.rotation.z = Math.sin(t * 1.05 + 0.6) * 0.03 * amp;
  boat.bobber.rotation.x = Math.sin(t * 1.25 + 1.9) * 0.015 * amp;
}
