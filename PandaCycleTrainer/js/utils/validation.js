// 初期セットアップの入力値バリデーション。
// 要件定義書5章「常識的な範囲でmin/max属性＋簡易メッセージによるバリデーション」に対応。
// メートル法のみ(体重kg、自転車重量kg、距離km)。

export const LIMITS = {
  weightKg: { min: 20, max: 200 },
  bikeWeightKg: { min: 3, max: 30 },
  distanceKm: { min: 0.1, max: 300 },
};

export function validateWeight(value) {
  return inRange(value, LIMITS.weightKg, '体重は20〜200kgの範囲で入力してください。');
}

export function validateBikeWeight(value) {
  return inRange(value, LIMITS.bikeWeightKg, '自転車重量は3〜30kgの範囲で入力してください。');
}

export function validateDistance(value) {
  return inRange(value, LIMITS.distanceKm, '走行距離は0.1〜300kmの範囲で入力してください。');
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
