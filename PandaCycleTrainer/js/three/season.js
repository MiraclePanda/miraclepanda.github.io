// 景色の季節: 走る日の実際の日付(端末の暦)・コースの場所(緯度・経度・標高)から、木の色・桜・紅葉・
// 山の雪・空の澄み具合・昼の太陽の高さを決める。見た目だけに使う(物理・トレーナーへの指示には入れない)。
// Three.js に依存しない純粋な計算(test/unit から読める)。色への直し方は seasonLook.js。
//
// 季節は設定で選ぶものではなく、いつも走る日の暦どおり(同じコースでも、春に走れば桜、秋に走れば紅葉)。
// 同じ日でも、桜は南から北へ・山の下から上へ、紅葉は北から南へ・山の上から下へ進む
// (気象庁の桜・かえでの平年値をおおまかに直線で近づけたもの。北緯 35 度・標高 0 m を基準にする)。

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

/**
 * コースの場所(景色ごと)。実在の街(熱海・京都・奈良・河口湖・上野)は実際の場所、作り物の景色は
 * それらしい場所(街並み = 東京、湖畔・山岳 = 箱根・富士五湖あたりの高さ)。elevM はスタート地点の標高で、
 * 景色の中の高さ(スタート = 0 m の相対の高さ)に足して植物・雪の標高にする。
 * 熱海と実在の街の地形は最初から標高(m)なので elevM = 0。siteElevM はスタート地点の実際の標高で、
 * 画面に出す季節の名前だけに使う(河口湖は湖畔で約 840 m なので、低地より紅葉が早い)。
 */
export const COURSE_GEO = {
  city: { latDeg: 35.68, lonDeg: 139.76, elevM: 20 },
  lakeside: { latDeg: 35.35, lonDeg: 138.95, elevM: 450 },
  mountain: { latDeg: 35.4, lonDeg: 138.7, elevM: 700 },
  ueno: { latDeg: 35.712, lonDeg: 139.77, elevM: 5 },
  atami: { latDeg: 35.1, lonDeg: 139.07, elevM: 0, siteElevM: 5 },
  kyoto: { latDeg: 35.0, lonDeg: 135.78, elevM: 0, siteElevM: 60 },
  nara: { latDeg: 34.685, lonDeg: 135.84, elevM: 0, siteElevM: 100 },
  kawaguchiko: { latDeg: 35.51, lonDeg: 138.76, elevM: 0, siteElevM: 840 },
};
const DEFAULT_GEO = COURSE_GEO.city;

/**
 * コースの場所。GPX から作った実在コースは profile.geo(スタート地点の緯度・経度・標高)を使う。
 * 竜宮城(海の底)は季節が無いので null。
 */
export function courseGeo(profile) {
  if (!profile || profile.scenery === 'ryugu') return null;
  const g = profile.geo;
  if (g && Number.isFinite(g.latDeg) && Number.isFinite(g.lonDeg)) {
    return { latDeg: g.latDeg, lonDeg: g.lonDeg, elevM: Number.isFinite(g.elevM) ? g.elevM : 0 };
  }
  return COURSE_GEO[profile.scenery] ?? DEFAULT_GEO;
}

/** 日付の年内の通し日(1月1日 = 1)。端末の暦(ローカルの日付)で数える。 */
export function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((now - start) / 86400000) + 1;
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

/** 太陽の赤緯(度)。 */
export function sunDeclinationDeg(doy) {
  return 23.44 * Math.sin(((2 * Math.PI) / 365) * (doy + 284));
}

/** 南中したときの太陽の高さ(度)。北緯 35 度で冬至は約 31 度、夏至は約 78 度。 */
export function noonSunElevationDeg(doy, latDeg) {
  return 90 - Math.abs(latDeg - sunDeclinationDeg(doy));
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

/** 季節の名前に添える絵文字。 */
export function seasonEmoji(name) {
  return { 桜のころ: '🌸', 紅葉のころ: '🍁', 新緑のころ: '🌱', 梅雨のころ: '☔', 夏: '🌻', 秋: '🌾', 冬: '⛄', 冬の終わり: '⛄', 春: '🌷' }[name] ?? '';
}

/**
 * 1回の走行の景色の季節(走行中は日付が変わらないので、走り始めに1回作る)。
 * @param {{now?:Date, latDeg:number, lonDeg:number, elevM?:number, siteElevM?:number}} o
 *   elevM: 景色の高さ 0 m の所の標高(plants・snowAt に渡す高さに足す)。siteElevM: 季節の名前を決める標高(省略時 elevM)
 */
export function createSeason({ now = new Date(), latDeg, lonDeg, elevM = 0, siteElevM = elevM }) {
  const doy = dayOfYear(now);
  const cache = new Map();
  const name = seasonName(doy, latDeg, siteElevM);
  const line = snowLineM(doy, latDeg);
  return {
    doy, latDeg, lonDeg, elevM,
    month: now.getMonth() + 1,
    day: now.getDate(),
    snowLineM: line,
    sky: skyMood(doy),
    noonSunElevDeg: noonSunElevationDeg(doy, latDeg),
    name,
    emoji: seasonEmoji(name),
    /** 景色の中の高さ h(m。elevM を足す前)の植物の様子(標高 20 m 刻みでまとめて計算)。 */
    plants(h = 0) {
      const k = Math.round(Math.max(h + elevM, 0) / 20);
      if (!cache.has(k)) cache.set(k, plantPhase(doy, latDeg, k * 20));
      return cache.get(k);
    },
    /** 景色の中の高さ h の雪の積もり具合(0..1): 雪線から 150 m 上で真っ白。 */
    snowAt(h) {
      return Number.isFinite(line) ? clamp01((h + elevM - line) / 150) : 0;
    },
  };
}

/**
 * コースの走行日の季節。日付は端末の暦(テスト・確認用に URL の ?date=YYYY-MM-DD で変えられる)。
 * 竜宮城(海の底)は季節が無いので null。
 */
export function createCourseSeason(profile, now = new Date()) {
  const geo = courseGeo(profile);
  return geo ? createSeason({ now, ...geo }) : null;
}

/** URL の ?date=YYYY-MM-DD(テスト・画面確認用)。無い・不正なら null。 */
export function parseSeasonDate(search) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(new URLSearchParams(search ?? '').get('date') ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 ? null : d;
}
