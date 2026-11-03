// 物理演算の内部定数(Trainer の physicsConstants.js から取り込み、旅向けに変更)。
// CRR/CDA は「トレーナーが標準で想定している抵抗」(Trainer と同じ値)で、FTMS の Simulation
// Parameters にもこの値を送る。旅で増える抵抗(荷物・路面・バッグ・向かい風)は
// physics/surfaces.js の extraGradePercent() で等価勾配に換算して勾配指示に上乗せする(設計書3章)。

export const PhysicsConstants = {
  // トレーナーへ送る基準の転がり抵抗係数 (Crr)。ロードバイク+スマートトレーナーの一般的な値。
  // 旅の物理の Crr は路面で決まる(physics/surfaces.js の SURFACES)。
  CRR: 0.004,
  // トレーナーへ送る基準の空気抵抗係数 CdA (m^2)。ドロップバー姿勢の一般的な値。
  CDA: 0.32,
  // 旅の物理の CdA (m^2)。グラベルバイクにフロント・サドル・フレームバッグを積んだ状態(設計書3章)。
  LOADED_CDA: 0.40,
  // 雨の後(路面が濡れている)の未舗装路の Crr 倍率。舗装路には掛けない。
  WET_UNPAVED_CRR_FACTOR: 1.3,
  // スコール中の向かい風 (m/s, 約22km/h)。晴れ・曇り・雨は無風。
  // 空気密度 (kg/m^3)。海抜0m・15℃相当。
  AIR_DENSITY: 1.225,
  SQUALL_HEADWIND_MPS: 6,
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
  // コーナーでの減速(区間データに方位があるとき。js/physics/cornering.js)。
  // 横方向の加速度の上限 (m/s^2, 約0.2G)。一般のサイクリストが無理なく曲がれる程度。
  // GPX の直角の交差点(角度からの見積もりで半径約10m、cornering.js)で約16km/h、
  // 半径15mのヘアピンで約20km/h になる。当初は 3.0 だったが、実走の GPX の記録
  // (交差点を 10 km/h 前後で曲がっている)と比べて速すぎたため下げた(2026-10)。
  CORNER_LATERAL_ACCEL_MPS2: 2.0,
  // コーナー手前のブレーキの減速度 (m/s^2)。急ブレーキではない普通の減速。
  CORNER_BRAKE_DECEL_MPS2: 2.5,
};

// BLE受信値の異常値バリデーション用の上限(簡易チェック)。
export const ValidationLimits = {
  MAX_POWER_W: 2500,
  MAX_CADENCE_RPM: 220,
  MAX_HEART_RATE_BPM: 240,
};
