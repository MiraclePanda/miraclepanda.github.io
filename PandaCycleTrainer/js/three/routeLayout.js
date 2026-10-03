// 3Dシーンの道路の平面上のカーブ(方位の揺らぎ)を、コースプロファイルの curve から求める。
// roadElevation.js と対になるモジュールで、同じくThree.js非依存の純粋関数にしてある
// (Node上でユニットテストするため)。
//
// curve は [振幅(度), 1周あたりの周期数(整数), 位相(rad)] の配列で、累積方位は
//   heading(m) = Σ amp·(sin(2π·n·m/L + φ) − sin φ)
// と定義する。n が整数なのでループ境界(m = L → 0)で方位が連続する。curve が空/未定義の
// コースは従来どおりの直線で、各関数は直線のときの値を厳密に返す(見た目を一切変えないため)。
//
// 座標の約束(既存シーンと同じ): 進行方向が −Z、道路中心からの右方向が +X。
//   yaw(rel) = heading(cur + rel) − heading(cur)(正 = 左へ曲がる、上から見て反時計回り)
//   前方 f = (−sin yaw, 0, −cos yaw)、右 r = (cos yaw, 0, −sin yaw)
// yaw = 0 で f = (0,0,−1)、r = (+1,0,0)。Three.js の rotation.y = yaw で −Z を向く
// オブジェクトが f を向く。
// (あくまで見た目の配置用。物理・勾配・距離・記録には一切使わない。)

const DEG = Math.PI / 180;

// カーブ内側の折り重なり対策で、横オフセットを曲率半径の何割までに抑えるか。
const INSIDE_CLAMP_RATIO = 0.8;

/**
 * 横に広い地形(LandscapeScene)向けの経路の平滑化。道路中心から |d| が
 * LATERAL_SMOOTH_START_M を超えた分に LATERAL_SMOOTH_RATIO を掛けた値を
 * ガウス平滑の σ(m) とし、遠い列ほど緩やかな経路(createAnchoredRoute では
 * 中心線の位置を平滑化した曲線)に沿わせてカーブ内側での裏返り・潰れを防ぐ。
 */
export const LATERAL_SMOOTH_START_M = 20;
export const LATERAL_SMOOTH_RATIO = 0.5;

function isStraight(curve) {
  return !Array.isArray(curve) || curve.length === 0;
}

/** curve を計算しやすい形(amp: rad, ω: rad/m, φ, sin φ)に直す。 */
function toTerms(curve, loopLengthM) {
  if (isStraight(curve)) return [];
  return curve.map(([ampDeg, cycles, phase]) => ({
    amp: ampDeg * DEG,
    omega: (2 * Math.PI * cycles) / loopLengthM,
    phase,
    sinPhase: Math.sin(phase),
  }));
}

/** ループ内の位置(0 ≤ m < L)へ畳む。走行距離が大きくなっても三角関数の精度を保つため。 */
function wrapM(loopLengthM, distanceM) {
  if (!(loopLengthM > 0)) return distanceM;
  const m = distanceM % loopLengthM;
  return m < 0 ? m + loopLengthM : m;
}

/** 平滑化済み方位を terms から求める。sigmaM = 0 では headingAtM と同じ演算になる。 */
function headingFromTerms(terms, loopLengthM, distanceM, sigmaM) {
  if (terms.length === 0) return 0;
  const m = wrapM(loopLengthM, distanceM);
  let h = 0;
  for (const t of terms) {
    const s = Math.sin(t.omega * m + t.phase);
    // ガウス平滑は振動成分だけを減衰させ、平均の向き(−amp·sin φ)は保つ。
    const osc = sigmaM > 0 ? Math.exp(-0.5 * t.omega * t.omega * sigmaM * sigmaM) * s : s;
    h += t.amp * (osc - t.sinPhase);
  }
  return h;
}

/** 累積方位(rad)。正 = 左へ曲がる向き(上から見て反時計回り)。curve が空なら 0。 */
export function headingAtM(curve, loopLengthM, distanceM) {
  return headingFromTerms(toTerms(curve, loopLengthM), loopLengthM, distanceM, 0);
}

