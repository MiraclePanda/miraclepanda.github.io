// 走行中の地図(Canvas 2D、北が上)。今いる場所のまわり(約 3 km 四方)と区間全体を、地図を押して切り替える。
// 景色データ(js/three/sceneryData.js)があれば、国土地理院の標高から陸と海・山の陰影を描き、近くでは建物も描く。
// 無ければ区間データの経緯度だけで道を描く。
//
// 毎フレームの値は React を通さず、RideScreen が apiRef.current.draw(segM) を 2Hz で呼ぶ(走行画面の他の計器と同じ)。

import { h, useEffect, useRef, useState } from './h.js';
import { createRouteSampler, ringBounds, heightAt } from '../three/sceneryData.js';
import { lonLatAt } from '../trip/tripMap.js';

const LOCAL_SPAN_M = 3000;
const PLACE_KINDS = ['town', 'food', 'shop', 'lodging', 'sight'];
const LOCAL_RES = 120; // 周辺の地図の陰影の画素数(一辺)

/** 高さ(m)と陰影(-0.35〜0.35)の色 [r, g, b]。海は水色。 */
function reliefColor(hgt, shade) {
  if (hgt < 0) return [158, 198, 219];
  const t = Math.min(hgt / 900, 1);
  return [232 - 70 * t, 236 - 40 * t, 214 - 60 * t].map((v) => Math.max(0, Math.min(255, v * (1 + shade))));
}

