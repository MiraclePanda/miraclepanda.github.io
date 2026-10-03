import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COURSE_PROFILES, getCourseProfile } from '../../PandaCycleTrainer/js/physics/courseProfiles.js';
import { buildElevationProfile } from '../../PandaCycleTrainer/js/three/roadElevation.js';
import { getLandscape, roadEdgeM } from '../../PandaCycleTrainer/js/three/landscapeLayout.js';
import {
  headingAtM, curvatureAtM, buildRouteFrame, frameAt, toLocal, frameAtInto, toLocalInto, clampInsideOffset,
  LATERAL_SMOOTH_START_M, LATERAL_SMOOTH_RATIO, lateralSigmaM, smoothedHeadingAtM, createAnchoredRoute,
} from '../../PandaCycleTrainer/js/three/routeLayout.js';

const DEG = Math.PI / 180;
const FRAME_OPTS = { behindM: 50, aheadM: 400, stepM: 4 };
// LandscapeScene と同じアンカー座標系の範囲(ROUTE_BEHIND_M = 200 + 2·16、ROUTE_AHEAD_M = 3600 + 2·16、ROUTE_STEP_M = 4)
const ANCHOR_OPTS = { behindM: 232, aheadM: 3632, stepM: 4 };

const curvedProfiles = COURSE_PROFILES.filter((p) => Array.isArray(p.curve) && p.curve.length > 0);
const loopM = (p) => p.loopLengthKm * 1000;

test('curved course profiles exist (flat, hilly, mountain) and atami/ueno stay straight', () => {
  assert.deepEqual(curvedProfiles.map((p) => p.id), ['flat', 'hilly', 'mountain']);
  assert.equal(getCourseProfile('atami').curve, undefined);
  assert.equal(getCourseProfile('ueno').curve, undefined);
});

// §5-1 直線との一致
test('straight course (curve = [] / undefined): toLocal returns exactly {x: d, z: -a, yaw: 0}', () => {
  for (const curve of [[], undefined]) {
    for (const cur of [0, 123.4, 9999.9]) {
      const frame = buildRouteFrame(curve, 10000, cur, FRAME_OPTS);
      for (const a of [-80, -50, -13.7, -0.5, 0, 0.25, 3.9, 77.7, 399.99, 400, 812.3]) {
        for (const d of [-3500, -120, -8, -4.6, 0, 1.3, 20, 120, 3500]) {
          assert.deepEqual(toLocal(frame, a, d), { x: d, z: -a, yaw: 0 }, `curve=${JSON.stringify(curve)} a=${a} d=${d}`);
        }
      }
      // 直線フレーム自体も x = 0, z = −alongM, yaw = 0, k = 0
      for (const p of frame) assert.deepEqual(p, { alongM: p.alongM, x: 0, z: 0 - p.alongM, yaw: 0, k: 0 });
    }
    assert.equal(headingAtM(curve, 10000, 1234), 0);
    assert.equal(curvatureAtM(curve, 10000, 1234), 0);
  }
});

// §5-2 原点の正規化
test('frameAt(frame, 0) is the origin {0, 0, 0} at any current distance', () => {
  for (const p of curvedProfiles) {
    for (let cur = 0; cur < loopM(p) * 2; cur += 777.7) {
      const frame = buildRouteFrame(p.curve, loopM(p), cur, FRAME_OPTS);
      assert.deepEqual(frameAt(frame, 0), { x: 0, z: 0, yaw: 0 }, `${p.id} cur=${cur}`);
      const o = toLocal(frame, 0, 0);
      assert.equal(o.x, 0);
      assert.equal(o.z, 0);
      assert.equal(o.yaw, 0);
    }
  }
});

