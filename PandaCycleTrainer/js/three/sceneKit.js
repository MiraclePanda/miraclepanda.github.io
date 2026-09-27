// 3Dシーン(CityScene / LandscapeScene)が共有するThree.jsの部品。
// 空の焼き込み、ライダーのアバター、InstancedMeshのプール、描画品質の段階と自動調整、
// リサイズ・破棄など、「どの景色でも同じ」処理をここに集めている。

import THREE from './three.js';

// 左側通行: ライダーは左車線の中央付近を走る。
export const RIDER_X_M = -2.0;
export const WHEEL_RADIUS_M = 0.34;

// ---- 空・環境マップ ----

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, uGround, 1.0 - smoothstep(-0.12, 0.0, h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 1200.0) * 12.0 + pow(s, 16.0) * 0.18);
  if (h > 0.0) {
    // 空の高いところにある平面へ投影した、ゆるいfBmの積雲。
    vec2 cp = d.xz / (h + 0.1) * 1.3;
    float c = fbm(cp + vec2(4.3, 1.7));
    float cover = smoothstep(0.5, 0.78, c) * smoothstep(0.02, 0.25, h);
    vec3 cloud = mix(vec3(0.72, 0.75, 0.8), vec3(1.0, 0.99, 0.97), smoothstep(0.55, 0.9, c) * 0.6 + s * 0.4);
    col = mix(col, cloud, cover * 0.9);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const SKY_RADIUS_M = 700;

/**
 * 空は静的(太陽・雲とも動かない)なので、シェーダーで描いた空を初期化時に1度だけ
 * キューブマップ(背景用)へ焼き込み、PMREM環境マップ(映り込み用)は必要時に生成する。
 * 毎フレーム空の全画素でノイズを計算するより大幅に軽い。
 * @param {THREE.WebGLRenderer} renderer
 * @param {{zenith:string, horizon:string, ground:string, sunColor:string, sunDir:THREE.Vector3}} colors
 */
export function bakeSky(renderer, { zenith, horizon, ground, sunColor, sunDir }) {
  const backgroundTarget = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCamera = new THREE.CubeCamera(0.1, SKY_RADIUS_M * 2, backgroundTarget);
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    uniforms: {
      uZenith: { value: new THREE.Color(zenith) },
      uHorizon: { value: new THREE.Color(horizon) },
      uGround: { value: new THREE.Color(ground) },
      uSunColor: { value: new THREE.Color(sunColor) },
      uSunDir: { value: sunDir.clone() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS_M, 32, 16), material);
  skyMesh.frustumCulled = false;
  const skyScene = new THREE.Scene();
  skyScene.add(skyMesh);
  cubeCamera.update(renderer, skyScene);
  skyMesh.geometry.dispose();
  material.dispose();

  let envTarget = null;
  return {
    background: backgroundTarget.texture,
    /** 焼き込み済みのキューブマップ背景からPMREM環境マップを作る(初回呼び出し時のみ)。 */
    getEnvironment() {
      if (!envTarget) {
        const pmrem = new THREE.PMREMGenerator(renderer);
        envTarget = pmrem.fromCubemap(backgroundTarget.texture);
        pmrem.dispose();
      }
      return envTarget.texture;
    },
    dispose() {
      backgroundTarget.dispose();
      envTarget?.dispose();
    },
  };
}

// ---- ジオメトリ生成ヘルパー ----

/** position/normal/uvだけを持つ単純なジオメトリ群を1つに結合する(BufferGeometryUtils非依存)。 */
export function mergeGeometries(geometries) {
  const parts = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const itemSize = parts[0].attributes[name].itemSize;
    const total = parts.reduce((n, g) => n + g.attributes[name].array.length, 0);
    const array = new Float32Array(total);
    let offset = 0;
    for (const g of parts) {
      array.set(g.attributes[name].array, offset);
      offset += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  for (const g of new Set([...geometries, ...parts])) g.dispose();
  return merged;
}

/** 広葉樹の樹冠1塊。球を位置依存のノイズで膨らませ、葉の塊らしいデコボコにする。 */
export function buildCanopyGeometry() {
  // 位置だけの関数なので、継ぎ目の重複頂点も同じだけ動き、割れない。
  const geo = new THREE.SphereGeometry(1, 12, 9);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = 1 + 0.12 * Math.sin(x * 5.1 + 1.3) * Math.sin(y * 4.3 + 0.7) + 0.1 * Math.sin(z * 6.7 + y * 2.1);
    pos.setXYZ(i, x * n, y * n * 0.85, z * n);
  }
  geo.computeVertexNormals();
  return geo;
}

/** 2点間を結ぶ円柱(自転車のフレームや手足に使う)。 */
function tube(from, to, radius, material) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const len = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  mesh.castShadow = true;
  return mesh;
}