/** 曲率(1/m) = 方位の距離微分。正 = 左カーブ。curve が空なら 0。 */
export function curvatureAtM(curve, loopLengthM, distanceM) {
  const terms = toTerms(curve, loopLengthM);
  if (terms.length === 0) return 0;
  const m = wrapM(loopLengthM, distanceM);
  let k = 0;
  for (const t of terms) k += t.amp * t.omega * Math.cos(t.omega * m + t.phase);
  return k;
}

/**
 * 方位にガウス平滑(標準偏差 sigmaM [m])をかけたもの。各周期成分の振動を
 * exp(−ω²σ²/2)(ω = 2πn/L)倍に減衰させる。sigmaM = 0 で headingAtM と厳密に一致する。
 */
export function smoothedHeadingAtM(curve, loopLengthM, distanceM, sigmaM) {
  return headingFromTerms(toTerms(curve, loopLengthM), loopLengthM, distanceM, sigmaM);
}

/** 横距離 d(m)に対する平滑化の σ(m)。|d| ≤ LATERAL_SMOOTH_START_M では 0(道路と同じ経路)。 */
export function lateralSigmaM(d) {
  return LATERAL_SMOOTH_RATIO * Math.max(0, Math.abs(d) - LATERAL_SMOOTH_START_M);
}

/**
 * buildElevationProfile と同じ並びの相対位置(alongM)を返す。
 * 後方は −behindM まで stepM 刻み(端は切り詰め)、0、前方は aheadM まで同様。
 * 浮動小数の足し方まで roadElevation.js に揃え、同じインデックスが同じ alongM を指すようにする。
 */
function sampleAlongs(behindM, aheadM, stepM) {
  const forward = [0];
  let alongM = 0;
  while (alongM < aheadM) {
    alongM = Math.min(alongM + stepM, aheadM);
    forward.push(alongM);
  }
  const backward = [];
  alongM = 0;
  while (alongM > -behindM) {
    alongM = Math.max(alongM - stepM, -behindM);
    backward.push(alongM);
  }
  backward.reverse();
  return { alongs: [...backward, ...forward], originIndex: backward.length };
}

/**
 * 方位関数 yawAt(rel) を原点(rel = 0)から区間中点の yaw で積分し、各サンプルの位置を返す。
 * p[i+1] = p[i] + f(yaw_mid)·len(後方は逆向きに同じ式)。
 */
function integrate(alongs, originIndex, yawAt) {
  const n = alongs.length;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = originIndex + 1; i < n; i++) {
    const a = alongs[i - 1];
    const b = alongs[i];
    const yawMid = yawAt((a + b) / 2);
    const len = b - a;
    xs[i] = xs[i - 1] - Math.sin(yawMid) * len;
    zs[i] = zs[i - 1] - Math.cos(yawMid) * len;
  }
  for (let i = originIndex - 1; i >= 0; i--) {
    const a = alongs[i + 1];
    const b = alongs[i];
    const yawMid = yawAt((a + b) / 2);
    const len = a - b; // 後方へ進む区間の長さ(正の値)
    xs[i] = xs[i + 1] + Math.sin(yawMid) * len;
    zs[i] = zs[i + 1] + Math.cos(yawMid) * len;
  }
  return { xs, zs };
}