// §5-3 サンプル間隔(端の切り詰め区間は除く)
test('adjacent samples are stepM apart (except truncated end segments) and match buildElevationProfile', () => {
  const opts = { behindM: 50, aheadM: 103, stepM: 4 }; // どちらの端も stepM で割り切れない
  const p = getCourseProfile('mountain');
  const frame = buildRouteFrame(p.curve, loopM(p), 5432.1, opts);
  const elev = buildElevationProfile(() => 0, 5.4321, opts);
  assert.deepEqual(frame.map((s) => s.alongM), elev.map((s) => s.alongM), 'same alongM ordering as buildElevationProfile');
  assert.equal(frame[0].alongM, -50);
  assert.equal(frame[frame.length - 1].alongM, 103);
  for (let i = 0; i + 1 < frame.length; i++) {
    const a = frame[i];
    const b = frame[i + 1];
    const along = b.alongM - a.alongM;
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    assert.ok(along > 0, 'alongM ascending');
    const isEnd = i === 0 || i + 1 === frame.length - 1;
    if (isEnd) {
      // 切り詰め区間は stepM 以下
      assert.ok(dist <= opts.stepM + 1e-6, `end segment ${i}: ${dist}`);
    } else {
      assert.ok(Math.abs(dist - opts.stepM) <= 1e-6, `segment ${i}: ${dist}`);
    }
  }
});

// §5-4 ループで連続
test('heading is continuous across the loop boundary', () => {
  const eps = 1e-3;
  for (const p of curvedProfiles) {
    const L = loopM(p);
    const diff = Math.abs(headingAtM(p.curve, L, L - eps) - headingAtM(p.curve, L, eps));
    assert.ok(diff < 1e-3, `${p.id}: ${diff}`);
    assert.ok(Math.abs(headingAtM(p.curve, L, L) - headingAtM(p.curve, L, 0)) < 1e-9);
    assert.ok(Math.abs(headingAtM(p.curve, L, 0)) < 1e-12, 'heading starts at 0');
    // 何周走っても同じ地点は同じ方位
    assert.ok(Math.abs(headingAtM(p.curve, L, 1234.5 + 7 * L) - headingAtM(p.curve, L, 1234.5)) < 1e-9);
  }
});

// §5-5 / (d) 決定性
test('deterministic: same arguments give identical results', () => {
  for (const p of curvedProfiles) {
    const L = loopM(p);
    const f1 = buildRouteFrame(p.curve, L, 4321.5, FRAME_OPTS);
    const f2 = buildRouteFrame(p.curve, L, 4321.5, FRAME_OPTS);
    assert.deepEqual(f1, f2);
    assert.deepEqual(toLocal(f1, 123.4, -7.5), toLocal(f2, 123.4, -7.5));
    assert.equal(headingAtM(p.curve, L, 999.9), headingAtM(p.curve, L, 999.9));
    assert.equal(smoothedHeadingAtM(p.curve, L, 999.9, 300), smoothedHeadingAtM(p.curve, L, 999.9, 300));

    const r1 = createAnchoredRoute(p.curve, L, 2500, ANCHOR_OPTS);
    const r2 = createAnchoredRoute(p.curve, L, 2500, ANCHOR_OPTS);
    // 問い合わせ順を変えても(キャッシュの作られ方が違っても)同じ値
    const q = [[2600, 0], [3000, -1500], [2400.3, 64], [5000, 3504.6], [2700, -8]];
    const a1 = q.map(([s, d]) => r1.place(s, d));
    const a2 = [...q].reverse().map(([s, d]) => r2.place(s, d)).reverse();
    assert.deepEqual(a1, a2);
    assert.equal(r1.headingAt(3333), r2.headingAt(3333));
  }
});

// §5-6 曲率の上限
test('max |curvature| <= 1/250 for every course with a curve (0.1 km scan)', () => {
  for (const p of curvedProfiles) {
    const L = loopM(p);
    let maxK = 0;
    for (let m = 0; m <= L; m += 100) maxK = Math.max(maxK, Math.abs(curvatureAtM(p.curve, L, m)));
    assert.ok(maxK <= 1 / 250, `${p.id}: max curvature ${maxK} (R=${1 / maxK}m)`);
    // 解析的な上限 Σ amp·ω も念のため
    const bound = p.curve.reduce((acc, [amp, n]) => acc + amp * DEG * (2 * Math.PI * n) / L, 0);
    assert.ok(maxK <= bound + 1e-12);
  }
});

test('curvature is the derivative of heading', () => {
  for (const p of curvedProfiles) {
    const L = loopM(p);
    for (let m = 0; m < L; m += 1111) {
      const h = 0.01;
      const num = (headingAtM(p.curve, L, m + h) - headingAtM(p.curve, L, m - h)) / (2 * h);
      assert.ok(Math.abs(num - curvatureAtM(p.curve, L, m)) < 1e-7, `${p.id} m=${m}`);
    }
  }
});

