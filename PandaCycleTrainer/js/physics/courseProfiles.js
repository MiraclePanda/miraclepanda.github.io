// 仮想コースの傾斜度プロファイル(距離[km] -> 勾配[%])。
// 要件定義書4章「初期2〜3種類(平坦寄り／丘陵／山岳)ハードコードで用意」に対応。
// 各points配列は [距離km, 勾配%] の制御点で、区間は線形補間する。
// loopLengthKm はこのプロファイル自体の1周分の長さ(最後の制御点の距離)。
// scenery は走行中の3D表示の景色: 'city'(街並み、CityScene)/'lakeside'(湖を見下ろす
// 丘陵)/'mountain'(山岳)/'atami'(熱海サンビーチ)/'ueno'(上野不忍池)。lakeside・mountain・
// atamiはLandscapeScene(js/three/landscapeLayout.js)、uenoはPondScene(js/three/pondLayout.js)で描く。
// fixedVehicle があるコースは、オプションのバイク種別に関わらずその乗り物で走る。
// curve: 平面上のカーブ(方位の揺らぎ)。[振幅(度), 1周あたりの周期数(整数), 位相(rad)] の配列。
// 方位 heading(m) = Σ amp·(sin(2π·n·m/L + φ) − sin φ)。nが整数なのでループ境界で連続する。
// 未指定(または空配列)のコースは従来どおりの直線。3D表示の見た目だけに使い、物理・勾配・
// 距離・記録には影響しない(js/three/routeLayout.js で道路の平面形状に変換する)。
// 熱海は海岸線沿いの直線(LandscapeScene 既存のゆるい蛇行)を維持するため、上野は PondScene が
// 独自の周回ルートを持つため、どちらも指定しない。

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
    description: '上野・不忍池をスワンボートで反時計回りに周回する平坦なコース(1周1.2km)。柳の岸辺や弁天堂、蓮池を眺めて漕ぎます。',
    // 1周の長さは周回ルート(js/three/pondLayout.js の ROUTE_LENGTH_M)と一致させている
    loopLengthKm: 1.2,
    crossfadeKm: 0,
    points: [
      [0, 0],
      [1.2, 0],
    ],
  },
];

export function getCourseProfile(id) {
  return COURSE_PROFILES.find((p) => p.id === id) ?? COURSE_PROFILES[0];
}
