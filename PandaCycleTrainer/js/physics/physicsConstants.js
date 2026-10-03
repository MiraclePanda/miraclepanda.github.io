// 物理演算の内部定数。要件定義書3章では当初ユーザー入力項目に含めない仕様だったが、
// ユーザー要望によりCRR/CDAはセットアップ画面の「詳細設定」で変更できるようにした
// (ここの値はその既定値。範囲はjs/utils/validation.jsのLIMITS.crr/cdaM2)。

export const PhysicsConstants = {
  // 転がり抵抗係数 (Crr)。ロードバイク+スマートトレーナーの一般的な実測値レンジ内で選定。
  CRR: 0.004,
  // 空気抵抗係数 CdA (m^2)。ドロップバー姿勢の一般的な値。
  CDA: 0.32,
  // 空気密度 (kg/m^3)。海抜0m・15℃相当。
  AIR_DENSITY: 1.225,
  // 屋内走行のため風速は常に0固定。
  WIND_SPEED_MPS: 0,
  // 重力加速度 (m/s^2)。
  GRAVITY: 9.80665,
  // v=0付近でのF_drive = power/v の特異点回避用の下限速度 (m/s)。
  MIN_SPEED_FOR_DRIVE_FORCE: 0.5,
  // ERGモード時、grade相当の目標Wを逆算する際の基準速度 (m/s, 約21.6km/h)。
  // 停止付近で目標Wが0に張り付いてしまうのを避けるための下駄。
  // ERGモードの負荷換算式自体、実機での検証が必要な暫定仕様(要件定義書8章)。
  ERG_REFERENCE_SPEED_MPS: 6.0,
  // 明らかに非現実的な値を弾くための速度上限 (m/s, 約110km/h)。
  MAX_SPEED_MPS: 30,
  // ドラフティング(集団の後ろについて風よけにする)の判定と効果。
  // 前のライダー(集団のみ。ゴーストは対象外)との車間が MIN〜MAX(両端含む)で、
  // 横のずれが MAX_LATERAL 未満のとき、空気抵抗の CdA に DRAFT_CDA_FACTOR を掛ける。
  DRAFT_MIN_GAP_M: 0.5,
  DRAFT_MAX_GAP_M: 6.0,
  DRAFT_MAX_LATERAL_M: 1.0,
  DRAFT_CDA_FACTOR: 0.66,
};

// BLE受信値の異常値バリデーション用の上限(簡易チェック)。
export const ValidationLimits = {
  MAX_POWER_W: 2500,
  MAX_CADENCE_RPM: 220,
  MAX_HEART_RATE_BPM: 240,
};
