// 初期セットアップの入力値バリデーション。
// 要件定義書5章「常識的な範囲でmin/max属性＋簡易メッセージによるバリデーション」に対応。
// メートル法のみ(体重kg、自転車重量kg、距離km)。
// 詳細設定の転がり抵抗係数Crr・空気抵抗係数CdA(m^2)も同じ仕組みで検証する。
// FTP(W)はパワーゾーン表示(utils/zones.js)の基準。PR2+3 仕様 §1.1 で追加(既定200W)。

export const LIMITS = {
  weightKg: { min: 20, max: 200 },
  bikeWeightKg: { min: 3, max: 30 },
  distanceKm: { min: 0.1, max: 300 },
  crr: { min: 0.001, max: 0.02 },
  cdaM2: { min: 0.15, max: 0.6 },
  ftpW: { min: 50, max: 600 },
};

export function validateWeight(value) {
  return inRange(value, LIMITS.weightKg, '体重は20〜200kgの範囲で入力してください。');
}

export function validateBikeWeight(value) {
  return inRange(value, LIMITS.bikeWeightKg, '自転車重量は3〜30kgの範囲で入力してください。');
}

/**
 * @param {number} [maxKm] コース長で上限を絞る場合(GPX の実在コース)。LIMITS の上限より小さいときだけ効く。
 */
export function validateDistance(value, maxKm) {
  if (Number.isFinite(maxKm) && maxKm < LIMITS.distanceKm.max) {
    const max = maxDistanceForCourse(maxKm);
    return inRange(value, { min: LIMITS.distanceKm.min, max }, `このコースの走行距離は${LIMITS.distanceKm.min}〜${max}km(コース全長)の範囲で入力してください。`);
  }
  return inRange(value, LIMITS.distanceKm, '走行距離は0.1〜300kmの範囲で入力してください。');
}

/** コース全長を走行距離の入力値にするときの丸め(0.01km 単位で切り捨て、全長を超えないように)。 */
export function floorTo2(km) {
  return Math.floor(km * 100 + 1e-9) / 100;
}

/** 実在コースで入力できる走行距離の上限(コース全長。ただし LIMITS の上限は超えない)。 */
export function maxDistanceForCourse(courseKm) {
  return Math.min(LIMITS.distanceKm.max, floorTo2(courseKm));
}

export function validateCrr(value) {
  return inRange(value, LIMITS.crr, '転がり抵抗係数は0.001〜0.02の範囲で入力してください。');
}

export function validateCda(value) {
  return inRange(value, LIMITS.cdaM2, '空気抵抗係数CdAは0.15〜0.6m²の範囲で入力してください。');
}

export function validateFtp(value) {
  return inRange(value, LIMITS.ftpW, 'FTPは50〜600Wの範囲で入力してください。');
}

function inRange(value, { min, max }, message) {
  if (value === '' || value === null || value === undefined || Number.isNaN(Number(value))) {
    return { valid: false, message: '数値を入力してください。' };
  }
  const n = Number(value);
  if (n < min || n > max) {
    return { valid: false, message };
  }
  return { valid: true, message: null };
}