/** 昇順の alongs から alongs[i] ≤ a < alongs[i+1] となる i を二分探索する(0 ≤ i ≤ n−2)。 */
function findSegment(alongs, a) {
  let lo = 0;
  let hi = alongs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (alongs[mid] <= a) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** frame[i] を再利用(なければ作成)して値を書き込む。 */
function setSample(frame, i, alongM, x, z, yaw, k) {
  const p = frame[i];
  if (p) {
    p.alongM = alongM;
    p.x = x;
    p.z = z;
    p.yaw = yaw;
    p.k = k;
  } else {
    frame[i] = { alongM, x, z, yaw, k };
  }
}

/**
 * 現在位置を原点とする相対フレームを作る。
 * alongM = 0 で x = 0, z = 0, yaw = 0。進行方向は −Z(既存シーンの約束と同じ)。
 * サンプル間隔・範囲は buildElevationProfile と同じ opts を渡すので、
 * 同じインデックスのサンプルが同じ alongM を指す。
 * curve が空のときは直線フレーム(x = 0, z = −alongM, yaw = 0)になり、
 * toLocal/frameAt は補間誤差のない厳密な直線の値を返す。
 * 毎フレーム呼ぶ CityScene 向けに、前回の戻り値を out に渡すと配列と要素のオブジェクトを
 * 使い回す(値は新規に作った場合と同一)。
 * @returns {Array<{alongM, x, z, yaw, k}>} alongM 昇順。k はそのサンプルの曲率
 */
export function buildRouteFrame(curve, loopLengthM, currentDistanceM, { behindM, aheadM, stepM }, out) {
  const terms = toTerms(curve, loopLengthM);
  const straight = terms.length === 0;
  const nT = terms.length;
  const frame = Array.isArray(out) ? out : [];

  // sampleAlongs と同じ並び・同じ浮動小数の足し方で、配列を作らずに frame へ直接書き込む。
  let nBack = 0;
  for (let a = 0; a > -behindM; nBack++) a = Math.max(a - stepM, -behindM);
  let nFwd = 0;
  for (let a = 0; a < aheadM; nFwd++) a = Math.min(a + stepM, aheadM);
  const n = nBack + 1 + nFwd;
  const originIndex = nBack;
  frame.length = Math.min(frame.length, n);

  const h0 = headingFromTerms(terms, loopLengthM, currentDistanceM, 0);
  const yawAt = (rel) => headingFromTerms(terms, loopLengthM, currentDistanceM + rel, 0) - h0;

  // 各サンプルの alongM と、向き・曲率(どちらも terms から、sin/cos を1回ずつ)。
  // 向きは headingAtM、曲率は curvatureAtM と同じ演算順にしてある。
  const fill = (i, alongM) => {
    if (straight) {
      setSample(frame, i, alongM, 0, 0 - alongM, 0, 0);
      return;
    }
    const m = wrapM(loopLengthM, currentDistanceM + alongM);
    let hh = 0;
    let k = 0;
    for (let j = 0; j < nT; j++) {
      const t = terms[j];
      const arg = t.omega * m + t.phase;
      hh += t.amp * (Math.sin(arg) - t.sinPhase);
      k += t.amp * t.omega * Math.cos(arg);
    }
    setSample(frame, i, alongM, 0, 0, i === originIndex ? 0 : hh - h0, k);
  };
  fill(originIndex, 0);
  let alongM = 0;
  for (let i = originIndex + 1; i < n; i++) {
    alongM = Math.min(alongM + stepM, aheadM);
    fill(i, alongM);
  }
  alongM = 0;
  for (let i = originIndex - 1; i >= 0; i--) {
    alongM = Math.max(alongM - stepM, -behindM);
    fill(i, alongM);
  }

  if (!straight) {
    // integrate() と同じ式(区間中点の向きで前方/後方へ積み上げる)。
    for (let i = originIndex + 1; i < n; i++) {
      const a = frame[i - 1];
      const b = frame[i];
      const yawMid = yawAt((a.alongM + b.alongM) / 2);
      const len = b.alongM - a.alongM;
      b.x = a.x - Math.sin(yawMid) * len;
      b.z = a.z - Math.cos(yawMid) * len;
    }
    for (let i = originIndex - 1; i >= 0; i--) {
      const a = frame[i + 1];
      const b = frame[i];
      const yawMid = yawAt((a.alongM + b.alongM) / 2);
      const len = a.alongM - b.alongM; // 後方へ進む区間の長さ(正の値)
      b.x = a.x + Math.sin(yawMid) * len;
      b.z = a.z + Math.cos(yawMid) * len;
    }
  }
  // 直線フレームの目印(列挙されないプロパティ)。toLocal で厳密な直線値を返すのに使う。
  Object.defineProperty(frame, 'straight', { value: straight, enumerable: false, writable: true, configurable: true });
  return frame;
}

/** frameAt の出力先指定版。out に {x, z, yaw} を書き込んで返す(毎フレームの配置ループ用)。 */
export function frameAtInto(frame, alongM, out) {
  if (frame.straight || frame.length === 0) {
    out.x = 0;
    out.z = 0 - alongM;
    out.yaw = 0;
    return out;
  }
  const first = frame[0];
  const last = frame[frame.length - 1];
  if (alongM <= first.alongM || alongM >= last.alongM || frame.length === 1) {
    const end = alongM <= first.alongM ? first : last;
    const ext = alongM - end.alongM;
    out.x = end.x - Math.sin(end.yaw) * ext;
    out.z = end.z - Math.cos(end.yaw) * ext;
    out.yaw = end.yaw;
    return out;
  }
  // 二分探索(alongM 配列を作らずに frame を直接引く)。
  let lo = 0;
  let hi = frame.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frame[mid].alongM <= alongM) lo = mid;
    else hi = mid - 1;
  }
  const a = frame[lo];
  const b = frame[lo + 1];
  if (alongM === a.alongM) {
    out.x = a.x;
    out.z = a.z;
    out.yaw = a.yaw;
    return out;
  }
  const t = (alongM - a.alongM) / (b.alongM - a.alongM);
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.yaw = a.yaw + (b.yaw - a.yaw) * t;
  return out;
}

