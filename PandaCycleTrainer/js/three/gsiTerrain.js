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

// 熱海サンビーチ(実験の「最高」画質で使う)。基準点は親水公園の前あたりの海岸通り。
// 走る向きは海岸線に沿って南南西(左手が相模湾 = 景色の海側 d < 0 と同じ)。
// 範囲は西の山並み(岩戸山・十国峠)から沖の初島まで入るよう、中心を東南東へずらす。
export const ATAMI_REAL_TERRAIN = {
  origin: { lon: 139.0768, lat: 35.0962 },
  bearingDeg: 200,
  z: 13,
  tiles: 5,
  offsetEM: 1500,
  offsetNM: -1500,
  gridN: 200,
  // ライダーのまわりは手続き生成の街・山(〜2.3km)が描くので、実地形はこれより外だけ見せる
  innerRadiusM: 1900,
};
