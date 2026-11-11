// 実在の地形の遠景(実験。描画品質「最高(実験)」で、熱海・河口湖・京都・奈良で使う。設定は gsiTerrain.js の REAL_TERRAIN)。
//
// 国土地理院の標高タイルと写真タイル(計算は gsiTerrain.js)から、ライダーのまわり約20km四方の
// 山並み・海岸線・島(熱海なら初島、河口湖なら富士山)を1枚のメッシュにする。backdrops.js の富士山と同じく、空と一緒に回る遠景として
// ライダーに付いて動き(走っても位置は変わらない)、フォグは使わず自前のシェーダーで
// 光の色・強さと大気遠近(フォグ色へ溶かす)を走行環境から読む。
// - 海(標高データなし)とライダーのまわり innerRadiusM の内側は描かない(海は水面、近くは手続き生成の街と山)。
// - タイルは走行中にネットワークから読む。読めなければ(オフライン・CORS など)何も出さず、
//   手続き生成の山並みだけで走れる(onStatus で 'error' を知らせる)。
// - 地理院タイルの利用条件に従い、表示中は出典を画面に出す(LandscapeScene が GSI_ATTRIBUTION を表示する)。

import THREE from './three.js';
import { threeWebGPU } from './gpuBackend.js';
import {
  GSI_DEM_URL,
  GSI_PHOTO_URL,
  TILE_PX,
  tileUrl,
  tileRange,
  sampleDemGrid,
  gridEastNorth,
  enToScene,
  heightNearOrigin,
  terrainHeights,
} from './gsiTerrain.js';
import { photoTintMul, seasonalGround } from './seasonLook.js';

// 大気遠近: backdrops.js と同じ考え方(フォグ密度 × 距離 × 係数)。実際のフォグより弱く
const HAZE_SCALE = 0.11;
const HAZE_MAX = 0.9;

async function loadBitmap(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return createImageBitmap(await res.blob());
}

/**
 * 範囲のタイルを1枚のキャンバスに並べる。読めなかったタイルは fill の色で塗る。
 * 地理院の標高タイルは海だけの範囲にはタイルが無く 404 になる(熱海の範囲でも沖の数枚)ので、
 * 標高は fill = 無効値の色(海)で埋めて続ける。1枚も読めなかったときだけ失敗にする
 * (オフライン・CORS で弾かれたなど。理由は最初のエラーで返す)。
 */
async function loadMosaic(template, range, fill) {
  const size = range.tiles * TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);
  let loaded = 0;
  let firstError = null;
  const jobs = [];
  for (let j = 0; j < range.tiles; j++) {
    for (let i = 0; i < range.tiles; i++) {
      const url = tileUrl(template, range.z, range.x0 + i, range.y0 + j);
      jobs.push(
        loadBitmap(url).then(
          (bmp) => {
            ctx.drawImage(bmp, i * TILE_PX, j * TILE_PX);
            bmp.close?.();
            loaded++;
          },
          (err) => {
            firstError ??= err;
          }
        )
      );
    }
  }
  await Promise.all(jobs);
  if (loaded === 0) throw firstError ?? new Error(`タイルを読めませんでした: ${template}`);
  return { canvas, ctx, size, loaded };
}

/**
 * 標高格子から地形のジオメトリ(回転前のシーン座標)を作る。
 * ys / visible は gsiTerrain.js の terrainHeights() の結果(基準面からの高さと、描くかどうか)。
 */
