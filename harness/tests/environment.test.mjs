import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMES, WEATHERS, TIME_IDS, WEATHER_IDS, resolveEnvironment, normalizeEnvironment, sameSky,
  FOG_FAR_K, MIN_FOG_FAR_M,
} from '../../PandaCycleTrainer/js/three/environmentPresets.js';

const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// 各シーンの「昼・晴れ」の値(CityScene / LandscapeScene の湖畔・熱海 / PondScene と同じ形)
const BASES = {
  city: {
    zenith: '#3f78c2', horizon: '#c9d9e6', ground: '#9aa3a8', sunColor: '#fff1dc', sunDir: unit([-0.5558, 0.7276, 0.4042]),
    sunIntensity: 2.6, hemiSky: 0xcfe0f5, hemiGround: 0x77736a, hemiIntensity: 0.55, fogDensity: 0.0055, exposure: 1.05,
  },
  lakeside: {
    zenith: '#3a7cc9', horizon: '#d3e3ee', ground: '#8ea39a', sunColor: '#fff3de', sunDir: unit([-0.5, 0.6, -0.62]),
    sunIntensity: 2.6, hemiSky: 0xcfe2f5, hemiGround: 0x6f7a5a, hemiIntensity: 0.6, fogDensity: 0.00042, exposure: 1.05,
  },
  atami: {
    zenith: '#2f7ad6', horizon: '#d9e8f2', ground: '#a3b6bc', sunColor: '#fff4e0', sunDir: unit([-0.55, 0.55, -0.6]),
    sunIntensity: 2.6, hemiSky: 0xd4e6f7, hemiGround: 0x8a8272, hemiIntensity: 0.6, fogDensity: 0.00018, exposure: 1.05,
  },
  pond: {
    zenith: '#3677c8', horizon: '#dde6ee', ground: '#a4aeb2', sunColor: '#fff2dc', sunDir: unit([-0.5, 0.62, 0.4]),
    sunIntensity: 2.5, hemiSky: 0xd0e2f4, hemiGround: 0x7a7564, hemiIntensity: 0.6, fogDensity: 0.00055, exposure: 1.05,
  },
};

const HEX = /^#[0-9a-f]{6}$/;

test('TIMES / WEATHERS have the four presets each', () => {
  assert.deepEqual(TIME_IDS, ['morning', 'noon', 'sunset', 'night']);
  assert.deepEqual(WEATHER_IDS, ['clear', 'cloudy', 'rain', 'fog']);
  for (const id of TIME_IDS) assert.equal(typeof TIMES[id].label, 'string');
  for (const id of WEATHER_IDS) assert.equal(typeof WEATHERS[id].label, 'string');
});

for (const [name, base] of Object.entries(BASES)) {
  test(`resolveEnvironment(base, 'noon', 'clear') keeps every base value unchanged (${name})`, () => {
    const v = resolveEnvironment(base, 'noon', 'clear');
    for (const key of Object.keys(base)) assert.deepEqual(v[key], base[key], `key ${key}`);
    assert.equal(v.night, 0);
    assert.equal(v.rain, 0);
    assert.equal(v.wet, 0);
    // 空は従来のシェーダーで焼く(雲量0・太陽の輝き1・夜度0)
    assert.equal(v.cloudCover, 0);
    assert.equal(v.sunGlow, 1);
    assert.ok(sameSky(v, resolveEnvironment(base, 'noon', 'clear')));
  });

  test(`every time x weather combination stays within sane ranges (${name})`, () => {
    for (const time of TIME_IDS) {
      for (const weather of WEATHER_IDS) {
        const v = resolveEnvironment(base, time, weather);
        const tag = `${time}/${weather}`;
        assert.ok(v.fogFarM >= MIN_FOG_FAR_M, `${tag}: fog far ${v.fogFarM} >= 130`);
        assert.ok(v.fogDensity > 0 && v.fogDensity <= FOG_FAR_K / MIN_FOG_FAR_M + 1e-12, `${tag}: fog density ${v.fogDensity}`);
        assert.ok(Math.abs(FOG_FAR_K / v.fogDensity - v.fogFarM) < 1e-6 * v.fogFarM, `${tag}: fogFarM matches density`);
        // 霧・雨・夜で見通しが基準より長くなることはない
        assert.ok(v.fogDensity >= base.fogDensity * (1 - 1e-12), `${tag}: fog never thinner than the base`);
        for (const k of ['sunIntensity', 'hemiIntensity', 'exposure', 'night', 'rain', 'wet', 'cloudCover', 'sunGlow']) {
          assert.ok(Number.isFinite(v[k]) && v[k] >= 0, `${tag}: ${k}=${v[k]} >= 0`);
        }
        for (const k of ['night', 'rain', 'wet', 'cloudCover']) assert.ok(v[k] <= 1, `${tag}: ${k} <= 1`);
        for (const k of ['zenith', 'horizon', 'ground', 'sunColor', 'cloud']) assert.match(v[k], HEX, `${tag}: ${k}`);
        for (const k of ['hemiSky', 'hemiGround']) assert.ok(Number.isInteger(v[k]) && v[k] >= 0 && v[k] <= 0xffffff, `${tag}: ${k}`);
        assert.ok(Math.abs(Math.hypot(...v.sunDir) - 1) < 1e-9, `${tag}: sunDir is normalized`);
        assert.ok(v.sunDir[1] > 0, `${tag}: sun (moon) above the horizon`);
      }
    }
  });
}

