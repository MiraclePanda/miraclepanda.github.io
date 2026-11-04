// 旅の設定の入力値バリデーション(Trainer の validation.js から取り込み、旅向けに整理)。
// メートル法のみ(体重kg、自転車重量kg、荷物kg)。
// 転がり抵抗係数 Crr は路面で決まる(physics/surfaces.js)ので入力項目にしない。CdA は荷物込みの値を入力できる。
// FTP(W)はパワーの目安の基準。パワー補正の倍率は、トレーナーが送るパワーに掛ける係数(既定1.0。
// CYCPLUS DC1 の実機でパワーが実際より小さく出たため Trainer で追加されたもの)。

export const LIMITS = {
  weightKg: { min: 20, max: 200 },
  bikeWeightKg: { min: 3, max: 30 },
  // 荷物の合計(テント・寝袋・食料・水など)。空荷の 0 から、長旅のフル装備でも 40kg まで。
  packWeightKg: { min: 0, max: 40 },
  cdaM2: { min: 0.15, max: 0.6 },
  ftpW: { min: 50, max: 600 },
  powerScale: { min: 0.5, max: 5 },
};

export function validateWeight(value) {
  return inRange(value, LIMITS.weightKg, '体重は20〜200kgの範囲で入力してください。');
}

export function validateBikeWeight(value) {
  return inRange(value, LIMITS.bikeWeightKg, '自転車重量は3〜30kgの範囲で入力してください。');
}

export function validatePackWeight(value) {
  return inRange(value, LIMITS.packWeightKg, '荷物の重さは0〜40kgの範囲で入力してください。');
}

export function validateCda(value) {
  return inRange(value, LIMITS.cdaM2, '空気抵抗係数CdAは0.15〜0.6m²の範囲で入力してください。');
}

export function validateFtp(value) {
  return inRange(value, LIMITS.ftpW, 'FTPは50〜600Wの範囲で入力してください。');
}

export function validatePowerScale(value) {
  return inRange(value, LIMITS.powerScale, 'パワー補正の倍率は0.5〜5の範囲で入力してください。');
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