export function buildTerrainGeometry(ys, visible, gridN, en, bearingDeg) {
  const positions = new Float32Array(gridN * gridN * 3);
  const uvs = new Float32Array(gridN * gridN * 2);
  const vis = new Float32Array(gridN * gridN);
  for (let k = 0; k < gridN * gridN; k++) {
    const p = enToScene(en.e[k], en.n[k], bearingDeg);
    positions[k * 3] = p.x;
    positions[k * 3 + 1] = ys[k];
    vis[k] = visible[k];
    positions[k * 3 + 2] = p.z;
    const i = k % gridN;
    const j = Math.floor(k / gridN);
    uvs[k * 2] = (i + 0.5) / gridN;
    uvs[k * 2 + 1] = 1 - (j + 0.5) / gridN; // 写真の上(北)が v = 1
  }
  const index = [];
  for (let j = 0; j < gridN - 1; j++) {
    for (let i = 0; i < gridN - 1; i++) {
      const a = j * gridN + i;
      const b = a + 1;
      const c = a + gridN;
      const d = c + 1;
      // 4隅とも描かない点(海・湖)なら作らない
      if (!visible[a] && !visible[b] && !visible[c] && !visible[d]) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aVisible', new THREE.BufferAttribute(vis, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  // 向き(進行方向の符号)によって三角形が裏返ることがあるので、法線は上向きにそろえる
  const nrm = g.getAttribute('normal');
  for (let k = 0; k < nrm.count; k++) {
    if (nrm.getY(k) < 0) nrm.setXYZ(k, -nrm.getX(k), -nrm.getY(k), -nrm.getZ(k));
  }
  return g;
}

function createMaterial(innerRadiusM, openSideX, innerBox, minDistM) {
  const W = threeWebGPU();
  if (W) return createGpuMaterial(W, innerRadiusM, openSideX, innerBox, minDistM);
  return new THREE.ShaderMaterial({
    fog: false,
    lights: false,
    side: THREE.DoubleSide,
    uniforms: {
      uMap: { value: null },
      uHasMap: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSun: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uHaze: { value: new THREE.Color(0.8, 0.85, 0.9) },
      uHazeK: { value: 0.0001 },
      uHazeMax: { value: HAZE_MAX },
      uInner: { value: innerRadiusM },
      uOpenSideX: { value: openSideX },
      uMinDist: { value: minDistM },
      uBox: { value: innerBox ? new THREE.Vector4(innerBox.minX, innerBox.maxX, innerBox.minZ, innerBox.maxZ) : new THREE.Vector4(1, -1, 1, -1) },
      // 季節: 高さ 0 の所の標高(m)、雪(雪線の標高・雪になりきる幅・写真にも掛けるか)、写真の色の倍率、低い所の森の色
      uBaseM: { value: 0 },
      uSnow: { value: new THREE.Vector3(2500, 400, 0) },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uLow: { value: new THREE.Color().setRGB(0.16, 0.24, 0.13, THREE.SRGBColorSpace) },
    },
    vertexShader: /* glsl */ `
      attribute float aVisible;
      varying vec3 vLocal;
      varying vec3 vNormalW;
      varying vec2 vUv;
      varying float vVisible;
      void main() {
        vLocal = position;
        vVisible = aVisible;
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uHasMap;
      uniform vec3 uSunDir;
      uniform vec3 uSun;
      uniform vec3 uAmbient;
      uniform vec3 uHaze;
      uniform float uHazeK;
      uniform float uHazeMax;
      uniform float uInner;
      uniform float uOpenSideX;
      uniform float uMinDist;
      uniform vec4 uBox;
      uniform float uBaseM;
      uniform vec3 uSnow;
      uniform vec3 uTint;
      uniform vec3 uLow;
      varying vec3 vLocal;
      varying vec3 vNormalW;
      varying vec2 vUv;
      varying float vVisible;
      void main() {
        float dist = length(vLocal.xz);
        // 海・湖(vVisible = 0)と、手続き生成の景色が描くライダーのまわりは描かない。
        // 水側(回転前の X < uOpenSideX。熱海の相模湾・河口湖)は 400 m より先なら本物の岬・島・対岸を見せる
        if (vVisible < 0.5 || dist < uMinDist || (dist < uInner && vLocal.x > uOpenSideX)) discard;
        // 実在の座標に組んだ景色(熱海)は、近景の地形の範囲(矩形)の内側を描かない
        if (vLocal.x > uBox.x && vLocal.x < uBox.y && vLocal.z > uBox.z && vLocal.z < uBox.w) discard;
        vec3 n = normalize(vNormalW);
        // 写真が無いときは標高で塗る(低い所は森の色、高い所は茶色がかった灰色)
        vec3 byHeight = mix(uLow, vec3(0.3, 0.3, 0.26), smoothstep(150.0, 700.0, vLocal.y));
        // 富士山のように高い山の上は雪。季節があればその日の雪線から上(写真にも掛ける。夏は雪なし)、
        // 無ければ 2500 m から上(写真が無いときだけ)
        float snow = smoothstep(uSnow.x, uSnow.x + uSnow.y, vLocal.y + uBaseM) * smoothstep(0.3, 0.6, abs(normalize(vNormalW).y));
        byHeight = mix(byHeight, vec3(0.85, 0.87, 0.9), snow);
        vec3 albedo = uHasMap > 0.5 ? mix(texture2D(uMap, vUv).rgb * uTint, vec3(0.85, 0.87, 0.9), snow * uSnow.z) : byHeight;
        // 写真には撮影時の日なた・日陰が焼き込まれているので、陰影は弱めにかける
        float diffuse = max(dot(n, normalize(uSunDir)), 0.0);
        vec3 color = albedo * (uAmbient + uSun * (0.35 + 0.65 * diffuse));
        float haze = min(uHazeMax, 1.0 - exp(-uHazeK * dist));
        color = mix(color, uHaze, haze);
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * WebGPU 用: createMaterial の GLSL と同じ塗り方を TSL で(ShaderMaterial は WebGPU で使えないため)。
 * material.uniforms に同じ名前・同じ形(.value)の uniform を持たせ、呼び出し側は WebGL と同じに扱える。
 */
function createGpuMaterial(W, innerRadiusM, openSideX, innerBox, minDistM) {
  const {
    uniform, texture, attribute, positionGeometry, normalWorldGeometry, uv, vec3, vec4, float, mix, smoothstep,
    max, min, dot, normalize, exp, abs, length, select,
  } = W.TSL;
  const u = {
    uMap: texture(new THREE.Texture(), uv()),
    uHasMap: uniform(0),
    uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
    uSun: uniform(new THREE.Color(1, 1, 1)),
    uAmbient: uniform(new THREE.Color(0.5, 0.5, 0.5)),
    uHaze: uniform(new THREE.Color(0.8, 0.85, 0.9)),
    uHazeK: uniform(0.0001),
    uHazeMax: uniform(HAZE_MAX),
    uBaseM: uniform(0),
    uSnow: uniform(new THREE.Vector3(2500, 400, 0)),
    uTint: uniform(new THREE.Vector3(1, 1, 1)),
    uLow: uniform(new THREE.Color().setRGB(0.16, 0.24, 0.13, THREE.SRGBColorSpace)),
  };
  const box = innerBox ?? { minX: 1, maxX: -1, minZ: 1, maxZ: -1 };
  const material = new W.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
  material.uniforms = u;
  const p = positionGeometry;
  const dist = length(p.xz);
  // 描かない所(GLSL 版の discard と同じ): 海・湖、ライダーのまわり、水側の近く、近景の地形の矩形の内側
  const hidden = attribute('aVisible', 'float').lessThan(0.5)
    .or(dist.lessThan(minDistM))
    .or(dist.lessThan(innerRadiusM).and(p.x.greaterThan(openSideX)))
    .or(p.x.greaterThan(box.minX).and(p.x.lessThan(box.maxX)).and(p.z.greaterThan(box.minZ)).and(p.z.lessThan(box.maxZ)));
  material.maskNode = hidden.not();
  const n = normalize(normalWorldGeometry);
  const snowWhite = vec3(0.85, 0.87, 0.9);
  const snow = smoothstep(u.uSnow.x, u.uSnow.x.add(u.uSnow.y), p.y.add(u.uBaseM)).mul(smoothstep(0.3, 0.6, abs(n.y)));
  const byHeight = mix(mix(u.uLow, vec3(0.3, 0.3, 0.26), smoothstep(150, 700, p.y)), snowWhite, snow);
  const photo = mix(u.uMap.rgb.mul(u.uTint), snowWhite, snow.mul(u.uSnow.z));
  const albedo = select(u.uHasMap.greaterThan(0.5), photo, byHeight);
  const diffuse = max(dot(n, normalize(u.uSunDir)), 0);
  const lit = albedo.mul(u.uAmbient.add(u.uSun.mul(float(0.35).add(diffuse.mul(0.65)))));
  const haze = min(u.uHazeMax, float(1).sub(exp(u.uHazeK.negate().mul(dist))));
  material.colorNode = vec4(mix(lit, u.uHaze, haze), 1);
  return material;
}

const _sun = new THREE.Vector3();

/**
 * 実在の地形の遠景を作る(読み込みは load() で始める)。
 * @param {object} cfg gsiTerrain.js の ATAMI_REAL_TERRAIN の形
 * @param {object} [opts]
 * @param {(status: 'loading'|'ready'|'error', err?: Error) => void} [opts.onStatus]
 * @param {number} [opts.anisotropy]
 */
export function createRealTerrain(cfg, { onStatus, anisotropy = 4, season = null } = {}) {
  // openSideX が無い設定(京都・奈良)は水側を開けない(十分大きい値 = どの点も「水側でない」)
  // innerBox(回転前のシーン座標の矩形 { minX, maxX, minZ, maxZ })の内側も描かない(熱海: 近景の地形の範囲)
  const material = createMaterial(cfg.innerRadiusM, cfg.openSideX ?? -1e9, cfg.innerBox ?? null, cfg.minDistM ?? 400);
  if (season) {
    // 走る日の季節: 写真の色(葉のある季節は緑、秋は黄み)・雪線・標高で塗るときの森の色
    const u = material.uniforms;
    u.uSnow.value.set(Number.isFinite(season.snowLineM) ? season.snowLineM : 1e6, 150, 1);
    u.uTint.value.fromArray(photoTintMul(season, 0));
    const [r, g, b] = seasonalGround(season, [0.16, 0.24, 0.13], 0, 1, 1);
    u.uLow.value.setRGB(r, g, b, THREE.SRGBColorSpace);
  }
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = 'real-terrain';
  mesh.frustumCulled = false;
  mesh.visible = false;
  let texture = null;
  let status = 'idle';
  let disposed = false;
  const setStatus = (s, err) => {
    status = s;
    onStatus?.(s, err);
  };

  return {
    object: mesh,
    get status() {
      return status;
    },
    /** タイルを読み、メッシュを作る(2回目以降は何もしない)。 */
    async load() {
      if (status !== 'idle') return;
      setStatus('loading');
      try {
        const range = tileRange({ ...cfg.origin, z: cfg.z, tiles: cfg.tiles, offsetEM: cfg.offsetEM, offsetNM: cfg.offsetNM });
        const [dem, photo] = await Promise.all([
          // 標高: 無いタイルは無効値 (128, 0, 0) = 海。写真: 無いタイルは山の緑で塗る(海の部分は描かないので目立たない)
          loadMosaic(GSI_DEM_URL, range, 'rgb(128, 0, 0)'),
          loadMosaic(GSI_PHOTO_URL, range, 'rgb(64, 84, 56)').catch(() => null),
        ]);
        if (disposed) return;
        const rgba = dem.ctx.getImageData(0, 0, dem.size, dem.size).data;
        const heights = sampleDemGrid(rgba, dem.size, cfg.gridN);
        const en = gridEastNorth(range, cfg.gridN, cfg.origin);
        const t = terrainHeights(heights, cfg, heightNearOrigin(heights, en));
        // 季節の雪線は標高で比べるので、高さ 0 の所の標高を渡す(季節が無ければ従来どおり高さそのまま)
        if (season) material.uniforms.uBaseM.value = t.baseM ?? 0;
        mesh.geometry.dispose();
        mesh.geometry = buildTerrainGeometry(t.y, t.visible, cfg.gridN, en, cfg.bearingDeg);
        if (photo) {
          texture = new THREE.CanvasTexture(photo.canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = anisotropy;
          material.uniforms.uMap.value = texture;
          material.uniforms.uHasMap.value = 1;
        }
        setStatus('ready');
      } catch (err) {
        if (disposed) return;
        // 原因(HTTP の状態・CORS など)は開発者ツールのコンソールで確かめられるようにする
        console.warn('実在の地形(地理院タイル)を読み込めませんでした:', err);
        setStatus('error', err);
      }
    },
    /**
     * 毎フレーム、カメラを動かした後に呼ぶ(backdrops.js の update と同じ引数)。
     * enabled が false か、まだ読めていなければ隠す。
     */
    update({ enabled, skyHeading, baseY, sunDir, hemiLight, sunLight, fog }) {
      mesh.visible = enabled && status === 'ready';
      if (!mesh.visible) return;
      mesh.position.set(0, baseY, 0);
      mesh.rotation.y = skyHeading;
      _sun.copy(sunDir).applyAxisAngle(THREE.Object3D.DEFAULT_UP, skyHeading);
      const u = material.uniforms;
      u.uSunDir.value.copy(_sun);
      u.uSun.value.copy(sunLight.color).multiplyScalar(sunLight.intensity * 0.36);
      u.uAmbient.value.copy(hemiLight.color).multiplyScalar(hemiLight.intensity * 0.9);
      u.uHaze.value.copy(fog.color);
      u.uHazeK.value = fog.density * HAZE_SCALE;
    },
    dispose() {
      disposed = true;
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      texture?.dispose();
    },
  };
}
