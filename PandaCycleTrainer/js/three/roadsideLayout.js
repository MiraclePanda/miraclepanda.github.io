// 沿道のハプニング・名所(happeningsLayout.js の actors)を道路の断面へ置くための純粋ロジック
// (Three.js 非依存。テスト対象)。3D の形・動きは roadsideActors.js、配置の入力は happeningsLayout.js。
//
// 横位置の約束(actors の契約に従う):
//   - side 0: lateralM は道路中心から右向きの距離(負なら左)
//   - side ±1: lateralM は車道の端(roadHalfWidthM)から外向きの距離。模型の原点(道路側の手前の縁)をそこに置く
//     (給水所・応援団は原点から外向きに奥行きを持つので、車道にはみ出さない)。
//     五重塔・三門・大仏殿などの建物(SIGHT_FOOTPRINTS)は原点が建物の中心なので、敷地が車道・路肩に
//     かからないよう中心を外へ押し出す。
// 名所・テントの「よけ範囲」(clearZones)は、街並みの建物や街路樹・景色の樹木を名所に重ねないために使う。

/** 五重塔の基壇(石の土台)の半幅(m)。 */
export const PAGODA_PLINTH_HALF_M = 6.5;
/** 五重塔の基壇と車道の端の最小のすき間(m)。 */
export const PAGODA_MIN_GAP_M = 1.5;
/** 五重塔の手前で、建物・木を置かずに見通しを空けておく長さ(m)。 */
export const PAGODA_VIEW_M = 24;
/** 大鳥居の柱の中心の、車道の端からの距離(m)。 */
export const TORII_PILLAR_OUTSET_M = 1.5;
/**
 * 沿道に建つ名所の敷地の半幅(m)。halfAlongM = 道路に沿う向き、halfLatM = 道路と直角の向き
 * (門・お堂は正面を道路へ向けて置くので、間口が道路に沿う)。
 * viewM: 手前(近づく側)に建物・木を置かずに見通しを空けておく長さ。
 * ground: 'max' = 敷地の中で一番高い地面に建てる(低い側は深い基壇が隠す)、'center' = 中心の地面
 * (清水の舞台は斜面に半分埋めて舞台の柱を谷側へ下ろす。浮見堂は池の底から柱を立てる)。
 */
export const SIGHT_FOOTPRINTS = {
  pagoda: { halfAlongM: PAGODA_PLINTH_HALF_M, halfLatM: PAGODA_PLINTH_HALF_M, viewM: PAGODA_VIEW_M, ground: 'max' },
  pagodaRed: { halfAlongM: PAGODA_PLINTH_HALF_M, halfLatM: PAGODA_PLINTH_HALF_M, viewM: PAGODA_VIEW_M, ground: 'max' },
  pagoda3: { halfAlongM: PAGODA_PLINTH_HALF_M, halfLatM: PAGODA_PLINTH_HALF_M, viewM: PAGODA_VIEW_M, ground: 'max' },
  sanmon: { halfAlongM: 17, halfLatM: 8, viewM: 30, ground: 'max' },
  romon: { halfAlongM: 8, halfLatM: 5, viewM: 20, ground: 'max' },
  daibutsuden: { halfAlongM: 33, halfLatM: 29, viewM: 60, ground: 'max' },
  kiyomizu: { halfAlongM: 27, halfLatM: 30, viewM: 70, ground: 'center' },
  ukimido: { halfAlongM: 6, halfLatM: 6, viewM: 0, ground: 'center' },
};

/** 給水所のテントの間口の半分・奥行き(m)。原点はテントの道路側の縁の中央。 */
export const AID_HALF_WIDTH_M = 1.3;
export const AID_DEPTH_M = 2.6;
/** 応援団の並びの半幅・奥行き(m)。 */
export const CHEER_HALF_WIDTH_M = 1.6;
export const CHEER_DEPTH_M = 0.8;

/**
 * 模型の原点の、道路中心から右向きの横位置(m)。
 * @param {{kind:string, side:number, lateralM:number}} actor
 * @param {number} roadHalfWidthM 車道の半幅(m)
 */
