// フルスクリーンHUDの canvas 描画(C: コースマップ、F: 標高プロファイル)。
// FullscreenHud から 20Hz に間引いて呼ばれる。DOM の textContent 更新と同じく
// React の再レンダリングを経由しない。
// (あくまで表示用。物理・距離・記録には一切使わない。)

import { buildRouteFrame } from '../three/routeLayout.js';
import { routeAt, ROUTE_LENGTH_M as POND_ROUTE_LENGTH_M } from '../three/pondLayout.js';

// HUD の配色(css/style.css の .fs-hud の変数と同じ値。canvas は CSS 変数を読めないため)
const C = {
  line: 'rgba(147,151,171,0.55)',
  text: '#e9e9ed',
  muted: '#9397ab',
  accent: '#9184d9',
  accentDark: '#5d5294',
  pack: 'rgba(178,182,202,0.8)',
  ridden: 'rgba(89,93,108,0.55)',
  // 勾配の強さの4段(<2% / <5% / <8% / それ以上)
  grade: ['rgba(117,121,140,0.75)', '#5d5294', '#796cbf', '#b5abfc'],
};

// コースマップの1周を何点で近似するか
const MAP_SAMPLES = 480;
// 標高プロファイルの表示範囲(現在地の後ろ/前)と積分の刻み
const PROFILE_BEHIND_M = 400;
const PROFILE_AHEAD_M = 3000;
const PROFILE_STEP_M = 20;

/**
 * コース1周分の平面形状を作る。curve のあるコースは routeLayout(3Dの道路と同じ曲がり方)、
 * 上野不忍池は pondLayout の周回ルート、curve のないコース(熱海)は直線。
 * 座標は画面向き(x 右、y 下。スタート直後の進行方向が上)にそろえる。
 * @returns {{ xs: Float64Array, ys: Float64Array, loopM: number, stepM: number, x0, x1, y0, y1 }}
 */
export function buildCourseMap(courseProfile) {
  const isPond = courseProfile?.scenery === 'ueno';
  const loopM = isPond ? POND_ROUTE_LENGTH_M : Math.max(1, (courseProfile?.loopLengthKm ?? 10) * 1000);
  const stepM = loopM / MAP_SAMPLES;
  const n = MAP_SAMPLES + 1;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  if (isPond) {
    for (let i = 0; i < n; i++) {
      const p = routeAt(i * stepM);
      xs[i] = p.x;
      ys[i] = -p.y; // 地図座標(北が +y)→ 画面座標(下が +y)
    }
  } else {
    // 進行方向が −Z、右が +X(既存シーンの約束)なので、そのまま x→右、z→下 に置けば
    // スタート直後の進行方向が画面の上になる。
    const frame = buildRouteFrame(courseProfile?.curve, loopM, 0, { behindM: 0, aheadM: loopM, stepM });
    for (let i = 0; i < n; i++) {
      const p = frame[Math.min(i, frame.length - 1)];
      xs[i] = p.x;
      ys[i] = p.z;
    }
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]);
    y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]);
  }
  return { xs, ys, loopM, stepM, x0, x1, y0, y1 };
}

/** 通算距離(m)を1周内の位置に畳んで、地図上の座標を線形補間で返す。 */
function mapPointAt(map, distanceM) {
  let m = distanceM % map.loopM;
  if (m < 0) m += map.loopM;
  const f = m / map.stepM;
  const i = Math.min(Math.floor(f), map.xs.length - 2);
  const t = f - i;
  return { x: map.xs[i] + (map.xs[i + 1] - map.xs[i]) * t, y: map.ys[i] + (map.ys[i + 1] - map.ys[i]) * t, index: i };
}

/** canvas のバッファを表示サイズ×DPR に合わせる。 */
function fitCanvas(cv) {
  const d = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return null;
  const bw = Math.round(w * d);
  const bh = Math.round(h * d);
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
  }
  const x = cv.getContext('2d');
  if (!x) return null;
  x.setTransform(d, 0, 0, d, 0, 0);
  x.clearRect(0, 0, w, h);
  return { x, w, h };
}

