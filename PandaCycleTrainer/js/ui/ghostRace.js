// ゴースト対戦(PR2+3 仕様 §5.3)の走行中の計算。React・DOM に依存しない純粋関数にしてある
// (Node でユニットテストするため)。ゴーストは記録の再生なので物理演算はしない。

import { distanceAt, trackEndS } from '../storage/ghostTrack.js';
import { PB_GHOST_ID } from '../storage/prefs.js';

// ゴーストの色(HUD の --hud-ghost-pb / --hud-ghost-friend と同じ値)
export const GHOST_COLORS = { pb: '#b5abfc', friend: '#5fb4ae' };
// 自分(車線0)と重ならないよう、ゴーストを左右に振り分ける横位置(m、右が正)
const GHOST_LANES_M = [-0.9, 0.9];
// 抜いた/抜かれた: 符号が変わったあと、この距離以上離れたら確定して通知する
export const OVERTAKE_CONFIRM_M = 2;
// 同じゴーストへの再通知を控える時間(秒)
export const OVERTAKE_COOLDOWN_S = 10;
// 秒差の計算で使う自分の速度の下限(m/s)。止まりかけで秒差が発散しないように
const MIN_GAP_SPEED_MPS = 2;
// 再生速度(km/h)を求める区間(秒)
const SPEED_WINDOW_S = 1;
// ゴーストのケイデンス(アバターの足の動き用の見た目の値)
const GHOST_CADENCE_RPM = 85;

/**
 * ゴースト再生用の走行時間(秒)。走行時間(一時停止を除く)から、さらにゴールのダイアログを
 * 開いていた時間を除く(ダイアログ中は物理が止まるので、ゴーストも止めておく)。
 * @param {{ ridingTimeS: number, totalGoalPausedMs: number, goalPauseStartedAt: number|null, nowMs: number }} p
 */
export function ghostTimeS({ ridingTimeS, totalGoalPausedMs = 0, goalPauseStartedAt = null, nowMs }) {
  const waitingMs = totalGoalPausedMs + (goalPauseStartedAt !== null && goalPauseStartedAt !== undefined ? Math.max(0, nowMs - goalPauseStartedAt) : 0);
  return Math.max(0, ridingTimeS - waitingMs / 1000);
}

/**
 * 選んだゴーストのトラックを、走行中に使う形にそろえる。
 * @param {Array<{ id, name, points }>} tracks
 */
export function prepareGhosts(tracks) {
  if (!Array.isArray(tracks)) return [];
  return tracks
    .filter((t) => t && t.points && t.points.length >= 2)
    .slice(0, GHOST_LANES_M.length)
    .map((t, i) => ({
      id: t.id,
      name: t.name,
      color: t.color ?? (t.id === PB_GHOST_ID ? GHOST_COLORS.pb : GHOST_COLORS.friend),
      track: t,
      endS: trackEndS(t),
      laneOffsetM: GHOST_LANES_M[i],
      // 抜いた/抜かれた判定の状態
      side: 0, // 確定済みの前後(+1 = ゴーストが前、−1 = 後ろ、0 = まだ決まっていない)
      lastNoticeS: -Infinity,
    }));
}

/**
 * 走行時間 tSec における各ゴーストの状態を求め、抜いた/抜かれたを判定する。
 * ghosts の判定状態(side, lastNoticeS)を更新する。
 * @returns {{ ghosts: Array, others: Array, events: Array<{ ghost, kind: 'passed'|'passedBy', gapM }> }}
 *   ghosts: HUD の values.ghosts、others: シーン・canvas 用(values.raw.others)
 */
export function stepGhosts(ghosts, tSec, me) {
  const hud = [];
  const others = [];
  const events = [];
  const myD = Number.isFinite(me?.distanceM) ? me.distanceM : 0;
  const mySpeed = Number.isFinite(me?.speedMps) ? me.speedMps : 0;
  for (const g of ghosts) {
    const d = distanceAt(g.track, tSec);
    const finished = tSec >= g.endS;
    const dPrev = distanceAt(g.track, Math.max(0, tSec - SPEED_WINDOW_S));
    const speedKmh = finished ? 0 : ((d - dPrev) / Math.min(SPEED_WINDOW_S, Math.max(tSec, 1e-6))) * 3.6;
    const gapM = d - myD;
    const gapS = gapM / Math.max(mySpeed, MIN_GAP_SPEED_MPS);

    // 符号が変わり、変わったあと OVERTAKE_CONFIRM_M 以上離れたら確定。最初の確定は通知しない。
    if (Math.abs(gapM) >= OVERTAKE_CONFIRM_M) {
      const sign = gapM > 0 ? 1 : -1;
      if (g.side !== 0 && sign !== g.side && tSec - g.lastNoticeS >= OVERTAKE_COOLDOWN_S) {
        events.push({ ghost: g, kind: sign < 0 ? 'passed' : 'passedBy', gapM });
        g.lastNoticeS = tSec;
      }
      g.side = sign;
    }

    hud.push({ id: g.id, name: g.name, color: g.color, gapM, gapS, ahead: gapM > 0, finished });
    others.push({
      id: g.id,
      kind: 'ghost',
      distanceM: d,
      laneOffsetM: g.laneOffsetM,
      speedKmh: Math.max(0, speedKmh),
      cadenceRpm: finished || speedKmh < 1 ? 0 : GHOST_CADENCE_RPM,
      color: g.color,
      label: g.name,
      finished,
    });
  }
  return { ghosts: hud, others, events };
}

/** 通知 G の内容。 */
export function overtakeToast(ev) {
  const m = Math.abs(ev.gapM).toFixed(0);
  return ev.kind === 'passed'
    ? { kind: 'ghost', kicker: 'ゴースト対戦', title: `${ev.ghost.name}を抜きました`, sub: `${m}m リード`, tone: 'ok' }
    : { kind: 'ghost', kicker: 'ゴースト対戦', title: `${ev.ghost.name}に抜かれました`, sub: `${m}m 先行されています`, tone: 'ng' };
}

/** ダッシュボード(非フルスクリーン)に出すゴースト差の1行。ゴーストがいなければ空文字。 */
export function ghostSummary(hudGhosts) {
  if (!hudGhosts || hudGhosts.length === 0) return '';
  return 'ゴースト: ' + hudGhosts
    .map((g) => {
      const s = `${g.ahead ? '+' : '−'}${Math.abs(g.gapS).toFixed(1)}s`;
      const m = `${Math.abs(g.gapM).toFixed(0)}m ${g.ahead ? '前方' : '後方'}`;
      return `${g.name} ${s}(${m}${g.finished ? '・記録終了' : ''})`;
    })
    .join(' / ');
}
