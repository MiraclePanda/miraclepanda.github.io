// セットアップ画面「③ コース選択」のタイル表示用の分類・アイコン。表示だけに使い、物理演算や
// トレーナーへの指示には関わらない(コースの中身は physics/courseProfiles.js)。
// 新しいコースを足したらここにも1行足す(無ければ「観光・おでかけ」の末尾に🚲で並ぶ)。

export const COURSE_GROUPS = [
  { id: 'training', title: '🚴 トレーニング' },
  { id: 'outing', title: '🗾 観光・おでかけ' },
];

// 並び順もこの順。熱海は景色を作り直している実験中のコースなので、観光・おでかけの最後に置く。
const CATALOG = [
  { id: 'flat', group: 'training', icon: '🏙️' },
  { id: 'hilly', group: 'training', icon: '🌳' },
  { id: 'mountain', group: 'training', icon: '⛰️' },
  { id: 'ueno', group: 'outing', icon: '🦢' },
  { id: 'fuji', group: 'outing', icon: '🗻' },
  { id: 'kyoto', group: 'outing', icon: '⛩️' },
  { id: 'nara', group: 'outing', icon: '🦌' },
  { id: 'ryugu', group: 'outing', icon: '🐢' },
  { id: 'atami', group: 'outing', icon: '🏖️', experimental: true },
];

/** コースの表示情報 { group, icon, experimental }。 */
export function courseMeta(profile) {
  if (profile.fixedLength) return { group: 'gpx', icon: '📍', experimental: false };
  const m = CATALOG.find((c) => c.id === profile.id);
  return m ? { experimental: false, ...m } : { group: 'outing', icon: '🚲', experimental: false };
}

/** グループごとに並べた組み込みコース [{ group, courses }]。 */
export function groupBuiltinCourses(profiles) {
  const order = (p) => {
    const i = CATALOG.findIndex((c) => c.id === p.id);
    return i < 0 ? CATALOG.length : i;
  };
  const sorted = [...profiles].sort((a, b) => order(a) - order(b));
  return COURSE_GROUPS.map((g) => ({ group: g, courses: sorted.filter((p) => courseMeta(p).group === g.id) }));
}

/** タイルに出す短い名前(末尾の「コース」を省く。詳細パネルには正式名を出す)。 */
export function tileName(name) {
  return name.replace(/コース$/, '');
}

/** タイルに出す1行の要約。 */
export function courseSummary(profile) {
  const len = `1周${formatKm(profile.loopLengthKm)}km`;
  if (profile.fixedVehicle === 'swan') return `${len}・スワン`;
  if (profile.tag) return `${len}・${profile.tag}`;
  return `${len}・${TRAINING_FEEL[profile.id] ?? '周回'}`;
}

const TRAINING_FEEL = { flat: '平坦', hilly: '起伏あり', mountain: '長い上り', atami: '海沿い' };

function formatKm(km) {
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}