/**
 * C: コースマップ。1周の形(薄い線)、この周回で走った部分(アクセント色)、
 * ゴースト(輪)・集団(小さい点)・自分(白縁の点)。
 * @param {HTMLCanvasElement} cv
 * @param {ReturnType<typeof buildCourseMap>} map
 * @param {{ distanceM: number, others?: Array }} raw
 */
export function drawCourseMap(cv, map, raw) {
  if (!cv || !map) return;
  const fit = fitCanvas(cv);
  if (!fit) return;
  const { x, w, h } = fit;
  const pad = 16;
  const top = 22; // 見出し「コース」の分だけ上を空ける
  const bw = map.x1 - map.x0;
  const bh = map.y1 - map.y0;
  const s = Math.min((w - pad * 2) / (bw || 1), (h - top - pad) / (bh || 1));
  const ox = (w - bw * s) / 2;
  const oy = top + (h - top - pad - bh * s) / 2;
  const px = (X) => ox + (X - map.x0) * s;
  const py = (Y) => oy + (Y - map.y0) * s;

  const path = (i0, i1, endPt) => {
    x.beginPath();
    x.moveTo(px(map.xs[i0]), py(map.ys[i0]));
    for (let i = i0 + 1; i <= i1; i++) x.lineTo(px(map.xs[i]), py(map.ys[i]));
    if (endPt) x.lineTo(px(endPt.x), py(endPt.y));
    x.stroke();
  };
  x.lineCap = 'round';
  x.lineJoin = 'round';
  x.strokeStyle = C.line;
  x.lineWidth = 2;
  path(0, map.xs.length - 1);

  const dist = Number.isFinite(raw?.distanceM) ? raw.distanceM : 0;
  const me = mapPointAt(map, dist);
  x.strokeStyle = C.accent;
  x.lineWidth = 2.5;
  path(0, me.index, me);

  const dot = (p, fill, stroke, r) => {
    x.beginPath();
    x.arc(px(p.x), py(p.y), r, 0, Math.PI * 2);
    if (fill) { x.fillStyle = fill; x.fill(); }
    if (stroke) { x.strokeStyle = stroke; x.lineWidth = 1.5; x.stroke(); }
  };
  const others = Array.isArray(raw?.others) ? raw.others : [];
  for (const o of others) if (o.kind === 'pack' && Number.isFinite(o.distanceM)) dot(mapPointAt(map, o.distanceM), C.pack, null, 2);
  for (const o of others) if (o.kind === 'ghost' && Number.isFinite(o.distanceM)) dot(mapPointAt(map, o.distanceM), null, o.color || C.accent, 4);
  dot(me, C.text, C.accent, 4.5);
}

/**
 * F: 標高プロファイル。現在地の 400m 後ろ〜3km 先(スタート直後は 0〜3.4km)を、
 * courseEngine.gradeAtKm の積分で描く。走った部分は灰色、先は勾配の強さで4段の色分け。
 * @param {HTMLCanvasElement} cv
 * @param {{ gradeAtKm(km:number):number, effectiveGoalKm?: number }} courseEngine
 * @param {{ distanceM: number, others?: Array }} raw
 */
