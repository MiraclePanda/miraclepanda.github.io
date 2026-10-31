// 実在の地形の遠景(実験。熱海サンビーチの描画品質「最高(実験)」で使う)。
//
// 国土地理院の標高タイルと写真タイル(計算は gsiTerrain.js)から、ライダーのまわり約20km四方の
// 山並み・海岸線・初島を1枚のメッシュにする。backdrops.js の富士山と同じく、空と一緒に回る遠景として
// ライダーに付いて動き(走っても位置は変わらない)、フォグは使わず自前のシェーダーで
// 光の色・強さと大気遠近(フォグ色へ溶かす)を走行環境から読む。
// - 海(標高データなし)とライダーのまわり innerRadiusM の内側は描かない(海は水面、近くは手続き生成の街と山)。
// - タイルは走行中にネットワークから読む。読めなければ(オフライン・CORS など)何も出さず、
//   手続き生成の山並みだけで走れる(onStatus で 'error' を知らせる)。
// - 地理院タイルの利用条件に従い、表示中は出典を画面に出す(LandscapeScene が GSI_ATTRIBUTION を表示する)。

import THREE from './three.js';
import {
  GSI_DEM_URL,
  GSI_PHOTO_URL,
  TILE_PX,
  tileUrl,
  tileRange,
  sampleDemGrid,
  gridEastNorth,
  enToScene,
} from './gsiTerrain.js';

// 大気遠近: backdrops.js と同じ考え方(フォグ密度 × 距離 × 係数)。実際のフォグより弱く
const HAZE_SCALE = 0.11;
const HAZE_MAX = 0.9;

async function loadBitmap(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return createImageBitmap(await res.blob());
}

/** 範囲のタイルを1枚のキャンバスに並べる。1枚でも読めなければ失敗(写真は欠けても続ける: allowMissing)。 */
async function loadMosaic(template, range, allowMissing) {
  const size = range.tiles * TILE_PX;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let j = 0; j < range.tiles; j++) {
    for (let i = 0; i < range.tiles; i++) {
      const url = tileUrl(template, range.z, range.x0 + i, range.y0 + j);
      jobs.push(
        loadBitmap(url).then(
          (bmp) => {
            ctx.drawImage(bmp, i * TILE_PX, j * TILE_PX);
            bmp.close?.();
          },
          (err) => {
            if (!allowMissing) throw err;
          }
        )
      );
    }
  }
  await Promise.all(jobs);
  return { canvas, ctx, size };
}

/** 標高格子から地形のジオメトリ(回転前のシーン座標、標高は海面 = 0)を作る。 */
export function buildTerrainGeometry(heights, gridN, en, bearingDeg) {
  const positions = new Float32Array(gridN * gridN * 3);
  const uvs = new Float32Array(gridN * gridN * 2);
  for (let k = 0; k < gridN * gridN; k++) {
    const p = enToScene(en.e[k], en.n[k], bearingDeg);
    positions[k * 3] = p.x;
    positions[k * 3 + 1] = heights[k];
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
      // 4隅とも海なら作らない
      if (heights[a] <= 0 && heights[b] <= 0 && heights[c] <= 0 && heights[d] <= 0) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  // 向き(進行方向の符号)によって三角形が裏返ることがあるので、法線は上向きにそろえる
  const nrm = g.getAttribute('normal');
  for (let k = 0; k < nrm.count; k++) {
    if (nrm.getY(k) < 0) nrm.setXYZ(k, -nrm.getX(k), -nrm.getY(k), -nrm.getZ(k));
  }
  return g;
}

function createMaterial(innerRadiusM) {
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
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vNormalW;
      varying vec2 vUv;
      void main() {
        vLocal = position;
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
      varying vec3 vLocal;
      varying vec3 vNormalW;
      varying vec2 vUv;
      void main() {
        float dist = length(vLocal.xz);
        // 海(標高 0 以下)と、手続き生成の街・山が描くライダーのまわり(山側。海側は沖へ 400 m より先なら
        // 本物の岬や島を見せる)は描かない。vLocal は回転前の座標で、−X が海側
        if (vLocal.y < 0.5 || dist < 400.0 || (dist < uInner && vLocal.x > -400.0)) discard;
        vec3 n = normalize(vNormalW);
        // 写真が無いときは標高で塗る(低い所は緑、高い所は茶色がかった灰色)
        vec3 byHeight = mix(vec3(0.16, 0.24, 0.13), vec3(0.3, 0.3, 0.26), smoothstep(150.0, 700.0, vLocal.y));
        vec3 albedo = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : byHeight;
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

const _sun = new THREE.Vector3();

/**
 * 実在の地形の遠景を作る(読み込みは load() で始める)。
 * @param {object} cfg gsiTerrain.js の ATAMI_REAL_TERRAIN の形
 * @param {object} [opts]
 * @param {(status: 'loading'|'ready'|'error', err?: Error) => void} [opts.onStatus]
 * @param {number} [opts.anisotropy]
 */
export function createRealTerrain(cfg, { onStatus, anisotropy = 4 } = {}) {
  const material = createMaterial(cfg.innerRadiusM);
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
          loadMosaic(GSI_DEM_URL, range, false),
          loadMosaic(GSI_PHOTO_URL, range, true).catch(() => null),
        ]);
        if (disposed) return;
        const rgba = dem.ctx.getImageData(0, 0, dem.size, dem.size).data;
        const heights = sampleDemGrid(rgba, dem.size, cfg.gridN);
        const en = gridEastNorth(range, cfg.gridN, cfg.origin);
        mesh.geometry.dispose();
        mesh.geometry = buildTerrainGeometry(heights, cfg.gridN, en, cfg.bearingDeg);
        if (photo) {
          texture = new THREE.CanvasTexture(photo.canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = anisotropy;
          material.uniforms.uMap.value = texture;
          material.uniforms.uHasMap.value = 1;
        }
        setStatus('ready');
      } catch (err) {
        if (!disposed) setStatus('error', err);
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