export function buildRiderAvatar() {
  const group = new THREE.Group();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.3, metalness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.6 });
  const jerseyMat = new THREE.MeshStandardMaterial({ color: 0x1f5fbf, roughness: 0.7 });
  const shortsMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b48f, roughness: 0.8 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35 });

  const R = WHEEL_RADIUS_M;
  const makeWheel = (z) => {
    const wheel = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.TorusGeometry(R, 0.022, 8, 32), darkMat);
    tire.castShadow = true;
    wheel.add(tire);
    // スポーク(回転が見えるように数本だけ)
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.008, R * 2, 0.008), new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.8, roughness: 0.3 }));
      spoke.rotation.z = (i * Math.PI) / 4;
      wheel.add(spoke);
    }
    wheel.rotation.y = Math.PI / 2;
    wheel.position.set(0, R, z);
    group.add(wheel);
    return wheel;
  };
  const rearWheel = makeWheel(0.5);
  const frontWheel = makeWheel(-0.5);

  const rearHub = [0, R, 0.5];
  const frontHub = [0, R, -0.5];
  const bb = [0, 0.3, 0.05];
  const seatTop = [0, 0.86, 0.2];
  const headTop = [0, 0.84, -0.4];
  const headBottom = [0, 0.7, -0.44];
  group.add(
    tube(rearHub, bb, 0.018, frameMat),
    tube(rearHub, seatTop, 0.016, frameMat),
    tube(bb, seatTop, 0.022, frameMat),
    tube(seatTop, headTop, 0.022, frameMat),
    tube(bb, headBottom, 0.026, frameMat),
    tube(headBottom, frontHub, 0.018, frameMat),
    tube(headTop, [0, 0.93, -0.44], 0.02, darkMat),
    tube([-0.2, 0.93, -0.46], [0.2, 0.93, -0.46], 0.015, darkMat),
    tube([0, 0.92, 0.28], [0, 0.93, 0.14], 0.03, darkMat) // サドル
  );

  const hip = [0, 1.0, 0.2];
  const shoulder = [0, 1.36, -0.2];
  group.add(tube(hip, shoulder, 0.15, jerseyMat));
  for (const sx of [-1, 1]) {
    group.add(
      tube([sx * 0.18, 1.34, -0.18], [sx * 0.2, 0.95, -0.46], 0.042, skinMat),
      tube([sx * 0.1, 1.0, 0.2], [sx * 0.12, 0.7, -0.08], 0.07, shortsMat),
      tube([sx * 0.12, 0.7, -0.08], [sx * 0.12, 0.34, 0.06], 0.05, skinMat)
    );
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), skinMat);
  head.position.set(0, 1.5, -0.32);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), helmetMat);
  helmet.position.set(0, 1.52, -0.3);
  helmet.scale.set(1, 0.9, 1.25);
  head.castShadow = true;
  helmet.castShadow = true;
  group.add(head, helmet);

  group.position.x = RIDER_X_M;
  return { group, spinners: [frontWheel, rearWheel], spinRadiusM: R, bobber: null, camera: { sideM: 0, raiseM: 0, backM: 0 } };
}

// セットアップ画面「④ オプション」のバイク種別。見た目だけを切り替える(物理演算・負荷は同じ)。
export const VEHICLES = ['bike', 'swan'];
const SWAN_PADDLE_RADIUS_M = 0.36;

