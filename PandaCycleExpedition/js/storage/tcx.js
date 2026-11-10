// TCX (Training Center XML) 形式でのエクスポート(設計書5章: GPS 座標は入れない)。
// 旅の1日の走行記録(tripState の ride.samples / lastTrack)を TCX にして保存する。
//  - GPS座標(<Position>)は含めない。ダミー座標による偽装も行わない
//  - ケイデンス・パワーはTrackpointに含める
//
// Strava 側の「バーチャルライド」認識について:
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
        <Name>PandaCycleExpedition</Name>
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

/**
 * その日の走行記録: 走行中(trip.ride)か、最後に終えた日(trip.lastTrack)。無ければ null。
 * @returns {{day:number, startedAt:number, samples:number[][]}|null}
 */
export function trackForDay(trip, day) {
  const r = trip.ride;
  if (r && r.day === day && r.samples?.length) return { day, startedAt: r.startedAt, samples: r.samples };
  const t = trip.lastTrack;
  return t && t.day === day && t.samples?.length ? t : null;
}

/**
 * 走行記録を buildTcx の record にする。点は [走行秒, 距離 m, パワー W, ケイデンス rpm]。
 * 時刻は「走り出した時刻 + 走行秒」(休憩・食事の止まっていた時間は詰める)。
 */
export function trackToRecord(track) {
  const samples = track.samples.map(([s, m, w, c]) => ({ tOffsetS: s, distanceM: m, powerW: w, cadenceRpm: c }));
  const last = samples[samples.length - 1];
  return { startTime: track.startedAt, samples, ridingTimeS: last?.tOffsetS ?? 0, totalDistanceM: last?.distanceM ?? 0 };
}

/** 旅の d 日目の走行記録を TCX ファイルとして保存する(ファイル名に日数を入れる)。 */
export function downloadTrackTcx(track) {
  downloadTcx(trackToRecord(track), `day${track.day}`);
}

export function downloadTcx(record, label = '') {
  const xml = buildTcx(record);
  const blob = new Blob([xml], { type: 'application/vnd.garmin.tcx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date(record.startTime).toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `PandaCycleExpedition_${label ? `${label}_` : ''}${dateStr}.tcx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
