// 道ばたの置き物の配置(純粋な計算。Three.js を使わないので Node のテストから読める)。
// 区間の道の形(向きの変わり方)・地面の高さ・トンネル・町から、日本の道らしい置き物の場所を決める。
//   - 電柱: 35 m ごと。300 m の区切りごとに山側(地面の高い側)に立て、崖・橋の側は避ける。隣の電柱と電線でつなぐ
//   - カーブミラー: きついカーブの外側に1本
//   - 警戒標識(黄色のひし形): カーブの手前 70 m の左側
//   - 速度標識: 区間の出だし・トンネルを出た所・2 km ごと。町の中は 40、ほかは 50
//   - 案内標識(青): 3 km ごとと町を出た所。次の町と行き先までの km
//   - 中央線の黄色(はみ出し禁止): カーブの続く所とトンネル
//   - ゴールの表札: 区間の終わりの少し先に、道をまたぐ大きな門。行き先の名前を書く(着いた時に前に見える。電柱はその手前で止める)
// 同じ区間ならいつも同じ配置になる(乱数を使わない)。道の見た目だけで、物理・トレーナーには関係しない。
//
// 座標は区間の平面座標(東 = +x、北 = +y)。at(m) の向き (hx, hy) の左は (-hy, hx)。side は +1 = 左、-1 = 右。

export const POLE_STEP_M = 35;
const POLE_RUN_M = 300; // 電柱を同じ側に立てる区切り
const POLE_OFF_M = 6.4; // 道の中心から電柱まで
const TURN_SPAN_M = 20; // 向きの変わり方を測る前後の距離
const CURVE_TURN = 0.45; // 前後 40 m で 26° 以上曲がる = カーブ(半径 90 m くらいまで)
const MIRROR_TURN = 0.7; // 40° 以上 = 見通しの悪いカーブ(半径 57 m くらいまで)
const YELLOW_TURN = 0.3;
const TOWN_BEFORE_M = 400;
const TOWN_AFTER_M = 700;
const GOAL_CLEAR_M = 20; // ゴールの門のまわりに電柱を立てない
const GOAL_AHEAD_M = 16; // 着いた所から門まで(真下だとカメラから字が読めない)

/** m の前後 TURN_SPAN_M での向きの変わり(ラジアン、左に曲がると正)。 */
export function turnAt(at, m, lengthM) {
  const a = at(Math.max(m - TURN_SPAN_M, 0), {});
  const b = at(Math.min(m + TURN_SPAN_M, lengthM), {});
  return Math.atan2(a.hx * b.hy - a.hy * b.hx, a.hx * b.hx + a.hy * b.hy);
}

