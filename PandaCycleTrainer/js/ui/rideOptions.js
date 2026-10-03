// 走行画面の表示オプション(環境の時間帯・天候、視点)の表示名と選択肢。
// 値の一覧そのものは storage/prefs.js(ENVIRONMENT_TIMES / ENVIRONMENT_WEATHERS / CAMERA_VIEWS)が持ち、
// ここでは日本語の表示名と、コースごとに選べる範囲だけを決める。

import { ENVIRONMENT_TIMES, ENVIRONMENT_WEATHERS, CAMERA_VIEWS } from '../storage/prefs.js';

export const TIME_LABELS = { morning: '朝', noon: '昼', sunset: '夕方', night: '夜' };
export const WEATHER_LABELS = { clear: '晴れ', cloudy: 'くもり', rain: '雨', fog: '霧' };
export const VIEW_LABELS = { chase: '後方', fp: '目線', cine: 'シネマ' };

export const TIME_OPTIONS = ENVIRONMENT_TIMES.map((id) => ({ id, label: TIME_LABELS[id] ?? id }));
export const WEATHER_OPTIONS = ENVIRONMENT_WEATHERS.map((id) => ({ id, label: WEATHER_LABELS[id] ?? id }));

/** 上野不忍池(PondScene)は時間帯だけを反映し、天候は出さない。 */
export function supportsWeather(courseProfile) {
  return courseProfile?.scenery !== 'ueno';
}

/** コースで選べる視点。上野不忍池は後方/目線のみ(シネマは後方扱い)。 */
export function viewsFor(courseProfile) {
  return courseProfile?.scenery === 'ueno' ? CAMERA_VIEWS.filter((v) => v !== 'cine') : CAMERA_VIEWS.slice();
}

/** 保存値をコースで選べる視点にそろえる(上野でシネマなら後方)。 */
export function effectiveView(view, courseProfile) {
  const views = viewsFor(courseProfile);
  return views.includes(view) ? view : 'chase';
}

/** 後方 → 目線 → シネマ → 後方 …(上野は 後方 ⇄ 目線)。 */
export function nextView(view, courseProfile) {
  const views = viewsFor(courseProfile);
  const i = views.indexOf(effectiveView(view, courseProfile));
  return views[(i + 1) % views.length];
}

/** チップ等に出す環境の短い表示(上野は時間帯のみ)。 */
export function environmentLabel(env, courseProfile) {
  const time = TIME_LABELS[env?.time] ?? '--';
  return supportsWeather(courseProfile) ? `${time} · ${WEATHER_LABELS[env?.weather] ?? '--'}` : time;
}
