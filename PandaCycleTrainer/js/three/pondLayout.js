// 上野・不忍池コースの池と周回ルートの手続き型生成。Three.js非依存の純粋関数で、
// Node上でユニットテストできる。
//
// 座標系: 地図座標(x=東, y=北, 単位m、池の中心が原点)。3D側ではワールドX=x, Z=-y とする。
// 岸辺と周回ルートは池の中心からの極座標 r(θ) で表す(θは東から反時計回り)。θが増える
// 向きに進むので、ルートは必ず反時計回りになる。ルートは凸な形に保ち、常に左へ曲がり
// 続ける(直線区間や右カーブのない)周回コースにしている。1周がちょうど ROUTE_LENGTH_M に
// なるよう全体の縮尺を決める。

import { mulberry32 } from './cityLayout.js';

/** 周回ルート1周の長さ(m)。コースプロファイルの loopLengthKm と一致させる。 */
export const ROUTE_LENGTH_M = 1200;
/** スタート地点の角度(池の南、ボート乗り場の沖)。反時計回りなので東へ向かって漕ぎ出す。 */
export const START_THETA = -Math.PI / 2;
/** 岸の遊歩道の高さ(水面=0)。石積みの護岸の上。 */
export const EMBANKMENT_M = 0.9;
/** 弁天堂のある半島の方角(東)。 */
export const BENTENDO_THETA = 0;

const TAU = Math.PI * 2;

function angleDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function ellipseR(a, b, theta) {
  const c = Math.cos(theta) / a;
  const s = Math.sin(theta) / b;
  return 1 / Math.sqrt(c * c + s * s);
}

// 縮尺前の形(おおよそ東西450m×南北330mの池)
function rawShoreR(theta) {
  const peninsula = 30 * Math.exp(-(angleDiff(theta, BENTENDO_THETA) ** 2) / (2 * 0.2 * 0.2));
  return ellipseR(240, 175, theta) + 10 * Math.sin(3 * theta + 0.5) + 6 * Math.sin(5 * theta + 1.3) - peninsula;
}

function rawRouteR(theta) {
  // 岸より内側の、ゆるやかな楕円(小さな2次の揺らぎだけ加えて凸を保つ)
  return ellipseR(190, 146, theta) + 3 * Math.sin(2 * theta + 0.8);
}

// ルートの弧長テーブル(θを細かく刻んで数値積分)。縮尺はここで決まる。
const TABLE_N = 4096;
const rawTable = (() => {
  const thetas = new Float64Array(TABLE_N + 1);
  const lengths = new Float64Array(TABLE_N + 1);
  let prev = null;
  let total = 0;
  for (let i = 0; i <= TABLE_N; i++) {
    const theta = START_THETA + (i / TABLE_N) * TAU;
    const r = rawRouteR(theta);
    const p = [r * Math.cos(theta), r * Math.sin(theta)];
    if (prev) total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    thetas[i] = theta;
    lengths[i] = total;
    prev = p;
  }
  return { thetas, lengths, total };
})();

/** 縮尺前の形を1周 ROUTE_LENGTH_M に合わせる倍率。 */
export const POND_SCALE = ROUTE_LENGTH_M / rawTable.total;

/** 岸辺(石積み護岸の水際)の池の中心からの距離。 */
export function shoreR(theta) {
  return rawShoreR(theta) * POND_SCALE;
}

/** 周回ルートの池の中心からの距離。 */
export function routeR(theta) {
  return rawRouteR(theta) * POND_SCALE;
}

/** 極座標 → 地図座標。 */
export function polar(theta, r) {
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
}

/** 周回距離 s(m) におけるルート上の角度θ。 */
export function routeTheta(s) {
  const m = ((s % ROUTE_LENGTH_M) + ROUTE_LENGTH_M) % ROUTE_LENGTH_M;
  const target = m / POND_SCALE;
  const { thetas, lengths } = rawTable;
  let lo = 0;
  let hi = TABLE_N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] <= target) lo = mid;
    else hi = mid;
  }
  const t = (target - lengths[lo]) / (lengths[hi] - lengths[lo] || 1);
  return thetas[lo] + (thetas[hi] - thetas[lo]) * t;
}

