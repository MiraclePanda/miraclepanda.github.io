// 仮想コースの傾斜度プロファイル(距離[km] -> 勾配[%])。
// 要件定義書4章「初期2〜3種類(平坦寄り／丘陵／山岳)ハードコードで用意」に対応。
// 各points配列は [距離km, 勾配%] の制御点で、区間は線形補間する。
// loopLengthKm はこのプロファイル自体の1周分の長さ(最後の制御点の距離)。
// scenery は走行中の3D表示の景色: 'city'(街並み、CityScene)/'lakeside'(湖を見下ろす
// 丘陵)/'mountain'(山岳)/'atami'(熱海サンビーチ。実在の街、js/ui/AtamiScene.js)/'ueno'(上野不忍池)/観光地コース専用の
// 'kawaguchiko'(河口湖)・'kyoto'(京都・東山の町並み)・'nara'(奈良公園)・'ryugu'(竜宮城の海底)。
// uenoはPondScene(js/three/pondLayout.js)、kawaguchiko・kyoto・nara は実在の街の RealTownScene
// (js/three/realTownLayout.js。データは tools/real-towns/build.py が生成)、ほかの city 以外は
// LandscapeScene(js/three/landscapeLayout.js。竜宮城の海底は js/three/ryuguLayout.js)で描く。
// fixedLength: true のコース(GPX から読み込んだ実在コース、js/physics/realCourse.js)は
// ループせず、走行距離をコース長(loopLengthKm)以下に制限する。
// fixedVehicle があるコースは、オプションのバイク種別に関わらずその乗り物で走る。
// curve: 平面上のカーブ(方位の揺らぎ)。[振幅(度), 1周あたりの周期数(整数), 位相(rad)] の配列。
// 方位 heading(m) = Σ amp·(sin(2π·n·m/L + φ) − sin φ)。nが整数なのでループ境界で連続する。
// 未指定(または空配列)のコースは従来どおりの直線。3D表示の見た目だけに使い、物理・勾配・
// 距離・記録には影響しない(js/three/routeLayout.js で道路の平面形状に変換する)。
// 上野は PondScene が独自の周回ルートを持つため指定しない。熱海は実在の道の方位の表(GPX と同じ形)。
// 観光地コース(tag: '観光地')は専用の景色を使い、次の項目を持つ:
//   backdrop: 遠景('fuji' = 作り物の富士山。LandscapeScene が空と一緒に回る遠景として描く。現在は未使用)
//   landmarks: [{ km, kind, side, lateralM, yaw?, viewM? }] 1周ごとに置く名所(js/three/happeningsLayout.js)。
//     kind は大鳥居・五重塔・三重塔・三門・楼門・大仏殿・清水の舞台・浮見堂・竜宮門・竜宮城・乙姫の舞台・
//     玉手箱(LANDMARK_KINDS)。
//     yaw = −π/2(右側)/+π/2(左側)で門・お堂の正面を道路へ向ける。viewM は遠くから見える距離
//   guide: [{ km, title, sub }] バスガイド風のアナウンス(js/utils/tourGuide.js)
//   localFood: { name, unit, kcal } 消費カロリーのグルメ換算で優先する名物(js/utils/gourmet.js)
// happenings: 沿道のハプニングの種類ごとの出やすさ(省略時は既定。null ならハプニングなし)。
// いずれも見た目と通知だけで、物理・勾配・トレーナーへの指示には影響しない。

import { ATAMI_COURSE_DATA } from './atamiCourseData.js';
import { KYOTO_TOWN_DATA } from './realTowns/kyoto.js';
import { NARA_TOWN_DATA } from './realTowns/nara.js';
import { FUJI_TOWN_DATA } from './realTowns/fuji.js';