// §5-7 符号
test('positive amplitude with increasing heading turns left: forward samples have x < 0', () => {
  // 単一成分: heading = amp·sin(2πm/L) は 0 < m < L/2 で正 → 前方は左(−X)へ曲がる
  const L = 10000;
  const curve = [[10, 1, 0]];
  const frame = buildRouteFrame(curve, L, 0, { behindM: 0, aheadM: 4000, stepM: 4 });
  for (const s of frame) {
    if (s.alongM <= 0) continue;
    assert.ok(s.x < 0, `alongM=${s.alongM} x=${s.x}`);
    assert.ok(s.yaw > 0);
    assert.ok(toLocal(frame, s.alongM, 0).x < 0);
  }
  // 実コースでも、曲率が正(heading が増える)地点では近い前方が左へ寄る
  for (const p of curvedProfiles) {
    const L2 = loopM(p);
    let checked = 0;
    for (let cur = 0; cur < L2; cur += 250) {
      if (curvatureAtM(p.curve, L2, cur) <= 1e-4) continue;
      const f = buildRouteFrame(p.curve, L2, cur, { behindM: 0, aheadM: 40, stepM: 4 });
      for (const s of f) if (s.alongM > 0 && s.yaw > 0) assert.ok(s.x < 0, `${p.id} cur=${cur} alongM=${s.alongM}`);
      checked++;
    }
    assert.ok(checked > 0);
  }
});

// §5-8 内側クランプ
test('clampInsideOffset clamps only on the inside of the curve', () => {
  assert.equal(clampInsideOffset(1 / 100, -120), -80);
  assert.equal(clampInsideOffset(1 / 100, 120), 120);
  assert.equal(clampInsideOffset(-1 / 100, 120), 80);
  assert.equal(clampInsideOffset(-1 / 100, -120), -120);
  assert.equal(clampInsideOffset(1 / 100, -50), -50);
  assert.equal(clampInsideOffset(0, -120), -120);
});

// (a) 平滑化した方位
test('smoothedHeadingAtM: sigma=0 equals headingAtM; larger sigma damps oscillation toward the mean heading', () => {
  assert.equal(LATERAL_SMOOTH_START_M, 20);
  assert.equal(LATERAL_SMOOTH_RATIO, 0.5);
  assert.equal(lateralSigmaM(0), 0);
  assert.equal(lateralSigmaM(-20), 0);
  assert.equal(lateralSigmaM(120), 50);
  assert.equal(lateralSigmaM(-3504.6), 0.5 * (3504.6 - 20));

  for (const p of curvedProfiles) {
    const L = loopM(p);
    for (let m = 0; m <= L; m += 50) {
      assert.equal(smoothedHeadingAtM(p.curve, L, m, 0), headingAtM(p.curve, L, m), `${p.id} m=${m}`);
    }
    // 平均の向き(定数項)は平滑化しても残る
    const mean = -p.curve.reduce((acc, [amp, , ph]) => acc + amp * DEG * Math.sin(ph), 0);
    const rms = (sigma) => {
      let sum = 0;
      let n = 0;
      for (let m = 0; m < L; m += 25) {
        const e = smoothedHeadingAtM(p.curve, L, m, sigma) - mean;
        sum += e * e;
        n++;
      }
      return Math.sqrt(sum / n);
    };
    let prev = Infinity;
    for (const sigma of [0, 20, 100, 300, 1000, 3000]) {
      const r = rms(sigma);
      assert.ok(r < prev, `${p.id}: rms deviation must shrink as sigma grows (sigma=${sigma}: ${r} >= ${prev})`);
      prev = r;
    }
    for (let m = 0; m < L; m += 500) {
      assert.ok(Math.abs(smoothedHeadingAtM(p.curve, L, m, 1e5) - mean) < 1e-9, `${p.id} m=${m}`);
    }
  }
});

/** 剛体変換(Y 軸回りに θ 回転 → T だけ平行移動)。Three.js の rotation.y と同じ向き。 */
const rigid = (p, theta, T) => ({
  x: T.x + p.x * Math.cos(theta) + p.z * Math.sin(theta),
  z: T.z - p.x * Math.sin(theta) + p.z * Math.cos(theta),
  yaw: p.yaw + theta,
});

