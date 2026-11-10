// 走行中の音の混ぜ具合(純粋な計算。音を鳴らすのは soundscape.js)。
//
// 音のファイルは使わず、ブラウザの中でノイズと発振器から作る。ここではいまの様子(速さ・路面・海沿いか・トンネル・天気・
// 季節・時刻)から、それぞれの音の大きさ(0〜1)を決める。見た目と同じく旅の雰囲気のためだけで、物理・トレーナーには使わない。

/** 夜とみなす時刻(旅の分)。虫の声は夕方から、鳥は朝から昼。 */
const DAWN = 5 * 60;
const DUSK = 17 * 60;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * @param {object} s
 * @param {number} s.speedKmh 速さ
 * @param {boolean} s.unpaved 未舗装の路面か
 * @param {boolean} s.seaSide 海沿いの区間か
 * @param {boolean} s.inTunnel トンネルの中か
 * @param {string} s.weatherKind 'sunny' | 'cloudy' | 'rain' | 'squall'
 * @param {string|null} s.season 'spring' | 'summer' | 'autumn' | 'winter'
 * @param {number} s.clockMinutes 旅の時刻(0:00 からの分)
 * @returns {{wind:number, tire:number, gravel:number, sea:number, rain:number, cicada:number, cricket:number, birds:number, tunnel:number}}
 */
export function soundMix({ speedKmh = 0, unpaved = false, seaSide = false, inTunnel = false, weatherKind = 'sunny', season = null, clockMinutes = 12 * 60 }) {
  const v = clamp01(speedKmh / 45);
  const moving = speedKmh > 1;
  const stormy = weatherKind === 'squall';
  const rainy = weatherKind === 'rain' || stormy;
  const outside = inTunnel ? 0 : 1;
  const clock = ((clockMinutes % 1440) + 1440) % 1440;
  const day = clock >= DAWN + 30 && clock < DUSK;
  const evening = clock >= DUSK - 60 || clock < DAWN;
  // 雨・トンネルの中では生き物の声は聞こえない
  const quietLife = rainy || inTunnel ? 0 : 1;
  return {
    // 風切り音: 速さの2乗で大きくなる。スコールは止まっていても吹く
    wind: clamp01(v * v * 0.9 + (stormy ? 0.35 : 0)) * (inTunnel ? 0.6 : 1),
    // 舗装のタイヤのさーっという音
    tire: moving && !unpaved ? clamp01(0.15 + v * 0.6) : 0,
    // 砂利を踏む音
    gravel: moving && unpaved ? clamp01(0.35 + v * 0.8) : 0,
    sea: seaSide ? (stormy ? 0.9 : 0.55) * outside : 0,
    rain: (stormy ? 1 : rainy ? 0.55 : 0) * outside,
    cicada: season === 'summer' && day ? 0.6 * quietLife : 0,
    cricket: (season === 'autumn' || season === 'summer') && evening ? 0.5 * quietLife : 0,
    birds: (season === 'spring' || season === 'summer' || season === 'autumn') && clock >= DAWN && clock < 12 * 60 ? 0.5 * quietLife
      : season === 'winter' && day ? 0.2 * quietLife : 0,
    // トンネルの中の響き(こもった低い音)
    tunnel: inTunnel ? clamp01(0.4 + v * 0.6) : 0,
  };
}
