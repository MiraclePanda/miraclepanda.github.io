import { h, useRef, useState, useMemo, useEffect } from './h.js';
import { buildCourseMap, drawCourseMap, drawElevationProfile } from './hudCanvas.js';

const { forwardRef, useImperativeHandle, useLayoutEffect } = React;

// HUD の基準サイズ。これより小さい画面では全体を等倍で縮小する(文字サイズを個別に変えない)。
const BASE_W = 1280;
const BASE_H = 760;
// 間引き: B(ゴースト対戦)は 8Hz、C/F の canvas は 20Hz
const GHOST_INTERVAL_MS = 125;
const CANVAS_INTERVAL_MS = 50;
// B の位置バーの表示範囲(自分の前後 ±m)
const TRACK_RANGE_M = 150;
// B の位置バーに出せる集団の点の数(足りない分は描かない)
const TRACK_PACK_DOTS = 8;
const GHOST_SLOTS = 2;

const ZONE_NAMES = ['回復', '持久走', 'テンポ', '閾値', 'VO2max', '無酸素', 'スプリント'];

// ref で textContent を直接書き換える値(values のキー)
const TEXT_KEYS = [
  'power', 'power3s', 'cadence', 'virtualSpeed', 'heartRate',
  'courseGrade', 'next500Grade', 'loadRatio',
  'distanceDone', 'distanceRemaining', 'ridingTime', 'elevationGain', 'elevation',
];

/**
 * フルスクリーン表示時に3D風景へ重ねるHUD(仕様 §1 の A〜H 区画)。
 *   A 左上: コース名・状態バッジ   B 上中央: ゴースト対戦   C 右上: コースマップ
 *   D 右: パワー・速度・ケイデンス・心拍   E 左下: 勾配   F 下: 標高プロファイル+合計値
 *   G 中央: 通知トースト   H 右下: 操作(children)
 * Dashboardと同じく、高頻度更新はReactの再レンダリングを経由せず、
 * update(values) で ref の textContent / style / canvas を直接書き換える。
 * controlUnit: トレーナー送信値の単位('%' / 'W')。null なら送信していない(デモ)ので '--'。
 * chips: E の上に出す補足(天候など)の文字列配列。低頻度なので React で描く。
 * ftpW: パワーゾーン名に添える FTP(W)。
 */