/**
 * パロディモード: 上野・不忍池にあるようなレジャー用の足漕ぎスワンボート。
 * 白い胴体にS字の首と橙色のくちばし、たたんだ翼、座席のある操縦席、船尾で回る外輪。
 * 自転車の代わりに路面を進む(ライダーは操縦席に座って漕いでいる)。
 */
export function buildSwanBoat() {
  const group = new THREE.Group();
  // 揺れ(ぷかぷか)は内側のグループにかける(外側のグループの位置は毎フレーム各シーンが設定する)。
  const boat = new THREE.Group();
  group.add(boat);

  const white = new THREE.MeshStandardMaterial({ color: 0xf6f5ef, roughness: 0.32 });
  const shade = new THREE.MeshStandardMaterial({ color: 0xe4e2da, roughness: 0.4 });
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x5aa9d6, roughness: 0.35 });
  const cockpitMat = new THREE.MeshStandardMaterial({ color: 0x23324a, roughness: 0.8 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2f7ad1, roughness: 0.55 });
  const beakMat = new THREE.MeshStandardMaterial({ color: 0xf08a24, roughness: 0.45 });
  const blackMat = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.3 });
  const paddleMat = new THREE.MeshStandardMaterial({ color: 0xd8412f, roughness: 0.5 });
  const jerseyMat = new THREE.MeshStandardMaterial({ color: 0x1f5fbf, roughness: 0.7 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b48f, roughness: 0.8 });
  const helmetMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.35 });

  const add = (geometry, material, [x, y, z], [sx, sy, sz] = [1, 1, 1], [rx, ry, rz] = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.rotation.set(rx, ry, rz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    boat.add(mesh);
    return mesh;
  };
  const sphere = new THREE.SphereGeometry(1, 28, 18);

  // 船体(水色の帯)と白い胴体
  add(sphere, hullMat, [0, 0.42, 0.1], [0.82, 0.3, 1.45]);
  add(sphere, white, [0, 0.72, 0.12], [0.8, 0.52, 1.32]);
  // 操縦席の開口部・座席・背もたれ
  add(new THREE.CylinderGeometry(1, 1, 1, 28), cockpitMat, [0, 1.2, 0.22], [0.52, 0.05, 0.72]);
  add(new THREE.BoxGeometry(0.9, 0.12, 0.42), seatMat, [0, 1.18, 0.42]);
  add(new THREE.BoxGeometry(0.9, 0.22, 0.1), seatMat, [0, 1.3, 0.68], [1, 1, 1], [-0.18, 0, 0]);
  // 翼(左右)と尾
  for (const side of [-1, 1]) {
    add(sphere, shade, [side * 0.74, 1.0, 0.32], [0.14, 0.42, 0.95], [-0.25, 0, side * 0.28]);
    add(sphere, white, [side * 0.8, 1.12, 0.62], [0.1, 0.3, 0.6], [-0.55, 0, side * 0.35]);
  }
  add(new THREE.ConeGeometry(0.32, 0.7, 16), white, [0, 1.1, 1.38], [1, 1, 0.6], [0.95, 0, 0]);
  // S字の首と頭
  const neckCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.9, -0.92),
    new THREE.Vector3(0, 1.32, -1.28),
    new THREE.Vector3(0, 1.78, -1.22),
    new THREE.Vector3(0, 2.08, -1.02),
    new THREE.Vector3(0, 2.24, -1.12),
  ]);
  add(new THREE.TubeGeometry(neckCurve, 32, 0.17, 16, false), white, [0, 0, 0]);
  add(sphere, white, [0, 1.3, -1.18], [0.26, 0.4, 0.3]); // 首の付け根のふくらみ
  add(sphere, white, [0, 2.27, -1.2], [0.27, 0.25, 0.34]);
  add(new THREE.ConeGeometry(0.1, 0.38, 16), beakMat, [0, 2.2, -1.66], [1, 1, 1], [-Math.PI / 2 - 0.2, 0, 0]);
  add(sphere, blackMat, [0, 2.28, -1.5], [0.08, 0.09, 0.09]); // くちばしの付け根のこぶ
  for (const side of [-1, 1]) add(sphere, blackMat, [side * 0.2, 2.33, -1.36], [0.045, 0.045, 0.045]);

  // 操縦席で漕ぐライダー(上半身)と操縦レバー
  const riderPart = (from, to, radius, material) => {
    const mesh = tube(from, to, radius, material);
    boat.add(mesh);
    return mesh;
  };
  riderPart([0, 1.2, 0.4], [0, 1.66, 0.32], 0.16, jerseyMat);
  for (const side of [-1, 1]) riderPart([side * 0.19, 1.62, 0.3], [side * 0.12, 1.3, -0.08], 0.045, skinMat);
  riderPart([0, 1.05, -0.1], [0, 1.32, -0.12], 0.03, blackMat);
  add(new THREE.SphereGeometry(0.11, 14, 10), skinMat, [0, 1.84, 0.28]);
  add(new THREE.SphereGeometry(0.135, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), helmetMat, [0, 1.86, 0.3], [1, 0.9, 1.2]);

  // 船尾の外輪(速度に合わせて回る)
  const paddle = new THREE.Group();
  paddle.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.5, 12).rotateZ(Math.PI / 2), blackMat));
  for (let i = 0; i < 6; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.05, SWAN_PADDLE_RADIUS_M), paddleMat);
    blade.position.set(0, Math.sin((i * Math.PI) / 3) * SWAN_PADDLE_RADIUS_M * 0.5, Math.cos((i * Math.PI) / 3) * SWAN_PADDLE_RADIUS_M * 0.5);
    blade.rotation.x = -(i * Math.PI) / 3;
    blade.castShadow = true;
    paddle.add(blade);
  }
  paddle.position.set(0, SWAN_PADDLE_RADIUS_M + 0.02, 1.62);
  boat.add(paddle);

  // 実物(全長約3m)より少し大きめにして、走行画面でもスワンだと分かるようにする
  boat.scale.setScalar(1.2);
  group.position.x = RIDER_X_M;
  // カメラは少し右上の斜め後ろから: 真後ろだとS字の首と頭が胴体に隠れてしまう
  return { group, spinners: [paddle], spinRadiusM: SWAN_PADDLE_RADIUS_M, bobber: boat, camera: { sideM: 2.4, raiseM: 1.0, backM: 1.2 } };
}