/**
 * 周回距離 s(m) におけるルート上の位置と進行方向。
 * @returns {{x:number, y:number, theta:number, heading:number}} headingは地図上の進行方位(rad, 東=0, 反時計回り)
 */
export function routeAt(s) {
  const theta = routeTheta(s);
  const p = polar(theta, routeR(theta));
  const e = 1e-4;
  const a = polar(theta - e, routeR(theta - e));
  const b = polar(theta + e, routeR(theta + e));
  return { x: p.x, y: p.y, theta, heading: Math.atan2(b.y - a.y, b.x - a.x) };
}

// ---- 配置物 ----

// 周囲の区域(θの範囲): 北〜東は上野公園の森、西〜南は市街地(池之端・湯島・上野広小路)
export function isParkSector(theta) {
  const t = ((theta % TAU) + TAU) % TAU;
  return t < 1.75 || t > 5.9; // おおよそ北東〜東〜北
}

export const WILLOW_COLOR = 0x8fb04e;
export const CHERRY_COLORS = [0x4f7234, 0x5a7d3a, 0x466a2f];
export const PARK_TREE_COLORS = [0x3f5f2a, 0x4a6b2f, 0x355426, 0x56793a];
export const BUILDING_STYLES_POND = ['stucco', 'concrete', 'glass', 'brick'];
export const BUILDING_TINTS_POND = [0xffffff, 0xf2eee6, 0xe6e2da, 0xd9d4ca, 0xeae6e0];

/**
 * 池の周りの配置物を決定的に列挙する(すべて地図座標)。
 * willows/cherries: 岸辺の柳と桜 / lamps: 遊歩道の街灯 / parkTrees: 上野公園の木々 /
 * buildings: 周囲のビル / lotus: 蓮の葉 / pier: ボート乗り場 / moored: 係留中のスワンボート /
 * boats: 周回中の他のスワンボート(ルート) / bentendo: 弁天堂 / skytree: 遠景の東京スカイツリー
 */
