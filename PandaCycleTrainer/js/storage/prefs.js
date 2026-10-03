// 前回の走行設定をlocalStorageに保存/復元する。
// 要件定義書5章「入力値のデフォルト記憶」に対応(当初は体重・自転車重量のみ)。
// ユーザー要望により、走行距離と詳細設定(転がり抵抗係数Crr・空気抵抗係数CdA)も
// 記憶するよう拡張した。オプションのバイク種別(標準/スワンボート)も記憶する。
// コース選択・負荷率は従来どおり毎回リセットする。
// PR2+3 で FTP(ftpW、パワーゾーン表示の基準)を同じキーに追加した。既存の保存値はそのまま読める。
// あわせて、走行画面の環境(時間帯・天候)・視点・ゴースト選択・集団走行の有無・
// 友人のゴースト(TCX から読み込んだトラック)も localStorage に保存する。

import { LIMITS } from '../utils/validation.js';

const KEY = 'pct_prefs_v1';

const FIELDS = ['distanceKm', 'weightKg', 'bikeWeightKg', 'crr', 'cdaM2'];
const VEHICLE_VALUES = ['bike', 'swan'];

// FTP の既定値(W)。未設定・範囲外の保存値はこれに戻す。
export const DEFAULT_FTP_W = 200;

function sanitizeFtp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= LIMITS.ftpW.min && value <= LIMITS.ftpW.max
    ? value
    : DEFAULT_FTP_W;
}

// 戻り値の ftpW は常に数値(既定 200)。他のフィールドは従来どおり未保存・不正なら undefined。
export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ftpW: DEFAULT_FTP_W };
    const parsed = JSON.parse(raw);
    const prefs = {};
    for (const field of FIELDS) {
      prefs[field] = typeof parsed?.[field] === 'number' && Number.isFinite(parsed[field]) ? parsed[field] : undefined;
    }
    prefs.vehicle = VEHICLE_VALUES.includes(parsed?.vehicle) ? parsed.vehicle : undefined;
    prefs.ftpW = sanitizeFtp(parsed?.ftpW);
    return prefs;
  } catch (e) {
    return { ftpW: DEFAULT_FTP_W };
  }
}

// ftpW を省略した呼び出し(従来の呼び出し方)では、保存済みの ftpW を消さずに残す。
export function savePrefs({ distanceKm, weightKg, bikeWeightKg, crr, cdaM2, vehicle, ftpW }) {
  try {
    let keepFtp;
    if (ftpW === undefined) {
      try {
        keepFtp = JSON.parse(localStorage.getItem(KEY) ?? 'null')?.ftpW;
      } catch (e) {
        keepFtp = undefined;
      }
    } else {
      keepFtp = ftpW;
    }
    const value = { distanceKm, weightKg, bikeWeightKg, crr, cdaM2, vehicle };
    if (typeof keepFtp === 'number' && Number.isFinite(keepFtp)) value.ftpW = keepFtp;
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}

// 走行画面の「描画品質」(auto / high / medium / low)。セットアップ入力とは独立に、
// 変更した時点で保存し、次の走行でも同じ設定から始める。
const RENDER_QUALITY_KEY = 'pct_render_quality_v1';
const RENDER_QUALITY_VALUES = ['auto', 'high', 'medium', 'low'];

export function loadRenderQuality() {
  try {
    const value = localStorage.getItem(RENDER_QUALITY_KEY);
    return RENDER_QUALITY_VALUES.includes(value) ? value : 'auto';
  } catch (e) {
    return 'auto';
  }
}

export function saveRenderQuality(value) {
  if (!RENDER_QUALITY_VALUES.includes(value)) return;
  try {
    localStorage.setItem(RENDER_QUALITY_KEY, value);
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}

// ---------------------------------------------------------------------------
// 走行画面の環境(時間帯・天候)。PR2+3 仕様 §2。
// 値の一覧は three/environmentPresets.js の TIMES / WEATHERS のキーと一致させること
// (storage から three を参照しないよう、ここではキー名だけを持つ)。
// ---------------------------------------------------------------------------
const ENVIRONMENT_KEY = 'pct_environment_v1';
export const ENVIRONMENT_TIMES = ['morning', 'noon', 'sunset', 'night'];
export const ENVIRONMENT_WEATHERS = ['clear', 'cloudy', 'rain', 'fog'];
const DEFAULT_ENVIRONMENT = { time: 'noon', weather: 'clear' };

export function loadEnvironment() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ENVIRONMENT_KEY) ?? 'null');
    return {
      time: ENVIRONMENT_TIMES.includes(parsed?.time) ? parsed.time : DEFAULT_ENVIRONMENT.time,
      weather: ENVIRONMENT_WEATHERS.includes(parsed?.weather) ? parsed.weather : DEFAULT_ENVIRONMENT.weather,
    };
  } catch (e) {
    return { ...DEFAULT_ENVIRONMENT };
  }
}

