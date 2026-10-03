// 走行環境(時間帯・天候)のプリセットと、景観ごとの「昼・晴れ」の値から
// 実際に使う空・光・霧・露出の値を求める純粋関数(Three.js 非依存。テスト対象)。
//
// 各シーン(CityScene / LandscapeScene / PondScene)は、今までの空・光・霧の値を
// baseAtmo として渡す。「昼・晴れ」では baseAtmo をそのまま返すので、
// 環境を選ばない(または昼・晴れを選んだ)ときの見た目は従来と1画素も変わらない。
// それ以外の時間帯は時間帯ごとの色(参考プロトタイプ ride-engine.js の TIMES を出発点)に
// 置き換え、光の強さ・霧の距離・露出は景観ごとの基準値に対する倍率で求める
// (景観ごとの明るさ・空気の澄み具合の違いを保つため)。天候はその上に灰色化・減光・霧を重ねる。
// 天候は見た目だけ(物理・トレーナーへの反映はしない)。

/**
 * baseAtmo(各シーンの「昼・晴れ」の値)の形:
 * @typedef {object} BaseAtmo
 * @property {string} zenith    空の天頂色 '#rrggbb'
 * @property {string} horizon   空の地平線色(フォグ色もこれ)
 * @property {string} ground    地平線より下の空の色
 * @property {string} sunColor  太陽光の色
 * @property {number[]} sunDir  太陽の方向 [x, y, z](正規化済み、y が上)
 * @property {number} sunIntensity  DirectionalLight の強さ
 * @property {number} hemiSky       HemisphereLight の空側の色 0xRRGGBB
 * @property {number} hemiGround    HemisphereLight の地面側の色 0xRRGGBB
 * @property {number} hemiIntensity HemisphereLight の強さ
 * @property {number} fogDensity    FogExp2 の密度
 * @property {number} exposure      renderer.toneMappingExposure
 */

// FogExp2 の「見通し距離」への換算係数。濃度 d·ρ = 2 で約98%が霧色になるので、
// 線形フォグの far に相当する距離を FOG_FAR_K / ρ とみなす。
export const FOG_FAR_K = 2;
// 霧で縮める見通し距離の下限(m)。これより短いと道路の先が見えず走りにくい。
export const MIN_FOG_FAR_M = 130;

/**
 * 時間帯。palette が null の noon は景観の基準値(baseAtmo)をそのまま使う。
 * - elevationDeg: 太陽(夜は月)の高度。方位は景観ごとの構図を保つため基準値のまま
 * - sunMul / hemiMul / exposureMul / fogMul: 基準値に対する倍率(fogMul は見通し距離の倍率)
 * - night: 夜度 0〜1(窓の明かり・ヘッドライト・星)
 * - cloud: 空に焼き込む雲の色(noon は従来の雲のまま)
 */
export const TIMES = {
  morning: {
    label: '朝',
    elevationDeg: 14, sunMul: 0.85, hemiMul: 0.9, exposureMul: 1.0, fogMul: 0.85, night: 0,
    palette: {
      zenith: '#4f86d0', horizon: '#f0d7bd', ground: '#9c958a', sunColor: '#ffd4a8',
      hemiSky: 0xc4d6f2, hemiGround: 0x5e5446, cloud: '#f4e2d0',
    },
  },
  noon: {
    label: '昼',
    elevationDeg: null, sunMul: 1, hemiMul: 1, exposureMul: 1, fogMul: 1, night: 0,
    palette: null,
  },
  sunset: {
    label: '夕方',
    elevationDeg: 7, sunMul: 0.75, hemiMul: 0.7, exposureMul: 1.08, fogMul: 0.8, night: 0.15,
    palette: {
      zenith: '#34427e', horizon: '#ff9a62', ground: '#6e5a58', sunColor: '#ff8a4a',
      hemiSky: 0xf2b49a, hemiGround: 0x3e3236, cloud: '#ffb27a',
    },
  },
  night: {
    label: '夜',
    elevationDeg: 38, sunMul: 0.12, hemiMul: 1.0, exposureMul: 1.4, fogMul: 0.56, night: 1,
    palette: {
      zenith: '#03060f', horizon: '#18213d', ground: '#0b0e15', sunColor: '#9fb4ff',
      hemiSky: 0x40528c, hemiGround: 0x1a1f28, cloud: '#2a3248',
    },
  },
};

