// 沿道のハプニング(猫が横切る・パンダが並走する・謎の応援団・給水所・鹿のおじぎ)と、
// 観光地コースの名所(大鳥居・五重塔)の配置を決める純粋ロジック(Three.js 非依存。テスト対象)。
// 実際の3D描画は roadsideActors.js(CityScene / LandscapeScene が使う)。
//
// ハプニングの地点は seed から決定的に決める(同じ seed なら毎回同じ距離で同じことが起きる)。
// 走行の速さ・物理演算・トレーナーへの指示には一切影響しない(見た目と通知だけ)。
//
// 各フレームの出力 actors は次の形(roadsideActors.js との契約):
//   { id, kind, distanceM, side, lateralM, yaw, moving, phase }
//   - kind: 'cat' | 'panda' | 'cheer' | 'aid' | 'deer' | 'torii' | 'pagoda'
//   - distanceM: コース上の絶対距離(m)。ループするコースでも周回をまたいで増え続ける距離
//   - side: 0 = 道路上(lateralM は道路中心から右向きの距離)、
//           −1 / +1 = 左 / 右の沿道(lateralM は道路の端から外向きの距離)
//   - yaw: 道路の進行方向を 0 とした向き(rad、左回りが正。+π/2 = 左を向く、−π/2 = 右を向く、π = こちらを向く)
//   - moving: 0〜1 の動きの強さ(脚の振り・旗振り・おじぎの大きさ)
//   - phase: 動きの位相(s)。毎フレーム増える

import { mulberry32 } from './cityLayout.js';

export const HAPPENING_KINDS = ['cat', 'panda', 'cheer', 'aid', 'deer'];
export const LANDMARK_KINDS = ['torii', 'pagoda'];

/** ハプニングの既定の出やすさ(コースプロファイルの happenings で上書きできる)。 */
export const DEFAULT_HAPPENING_WEIGHTS = { cat: 3, panda: 2, cheer: 2, aid: 2, deer: 0 };

// ハプニングどうしの間隔(m)。のんびり走って数分に1回くらい
export const MIN_GAP_M = 700;
export const MAX_GAP_M = 1500;
export const FIRST_AT_M = 350;
// 描く範囲(自分の後ろ BEHIND_M 〜 前 AHEAD_M)
export const ACTORS_BEHIND_M = 30;
export const ACTORS_AHEAD_M = 300;

// 猫: 自分が手前 CAT_TRIGGER_M まで来たら、右の歩道から左へ CAT_CROSS_S 秒で横切る
const CAT_TRIGGER_M = 45;
const CAT_CROSS_S = 3.2;
const CAT_FROM_M = 6;
// パンダ: 地点に来たら後ろから追いついて、少し前で並走し、疲れて後ろへ下がる
const PANDA_START_GAP_M = -14;
const PANDA_PACE_GAP_M = 3;
const PANDA_CATCHUP_MPS = 2.5;
const PANDA_PACE_S = 22;
const PANDA_FADE_MPS = 3;
const PANDA_LANE_M = 1.6; // 自分(左車線)の右隣
// 応援団・給水所・鹿: 地点の手前 NOTICE_M で通知する
const NOTICE_M = 35;

const TOASTS = {
  cat: [
    { title: '猫が横切りました', sub: '縁起がいいのか悪いのか、猫は気にしていません。' },
    { title: '猫が横切りました', sub: 'こちらを一瞥して去っていきました。' },
    { title: '猫が横切りました', sub: '信号は守ってほしいところです。' },
  ],
  pandaStart: [
    { title: 'パンダが並走してきました', sub: '負けずにペダルを回しましょう(パンダは速度に影響しません)。' },
    { title: '野生のパンダが現れた！', sub: 'なぜか自転車と同じ速さで走っています。' },
  ],
  pandaEnd: [
    { title: 'パンダは疲れて笹を食べ始めました', sub: 'ここから先はひとりで走りましょう。' },
    { title: 'パンダが脱落しました', sub: '「また明日」と言っている気がします。' },
  ],
  cheer: [
    { title: '謎の応援団', sub: '「がんばれー！」(どなたでしょう)' },
    { title: '謎の応援団', sub: '旗には「祝 完走(予定)」と書いてあります。' },
    { title: '沿道の声援', sub: '「いいペースですよー！」(たぶん社交辞令)' },
  ],
  aid: [
    { title: '給水所を通過', sub: 'おにぎりを受け取りました(気持ちだけ)。' },
    { title: '給水所を通過', sub: '麦茶とたくあんが振る舞われています。' },
    { title: '給水所を通過', sub: '「梅干しは酸っぱいので注意」と書いてあります。' },
  ],
  deer: [
    { title: '鹿がおじぎをしてきました', sub: '鹿せんべいは持っていません。' },
    { title: '鹿がおじぎをしてきました', sub: 'つられておじぎをすると危ないので前を見ましょう。' },
  ],
};