export function saveEnvironment(env) {
  const time = ENVIRONMENT_TIMES.includes(env?.time) ? env.time : DEFAULT_ENVIRONMENT.time;
  const weather = ENVIRONMENT_WEATHERS.includes(env?.weather) ? env.weather : DEFAULT_ENVIRONMENT.weather;
  try {
    localStorage.setItem(ENVIRONMENT_KEY, JSON.stringify({ time, weather }));
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}

// ---------------------------------------------------------------------------
// 視点(後方 chase / 一人称 fp / 映画風 cine)。PR2+3 仕様 §3。既定は従来どおりの chase。
// ---------------------------------------------------------------------------
const CAMERA_VIEW_KEY = 'pct_camera_view_v1';
export const CAMERA_VIEWS = ['chase', 'fp', 'cine'];

export function loadCameraView() {
  try {
    const value = localStorage.getItem(CAMERA_VIEW_KEY);
    return CAMERA_VIEWS.includes(value) ? value : 'chase';
  } catch (e) {
    return 'chase';
  }
}

export function saveCameraView(value) {
  if (!CAMERA_VIEWS.includes(value)) return;
  try {
    localStorage.setItem(CAMERA_VIEW_KEY, value);
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}

// ---------------------------------------------------------------------------
// ゴースト選択。PR2+3 仕様 §5.2。'pb'(自己ベスト)または友人ゴーストの ID を最大2つ。
// ---------------------------------------------------------------------------
const GHOST_SELECTION_KEY = 'pct_ghost_selection_v1';
export const PB_GHOST_ID = 'pb';
export const MAX_GHOSTS = 2;

function sanitizeGhostSelection(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_GHOSTS) break;
  }
  return out;
}

export function loadGhostSelection() {
  try {
    return sanitizeGhostSelection(JSON.parse(localStorage.getItem(GHOST_SELECTION_KEY) ?? 'null'));
  } catch (e) {
    return [];
  }
}

export function saveGhostSelection(ids) {
  try {
    localStorage.setItem(GHOST_SELECTION_KEY, JSON.stringify(sanitizeGhostSelection(ids)));
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}

// ---------------------------------------------------------------------------
// 集団走行の有無。PR2+3 仕様 §6。既定はオン。
// ---------------------------------------------------------------------------
const PACK_ENABLED_KEY = 'pct_pack_enabled_v1';

export function loadPackEnabled() {
  try {
    const value = localStorage.getItem(PACK_ENABLED_KEY);
    if (value === '0') return false;
    return true;
  } catch (e) {
    return true;
  }
}

export function savePackEnabled(enabled) {
  try {
    localStorage.setItem(PACK_ENABLED_KEY, enabled ? '1' : '0');
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}

// ---------------------------------------------------------------------------
// 友人のゴースト。PR2+3 仕様 §5.2。
// IndexedDB に新しいストアは作らず、localStorage にコースIDごと最大3件を保存する
// (4件目を保存すると、そのコースで一番古いものから消える)。
// 保存形式: [{ id, name, courseId, importedAt, points: number[] }]。
// points は容量節約のため 0.1 秒・0.1m に丸めて通常配列で保存し、読み出し時に Float64Array に戻す。
// ---------------------------------------------------------------------------
const FRIEND_GHOSTS_KEY = 'pct_friend_ghosts_v1';
export const MAX_FRIEND_GHOSTS_PER_COURSE = 3;

function readFriendGhosts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FRIEND_GHOSTS_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (g) =>
        g &&
        typeof g.id === 'string' &&
        typeof g.courseId === 'string' &&
        Array.isArray(g.points) &&
        g.points.length >= 2 &&
        g.points.length % 2 === 0 &&
        g.points.every((v) => typeof v === 'number' && Number.isFinite(v)),
    );
  } catch (e) {
    return [];
  }
}