/**
 * 天候。
 * - grey: 色の灰色化率(輝度へ寄せる割合)
 * - darken: 太陽以外の色に掛ける明るさ(雨の暗さ)
 * - sunMul / hemiMul: 光の強さの倍率
 * - cloudCover: 空に焼き込む雲量(0 = 従来の晴れの雲、1 = 一面の雲)
 * - fogMul: 見通し距離の倍率、maxFogFarM: 見通し距離の上限(m)
 * - rain: 雨粒の量 0〜1、wet: 路面の濡れ度 0〜1
 */
export const WEATHERS = {
  clear: { label: '晴れ', grey: 0, darken: 1, sunMul: 1, hemiMul: 1, cloudCover: 0, fogMul: 1, maxFogFarM: Infinity, rain: 0, wet: 0 },
  cloudy: { label: 'くもり', grey: 0.55, darken: 1, sunMul: 0.35, hemiMul: 1.15, cloudCover: 0.75, fogMul: 0.75, maxFogFarM: 3000, rain: 0, wet: 0 },
  rain: { label: '雨', grey: 0.75, darken: 0.72, sunMul: 0.15, hemiMul: 1.05, cloudCover: 1, fogMul: 0.5, maxFogFarM: 700, rain: 1, wet: 1 },
  fog: { label: '霧', grey: 0.6, darken: 1, sunMul: 0.25, hemiMul: 1.1, cloudCover: 0.85, fogMul: 0.3, maxFogFarM: MIN_FOG_FAR_M, rain: 0, wet: 0.4 },
};

export const TIME_IDS = Object.keys(TIMES);
export const WEATHER_IDS = Object.keys(WEATHERS);
export const DEFAULT_ENVIRONMENT = Object.freeze({ time: 'noon', weather: 'clear' });

/** 不正な値は既定(昼・晴れ)に丸めた { time, weather } を返す。 */
export function normalizeEnvironment(env) {
  const time = env && Object.hasOwn(TIMES, env.time) ? env.time : DEFAULT_ENVIRONMENT.time;
  const weather = env && Object.hasOwn(WEATHERS, env.weather) ? env.weather : DEFAULT_ENVIRONMENT.weather;
  return { time, weather };
}

// ---- 色の小道具('#rrggbb' 文字列と 0xRRGGBB 数値の両方を扱い、入力と同じ形で返す) ----

