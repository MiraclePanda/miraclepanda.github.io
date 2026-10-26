// 仮想コースの傾斜度プロファイル(距離[km] -> 勾配[%])。
// 要件定義書4章「初期2〜3種類(平坦寄り／丘陵／山岳)ハードコードで用意」に対応。
// 各points配列は [距離km, 勾配%] の制御点で、区間は線形補間する。
// loopLengthKm はこのプロファイル自体の1周分の長さ(最後の制御点の距離)。
// scenery は走行中の3D表示の景色: 'city'(街並み、CityScene)/'lakeside'(湖を見下ろす
// 丘陵)/'mountain'(山岳)/'atami'(熱海サンビーチ)/'ueno'(上野不忍池)/観光地コース専用の
// 'kawaguchiko'(河口湖)・'kyoto'(京都・東山の町並み)・'nara'(奈良公園)。uenoはPondScene
// (js/three/pondLayout.js)、ほかの city 以外は LandscapeScene(js/three/landscapeLayout.js。
// 観光地の町並み・名物は js/three/tourLayout.js)で描く。
// fixedLength: true のコース(GPX から読み込んだ実在コース、js/physics/realCourse.js)は
// ループせず、走行距離をコース長(loopLengthKm)以下に制限する。
// fixedVehicle があるコースは、オプションのバイク種別に関わらずその乗り物で走る。
// curve: 平面上のカーブ(方位の揺らぎ)。[振幅(度), 1周あたりの周期数(整数), 位相(rad)] の配列。
// 方位 heading(m) = Σ amp·(sin(2π·n·m/L + φ) − sin φ)。nが整数なのでループ境界で連続する。
// 未指定(または空配列)のコースは従来どおりの直線。3D表示の見た目だけに使い、物理・勾配・
// 距離・記録には影響しない(js/three/routeLayout.js で道路の平面形状に変換する)。
// 熱海は海岸線沿いの直線(LandscapeScene 既存のゆるい蛇行)を維持するため、上野は PondScene が
// 独自の周回ルートを持つため、どちらも指定しない。
// 観光地コース(tag: '観光地')は専用の景色を使い、次の項目を持つ:
//   backdrop: 遠景(現在は 'fuji' = 富士山。LandscapeScene が空と一緒に回る遠景として描く)
//   landmarks: [{ km, kind, side, lateralM, yaw?, viewM? }] 1周ごとに置く名所(js/three/happeningsLayout.js)。
//     kind は大鳥居・五重塔・三重塔・三門・楼門・大仏殿・清水の舞台・浮見堂(LANDMARK_KINDS)。
//     yaw = −π/2(右側)/+π/2(左側)で門・お堂の正面を道路へ向ける。viewM は遠くから見える距離
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
    scenery: 'kawaguchiko',
    backdrop: 'fuji',
    description: '紅葉の河口湖の湖畔をぐるりと一周。湖の向こうに富士山を眺め、忠霊塔・河口湖大橋・遊覧船・もみじ回廊・大鳥居をめぐる観光コース(1周20km)。',
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
      // 新倉山浅間公園の忠霊塔(朱塗りの五重塔)。山の中腹に建つので遠くから見える
      { km: 6, kind: 'pagodaRed', side: 1, lateralM: 55, viewM: 900 },
      { km: 15, kind: 'torii', side: 0, lateralM: 0 },
    ],
    guide: [
      { km: 0.3, title: '左手に見えますのが富士山でございます', sub: '標高3776m。本日もたいへん大きゅうございます。' },
      { km: 3, title: '河口湖の湖畔を走ります', sub: '湖面に逆さ富士が映る……かもしれません。紅葉もちょうど見ごろでございます。' },
      { km: 5.4, title: '右手の山の上に見えますのが忠霊塔でございます', sub: '富士山・五重塔・紅葉の三点セット。本来は少し離れた富士吉田にございますが、本日は特別に寄せております。' },
      { km: 8.6, title: '左手に河口湖大橋が見えてまいります', sub: '湖を渡る全長500mほどの橋でございます。本日は渡らずに眺めるだけでございます。' },
      { km: 10, title: 'ただいま折り返し地点でございます', sub: 'ほうとうの看板が見えても、まだ寄り道は早うございます。' },
      { km: 11.5, title: '湖の上をご覧ください、遊覧船でございます', sub: '戦国武将の御座船のような姿。お殿様気分で手を振ってみましょう。' },
      { km: 12.6, title: 'もみじ回廊に入ります', sub: '真っ赤なもみじのトンネルでございます。見とれてペダルが止まらないようご注意ください。' },
      { km: 14.8, title: '間もなく大鳥居をくぐります', sub: '富士山の神様にごあいさつを。' },
      { km: 17, title: '間もなく1周でございます', sub: 'お忘れ物のないよう、ペダルは回し続けてください。' },
    ],
    localFood: { name: 'ほうとう', unit: '杯', kcal: 550 },
  },
  {
    id: 'kyoto',
    name: '京都・東山コース',
    tag: '観光地',
    scenery: 'kyoto',
    description: '平安神宮の大鳥居から、知恩院の三門、八坂神社、祇園白川、八坂の塔を経て清水の舞台へ。京町家が軒を連ねる石畳の道と紅葉の東山をのんびりめぐる観光コース(1周8km)。',
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
    // 実際の東山の名所の並び(北から南へ)。建物の形は js/three/sightModels.js
    landmarks: [
      { km: 0.8, kind: 'torii', side: 0, lateralM: 0 },
      { km: 1.7, kind: 'sanmon', side: 1, lateralM: 6, yaw: -Math.PI / 2, viewM: 700 },
      { km: 2.6, kind: 'romon', side: 1, lateralM: 2, yaw: -Math.PI / 2, viewM: 500 },
      { km: 4.3, kind: 'pagoda', side: 1, lateralM: 2, viewM: 900 },
      { km: 4.95, kind: 'romon', side: 1, lateralM: 4, yaw: -Math.PI / 2, viewM: 500 },
      { km: 5.08, kind: 'pagoda3', side: 1, lateralM: 26, viewM: 800 },
      { km: 5.3, kind: 'kiyomizu', side: 1, lateralM: 50, yaw: -Math.PI / 2, viewM: 1500 },
    ],
    guide: [
      { km: 0.2, title: '京都・東山へようこそ', sub: '本日のガイドはわたくし、パンダがつとめます。東山は紅葉の見ごろでございます。' },
      { km: 0.6, title: '平安神宮の大鳥居でございます', sub: '高さ約24m。自転車でくぐれる鳥居としては、たぶん日本有数でございます。' },
      { km: 1.45, title: '右手に見えますのが知恩院の三門でございます', sub: '日本最大級の木造の門。くぐるには自転車を降りて石段を上る必要がございます。' },
      { km: 2.35, title: '朱塗りの門は八坂神社の西楼門でございます', sub: '「祇園さん」の愛称で親しまれております。' },
      { km: 3, title: '左手は祇園白川でございます', sub: '柳並木と石畳、町家の格子。舞妓さんを見かけても、よそ見運転はご遠慮ください。' },
      { km: 4.05, title: '正面に八坂の塔が見えてまいりました', sub: '坂の上に五重塔。京都らしい景色の代表選手でございます。' },
      { km: 4.8, title: '清水寺の仁王門と三重塔でございます', sub: 'ここからは清水坂。ゆっくり上りましょう。' },
      { km: 5.15, title: '右手の崖の上が清水の舞台でございます', sub: '139本の柱が支える懸造り。くれぐれも飛び降りないでください。' },
      { km: 6.5, title: '清水の舞台から飛び降りるつもりで', sub: '……ラストスパートしなくても大丈夫です。のんびりどうぞ。' },
      { km: 7.05, title: '左手遠くに見えますのが京都タワーでございます', sub: '灯台をイメージした塔。ろうそくではございません。' },
    ],
    localFood: { name: '生八つ橋', unit: '個', kcal: 50 },
  },
  {
    id: 'nara',
    name: '奈良公園コース',
    tag: '観光地',
    scenery: 'nara',
    description: '鹿がのんびり暮らす奈良公園を一周。猿沢池と興福寺の五重塔、東大寺の南大門と大仏殿、若草山、春日大社の石灯籠の参道、浮見堂をめぐる観光コース(1周6km)。鹿によく会います。',
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
    // 池・若草山・参道の位置は js/three/landscapeLayout.js の LANDSCAPES.nara.tour と揃えている
    landmarks: [
      { km: 0.8, kind: 'pagoda', side: -1, lateralM: 92, viewM: 900 },
      { km: 1.65, kind: 'sanmon', side: 1, lateralM: 6, yaw: -Math.PI / 2, viewM: 700 },
      { km: 1.65, kind: 'daibutsuden', side: 1, lateralM: 170, yaw: -Math.PI / 2, viewM: 2500 },
      { km: 3.35, kind: 'torii', side: 0, lateralM: 0 },
      { km: 4.75, kind: 'ukimido', side: -1, lateralM: 42.8, yaw: Math.PI / 2, viewM: 600 },
    ],
    guide: [
      { km: 0.2, title: '奈良公園へようこそ', sub: '鹿が約1300頭暮らしています。道は譲ってあげましょう。' },
      { km: 0.55, title: '左手は猿沢池でございます', sub: '池の向こうに興福寺の五重塔。水面に映る姿が見どころでございます。' },
      { km: 0.85, title: '興福寺の五重塔でございます', sub: '高さ約50m。木造の塔では日本で2番目の高さです。' },
      { km: 1.4, title: '右手に東大寺の南大門が見えてまいります', sub: '門の奥が大仏殿。世界最大級の木造建築で、中では大仏さまがお待ちです(自転車は入れません)。' },
      { km: 2.45, title: '右手に見えますのが若草山でございます', sub: '三つの笠を重ねたような芝の山。1月の山焼きが有名でございます。' },
      { km: 3.2, title: '間もなく春日大社の一の鳥居をくぐります', sub: '鹿は神様のお使いとされています。' },
      { km: 3.5, title: '参道の石灯籠をご覧ください', sub: '春日大社には約3000基の灯籠がございます。数えながら走るのはおすすめいたしません。' },
      { km: 4.55, title: '左手の池に浮かぶのが浮見堂でございます', sub: '鷺池に浮かぶ六角のお堂。橋を渡ってひと休み……は、ペダルを止めてからどうぞ。' },
      { km: 5.3, title: '鹿せんべいの売店が見えてまいりました', sub: '走りながらは渡せませんので、気持ちだけお渡しください。' },
    ],
    localFood: { name: '柿の葉寿司', unit: '個', kcal: 50 },
  },
];

export function getCourseProfile(id) {
  return COURSE_PROFILES.find((p) => p.id === id) ?? COURSE_PROFILES[0];
}
