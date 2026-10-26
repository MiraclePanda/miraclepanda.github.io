// 竜宮城の海底コースのリザルト画面の玉手箱。浦島太郎の言い伝え(の一説)「竜宮城の1日は地上の100年」に
// ならって、竜宮城で過ごした時間(ライドの経過時間)が地上では何年何か月にあたるかを求める。
// 見た目と文言だけで、記録・物理・トレーナーには関係しない。

export const LAND_YEARS_PER_RYUGU_DAY = 100;
const DAYS_PER_YEAR = 365.25;
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;

/**
 * 竜宮城で過ごした秒数 → 地上で過ぎた年・月・日(端数は切り捨て)。不正値・負の値は 0 とする。
 * @returns {{years:number, months:number, days:number}}
 */
export function landTimeFromRyuguS(seconds) {
  const s = Number(seconds);
  const ryuguDays = Number.isFinite(s) && s > 0 ? s / 86400 : 0;
  const landDays = ryuguDays * LAND_YEARS_PER_RYUGU_DAY * DAYS_PER_YEAR;
  // ちょうど割り切れる値が浮動小数点の誤差で1つ下に落ちないよう、わずかに足してから切り捨てる
  const EPS = 1e-9;
  const years = Math.floor(landDays / DAYS_PER_YEAR + EPS);
  const rest = Math.max(0, landDays - years * DAYS_PER_YEAR);
  const months = Math.floor(rest / DAYS_PER_MONTH + EPS);
  const days = Math.floor(Math.max(0, rest - months * DAYS_PER_MONTH) + EPS);
  return { years, months, days };
}

/** 「約2年1か月」「約3か月12日」「約5日」の形の文言。 */
export function landTimeLabel(seconds) {
  const { years, months, days } = landTimeFromRyuguS(seconds);
  if (years > 0) return `約${years}年${months > 0 ? `${months}か月` : ''}`;
  if (months > 0) return `約${months}か月${days > 0 ? `${days}日` : ''}`;
  return `約${days}日`;
}

/** 玉手箱の煙のあとのひとこと(地上で過ぎた年数で変える)。 */
export function tamatebakoComment(seconds) {
  const { years } = landTimeFromRyuguS(seconds);
  if (years >= 10) return 'ゆっくりしすぎました。おじいさんに……なっていません。たぶん気のせいです。';
  if (years >= 1) return '白い煙がもくもく……。鏡を見るのは、もう少しあとにしましょう。';
  return '煙はちょっぴり。まだまだ若いままです。';
}
