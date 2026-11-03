// 熱海サンビーチコース(国道135号の海岸沿い)の実在データの読み込みと、配置の計算。
// Three.js・DOM に依存しない純粋関数(test/unit から読める)。描画は js/ui/AtamiScene.js。
//
// データ(js/data/atami-plateau.json)は tools/atami-plateau/build.py が作る:
//   - 道路中心線(国土地理院 道路中心線)を 2m 間隔に引き直した線と、路面の標高(国土地理院 DEM5A)・半幅
//   - 地形の標高格子: 近景 10m 間隔(道路の下は路面の高さにならし済み)、遠景 80m 間隔(初島まで)
//   - 建物: PLATEAU 熱海市(2023年度)の建築物 LOD1 の外形と高さ(ルートから 450m 以内)
//   - 道路網: 国土地理院の道路中心線と幅の区分(走るルート以外)
//
// 座標: 原点 = スタート地点(サンビーチの北寄り)、x = 東(m)、y = 北(m)、z = 標高(m、海面 0)。
// Three.js のシーンでは (x, z, −y) に置く(PondScene と同じく北が −Z)。
//
// コース1周 = 往復: スタートから南へ(錦ヶ浦の手前でUターン)→ 北へ(伊豆山でUターン)→ 南へスタートまで。
// 片道の中心線上の位置を t(南端 = 0 から北へ測った m)、1周の中の位置を s(スタート = 0)とする。
// 道路の左右 d は進行方向の右が正(既存シーンと同じ)。日本は左側通行なので、往きと帰りで
// 同じ d < 0 の車線が道路の反対側になる(Uターンでは右回りに反対車線へ移る)。

export const ATAMI_DATA_URL = new URL('../data/atami-plateau.json', import.meta.url).href;

// サンビーチの砂浜がある区間(南端からの t、m)。この区間の海側の低い所を砂浜に塗り、ヤシ並木を置く。
export const SUN_BEACH_T = [780, 1380];
// 海沿いの遊歩道(ヤシ並木・街灯・手すり)がある区間。親水公園の先まで続く。
export const PROMENADE_T = [700, 1900];
// Uターンで回り込む最小の幅(m)。中心線上(d = 0)でも曲がって見えるように。
const UTURN_MIN_BULGE_M = 3;

/** 行ごとの差分(dm)の格子 → 標高(m)の Float32Array(行は南から北、列は西から東)。 */
export function decodeGrid(g) {
  const h = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    const row = g.rows[j];
    let v = 0;
    for (let i = 0; i < g.nx; i++) {
      v += row[i];
      h[j * g.nx + i] = v / 10;
    }
  }
  return { x0: g.x0, y0: g.y0, step: g.step, nx: g.nx, ny: g.ny, h };
}

/** 格子の双一次補間。範囲外は NaN。 */
export function gridHeight(grid, x, y) {
  const fx = (x - grid.x0) / grid.step;
  const fy = (y - grid.y0) / grid.step;
  if (!(fx >= 0 && fy >= 0 && fx <= grid.nx - 1 && fy <= grid.ny - 1)) return NaN;
  const i = Math.min(grid.nx - 2, Math.floor(fx));
  const j = Math.min(grid.ny - 2, Math.floor(fy));
  const tx = fx - i;
  const ty = fy - j;
  const h = grid.h;
  const k = j * grid.nx + i;
  const a = h[k] + (h[k + 1] - h[k]) * tx;
  const b = h[k + grid.nx] + (h[k + grid.nx + 1] - h[k + grid.nx]) * tx;
  return a + (b - a) * ty;
}

/**
 * 近景の格子の外周を、遠景の格子の値(辺に沿った線形補間)にそろえる。
 * 遠景のメッシュは近景の範囲をくり抜いて描くので、境目にすき間・段差ができないようにする。
 */