export const FullscreenHud = forwardRef(function FullscreenHud(
  { paused, communicationWarning, courseProfile, courseEngine, toast = null, demo = false, controlUnit = '%', chips = [], ftpW = null, children },
  ref
) {
  const rootRef = useRef(null);
  const els = useRef({});
  const setEl = (key) => (el) => { els.current[key] = el; };
  const lastGhostAtRef = useRef(-Infinity);
  const lastCanvasAtRef = useRef(-Infinity);
  const lastRawRef = useRef(null);
  const [size, setSize] = useState({ w: BASE_W, h: BASE_H });

  // 表示サイズに合わせて HUD 全体の縮小率を決める(リサイズ時のみ再レンダリング)
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth || window.innerWidth;
      const hh = el.clientHeight || window.innerHeight;
      setSize((s) => (s.w === w && s.h === hh ? s : { w, h: hh }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = Math.min(1, size.w / BASE_W, size.h / BASE_H);

  const courseMap = useMemo(() => buildCourseMap(courseProfile), [courseProfile]);

  useImperativeHandle(ref, () => ({
    update(v) {
      const e = els.current;
      for (const key of TEXT_KEYS) {
        if (e[key] && v[key] !== undefined) e[key].textContent = v[key];
      }
      // デモではトレーナーへ送らないので送信値は出さない
      if (e.controlCalculated) e.controlCalculated.textContent = controlUnit ? (v.controlCalculated ?? '--') : '--';

      // パワーゾーン(7段)。値がまだ無ければ全段を薄く、ゾーン名は '--'
      const zone = Number.isInteger(v.powerZone) && v.powerZone >= 0 && v.powerZone <= 6 ? v.powerZone : null;
      if (e.zoneBars) {
        const bars = e.zoneBars.children;
        for (let i = 0; i < bars.length; i++) {
          bars[i].className = `fs-zone-bar${zone === null ? '' : i === zone ? ' is-current' : i < zone ? ' is-below' : ''}`;
        }
      }
      if (e.zoneName) {
        e.zoneName.textContent = zone === null ? '--' : `Z${zone + 1} ${ZONE_NAMES[zone]}${ftpW ? ` · FTP ${ftpW}W` : ''}`;
      }

      // 勾配の傾き線(見やすいよう実際の角度の 2.5 倍)
      const grade = v.raw && Number.isFinite(v.raw.gradePercent) ? v.raw.gradePercent : 0;
      if (e.gradeLine) e.gradeLine.style.transform = `rotate(${(((-Math.atan(grade / 100) * 180) / Math.PI) * 2.5).toFixed(1)}deg)`;

      if (e.draftChip) e.draftChip.style.display = v.drafting ? '' : 'none';

      const now = performance.now();
      if (now - lastGhostAtRef.current >= GHOST_INTERVAL_MS) {
        lastGhostAtRef.current = now;
        updateGhostPanel(e, v.ghosts, v.raw);
      }
      if (v.raw) lastRawRef.current = v.raw;
      if (now - lastCanvasAtRef.current >= CANVAS_INTERVAL_MS && v.raw) {
        lastCanvasAtRef.current = now;
        drawCanvases(v.raw);
      }
    },
  }), [courseMap, courseEngine, controlUnit, ftpW]);

  function drawCanvases(raw) {
    drawCourseMap(els.current.mapCanvas, courseMap, raw);
    drawElevationProfile(els.current.profileCanvas, courseEngine, raw);
  }

  // リサイズで canvas のバッファが作り直されると消えるため、一時停止中でも最後の値で描き直す
  useEffect(() => {
    if (lastRawRef.current) drawCanvases(lastRawRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const frameStyle = {
    width: `${size.w / scale}px`,
    height: `${size.h / scale}px`,
    transform: `scale(${scale})`,
  };

  return h(
    'div', { className: 'fs-hud', ref: rootRef, 'aria-live': 'off' },
    h('div', { className: 'fs-hud-shade' }),
    h(
      'div', { className: 'fs-hud-frame', style: frameStyle, 'data-scale': scale.toFixed(3) },

      // A: コース名・状態
      h(
        'div', { className: 'fs-hud-a' },
        h('div', { className: 'fs-pill fs-pill-course' }, courseProfile?.name ?? '--'),
        demo && h('div', { className: 'fs-pill' }, h('span', { className: 'fs-pill-dot' }), 'デモ自動走行'),
        paused && h('div', { className: 'fs-hud-badge' }, '一時停止中'),
        communicationWarning && h('div', { className: 'fs-hud-badge fs-hud-warning' }, '⚠ 通信が不安定です')
      ),

      // B: ゴースト対戦(ゴーストがいなければ非表示)
      h(
        'div', { className: 'fs-hud-b fs-panel', ref: setEl('ghostPanel'), style: { display: 'none' } },
        h(
          'div', { className: 'fs-ghost-grid' },
          Array.from({ length: GHOST_SLOTS }, (_, i) =>
            h(
              'div', { key: i, className: 'fs-ghost', ref: setEl(`ghost${i}`) },
              h('div', { className: 'fs-ghost-name' }, h('span', { className: 'fs-ghost-ring', ref: setEl(`ghostRing${i}`) }), h('span', { ref: setEl(`ghostName${i}`) }, '--')),
              h(
                'div', { className: 'fs-ghost-gap fs-num' },
                h('span', { className: 'fs-ghost-sec', ref: setEl(`ghostSec${i}`) }, '--'),
                h('span', { className: 'fs-ghost-sub', ref: setEl(`ghostSub${i}`) }, '')
              )
            )
          )
        ),
        h(
          'div', { className: 'fs-track', ref: setEl('track') },
          h('div', { className: 'fs-track-line' }),
          h('div', { className: 'fs-track-center' }),
          Array.from({ length: TRACK_PACK_DOTS }, (_, i) => h('div', { key: `p${i}`, className: 'fs-track-dot is-pack', 'data-dot': `pack${i}`, style: { display: 'none' } })),
          Array.from({ length: GHOST_SLOTS }, (_, i) => h('div', { key: `g${i}`, className: 'fs-track-dot is-ghost', 'data-dot': `ghost${i}`, style: { display: 'none' } })),
          h('div', { className: 'fs-track-dot is-me' })
        ),
        h('div', { className: 'fs-track-scale fs-num' }, h('span', null, `−${TRACK_RANGE_M}m`), h('span', null, 'あなた'), h('span', null, `+${TRACK_RANGE_M}m`))
      ),

      // C: コースマップ
      h(
        'div', { className: 'fs-hud-c fs-panel' },
        h('canvas', { className: 'fs-map-canvas', ref: setEl('mapCanvas') }),
        h('div', { className: 'fs-hud-label fs-map-title' }, 'コース')
      ),

      // D: 主要値
      h(
        'div', { className: 'fs-hud-d' },
        h(
          'div', { className: 'fs-panel fs-power' },
          h(
            'div', { className: 'fs-row-between' },
            h('span', { className: 'fs-hud-label' }, 'パワー'),
            h('span', { className: 'fs-power3 fs-num' }, '3秒 ', h('span', { ref: setEl('power3s') }, '--'), 'W')
          ),
          h('div', { className: 'fs-power-main' }, h('span', { className: 'fs-power-value fs-num', ref: setEl('power') }, '--'), h('span', { className: 'fs-hud-unit' }, 'W')),
          h('div', { className: 'fs-zone-bars', ref: setEl('zoneBars') }, ZONE_NAMES.map((_, i) => h('div', { key: i, className: 'fs-zone-bar' }))),
          h('div', { className: 'fs-zone-name', ref: setEl('zoneName') }, '--')
        ),
        metricRow('速度', setEl('virtualSpeed'), 'km/h'),
        metricRow('ケイデンス', setEl('cadence'), 'rpm'),
        metricRow('心拍', setEl('heartRate'), 'bpm')
      ),

      // E: 勾配
      h(
        'div', { className: 'fs-hud-e' },
        h(
          'div', { className: 'fs-chips' },
          h('div', { className: 'fs-chip is-accent', ref: setEl('draftChip'), style: { display: 'none' } }, 'ドラフティング中 · 空気抵抗 −34%'),
          chips.map((c) => h('div', { key: c, className: 'fs-chip' }, c))
        ),
        h(
          'div', { className: 'fs-panel fs-grade' },
          h('div', { className: 'fs-hud-label fs-grade-title' }, '勾配'),
          h(
            'div', { className: 'fs-grade-main' },
            h('div', { className: 'fs-grade-icon' }, h('div', { className: 'fs-grade-line', ref: setEl('gradeLine') })),
            h('span', { className: 'fs-grade-value fs-num' }, h('span', { ref: setEl('courseGrade') }, '--'), h('span', { className: 'fs-hud-unit' }, '%'))
          ),
          h(
            'div', { className: 'fs-grade-sub fs-num' },
            h('span', null, '次の500m ', h('b', { ref: setEl('next500Grade') }, '--'), h('b', null, '%')),
            h('span', null, 'トレーナー送信 ', h('b', { ref: setEl('controlCalculated') }, '--'), h('b', null, controlUnit ?? '')),
            h('span', null, '負荷率 ', h('b', { ref: setEl('loadRatio') }, '--'), h('b', null, '%'))
          )
        )
      ),

      // F: 標高プロファイル+合計値
      h(
        'div', { className: 'fs-hud-f fs-panel' },
        h('div', { className: 'fs-profile' }, h('canvas', { className: 'fs-profile-canvas', ref: setEl('profileCanvas') })),
        h(
          'div', { className: 'fs-totals fs-num' },
          totalRow('距離', setEl('distanceDone'), 'km'),
          totalRow('残り', setEl('distanceRemaining'), 'km'),
          totalRow('時間', setEl('ridingTime'), ''),
          totalRow('獲得標高', setEl('elevationGain'), 'm'),
          totalRow('標高', setEl('elevation'), 'm')
        )
      ),

      // G: 通知トースト(イベント時のみ)
      toast &&
        h(
          'div', { className: `fs-hud-g fs-toast${toast.tone ? ` is-${toast.tone}` : ''}`, role: 'status' },
          toast.kicker && h('div', { className: 'fs-toast-kicker' }, toast.kicker),
          h('div', { className: 'fs-toast-title' }, toast.title),
          toast.sub && h('div', { className: 'fs-toast-sub' }, toast.sub)
        ),

      // H: 操作
      h('div', { className: 'fs-hud-h' }, children)
    )
  );
});

function metricRow(label, ref, unit) {
  return h(
    'div', { className: 'fs-panel fs-metric' },
    h('span', { className: 'fs-hud-label' }, label),
    h('span', { className: 'fs-metric-value' }, h('span', { className: 'fs-num', ref }, '--'), h('span', { className: 'fs-hud-unit' }, unit))
  );
}

function totalRow(label, ref, unit) {
  return [
    h('span', { key: `${label}-l`, className: 'fs-hud-label' }, label),
    h('span', { key: `${label}-v`, className: 'fs-total-value' }, h('span', { ref }, '--'), unit && h('span', { className: 'fs-hud-unit' }, unit)),
  ];
}

/** B: ゴースト2枠と前後150mの位置バーを書き換える(8Hz)。ghosts が空なら区画ごと隠す。 */
function updateGhostPanel(e, ghosts, raw) {
  const panel = e.ghostPanel;
  if (!panel) return;
  const list = Array.isArray(ghosts) ? ghosts.slice(0, GHOST_SLOTS) : [];
  if (list.length === 0) {
    if (panel.style.display !== 'none') panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  for (let i = 0; i < GHOST_SLOTS; i++) {
    const g = list[i];
    const slot = e[`ghost${i}`];
    if (!slot) continue;
    slot.style.visibility = g ? '' : 'hidden';
    if (!g) continue;
    const gapS = Math.abs(Number(g.gapS) || 0);
    const gapM = Math.abs(Number(g.gapM) || 0);
    e[`ghostRing${i}`].style.boxShadow = `inset 0 0 0 1.5px ${g.color || '#b5abfc'}`;
    e[`ghostName${i}`].textContent = g.name ?? '--';
    e[`ghostSec${i}`].textContent = `${g.ahead ? '+' : '−'}${gapS.toFixed(1)}s`;
    e[`ghostSec${i}`].classList.toggle('is-behind', !g.ahead);
    e[`ghostSub${i}`].textContent = `${gapM.toFixed(0)}m ${g.ahead ? '前方' : '後方'}${g.finished ? ' · 記録終了' : ''}`;
  }

  const track = e.track;
  if (!track) return;
  const pos = (gapM) => `${50 + (Math.max(-TRACK_RANGE_M, Math.min(TRACK_RANGE_M, gapM)) / TRACK_RANGE_M) * 50}%`;
  for (let i = 0; i < GHOST_SLOTS; i++) {
    const dot = track.querySelector(`[data-dot="ghost${i}"]`);
    const g = list[i];
    if (!dot) continue;
    const gapM = Number(g?.gapM);
    if (!g || !Number.isFinite(gapM) || Math.abs(gapM) > TRACK_RANGE_M) {
      dot.style.display = 'none';
      continue;
    }
    dot.style.display = '';
    dot.style.left = pos(g.ahead ? Math.abs(gapM) : -Math.abs(gapM));
    dot.style.boxShadow = `inset 0 0 0 2px ${g.color || '#b5abfc'}`;
  }
  const myM = raw && Number.isFinite(raw.distanceM) ? raw.distanceM : null;
  const pack = myM === null || !Array.isArray(raw.others)
    ? []
    : raw.others.filter((o) => o.kind === 'pack' && Number.isFinite(o.distanceM) && Math.abs(o.distanceM - myM) <= TRACK_RANGE_M);
  for (let i = 0; i < TRACK_PACK_DOTS; i++) {
    const dot = track.querySelector(`[data-dot="pack${i}"]`);
    if (!dot) continue;
    const o = pack[i];
    if (!o) {
      dot.style.display = 'none';
      continue;
    }
    dot.style.display = '';
    dot.style.left = pos(o.distanceM - myM);
  }
}
