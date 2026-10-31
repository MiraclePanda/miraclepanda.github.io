// 国土地理院の地図タイル(標高タイル dem_png・写真 seamlessphoto)から、実在の地形の遠景を作るための
// 純粋な計算(Three.js・DOM に依存しない。test/unit から読める)。描画と読み込みは realTerrain.js。
//
// 使うタイル(出典: 国土地理院。画面に出典を表示すること):
// - 標高 PNG: https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png(z ≤ 14)
//   画素の (R, G, B) から x = R·2^16 + G·2^8 + B。x < 2^23 なら x·0.01 m、x > 2^23 なら (x − 2^24)·0.01 m、
//   x = 2^23 は無効値(海など、データなし)。
// - 写真: https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg
//
// 座標の約束: 基準点(ライダーのいる実在の場所)からの東・北の距離 (e, n) [m] を、
// 回転前のシーン座標(進行方向 −Z、左 −X)へ、走る向きの方位 bearingDeg(北から時計回り)で写す。

export const GSI_DEM_URL = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
export const GSI_PHOTO_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
export const GSI_ATTRIBUTION = '地形・写真: 国土地理院(地理院タイル)';
export const TILE_PX = 256;
const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** タイルの URL。 */
export function tileUrl(template, z, x, y) {
  return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** 経度・緯度 → ズーム z のタイル座標(小数。整数部がタイル番号、小数部がタイル内の位置)。 */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  };
}

/** タイル座標(小数) → 経度・緯度。 */
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}

/** 緯度 lat でのタイル1枚の幅(m)。 */
export function tileSizeM(lat, z) {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/**
 * 基準点 (lon, lat) のまわりを覆うタイルの範囲。中心を (offsetEM, offsetNM) だけずらし、
 * 一辺 tiles 枚の正方形にする。
 * @returns {{ z, x0, y0, tiles }} 左上のタイル番号と枚数
 */
export function tileRange({ lon, lat, z, tiles, offsetEM = 0, offsetNM = 0 }) {
  const size = tileSizeM(lat, z);
  const c = lonLatToTile(lon, lat, z);
  const cx = c.x + offsetEM / size;
  const cy = c.y - offsetNM / size;
  return { z, x0: Math.floor(cx - tiles / 2 + 0.5), y0: Math.floor(cy - tiles / 2 + 0.5), tiles };
}

/** 標高 PNG の1画素 → 標高(m)。無効値は null。 */
export function decodeDemPixel(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  return (x < 8388608 ? x : x - 16777216) * 0.01;
}

/**
 * 並べたタイルの RGBA 画素(一辺 tiles·256 px)を、一辺 gridN 点の標高格子へ間引く(各点のまわりの平均)。
 * 無効値(海)は seaM(既定 −5 m。描画で捨てる)にする。
 * @param {Uint8ClampedArray|Uint8Array} rgba 一辺 sizePx の RGBA
 * @returns {Float32Array} gridN × gridN、行は北から南、列は西から東
 */
export function sampleDemGrid(rgba, sizePx, gridN, seaM = -5) {
  const out = new Float32Array(gridN * gridN);
  const step = sizePx / gridN;
  const half = Math.max(1, Math.floor(step / 2));
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const cx = Math.min(sizePx - 1, Math.floor((i + 0.5) * step));
      const cy = Math.min(sizePx - 1, Math.floor((j + 0.5) * step));
      let sum = 0;
      let count = 0;
      let invalid = 0;
      for (let dy = -half; dy < half; dy += Math.max(1, half >> 1)) {
        for (let dx = -half; dx < half; dx += Math.max(1, half >> 1)) {
          const px = Math.min(sizePx - 1, Math.max(0, cx + dx));
          const py = Math.min(sizePx - 1, Math.max(0, cy + dy));
          const k = (py * sizePx + px) * 4;
          const h = decodeDemPixel(rgba[k], rgba[k + 1], rgba[k + 2]);
          if (h === null) invalid++;
          else {
            sum += h;
            count++;
          }
        }
      }
      // 半分以上が海なら海(海岸線が陸側へ膨らまないように)
      out[j * gridN + i] = count > invalid ? sum / count : seaM;
    }
  }
  return out;
}

/**
 * 東・北の距離 (e, n) → 回転前のシーン座標 (x, z)。走る向き(方位 bearingDeg)が −Z、その左が −X。
 */
export function enToScene(e, n, bearingDeg) {
  const b = (bearingDeg * Math.PI) / 180;
  const fe = Math.sin(b);
  const fn = Math.cos(b);
  // 左 = 進行方向を反時計回りに90°
  const le = -fn;
  const ln = fe;
  return { x: -(e * le + n * ln), z: -(e * fe + n * fn) };
}

/**
 * 標高格子の各点の、基準点からの東・北の距離(m)。タイルの範囲と基準点から求める。
 * @returns {{ e: Float32Array, n: Float32Array }}
 */
export function gridEastNorth(range, gridN, origin) {
  const { z, x0, y0, tiles } = range;
  const o = lonLatToTile(origin.lon, origin.lat, z);
  const size = tileSizeM(origin.lat, z); // 範囲が数十kmなので緯度による縮みは基準点の値で近似する
  const e = new Float32Array(gridN * gridN);
  const n = new Float32Array(gridN * gridN);
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const tx = x0 + ((i + 0.5) / gridN) * tiles;
      const ty = y0 + ((j + 0.5) / gridN) * tiles;
      e[j * gridN + i] = (tx - o.x) * size;
      n[j * gridN + i] = -(ty - o.y) * size;
    }
  }
  return { e, n };
}