// 実在の街の観光地コース(tools/real-towns/build.py が生成した js/physics/realTowns/*.js)の共通部分:
// 1周の長さ・方位の表・勾配。熱海と同じく、コーナー(とUターン)の手前で減速する(cornering)。
function townCourse(d) {
  return {
    loopLengthKm: d.loopLengthM / 1000,
    crossfadeKm: 0,
    cornering: true,
    curve: { type: 'table', stepM: d.headingStepM, headings: d.headings },
    points: townPoints(d),
  };
}

// 勾配の表 → 制御点。最後の点が1周の終わりに届かなければ、1周の終わりに最初の勾配の点を足す(周回の継ぎ目)
function townPoints(d) {
  const pts = d.grades.map((g, i) => [(i * d.gradeStepM) / 1000, g]);
  const lap = d.loopLengthM / 1000;
  if (pts[pts.length - 1][0] < lap - 1e-9) pts.push([lap, d.grades[0]]);
  return pts;
}

/** 名所(生成データの sights から、keys の順に)。 */
function townLandmarks(d, keys) {
  return keys.map((k) => {
    const { km, kind, side, lateralM, yaw, viewM } = d.sights[k];
    const m = { km, kind, side, lateralM };
    if (yaw !== undefined) m.yaw = yaw;
    if (viewM !== undefined) m.viewM = viewM;
    return m;
  });
}

/**
 * バスガイド。[名所の key(null なら1周の最初/最後), その位置からのずれ km, title, sub]。
 * 名所が null でずれが負なら1周の終わりから数える。
 */
