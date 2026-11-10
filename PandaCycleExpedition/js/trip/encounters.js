// 道ばたの出会い(区間の決まった出会いとは別に、ところどころで起きるもの)の話の一覧と、選び方。純粋な関数とデータだけ。
//
// 何ヶ月も走っても同じ話ばかりにならないように、どこでも起きる話に、地方・季節・海沿いか山道か で起きる話を足して、
// その日の区間で起きうるものから選ぶ。同じ日の中では同じ話をくり返さず、最近の日誌に出た話もなるべく避ける。
// 競争や急かす話は入れない(このアプリは楽しく走るのが目的)。gift は差し入れ(満腹度が少し上がる)。
//
// 各項目: { id, text, gift?, region?, season?, where? }
//   region: 地方 id(tools/segments/regions/<id>.json)。無ければどの地方でも
//   season: 'spring' | 'summer' | 'autumn' | 'winter'。無ければいつでも
//   where:  'sea'(海沿いの区間)| 'hill'(上りの多い区間)。無ければどこでも

export const ROADSIDE_TALES = [
  // ---- どこでも ----
  { id: 'granny', text: '散歩中のおばあさん「その荷物でどこまで行くの?気をつけてね」' },
  { id: 'kei-truck', text: '軽トラのおじさん「この先はトンネルが続くから、ライトをつけてな」' },
  { id: 'students', text: '地元の高校生が手を振ってくれた。' },
  { id: 'cyclist', text: 'サイクリストとすれ違った。「グッドライド!」' },
  { id: 'dog', text: '柴犬を連れた人が立ち止まって、犬がしっぽを振っている。' },
  { id: 'kids', text: '小学生の列が「がんばれー!」と声をそろえた。' },
  { id: 'postman', text: '郵便配達のバイクが追い越しぎわに会釈していった。' },
  { id: 'vending', text: '自動販売機の前で休んでいた人「この先に、景色のいいベンチがあるよ」' },
  { id: 'farmer', text: '畑の人「どこから来たの?へえ、自転車で!」' },
  { id: 'cat', text: '塀の上の猫が、こちらをじっと見送っている。' },
  { id: 'bus-stop', text: 'バス停のおじいさん「若いっていいねえ。わしも昔は自転車で峠を越えたもんだ」' },
  { id: 'shop-lady', text: '商店のおかみさん「お茶でも飲んでいきなさい」', gift: { name: '冷たいお茶', satiety: 3 } },
  { id: 'tourer', text: '同じように荷物を積んだ旅の人とすれ違い、手を上げあった。' },
  { id: 'map-check', text: '地図を見ていたら、通りがかりの人が道を教えてくれた。' },
  // ---- 海沿い ----
  { id: 'fisher', text: '釣り帰りの人「今日は海が穏やかでいいね」', where: 'sea' },
  { id: 'surfer', text: 'サーフボードを抱えた人「波はいまいちだけど、走るにはいい風だね」', where: 'sea' },
  { id: 'gulls', text: 'カモメの群れが、しばらく横を飛んでいた。', where: 'sea' },
  { id: 'port-uncle', text: '港のおじさん「朝どれのアジだ。焼いて食べな」', gift: { name: 'アジの干物の試食', satiety: 4 }, where: 'sea' },
  // ---- 上り坂 ----
  { id: 'hill-uncle', text: '坂の途中の家のおじさん「ここを自転車で上るとはなあ。水、持ってくか?」', gift: { name: '冷たい水', satiety: 2 }, where: 'hill' },
  { id: 'hill-hikers', text: 'ハイキングの人たち「上から見る景色がきれいですよ」', where: 'hill' },
  { id: 'hill-monkey', text: '道ばたの木で、サルがこちらをうかがっている。', where: 'hill' },
  // ---- 伊豆半島 ----
  { id: 'izu-mikan', text: 'みかん農家さん「ひとつ持っていきな」', gift: { name: 'みかん', satiety: 6 }, region: 'izu' },
  { id: 'izu-himono', text: '干物屋さん「試食していきなよ」', gift: { name: 'アジの干物の試食', satiety: 4 }, region: 'izu' },
  { id: 'izu-onsen', text: '湯上がりの人「この先の共同浴場、自転車の人にも評判だよ」', region: 'izu' },
  { id: 'izu-wasabi', text: 'わさび田の人「天城の水は冷たいぞ。手を洗っていきな」', region: 'izu', where: 'hill' },
  { id: 'izu-kinme', text: '漁師さん「今朝は金目がよく揚がった。どこかで煮付けを食べな」', region: 'izu', where: 'sea' },
  { id: 'izu-lava', text: '地元の人「このあたりの岩は、昔の火山の溶岩なんだよ」', region: 'izu' },
  { id: 'izu-oshima', text: '展望所の人「晴れていると、海の向こうに大島が見えるよ」', region: 'izu', where: 'sea' },
  // ---- 静岡 ----
  { id: 'sz-tea', text: 'お茶農家さん「一番茶じゃないけど、うまいよ」', gift: { name: '温かいお茶', satiety: 3 }, region: 'shizuoka' },
  { id: 'sz-fuji', text: '地元の人「今日は富士山がよく見える日だね」', region: 'shizuoka' },
  { id: 'sz-oden', text: '駄菓子屋さん「静岡おでん、一本どう?」', gift: { name: '静岡おでん', satiety: 8 }, region: 'shizuoka' },
  { id: 'sz-tokaido', text: '旧街道を歩く人「東海道を歩いて京都まで行くんです。お互い、のんびり行きましょう」', region: 'shizuoka' },
  { id: 'sz-sakuraebi', text: '港の人「桜えびの季節になると、浜がピンクに染まるんだよ」', region: 'shizuoka', where: 'sea' },
  { id: 'sz-soccer', text: 'サッカーボールを蹴る子どもたちが手を振った。', region: 'shizuoka' },
  // ---- 春 ----
  { id: 'sp-sakura', text: '桜の花びらが、風に乗って顔にあたった。', season: 'spring' },
  { id: 'sp-picnic', text: 'お花見の人たち「団子、ひとつどうぞ」', gift: { name: '花見団子', satiety: 6 }, season: 'spring' },
  { id: 'sp-tsubame', text: 'ツバメが低く飛んでいく。巣作りの季節だ。', season: 'spring' },
  // ---- 夏 ----
  { id: 'su-semi', text: 'セミの声がにぎやか。木陰がありがたい。', season: 'summer' },
  { id: 'su-ice', text: '店先のおばあさん「暑いでしょう。アイス、おまけね」', gift: { name: 'アイスキャンディー', satiety: 4 }, season: 'summer' },
  { id: 'su-kids-water', text: '川で遊ぶ子どもたちの声が聞こえる。', season: 'summer' },
  // ---- 秋 ----
  { id: 'au-kaki', text: '庭先の人「柿がたくさんなったから、持っていって」', gift: { name: '柿', satiety: 6 }, season: 'autumn' },
  { id: 'au-akatombo', text: '赤とんぼが、ハンドルのそばをついてくる。', season: 'autumn' },
  { id: 'au-yakiimo', text: '焼き芋の軽トラのおじさん「ほら、熱いうちに」', gift: { name: '焼き芋', satiety: 10 }, season: 'autumn' },
  // ---- 冬 ----
  { id: 'wi-amazake', text: 'お寺の前で甘酒をふるまっていた。', gift: { name: '甘酒', satiety: 6 }, season: 'winter' },
  { id: 'wi-breath', text: '畑の人「冷えるねえ。手袋はあるかい?」', season: 'winter' },
  { id: 'wi-clear', text: '空気が澄んで、遠くの山まではっきり見える。', season: 'winter' },
];

