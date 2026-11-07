// 景色の季節: 日付・緯度・標高から、木の色・桜・紅葉・山の雪・日の出と日の入り・空の澄み具合を決める。
// 見た目だけに使う(物理・トレーナーへの指示・旅の判断には入れない)。Three.js に依存しない純粋な計算。
//
// 季節は既定で実際の今日の日付(何ヶ月も乗り続けると、現実と同じ速さで景色が変わる)。設定で春夏秋冬の
// どれかに固定もできる。同じ日でも、桜は南から北へ・山の下から上へ、紅葉は北から南へ・山の上から下へ進む
// (気象庁の桜・かえでの平年値をおおまかに直線で近づけたもの。北緯 35 度・標高 0 m を基準にする)。

export const SEASON_MODES = ['auto', 'spring', 'summer', 'autumn', 'winter'];
export const SEASON_LABELS = { auto: '実際の今日の日付', spring: '春(桜のころ)', summer: '夏', autumn: '秋(紅葉のころ)', winter: '冬' };
// 季節を固定したときに使う日(北緯 35 度の低地で、その季節らしい日)
const FIXED_DOY = { spring: 89, summer: 213, autumn: 325, winter: 20 };

const SAKURA_DOY = 88; // 桜の満開(北緯 35 度・低地)。3月末
const SAKURA_DAYS_PER_LAT = 4.5; // 北へ 1 度で 4.5 日遅れる(札幌はおよそ5月初め)
const SAKURA_DAYS_PER_100M = 2.5;
const MOMIJI_DOY = 330; // 紅葉の見ごろ(北緯 35 度・低地)。11月下旬
const MOMIJI_DAYS_PER_LAT = -3.8; // 北へ 1 度で 3.8 日早まる
const MOMIJI_DAYS_PER_100M = -2.5;
const LEAF_OUT_AFTER_SAKURA = 12; // 桜の満開から芽吹きまで
const FRESH_DAYS = 45; // 新緑の明るい緑が続く日数
const TURN_DAYS = 28; // 色づき始めから見ごろまで
const FALL_DAYS = 18; // 見ごろから葉が落ちきるまで

/** 季節の設定を SEASON_MODES のどれかにそろえる(無い・不正なら 'auto')。 */
export function normalizeSeasonMode(x) {
  return SEASON_MODES.includes(x) ? x : 'auto';
}

/** 日付の年内の通し日(1月1日 = 1)。 */
export function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((now - start) / 86400000) + 1;
}

/** 景色に使う通し日。'auto' は実際の日付、それ以外は季節ごとの代表の日。 */
export function seasonDayOfYear(mode, now = new Date()) {
  const m = normalizeSeasonMode(mode);
  return m === 'auto' ? dayOfYear(now) : FIXED_DOY[m];
}

const wrap = (d) => ((d % 365) + 365) % 365; // 0..365 に巻く
/** d が基準日から何日後か(-182..182 に巻く)。 */
const since = (d, ref) => wrap(d - ref + 182) - 182;
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);

/**
 * その日・その場所の植物の様子。
 * @returns {{sakura:number, fresh:number, turn:number, bare:number}}
 *   sakura: 桜の花(0..1、満開で 1)。fresh: 新緑の明るさ(0..1)。turn: 紅葉(0..1、見ごろで 1)。
 *   bare: 落葉樹の葉の落ち具合(0..1、冬で 1)
 */
export function plantPhase(doy, latDeg, elevM = 0) {
  const e = Math.max(elevM, 0) / 100;
  const sakura = SAKURA_DOY + (latDeg - 35) * SAKURA_DAYS_PER_LAT + e * SAKURA_DAYS_PER_100M;
  const momiji = MOMIJI_DOY + (latDeg - 35) * MOMIJI_DAYS_PER_LAT + e * MOMIJI_DAYS_PER_100M;
  const s = since(doy, sakura);
  const leafOut = s - LEAF_OUT_AFTER_SAKURA;
  const m = since(doy, momiji);
  // 葉が出る前(桜の前後)と、紅葉が終わった後は裸の枝。芽吹きは 10 日、落葉は FALL_DAYS かけて
  let bare;
  if (m >= 0 && m < FALL_DAYS) bare = m / FALL_DAYS;
  else if (leafOut >= 0 && leafOut < 10) bare = 1 - leafOut / 10;
  else bare = since(doy, momiji + FALL_DAYS) >= 0 && since(doy, sakura + LEAF_OUT_AFTER_SAKURA) < 0 ? 1 : 0;
  return {
    sakura: clamp01(1 - Math.abs(s) / 7), // 満開の前後1週間
    fresh: leafOut >= 0 && leafOut < FRESH_DAYS + 20 ? clamp01(Math.min(leafOut / 6, (FRESH_DAYS + 20 - leafOut) / 20)) : 0,
    turn: m < 0 ? clamp01(1 + m / TURN_DAYS) : clamp01(1 - m / (FALL_DAYS * 1.4)),
    bare: clamp01(bare),
  };
}