function townGuide(d, rows) {
  const lap = d.loopLengthM / 1000;
  return rows
    .map(([key, off, title, sub]) => {
      const base = key ? d.sights[key].km : off < 0 ? lap : 0;
      const km = Math.round((base + off) * 1000) / 1000;
      return { km: Math.min(lap - 0.01, Math.max(0, km)), title, sub };
    })
    .sort((a, b) => a.km - b.km);
}

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
    description: '国道135号の海岸沿いを、サンビーチから錦ヶ浦の手前と伊豆山で折り返す実在の道(1周7.6km)。PLATEAU の建物と国土地理院の地形・道路で熱海の街並みを再現。',
    // 実在の道(atamiCourseData.js、tools/atami-plateau/build.py が生成): 1周 = 往復 + Uターン2回。
    // 勾配は国土地理院の標高から、方位の表は道路中心線から。ほかの組み込みコースと違い、
    // GPX の実在コースと同じくコーナー(とUターン)の手前で減速する(cornering)。周回はする。
    loopLengthKm: ATAMI_COURSE_DATA.loopLengthM / 1000,
    crossfadeKm: 0,
    cornering: true,
    curve: { type: 'table', stepM: ATAMI_COURSE_DATA.headingStepM, headings: ATAMI_COURSE_DATA.headings },
    points: ATAMI_COURSE_DATA.grades.map((g, i) => [(i * ATAMI_COURSE_DATA.gradeStepM) / 1000, g]),
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
    description: `河口湖大橋のたもとから、河口湖の北岸を西へ。湖の向こうに本物の富士山を眺めながら、河口の集落・大石公園を通ってもみじ回廊の近くまで行き、同じ道を戻る実在の道(1周${(FUJI_TOWN_DATA.loopLengthM / 1000).toFixed(1)}km)。地形・湖・道路・建物の形は国土地理院のデータから(この辺りは PLATEAU が無いため、建物の高さは推定)。`,
    // 実在の道(js/physics/realTowns/fuji.js、tools/real-towns/build.py が生成): 1周 = 往復 + Uターン2回。
    // 富士山は遠景の地形(国土地理院の標高)そのものなので、作り物の遠景(backdrop)は使わない
    ...townCourse(FUJI_TOWN_DATA),
    landmarks: townLandmarks(FUJI_TOWN_DATA, ['chureito', 'torii']),
    guide: townGuide(FUJI_TOWN_DATA, [
      [null, 0.05, '富士山・河口湖へようこそ', '本日のガイドはわたくし、パンダがつとめます。左手の湖の向こうに見えますのが、本物の富士山でございます。'],
      [null, 0.9, '河口湖の北岸を西へまいります', '湖面に逆さ富士が映る……かもしれません。湖畔の木々は、今日の暦どおりの季節の装いでございます。'],
      ['chureito', -0.2, '右手の山の上に見えますのが忠霊塔でございます', '富士山・五重塔・桜(秋は紅葉)の豪華セット。本来は少し離れた富士吉田にございますが、本日は特別に寄せております。'],
      ['kawaguchi', -0.05, '河口の集落に入ります', '富士山へお参りする人たちが泊まった、古い御師(おし)の町でございます。'],
      ['torii', -0.15, '間もなく大鳥居をくぐります', '富士山の神様にごあいさつを。'],
      ['oishi', -0.1, '大石公園でございます', '湖と富士山をいっぺんに眺められる花の公園。ラベンダーとコキアが名物でございます。'],
      ['momiji', -0.25, 'もみじ回廊が近づいてまいりました', '秋には真っ赤なもみじのトンネルになる並木でございます。見とれてペダルが止まらないようご注意ください。'],
      ['momiji', 0.03, 'ここで折り返しでございます', 'ほうとうの看板が見えても、まだ寄り道は早うございます。'],
      [null, -0.4, '間もなく1周でございます', '河口湖大橋のたもとで折り返し。お忘れ物のないよう、ペダルは回し続けてください。'],
    ]),
    localFood: { name: 'ほうとう', unit: '杯', kcal: 550 },
  },
  {
    id: 'kyoto',
    name: '京都・東山コース',
    tag: '観光地',
    scenery: 'kyoto',
    description: `平安神宮の大鳥居から神宮道を南へ、知恩院の三門・円山公園・ねねの道・八坂の塔を経て清水寺の仁王門まで上り、同じ道を戻る実在の道(1周${(KYOTO_TOWN_DATA.loopLengthM / 1000).toFixed(1)}km)。PLATEAU の建物と国土地理院の地形・道路で東山の町並みを再現。清水坂は本物の上り坂です。`,
    // 実在の道(js/physics/realTowns/kyoto.js、tools/real-towns/build.py が生成): 1周 = 往復 + Uターン2回。
    // 名所の位置(1周の中の km・左右・道からの距離)も実在の位置からの生成値
    ...townCourse(KYOTO_TOWN_DATA),
    landmarks: townLandmarks(KYOTO_TOWN_DATA, ['heianTorii', 'chionin', 'yasaka', 'yasakaPagoda', 'niomon', 'kiyomizuPagoda', 'kiyomizu']),
    guide: townGuide(KYOTO_TOWN_DATA, [
      [null, 0.05, '京都・東山へようこそ', '本日のガイドはわたくし、パンダがつとめます。平安神宮の前から、本物の東山の町並みを南へまいります。'],
      ['heianTorii', -0.12, '平安神宮の大鳥居でございます', '高さ約24m。自転車でくぐれる鳥居としては、たぶん日本有数でございます。'],
      ['chionin', -0.22, '左手に見えますのが知恩院の三門でございます', '日本最大級の木造の門。くぐるには自転車を降りて石段を上る必要がございます。'],
      ['yasaka', -0.18, '円山公園と八坂神社でございます', '「祇園さん」の愛称で親しまれております。公園のしだれ桜は春、東山の紅葉は秋の名物でございます。'],
      ['yasaka', 0.2, 'ねねの道に入ります', '豊臣秀吉の妻・ねねが晩年を過ごした高台寺へ続く石畳の道。人力車にお気をつけください。'],
      ['yasakaPagoda', -0.18, '正面に八坂の塔が見えてまいりました', '坂の上に五重塔。京都らしい景色の代表選手でございます。'],
      ['niomon', -0.4, 'ここから清水坂でございます', '本物の上り坂。ゆっくり上りましょう。お土産屋さんの試食は、ペダルを止めてからどうぞ。'],
      ['niomon', -0.06, '清水寺の仁王門と三重塔でございます', '右手の上の方が清水の舞台。139本の柱が支える懸造りでございます。'],
      ['niomon', 0.06, 'ここで折り返しでございます', '清水の舞台から飛び降りるつもりで……下り坂は、くれぐれもゆっくりどうぞ。'],
      [null, -0.35, '間もなく1周でございます', '平安神宮の大鳥居で折り返し。お忘れ物のないよう、ペダルは回し続けてください。'],
    ]),
    localFood: { name: '生八つ橋', unit: '個', kcal: 50 },
  },
  {
    id: 'nara',
    name: '奈良公園コース',
    tag: '観光地',
    scenery: 'nara',
    description: `鹿がのんびり暮らす奈良公園を一周する実在の道(1周${(NARA_TOWN_DATA.loopLengthM / 1000).toFixed(1)}km)。猿沢池から三条通を東へ、一の鳥居・春日大社の参道・東大寺の南大門と大仏殿・若草山の麓・浮見堂をめぐります。建物の形・地形・道路は国土地理院のデータから(この辺りは PLATEAU が無いため、建物の高さは推定)。鹿によく会います。`,
    // 実在の道(js/physics/realTowns/nara.js、tools/real-towns/build.py が生成): 周回
    ...townCourse(NARA_TOWN_DATA),
    // 鹿によく会う
    happenings: { cat: 1, panda: 1, cheer: 1, aid: 1, deer: 6 },
    landmarks: townLandmarks(NARA_TOWN_DATA, ['kofukuji', 'ichinoTorii', 'nandaimon', 'daibutsuden', 'ukimido']),
    guide: townGuide(NARA_TOWN_DATA, [
      [null, 0.04, '奈良公園へようこそ', '鹿が約1300頭暮らしています。道は譲ってあげましょう。'],
      ['kofukuji', -0.1, '左手に見えますのが興福寺の五重塔でございます', '高さ約50m。木造の塔では日本で2番目の高さです。'],
      ['ichinoTorii', -0.15, '間もなく春日大社の一の鳥居をくぐります', '鹿は神様のお使いとされています。'],
      ['kasuga', -0.1, '春日大社の参道でございます', '奥の本殿まで約3000基の灯籠が続きます。数えながら走るのはおすすめいたしません。'],
      ['nandaimon', -0.25, '左手に東大寺の南大門が見えてまいります', '門の左右には運慶・快慶の金剛力士像。にらまれても止まらずにどうぞ。'],
      ['daibutsuden', -0.05, '左手の奥が大仏殿でございます', '世界最大級の木造建築。中では大仏さまがお待ちです(自転車は入れません)。'],
      ['wakakusa', -0.15, '右手に見えますのが若草山でございます', '三つの笠を重ねたような芝の山。1月の山焼きが有名でございます。'],
      ['tobihino', 0.05, '飛火野でございます', '鹿がいちばん多い芝生の原っぱ。鹿せんべいを持っていると囲まれます。'],
      ['ukimido', -0.15, '左手の池に浮かぶのが浮見堂でございます', '鷺池に浮かぶ六角のお堂。橋を渡ってひと休み……は、ペダルを止めてからどうぞ。'],
      ['araike', -0.05, '荒池のほとりを走ります', '鹿せんべいの売店が見えても、走りながらは渡せません。気持ちだけお渡しください。'],
      ['sarusawa', -0.15, '間もなく猿沢池でございます', '池に映る五重塔が見どころ。1周おつかれさまでございます。'],
    ]),
    localFood: { name: '柿の葉寿司', unit: '個', kcal: 50 },
  },
  {
    id: 'ryugu',
    name: '竜宮城・海底コース',
    tag: '観光地',
    scenery: 'ryugu',
    // セットアップ画面で「ウミガメ」をすすめる(固定はしない: fixedVehicle と違いユーザーの選択のまま)
    recommendedVehicle: 'turtle',
    description: '光の差し込む海の底を、サンゴと貝殻で縁取られた白い砂の道でめぐる観光コース(1周6km)。昆布の林や沈没船を抜け、竜宮門をくぐって竜宮城と乙姫さまの舞台へ。カメがときどき並んで泳いでくれます。',
    loopLengthKm: 6,
    crossfadeKm: 0.15,
    curve: [[26, 2, 0.9], [11, 6, 2.4], [4, 14, 0.5]],
    // 上りは海底の岩山、下りは海溝の縁へ。1周の上り下りはほぼ打ち消し合う
    points: [
      [0, 0],
      [0.8, 1.5],
      [1.6, 0.5],
      [2.4, -2],
      [3.2, -1],
      [4, 2],
      [4.8, 0.5],
      [5.5, -1.5],
      [6, 0],
    ],
    // 海の中なので猫・パンダ・鹿・応援団の代わりにカメが出る(給水所は海の中でもある)
    happenings: { cat: 0, panda: 0, cheer: 0, aid: 1, deer: 0, turtle: 4 },
    // 昆布の林・沈没船・舞台のまわりの踊り子の位置は js/three/landscapeLayout.js の LANDSCAPES.ryugu.tour と揃えている
    landmarks: [
      { km: 1.2, kind: 'ryuguGate', side: 0, lateralM: 0, viewM: 500 },
      { km: 1.75, kind: 'ryuguPalace', side: 1, lateralM: 70, yaw: -Math.PI / 2, viewM: 1200 },
      { km: 2.25, kind: 'otohimeStage', side: -1, lateralM: 8, yaw: Math.PI / 2, viewM: 400 },
      { km: 5.2, kind: 'tamatebako', side: 1, lateralM: 2.5, yaw: -Math.PI / 2, viewM: 200 },
    ],
    guide: [
      { km: 0.2, title: '海の底へようこそ', sub: '本日のガイドはわたくし、パンダがつとめます。息つぎは気にせずペダルをどうぞ。' },
      { km: 0.5, title: '道の両側はサンゴ礁でございます', sub: '貝殻で縁取られた白い砂の道。サンゴには触らないようお願いいたします。' },
      { km: 0.95, title: '正面に竜宮門が見えてまいりました', sub: '白い漆喰に朱塗りの楼閣。このまま門をくぐってまいります。' },
      { km: 1.55, title: '右手に見えますのが竜宮城でございます', sub: '絵にも描けない美しさ……でしたが、本日は3Dで描いております。' },
      { km: 2.05, title: '左手は乙姫さまの舞台でございます', sub: 'タイやヒラメが舞い踊っております。見とれてペダルが止まらないようご注意ください。' },
      { km: 2.7, title: '昆布の林に入ります', sub: 'ゆらゆら揺れておりますが、揺れているのは昆布です。目が回ったわけではございません。' },
      { km: 3.75, title: '左手に沈没船が見えてまいります', sub: '宝箱が転がっておりますが、持ち帰りはご遠慮ください。' },
      { km: 4.5, title: '左手の先は海溝でございます', sub: '深さは……わかりません。チョウチンアンコウが住んでいるそうです。' },
      { km: 5.05, title: '右手に玉手箱がございます', sub: '決して開けてはなりません。開けるのはゴール後のリザルト画面でどうぞ。' },
      { km: 5.7, title: '間もなく1周でございます', sub: '竜宮城の1日は地上の100年とも申します。時計はあまり気になさらずに。' },
    ],
    localFood: { name: '海藻サラダ', unit: '皿', kcal: 40 },
  },
];

export function getCourseProfile(id) {
  return COURSE_PROFILES.find((p) => p.id === id) ?? COURSE_PROFILES[0];
}