/** 通し日(1月1日 = 1)から季節: 3〜5月 = 春、6〜8月 = 夏、9〜11月 = 秋、12〜2月 = 冬。 */
export function seasonOfDay(doy) {
  const d = ((Math.round(doy) - 1) % 365 + 365) % 365 + 1;
  if (d >= 60 && d < 152) return 'spring';
  if (d >= 152 && d < 244) return 'summer';
  if (d >= 244 && d < 335) return 'autumn';
  return 'winter';
}

/** 区間の様子: 海沿いか(seaSide が none でない)、上りの多い区間か(1 km あたり 15 m 以上上る)。 */
export function segmentTags(segment) {
  const tags = new Set();
  if (segment.seaSide && segment.seaSide !== 'none') tags.add('sea');
  if ((segment.climbM ?? 0) / Math.max(1, segment.lengthM / 1000) >= 15) tags.add('hill');
  return tags;
}

/**
 * その区間・季節で起きうる道ばたの出会い。
 * @param {object} segment 区間(region・seaSide・climbM・lengthM)
 * @param {string|null} season seasonOfDay の値。null なら季節の話は出さない
 */
export function talesFor(segment, season = null) {
  const tags = segmentTags(segment);
  return ROADSIDE_TALES.filter((t) => (!t.region || t.region === segment.region)
    && (!t.season || t.season === season)
    && (!t.where || tags.has(t.where)));
}

/**
 * 候補から1つ選ぶ。その日にもう出た話(usedIds)は選ばず、最近の日誌に出た話(recentIds)はなるべく避ける。
 * 季節・地方・海や山の話は、どこでも起きる話より少し出やすくする(その土地らしさが出るように)。
 * @param {() => number} rnd 0〜1 の乱数(seed つき)
 * @returns {object|null}
 */
export function pickTale(tales, rnd, usedIds = new Set(), recentIds = new Set()) {
  const fresh = tales.filter((t) => !usedIds.has(t.id));
  if (fresh.length === 0) return null;
  const weight = (t) => (recentIds.has(t.id) ? 0.15 : 1) * (t.region || t.season || t.where ? 1.6 : 1);
  const sum = fresh.reduce((a, t) => a + weight(t), 0);
  let r = rnd() * sum;
  for (const t of fresh) {
    r -= weight(t);
    if (r < 0) return t;
  }
  return fresh[fresh.length - 1];
}

/** 旅の日誌の最近 days 日(と走行中の日)に出た道ばたの出会いの話の id。 */
export function recentTaleIds(trip, days = 5) {
  const ids = new Set();
  const logs = [...(trip.log ?? []).slice(-days), trip.ride].filter(Boolean);
  for (const d of logs) for (const e of d.encounters ?? []) if (e.tale) ids.add(e.tale);
  return ids;
}