// (b) アンカー座標系と相対フレームの整合
test('createAnchoredRoute (sigma=0) matches buildRouteFrame/toLocal up to a rigid transform', () => {
  for (const p of curvedProfiles) {
    const L = loopM(p);
    for (const anchorS of [0, 3001, L - 700]) {
      const route = createAnchoredRoute(p.curve, L, anchorS, ANCHOR_OPTS);
      assert.equal(route.anchorS, anchorS);
      const o = route.place(anchorS, 0);
      assert.ok(Math.abs(o.x) < 1e-12 && Math.abs(o.z) < 1e-12 && Math.abs(o.yaw) < 1e-12, 'anchor is the origin');
      // アンカーの格子(4m)から半端にずれた現在位置で相対フレームを作る
      for (const off of [-150.5, 10, 1234.7]) {
        const cur = anchorS + off;
        const frame = buildRouteFrame(p.curve, L, cur, ANCHOR_OPTS);
        const theta = route.headingAt(cur);
        assert.ok(Math.abs(theta - (headingAtM(p.curve, L, cur) - headingAtM(p.curve, L, anchorS))) < 1e-12);
        // 平行移動は最小二乗(残差の平均)で求める。place(cur, 0) 自体も 4m 間隔の線形補間で
        // 弦誤差(最大 step²/8R ≈ 8mm)を含むため、それを T に持ち込まないようにする。
        const pairs = [];
        for (let rel = -100; rel <= 2000; rel += 7.3) {
          const s = cur + rel;
          if (s - anchorS < -ANCHOR_OPTS.behindM || s - anchorS > ANCHOR_OPTS.aheadM) continue;
          for (const d of [-20, -4.6, 0, 3.5, 20]) {
            pairs.push([route.place(s, d), rigid(toLocal(frame, rel, d), theta, { x: 0, z: 0 })]);
          }
        }
        const T = { x: 0, z: 0 };
        for (const [got, rot] of pairs) {
          T.x += (got.x - rot.x) / pairs.length;
          T.z += (got.z - rot.z) / pairs.length;
        }
        const T0 = route.place(cur, 0);
        assert.ok(Math.hypot(T.x - T0.x, T.z - T0.z) < 2e-2, 'translation is where the current position lies');
        let maxPos = 0;
        let maxYaw = 0;
        for (const [got, rot] of pairs) {
          maxPos = Math.max(maxPos, Math.hypot(got.x - rot.x - T.x, got.z - rot.z - T.z));
          maxYaw = Math.max(maxYaw, Math.abs(got.yaw - rot.yaw));
        }
        assert.ok(maxPos < 1e-2, `${p.id} anchor=${anchorS} cur=${cur}: position diff ${maxPos}`);
        assert.ok(maxYaw < 1e-3, `${p.id} anchor=${anchorS} cur=${cur}: yaw diff ${maxYaw}`);
      }
    }
  }
});

test('createAnchoredRoute with an empty curve is exactly the straight layout', () => {
  for (const curve of [[], undefined]) {
    for (const anchorS of [0, 1600, 12345.6]) {
      const route = createAnchoredRoute(curve, 10000, anchorS, ANCHOR_OPTS);
      for (const s of [anchorS - 500, anchorS - 3.3, anchorS, anchorS + 17.25, anchorS + 3600, anchorS + 5000]) {
        for (const d of [-3504.6, -120, -4.1, 0, 4.6, 64, 3504.6]) {
          assert.deepEqual(route.place(s, d), { x: d, z: -(s - anchorS), yaw: 0 });
        }
        assert.equal(route.headingAt(s), 0);
      }
    }
  }
});