/**
 * 標高格子の中で基準点(e = n = 0)に一番近い点の標高。無効値(海)なら null。
 */
export function heightNearOrigin(heights, en, seaM = -5) {
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < heights.length; k++) {
    const d = en.e[k] * en.e[k] + en.n[k] * en.n[k];
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best < 0 || heights[best] === seaM ? null : heights[best];
}

/**
 * 標高格子 → 描く高さ(シーンの基準面からの m)と、描くかどうか。
 * cfg.anchor:
 * - 'sea'    : 基準面 = 海面(熱海)。海(無効値)は描かない。
 * - 'water'  : 基準面 = 湖面 cfg.waterLevelM(河口湖)。湖面と同じ高さの平らな所(湖)は描かず、
 *              湖面より低い土地は湖面の少し上に抑える(シーンの水面の下に沈めない)。
 * - 'origin' : 基準面 = 基準点(ライダーのいる道路)の標高(京都・奈良。盆地の中なので海も湖も無い)。
 * @returns {{ y: Float32Array, visible: Uint8Array, baseM: number }}
 */
export function terrainHeights(heights, cfg, originM, seaM = -5) {
  const n = heights.length;
  const y = new Float32Array(n);
  const visible = new Uint8Array(n);
  const anchor = cfg.anchor ?? 'sea';
  const baseM = anchor === 'water' ? cfg.waterLevelM : anchor === 'origin' ? (originM ?? 0) : 0;
  for (let k = 0; k < n; k++) {
    const h = heights[k];
    if (h === seaM) continue; // 海・データなし
    if (anchor === 'sea') {
      if (h <= 0) continue;
      y[k] = h;
    } else if (anchor === 'water') {
      if (Math.abs(h - baseM) < (cfg.waterToleranceM ?? 1.5)) continue; // 湖面
      y[k] = Math.max(h - baseM, 1);
    } else {
      y[k] = h - baseM;
    }
    visible[k] = 1;
  }
  return { y, visible, baseM };
}

// コースごとの実在の地形(景色の id → 設定)。描画品質「最高(実験)」で、実在の場所をモデルにした
// コースだけが持つ(平坦・丘陵・山岳は架空のコース、上野は平らな都心、竜宮城は海の底なので無し)。
// bearingDeg は走る向きの方位で、景色の「山側・水側」と実際の地形の向きをそろえる:
// 熱海・河口湖は左手が水(海・湖)、京都・奈良は右手(東)が山。
// innerRadiusM の内側は手続き生成の景色が描くので実地形は描かない(地形の列は路肩から約3.5kmまで)。
// openSideX: 回転前の X がこれより小さい側(水側)では、innerRadiusM の内側でも 400 m より先なら描く。
export const REAL_TERRAIN = {
  // 熱海サンビーチ。基準点は親水公園の前あたりの海岸通り。海岸線に沿って南南西へ走る(左手が相模湾)。
  // 範囲は西の山並み(岩戸山・十国峠)から沖の初島まで入るよう、中心を東南東へずらす。
  atami: {
    origin: { lon: 139.0768, lat: 35.0962 },
    bearingDeg: 200,
    anchor: 'sea',
    z: 13,
    tiles: 5,
    offsetEM: 1500,
    offsetNM: -1500,
    gridN: 200,
    innerRadiusM: 1900,
    openSideX: -400,
    hideIslands: true,
  },
  // 河口湖の北岸(大石公園のあたり)。湖を左手に西へ走ると、左手(南)の湖の向こうに本物の富士山(約18km)。
  // 富士山まで入るよう z12(1枚約8km)で、中心を南へずらす。本物の富士山が出たら手続き生成の富士山は隠す。
  kawaguchiko: {
    origin: { lon: 138.7400, lat: 35.5225 },
    bearingDeg: 270,
    anchor: 'water',
    waterLevelM: 831,
    z: 12,
    tiles: 5,
    offsetEM: 0,
    offsetNM: -9000,
    gridN: 240,
    innerRadiusM: 2400,
    openSideX: -400,
    hideBackdrop: true,
  },
  // 京都・東山(清水寺の下あたり)。東山を右手に北へ走る。比叡山・大文字山・西山・北山が盆地を囲む。
  kyoto: {
    origin: { lon: 135.7790, lat: 34.9975 },
    bearingDeg: 0,
    anchor: 'origin',
    z: 12,
    tiles: 5,
    offsetEM: -2000,
    offsetNM: 2000,
    gridN: 240,
    innerRadiusM: 3600,
  },
  // 奈良公園(東大寺の南のあたり)。若草山・春日山を右手に北へ走る。西の生駒山まで入れる。
  nara: {
    origin: { lon: 135.8400, lat: 34.6860 },
    bearingDeg: 0,
    anchor: 'origin',
    z: 12,
    tiles: 5,
    offsetEM: -5000,
    offsetNM: 0,
    gridN: 240,
    innerRadiusM: 3600,
  },
};

/** 熱海の設定(以前の名前。テストなどから使う)。 */
export const ATAMI_REAL_TERRAIN = REAL_TERRAIN.atami;
