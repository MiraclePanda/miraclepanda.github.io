// Bluetooth GATT Fitness Machine Service (FTMS) と関連サービスの定数群。
// UUID・opcode・フラグビットの値はBluetooth SIG公開仕様
// (Fitness Machine Service v1.0, User Data Service v1.0,
//  Cycling Power Service v1.1, Cycling Speed and Cadence Service v1.0)
// に基づく。実機(CYCPLUS DC1)でのアドバタイズ内容・対応特性は
// 実機確認が必要 (要件定義書 8章参照)。

// ---- Service UUID ----
export const FTMS_SERVICE = 0x1826;
export const USER_DATA_SERVICE = 0x181c;
export const CYCLING_POWER_SERVICE = 0x1818;
export const CSC_SERVICE = 0x1816;

// ---- FTMS Characteristics ----
export const CHAR_FTMS_FEATURE = 0x2acc;
export const CHAR_INDOOR_BIKE_DATA = 0x2ad2;
export const CHAR_FTMS_CONTROL_POINT = 0x2ad9;
export const CHAR_FTMS_STATUS = 0x2ada;
export const CHAR_SUPPORTED_RESISTANCE_RANGE = 0x2ad6;
export const CHAR_SUPPORTED_POWER_RANGE = 0x2ad8;

// ---- User Data Service Characteristics ----
export const CHAR_USER_INDEX = 0x2a9a;
export const CHAR_USER_CONTROL_POINT = 0x2a9f;
export const CHAR_UDS_WEIGHT = 0x2a98;

// ---- Cycling Power Service Characteristics ----
export const CHAR_CYCLING_POWER_MEASUREMENT = 0x2a63;

// ---- Cycling Speed and Cadence Characteristics ----
export const CHAR_CSC_MEASUREMENT = 0x2a5b;

// ---- Fitness Machine Control Point OpCode ----
export const OP_REQUEST_CONTROL = 0x00;
export const OP_RESET = 0x01;
export const OP_SET_TARGET_SPEED = 0x02;
export const OP_SET_TARGET_INCLINATION = 0x03;
export const OP_SET_TARGET_RESISTANCE_LEVEL = 0x04;
export const OP_SET_TARGET_POWER = 0x05;
export const OP_SET_TARGET_HEART_RATE = 0x06;
export const OP_START_OR_RESUME = 0x07;
export const OP_STOP_OR_PAUSE = 0x08;
export const OP_SET_INDOOR_BIKE_SIMULATION_PARAMS = 0x11;
export const OP_RESPONSE_CODE = 0x80;

// 上記OpCode値はBluetooth SIG "Fitness Machine Control Point" 定義に基づく
// (0x00 Request Control, 0x07 Start or Resume, 0x08 Stop or Pause,
//  0x11 Set Indoor Bike Simulation Parameters 等)。

export const RESULT_SUCCESS = 0x01;
export const RESULT_OP_NOT_SUPPORTED = 0x02;
export const RESULT_INVALID_PARAMETER = 0x03;
export const RESULT_OPERATION_FAILED = 0x04;
export const RESULT_CONTROL_NOT_PERMITTED = 0x05;

// ---- User Control Point OpCode (User Data Service) ----
export const UCP_REGISTER_NEW_USER = 0x01;
export const UCP_CONSENT = 0x02;
export const UCP_RESPONSE_CODE = 0x20;

// ---- Indoor Bike Data flags (bit position) ----
export const IBD_FLAG_MORE_DATA = 0; // 1のとき瞬間速度フィールドは"なし"
export const IBD_FLAG_AVG_SPEED = 1;
export const IBD_FLAG_INST_CADENCE = 2;
export const IBD_FLAG_AVG_CADENCE = 3;
export const IBD_FLAG_TOTAL_DISTANCE = 4;
export const IBD_FLAG_RESISTANCE_LEVEL = 5;
export const IBD_FLAG_INST_POWER = 6;
export const IBD_FLAG_AVG_POWER = 7;
export const IBD_FLAG_EXPENDED_ENERGY = 8;
export const IBD_FLAG_HEART_RATE = 9;
export const IBD_FLAG_METABOLIC_EQUIVALENT = 10;
export const IBD_FLAG_ELAPSED_TIME = 11;
export const IBD_FLAG_REMAINING_TIME = 12;

// ---- Fitness Machine Feature (1st field: Fitness Machine Features) ----
export const FEATURE_POWER_MEASUREMENT = 14;
export const FEATURE_CADENCE_SUPPORTED = 1;

// ---- Fitness Machine Feature (2nd field: Target Setting Features) ----
export const TARGET_SPEED_SUPPORTED = 0;
export const TARGET_INCLINATION_SUPPORTED = 1;
export const TARGET_RESISTANCE_SUPPORTED = 2;
export const TARGET_POWER_SUPPORTED = 3;
export const TARGET_SIMULATION_SUPPORTED = 13;

export function bitSet(value, bit) {
  return ((value >> bit) & 1) === 1;
}