export function stitchGrid(inner, outer) {
  const { nx, ny, h } = inner;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i !== 0 && j !== 0 && i !== nx - 1 && j !== ny - 1) continue;
      const v = gridHeight(outer, inner.x0 + i * inner.step, inner.y0 + j * inner.step);
      if (Number.isFinite(v)) h[j * nx + i] = v;
    }
  }
}

/**
 * JSON(build.py の出力)→ 使いやすい形。建物の外形は [x, y] の配列、標高は m に戻す。
 */
export function decodeAtamiData(raw) {
  const r = raw.route;
  const n = r.x.length;
  const route = {
    stepM: r.stepM, n, startTM: r.startTM, uturnM: r.uturnM,
    // 'outback' = 片道の線を往復(熱海)、'loop' = 閉じた線を周回(最後の点 = 最初の点)。onWater = 池の上
    mode: r.mode === 'loop' ? 'loop' : 'outback', onWater: !!r.onWater,
    x: Float64Array.from(r.x), y: Float64Array.from(r.y), z: Float64Array.from(r.z),
    halfWidth: Float64Array.from(r.halfWidth), bridge: Uint8Array.from(r.bridge),
    lengthM: (n - 1) * r.stepM,
  };
  const terrain = decodeGrid(raw.terrain);
  const outer = decodeGrid(raw.outer);
  stitchGrid(terrain, outer);
  const buildings = raw.buildings.map((b) => {
    const ring = [];
    let x = 0;
    let y = 0;
    for (let k = 4; k < b.length; k += 2) {
      x += b[k];
      y += b[k + 1];
      ring.push([x / 10, y / 10]);
    }
    return { base: b[0] / 10, height: b[1] / 10, usage: b[2], storeys: b[3], ring };
  });
  const streets = raw.streets.map((s) => {
    const pts = [];
    let x = 0;
    let y = 0;
    for (let k = 1; k < s.length; k += 2) {
      x += s[k];
      y += s[k + 1];
      pts.push([x / 10, y / 10]);
    }
    return { widthM: s[0] / 10, pts };
  });
  return {
    origin: raw.origin, attribution: raw.attribution, route, terrain, outer, buildings, streets,
    landmarks: raw.landmarks ?? [],
    // 湖・池の水面 [{ level, x0, y0, x1, y1 }](熱海は海面 0 の海だけなので無い)
    waters: raw.waters ?? [],
  };
}

let cached = null;

