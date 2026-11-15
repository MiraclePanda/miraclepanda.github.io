// 走行記録の「要約」と「毎秒のサンプル」を分ける純粋関数(IndexedDB に依存しない。Node でテストできる)。
//
// 走行履歴は1回の走行で約3600サンプル(1時間)を持つ。合計距離(日本縦断)や一覧・自己ベストの判定は
// 要約だけで足りるので、db.js は要約(rides)とサンプル(rideSamples)を別のストアに置き、要約だけを
// 読む場面ではサンプルを読まない(レビュー Q10)。
//
// 要約には自己ベストの判定用に、距離 GHOST_SPLIT_M ごとの走行時間の表(ghostSplits: [t0, d0, t1, d1, …])を持たせる。
// ゴーストとして実際に走るときは、getRide() でサンプルごと読み直して細かいトラックを作る。

import { fromRecord } from './ghostTrack.js';

/** 自己ベストの判定に使う、距離の刻み(m)。 */
export const GHOST_SPLIT_M = 50;

/**
 * 記録のトラック(fromRecord)を GHOST_SPLIT_M ごとに間引いた [t, d, …](最初と最後の点は残す)。
 * @returns {number[]}
 */
export function ghostSplits(record) {
  const p = fromRecord(record).points;
  const n = p.length >> 1;
  const out = [];
  let nextD = 0;
  for (let i = 0; i < n; i++) {
    const d = p[i * 2 + 1];
    if (i === 0 || i === n - 1 || d >= nextD) {
      out.push(p[i * 2], d);
      nextD = (Math.floor(d / GHOST_SPLIT_M) + 1) * GHOST_SPLIT_M;
    }
  }
  return out;
}

/**
 * 記録を要約とサンプルに分ける。要約は samples を持たず、sampleCount・ghostSplits を持つ。
 * workKj の無い古い記録は、サンプルから求めておく(要約だけでカロリーを出せるように)。
 * @param {object} record
 * @param {(samples: object[]) => number} [workKjFromSamples]
 * @returns {{ summary: object, samples: object[] }}
 */
export function splitRecord(record, workKjFromSamples) {
  const samples = Array.isArray(record?.samples) ? record.samples : [];
  const { samples: _omit, ...rest } = record ?? {};
  const summary = { ...rest, sampleCount: samples.length, ghostSplits: ghostSplits(record) };
  if (!Number.isFinite(summary.workKj) && workKjFromSamples) summary.workKj = workKjFromSamples(samples);
  return { summary, samples };
}

/** 要約とサンプルを1つの記録に戻す(TCX の書き出し・ゴースト用)。 */
export function joinRecord(summary, samples) {
  if (!summary) return null;
  const { ghostSplits: _g, sampleCount: _c, ...rest } = summary;
  return { ...rest, samples: Array.isArray(samples) ? samples : [] };
}
