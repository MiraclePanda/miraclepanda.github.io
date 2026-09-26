import { h, useRef } from './h.js';

const { forwardRef, useImperativeHandle } = React;

/**
 * 走行中ダッシュボード。
 * 高頻度更新はReactの再レンダリングを避け、ref経由でDOMのtextContentを
 * 直接書き換えることでアニメーションを滑らかにする。
 */
export const Dashboard = forwardRef(function Dashboard({ controlMode }, ref) {
  const refs = {
    power: useRef(null),
    cadence: useRef(null),
    virtualSpeed: useRef(null),
    realSpeed: useRef(null),
    heartRate: useRef(null),
    courseGrade: useRef(null),
    controlCalculated: useRef(null),
    controlActual: useRef(null),
    distanceDone: useRef(null),
    distanceRemaining: useRef(null),
    elevation: useRef(null),
    elevationGain: useRef(null),
    elapsedTime: useRef(null),
    ridingTime: useRef(null),
  };

  useImperativeHandle(ref, () => ({
    update(v) {
      setText(refs.power, v.power);
      setText(refs.cadence, v.cadence);
      setText(refs.virtualSpeed, v.virtualSpeed);
      setText(refs.realSpeed, v.realSpeed);
      setText(refs.heartRate, v.heartRate);
      setText(refs.courseGrade, v.courseGrade);
      setText(refs.controlCalculated, v.controlCalculated);
      setText(refs.controlActual, v.controlActual);
      setText(refs.distanceDone, v.distanceDone);
      setText(refs.distanceRemaining, v.distanceRemaining);
      setText(refs.elevation, v.elevation);
      setText(refs.elevationGain, v.elevationGain);
      setText(refs.elapsedTime, v.elapsedTime);
      setText(refs.ridingTime, v.ridingTime);
    },
  }));

  return h(
    'div', { className: 'dashboard' },
    controlMode === 'erg' &&
      h('div', { className: 'banner banner-info' }, '現在ERGモードで走行中です(Simulation Mode非対応のためフォールバック)。'),
    h(
      'div', { className: 'dash-grid' },
      tile('パワー', refs.power, 'W'),
      tile('ケイデンス', refs.cadence, 'rpm'),
      tile('仮想速度', refs.virtualSpeed, 'km/h'),
      tile('実測速度(参考)', refs.realSpeed, 'km/h'),
      tile('心拍', refs.heartRate, 'bpm'),
      tile('現在のコース傾斜度(100%基準)', refs.courseGrade, '%'),
      tile(controlMode === 'erg' ? '計算値(目標W)' : '計算値(grade)', refs.controlCalculated, controlMode === 'erg' ? 'W' : '%'),
      tile(controlMode === 'erg' ? '実送信値(目標W)' : '実送信値(grade)', refs.controlActual, controlMode === 'erg' ? 'W' : '%'),
      tile('走行距離', refs.distanceDone, 'km'),
      tile('残距離', refs.distanceRemaining, 'km'),
      tile('現在標高', refs.elevation, 'm'),
      tile('獲得標高', refs.elevationGain, 'm'),
      tile('経過時間(休憩含む)', refs.elapsedTime, ''),
      tile('走行時間(休憩除く)', refs.ridingTime, '')
    )
  );
});

function tile(label, ref, unit) {
  return h(
    'div', { className: 'dash-tile' },
    h('div', { className: 'dash-label' }, label),
    h('div', { className: 'dash-value' }, h('span', { ref }, '--'), unit && h('span', { className: 'dash-unit' }, unit))
  );
}

function setText(ref, value) {
  if (ref.current) ref.current.textContent = value;
}