function writeFriendGhosts(list) {
  localStorage.setItem(FRIEND_GHOSTS_KEY, JSON.stringify(list));
}

// courseId を省略すると全コース分を返す(履歴画面での一覧用)。新しいものが先頭。
export function loadFriendGhosts(courseId) {
  return readFriendGhosts()
    .filter((g) => courseId === undefined || g.courseId === courseId)
    .sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0))
    .map((g) => ({
      id: g.id,
      name: typeof g.name === 'string' && g.name ? g.name : '友人のゴースト',
      courseId: g.courseId,
      importedAt: typeof g.importedAt === 'number' ? g.importedAt : 0,
      points: Float64Array.from(g.points),
    }));
}

// track: ghostTrack.js の形式 + courseId(文字列必須)。採番した id を返す。
// courseId がない・点がない・localStorage に書けない(容量超過など)場合は null を返す。
export function saveFriendGhost(track) {
  const courseId = track?.courseId;
  const points = track?.points;
  if (typeof courseId !== 'string' || courseId === '' || !points || points.length < 2) return null;
  const rounded = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    const t = Number(points[i]);
    const d = Number(points[i + 1]);
    if (!Number.isFinite(t) || !Number.isFinite(d)) continue;
    rounded.push(Math.round(t * 10) / 10, Math.round(d * 10) / 10);
  }
  if (rounded.length < 2) return null;
  const list = readFriendGhosts();
  // 同じミリ秒に続けて保存しても古い順が崩れないよう、既存より必ず新しい時刻にする
  const importedAt = list.reduce((max, g) => Math.max(max, (g.importedAt ?? 0) + 1), Date.now());
  const id = `fg_${importedAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    name: typeof track.name === 'string' && track.name.trim() ? track.name.trim() : '友人のゴースト',
    courseId,
    importedAt,
    points: rounded,
  };
  list.push(entry);
  // 同じコースで上限を超えた分を古い順に消す
  const sameCourse = list
    .filter((g) => g.courseId === courseId)
    .sort((a, b) => (a.importedAt ?? 0) - (b.importedAt ?? 0));
  const removeIds = new Set(
    sameCourse.slice(0, Math.max(0, sameCourse.length - MAX_FRIEND_GHOSTS_PER_COURSE)).map((g) => g.id),
  );
  const kept = list.filter((g) => !removeIds.has(g.id));
  try {
    writeFriendGhosts(kept);
  } catch (e) {
    return null;
  }
  if (removeIds.size > 0) dropFromGhostSelection(removeIds);
  return id;
}

export function deleteFriendGhost(id) {
  const list = readFriendGhosts();
  const kept = list.filter((g) => g.id !== id);
  if (kept.length === list.length) return;
  try {
    writeFriendGhosts(kept);
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
  dropFromGhostSelection(new Set([id]));
}

// 消えた友人ゴーストをゴースト選択からも外す
function dropFromGhostSelection(ids) {
  const current = loadGhostSelection();
  const next = current.filter((id) => !ids.has(id));
  if (next.length !== current.length) saveGhostSelection(next);
}
