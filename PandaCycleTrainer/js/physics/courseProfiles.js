// 仮想コースの傾斜度プロファイル(距離[km] -> 勾配[%])。
// 要件定義書4章「初期2〜3種類(平坦寄り／丘陵／山岳)ハードコードで用意」に対応。
// 各points配列は [距離km, 勾配%] の制御点で、区間は線形補間する。
// loopLengthKm はこのプロファイル自体の1周分の長さ(最後の制御点の距離)。
// scenery は走行中の3D表示の景色: 'city'(街並み、CityScene)/'lakeside'(湖を見下ろす
// 丘陵)/'mountain'(山岳)/'atami'(熱海サンビーチ)/'ueno'(上野不忍池)。lakeside・mountain・
// atamiはLandscapeScene(js/three/landscapeLayout.js)、uenoはPondScene(js/three/pondLayout.js)で描く。
// fixedLength: true のコース(GPX から読み込んだ実在コース、js/physics/realCourse.js)は
// ループせず、走行距離をコース長(loopLengthKm)以下に制限する。
// fixedVehicle があるコースは、オプションのバイク種別に関わらずその乗り物で走る。
// curve: 平面上のカーブ(方位の揺らぎ)。[振幅(度), 1周あたりの周期数(整数), 位相(rad)] の配列。
// 方位 heading(m) = Σ amp·(sin(2π·n·m/L + φ) − sin φ)。nが整数なのでループ境界で連続する。
// 未指定(または空配列)のコースは従来どおりの直線。3D表示の見た目だけに使い、物理・勾配・
// 距離・記録には影響しない(js/three/routeLayout.js で道路の平面形状に変換する)。
// 熱海は海岸線沿いの直線(LandscapeScene 既存のゆるい蛇行)を維持するため、上野は PondScene が
// 独自の周回ルートを持つため、どちらも指定しない。
// 観光地コース(tag: '観光地')は既存の景色を使い、次の項目を持つ:
//   backdrop: 遠景(現在は 'fuji' = 富士山。LandscapeScene が空と一緒に回る遠景として描く)
//   landmarks: [{ km, kind: 'torii'|'pagoda', side, lateralM }] 1周ごとに置く名所(js/three/happeningsLayout.js)
//   guide: [{ km, title, sub }] バスガイド風のアナウンス(js/utils/tourGuide.js)
//   localFood: { name, unit, kcal } 消費カロリーのグルメ換算で優先する名物(js/utils/gourmet.js)
// happenings: 沿道のハプニングの種類ごとの出やすさ(省略時は既定。null ならハプニングなし)。
// いずれも見た目と通知だけで、物理・勾配・トレーナーへの指示には影響しない。