const EMOJI = { cat: '🐈', pandaStart: '🐼', pandaEnd: '🐼', cheer: '📣', aid: '🍙', deer: '🦌' };

/** 重みからハプニングの種類を1つ選ぶ。重みがすべて0なら null。 */
export function pickKind(weights, r) {
  const entries = HAPPENING_KINDS.map((k) => [k, Math.max(0, Number(weights?.[k]) || 0)]);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return null;
  let x = r * total;
  for (const [k, w] of entries) {
    if (x < w) return k;
    x -= w;
  }
  return entries.filter(([, w]) => w > 0).pop()[0];
}

/**
 * fromM 〜 toM のハプニングの予定(決定的)。i 番目の地点は seed と i だけで決まる。
 * @returns {Array<{index:number, kind:string, atM:number, variant:number}>}
 */
export function planHappenings(seed, weights, fromM, toM) {
  const list = [];
  let atM = FIRST_AT_M;
  for (let i = 0; atM <= toM; i++) {
    const rand = mulberry32((seed * 7919 + i * 104729) >>> 0);
    const kind = pickKind(weights, rand());
    const variant = Math.floor(rand() * 1000);
    if (kind && atM >= fromM) list.push({ index: i, kind, atM, variant });
    atM += MIN_GAP_M + rand() * (MAX_GAP_M - MIN_GAP_M);
    if (i > 100000) break;
  }
  return list;
}

/** 通知の文言(絵文字つきの kicker、title、sub)。 */
export function happeningToast(key, variant) {
  const list = TOASTS[key];
  const t = list[variant % list.length];
  return { kind: 'happening', kicker: `${EMOJI[key]} 沿道のハプニング`, title: t.title, sub: t.sub };
}

/**
 * コースの名所(大鳥居・五重塔など)。profile.landmarks = [{ km, kind, side, lateralM, yaw? }] を
 * 1周ごとに繰り返して、描く範囲にあるものを actors の形で返す。fixedLength のコースは繰り返さない。
 */
export function landmarkActors(profile, distanceM, behindM = ACTORS_BEHIND_M, aheadM = ACTORS_AHEAD_M) {
  const marks = Array.isArray(profile?.landmarks) ? profile.landmarks : [];
  if (marks.length === 0) return [];
  const loopM = (profile.loopLengthKm ?? 0) * 1000;
  const out = [];
  const from = distanceM - behindM;
  const to = distanceM + aheadM;
  const firstLoop = loopM > 0 && !profile.fixedLength ? Math.max(0, Math.floor(from / loopM)) : 0;
  const lastLoop = loopM > 0 && !profile.fixedLength ? Math.floor(to / loopM) : 0;
  for (let loop = firstLoop; loop <= lastLoop; loop++) {
    marks.forEach((m, i) => {
      const at = loop * loopM + m.km * 1000;
      if (at < from || at > to) return;
      out.push({
        id: `lm-${loop}-${i}`, kind: m.kind, distanceM: at,
        side: m.side ?? 0, lateralM: m.lateralM ?? 0, yaw: m.yaw ?? 0, moving: 0, phase: 0,
      });
    });
  }
  return out;
}

/**
 * 走行中のハプニングを進める。RideScreen が毎フレーム step() を呼び、actors をシーンへ、events を通知へ渡す。
 * @param {object} opts
 * @param {number} opts.seed 決定的な配置の seed(コースごとに変える)
 * @param {object|null} opts.weights 種類ごとの出やすさ。null ならハプニングなし(名所だけ)
 * @param {object} [opts.profile] コースプロファイル(名所 landmarks 用)
 */
