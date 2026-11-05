// 区間のネットワーク: 町(ノード)と区間をつなぎ、分かれ道で次に走れる区間を出す。純粋関数のみ。
//
// 区間データは from → to の片向きだけを持つ。逆向きは id の末尾に REVERSE_SUFFIX をつけて表し、
// 勾配・地点・トンネル・路面・地図を反転した区間をその場で作る(同じ id なら同じオブジェクトを返す)。
//
// 区間は2段で持つ。起動時は js/data/catalog.js の要約(勾配なし・地図は約 1 km ごと)だけで、
// 分かれ道の案内・旅の地図・スタンプはこれで足りる。走る区間は loadSegment() で
// js/data/segments/<id>.json(勾配・細かい地図つき)を読んでから getSegment() で使う。
// 区間がいくら増えても、起動時に読む量とテストが読む量が区間の数ほどは増えないようにするため。

import { SEGMENTS, NODES, TRANSFERS, REGIONS } from '../data/catalog.js';
import { elevationAtM } from '../physics/segmentRoute.js';

export const REVERSE_SUFFIX = '~rev';

/** 読み込んだ区間の全データ(id → 区間)。 */
const fullSegments = new Map();
const reversedCache = new Map();

const baseId = (id) => (id.endsWith(REVERSE_SUFFIX) ? id.slice(0, -REVERSE_SUFFIX.length) : id);

/**
 * 区間 id(逆向きの id も可)から区間データ。無ければ null。
 * loadSegment() で読んだ後なら勾配つきの全データ、まだなら catalog の要約(grades が無い)を返す。
 */
export function getSegment(id) {
  if (typeof id !== 'string') return null;
  const base = fullSegments.get(baseId(id)) ?? SEGMENTS[baseId(id)];
  if (!base) return null;
  if (!id.endsWith(REVERSE_SUFFIX)) return base;
  const hit = reversedCache.get(id);
  if (hit && hit.base === base) return hit.rev;
  const rev = reverseSegment(base);
  reversedCache.set(id, { base, rev });
  return rev;
}

/** 区間の全データ(勾配つき)を読み込み済みか。 */
export function isSegmentLoaded(id) {
  return typeof id === 'string' && fullSegments.has(baseId(id));
}

/** 区間の全データの URL(js/data/segments/<id>.json)。逆向きの id なら元の区間。 */
export function segmentUrl(id) {
  return new URL(`../data/segments/${baseId(id)}.json`, import.meta.url).href;
}

/** 読み込んだ区間の全データを登録する(loadSegment が使う。テストはファイルから直接入れる)。 */
export function registerSegment(data) {
  fullSegments.set(data.id, { ...SEGMENTS[data.id], ...data });
}

/** 区間の全データを読み込む(読み込み済みなら何もしない)。読んだ後の getSegment(id) を返す。 */
export async function loadSegment(id, fetchFn = globalThis.fetch) {
  if (!isSegmentLoaded(id)) {
    const res = await fetchFn(segmentUrl(id));
    if (!res.ok) throw new Error(`区間データを読めませんでした(${baseId(id)}: ${res.status})`);
    registerSegment(await res.json());
  }
  return getSegment(id);
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
  const full = Array.isArray(s.grades);
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
    startElevM: full ? (s.startElevM ?? 0) + elevationAtM(s, L) : s.endElevM,
    endElevM: s.startElevM,
    descentM: s.climbM,
    grades: full ? s.grades.map((g) => -g).reverse() : undefined,
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
  rev.climbM = full ? climbOf(rev) : s.descentM;
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

/**
 * 旅を始められるコースの一覧(旅の支度で選ぶ)。コース = 区間を順方向に走ること。
 * 並びは日本一周の順(地方の設定の order、地方の中は設定に書いた順)で、つなげていくと一周になる。
 * side は本線から外れる寄り道(行き止まりの岬など)。
 * @returns {{segmentId:string, no:number, name:string, regionName:string, lengthM:number, climbM:number, side:boolean}[]}
 */
export function courseChoices() {
  const regionName = Object.fromEntries(REGIONS.map((r) => [r.id, r.name]));
  return Object.values(SEGMENTS).map((s, i) => ({
    segmentId: s.id,
    no: i + 1,
    name: s.name,
    regionName: regionName[s.region] ?? '',
    lengthM: s.lengthM,
    climbM: s.climbM,
    side: Boolean(s.side),
  }));
}
