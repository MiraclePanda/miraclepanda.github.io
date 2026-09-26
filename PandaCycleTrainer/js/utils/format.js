// 表示用フォーマット関数群。null/undefinedの場合は「--」を表示する。
// 要件定義書3章「Indoor Bike Dataのフィールド欠落」ガード処理に対応。

export function fmt(value, digits = 0, unit = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '--';
  return `${value.toFixed(digits)}${unit}`;
}

export function fmtTime(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || Number.isNaN(totalSeconds)) return '--:--';
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(sec)}`;
  }
  return `${pad(m)}:${pad(sec)}`;
}

function pad(n) {
  return n.toString().padStart(2, '0');
}