// (c) LandscapeScene と同じ格子で折り重なり(裏返り・潰れ)がないこと
// 行・列は js/ui/LandscapeScene.js の terrainRows / terrainColumns と同じ作り方にしてある
// (LandscapeScene は Three.js を import するので Node から直接は呼べない。定数を変えたらここも合わせる)。
const NEAR_BEHIND_M = 40;
const NEAR_AHEAD_M = 330;
const REBUILD_M = 16;
const ROW_STEP_NEAR_M = 4;
const ROW_STEP_MID_M = 20;
const MID_AHEAD_M = 1000;
const ROW_STEP_FAR_M = 100;
const FAR_AHEAD_M = 3600;
const FAR_BEHIND_M = 200;
const OUTER_COLUMNS_M = [0.4, 1, 2, 3.5, 5.5, 8, 11, 15, 20, 27, 36, 48, 64, 85, 110, 145, 190, 250, 330, 430, 560, 720, 920, 1170, 1480, 1850, 2300, 2850, 3500];
const HILL_MAX_COLUMN_M = 2300;
// コース → 景観(courseProfiles.js の scenery)
const LANDSCAPE_OF = { hilly: 'lakeside', mountain: 'mountain' };

/** terrainRows と同じ行(絶対距離)。anchorS は 4m の倍数(rebuildWorld と同じ丸め)。 */
function terrainRows(anchorS) {
  const rows = [];
  const nearStart = anchorS - NEAR_BEHIND_M;
  const nearEnd = anchorS + NEAR_AHEAD_M + REBUILD_M;
  for (let s = Math.ceil((anchorS - FAR_BEHIND_M) / ROW_STEP_MID_M) * ROW_STEP_MID_M; s < nearStart; s += ROW_STEP_MID_M) rows.push(s);
  for (let s = Math.ceil(nearStart / ROW_STEP_NEAR_M) * ROW_STEP_NEAR_M; s <= nearEnd; s += ROW_STEP_NEAR_M) rows.push(s);
  const midEnd = anchorS + MID_AHEAD_M;
  for (let s = Math.floor(nearEnd / ROW_STEP_MID_M) * ROW_STEP_MID_M + ROW_STEP_MID_M; s <= midEnd; s += ROW_STEP_MID_M) rows.push(s);
  for (let s = Math.floor(midEnd / ROW_STEP_FAR_M) * ROW_STEP_FAR_M + ROW_STEP_FAR_M; s <= anchorS + FAR_AHEAD_M; s += ROW_STEP_FAR_M) rows.push(s);
  return rows;
}

/** terrainColumns と同じ列(谷/湖側 = 左は外縁 +3500m まで、山側 = 右は外縁 +2300m まで)。 */
function terrainColumns(L) {
  const edge = roadEdgeM(L);
  const valley = OUTER_COLUMNS_M.map((u) => -(edge + u)).reverse();
  const hill = OUTER_COLUMNS_M.filter((u) => u <= HILL_MAX_COLUMN_M).map((u) => edge + u);
  return [...valley, -edge, -(L.roadHalfWidthM + 0.6), L.roadHalfWidthM + 0.6, edge, ...hill];
}

/** 四角形 p0→p1→p2→p3 の符号付き面積(x-z 平面、shoelace)。 */
const quadArea = (p0, p1, p2, p3) =>
  0.5 * ((p0.x * p1.z - p1.x * p0.z) + (p1.x * p2.z - p2.x * p1.z) + (p2.x * p3.z - p3.x * p2.z) + (p3.x * p0.z - p0.x * p3.z));

test('terrain grid matches LandscapeScene: lakeside edge 4.6 m, mountain edge 4.1 m, valley to +3500 m, hill to +2300 m', () => {
  const lake = terrainColumns(getLandscape('lakeside'));
  const mtn = terrainColumns(getLandscape('mountain'));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(roadEdgeM(getLandscape('lakeside')), 4.6));
  assert.ok(near(roadEdgeM(getLandscape('mountain')), 4.1));
  for (const cols of [lake, mtn]) {
    for (let j = 0; j + 1 < cols.length; j++) assert.ok(cols[j] < cols[j + 1], 'columns ascending, no duplicates');
  }
  assert.ok(near(lake[0], -(4.6 + 3500)));
  assert.ok(near(lake[lake.length - 1], 4.6 + 2300));
  assert.ok(near(mtn[0], -(4.1 + 3500)));
  assert.ok(near(mtn[mtn.length - 1], 4.1 + 2300));
  // 行は昇順で、アンカー位置(4m 刻みの近景帯)を含み、後方 200m・前方 3600m まで
  const rows = terrainRows(4000);
  for (let i = 0; i + 1 < rows.length; i++) assert.ok(rows[i] < rows[i + 1]);
  assert.ok(rows.includes(4000));
  assert.equal(rows[0], 3800);
  assert.equal(rows[rows.length - 1], 7600);
  // 行・列とも組み直しの座標系の範囲(ANCHOR_OPTS)に収まる
  assert.ok(rows[0] - 4000 >= -ANCHOR_OPTS.behindM + 2 * REBUILD_M - 1e-9);
  assert.ok(rows[rows.length - 1] - 4000 <= ANCHOR_OPTS.aheadM - 2 * REBUILD_M + 1e-9);
});

