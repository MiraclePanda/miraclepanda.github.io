// 旅の地図(Canvas 2D): すべての区間を灰色で、走ってきた道を色で、今いる場所・泊まった場所・町を描く。
// 地図タイルは使わない(外部の画像に頼らず、区間データの経緯度だけで描く)。

import { h, useEffect, useRef } from './h.js';
import { buildTripMap, pathBetween, fitProjection } from '../trip/tripMap.js';

/**
 * @param {{trip:object, highlightDay?:number|null}} props highlightDay の日に走った道を強調する
 */
export function TripMap({ trip, highlightDay = null }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 320;
    const hgt = cv.clientHeight || 320;
    cv.width = w * dpr;
    cv.height = hgt * dpr;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const m = buildTripMap(trip);
    const proj = fitProjection(m.roads.flat(), w, hgt, 28);
    const line = (pts, color, width) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      pts.forEach((p, i) => { const [x, y] = proj(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    };
    const css = getComputedStyle(cv);
    const muted = css.getPropertyValue('--muted').trim() || '#8a94a0';
    const accent = css.getPropertyValue('--accent').trim() || '#e07b39';
    const text = css.getPropertyValue('--ink').trim() || '#222';
    const warn = css.getPropertyValue('--warn').trim() || '#b5542c';
    g.setLineDash([4, 5]);
    for (const t of m.transfers) line(t.line, muted, 1.5);
    g.setLineDash([]);
    for (const r of m.roads) line(r, muted, 2);
    for (const r of m.traveled) line(r, accent, 4);
    if (highlightDay !== null) {
      const d = trip.log.find((x) => x.day === highlightDay);
      if (d) for (const r of pathBetween(trip, d.endTotalM - d.distanceM, d.endTotalM)) line(r, warn, 6);
    }
    g.font = '12px system-ui, sans-serif';
    for (const t of m.towns) {
      const [x, y] = proj(t.lonLat);
      g.fillStyle = text;
      g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
      g.fillText(t.name, x + 7, y + 4);
    }
    for (const n of m.nights) {
      const [x, y] = proj(n.lonLat);
      g.fillStyle = warn;
      g.fillRect(x - 3, y - 3, 6, 6);
    }
    if (m.here) {
      const [x, y] = proj(m.here);
      g.fillStyle = accent;
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }, [trip, highlightDay]);
  return h('canvas', { ref, className: 'trip-map', 'aria-label': '旅の地図' });
}