/** バイク種別('bike' | 'swan')に応じたアバターを作る。 */
export function createAvatar(vehicle) {
  return vehicle === 'swan' ? buildSwanBoat() : buildRiderAvatar();
}

/** 車輪(外輪)の回転とアバターの前傾(路面の勾配)、スワンボートの揺れを更新する。 */
export function updateRiderAvatar(rider, clock, speedKmh, pitch) {
  const dt = Math.min(clock.getDelta(), 0.1);
  const speedMps = speedKmh / 3.6;
  const delta = (speedMps / rider.spinRadiusM) * dt; // rad
  // 前進(-Z方向)で車輪の上端が前へ回る向き。
  for (const spinner of rider.spinners) spinner.rotation.x -= delta;
  rider.group.rotation.x = pitch;
  if (rider.bobber) {
    // 水に浮いているかのように、ゆっくり上下しながら左右に揺れる(進むほど少し大きく)
    const t = clock.elapsedTime;
    const amp = 1 + Math.min(speedMps, 10) * 0.05;
    rider.bobber.position.y = Math.sin(t * 1.7) * 0.025 * amp;
    rider.bobber.rotation.z = Math.sin(t * 1.1 + 0.6) * 0.03 * amp;
    rider.bobber.rotation.x = Math.sin(t * 1.3 + 1.9) * 0.015 * amp;
  }
}

// ---- インスタンスプール ----

const _obj = new THREE.Object3D();
const _objYXZ = new THREE.Object3D();
_objYXZ.rotation.order = 'YXZ';
const _color = new THREE.Color();