export const COURSE_PROFILES = [
  {
    id: 'flat',
    name: '平坦コース',
    scenery: 'city',
    description: '起伏の少ない平坦基調のコース。ウォームアップや脚を回したい日向け。',
    loopLengthKm: 10,
    crossfadeKm: 0.15,
    curve: [[25, 3, 0], [12, 8, 1.3], [6, 17, 2.1]],
    points: [
      [0, 0],
      [1.5, 0.5],
      [3, -0.5],
      [4.5, 1],
      [6, 0],
      [7.5, -1],
      [9, 0.5],
      [10, 0],
    ],
  },
  {
    id: 'hilly',
    name: '丘陵コース',
    scenery: 'lakeside',
    description: '緩やかなアップダウンが連続する丘陵地帯のコース。',
    loopLengthKm: 15,
    crossfadeKm: 0.2,
    curve: [[35, 3, 0.4], [16, 9, 2.0], [6, 22, 0.7]],
    points: [
      [0, 0],
      [1, 3],
      [2.5, 5],
      [3.5, 2],
      [5, -3],
      [6, -4],
      [7.5, 1],
      [9, 4],
      [10.5, 6],
      [11.5, 3],
      [13, -2],
      [14, -4],
      [15, 0],
    ],
  },
  {
    id: 'mountain',
    name: '山岳コース',
    scenery: 'mountain',
    description: '長い上りを含む山岳コース。合計獲得標高を稼ぎたい日向け。',
    loopLengthKm: 20,
    crossfadeKm: 0.25,
    curve: [[45, 4, 1.0], [22, 12, 0.2], [8, 30, 2.5]],
    points: [
      [0, 0],
      [1, 2],
      [3, 6],
      [5, 8],
      [7, 9],
      [9, 10],
      [10, 4],
      [11, -6],
      [12.5, -8],
      [14, -2],
      [15, 5],
      [17, 7],
      [18.5, 3],
      [19.5, -4],
      [20, 0],
    ],
  },
  {
    id: 'atami',
    name: '熱海サンビーチコース',
    scenery: 'atami',
    description: '相模湾に面した熱海サンビーチ沿いの海岸通り。ヤシ並木の遊歩道と砂浜、ホテル街を眺めて走る平坦基調のコース。',
    loopLengthKm: 6,
    crossfadeKm: 0.15,
    // 上り下りが打ち消し合い、1周で標高がほぼ変わらない(海岸線から離れない)ようにしている。
    points: [
      [0, 0],
      [0.8, 1.0],
      [1.6, 0],
      [2.4, -1.0],
      [3.2, 0],
      [4.0, 0.8],
      [4.8, -0.8],
      [5.6, 0],
      [6, 0],
    ],
  },
  {
    id: 'ueno',
    name: '上野不忍池コース',
    scenery: 'ueno',
    // 池の上をスワンボートで周回するコースのため、バイク種別はスワンボートに固定
    fixedVehicle: 'swan',
    // 池の上なので沿道のハプニングは起きない
    happenings: null,
    description: '上野・不忍池をスワンボートで反時計回りに周回する平坦なコース(1周1.2km)。柳の岸辺や弁天堂、蓮池を眺めて漕ぎます。',
    // 1周の長さは周回ルート(js/three/pondLayout.js の ROUTE_LENGTH_M)と一致させている
    loopLengthKm: 1.2,
    crossfadeKm: 0,
    points: [
      [0, 0],
      [1.2, 0],
    ],
  },
  {
    id: 'fuji',
    name: '富士山・河口湖コース',
    tag: '観光地',
    scenery: 'lakeside',
    backdrop: 'fuji',
    description: '河口湖の湖畔をぐるりと一周。湖の向こうに富士山を眺めながら、五重塔や大鳥居をめぐる観光コース(1周20km)。',
    loopLengthKm: 20,
    crossfadeKm: 0.2,
    curve: [[30, 3, 1.1], [14, 8, 0.4], [5, 19, 2.4]],
    points: [
      [0, 0],
      [2, 1],
      [4, -0.5],
      [6, 1.5],
      [8, 0],
      [10, -1],
      [12, 1],
      [14, 2],
      [16, -1.5],
      [18, -1],
      [20, 0],
    ],
    landmarks: [
      { km: 6, kind: 'pagoda', side: 1, lateralM: 14 },
      { km: 13, kind: 'torii', side: 0, lateralM: 0 },
    ],
    guide: [
      { km: 0.3, title: '左手に見えますのが富士山でございます', sub: '標高3776m。本日もたいへん大きゅうございます。' },
      { km: 3, title: '河口湖の湖畔を走ります', sub: '湖面に逆さ富士が映る……かもしれません。' },
      { km: 5.8, title: '右手に五重塔が見えてまいります', sub: '富士山と五重塔。絵はがきでおなじみの組み合わせでございます。' },
      { km: 10, title: 'ただいま折り返し地点でございます', sub: 'ほうとうの看板が見えても、まだ寄り道は早うございます。' },
      { km: 12.8, title: '間もなく大鳥居をくぐります', sub: '富士山の神様にごあいさつを。' },
      { km: 17, title: '間もなく1周でございます', sub: 'お忘れ物のないよう、ペダルは回し続けてください。' },
    ],
    localFood: { name: 'ほうとう', unit: '杯', kcal: 550 },
  },
  {
    id: 'kyoto',
    name: '京都・東山コース',
    tag: '観光地',
    scenery: 'city',
    description: '平安神宮の大鳥居をくぐり、祇園の街並みから八坂の塔へ。ゆるやかな坂のある京都の街をのんびりめぐる観光コース(1周8km)。',
    loopLengthKm: 8,
    crossfadeKm: 0.15,
    curve: [[22, 3, 0.6], [10, 8, 2.2], [5, 17, 1.0]],
    points: [
      [0, 0],
      [1, 1.5],
      [2, 3],
      [3, 0.5],
      [4, -1],
      [5, 2],
      [6, -2],
      [7, -1.5],
      [8, 0],
    ],
    landmarks: [
      { km: 1, kind: 'torii', side: 0, lateralM: 0 },
      { km: 4.5, kind: 'pagoda', side: 1, lateralM: 18 },
    ],
    guide: [
      { km: 0.2, title: '京都・東山へようこそ', sub: '本日のガイドはわたくし、パンダがつとめます。' },
      { km: 0.85, title: '平安神宮の大鳥居でございます', sub: '高さ約24m。自転車でくぐれる鳥居としては、たぶん日本有数でございます。' },
      { km: 3, title: '祇園の街並みを走ります', sub: '舞妓さんを見かけても、よそ見運転はご遠慮ください。' },
      { km: 4.3, title: '右手に見えますのが八坂の塔でございます', sub: '五重塔は地震に強いつくりなのだそうです。' },
      { km: 6.5, title: '清水の舞台から飛び降りるつもりで', sub: '……ラストスパートしなくても大丈夫です。のんびりどうぞ。' },
    ],
    localFood: { name: '生八つ橋', unit: '個', kcal: 50 },
  },
  {
    id: 'nara',
    name: '奈良公園コース',
    tag: '観光地',
    scenery: 'lakeside',
    description: '鹿がのんびり暮らす奈良公園を一周。春日大社の鳥居や興福寺の五重塔、猿沢池を眺めて走る観光コース(1周6km)。鹿によく会います。',
    loopLengthKm: 6,
    crossfadeKm: 0.15,
    curve: [[24, 2, 0.3], [10, 6, 1.7], [4, 13, 0.9]],
    points: [
      [0, 0],
      [1, 2],
      [2, 1],
      [3, -1.5],
      [4, -2],
      [5, 1],
      [6, 0],
    ],
    // 鹿によく会う
    happenings: { cat: 1, panda: 1, cheer: 1, aid: 1, deer: 6 },
    landmarks: [
      { km: 1.2, kind: 'torii', side: 0, lateralM: 0 },
      { km: 3.5, kind: 'pagoda', side: 1, lateralM: 16 },
    ],
    guide: [
      { km: 0.2, title: '奈良公園へようこそ', sub: '鹿が約1300頭暮らしています。道は譲ってあげましょう。' },
      { km: 1.05, title: '春日大社の一の鳥居でございます', sub: '鹿は神様のお使いとされています。' },
      { km: 2.5, title: '左手は猿沢池でございます', sub: '池に映る五重塔が見どころでございます。' },
      { km: 3.3, title: '右手に見えますのが興福寺の五重塔でございます', sub: '高さ約50m。木造の塔では日本で2番目の高さです。' },
      { km: 5, title: '鹿せんべいの売店が見えてまいりました', sub: '走りながらは渡せませんので、気持ちだけお渡しください。' },
    ],
    localFood: { name: '柿の葉寿司', unit: '個', kcal: 50 },
  },
];

export function getCourseProfile(id) {
  return COURSE_PROFILES.find((p) => p.id === id) ?? COURSE_PROFILES[0];
}
