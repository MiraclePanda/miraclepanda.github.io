// 仮想コースの傾斜度プロファイル(距離[km] -> 勾配[%])。
// 要件定義書4章「初期2〜3種類(平坦寄り／丘陵／山岳)ハードコードで用意」に対応。
// 各points配列は [距離km, 勾配%] の制御点で、区間は線形補間する。
// loopLengthKm はこのプロファイル自体の1周分の長さ(最後の制御点の距離)。

export const COURSE_PROFILES = [
  {
    id: 'flat',
    name: '平坦コース',
    description: '起伏の少ない平坦基調のコース。ウォームアップや脚を回したい日向け。',
    loopLengthKm: 10,
    crossfadeKm: 0.15,
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
    description: '緩やかなアップダウンが連続する丘陵地帯のコース。',
    loopLengthKm: 15,
    crossfadeKm: 0.2,
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
    description: '長い上りを含む山岳コース。合計獲得標高を稼ぎたい日向け。',
    loopLengthKm: 20,
    crossfadeKm: 0.25,
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
];

export function getCourseProfile(id) {
  return COURSE_PROFILES.find((p) => p.id === id) ?? COURSE_PROFILES[0];
}