/** 区間 [a, b] の重なりをまとめる。 */
function mergeRanges(ranges) {
  const out = [];
  for (const r of [...ranges].sort((p, q) => p[0] - q[0])) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * 道ばたの置き物の配置を決める。
 * @param {{lengthM:number, at:(m:number, out?:object)=>{x:number,y:number,z:number,hx:number,hy:number},
 *   groundAt:(x:number,y:number)=>number, inTunnel?:(m:number)=>boolean,
 *   places?:{atM:number,name:string,kind:string}[], goalName?:string}} o
 */
export function planRoadside({ lengthM, at, groundAt, inTunnel = () => false, places = [], goalName, unpavedAt = () => false }) {
  const L = lengthM;
  const p = {};
  const tunnelNear = (m, r) => inTunnel(m) || inTunnel(Math.max(m - r, 0)) || inTunnel(Math.min(m + r, L));
  // 砂利道(林道・旧道)には電柱・カーブミラー・標識を立てない(山の中の古い道らしく)
  const wild = (m) => unpavedAt(m);
  const towns = places.filter((q) => q.kind === 'town').sort((q1, q2) => q1.atM - q2.atM);
  const inTown = (m) => towns.some((t) => m > t.atM - TOWN_BEFORE_M && m < t.atM + TOWN_AFTER_M);
  /** 道の脇 off m の地面が、路面よりどれだけ低いか(崖・海・橋なら大きい)。 */
  const dropAt = (m, off) => {
    at(m, p);
    return p.z - groundAt(p.x - p.hy * off, p.y + p.hx * off);
  };

  // ---- カーブ(5 m ごとの向きの変わり) ----
  const STEP = 5;
  const turns = [];
  for (let m = 0; m <= L; m += STEP) turns.push(turnAt(at, m, L));
  const curves = []; // { fromM, toM, peakM, turn }
  let cur = null;
  turns.forEach((t, i) => {
    const m = i * STEP;
    if (Math.abs(t) >= CURVE_TURN && (!cur || Math.sign(t) === Math.sign(cur.turn))) {
      if (!cur) cur = { fromM: m, toM: m, peakM: m, turn: t };
      cur.toM = m;
      if (Math.abs(t) > Math.abs(cur.turn)) { cur.turn = t; cur.peakM = m; }
    } else if (cur) {
      curves.push(cur);
      cur = Math.abs(t) >= CURVE_TURN ? { fromM: m, toM: m, peakM: m, turn: t } : null;
    }
  });
  if (cur) curves.push(cur);

  // ---- 電柱 ----
  const runSide = new Map();
  const sideOfRun = (r) => {
    if (!runSide.has(r)) {
      let sum = 0;
      for (let m = r * POLE_RUN_M; m < Math.min((r + 1) * POLE_RUN_M, L); m += 25) sum += dropAt(m, -9) - dropAt(m, 9);
      runSide.set(r, sum >= 0 ? 1 : -1); // 右の落ち込みが大きい = 左が山側
    }
    return runSide.get(r);
  };
  const poles = [];
  for (let m = 10; m < L - GOAL_CLEAR_M; m += POLE_STEP_M) {
    if (tunnelNear(m, 15) || wild(m)) continue;
    let side = sideOfRun(Math.floor(m / POLE_RUN_M));
    if (dropAt(m, side * POLE_OFF_M) > 3) side = -side;
    if (dropAt(m, side * POLE_OFF_M) > 3) continue; // 両側とも崖・橋
    poles.push({ m, side, link: false, transformer: Math.round(m / POLE_STEP_M) % 5 === 2 });
  }
  for (let i = 0; i + 1 < poles.length; i++) poles[i].link = poles[i + 1].m - poles[i].m <= POLE_STEP_M + 0.5;

  // ---- カーブミラー(きついカーブの外側) ----
  const mirrors = [];
  for (const c of curves) {
    if (Math.abs(c.turn) < MIRROR_TURN || tunnelNear(c.peakM, 20) || wild(c.peakM)) continue;
    if (mirrors.length && c.peakM - mirrors[mirrors.length - 1].m < 120) continue;
    const side = c.turn > 0 ? -1 : 1;
    if (dropAt(c.peakM, side * 6) > 3) continue; // 外側が崖ならガードレールだけ
    mirrors.push({ m: c.peakM, side, dir: c.turn > 0 ? 'left' : 'right' });
  }

  // ---- 標識(進む向きの左側) ----
  const warnings = [];
  for (const c of curves) {
    const m = c.fromM - 70;
    if (m < 30 || tunnelNear(m, 10) || wild(m) || wild(c.peakM)) continue;
    if (warnings.length && m - warnings[warnings.length - 1].m < 150) continue;
    warnings.push({ m, side: 1, dir: c.turn > 0 ? 'left' : 'right' });
  }
  const taken = [...warnings.map((w) => w.m)];
  const free = (m, r) => m > 20 && m < L - 20 && !tunnelNear(m, 10) && !wild(m) && !taken.some((t) => Math.abs(t - m) < r);

  const speeds = [];
  const speedAt = [80];
  for (const tn of tunnelRanges(inTunnel, L)) speedAt.push(tn[1] + 40);
  for (let m = 2000; m < L; m += 2000) speedAt.push(m);
  for (const m of speedAt.sort((a, b) => a - b)) {
    if (!free(m, 25) || speeds.some((s) => Math.abs(s.m - m) < 300)) continue;
    speeds.push({ m, side: 1, limit: inTown(m) ? 40 : 50 });
    taken.push(m);
  }

  const guides = [];
  const goal = goalName ?? towns[towns.length - 1]?.name;
  const guideAt = [600];
  for (const t of towns) guideAt.push(t.atM + 250);
  for (let m = 3000; m < L; m += 3000) guideAt.push(m);
  for (const m0 of guideAt.sort((a, b) => a - b)) {
    let m = m0;
    while (m < L && !free(m, 25)) m += 20;
    if (L - m < 800 || guides.some((g) => Math.abs(g.m - m) < 800)) continue;
    const next = towns.find((t) => t.atM > m + 400);
    const lines = [];
    if (next) lines.push({ name: next.name, km: Math.max(1, Math.round((next.atM - m) / 1000)) });
    if (goal && goal !== next?.name) lines.push({ name: goal, km: Math.max(1, Math.round((L - m) / 1000)) });
    if (!lines.length) continue;
    guides.push({ m, side: 1, lines });
    taken.push(m);
  }

  // ---- 中央線の黄色 ----
  const yellow = [];
  turns.forEach((t, i) => { if (Math.abs(t) >= YELLOW_TURN) yellow.push([i * STEP - 40, i * STEP + 40]); });
  for (const tn of tunnelRanges(inTunnel, L)) yellow.push([tn[0] - 30, tn[1] + 30]);

  // ---- ゴールの表札(区間の終わりから道の向きに GOAL_AHEAD_M 先。ライダーは門の手前で止まる) ----
  const goalSign = goal ? { m: L, aheadM: GOAL_AHEAD_M, name: goal } : null;

  return { poles, mirrors, warnings, speeds, guides, goal: goalSign, yellow: mergeRanges(yellow), curves };
}

/** 10 m ごとに見たトンネルの範囲 [入口, 出口]。 */
function tunnelRanges(inTunnel, L) {
  const out = [];
  let from = null;
  for (let m = 0; m <= L; m += 10) {
    const t = inTunnel(m);
    if (t && from === null) from = m;
    if (!t && from !== null) { out.push([from, m]); from = null; }
  }
  if (from !== null) out.push([from, L]);
  return out;
}

/** m が中央線の黄色の所か。 */
export function isYellowAt(plan, m) {
  const ys = plan.yellow;
  let lo = 0;
  let hi = ys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m < ys[mid][0]) hi = mid - 1;
    else if (m > ys[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** m の昇順に並んだ items のうち、[fromM, toM) にあるものの最初の添字。 */
export function firstIndexFrom(items, fromM) {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].m < fromM) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 電線のたるみ: 2本の電柱の間の t (0〜1) での、まっすぐ結んだ線からの下がり(m)。 */
export function wireSagM(spanM, t) {
  return 0.012 * spanM * 4 * t * (1 - t);
}