test('landscape grid cells never flip or collapse on hilly/mountain (whole loop, anchors every 248 m)', () => {
  const ANCHOR_STEP_M = 248; // 4m の倍数(LandscapeScene のアンカーは 4m に丸められる)
  for (const id of ['hilly', 'mountain']) {
    const p = getCourseProfile(id);
    const L = loopM(p);
    const cols = terrainColumns(getLandscape(LANDSCAPE_OF[id]));
    let cells = 0;
    let minRatio = Infinity;
    for (let anchorS = 0; anchorS < L; anchorS += ANCHOR_STEP_M) {
      const route = createAnchoredRoute(p.curve, L, anchorS, ANCHOR_OPTS);
      const rows = terrainRows(anchorS);
      const pts = rows.map((s) => cols.map((d) => route.place(s, d)));
      for (let i = 0; i + 1 < rows.length; i++) {
        for (let j = 0; j + 1 < cols.length; j++) {
          const curved = quadArea(pts[i][j], pts[i][j + 1], pts[i + 1][j + 1], pts[i + 1][j]);
          // 直線時(x = d, z = −(s − anchorS))の同じセルを同じ頂点順で測る(この順だと負の面積)。
          const sp = (r, c) => ({ x: cols[c], z: -(rows[r] - anchorS) });
          const straight = quadArea(sp(i, j), sp(i, j + 1), sp(i + 1, j + 1), sp(i + 1, j));
          const ratio = curved / straight;
          if (!(ratio >= 0.05)) {
            assert.fail(`${id} anchor=${anchorS} s=${rows[i]}..${rows[i + 1]} d=${cols[j]}..${cols[j + 1]}: area ratio ${ratio}`);
          }
          if (ratio < minRatio) minRatio = ratio;
          cells++;
        }
      }
    }
    assert.ok(cells > 0 && minRatio >= 0.05, `${id}: ${cells} cells, min ratio ${minRatio}`);
  }
});

// (e) 16m ごとの組み直しで景色が跳ばないこと(σ > 0 の遠景を含む)
test('re-anchoring (A -> A+16, A+4) is continuous after the rigid transform, including far columns (sigma > 0)', () => {
  const D_BASE = [0, 10, 30, 330, 1000, 3504.6];
  for (const id of ['hilly', 'mountain']) {
    const p = getCourseProfile(id);
    const L = loopM(p);
    // 景観の実際の列も混ぜる(σ の値がばらばら)。左右両側。
    const cols = terrainColumns(getLandscape(LANDSCAPE_OF[id]));
    const ds = [...new Set([...D_BASE, ...D_BASE.map((d) => -d), ...cols.filter((_, j) => j % 3 === 0)])];
    assert.ok(ds.some((d) => lateralSigmaM(d) > 1000), 'covers large sigma');
    // アンカーは間引く(4m の倍数)。ループ境界をまたぐ組み直しも含める。
    const anchors = [];
    for (let A = 0; A < L; A += 1004) anchors.push(A);
    anchors.push(L - 8, 2 * L + 400);
    let maxPos = 0;
    let maxYaw = 0;
    let worst = '';
    let compared = 0;
    for (const A of anchors) {
      const rA = createAnchoredRoute(p.curve, L, A, ANCHOR_OPTS);
      for (const dA of [16, 4]) {
        const B = A + dA;
        const rB = createAnchoredRoute(p.curve, L, B, ANCHOR_OPTS);
        // B の座標系 → A の座標系: B のアンカー(道路中心)が A の座標で place(B, 0) にあり、
        // 向きが headingAt(B) だけ回っている(σ = 0 の道路中心線で決まる剛体変換)。
        const T = rA.place(B, 0);
        const theta = rA.headingAt(B);
        // 両アンカーの範囲が重なる s
        for (let s = B - ANCHOR_OPTS.behindM; s <= A + ANCHOR_OPTS.aheadM; s += 13.7) {
          for (const d of ds) {
            const got = rigid(rB.place(s, d), theta, T);
            const want = rA.place(s, d);
            const e = Math.hypot(got.x - want.x, got.z - want.z);
            const ey = Math.abs(got.yaw - want.yaw);
            if (e > maxPos) {
              maxPos = e;
              worst = `A=${A} B=${B} s=${s.toFixed(1)} d=${d}`;
            }
            if (ey > maxYaw) maxYaw = ey;
            compared++;
          }
        }
      }
    }
    assert.ok(compared > 1000);
    assert.ok(maxPos < 0.05, `${id}: max position jump ${maxPos} m at ${worst}`);
    assert.ok(maxYaw < 1e-3, `${id}: max yaw jump ${maxYaw} rad`);
  }
});