export function makePool(geometry, material, max, { cast = true, receive = true } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.count = 0;
  // インスタンスの位置が大きく変わるため、キャッシュされる
  // バウンディングスフィアに頼ったカリングは使わない。
  mesh.frustumCulled = false;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  // 色を使わないプールにもinstanceColorを持たせる(白=マテリアル色そのまま)。
  // こうするとインスタンス描画するマテリアルのシェーダーが同じ構成に揃い、
  // コンパイルすべきシェーダープログラムの種類が減る(低速端末での起動時間短縮)。
  mesh.setColorAt(0, _color.setHex(0xffffff));
  return { mesh, max, n: 0 };
}

export function pushInstance(pool, x, y, z, sx, sy, sz, rotX = 0, rotY = 0, colorHex) {
  if (pool.n >= pool.max) return;
  _obj.position.set(x, y, z);
  _obj.rotation.set(rotX, rotY, 0);
  _obj.scale.set(sx, sy, sz);
  _obj.updateMatrix();
  pool.mesh.setMatrixAt(pool.n, _obj.matrix);
  pool.mesh.setColorAt(pool.n, _color.setHex(colorHex ?? 0xffffff));
  pool.n++;
}

/**
 * ヨー(Y軸)→ピッチ(X軸)の順で向きを決めるインスタンス配置。
 * ガードレールのビームなど「坂を上りながら曲がる」線状の部材に使う。
 */
export function pushInstanceYawPitch(pool, x, y, z, sx, sy, sz, yaw, pitch, colorHex) {
  if (pool.n >= pool.max) return;
  _objYXZ.position.set(x, y, z);
  _objYXZ.rotation.set(pitch, yaw, 0);
  _objYXZ.scale.set(sx, sy, sz);
  _objYXZ.updateMatrix();
  pool.mesh.setMatrixAt(pool.n, _objYXZ.matrix);
  pool.mesh.setColorAt(pool.n, _color.setHex(colorHex ?? 0xffffff));
  pool.n++;
}

export function commitPool(pool) {
  pool.mesh.count = pool.n;
  pool.mesh.instanceMatrix.needsUpdate = true;
  if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
  pool.n = 0;
}

// ---- 描画品質の自動調整 ----

// 描画品質の段階。トレーナー横に置くタブレット等の非力な端末でフレームレートが
// 落ちると物理演算のdt上限(PhysicsEngine: 0.25s)を超えて走行が実時間より遅れて
// しまうため、実測のフレーム間隔が遅ければ自動で1段ずつ品質を下げる(上げ直しはしない)。
export const QUALITY_TIERS = [
  { name: 'high', maxPixelRatio: 2, shadows: true, envMap: true },
  { name: 'medium', maxPixelRatio: 1, shadows: false, envMap: true },
  { name: 'low', maxPixelRatio: 0.6, shadows: false, envMap: false },
];
// 走行画面の「描画品質」で選べるモード。'auto' は実測のフレーム間隔による自動調整。
export const QUALITY_MODES = ['auto', 'high', 'medium', 'low'];
const QUALITY_SAMPLE_FRAMES = 10;
const SLOW_FRAME_MS = 45; // 約22fps未満が続いたら品質を下げる
const VERY_SLOW_FRAME_MS = 180; // 桁違いに遅い(ソフトウェアGL等)なら最低品質へ直行する

/**
 * シーン状態sに品質段階を適用する。sは { renderer, scene, sunLight, sky, canvas, camera } を持つこと。
 */
export function applyQuality(s, index) {
  const tier = QUALITY_TIERS[index];
  s.qualityIndex = index;
  s.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.maxPixelRatio));
  s.renderer.shadowMap.enabled = tier.shadows;
  s.sunLight.castShadow = tier.shadows;
  s.scene.environment = tier.envMap ? s.sky.getEnvironment() : null;
  // 影・環境マップの有無はシェーダーのdefineに影響するため再コンパイルさせる。
  // 環境マップが無いと金属的な面(窓ガラス・車体)は映り込むものが無く真っ黒になるため、
  // その場合は金属度を下げて拡散光で見えるようにする。
  s.scene.traverse((obj) => {
    if (!obj.material) return;
    const m = obj.material;
    if (m.isMeshStandardMaterial) {
      m.userData.baseMetalness ??= m.metalness;
      m.metalness = m.userData.baseMetalness * (tier.envMap ? 1 : 0.2);
    }
    m.needsUpdate = true;
  });
  s.canvas.dataset.quality = tier.name;
  resizeScene(s);
  s.onQualityChange?.(tier.name);
}