test('weather fog shortens the view to the 130 m minimum; rain is wet and rainy', () => {
  const fog = resolveEnvironment(BASES.lakeside, 'noon', 'fog');
  assert.equal(fog.fogFarM, MIN_FOG_FAR_M);
  const rain = resolveEnvironment(BASES.city, 'noon', 'rain');
  assert.equal(rain.rain, 1);
  assert.equal(rain.wet, 1);
  assert.ok(rain.sunIntensity < BASES.city.sunIntensity);
  const clearMorning = resolveEnvironment(BASES.city, 'morning', 'clear');
  assert.equal(clearMorning.rain, 0);
  assert.equal(clearMorning.wet, 0);
});

test('night is dark with lit windows; noon cloudy keeps the base sun direction', () => {
  const night = resolveEnvironment(BASES.city, 'night', 'clear');
  assert.equal(night.night, 1);
  assert.ok(night.sunIntensity < BASES.city.sunIntensity * 0.2);
  const cloudy = resolveEnvironment(BASES.city, 'noon', 'cloudy');
  assert.deepEqual(cloudy.sunDir, BASES.city.sunDir);
  assert.notEqual(cloudy.zenith, BASES.city.zenith, 'clouds grey the sky');
  assert.ok(!sameSky(cloudy, resolveEnvironment(BASES.city, 'noon', 'clear')));
});

test('time changes keep the base sun azimuth (scene composition) and only change the elevation', () => {
  const base = BASES.atami;
  const az = Math.atan2(base.sunDir[0], base.sunDir[2]);
  for (const time of ['morning', 'sunset', 'night']) {
    const v = resolveEnvironment(base, time, 'clear');
    assert.ok(Math.abs(Math.atan2(v.sunDir[0], v.sunDir[2]) - az) < 1e-9, time);
    assert.ok(Math.abs(Math.asin(v.sunDir[1]) * 180 / Math.PI - TIMES[time].elevationDeg) < 1e-9, time);
  }
});

test('unknown ids fall back to noon / clear', () => {
  assert.deepEqual(resolveEnvironment(BASES.pond, 'dusk', 'snow'), resolveEnvironment(BASES.pond, 'noon', 'clear'));
  assert.deepEqual(normalizeEnvironment(undefined), { time: 'noon', weather: 'clear' });
  assert.deepEqual(normalizeEnvironment({ time: 'night' }), { time: 'night', weather: 'clear' });
  assert.deepEqual(normalizeEnvironment({ time: 'x', weather: 'rain' }), { time: 'noon', weather: 'rain' });
});

test('resolveEnvironment is pure (does not mutate the base)', () => {
  const base = structuredClone(BASES.city);
  resolveEnvironment(base, 'sunset', 'rain');
  assert.deepEqual(base, BASES.city);
});