/** 任意の alongM における {x, z, yaw}。範囲外は端点の向きのまま直線で外挿する。 */
export function frameAt(frame, alongM) {
  return frameAtInto(frame, alongM, { x: 0, z: 0, yaw: 0 });
}

/**
 * toLocal の出力先指定版。out に {x, z, yaw} を書き込んで返す。
 * 毎フレーム数百回呼ぶ配置ループで、使い回しのオブジェクトを渡して GC を抑えるためのもの。
 */
export function toLocalInto(frame, alongM, xOffsetM, out) {
  if (frame.straight || frame.length === 0) {
    out.x = xOffsetM;
    out.z = -alongM;
    out.yaw = 0;
    return out;
  }
  frameAtInto(frame, alongM, out);
  const yaw = out.yaw;
  out.x += Math.cos(yaw) * xOffsetM;
  out.z -= Math.sin(yaw) * xOffsetM;
  return out;
}

/**
 * 道路中心から右へ xOffsetM ずらした点の相対座標と向き。
 * 配置物の回転は「元の rotY + yaw」にする。
 * curve が空のフレームでは厳密に {x: xOffsetM, z: −alongM, yaw: 0} を返す。
 * @returns {{x, z, yaw}}
 */
export function toLocal(frame, alongM, xOffsetM) {
  return toLocalInto(frame, alongM, xOffsetM, { x: 0, z: 0, yaw: 0 });
}

/**
 * カーブ内側の折り重なり対策。横オフセット d がカーブの内側(k > 0 なら d < 0、
 * k < 0 なら d > 0)で曲率半径の 0.8 倍を超えるとき、d を ±0.8/|k| に丸める。
 * 外側や k = 0 では d をそのまま返す。
 */
export function clampInsideOffset(k, d) {
  if (k === 0 || !Number.isFinite(k)) return d;
  const limit = INSIDE_CLAMP_RATIO / Math.abs(k);
  const inside = k > 0 ? d < 0 : d > 0;
  if (inside && Math.abs(d) > limit) return Math.sign(d) * limit;
  return d;
}

/**
 * createAnchoredRoute の σ > 0 で、中心線の位置にかけるガウス平滑の σ を lateralSigmaM(d) の何倍にするか。
 * 位置の平滑化は方位の平滑化より曲率が下がりにくい(窓内の接線の平均で速さ |X'| が縮み、
 * 弧長あたりの曲率がかえって上がる)ため、等倍だと山岳コースの |d| ≈ 1.2〜2.3km で
 * |d|·κ_σ > 1 となり格子が裏返る。1.5 倍で全コースの max |d|·κ_σ ≈ 0.8 に収まる。
 */
const ANCHORED_SIGMA_SCALE = 1.5;
// 平滑化前の中心線を最初に積分しておく範囲の余裕(サンプル数)。LandscapeScene の最も遠い列
// (路肩外縁 + 3500m)の σ まで足りるようにして、通常は積分し直さずに済ませる。
const DEFAULT_MAX_LATERAL_M = 3600;
const DEFAULT_MARGIN_K = (stepM) =>
  3 * (boxHalfWidth(((lateralSigmaM(DEFAULT_MAX_LATERAL_M) * ANCHORED_SIGMA_SCALE) / stepM) ** 2) + 1);

/** 箱フィルタ3回の分散 h(h+1)(サンプル²)が v 以下になる最大の h(≥ 0)。 */
function boxHalfWidth(v) {
  let h = Math.max(0, Math.floor((Math.sqrt(1 + 4 * v) - 1) / 2));
  while ((h + 1) * (h + 2) <= v) h++;
  while (h > 0 && h * (h + 1) > v) h--;
  return h;
}

