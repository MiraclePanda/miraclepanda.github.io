// パワーゾーンの判定(フルスクリーンHUDのゾーンバー用)。
// PR2+3 仕様 §1.1 に対応。FTP に対するパワーの比で 7 段(0〜6)に分ける:
//   <0.55 → 0 / <0.75 → 1 / <0.90 → 2 / <1.05 → 3 / <1.20 → 4 / <1.50 → 5 / それ以上 → 6
// 心拍ゾーンは HRmax の設定がないため扱わない。

export const ZONE_THRESHOLDS = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];

// watts: 現在のパワー(W)、ftpW: FTP(W)。不正値(数値でない・FTPが0以下・負のパワー)は 0 を返す。
// 比は watts / ftpW の割り算で求める(閾値×FTP の掛け算だと 0.55×200 が 110.00000000000001
// になり、ちょうど境界の 110W が下の段に落ちるため)。
export function powerZone(watts, ftpW) {
  const w = Number(watts);
  const ftp = Number(ftpW);
  if (watts === null || watts === undefined || ftpW === null || ftpW === undefined) return 0;
  if (!Number.isFinite(w) || !Number.isFinite(ftp) || ftp <= 0 || w <= 0) return 0;
  const ratio = w / ftp;
  for (let i = 0; i < ZONE_THRESHOLDS.length; i++) {
    if (ratio < ZONE_THRESHOLDS[i]) return i;
  }
  return ZONE_THRESHOLDS.length;
}
