// audio.js
// A small amount of synthesized ambience to reinforce the underwater feel
// without shipping any audio files. Must be started from a user gesture
// (browser autoplay policy) — call start() from a click/submit handler.

export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.filter = null;
    this.started = false;
    this.muted = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // Web Audio unavailable; fail silently
    this.ctx = new Ctx();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.18;
    this.masterGain.connect(this.ctx.destination);

    // Filtered noise buffer = a soft, unpitched underwater rumble.
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.02 * white) / 1.02; // brown-noise-ish integration
      data[i] = lastOut * 6;
    }
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 400;

    noiseSource.connect(this.filter).connect(this.masterGain);
    noiseSource.start();

    // Slow LFO drifting the filter cutoff for a gentle "current" movement.
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(this.filter.frequency);
    lfo.start();

    // A soft low sine adds body/depth without being tonal or distracting.
    const drone = this.ctx.createOscillator();
    drone.type = "sine";
    drone.frequency.value = 55;
    const droneGain = this.ctx.createGain();
    droneGain.gain.value = 0.05;
    drone.connect(droneGain).connect(this.masterGain);
    drone.start();
  }

  /** Nudges the filter brighter/louder with effort, subtly, no accents. */
  setIntensity(power) {
    if (!this.filter) return;
    const target = 350 + Math.min(power, 400) * 1.5;
    this.filter.frequency.setTargetAtTime(target, this.ctx.currentTime, 0.8);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.18, this.ctx?.currentTime ?? 0, 0.15);
    }
  }
}