/** 雪が積もっている標高(m)。北緯 35 度で1月下旬に 1500 m ほど、夏は無し(Infinity)。 */
export function snowLineM(doy, latDeg) {
  // 富士山の冠雪のおおまかな下限(月の中ごろの値。間は直線でつなぐ)
  const LINE = [1500, 1400, 1700, 2200, 2800, 3500, 4200, 4200, 4000, 3500, 2700, 1900];
  const f = (wrap(doy - 15) / 365) * 12;
  const i = Math.floor(f) % 12;
  const v = LINE[i] + (LINE[(i + 1) % 12] - LINE[i]) * (f - Math.floor(f));
  const line = v - (latDeg - 35) * 160;
  return line > 3800 ? Infinity : Math.max(line, 0);
}

/**
 * 太陽の高さと方角(度)。方角は北から時計回り。時刻は日本標準時(旅の時刻)。
 * @returns {{elevDeg:number, azDeg:number}}
 */
export function sunPosition(doy, latDeg, lonDeg, clockMinutes) {
  const rad = Math.PI / 180;
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (doy + 284));
  const noon = 12 * 60 - (lonDeg - 135) * 4; // 南中の時刻(分)
  const ha = ((clockMinutes - noon) / 60) * 15;
  const lat = latDeg * rad;
  const d = decl * rad;
  const sinE = Math.sin(lat) * Math.sin(d) + Math.cos(lat) * Math.cos(d) * Math.cos(ha * rad);
  const e = Math.asin(Math.min(Math.max(sinE, -1), 1));
  const cosAz = (Math.sin(d) - Math.sin(e) * Math.sin(lat)) / (Math.cos(e) * Math.cos(lat) || 1e-9);
  let az = Math.acos(Math.min(Math.max(cosAz, -1), 1)) / rad;
  if (ha > 0) az = 360 - az;
  return { elevDeg: e / rad, azDeg: az };
}

/** 日の出・日の入りの時刻(分、日本標準時)。太陽の上の縁が地平線に掛かる時(大気の屈折を含めて -0.833 度)。 */
export function sunTimes(doy, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const decl = 23.44 * Math.sin(((2 * Math.PI) / 365) * (doy + 284)) * rad;
  const lat = latDeg * rad;
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
  const halfMin = (Math.acos(Math.min(Math.max(cosH, -1), 1)) * (180 / Math.PI)) * 4;
  const noon = 12 * 60 - (lonDeg - 135) * 4;
  return { sunrise: noon - halfMin, sunset: noon + halfMin };
}

/** 季節の名前(画面の表示用)。 */
export function seasonName(doy, latDeg, elevM = 0) {
  const p = plantPhase(doy, latDeg, elevM);
  if (p.sakura > 0.3) return '桜のころ';
  if (p.turn > 0.5) return '紅葉のころ';
  if (p.fresh > 0.5) return '新緑のころ';
  const d = wrap(doy);
  if (p.bare > 0.5) return d >= 45 && d < 80 ? '冬の終わり' : d >= 80 && d < 182 ? '春' : '冬';
  if (d >= 152 && d < 196) return '梅雨のころ';
  if (d >= 196 && d < 258) return '夏';
  return d < 182 ? '春' : '秋';
}

/** 空の様子: 霞の濃さの倍率(冬は澄み、春は霞み、夏は湿気で白っぽい)と、空・地平の色の寄せ方。 */
export function skyMood(doy) {
  const d = wrap(doy);
  // 季節ごとの値を月の中ごろに置いて直線でつなぐ
  const HAZE = [0.55, 0.6, 0.9, 1.3, 1.3, 1.4, 1.6, 1.6, 1.3, 0.9, 0.75, 0.6];
  const f = (wrap(d - 15) / 365) * 12;
  const i = Math.floor(f) % 12;
  const haze = HAZE[i] + (HAZE[(i + 1) % 12] - HAZE[i]) * (f - Math.floor(f));
  return { haze, clear: clamp01((1 - haze) / 0.45), humid: clamp01((haze - 1) / 0.6) };
}

/**
 * 1回の走行の景色の季節(走行中は日付が変わらないので、走り始めに1回作る)。
 * @param {{mode?:string, now?:Date, latDeg:number, lonDeg:number}} o
 */
export function createSeason({ mode = 'auto', now = new Date(), latDeg, lonDeg }) {
  const doy = seasonDayOfYear(mode, now);
  const cache = new Map();
  return {
    doy, latDeg, lonDeg,
    snowLineM: snowLineM(doy, latDeg),
    sky: skyMood(doy),
    /** 標高 elevM の植物の様子(20 m 刻みでまとめて計算)。 */
    plants(elevM) {
      const k = Math.round(Math.max(elevM, 0) / 20);
      if (!cache.has(k)) cache.set(k, plantPhase(doy, latDeg, k * 20));
      return cache.get(k);
    },
    sunAt: (clockMinutes) => sunPosition(doy, latDeg, lonDeg, clockMinutes),
    ...sunTimes(doy, latDeg, lonDeg),
    name: seasonName(doy, latDeg),
  };
}
