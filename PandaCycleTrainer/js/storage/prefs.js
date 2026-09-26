// 体重・自転車重量のデフォルト値をlocalStorageに保存/復元する。
// 要件定義書5章「入力値のデフォルト記憶」に対応。
// 走行距離・コース選択は毎回リセットする仕様のため、ここには含めない。

const KEY = 'pct_prefs_v1';

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      weightKg: typeof parsed.weightKg === 'number' ? parsed.weightKg : undefined,
      bikeWeightKg: typeof parsed.bikeWeightKg === 'number' ? parsed.bikeWeightKg : undefined,
    };
  } catch (e) {
    return {};
  }
}

export function savePrefs({ weightKg, bikeWeightKg }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ weightKg, bikeWeightKg }));
  } catch (e) {
    // localStorageが使用不可(プライベートモード等)の場合は無視する。
  }
}