/** URLの ?quality=high|medium|low で品質を固定できる(自動調整は無効になる)。 */
export function forcedQualityIndex() {
  try {
    const name = new URLSearchParams(window.location.search).get('quality');
    const index = QUALITY_TIERS.findIndex((t) => t.name === name);
    return index >= 0 ? index : null;
  } catch {
    return null;
  }
}

/**
 * GPUを使わないソフトウェアレンダラー(SwiftShader/llvmpipe等)では最初から最低品質で始める。
 * 高品質で数フレーム測ってから落とすと、その間の1フレームが数百msかかり走行が遅れるため。
 */
export function initialQualityIndex(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return QUALITY_TIERS.length - 1;
  } catch {
    // 判定できなければ高品質から始め、実測で調整する。
  }
  return 0;
}

/**
 * 初期品質を決める。URLの ?quality= 指定(テスト用)があればそれを固定し、
 * 無ければユーザーが選んだモード(QUALITY_MODES、既定は自動)に従う。
 */
export function setupQuality(s, mode = 'auto') {
  s.qualityIndex = 0;
  const forced = forcedQualityIndex();
  if (forced !== null) {
    s.autoQuality = false;
    s.frameIntervals = [];
    s.lastDrawAt = null;
    s.canvas.dataset.qualityMode = QUALITY_TIERS[forced].name;
    applyQuality(s, forced);
    return;
  }
  setQualityMode(s, mode);
}

/**
 * 描画品質のモードを切り替える。'auto' なら端末に応じた初期段階から自動調整を再開し、
 * 'high' / 'medium' / 'low' ならその段階に固定する(自動調整は止める)。
 */
export function setQualityMode(s, mode) {
  const index = QUALITY_TIERS.findIndex((t) => t.name === mode);
  s.autoQuality = index < 0;
  s.frameIntervals = [];
  s.lastDrawAt = null;
  s.canvas.dataset.qualityMode = index < 0 ? 'auto' : mode;
  applyQuality(s, index < 0 ? initialQualityIndex(s.renderer) : index);
}

export function adaptQuality(s) {
  if (!s.autoQuality) return;
  const now = performance.now();
  if (s.lastDrawAt !== null) {
    const interval = now - s.lastDrawAt;
    // 一時停止やタブ非表示で空いた間隔は計測対象外。
    if (interval < 1000) s.frameIntervals.push(interval);
  }
  s.lastDrawAt = now;
  if (s.frameIntervals.length < QUALITY_SAMPLE_FRAMES) return;
  // シェーダーコンパイル・地形の再構築等の単発の遅延に引っ張られないよう中央値で判定する。
  const sorted = s.frameIntervals.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  s.frameIntervals.length = 0;
  const lowest = QUALITY_TIERS.length - 1;
  if (median > VERY_SLOW_FRAME_MS && s.qualityIndex < lowest) {
    applyQuality(s, lowest);
  } else if (median > SLOW_FRAME_MS && s.qualityIndex < lowest) {
    applyQuality(s, s.qualityIndex + 1);
  }
}

// ---- リサイズ・破棄 ----

export function resizeScene(s) {
  const rect = s.canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  s.renderer.setSize(width, height, false);
  s.camera.aspect = width / height;
  s.camera.updateProjectionMatrix();
}

/** シーン内の全ジオメトリ・マテリアル・テクスチャ・空・影マップ・レンダラーを解放する。 */
export function disposeScene(s) {
  s.scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of materials) m.dispose();
    }
    if (obj.isInstancedMesh) obj.dispose();
  });
  // テクスチャ・環境マップ・影マップはマテリアル/ジオメトリのdisposeでは解放されない。
  for (const t of s.textures) t.dispose();
  s.sky.dispose();
  s.scene.traverse((obj) => {
    if (obj.isLight && obj.shadow && obj.shadow.map) obj.shadow.map.dispose();
  });
  s.renderer.dispose();
}
