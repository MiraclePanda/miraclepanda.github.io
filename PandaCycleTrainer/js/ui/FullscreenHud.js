import { h, useRef } from './h.js';

const { forwardRef, useImperativeHandle } = React;

/**
 * フルスクリーン表示時に3D風景の左端へ重ねる走行データ。
 * Dashboardと同じく、高頻度更新はReactの再レンダリングを経由せず、
 * ref経由でtextContentを直接書き換える。
 */
export const FullscreenHud = forwardRef(function FullscreenHud({ paused, communicationWarning }, ref) {
  const refs = {
    power: useRef(null),
    cadence: useRef(null),
    virtualSpeed: useRef(null),
    distanceDone: useRef(null),
    distanceRemaining: useRef(null),
    ridingTime: useRef(null),
    loadRatio: useRef(null),
  };

  useImperativeHandle(ref, () => ({
    update(v) {
      for (const key of Object.keys(refs)) {
        if (refs[key].current && v[key] !== undefined) refs[key].current.textContent = v[key];
      }
    },
  }));

  return h(
    'div', { className: 'fs-hud', 'aria-live': 'off' },
    paused && h('div', { className: 'fs-hud-badge' }, '一時停止中'),
    communicationWarning && h('div', { className: 'fs-hud-badge fs-hud-warning' }, '⚠ 通信が不安定です'),
    item('パワー', refs.power, 'W'),
    item('ケイデンス', refs.cadence, 'rpm'),
    item('仮想速度', refs.virtualSpeed, 'km/h'),
    item('走行距離', refs.distanceDone, 'km'),
    item('残距離', refs.distanceRemaining, 'km'),
    item('走行時間', refs.ridingTime, ''),
    item('負荷率', refs.loadRatio, '%')
  );
});

function item(label, ref, unit) {
  return h(
    'div', { className: 'fs-hud-item' },
    h('div', { className: 'fs-hud-label' }, label),
    h('div', { className: 'fs-hud-value' }, h('span', { ref }, '--'), unit && h('span', { className: 'fs-hud-unit' }, unit))
  );
}