export function collectPondObjects() {
  const rand = mulberry32(5310);
  const willows = [];
  const cherries = [];
  const lamps = [];
  const parkTrees = [];
  const buildings = [];
  const lotus = [];

  // 岸辺: 柳と桜を交互に(水際から4〜10m)。弁天堂の半島とボート乗り場の前は空ける
  const shoreSteps = 150;
  for (let i = 0; i < shoreSteps; i++) {
    const theta = (i / shoreSteps) * TAU + rand() * 0.01;
    if (Math.abs(angleDiff(theta, BENTENDO_THETA)) < 0.12 || Math.abs(angleDiff(theta, START_THETA)) < 0.06) continue;
    const r = shoreR(theta) + 4 + rand() * 6;
    const p = polar(theta, r);
    const tree = { ...p, scale: 0.85 + rand() * 0.4, seed: Math.floor(rand() * 1e9) };
    if (i % 3 === 0) cherries.push({ ...tree, color: CHERRY_COLORS[Math.floor(rand() * CHERRY_COLORS.length)] });
    else willows.push(tree);
  }
  for (let i = 0; i < 48; i++) {
    const theta = (i / 48) * TAU + 0.04;
    lamps.push({ ...polar(theta, shoreR(theta) + 2.6), theta });
  }

  // 上野公園の森(北〜東)
  for (let i = 0; i < 900; i++) {
    const theta = rand() * TAU;
    if (!isParkSector(theta)) continue;
    const r = shoreR(theta) + 14 + Math.pow(rand(), 0.8) * 420;
    parkTrees.push({ ...polar(theta, r), scale: 0.9 + rand() * 0.9, conifer: rand() < 0.25, color: PARK_TREE_COLORS[Math.floor(rand() * PARK_TREE_COLORS.length)], seed: Math.floor(rand() * 1e9) });
  }

  // 市街地のビル(西〜南)。池から離れるほど高い
  for (let ring = 0; ring < 5; ring++) {
    const offset = 45 + ring * 70;
    const count = 34 + ring * 8;
    for (let i = 0; i < count; i++) {
      const theta = (i / count) * TAU + rand() * 0.05;
      if (isParkSector(theta)) continue;
      const r = shoreR(theta) + offset + rand() * 30;
      const floors = Math.round((5 + ring * 4) * (0.6 + rand() * 0.9));
      buildings.push({
        ...polar(theta, r), theta,
        widthM: 16 + rand() * 18, depthM: 14 + rand() * 14, floors: Math.max(3, floors),
        style: BUILDING_STYLES_POND[Math.floor(rand() * BUILDING_STYLES_POND.length)],
        tint: BUILDING_TINTS_POND[Math.floor(rand() * BUILDING_TINTS_POND.length)],
      });
    }
  }

  // 蓮池(北西の岸寄り)。ルートからは十分離す
  for (let i = 0; i < 1500; i++) {
    const theta = 2.0 + rand() * 1.05;
    const inner = routeR(theta) + 10;
    const outer = shoreR(theta) - 2;
    if (outer <= inner) continue;
    const r = inner + rand() * (outer - inner);
    lotus.push({ ...polar(theta, r), size: 0.55 + rand() * 0.6, yaw: rand() * TAU, tilt: rand() * 0.35 });
  }

  // ボート乗り場(スタート地点の岸)と係留中のスワンボート
  const pierTheta = START_THETA;
  const pierShore = shoreR(pierTheta);
  const pier = { theta: pierTheta, fromR: pierShore + 2, toR: pierShore - 16, widthM: 9 };
  const moored = [];
  for (const [side, depth] of [[-1, 4], [-1, 11], [1, 4], [1, 11]]) {
    const r = pierShore - depth;
    const lateral = side * 7.5;
    const base = polar(pierTheta, r);
    moored.push({ x: base.x + lateral * -Math.sin(pierTheta), y: base.y + lateral * Math.cos(pierTheta), yaw: pierTheta + Math.PI / 2 + (rand() - 0.5) * 0.3 });
  }

  // 周回中の他のスワンボート: ルートより内側の同心の小さな周回路を、それぞれの速さで反時計回り
  const boats = [];
  for (let i = 0; i < 6; i++) {
    boats.push({ inset: 16 + i * 9 + rand() * 4, phase: rand() * TAU, speedRadS: 0.012 + rand() * 0.012 });
  }

  const tip = shoreR(BENTENDO_THETA);
  const bentendo = { ...polar(BENTENDO_THETA, tip + 22), theta: BENTENDO_THETA };
  // 東京スカイツリー(北東、約3km先)
  const skytree = { ...polar(0.62, 3000), heightM: 634 };

  return { willows, cherries, lamps, parkTrees, buildings, lotus, pier, moored, boats, bentendo, skytree };
}

/** 周回中の他のスワンボートの時刻tSecでの位置と向き(地図座標)。 */
export function boatAt(boat, tSec) {
  const theta = boat.phase + boat.speedRadS * tSec;
  const r = Math.max(20, routeR(theta) - boat.inset);
  const p = polar(theta, r);
  const e = 1e-3;
  const q = polar(theta + e, Math.max(20, routeR(theta + e) - boat.inset));
  return { x: p.x, y: p.y, heading: Math.atan2(q.y - p.y, q.x - p.x) };
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * 岸(護岸の上端)からの距離 offsetM における地面の高さ。上野公園側(北〜東)は奥へ行くほど
 * 上野の山へゆるやかに上り、市街地側は平ら。
 */
export function groundHeightAtPolar(theta, offsetM) {
  if (offsetM <= 0) return EMBANKMENT_M;
  const hill = isParkSector(theta) ? 14 * smoothstep(50, 320, offsetM) * (0.7 + 0.3 * Math.sin(3 * theta + 0.4)) : 0;
  return EMBANKMENT_M + hill;
}

/** 地図座標(x, y)の地面の高さ(池の中は水面=0)。 */
export function groundHeightAt(x, y) {
  const theta = Math.atan2(y, x);
  const offset = Math.hypot(x, y) - shoreR(theta);
  return offset < 0 ? 0 : groundHeightAtPolar(theta, offset);
}
