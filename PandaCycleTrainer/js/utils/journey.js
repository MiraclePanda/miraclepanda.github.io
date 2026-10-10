// バーチャル日本縦断: これまでの走行距離の合計で、宗谷岬から佐多岬まで日本列島を進む(すごろく)。
// 走行記録(IndexedDB)の totalDistanceM の合計を使う(デモ走行は記録しないので数えない)。
// 佐多岬に着いたら宗谷岬から2周目。距離は国道沿いのおおよその道のり(km)で、
// 津軽海峡はフェリー分も漕いだことにしている(パロディなので)。
// lat/lon はセットアップ画面の小さな地図に点を打つためだけに使う(走行記録・TCX には入れない)。

/** 経由地。km = 宗谷岬からの累計距離。note は通過したときのひとこと。 */
export const JOURNEY_CITIES = [
  { name: '宗谷岬', km: 0, lat: 45.523, lon: 141.937, note: '日本最北端からスタート。ここから佐多岬を目指します。' },
  { name: '稚内', km: 30, lat: 45.415, lon: 141.673, note: '最北の駅で記念撮影(したつもり)。' },
  { name: '旭川', km: 280, lat: 43.771, lon: 142.365, note: '旭川ラーメンの醤油の香りがしてきました。' },
  { name: '札幌', km: 420, lat: 43.062, lon: 141.354, note: '時計台は思ったより小さいそうです。' },
  { name: '函館', km: 670, lat: 41.769, lon: 140.729, note: '夜景はまた今度。イカ刺しで手を打ちましょう。' },
  { name: '青森', km: 790, lat: 40.822, lon: 140.747, note: '津軽海峡はフェリー分も漕いだことにしました。' },
  { name: '盛岡', km: 970, lat: 39.702, lon: 141.154, note: 'わんこそばは何杯いけますか。' },
  { name: '仙台', km: 1155, lat: 38.268, lon: 140.872, note: '牛タンの誘惑を振り切って先へ。' },
  { name: '福島', km: 1235, lat: 37.760, lon: 140.474, note: '桃の季節に通りたいところです。' },
  { name: '宇都宮', km: 1395, lat: 36.555, lon: 139.883, note: '餃子は何個まで消費カロリーで帳消しになるでしょう。' },
  { name: '東京', km: 1505, lat: 35.684, lon: 139.774, note: '日本橋に到着。ここから東海道を西へ。' },
  { name: '横浜', km: 1535, lat: 35.444, lon: 139.638, note: '中華街の肉まんが呼んでいます。' },
  { name: '小田原', km: 1585, lat: 35.256, lon: 139.159, note: 'この先は箱根の山。気合いを入れましょう(勾配は変わりません)。' },
  { name: '静岡', km: 1690, lat: 34.975, lon: 138.383, note: 'お茶でひと息。富士山は見えましたか。' },
  { name: '浜松', km: 1770, lat: 34.711, lon: 137.726, note: 'うなぎパイは夜のお菓子だそうです。' },
  { name: '名古屋', km: 1875, lat: 35.170, lon: 136.882, note: '味噌カツの濃さに負けないペダリングを。' },
  { name: '京都', km: 2015, lat: 35.011, lon: 135.768, note: '三条大橋で東海道五十三次を完走しました。' },
  { name: '大阪', km: 2065, lat: 34.694, lon: 135.502, note: 'たこ焼きは消費カロリーの範囲でどうぞ。' },
  { name: '神戸', km: 2095, lat: 34.690, lon: 135.196, note: '港町の坂道を華麗に駆け抜けました(平地です)。' },
  { name: '岡山', km: 2245, lat: 34.655, lon: 133.919, note: '桃太郎が並走したそうにしています。' },
  { name: '広島', km: 2410, lat: 34.385, lon: 132.455, note: 'お好み焼きは広島風で。' },
  { name: '下関', km: 2610, lat: 33.958, lon: 130.941, note: '関門海峡を越えて九州へ。ふくをいただきましょう。' },
  { name: '福岡', km: 2690, lat: 33.590, lon: 130.402, note: 'とんこつラーメン、替え玉は1回まで。' },
  { name: '熊本', km: 2805, lat: 32.803, lon: 130.708, note: '熊本城を眺めてひと休み。' },
  { name: '鹿児島', km: 2980, lat: 31.597, lon: 130.557, note: '桜島が噴煙でお出迎え。ゴールはもうすぐです。' },
  { name: '佐多岬', km: 3070, lat: 30.994, lon: 130.661, note: '本土最南端に到着！ 日本縦断達成です。' },
];

