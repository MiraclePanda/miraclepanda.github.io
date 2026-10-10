// 消費カロリーのグルメ換算(「ラーメン0.7杯分」など)。走行中の表示・通知とリザルト画面で使う。
// 消費カロリーはペダルを回した仕事量(パワー×時間)から推定する:
//   人の体が食べ物のエネルギーを自転車の仕事に変える効率(グロス効率)を約24%とすると、
//   消費カロリー(kcal) = 仕事量(kJ) ÷ 4.184 ÷ 0.24 ≒ 仕事量(kJ) × 1.0
// あくまで目安(体格・心拍・基礎代謝は考えない)。物理演算・トレーナーの負荷には関係しない。

export const GROSS_EFFICIENCY = 0.24;
const KJ_PER_KCAL = 4.184;

/** 定番の食べ物(1単位あたりの kcal は一般的な目安)。小さい順。 */
export const FOODS = [
  { id: 'onsenmanju', name: '温泉まんじゅう', unit: '個', kcal: 80 },
  { id: 'onigiri', name: 'おにぎり', unit: '個', kcal: 180 },
  { id: 'beer', name: '生ビール(中)', unit: '杯', kcal: 200 },
  { id: 'nikuman', name: '肉まん', unit: '個', kcal: 250 },
  { id: 'cake', name: 'ショートケーキ', unit: '個', kcal: 350 },
  { id: 'takoyaki', name: 'たこ焼き(8個入り)', unit: '舟', kcal: 400 },
  { id: 'ramen', name: 'ラーメン', unit: '杯', kcal: 500 },
  { id: 'gyudon', name: '牛丼(並)', unit: '杯', kcal: 650 },
  { id: 'katsudon', name: 'カツ丼', unit: '杯', kcal: 900 },
];

const RAMEN = FOODS.find((f) => f.id === 'ramen');

/** 仕事量(kJ)→ 消費カロリー(kcal)。不正値は 0。 */
export function kcalFromWorkKj(workKj) {
  const kj = Number(workKj);
  if (!Number.isFinite(kj) || kj <= 0) return 0;
  return kj / KJ_PER_KCAL / GROSS_EFFICIENCY;
}

/** 1秒ごとのサンプル(powerW)から仕事量(kJ)を求める(記録に workKj が無い古い記録用)。 */
export function workKjFromSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = Number(samples[i]?.powerW);
    if (!Number.isFinite(p) || p <= 0) continue;
    // サンプル間隔は tOffsetS の差(一時停止をまたぐ大きな差は1秒として数える)
    const dt = i === 0 ? 1 : Number(samples[i].tOffsetS) - Number(samples[i - 1].tOffsetS);
    j += p * (Number.isFinite(dt) && dt > 0 && dt <= 5 ? dt : 1);
  }
  return j / 1000;
}

/** 記録の消費カロリー(kcal)。 */
export function recordKcal(record) {
  const kj = Number.isFinite(record?.workKj) ? record.workKj : workKjFromSamples(record?.samples);
  return kcalFromWorkKj(kj);
}

/** コースの名物(courseProfile.localFood = { name, unit, kcal })があれば定番の前に足した一覧。 */
export function foodsFor(courseProfile) {
  const lf = courseProfile?.localFood;
  if (lf && typeof lf.name === 'string' && Number(lf.kcal) > 0) {
    return [{ id: 'local', name: lf.name, unit: lf.unit ?? '個', kcal: Number(lf.kcal), local: true }, ...FOODS];
  }
  return FOODS;
}

/** 「おにぎり 1.4個分」の数量部分。1未満は小数1桁、10未満も小数1桁、それ以上は整数。 */
export function fmtAmount(x) {
  if (!Number.isFinite(x) || x <= 0) return '0';
  return x < 10 ? (Math.round(x * 10) / 10).toFixed(1) : String(Math.round(x));
}

/**
 * 走行中に出す換算の1行。消費カロリーに一番近い「1個以上になる中で一番大きい」食べ物で言う
 * (まだ一番小さいものにも届かないときは、それの何個分か)。名物があるコースは名物を優先する。
 */
export function gourmetLine(kcal, courseProfile) {
  const k = Math.max(0, Number(kcal) || 0);
  const foods = foodsFor(courseProfile);
  const local = foods.find((f) => f.local);
  if (local && k >= local.kcal * 0.2 && k < local.kcal * 20) return `${local.name} ${fmtAmount(k / local.kcal)}${local.unit}分`;
  let pick = FOODS[0];
  for (const f of FOODS) if (k >= f.kcal) pick = f;
  return `${pick.name} ${fmtAmount(k / pick.kcal)}${pick.unit}分`;
}

/**
 * 走行中の通知: 前回から今回までに越えた節目(定番の食べ物それぞれの1個分、以降はラーメン1杯ごと)。
 * @returns {object|null} 通知(RideScreen の showToast の形)
 */
export function gourmetMilestone(prevKcal, kcal, courseProfile) {
  const a = Number(prevKcal) || 0;
  const b = Number(kcal) || 0;
  if (!(b > a)) return null;
  const foods = foodsFor(courseProfile);
  let hit = null;
  for (const f of foods) if (a < f.kcal && b >= f.kcal) hit = { food: f, n: 1 };
  // ラーメン2杯分以降は500kcalごと
  const ramenA = Math.floor(a / RAMEN.kcal);
  const ramenB = Math.floor(b / RAMEN.kcal);
  if (ramenB >= 2 && ramenB > ramenA) hit = { food: RAMEN, n: ramenB };
  if (!hit) return null;
  const { food, n } = hit;
  return {
    kind: 'gourmet',
    kicker: '🍜 グルメ換算',
    title: `${food.name} ${n}${food.unit}分を消費しました`,
    sub: n >= 2 ? `累計 ${Math.round(b)}kcal。替え玉も視野に入ってきました。` : `累計 ${Math.round(b)}kcal。この調子でいきましょう。`,
  };
}

/**
 * リザルト画面の「今日のごほうび」。食べてよい量の一覧と、ひとこと。
 * @returns {{kcal:number, headline:string, comment:string, items:Array<{name,unit,amount:string,local?:boolean}>}}
 */
export function gourmetVerdict(kcal, courseProfile) {
  const k = Math.max(0, Number(kcal) || 0);
  const foods = foodsFor(courseProfile);
  const items = foods
    .filter((f) => f.local || ['onigiri', 'beer', 'cake', 'ramen', 'katsudon'].includes(f.id))
    .map((f) => ({ name: f.name, unit: f.unit, amount: fmtAmount(k / f.kcal), local: !!f.local }));
  let headline;
  let comment;
  if (k < FOODS[0].kcal) {
    headline = `温泉まんじゅう ${fmtAmount(k / FOODS[0].kcal)}個分`;
    comment = 'ウォームアップおつかれさまでした。まんじゅうは半分にしておきましょう。';
  } else if (k < RAMEN.kcal) {
    const f = [...FOODS].reverse().find((x) => k >= x.kcal);
    headline = `${f.name} ${fmtAmount(k / f.kcal)}${f.unit}分`;
    comment = 'ちょうどいいおやつの時間です。';
  } else if (k < 1000) {
    headline = `ラーメン ${fmtAmount(k / RAMEN.kcal)}杯分`;
    comment = '本日はラーメン1杯までなら罪悪感ゼロです。';
  } else {
    headline = `ラーメン ${fmtAmount(k / RAMEN.kcal)}杯分`;
    comment = '替え玉もトッピングも許されました。ただし食べすぎ注意。';
  }
  return { kcal: k, headline, comment, items };
}