export function createHappeningDirector({ seed = 1, weights = DEFAULT_HAPPENING_WEIGHTS, profile = null } = {}) {
  const enabled = !!weights && HAPPENING_KINDS.some((k) => (Number(weights[k]) || 0) > 0);
  // 進行中のハプニングの状態(index → state)
  const states = new Map();
  let plannedTo = -Infinity;
  let plan = [];
  let clock = 0;

  function ensurePlan(distanceM) {
    if (!enabled) return;
    if (distanceM + ACTORS_AHEAD_M + 200 <= plannedTo) return;
    plannedTo = distanceM + ACTORS_AHEAD_M + 3000;
    plan = planHappenings(seed, weights, Math.max(0, distanceM - 2000), plannedTo);
  }

  return {
    /**
     * @param {{distanceM:number, speedMps:number, dt:number}} rider
     * @returns {{actors: Array, events: Array<object>}} events は通知(happeningToast の形)
     */
    step({ distanceM, speedMps, dt }) {
      const step = Math.max(0, Math.min(0.5, Number.isFinite(dt) ? dt : 0));
      clock += step;
      const speed = Math.max(0, speedMps || 0);
      const actors = landmarkActors(profile, distanceM);
      const events = [];
      ensurePlan(distanceM);
      for (const p of plan) {
        if (p.atM > distanceM + ACTORS_AHEAD_M) break;
        let st = states.get(p.index);
        // 始まらないまま後ろへ過ぎた地点(予定の作り直しで戻ってきたもの)は扱わない
        if (!st && p.atM < distanceM - ACTORS_BEHIND_M) continue;
        if (!st) {
          st = { phase: 'waiting', t: 0, gapM: PANDA_START_GAP_M, done: false };
          states.set(p.index, st);
        }
        if (st.done) continue;
        const actor = advance(p, st, distanceM, speed, step, events);
        if (actor) actors.push(actor);
      }
      // 遠く後ろになった状態は捨てる
      // (予定は自分の 2000m 後ろから作り直すので、それより後ろの状態だけ捨てる)
      for (const [i, st] of states) if (st.done && st.atM < distanceM - 2500) states.delete(i);
      return { actors, events };
    },
  };

  function advance(p, st, distanceM, speed, dt, events) {
    st.atM = p.atM;
    const gap = p.atM - distanceM;
    const id = `hp-${p.index}`;
    switch (p.kind) {
      case 'cat': {
        if (st.phase === 'waiting' && gap <= CAT_TRIGGER_M) {
          st.phase = 'crossing';
          events.push(happeningToast('cat', p.variant));
        }
        if (st.phase === 'crossing') st.t += dt;
        const u = Math.min(1, st.t / CAT_CROSS_S);
        if (gap < -ACTORS_BEHIND_M) {
          st.done = true;
          return null;
        }
        // 横切り終わったら左の歩道で座る
        return {
          id, kind: 'cat', distanceM: p.atM, side: 0, lateralM: CAT_FROM_M - 2 * CAT_FROM_M * u,
          yaw: u >= 1 ? Math.PI : Math.PI / 2,
          moving: u > 0 && u < 1 ? 1 : 0, phase: clock,
        };
      }
      case 'panda': {
        if (st.phase === 'waiting') {
          if (gap > 0) return null; // 地点に来るまでは見えない(後ろから来る)
          st.phase = 'catchup';
          events.push(happeningToast('pandaStart', p.variant));
        }
        let pandaSpeed = speed;
        if (st.phase === 'catchup') {
          pandaSpeed = speed + PANDA_CATCHUP_MPS;
          st.gapM = Math.min(PANDA_PACE_GAP_M, st.gapM + PANDA_CATCHUP_MPS * dt);
          if (st.gapM >= PANDA_PACE_GAP_M) st.phase = 'pace';
        } else if (st.phase === 'pace') {
          st.t += dt;
          // 自分が止まっている間は並走の時間を数えない(待っていてくれる)
          if (speed < 0.5) st.t -= dt;
          if (st.t >= PANDA_PACE_S) {
            st.phase = 'tired';
            events.push(happeningToast('pandaEnd', p.variant));
          }
        } else if (st.phase === 'tired') {
          pandaSpeed = Math.max(0, speed - PANDA_FADE_MPS);
          st.gapM -= PANDA_FADE_MPS * dt;
          if (st.gapM < -ACTORS_BEHIND_M) {
            st.done = true;
            return null;
          }
        }
        return {
          id, kind: 'panda', distanceM: distanceM + st.gapM, side: 0, lateralM: PANDA_LANE_M,
          yaw: 0, moving: Math.min(1, pandaSpeed / 4), phase: clock,
        };
      }
      case 'cheer':
      case 'aid':
      case 'deer': {
        if (st.phase === 'waiting' && gap <= NOTICE_M) {
          st.phase = 'noticed';
          events.push(happeningToast(p.kind, p.variant));
        }
        if (gap < -ACTORS_BEHIND_M) {
          st.done = true;
          return null;
        }
        return {
          id, kind: p.kind, distanceM: p.atM, side: p.kind === 'deer' ? 1 : -1, lateralM: p.kind === 'deer' ? 0.6 : 0.8,
          // 道路側(ライダーの方)を向く
          yaw: p.kind === 'deer' ? Math.PI / 2 : -Math.PI / 2,
          moving: p.kind === 'aid' ? 0.3 : 1, phase: clock,
        };
      }
      default:
        return null;
    }
  }
}

/** コース id から決定的な seed を作る(同じコースなら毎回同じ地点でハプニングが起きる)。 */
export function seedForCourse(courseId) {
  let hsh = 2166136261;
  for (const ch of String(courseId ?? '')) {
    hsh ^= ch.charCodeAt(0);
    hsh = Math.imul(hsh, 16777619);
  }
  return hsh >>> 0;
}