/**
 * 幅 2h+1 の箱フィルタ(移動平均)。src[off + i … off + i + 2h] の平均を dst[i] に書く
 * (i = 0 … len − 2h − 1)。累積の足し引きで O(len)。
 */
function boxPass(src, off, len, h, dst) {
  const w = 2 * h + 1;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += src[off + i];
  const nOut = len - 2 * h;
  for (let i = 0; i < nOut; i++) {
    dst[i] = sum / w;
    if (i + 1 < nOut) sum += src[off + i + w] - src[off + i];
  }
}

/**
 * 絶対距離 anchorS に固定した配置座標系(LandscapeScene 用)。
 * アンカー地点の道路中心が原点、アンカーでの道路の向きが −Z(yaw = 0)。
 *
 * - σ = lateralSigmaM(d) = 0(|d| ≤ 20m): 道路中心線 X0 を [anchorS − behindM, anchorS + aheadM] の
 *   stepM 刻み(buildElevationProfile と同じ並び)で区間中点の方位から積分し、間は線形補間する。
 *   向きは headingAtM(s) − headingAtM(anchorS) の線形補間で、buildRouteFrame/toLocal と
 *   同じ道路中心線になる(アンカー基準の剛体変換の違いだけ)。
 * - σ > 0(横に遠い点): 中心線の「位置」をガウス平滑した曲線 X_σ = G_σpos * X0
 *   (σpos = ANCHORED_SIGMA_SCALE·σ)に沿わせ、
 *   位置 = X_σ(s) + r(yaw_σ(s))·d、yaw_σ = X_σ の接線方向とする。遠い列ほど緩やかな経路に沿うので、
 *   横 ±数km の地形格子もカーブ内側で裏返らない。畳み込みは剛体変換と可換なので、
 *   X_σ はアンカーによらず同じ曲線になる(16m ごとの組み直しで遠景が横へ跳ばない)。
 *   ・X0 は絶対距離の stepM の倍数の格子で、アンカーから区間中点の方位で積分する
 *     (アンカーが格子上なら区間の切り方もアンカーによらない)。範囲は出力範囲の前後に
 *     平滑化の台の半幅(3(h+1) サンプル)を足したもの。
 *   ・ガウスは幅 w = 2h+1 の箱フィルタ3回で近似する。3回の分散は (w²−1)/4 = h(h+1) サンプル² なので、
 *     h(h+1) ≤ (σpos/stepM)² < (h+1)(h+2) となる h と h+1 の結果を、分散がちょうど σpos² になる比で混ぜる
 *     (σ に対して連続になり、列の σ が小さくても段差が出ない)。h ごと・σ ごとにキャッシュする。
 *   ・yaw_σ は X_σ の中心差分の向き(アンカー座標での角度、yaw = 0 が −Z)。間は線形補間。
 * 範囲外は端点の向きのまま直線で外挿する。curve が空なら厳密な直線。
 *
 * @returns {{
 *   anchorS: number,
 *   place: (s: number, d: number) => {x: number, z: number, yaw: number},
 *   headingAt: (s: number) => number,
 * }}
 *   place: 絶対距離 s・道路中心から右へ d の点と、その点での(平滑化した)道路の向き。
 *   headingAt: σ = 0 の道路の向き headingAtM(s) − headingAtM(anchorS)(ライダー・カメラ用)。
 */
