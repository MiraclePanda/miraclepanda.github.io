// 体力・満腹度の変化と、走行中の失敗(ハンガーノック・疲労)の判定(設計書2章・4章)。純粋関数のみ。
//
// どちらも旅の時間(早回し倍率を掛けた後の分)で進むので、倍率を上げるほど1回のライドで減りやすい。
// 物理・トレーナーへの指示には使わない(表示と旅の判断だけ)。

export const BODY = {
  // 満腹度の減り(1旅時間あたり)。じっとしていても減る分 + パワー/FTP に比例する分
  SATIETY_BASE_PER_H: 5,
  SATIETY_WORK_PER_H: 12,
  // 体力の減り(1旅時間あたり)。3 + 22 × (パワー/FTP)²。FTP の6割で約11/時
  STAMINA_BASE_PER_H: 3,
  STAMINA_WORK_PER_H: 22,
  // 満腹度がこれ未満だと体力の減りが HUNGRY_FACTOR 倍
  HUNGRY_BELOW: 20,
  HUNGRY_FACTOR: 2,
  // 雨具なしで雨・スコールの中を走ると体力の減りがこの倍
  SOAKED_FACTOR: 1.5,
  // 止まって休んでいる間の体力の戻り(1旅時間あたり)
  STAMINA_REST_PER_H: 8,
  // 満腹度 0 のままこの旅時間(分)走るとハンガーノック
  KNOCK_AFTER_MIN: 15,
};

/** 日の入り(旅の時刻、分)の既定値。区間の場所が分からないときだけ使う(ふつうは季節と場所から sunsetMinutes で決める)。 */
export const SUNSET_MINUTES = 17 * 60;

/**
 * 日暮れの決まり。日の入りの WARN_BEFORE_MIN 分前(と日の入り)に道連れか土地の人が「そろそろ宿を」と声をかけ、
 * 日の入りから DARK_AFTER_MIN 分たって暗くなってから、はじめて野宿になる(景色も日の入りの 40 分後までに暗くなる)。
 */
export const DUSK = { WARN_BEFORE_MIN: [60, 20, 0], DARK_AFTER_MIN: 30 };

/** 体力がこの値を下回ったら声をかける(0 で動けなくなる前に、宿を探す・補給する余裕があるように)。 */
export const STAMINA_WARN = [25, 10];

/**
 * 体の状態を旅の時間 tripMinutes 分だけ進める。
 * @param {{stamina:number, satiety:number, zeroSatietyMinutes?:number}} rider
 * @param {{tripMinutes:number, powerW:number, ftpW:number, resting?:boolean, soaked?:boolean}} p soaked = 雨具なしで雨の中
 * @returns 新しい rider(元は変えない)
 */
export function stepBody(rider, { tripMinutes, powerW, ftpW, resting = false, soaked = false }) {
  const h = Math.max(0, tripMinutes) / 60;
  const ratio = resting ? 0 : Math.max(0, powerW) / Math.max(1, ftpW);
  const satiety = clamp100(rider.satiety - h * (BODY.SATIETY_BASE_PER_H + BODY.SATIETY_WORK_PER_H * ratio));
  let staminaDelta;
  if (resting) {
    staminaDelta = h * BODY.STAMINA_REST_PER_H;
  } else {
    const hungry = rider.satiety < BODY.HUNGRY_BELOW ? BODY.HUNGRY_FACTOR : 1;
    staminaDelta = -h * (BODY.STAMINA_BASE_PER_H + BODY.STAMINA_WORK_PER_H * ratio * ratio) * hungry * (soaked ? BODY.SOAKED_FACTOR : 1);
  }
  const zero = satiety <= 0 && !resting ? (rider.zeroSatietyMinutes ?? 0) + Math.max(0, tripMinutes) : 0;
  return { ...rider, satiety, stamina: clamp100(rider.stamina + staminaDelta), zeroSatietyMinutes: zero };
}

/**
 * 走行中の失敗を判定する。日没は、日の入り sunsetMinutes から DUSK.DARK_AFTER_MIN 分たって暗くなったとき。
 * @returns {'hungerKnock'|'exhausted'|'sunset'|null}
 */
export function checkFailure(rider, clockMinutes, sunsetMinutes = SUNSET_MINUTES) {
  if ((rider.zeroSatietyMinutes ?? 0) >= BODY.KNOCK_AFTER_MIN) return 'hungerKnock';
  if (rider.stamina <= 0) return 'exhausted';
  if (clockMinutes >= sunsetMinutes + DUSK.DARK_AFTER_MIN) return 'sunset';
  return null;
}

/** 体力が下がったときの「上限パワーの目安」(表示のみ)。体力 100 で FTP、0 で FTP の半分。 */
export function sustainableWatts(stamina, ftpW) {
  return Math.round(ftpW * (0.5 + 0.5 * clamp100(stamina) / 100));
}

/** 表示用のことば。 */
export function satietyLabel(satiety) {
  if (satiety >= 70) return '満腹';
  if (satiety >= 40) return 'ふつう';
  if (satiety >= BODY.HUNGRY_BELOW) return '小腹がすいた';
  if (satiety > 0) return 'お腹ぺこぺこ';
  return 'ハンガーノック寸前';
}

export function clamp100(x) {
  return Math.min(100, Math.max(0, x));
}
