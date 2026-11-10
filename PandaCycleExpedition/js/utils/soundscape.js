// 走行中の音(Web Audio)。音のファイルは使わず、ノイズと発振器から作る(ビルドなし・素材なしの方針)。
// 大きさは soundMix.js の値をそのまま受け取り、急に変わらないようにゆっくり近づける。
//
//  - 風・タイヤ・波・雨・トンネルの響き: ノイズを帯域フィルタで色づけしたもの。波はゆっくり大きさを揺らす
//  - 砂利: まばらな「パチッ」という粒のノイズを繰り返し、速さで再生の速さを変える
//  - セミ・コオロギ・鳥: 発振器。コオロギと鳥は時々鳴かせる
// AudioContext はブラウザの決まりでユーザー操作の後でないと鳴らないので、resume() を出発のボタンの後に呼ぶ。

const SMOOTH_S = 0.4;
const MASTER = 0.5;

/** 白色ノイズ(秒数ぶん)。 */
function noiseBuffer(ctx, seconds, fill) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  fill(buf.getChannelData(0), ctx.sampleRate);
  return buf;
}

function white(d) {
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

/** 低い音の多いノイズ(ブラウン)。波・風・トンネルに。 */
function brown(d) {
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
}

/** 砂利を踏む音: まばらな短い粒(粒の数は1秒に約 90)。 */
function crunch(d, rate) {
  d.fill(0);
  const grains = Math.floor((d.length / rate) * 90);
  for (let g = 0; g < grains; g++) {
    const at = Math.floor(Math.random() * d.length);
    const len = Math.floor(rate * (0.002 + Math.random() * 0.006));
    const amp = 0.3 + Math.random() * 0.7;
    for (let i = 0; i < len && at + i < d.length; i++) d[at + i] += (Math.random() * 2 - 1) * amp * (1 - i / len);
  }
}

/**
 * @returns {{update:(mix:object, speedKmh:number)=>void, setEnabled:(on:boolean)=>void, resume:()=>void, dispose:()=>void}|null}
 *   Web Audio が使えない環境では null
 */
export function createSoundscape({ enabled = true } = {}) {
  const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  const master = ctx.createGain();
  master.gain.value = enabled ? MASTER : 0;
  master.connect(ctx.destination);
  const nodes = [];
  const keep = (n) => (nodes.push(n), n);

  /** ノイズを流し続ける1つの音。gain を外から動かす。 */
  function loop(buf, filters, rate = 1) {
    const src = keep(ctx.createBufferSource());
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    const gain = keep(ctx.createGain());
    gain.gain.value = 0;
    let at = src;
    for (const [type, freq, q = 0.7] of filters) {
      const f = keep(ctx.createBiquadFilter());
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      at.connect(f);
      at = f;
    }
    at.connect(gain);
    gain.connect(master);
    src.start();
    return { src, gain };
  }

  const whiteBuf = noiseBuffer(ctx, 3, white);
  const brownBuf = noiseBuffer(ctx, 4, brown);
  const ch = {
    wind: loop(brownBuf, [['lowpass', 900], ['highpass', 80]]),
    tire: loop(whiteBuf, [['bandpass', 1800, 0.5]]),
    gravel: loop(noiseBuffer(ctx, 2, crunch), [['highpass', 900], ['lowpass', 6000]]),
    sea: loop(brownBuf, [['lowpass', 500]], 0.8),
    rain: loop(whiteBuf, [['highpass', 1200], ['lowpass', 9000]], 0.9),
    tunnel: loop(brownBuf, [['lowpass', 220]], 0.6),
  };
  const LEVEL = { wind: 0.5, tire: 0.08, gravel: 0.35, sea: 0.45, rain: 0.25, tunnel: 0.5 };

  // 波の満ち引き: 大きさをゆっくり揺らす(約 9 秒周期)
  const swell = keep(ctx.createOscillator());
  swell.frequency.value = 0.11;
  const swellAmt = keep(ctx.createGain());
  swellAmt.gain.value = 0;
  swell.connect(swellAmt);
  swellAmt.connect(ch.sea.gain.gain);
  swell.start();

  // セミ: 高い音を細かく震わせ続ける
  const cicadaGain = keep(ctx.createGain());
  cicadaGain.gain.value = 0;
  const cicada = keep(ctx.createOscillator());
  cicada.type = 'sawtooth';
  cicada.frequency.value = 4200;
  const cicadaAm = keep(ctx.createOscillator());
  cicadaAm.frequency.value = 38;
  const cicadaAmGain = keep(ctx.createGain());
  cicadaAmGain.gain.value = 0.5;
  const cicadaVca = keep(ctx.createGain());
  cicadaVca.gain.value = 0.5;
  cicadaAm.connect(cicadaAmGain);
  cicadaAmGain.connect(cicadaVca.gain);
  const cicadaBp = keep(ctx.createBiquadFilter());
  cicadaBp.type = 'bandpass';
  cicadaBp.frequency.value = 4500;
  cicadaBp.Q.value = 4;
  cicada.connect(cicadaVca);
  cicadaVca.connect(cicadaBp);
  cicadaBp.connect(cicadaGain);
  cicadaGain.connect(master);
  cicada.start();
  cicadaAm.start();

  let target = {};
  let nextCricket = 0;
  let nextBird = 0;

  /** 短い音を1つ鳴らす(コオロギ・鳥)。 */
  function blip(freq, freqEnd, dur, vol, at) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(freq, at);
    o.frequency.exponentialRampToValueAtTime(freqEnd, at + dur);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + dur * 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g);
    g.connect(master);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  return {
    /** 毎フレーム呼んでよい(大きさはゆっくり近づく)。mix は soundMix() の値。 */
    update(mix, speedKmh = 0) {
      const now = ctx.currentTime;
      for (const [k, c] of Object.entries(ch)) {
        const v = (mix[k] ?? 0) * LEVEL[k];
        if (Math.abs((target[k] ?? -1) - v) > 0.005) {
          c.gain.gain.setTargetAtTime(v, now, SMOOTH_S);
          target[k] = v;
        }
      }
      swellAmt.gain.setTargetAtTime((mix.sea ?? 0) * LEVEL.sea * 0.6, now, SMOOTH_S);
      // 砂利の粒は速いほど細かく
      ch.gravel.src.playbackRate.setTargetAtTime(0.5 + Math.min(speedKmh, 40) / 25, now, SMOOTH_S);
      cicadaGain.gain.setTargetAtTime((mix.cicada ?? 0) * 0.025, now, 1.5);
      if ((mix.cricket ?? 0) > 0 && now >= nextCricket) {
        // リッ・リッ・リッ と3回
        for (let i = 0; i < 3; i++) blip(4700, 4600, 0.05, 0.03 * mix.cricket, now + i * 0.09);
        nextCricket = now + 0.8 + Math.random() * 1.6;
      }
      if ((mix.birds ?? 0) > 0 && now >= nextBird) {
        // ピーチュ、ピー と高く短く
        const f = 2400 + Math.random() * 1600;
        blip(f, f * 1.4, 0.12, 0.04 * mix.birds, now);
        blip(f * 1.2, f * 0.9, 0.18, 0.035 * mix.birds, now + 0.18);
        nextBird = now + 3 + Math.random() * 7;
      }
    },
    setEnabled(on) {
      master.gain.setTargetAtTime(on ? MASTER : 0, ctx.currentTime, 0.1);
      if (on) ctx.resume().catch(() => {});
    },
    resume() {
      ctx.resume().catch(() => {});
    },
    dispose() {
      for (const n of nodes) {
        try { n.stop?.(); } catch { /* 止まっている */ }
        n.disconnect();
      }
      ctx.close().catch(() => {});
    },
  };
}
