// Day 1 の区間: 熱海サンビーチ → 国道135号を南下 → 網代 → 宇佐美 → 伊東(設計書6章)。
//
// ⚠ 仮のデータ: 地形(勾配・トンネル)は国土地理院の道路中心線と標高から作る予定で、まだ入っていない
// (いまは全区間 0% の平坦)。地点の位置もおおよその値。実データができたらこのファイルを差し替える。

const LENGTH_M = 17000;
const STEP_M = 50;

export const ATAMI_ITO = {
  id: 'atami-ito',
  name: '熱海サンビーチ → 伊東',
  goalName: '伊東',
  provisional: true,
  lengthM: LENGTH_M,
  stepM: STEP_M,
  startElevM: 3,
  grades: new Array(LENGTH_M / STEP_M).fill(0),
  surfaces: [{ fromM: 0, surface: 'paved' }],
  tunnels: [],
  places: [
    { atM: 0, id: 'atami', name: '熱海', kind: 'town', text: '熱海サンビーチを出発。海沿いの国道135号を南へ。' },
    { atM: 300, id: 'atami-onsen', name: '温泉まんじゅうの店', kind: 'food', menu: [{ name: '温泉まんじゅう', yen: 300, satiety: 12 }] },
    { atM: 2200, id: 'nishikigaura', name: '錦ヶ浦', kind: 'sight', text: '錦ヶ浦の断崖。眼下に相模灘が広がる。' },
    { atM: 5500, id: 'taga', name: '多賀', kind: 'town' },
    { atM: 6000, id: 'taga-conbini', name: '多賀のコンビニ', kind: 'shop', menu: [
      { name: 'おにぎり', yen: 150, satiety: 15 }, { name: 'あんパン', yen: 140, satiety: 14 },
    ] },
    { atM: 8600, id: 'ajiro-himono', name: '網代の干物屋', kind: 'encounter', text: '干物屋のおばちゃん「網代のアジは脂がのってておいしいよ」' },
    { atM: 9000, id: 'ajiro', name: '網代', kind: 'town' },
    { atM: 9200, id: 'ajiro-shokudo', name: '網代の食堂', kind: 'food', menu: [
      { name: 'アジの干物定食', yen: 1500, satiety: 50 }, { name: '海鮮丼', yen: 2200, satiety: 60 },
    ] },
    { atM: 13500, id: 'usami', name: '宇佐美', kind: 'town' },
    { atM: 13700, id: 'usami-stay', name: '宇佐美の海岸', kind: 'lodging', options: [
      { kind: 'guesthouse', name: '宇佐美のゲストハウス', yen: 4500 }, { kind: 'park', name: '宇佐美の海岸の公園', yen: 0 },
    ] },
    { atM: 15500, id: 'ito-local', name: '地元のサイクリスト', kind: 'encounter', text: '地元のサイクリスト「伊東はもうすぐ。温泉でゆっくりしてね」' },
    { atM: 16500, id: 'ito', name: '伊東', kind: 'town' },
    { atM: 16900, id: 'ito-stay', name: '伊東の温泉街', kind: 'lodging', options: [
      { kind: 'hotel', name: '伊東の温泉旅館', yen: 9800 }, { kind: 'guesthouse', name: '伊東のゲストハウス', yen: 4500 },
    ] },
  ],
};