// (f) 出力先指定版・配列の使い回し
test('frameAtInto/toLocalInto give the same values as frameAt/toLocal (reused out object)', () => {
  const out = { x: NaN, z: NaN, yaw: NaN };
  const cases = [
    ...curvedProfiles.map((p) => [p.curve, loopM(p), 4321.5]),
    [[], 10000, 123.4],
    [undefined, 10000, 0],
  ];
  for (const [curve, L, cur] of cases) {
    const frame = buildRouteFrame(curve, L, cur, FRAME_OPTS);
    // 範囲外(外挿)・サンプル上・サンプル間・端点を含む
    for (const a of [-120, -50, -49.9, -13.7, 0, 0.25, 4, 77.7, 399.99, 400, 812.3]) {
      assert.equal(frameAtInto(frame, a, out), out, 'returns out');
      assert.deepEqual({ ...out }, frameAt(frame, a), `frameAt ${JSON.stringify(curve)} a=${a}`);
      for (const d of [-3504.6, -120, -4.6, 0, 3.5, 64, 2304.1]) {
        assert.equal(toLocalInto(frame, a, d, out), out, 'returns out');
        assert.deepEqual({ ...out }, toLocal(frame, a, d), `toLocal ${JSON.stringify(curve)} a=${a} d=${d}`);
      }
    }
  }
});

test('buildRouteFrame(..., out) reuses the array and objects and gives the same result as a fresh frame', () => {
  const hilly = getCourseProfile('hilly');
  const mtn = getCourseProfile('mountain');
  const out = [];
  // 長さが増える・減る・直線と曲線が入れ替わる順に使い回す
  const seq = [
    [mtn.curve, loopM(mtn), 5432.1, { behindM: 50, aheadM: 103, stepM: 4 }],
    [hilly.curve, loopM(hilly), 1234.5, FRAME_OPTS],
    [[], 10000, 77, FRAME_OPTS],
    [mtn.curve, loopM(mtn), 19990, { behindM: 30, aheadM: 61, stepM: 4 }],
    [undefined, 10000, 5, { behindM: 10, aheadM: 20, stepM: 4 }],
    [hilly.curve, loopM(hilly), 14000.3, FRAME_OPTS],
  ];
  let prevFirst = null;
  for (const [curve, L, cur, opts] of seq) {
    const fresh = buildRouteFrame(curve, L, cur, opts);
    const reused = buildRouteFrame(curve, L, cur, opts, out);
    assert.equal(reused, out, 'returns the same array');
    assert.equal(reused.length, fresh.length);
    assert.deepEqual(reused, fresh, `${JSON.stringify(curve)?.slice(0, 20)} cur=${cur}`);
    assert.equal(reused.straight, fresh.straight, 'straight flag follows the latest curve');
    if (prevFirst) assert.equal(reused[0], prevFirst, 'sample objects are reused');
    prevFirst = reused[0];
    for (const a of [-60, -3.3, 0, 17.25, 99, 500]) {
      for (const d of [-120, 0, 4.6]) assert.deepEqual(toLocal(reused, a, d), toLocal(fresh, a, d));
    }
  }
});