export const JOURNEY_TOTAL_KM = JOURNEY_CITIES[JOURNEY_CITIES.length - 1].km;

/** 走行記録の一覧から、日本縦断に数える合計距離(km)。 */
export function journeyTotalKm(rides) {
  if (!Array.isArray(rides)) return 0;
  let m = 0;
  for (const r of rides) {
    const d = Number(r?.totalDistanceM);
    if (Number.isFinite(d) && d > 0) m += d;
  }
  return m / 1000;
}

/**
 * 合計距離(km)から現在地を求める。
 * @returns {{lap:number, kmInLap:number, from:object, to:object, legFraction:number, kmToNext:number,
 *   lat:number, lon:number, fraction:number, nextIndex:number}}
 *   lap は何周目か(1始まり)。fraction は今の周の進み具合(0〜1)。
 */
export function journeyPosition(totalKm) {
  const km = Math.max(0, Number(totalKm) || 0);
  const lap = Math.floor(km / JOURNEY_TOTAL_KM) + 1;
  const kmInLap = km - (lap - 1) * JOURNEY_TOTAL_KM;
  let i = 1;
  while (i < JOURNEY_CITIES.length - 1 && JOURNEY_CITIES[i].km <= kmInLap) i++;
  const from = JOURNEY_CITIES[i - 1];
  const to = JOURNEY_CITIES[i];
  const legFraction = to.km > from.km ? Math.min(1, (kmInLap - from.km) / (to.km - from.km)) : 0;
  return {
    lap, kmInLap, from, to, legFraction, nextIndex: i,
    kmToNext: Math.max(0, to.km - kmInLap),
    lat: from.lat + (to.lat - from.lat) * legFraction,
    lon: from.lon + (to.lon - from.lon) * legFraction,
    fraction: kmInLap / JOURNEY_TOTAL_KM,
  };
}

/**
 * beforeKm → afterKm の間に通過した経由地(周回をまたぐ場合も順に)。
 * @returns {Array<{city:object, lap:number}>} lap はその経由地を通過した周(1始まり)
 */
export function citiesPassed(beforeKm, afterKm) {
  const a = Math.max(0, Number(beforeKm) || 0);
  const b = Math.max(0, Number(afterKm) || 0);
  const out = [];
  if (!(b > a)) return out;
  const firstLap = Math.floor(a / JOURNEY_TOTAL_KM);
  const lastLap = Math.floor(b / JOURNEY_TOTAL_KM);
  for (let lap = firstLap; lap <= lastLap; lap++) {
    for (const city of JOURNEY_CITIES) {
      // 宗谷岬(0km)は前の周の佐多岬と同じ地点なので数えない
      if (city.km === 0) continue;
      const at = lap * JOURNEY_TOTAL_KM + city.km;
      if (at > a && at <= b) out.push({ city, lap: lap + 1 });
    }
  }
  return out;
}

/** 経由地を通過したときの通知。 */
export function journeyToast({ city, lap }) {
  const goal = city === JOURNEY_CITIES[JOURNEY_CITIES.length - 1];
  return {
    kind: 'journey',
    kicker: `🗾 日本縦断${lap > 1 ? `(${lap}周目)` : ''}`,
    title: goal ? `${city.name}に到着！ 日本縦断達成！` : `${city.name}を通過しました`,
    sub: city.note,
  };
}

/** 地図用の投影(正距円筒、緯度37度で横を縮める)。viewBox の座標を返す。 */
export const JOURNEY_MAP = { width: 200, height: 220 };
const LON0 = 129.5;
const LON1 = 146.5;
const LAT0 = 30.4;
const LAT1 = 46.0;
export function projectLatLon(lat, lon) {
  const k = Math.cos((37 * Math.PI) / 180);
  const spanX = (LON1 - LON0) * k;
  const spanY = LAT1 - LAT0;
  const scale = Math.min(JOURNEY_MAP.width / spanX, JOURNEY_MAP.height / spanY);
  return [(lon - LON0) * k * scale, (LAT1 - lat) * scale];
}