function toRgb(c) {
  const n = typeof c === 'string' ? parseInt(c.slice(1), 16) : c;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function fromRgb([r, g, b], like) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const n = (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
  return typeof like === 'string' ? `#${n.toString(16).padStart(6, '0')}` : n;
}

/** 灰色化(輝度へ寄せる)と減光。どちらも無変化なら元の値をそのまま返す(基準値と完全一致させるため)。 */
function weatherTint(c, grey, darken) {
  if (grey === 0 && darken === 1) return c;
  const [r, g, b] = toRgb(c);
  const l = r * 0.3 + g * 0.55 + b * 0.15;
  return fromRgb([r, g, b].map((v) => (v + (l - v) * grey) * darken), c);
}

/** 方位(水平成分の向き)を保ったまま高度だけ変えた太陽の方向。 */
function withElevation(dir, elevationDeg) {
  const [x, , z] = dir;
  const horiz = Math.hypot(x, z) || 1;
  const e = (elevationDeg * Math.PI) / 180;
  const c = Math.cos(e);
  return [(x / horiz) * c, Math.sin(e), (z / horiz) * c];
}

/**
 * 時間帯・天候から実際に使う値を求める。
 * 返り値は baseAtmo と同じキー(同じ形)に、以下を加えたもの:
 * - night: 夜度 0〜1、rain: 雨量 0〜1、wet: 路面の濡れ度 0〜1
 * - cloudCover: 空に焼き込む雲量 0〜1、cloud: 雲の色(cloudCover > 0 のときだけ使う)
 * - sunGlow: 空に焼き込む太陽の輝きの倍率(1 = 従来どおり)
 * - fogFarM: FogExp2 の濃度を見通し距離へ換算した値(≥ MIN_FOG_FAR_M)
 * 「昼・晴れ」では baseAtmo のキーはすべて baseAtmo と同じ値になる。
 * @param {BaseAtmo} baseAtmo
 * @param {string} timeId 'morning' | 'noon' | 'sunset' | 'night'
 * @param {string} weatherId 'clear' | 'cloudy' | 'rain' | 'fog'
 */
export function resolveEnvironment(baseAtmo, timeId, weatherId) {
  const t = TIMES[timeId] ?? TIMES.noon;
  const w = WEATHERS[weatherId] ?? WEATHERS.clear;
  const p = t.palette;
  const pick = (key) => (p ? p[key] : baseAtmo[key]);
  const { grey, darken } = w;

  // 見通し距離: 基準の濃度を時間帯・天候の倍率で濃くし、天候の上限と全体の下限で丸める。
  // 倍率がすべて1(昼・晴れ)なら濃度は基準値のまま(x / 1 === x)。
  let fogDensity = baseAtmo.fogDensity / (t.fogMul * w.fogMul);
  let fogFarM = FOG_FAR_K / fogDensity;
  if (fogFarM > w.maxFogFarM) {
    fogFarM = w.maxFogFarM;
    fogDensity = FOG_FAR_K / fogFarM;
  }
  if (fogFarM < MIN_FOG_FAR_M) {
    fogFarM = MIN_FOG_FAR_M;
    fogDensity = FOG_FAR_K / fogFarM;
  }

  return {
    ...baseAtmo,
    zenith: weatherTint(pick('zenith'), grey, darken),
    horizon: weatherTint(pick('horizon'), grey, darken),
    ground: weatherTint(pick('ground'), grey, darken),
    // 太陽の色は灰色化だけ(雨でも光の色そのものは暗くせず、強さで弱める)
    sunColor: weatherTint(pick('sunColor'), grey, 1),
    sunDir: t.elevationDeg === null ? baseAtmo.sunDir : withElevation(baseAtmo.sunDir, t.elevationDeg),
    sunIntensity: baseAtmo.sunIntensity * t.sunMul * w.sunMul,
    hemiSky: weatherTint(pick('hemiSky'), grey, darken),
    hemiGround: weatherTint(pick('hemiGround'), grey, darken),
    hemiIntensity: baseAtmo.hemiIntensity * t.hemiMul * w.hemiMul,
    fogDensity,
    exposure: baseAtmo.exposure * t.exposureMul,
    night: t.night,
    rain: w.rain,
    wet: w.wet,
    cloudCover: w.cloudCover,
    cloud: weatherTint(p ? p.cloud : '#ffffff', grey, darken),
    sunGlow: w.sunMul * (1 - t.night * 0.85),
    fogFarM,
  };
}

/** 空の焼き直しが必要な値(空の見た目を決める値)が同じかどうか。 */
export function sameSky(a, b) {
  return a.zenith === b.zenith && a.horizon === b.horizon && a.ground === b.ground && a.sunColor === b.sunColor
    && a.sunDir[0] === b.sunDir[0] && a.sunDir[1] === b.sunDir[1] && a.sunDir[2] === b.sunDir[2]
    && a.cloudCover === b.cloudCover && a.cloud === b.cloud && a.sunGlow === b.sunGlow && a.night === b.night;
}