export function actorLateralM(actor, roadHalfWidthM) {
  const lateral = Number.isFinite(actor.lateralM) ? actor.lateralM : 0;
  const side = Math.sign(actor.side || 0);
  if (side === 0) return lateral;
  const out = roadHalfWidthM + Math.max(0, lateral);
  const fp = SIGHT_FOOTPRINTS[actor.kind];
  if (fp) return side * Math.max(out, roadHalfWidthM + PAGODA_MIN_GAP_M + fp.halfLatM);
  return side * out;
}

/**
 * 名所・テントの占める範囲(絶対距離と横位置の矩形)。街並みの建物や樹木をここに置かないために使う。
 * @param {Array} actors
 * @param {number} roadHalfWidthM
 * @returns {Array<{fromM:number, toM:number, latMin:number, latMax:number, kind:string}>}
 */
export function clearZones(actors, roadHalfWidthM) {
  const zones = [];
  if (!Array.isArray(actors)) return zones;
  for (const a of actors) {
    if (!a || !Number.isFinite(a.distanceM)) continue;
    const s = a.distanceM;
    const lat = actorLateralM(a, roadHalfWidthM);
    const out = Math.sign(lat) || 1;
    switch (a.kind) {
      case 'torii': {
        // 左右の柱のまわり(柱の太さ+余裕)
        const x = roadHalfWidthM + TORII_PILLAR_OUTSET_M;
        for (const sign of [-1, 1]) {
          const c = lat + sign * x;
          zones.push({ fromM: s - 2, toM: s + 2, latMin: c - 1.8, latMax: c + 1.8, kind: a.kind });
        }
        break;
      }
      case 'pagoda':
      case 'pagodaRed':
      case 'pagoda3':
      case 'sanmon':
      case 'romon':
      case 'daibutsuden':
      case 'kiyomizu':
      case 'ukimido': {
        // 敷地のまわりに加えて、手前 viewM は道路側まで空けて、近づく途中から建物が見えるようにする
        const fp = SIGHT_FOOTPRINTS[a.kind];
        const rs = fp.halfAlongM + 1;
        const rl = fp.halfLatM + 1;
        const near = out * (roadHalfWidthM + 1);
        zones.push({
          fromM: s - rs - fp.viewM, toM: s + rs,
          latMin: Math.min(lat - rl, near), latMax: Math.max(lat + rl, near), kind: a.kind,
        });
        break;
      }
      case 'aid':
      case 'cheer': {
        const half = (a.kind === 'aid' ? AID_HALF_WIDTH_M : CHEER_HALF_WIDTH_M) + 0.8;
        const depth = a.kind === 'aid' ? AID_DEPTH_M : CHEER_DEPTH_M;
        // 原点は道路側の縁。向き(yaw)は道路の方なので、奥行きは外向きに伸びる
        const a0 = lat;
        const a1 = lat + out * (depth + 0.6);
        zones.push({ fromM: s - half, toM: s + half, latMin: Math.min(a0, a1), latMax: Math.max(a0, a1), kind: a.kind });
        break;
      }
      default:
        break;
    }
  }
  return zones;
}

/**
 * 中心 (alongM, latM)・半幅 (halfAlongM, halfLatM) の矩形が、どれかのよけ範囲に重なるか。
 */
export function inClearZone(zones, alongM, latM, halfAlongM = 0, halfLatM = 0) {
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (alongM + halfAlongM < z.fromM || alongM - halfAlongM > z.toM) continue;
    if (latM + halfLatM < z.latMin || latM - halfLatM > z.latMax) continue;
    return true;
  }
  return false;
}

/** 文字列 id から 0〜n−1 の決定的な番号(猫の毛色などの見た目の選択用)。 */
export function variantOf(id, n) {
  let hsh = 2166136261;
  for (const ch of String(id ?? '')) {
    hsh ^= ch.charCodeAt(0);
    hsh = Math.imul(hsh, 16777619);
  }
  return (hsh >>> 0) % Math.max(1, n);
}