/** 標高の格子から、陸(高さで色分け・北西からの光で陰影)と海の画像を作る。 */
function reliefImage(far) {
  const cv = document.createElement('canvas');
  cv.width = far.nx;
  cv.height = far.ny;
  const g = cv.getContext('2d');
  const img = g.createImageData(far.nx, far.ny);
  const H = (i, j) => far.h[Math.min(Math.max(j, 0), far.ny - 1) * far.nx + Math.min(Math.max(i, 0), far.nx - 1)];
  for (let j = 0; j < far.ny; j++) {
    for (let i = 0; i < far.nx; i++) {
      const hgt = H(i, j);
      const p = ((far.ny - 1 - j) * far.nx + i) * 4; // 画像は上が北
      if (hgt < 0) {
        img.data.set([158, 198, 219, 255], p);
        continue;
      }
      const shade = Math.max(-0.35, Math.min(0.35, ((H(i - 1, j) - H(i + 1, j)) + (H(i, j + 1) - H(i, j - 1))) / (far.cell * 1.2)));
      img.data.set([...reliefColor(hgt, shade), 255], p);
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

/** 区間の地点 m → 地図の平面座標 [x(東), y(北)](m)。 */
function makeLocator(segment, scenery) {
  if (scenery) {
    const at = createRouteSampler(scenery, segment);
    const p = {};
    return (m) => (at(m, p), [p.x, p.y]);
  }
  const o = lonLatAt(segment, 0) ?? [0, 0];
  const kx = 111320 * Math.cos((o[1] * Math.PI) / 180);
  return (m) => {
    const q = lonLatAt(segment, m) ?? o;
    return [(q[0] - o[0]) * kx, (q[1] - o[1]) * 110940];
  };
}

/**
 * @param {{segment:object, scenery:object|null, apiRef:{current:any}}} props
 */
export function RideMap({ segment, scenery, apiRef }) {
  const ref = useRef(null);
  const [whole, setWhole] = useState(false);
  const lastMRef = useRef(0);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return undefined;
    const locate = makeLocator(segment, scenery);
    const step = 50;
    const line = [];
    for (let m = 0; m <= segment.lengthM; m += step) line.push(locate(m));
    line.push(locate(segment.lengthM));
    const bounds = line.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
      [Infinity, Infinity, -Infinity, -Infinity]);
    const places = (segment.places ?? []).filter((p) => PLACE_KINDS.includes(p.kind)).map((p) => ({ ...p, xy: locate(p.atM) }));
    // 区間全体は遠景(100 m)の画像。周辺は描くたびに、道の近くの細かい地形(25 m)も使って陰影を作る
    const relief = scenery ? reliefImage(scenery.far) : null;
    let local = null;
    if (scenery) {
      local = document.createElement('canvas');
      local.width = local.height = LOCAL_RES;
    }
    function drawLocalRelief(g, x0, y1, spanM, X, Y, scale) {
      const lg = local.getContext('2d');
      const img = lg.createImageData(LOCAL_RES, LOCAL_RES);
      const px = spanM / LOCAL_RES;
      for (let j = 0; j < LOCAL_RES; j++) {
        for (let i = 0; i < LOCAL_RES; i++) {
          const x = x0 + (i + 0.5) * px;
          const y = y1 - (j + 0.5) * px;
          const hgt = heightAt(scenery, x, y);
          const shade = Math.max(-0.35, Math.min(0.35,
            (heightAt(scenery, x - px, y) - heightAt(scenery, x + px, y) + heightAt(scenery, x, y + px) - heightAt(scenery, x, y - px)) / (px * 2.4)));
          img.data.set([...reliefColor(hgt, shade), 255], (j * LOCAL_RES + i) * 4);
        }
      }
      lg.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(local, X(x0), Y(y1), spanM * scale, spanM * scale);
    }
    const blds = scenery ? scenery.buildings.map((b) => ({ ring: b.ring, bb: ringBounds(b.ring) })) : [];
    const css = getComputedStyle(cv);
    const accent = css.getPropertyValue('--accent').trim() || '#e07b39';

    function draw(segM) {
      lastMRef.current = segM;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || 220;
      const hh = cv.clientHeight || 220;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const here = locate(segM);
      const ahead = locate(Math.min(segM + 30, segment.lengthM));
      let cx;
      let cy;
      let scale;
      if (whole) {
        cx = (bounds[0] + bounds[2]) / 2;
        cy = (bounds[1] + bounds[3]) / 2;
        scale = Math.min((w - 24) / Math.max(bounds[2] - bounds[0], 1), (hh - 24) / Math.max(bounds[3] - bounds[1], 1));
      } else {
        [cx, cy] = here;
        scale = Math.min(w, hh) / LOCAL_SPAN_M;
      }
      const X = (x) => w / 2 + (x - cx) * scale;
      const Y = (y) => hh / 2 - (y - cy) * scale;
      g.fillStyle = '#e8ecdc';
      g.fillRect(0, 0, w, hh);
      if (local && !whole) {
        const spanM = Math.max(w, hh) / scale;
        drawLocalRelief(g, cx - spanM / 2, cy + spanM / 2, spanM, X, Y, scale);
      } else if (relief) {
        const f = scenery.far;
        g.imageSmoothingEnabled = true;
        g.drawImage(relief, X(f.x0 - f.cell / 2), Y(f.y0 + (f.ny - 0.5) * f.cell), f.nx * f.cell * scale, f.ny * f.cell * scale);
      }
      if (!whole) {
        g.fillStyle = 'rgba(120, 110, 100, 0.75)';
        const half = (Math.max(w, hh) / scale) * 0.75;
        for (const b of blds) {
          if (Math.abs(b.bb.cx - cx) > half || Math.abs(b.bb.cy - cy) > half) continue;
          g.beginPath();
          for (let i = 0; i < b.ring.length; i += 2) g[i ? 'lineTo' : 'moveTo'](X(b.ring[i]), Y(b.ring[i + 1]));
          g.fill();
        }
      }
      const stroke = (pts, color, width) => {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.lineJoin = g.lineCap = 'round';
        g.beginPath();
        pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](X(x), Y(y)));
        g.stroke();
      };
      stroke(line, '#ffffff', whole ? 4 : 7);
      stroke(line, '#6b6258', whole ? 2 : 4);
      const done = Math.min(line.length, Math.floor(segM / step) + 1);
      stroke([...line.slice(0, done), here], accent, whole ? 3 : 5);
      g.font = '11px system-ui, sans-serif';
      for (const p of places) {
        const px = X(p.xy[0]);
        const py = Y(p.xy[1]);
        if (px < -20 || py < -20 || px > w + 20 || py > hh + 20) continue;
        if (whole && p.kind !== 'town') continue;
        g.fillStyle = p.kind === 'town' ? '#2b2620' : p.kind === 'lodging' ? '#b5542c' : '#3a6d8c';
        g.beginPath();
        g.arc(px, py, p.kind === 'town' ? 4 : 3, 0, Math.PI * 2);
        g.fill();
        if (p.kind === 'town' || !whole) {
          g.lineWidth = 3;
          g.strokeStyle = 'rgba(255,255,255,0.85)';
          g.strokeText(p.name, px + 6, py + 4);
          g.fillText(p.name, px + 6, py + 4);
        }
      }
      // 今いる場所: 進む向きの矢印
      const ang = Math.atan2(-(ahead[1] - here[1]), ahead[0] - here[0]);
      g.save();
      g.translate(X(here[0]), Y(here[1]));
      g.rotate(ang);
      g.fillStyle = accent;
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(10, 0);
      g.lineTo(-7, 7);
      g.lineTo(-3, 0);
      g.lineTo(-7, -7);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
      // 縮尺と北
      const barM = whole ? (scale * 10000 < w * 0.6 ? 10000 : 5000) : 1000;
      g.fillStyle = '#2b2620';
      g.fillRect(10, hh - 12, barM * scale, 3);
      g.fillText(`${barM / 1000} km`, 10, hh - 16);
      g.fillText('N↑', w - 26, 16);
    }
    apiRef.current = { draw };
    draw(lastMRef.current);
    return () => { if (apiRef.current?.draw === draw) apiRef.current = null; };
  }, [segment, scenery, whole]);
  return h('canvas', {
    ref, className: 'ride-map', role: 'button', tabIndex: 0,
    'aria-label': whole ? '地図(区間全体)。押すと今いる場所のまわりに切り替え' : '地図(今いる場所のまわり)。押すと区間全体に切り替え',
    title: whole ? '押すと今いる場所のまわり' : '押すと区間全体',
    onClick: () => setWhole((v) => !v),
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') setWhole((v) => !v); },
  });
}
