// TCX (Training Center XML) 形式でのエクスポート。
// 要件定義書6章に対応:
//  - GPS座標(<Position>)は含めない。ダミー座標による偽装も行わない
//  - ケイデンス・パワーはTrackpointに含める
//
// Strava側の「バーチャルライド」認識について事前調査した結果:
// StravaはGPS座標を含まないアクティビティを基本的に「屋内(Indoor)」として
// 扱い、GPSを伴う専用スマートトレーナー連携(Zwift等)由来のもののみを
// 厳密な「Virtual Ride」種別に分類する。本アプリはGPSを付与しない方針の
// ため、Strava上では「屋内ライド」として取り込まれる想定とし、
// アクティビティ種別を「バーチャルライド」に手動変更したい場合は
// Strava側の編集画面で行う必要がある旨をUIに明記する。

export function buildTcx(record) {
  const startIso = new Date(record.startTime).toISOString();
  const laps = buildLap(record);

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities>
    <Activity Sport="Biking">
      <Id>${escapeXml(startIso)}</Id>
${laps}
      <Creator xsi:type="Device_t">
        <Name>PandaCycleTrainer</Name>
        <UnitId>0</UnitId>
        <ProductID>0</ProductID>
        <Version>
          <VersionMajor>1</VersionMajor>
          <VersionMinor>0</VersionMinor>
          <BuildMajor>0</BuildMajor>
          <BuildMinor>0</BuildMinor>
        </Version>
      </Creator>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}

function buildLap(record) {
  const startIso = new Date(record.startTime).toISOString();
  const samples = record.samples ?? [];
  const trackpoints = samples
    .map((s) => {
      const t = new Date(record.startTime + s.tOffsetS * 1000).toISOString();
      const distanceM = Math.round(s.distanceM ?? 0);
      const cadenceEl =
        s.cadenceRpm !== null && s.cadenceRpm !== undefined
          ? `\n          <Cadence>${clampCadence(s.cadenceRpm)}</Cadence>`
          : '';
      const watts = s.powerW ?? 0;
      return `        <Trackpoint>
          <Time>${t}</Time>
          <DistanceMeters>${distanceM}</DistanceMeters>${cadenceEl}
          <Extensions>
            <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
              <Watts>${Math.round(watts)}</Watts>
            </TPX>
          </Extensions>
        </Trackpoint>`;
    })
    .join('\n');

  return `      <Lap StartTime="${startIso}">
        <TotalTimeSeconds>${Math.round(record.ridingTimeS ?? 0)}</TotalTimeSeconds>
        <DistanceMeters>${Math.round(record.totalDistanceM ?? 0)}</DistanceMeters>
        <Calories>0</Calories>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${trackpoints}
        </Track>
      </Lap>`;
}

function clampCadence(rpm) {
  // TCX Cadence(RunCadence/CyclingCadence相当)は0-254のuint8。
  return Math.max(0, Math.min(254, Math.round(rpm)));
}

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

export function downloadTcx(record) {
  const xml = buildTcx(record);
  const blob = new Blob([xml], { type: 'application/vnd.garmin.tcx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date(record.startTime).toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `PandaCycleTrainer_${dateStr}.tcx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