/** データを読み込む(1回だけ。2回目以降は同じ Promise)。 */
export function loadAtamiData(fetchImpl = globalThis.fetch) {
  if (!cached) {
    cached = fetchImpl(ATAMI_DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${ATAMI_DATA_URL}`);
        return res.json();
      })
      .then(decodeAtamiData)
      .catch((err) => {
        cached = null; // 失敗したら次の走行でやり直せるように
        throw err;
      });
  }
  return cached;
}

/** 地形の高さ(近景の格子、無ければ遠景)。どちらの範囲外でも 0(海面)。 */
export function createTerrainSampler(data) {
  return (x, y) => {
    let v = gridHeight(data.terrain, x, y);
    if (Number.isFinite(v)) return v;
    v = gridHeight(data.outer, x, y);
    return Number.isFinite(v) ? v : -5;
  };
}

/**
 * 中心線と1周の位置の計算。
 * @returns {{
 *   lapM: number, oneWayM: number,
 *   center(t): { x, y, z, hw, tx, ty },
 *   legAt(s): { t, dir, turn: null | { frac, endT } },
 *   place(s, d): { x, y, z, fx, fy, t, hw },
 *   turnDistanceM(s): number,
 * }}
 */
export function createAtamiRoute(route) {
  const { x, y, z, halfWidth, stepM, n } = route;
  const T = route.lengthM;
  const t0 = route.startTM;
  const loop = route.mode === 'loop';
  const U = loop ? 0 : route.uturnM;
  const lapM = loop ? T : 2 * T + 2 * U;

  // 接線(中心差分を正規化)。周回の線は端をまたいで(最後の点 = 最初の点)
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = Math.max(0, i - 2);
    let b = Math.min(n - 1, i + 2);
    if (loop && (i < 2 || i > n - 3)) {
      a = (i - 2 + (n - 1)) % (n - 1);
      b = (i + 2) % (n - 1);
    }
    const dx = x[b] - x[a];
    const dy = y[b] - y[a];
    const len = Math.hypot(dx, dy) || 1;
    tx[i] = dx / len;
    ty[i] = dy / len;
  }

  function center(t, out = {}) {
    if (loop) t = ((t % T) + T) % T;
    const f = Math.min(n - 1, Math.max(0, t / stepM));
    const i = Math.min(n - 2, Math.floor(f));
    const u = f - i;
    out.x = x[i] + (x[i + 1] - x[i]) * u;
    out.y = y[i] + (y[i + 1] - y[i]) * u;
    out.z = z[i] + (z[i + 1] - z[i]) * u;
    out.hw = halfWidth[i] + (halfWidth[i + 1] - halfWidth[i]) * u;
    const ex = tx[i] + (tx[i + 1] - tx[i]) * u;
    const ey = ty[i] + (ty[i + 1] - ty[i]) * u;
    const len = Math.hypot(ex, ey) || 1;
    out.tx = ex / len;
    out.ty = ey / len;
    // 中心線の外(Uターンの先)は端の向きのまま直進する
    if (t < 0) {
      out.x += out.tx * t;
      out.y += out.ty * t;
    } else if (t > T) {
      out.x += out.tx * (t - T);
      out.y += out.ty * (t - T);
    }
    return out;
  }

  /** 1周の中の位置 s → 片道の位置 t と向き(+1 = 北へ、−1 = 南へ)。Uターン中は turn。 */
  function legAt(s) {
    let m = s % lapM;
    if (m < 0) m += lapM;
    if (loop) return { t: (t0 + m) % T, dir: 1, turn: null };
    if (m <= t0) return { t: t0 - m, dir: -1, turn: null };
    if (m < t0 + U) return { t: 0, dir: -1, turn: { frac: (m - t0) / U, endT: 0 } };
    if (m <= t0 + U + T) return { t: m - t0 - U, dir: 1, turn: null };
    if (m < t0 + 2 * U + T) return { t: T, dir: 1, turn: { frac: (m - t0 - U - T) / U, endT: T } };
    return { t: T - (m - t0 - 2 * U - T), dir: -1, turn: null };
  }

  const _c = {};
  /**
   * 1周の中の位置 s、道路中心から右へ d(m)の地点。fx, fy は進行方向(単位ベクトル、地図座標)。
   * Uターン中は、到着時の向きの前方へ膨らむ半円(楕円)で反対車線へ回り込む(右回り)。
   */
  function place(s, d, out = {}) {
    const leg = legAt(s);
    if (!leg.turn) {
      const c = center(leg.t, _c);
      const fx = c.tx * leg.dir;
      const fy = c.ty * leg.dir;
      // 右 = 進行方向を時計回りに90°(地図座標で (fy, −fx))
      out.x = c.x + d * fy;
      out.y = c.y - d * fx;
      out.z = c.z;
      out.fx = fx;
      out.fy = fy;
      out.t = leg.t;
      out.hw = c.hw;
      return out;
    }
    const { frac, endT } = leg.turn;
    const c = center(endT, _c);
    // 到着時の向き F0(南端へは南向き、北端へは北向き)と右 R0
    const sgn = endT === 0 ? -1 : 1;
    const f0x = c.tx * sgn;
    const f0y = c.ty * sgn;
    const r0x = f0y;
    const r0y = -f0x;
    const phi = Math.PI * frac;
    const bulge = Math.max(Math.abs(d), UTURN_MIN_BULGE_M);
    out.x = c.x + d * Math.cos(phi) * r0x + bulge * Math.sin(phi) * f0x;
    out.y = c.y + d * Math.cos(phi) * r0y + bulge * Math.sin(phi) * f0y;
    out.z = c.z;
    // 向き: F0 から右(R0)へ φ だけ回る
    out.fx = Math.cos(phi) * f0x + Math.sin(phi) * r0x;
    out.fy = Math.cos(phi) * f0y + Math.sin(phi) * r0y;
    out.t = endT;
    out.hw = c.hw;
    return out;
  }

  // Uターンの中央(1周の中の位置)
  const turnS = loop ? [] : [t0 + U / 2, t0 + 1.5 * U + T];
  /** 1周の中の位置 s から、最も近いUターンの中央までの距離(m)。 */
  function turnDistanceM(s) {
    let m = s % lapM;
    if (m < 0) m += lapM;
    let best = Infinity;
    for (const c of turnS) {
      const d = Math.abs(m - c);
      best = Math.min(best, d, lapM - d);
    }
    return best;
  }

  return { lapM, oneWayM: T, startTM: t0, uturnM: U, loop, center, legAt, place, turnDistanceM };
}

/** 進行方向(地図座標の単位ベクトル)→ −Z が前のモデルの Y 回転(シーンは北が −Z、東が +X)。 */
export function yawFromDir(fx, fy) {
  return Math.atan2(-fx, fy);
}

/**
 * 中心線の各点で、海がどちら側にあるか(+1 = 北向きに走るときの右 = 東、−1 = 西、0 = どちらも陸)。
 * 中心線から左右へ seaProbeM 離れた地点の地形が海面より低ければ海とみなす。
 */
export function seaSides(route, heightAt, probeM = [30, 60, 90]) {
  const r = createAtamiRoute(route);
  const out = new Int8Array(route.n);
  const c = {};
  for (let i = 0; i < route.n; i++) {
    r.center(i * route.stepM, c);
    let east = 0;
    let west = 0;
    for (const p of probeM) {
      if (heightAt(c.x + c.ty * p, c.y - c.tx * p) <= 0.5) east++;
      if (heightAt(c.x - c.ty * p, c.y + c.tx * p) <= 0.5) west++;
    }
    out[i] = east > west ? 1 : west > east ? -1 : 0;
  }
  return out;
}

// 建物の外壁の種類(都市の外壁シェーダーの種類)と色味。PLATEAU の用途コード(建築物の usage)で分ける:
// 401 業務 / 402 商業 / 403 宿泊 / 404 商業系複合 / 411 住宅 / 412 共同住宅 / 413・414 店舗等併用 / 421〜 公共・その他
const HOTEL_TINTS = [0xffffff, 0xf7f2e8, 0xefe6d6, 0xe8e4dc, 0xf4efe4, 0xdcd6cc];
const HOUSE_TINTS = [0xf1ece2, 0xe4dccb, 0xd9cdb6, 0xc9b79c, 0xf5f3ee, 0xb8a58a];
const HOUSE_ROOFS = [0x3c4148, 0x2f3d52, 0x7a3b2a, 0x4a4a4a, 0x5b3a2a, 0x55524c];
const FLAT_ROOFS = [0x9c9890, 0x8e8b85, 0xa7a39a, 0x86837c];

function hashIndex(seed, n) {
  let h = Math.imul(seed | 0, 2654435761) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) % n;
}

/**
 * 建物の見た目(決定的)。style は cityMaterials.js の外壁の種類、tint は外壁の色、roof は屋根の色。
 * 低い戸建て(住宅で高さ 10m 未満)は瓦屋根の色、それ以外は陸屋根の灰色。
 */
export function buildingLook(b, index) {
  const tall = b.height >= 18;
  const house = (b.usage === 411 || b.usage === 413 || b.usage === 451) && b.height < 10;
  let style;
  if (b.usage === 403) style = tall && hashIndex(index, 4) === 0 ? 'glass' : hashIndex(index, 2) ? 'stucco' : 'concrete';
  else if (b.usage === 401 || b.usage === 402 || b.usage === 404) style = tall && hashIndex(index, 3) === 0 ? 'glass' : 'concrete';
  else if (house) style = 'stucco';
  else style = hashIndex(index, 3) === 0 ? 'concrete' : 'stucco';
  const tints = house ? HOUSE_TINTS : HOTEL_TINTS;
  return {
    style,
    tint: tints[hashIndex(index * 7 + 1, tints.length)],
    roof: house ? HOUSE_ROOFS[hashIndex(index * 13 + 5, HOUSE_ROOFS.length)] : FLAT_ROOFS[hashIndex(index * 3 + 2, FLAT_ROOFS.length)],
    house,
  };
}

/**
 * 海沿いの遊歩道の配置物(ヤシ並木・街灯)。PROMENADE_T の区間で、海側の歩道の外寄りに置く。
 * 返す位置は片道の位置 t と、北へ走るときの右を正とした横距離 e(m)。
 */
export function collectPromenade(route, sides) {
  const palms = [];
  const lamps = [];
  const r = createAtamiRoute(route);
  const c = {};
  const sideAt = (t) => sides[Math.min(route.n - 1, Math.max(0, Math.round(t / route.stepM)))];
  for (let t = PROMENADE_T[0]; t <= PROMENADE_T[1]; t += 11) {
    const side = sideAt(t);
    if (!side) continue;
    r.center(t, c);
    palms.push({ t, e: side * (c.hw + 1.6), scale: 0.9 + 0.3 * ((Math.sin(t * 12.9898) + 1) / 2), yaw: (t * 0.7) % (Math.PI * 2) });
  }
  for (let t = PROMENADE_T[0] + 5; t <= PROMENADE_T[1]; t += 33) {
    const side = sideAt(t);
    if (!side) continue;
    r.center(t, c);
    lamps.push({ t, e: side * (c.hw + 3.2) });
  }
  return { palms, lamps };
}

/**
 * 地形の格子の頂点の色(sRGB 0..1)。標高・傾き・海までの近さ・建物の密度から塗る。
 * @param {number} h 標高(m)
 * @param {number} normalY 法線のY成分
 * @param {number} builtUp 建物の密度(0..1)
 * @param {boolean} beach サンビーチの砂浜の範囲か
 */
export function groundColor(h, normalY, builtUp, beach, noise) {
  const n = (noise - 0.5) * 0.06;
  if (h <= -0.3) return [0.5 + n, 0.48 + n, 0.38 + n]; // 海底の砂
  if (beach && h < 4.2) {
    if (h < 0.6) return [0.68 + n, 0.6 + n, 0.47 + n]; // 波打ち際の濡れた砂
    return [0.87 + n, 0.79 + n, 0.62 + n]; // 乾いた砂浜
  }
  if (h < 2.5 && normalY > 0.9) return [0.62 + n, 0.61 + n, 0.58 + n]; // 岸壁・防波堤のコンクリート
  // 海沿いの平らな埋め立て地(港・駐車場・公園の広場)は舗装の色。建物が無くても草地にしない
  if (h < 12 && normalY > 0.985) builtUp = Math.max(builtUp, 0.85);
  // 森(斜面・山の上)⇄ 市街地(建物の密集した所は屋根・舗装の灰色)
  const forest = Math.min(1, Math.max(0, (h - 60) / 220)) * 0.5 + 0.35;
  const green = [0.36 - 0.2 * forest + n, 0.5 - 0.2 * forest + n, 0.24 - 0.09 * forest + n];
  const town = [0.6 + n, 0.58 + n, 0.53 + n];
  const k = Math.min(1, builtUp * 1.3);
  let rgb = green.map((g, i) => g + (town[i] - g) * k);
  // 急な崖は岩肌
  const rock = Math.min(1, Math.max(0, (0.62 - normalY) / 0.2));
  rgb = rgb.map((v, i) => v + ([0.48, 0.46, 0.42][i] - v) * rock);
  return rgb.map((v) => Math.min(1, Math.max(0, v)));
}