export function createAnchoredRoute(curve, loopLengthM, anchorS, { behindM, aheadM, stepM }) {
  const terms = toTerms(curve, loopLengthM);
  if (terms.length === 0) {
    return {
      anchorS,
      place: (s, d) => ({ x: d, z: -(s - anchorS), yaw: 0 }),
      headingAt: () => 0,
    };
  }

  const hA = headingFromTerms(terms, loopLengthM, anchorS, 0);
  const yawAtS = (s) => headingFromTerms(terms, loopLengthM, s, 0) - hA;

  // ---- σ = 0: 道路中心線(アンカーからの相対位置の並び) ----
  const { alongs, originIndex } = sampleAlongs(behindM, aheadM, stepM);
  const n = alongs.length;
  const firstRel = alongs[0];
  const lastRel = alongs[n - 1];
  const center = integrate(alongs, originIndex, (rel) => yawAtS(anchorS + rel));
  const centerYaws = new Float64Array(n);
  for (let i = 0; i < n; i++) centerYaws[i] = i === originIndex ? 0 : yawAtS(anchorS + alongs[i]);

  // ---- σ > 0: 絶対距離の格子(index k ↔ s = k·stepM)上の平滑化経路 ----
  // 出力範囲(端の向きを中心差分で求めるため前後に1サンプル余分)
  const firstK = Math.floor((anchorS - behindM) / stepM);
  const lastK = Math.ceil((anchorS + aheadM) / stepM);
  const nOut = lastK - firstK + 3; // 絶対 index firstK−1 … lastK+1
  const kA = Math.floor(anchorS / stepM);
  // X0(平滑化前の中心線)。base0 は配列先頭の絶対 index。必要な余裕に応じて積分し直す。
  let base0 = 0;
  let x0 = null;
  let z0 = null;
  let scratchA = null;
  let scratchB = null;
  let marginNow = -1;
  function ensureCenterGrid(needK) {
    if (needK <= marginNow) return;
    // 足りなくなったら余裕を倍以上に広げて積分し直す(σ が少しずつ増える呼び方でも数回で済む)。
    // 初回は LandscapeScene の最も遠い列まで足りる余裕にしておく。
    const marginK = Math.max(needK, 2 * marginNow, DEFAULT_MARGIN_K(stepM));
    marginNow = marginK;
    const from = firstK - 1 - marginK;
    const to = lastK + 1 + marginK;
    const len = to - from + 1;
    base0 = from;
    x0 = new Float64Array(len);
    z0 = new Float64Array(len);
    scratchA = new Float64Array(len);
    scratchB = new Float64Array(len);
    // アンカーから前後の格子点へ。アンカーが格子上でなければ最初の区間だけ半端な長さになる。
    const iA = kA - base0; // s_kA ≤ anchorS
    const sKA = kA * stepM;
    if (iA >= 0 && iA < len) {
      const back = anchorS - sKA;
      const yb = back > 0 ? yawAtS((anchorS + sKA) / 2) : 0;
      x0[iA] = Math.sin(yb) * back;
      z0[iA] = Math.cos(yb) * back;
    }
    for (let i = iA + 1; i < len; i++) {
      const sB = (base0 + i) * stepM;
      // 1区間目はアンカーから、以降は1つ手前の格子点から
      const sA = i === iA + 1 ? anchorS : (base0 + i - 1) * stepM;
      const px = i === iA + 1 ? 0 : x0[i - 1];
      const pz = i === iA + 1 ? 0 : z0[i - 1];
      const yawMid = yawAtS((sA + sB) / 2);
      const segLen = sB - sA;
      x0[i] = px - Math.sin(yawMid) * segLen;
      z0[i] = pz - Math.cos(yawMid) * segLen;
    }
    for (let i = iA - 1; i >= 0; i--) {
      const sA = (base0 + i + 1) * stepM;
      const sB = (base0 + i) * stepM;
      const yawMid = yawAtS((sA + sB) / 2);
      const segLen = sA - sB; // 後方へ進む区間の長さ(正の値)
      x0[i] = x0[i + 1] + Math.sin(yawMid) * segLen;
      z0[i] = z0[i + 1] + Math.cos(yawMid) * segLen;
    }
  }

  const boxed = new Map(); // h → {xs, zs}(箱フィルタ3回、絶対 index firstK−1 … lastK+1)
  function boxedFor(h) {
    let b = boxed.get(h);
    if (b) return b;
    ensureCenterGrid(3 * h);
    const off = firstK - 1 - 3 * h - base0;
    const xs = new Float64Array(nOut);
    const zs = new Float64Array(nOut);
    if (h === 0) {
      xs.set(x0.subarray(off, off + nOut));
      zs.set(z0.subarray(off, off + nOut));
    } else {
      const len = nOut + 6 * h;
      for (const [src, dst] of [[x0, xs], [z0, zs]]) {
        boxPass(src, off, len, h, scratchA);
        boxPass(scratchA, 0, len - 2 * h, h, scratchB);
        boxPass(scratchB, 0, len - 4 * h, h, dst);
      }
    }
    b = { xs, zs };
    boxed.set(h, b);
    return b;
  }

  const smoothTracks = new Map(); // σ → {xs, zs, yaws}(絶対 index firstK … lastK)
  function smoothTrackFor(sigma) {
    let tr = smoothTracks.get(sigma);
    if (tr) return tr;
    // 箱3回の分散 h(h+1)(サンプル²)が (σ_pos/stepM)² を挟む h, h+1 を混ぜる。
    const v = ((sigma * ANCHORED_SIGMA_SCALE) / stepM) ** 2;
    const h = boxHalfWidth(v);
    const t = (v - h * (h + 1)) / (2 * (h + 1));
    const lo = boxedFor(h);
    const hi = t > 0 ? boxedFor(h + 1) : lo;
    const sx = new Float64Array(nOut);
    const sz = new Float64Array(nOut);
    for (let i = 0; i < nOut; i++) {
      sx[i] = lo.xs[i] + (hi.xs[i] - lo.xs[i]) * t;
      sz[i] = lo.zs[i] + (hi.zs[i] - lo.zs[i]) * t;
    }
    const nTr = nOut - 2;
    const xs = sx.subarray(1, nOut - 1);
    const zs = sz.subarray(1, nOut - 1);
    const yaws = new Float64Array(nTr);
    // 接線の向き。前方 f = (−sin yaw, −cos yaw) なので yaw = atan2(−dx, −dz)。
    for (let i = 0; i < nTr; i++) yaws[i] = Math.atan2(sx[i] - sx[i + 2], sz[i] - sz[i + 2]);
    // ±π をまたぐ不連続を、アンカー付近のサンプルから外側へ順に巻き戻す。
    const iA = Math.min(nTr - 1, Math.max(0, kA - firstK));
    for (let i = iA + 1; i < nTr; i++) yaws[i] = unwrapNear(yaws[i], yaws[i - 1]);
    for (let i = iA - 1; i >= 0; i--) yaws[i] = unwrapNear(yaws[i], yaws[i + 1]);
    tr = { xs, zs, yaws };
    smoothTracks.set(sigma, tr);
    return tr;
  }

  function place(s, d) {
    const sigma = lateralSigmaM(d);
    let x;
    let z;
    let yaw;
    if (sigma === 0) {
      const rel = s - anchorS;
      if (rel <= firstRel || rel >= lastRel || n === 1) {
        const i = rel <= firstRel ? 0 : n - 1;
        yaw = centerYaws[i];
        const ext = rel - alongs[i];
        x = center.xs[i] - Math.sin(yaw) * ext;
        z = center.zs[i] - Math.cos(yaw) * ext;
      } else {
        const i = findSegment(alongs, rel);
        const t = (rel - alongs[i]) / (alongs[i + 1] - alongs[i]);
        x = center.xs[i] + (center.xs[i + 1] - center.xs[i]) * t;
        z = center.zs[i] + (center.zs[i + 1] - center.zs[i]) * t;
        // 向きも frameAt と同じくサンプル間の線形補間にする(σ = 0 で toLocal と揃えるため)。
        yaw = centerYaws[i] + (centerYaws[i + 1] - centerYaws[i]) * t;
      }
    } else {
      const tr = smoothTrackFor(sigma);
      const nTr = tr.xs.length;
      const sFirst = firstK * stepM;
      const sLast = lastK * stepM;
      if (s <= sFirst || s >= sLast) {
        const i = s <= sFirst ? 0 : nTr - 1;
        yaw = tr.yaws[i];
        const ext = s - (firstK + i) * stepM;
        x = tr.xs[i] - Math.sin(yaw) * ext;
        z = tr.zs[i] - Math.cos(yaw) * ext;
      } else {
        const k = Math.min(lastK - 1, Math.floor(s / stepM));
        const i = k - firstK;
        const t = (s - k * stepM) / stepM;
        x = tr.xs[i] + (tr.xs[i + 1] - tr.xs[i]) * t;
        z = tr.zs[i] + (tr.zs[i + 1] - tr.zs[i]) * t;
        yaw = tr.yaws[i] + (tr.yaws[i + 1] - tr.yaws[i]) * t;
      }
    }
    return {
      x: x + Math.cos(yaw) * d,
      z: z - Math.sin(yaw) * d,
      yaw,
    };
  }

  return {
    anchorS,
    place,
    headingAt: (s) => headingFromTerms(terms, loopLengthM, s, 0) - hA,
  };
}

/** 角度 a を 2π の整数倍ずらして ref との差を ±π 以内にする。 */
function unwrapNear(a, ref) {
  const TWO_PI = 2 * Math.PI;
  return a - TWO_PI * Math.round((a - ref) / TWO_PI);
}
