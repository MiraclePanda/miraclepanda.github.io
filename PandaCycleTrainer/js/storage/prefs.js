// 前回の走行設定をlocalStorageに保存/復元する。
// 要件定義書5章「入力値のデフォルト記憶」に対応(当初は体重・自転車重量のみ)。
// ユーザー要望により、走行距離と詳細設定(転がり抵抗係数Crr・空気抵抗係数CdA)も
// 記憶するよう拡張した。コース選択・負荷率は従来どおり毎回リセットする。

const KEY = 'pct_prefs_v1';

const FIELDS = ['distanceKm', 'weightKg', 'bikeWeightKg', 'crr', 'cdaM2'];

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const prefs = {};
    for (const field of FIELDS) {
      prefs[field] = typeof parsed?.[field] === 'number' && Number.isFinite(parsed[field]) ? parsed[field] : undefined;
    }
    return prefs;
  } catch (e) {
    return {};
  }
}

export function savePrefs({ distanceKm, weightKg, bikeWeightKg, crr, cdaM2 }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ distanceKm, weightKg, bikeWeightKg, crr, cdaM2 }));
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
