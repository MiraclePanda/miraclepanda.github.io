// 区間のネットワーク: 町(ノード)と区間をつなぎ、分かれ道で次に走れる区間を出す。純粋関数のみ。
//
// 区間データは from → to の片向きだけを持つ。逆向きは id の末尾に REVERSE_SUFFIX をつけて表し、
// 勾配・地点・トンネル・路面・地図を反転した区間をその場で作る(同じ id なら同じオブジェクトを返す)。

import { SEGMENTS, NODES, TRANSFERS } from '../data/segments/index.js';
import { elevationAtM } from '../physics/segmentRoute.js';

export const REVERSE_SUFFIX = '~rev';

const reversedCache = new Map();

/** 区間 id(逆向きの id も可)から区間データ。無ければ null。 */
export function getSegment(id) {
  if (typeof id !== 'string') return null;
  if (!id.endsWith(REVERSE_SUFFIX)) return SEGMENTS[id] ?? null;
  if (reversedCache.has(id)) return reversedCache.get(id);
  const base = SEGMENTS[id.slice(0, -REVERSE_SUFFIX.length)];
  const rev = base ? reverseSegment(base) : null;
  reversedCache.set(id, rev);
  return rev;
}

/** 町の名前。 */
export function nodeName(nodeId) {
  return NODES[nodeId]?.name ?? nodeId;
}

/** 獲得標高(m)。勾配の表から数える。 */
export function climbOf(segment) {
  return Math.round(segment.grades.reduce((a, g) => a + Math.max(0, g) * segment.stepM / 100, 0));
}

/**
 * 区間を逆向きにする。地点は向きに関係しないものだけ残す(道ばたの出会いのせりふや、
 * 「◯◯を出発」のような町の文は向きに合わないので落とす)。
 */
export function reverseSegment(s) {
  const L = s.lengthM;
  const flip = (m) => Math.min(L - 1, Math.max(0, L - m));
  const surfaces = (s.surfaces ?? [{ fromM: 0, surface: 'paved' }]).map((r, i, a) => ({
    fromM: L - (a[i + 1]?.fromM ?? L), surface: r.surface,
  })).reverse();
  surfaces[0] = { ...surfaces[0], fromM: 0 };
  const rev = {
    ...s,
    id: s.id + REVERSE_SUFFIX,
    name: `${nodeName(s.to)} → ${nodeName(s.from)}`,
    from: s.to,
    to: s.from,
    goalName: nodeName(s.from),
    seaSide: { left: 'right', right: 'left' }[s.seaSide] ?? s.seaSide,
    startElevM: (s.startElevM ?? 0) + elevationAtM(s, L),
    grades: s.grades.map((g) => -g).reverse(),
    map: s.map ? [...s.map].reverse() : undefined,
    surfaces,
    tunnels: (s.tunnels ?? []).map((t) => ({ ...t, fromM: L - t.toM, toM: L - t.fromM })).reverse(),
    places: (s.places ?? [])
      .filter((p) => p.kind !== 'encounter')
      .map((p) => {
        const q = { ...p, atM: Math.round(flip(p.atM) / 10) * 10 };
        if (p.kind === 'town') delete q.text;
        return q;
      })
      .sort((a, b) => a.atM - b.atM),
  };
  rev.climbM = climbOf(rev);
  return rev;
}

/**
 * 町 nodeId から走り出せる区間(順方向と逆向きの両方)。
 * @returns {{segmentId:string, segment:object, toName:string, back:boolean}[]}
 *   back = 来た区間を引き返す向き(cameFrom と同じ区間の逆向き)
 */
export function routesFrom(nodeId, cameFromSegmentId = null) {
  const cameBase = cameFromSegmentId?.replace(REVERSE_SUFFIX, '') ?? null;
  const out = [];
  for (const s of Object.values(SEGMENTS)) {
    for (const id of [s.id, s.id + REVERSE_SUFFIX]) {
      const seg = getSegment(id);
      if (seg.from !== nodeId) continue;
      out.push({ segmentId: id, segment: seg, toName: nodeName(seg.to), back: s.id === cameBase });
    }
  }
  // 引き返す道は最後に
  return out.sort((a, b) => Number(a.back) - Number(b.back));
}

/** 区間の様子の要約(分かれ道の案内に出す)。 */
export function segmentSummary(segment) {
  const places = segment.places ?? [];
  const surfaces = [...new Set((segment.surfaces ?? []).map((r) => r.surface))];
  return {
    lengthKm: segment.lengthM / 1000,
    climbM: segment.climbM ?? climbOf(segment),
    lodgings: places.filter((p) => p.kind === 'lodging').length,
    foods: places.filter((p) => p.kind === 'food' || p.kind === 'shop').length,
    tunnels: (segment.tunnels ?? []).length,
    surfaces,
  };
}

/** 旅の今いる町(区間の端にいるときだけ。区間の途中なら null)。 */
export function currentNode(trip, segment) {
  const m = trip.position.segmentM;
  if (m >= segment.lengthM - 1) return segment.to;
  if (m <= 1) return segment.from;
  return null;
}

/** 分かれ道で「来た道」とみなす区間(電車・船で着いた直後は無い)。 */
export function cameFromSegmentId(trip) {
  const last = trip.legs?.[trip.legs.length - 1];
  return last && !last.transfer ? last.segmentId : null;
}

/** 町 nodeId から乗れる電車・船。 */
export function transfersFrom(nodeId) {
  return TRANSFERS.filter((t) => t.a === nodeId || t.b === nodeId)
    .map((t) => ({ ...t, from: nodeId, to: t.a === nodeId ? t.b : t.a, toName: nodeName(t.a === nodeId ? t.b : t.a) }));
}

/** 町 nodeId に着く区間(向きはどちらでも)。電車・船で着いたときの位置に使う。 */
export function segmentArrivingAt(nodeId) {
  for (const s of Object.values(SEGMENTS)) {
    if (s.to === nodeId) return s.id;
    if (s.from === nodeId) return s.id + REVERSE_SUFFIX;
  }
  return null;
}