export function drawElevationProfile(cv, courseEngine, raw) {
  if (!cv || !courseEngine) return;
  const fit = fitCanvas(cv);
  if (!fit) return;
  const { x, w, h } = fit;
  const dist = Number.isFinite(raw?.distanceM) ? Math.max(0, raw.distanceM) : 0;
  const a = Math.max(0, dist - PROFILE_BEHIND_M);
  const b = a + PROFILE_BEHIND_M + PROFILE_AHEAD_M;
  const n = Math.ceil((b - a) / PROFILE_STEP_M);
  const ss = new Float64Array(n + 1);
  const gs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  // 相対標高は courseEngine.elevationDeltaM(勾配の積分)で作る。
  // 色分けに使う勾配は各点の gradeAtKm。
  const hasDelta = typeof courseEngine.elevationDeltaM === 'function';
  for (let i = 0; i <= n; i++) {
    ss[i] = Math.min(b, a + i * PROFILE_STEP_M);
    gs[i] = courseEngine.gradeAtKm(ss[i] / 1000);
    if (i > 0) {
      ys[i] = ys[i - 1] + (hasDelta
        ? courseEngine.elevationDeltaM(ss[i - 1] / 1000, ss[i] / 1000)
        : ((gs[i - 1] + gs[i]) / 200) * (ss[i] - ss[i - 1]));
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= n; i++) { lo = Math.min(lo, ys[i]); hi = Math.max(hi, ys[i]); }
  const span = Math.max(30, hi - lo);
  lo -= span * 0.35;
  hi = lo + span * 1.5;
  const top = 10;
  const bot = h - 14;
  const X = (s) => ((s - a) / (b - a)) * w;
  const Y = (y) => bot - ((y - lo) / (hi - lo)) * (bot - top);
  const yAt = (s) => {
    const f = Math.min(n, Math.max(0, (s - a) / PROFILE_STEP_M));
    const i = Math.min(n - 1, Math.floor(f));
    return ys[i] + (ys[i + 1] - ys[i]) * (f - i);
  };

  for (let i = 0; i < n; i++) {
    const s0 = ss[i], s1 = ss[i + 1];
    const g = (gs[i] + gs[i + 1]) / 2;
    x.fillStyle = s1 <= dist ? C.ridden : g < 2 ? C.grade[0] : g < 5 ? C.grade[1] : g < 8 ? C.grade[2] : C.grade[3];
    x.beginPath();
    x.moveTo(X(s0), bot);
    x.lineTo(X(s0), Y(ys[i]));
    x.lineTo(X(s1) + 0.6, Y(ys[i + 1]));
    x.lineTo(X(s1) + 0.6, bot);
    x.fill();
  }

  // 500m ごとの目盛り(km)
  x.font = '500 10px system-ui, sans-serif';
  x.fillStyle = C.muted;
  x.textBaseline = 'bottom';
  for (let k = Math.ceil(a / 500) * 500; k < b; k += 500) {
    x.fillRect(X(k), bot, 1, 3);
    x.fillText((k / 1000).toFixed(1), X(k) + 2, h);
  }

  // ゴール地点
  const goalM = Number.isFinite(courseEngine.effectiveGoalKm) ? courseEngine.effectiveGoalKm * 1000 : NaN;
  if (goalM > a && goalM < b) {
    const gx = X(goalM);
    x.fillStyle = C.text;
    x.fillRect(gx - 0.5, top, 1, bot - top);
    x.textBaseline = 'top';
    x.fillText('ゴール', Math.min(gx + 3, w - 32), top);
  }

  // ゴーストの位置
  const others = Array.isArray(raw?.others) ? raw.others : [];
  for (const o of others) {
    if (o.kind !== 'ghost' || !Number.isFinite(o.distanceM) || o.distanceM < a || o.distanceM > b) continue;
    x.beginPath();
    x.arc(X(o.distanceM), Y(yAt(o.distanceM)), 3.5, 0, Math.PI * 2);
    x.strokeStyle = o.color || C.accent;
    x.lineWidth = 1.5;
    x.stroke();
  }

  // 自分(縦線+点)
  const mx = X(dist);
  const my = Y(yAt(dist));
  x.fillStyle = C.text;
  x.fillRect(mx - 0.5, top - 4, 1, bot - top + 4);
  x.beginPath();
  x.arc(mx, my, 4.5, 0, Math.PI * 2);
  x.fillStyle = C.accent;
  x.fill();
  x.strokeStyle = C.text;
  x.lineWidth = 1.5;
  x.stroke();
}
