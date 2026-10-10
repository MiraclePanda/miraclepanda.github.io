// 観光地コースのバスガイド風アナウンス(「右手に見えますのが…」)。
// コースプロファイルの guide = [{ km, title, sub }] を1周ごとに繰り返し、その地点を通過したら通知する。
// ループしない実在コース(fixedLength)は繰り返さない。見た目の通知だけで、走行には影響しない。

/**
 * fromM → toM の間に通過したアナウンス。
 * @returns {Array<object>} 通知(RideScreen の showToast の形)
 */
export function guideEventsBetween(profile, fromM, toM) {
  const guide = Array.isArray(profile?.guide) ? profile.guide : [];
  const a = Number(fromM);
  const b = Number(toM);
  if (guide.length === 0 || !Number.isFinite(a) || !Number.isFinite(b) || !(b > a)) return [];
  const loopM = (profile.loopLengthKm ?? 0) * 1000;
  const repeat = loopM > 0 && !profile.fixedLength;
  const firstLoop = repeat ? Math.max(0, Math.floor(a / loopM)) : 0;
  const lastLoop = repeat ? Math.floor(b / loopM) : 0;
  const out = [];
  for (let loop = firstLoop; loop <= lastLoop; loop++) {
    for (const g of guide) {
      const at = loop * loopM + g.km * 1000;
      if (at > a && at <= b) {
        out.push({ kind: 'guide', kicker: '🚩 観光ガイド', title: g.title, sub: g.sub ?? '' });
      }
    }
  }
  return out;
}
