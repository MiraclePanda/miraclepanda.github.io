// 観光地コースの名所の建物(五重塔・三重塔・三門/楼門・大仏殿・清水の舞台・浮見堂)の3Dの形。
// roadsideActors.js のテンプレートの一種で、描画・配置は roadsideActors.js が行う
// (敷地の広さ・地面の合わせ方は roadsideLayout.js の SIGHT_FOOTPRINTS)。
//
// 実在の建物の「らしさ」が遠目にも分かることを優先した簡略模型(寸法はおおよそ実物どおり、細部は省略)。
// 原点は建物の中心の地面、正面は +Z(向き 0 のとき走ってくる側。沿道に置くときは yaw = ∓π/2 で道路へ向ける)。
// 地面の起伏で浮かないよう、基壇・柱は地下まで伸ばしてある。
//
// 部品の塗り・結合は roadsideActors.js の道具(kit = { paint, merge, box, rod, sphere })を使う
// (頂点カラー + 共通のアトラス、1種類1ジオメトリ = 1 draw call)。

import THREE from './three.js';
import { PAGODA_PLINTH_HALF_M } from './roadsideLayout.js';

/**
 * 反りのある寄棟屋根(四角い平面形、軒先は平らで頂部ほど急、四隅が跳ね上がる)。
 * rBottom: 軒先の半幅、rTop: 上端の半幅、fascia > 0 なら軒先の鼻隠し(縦の帯)を作る。
 */
export function eaveRoof(rBottom, rTop, height, lift, fascia = 0) {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 24, fascia ? 1 : 5, true);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const t = pos.getY(i) + 0.5;
    const th = Math.atan2(x, z);
    // 円を正方形へ(辺が軸に沿う)。corner は四隅で 1
    const k = 1 / Math.max(Math.abs(Math.sin(th)), Math.abs(Math.cos(th)));
    const corner = (k - 1) / (Math.SQRT2 - 1);
    let r;
    let y;
    if (fascia) {
      r = rBottom;
      y = lift * corner - (1 - t) * fascia;
    } else {
      r = rBottom + (rTop - rBottom) * t;
      y = height * Math.pow(t, 1.7) + lift * corner * Math.pow(1 - t, 2.5);
    }
    pos.setXYZ(i, Math.sin(th) * r * k, y, Math.cos(th) * r * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * 長方形の平面の反りのある屋根(寄棟。ridgeHalf > 0 なら X 方向の棟)。原点は軒先の高さの中心。
 * hw/hd: 軒先の半幅(X)・半奥行き(Z)、lift: 四隅の跳ね上がり。
 */
export function hipRoof(hw, hd, height, lift, ridgeHalf = Math.max(0, hw - hd)) {
  const N = 12;
  const V = 6;
  const positions = [];
  const idx = [];
  const eaveY = (t) => lift * Math.pow(Math.abs(t), 4);
  const face = (eave, ridge) => {
    const base = positions.length / 3;
    for (let j = 0; j <= V; j++) {
      const v = j / V;
      for (let i = 0; i <= N; i++) {
        const t = -1 + (2 * i) / N;
        const e = eave(t);
        const r = ridge(t);
        // 軒先は緩く棟に近いほど急(反り)。四隅の跳ね上がりは棟へ向かって消える
        const y = e[1] * (1 - v) * (1 - v) + r[1] * Math.pow(v, 1.6);
        positions.push(e[0] + (r[0] - e[0]) * v, y, e[2] + (r[2] - e[2]) * v);
      }
    }
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < N; i++) {
        const a = base + j * (N + 1) + i;
        const c = a + N + 1;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
  };
  face((t) => [t * hw, eaveY(t), hd], (t) => [t * ridgeHalf, height, 0]);
  face((t) => [-t * hw, eaveY(t), -hd], (t) => [-t * ridgeHalf, height, 0]);
  face((t) => [hw, eaveY(t), -t * hd], () => [ridgeHalf, height, 0]);
  face((t) => [-hw, eaveY(t), t * hd], () => [-ridgeHalf, height, 0]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** 入母屋の妻(棟の両端の三角の壁)。x = ±halfX、底辺 y0・頂点 y1、底辺の半幅 halfZ。 */
function gableEnds(halfX, halfZ, y0, y1) {
  const p = [];
  for (const sx of [-1, 1]) p.push(sx * halfX, y0, -halfZ, sx * halfX, y0, halfZ, sx * halfX, y1, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.computeVertexNormals();
  return geo;
}

const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => (n === 1 ? (a + b) / 2 : a + ((b - a) * i) / (n - 1)));

const STONE = 0x8f8b84;
const GOLD = 0xd2ad45;

/**
 * 五重塔・三重塔。原点は基壇の中心の地面(基壇は斜面でも浮かないよう地下 12m まで)。
 * 白壁に濃い木部(興福寺・八坂の塔)と、朱塗り(忠霊塔・清水寺の三重塔)の塗り分け。
 */
function pagodaModel(kit, { storeys, wall, wood, roof, scale }) {
  const { paint, merge, box, sphere } = kit;
  const BRONZE = 0x8a7744;
  const tower = [];
  let y = 0;
  storeys.forEach(({ w, h }, i) => {
    const half = w / 2;
    const base = y;
    // 白壁に、柱・長押・扉(木部)を別の部品として重ねる(頂点カラーの補間でにじまないように)
    tower.push(paint(box(w, h, w, [0, base + h / 2, 0]), wall));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) tower.push(paint(box(0.42, h, 0.42, [sx * half, base + h / 2, sz * half]), wood));
    }
    for (const o of [-half / 3, half / 3]) {
      tower.push(paint(box(0.26, h, w + 0.08, [o, base + h / 2, 0]), wood));
      tower.push(paint(box(w + 0.08, h, 0.26, [0, base + h / 2, o]), wood));
    }
    tower.push(paint(box(w + 0.12, 0.45, w + 0.12, [0, base + 0.22, 0]), wood));
    tower.push(paint(box(w + 0.12, 0.5, w + 0.12, [0, base + h - 0.25, 0]), wood));
    // 中央の柱間の扉(各面)
    const doorW = (2 * half) / 3 - 0.5;
    const doorH = h * 0.55;
    tower.push(paint(box(doorW, doorH, w + 0.05, [0, base + 0.45 + doorH / 2, 0]), 0x3a1d12));
    tower.push(paint(box(w + 0.05, doorH, doorW, [0, base + 0.45 + doorH / 2, 0]), 0x3a1d12));
    if (i > 0) tower.push(paint(box(w + 0.9, 0.35, w + 0.9, [0, base + 0.18, 0]), wood)); // 縁(高欄)
    const next = storeys[i + 1];
    const roofY = base + h - 0.25;
    const last = !next;
    const rTop = last ? 0.55 : (next.w / 2) * 0.92;
    tower.push(paint(eaveRoof(half + 2.4, rTop, last ? 3.4 : 1.5, 0.9).translate(0, roofY, 0), roof));
    tower.push(paint(eaveRoof(half + 2.4, 0, 0, 0.9, 0.35).translate(0, roofY, 0), wood));
    y = last ? roofY + 3.4 : roofY + 1.35;
  });
  // 相輪(露盤・伏鉢・九輪・宝珠)
  tower.push(paint(box(1.5, 0.8, 1.5, [0, y + 0.2, 0]), BRONZE));
  tower.push(paint(sphere(0.65, [0, y + 0.6, 0], [1, 0.7, 1]), BRONZE));
  tower.push(paint(new THREE.CylinderGeometry(0.12, 0.16, 8.6, 8).translate(0, y + 0.6 + 4.3, 0), BRONZE));
  for (let i = 0; i < 9; i++) {
    tower.push(paint(new THREE.CylinderGeometry(0.58 - i * 0.025, 0.58 - i * 0.025, 0.16, 12).translate(0, y + 1.6 + i * 0.62, 0), BRONZE));
  }
  tower.push(paint(sphere(0.3, [0, y + 9.5, 0]), 0xb39a52));
  for (const g of tower) g.scale(scale, scale, scale).translate(0, 1.2, 0);
  // 基壇(石)
  const plinthH = 12 + 1.2;
  tower.push(paint(box(PAGODA_PLINTH_HALF_M * 2, plinthH, PAGODA_PLINTH_HALF_M * 2, [0, 1.2 - plinthH / 2, 0]), STONE));
  return { parts: [{ name: 'body', geo: merge(tower), pivot: [0, 0, 0] }], animate() {} };
}

/**
 * 二重門(下層は柱だけの通路、上層は縁と壁、入母屋の屋根)。知恩院の三門・東大寺の南大門のような
 * 木地の大門(sanmon)と、八坂神社の西楼門・清水寺の仁王門のような朱塗りの楼門(romon)。
 * W: 間口(X)、D: 奥行き(Z)、H: 棟までの高さ。
 */
function gateModel(kit, { W, D, H, post, wall, roof, band, lowerRoof }) {
  const { paint, merge, box, rod } = kit;
  const g = [];
  const baseTop = 1.0;
  g.push(paint(box(W + 3, baseTop + 8, D + 3, [0, baseTop - (baseTop + 8) / 2, 0]), STONE));
  const big = W > 20;
  const r = big ? 0.55 : 0.32;
  const h1 = H * 0.36;
  const xs = linspace(-W / 2 + 0.8, W / 2 - 0.8, big ? 6 : 4);
  const zs = [-D / 2 + 0.6, 0, D / 2 - 0.6];
  for (const x of xs) for (const z of zs) g.push(paint(rod([x, baseTop - 0.1, z], [x, baseTop + h1, z], r, r, 10), post));
  // 頭貫と組物の帯
  g.push(paint(box(W, 0.7, D, [0, baseTop + h1 + 0.35, 0]), post));
  g.push(paint(box(W + 0.6, 0.9, D + 0.6, [0, baseTop + h1 + 1.15, 0]), band));
  let u0 = baseTop + h1 + 1.6;
  if (lowerRoof) {
    // 下層の屋根(裳階のような軒)
    g.push(paint(hipRoof(W / 2 + 2.6, D / 2 + 2.6, H * 0.07, big ? 0.9 : 0.5).translate(0, u0, 0), roof));
    u0 += H * 0.06;
  }
  // 上層: 縁と高欄、壁、壁の外に見える柱
  const uw = W * 0.92;
  const ud = D * 0.85;
  g.push(paint(box(uw + 1.4, 0.4, ud + 1.4, [0, u0 + 0.2, 0]), post));
  for (const sz of [-1, 1]) g.push(paint(box(uw + 1.4, 0.16, 0.16, [0, u0 + 1.2, sz * (ud / 2 + 0.6)]), post));
  for (const sx of [-1, 1]) g.push(paint(box(0.16, 0.16, ud + 1.4, [sx * (uw / 2 + 0.6), u0 + 1.2, 0]), post));
  const h2 = H * 0.25;
  g.push(paint(box(uw, h2, ud, [0, u0 + 0.4 + h2 / 2, 0]), wall));
  for (const x of linspace(-uw / 2, uw / 2, big ? 6 : 4)) {
    for (const sz of [-1, 1]) g.push(paint(box(r * 1.5, h2, 0.3, [x, u0 + 0.4 + h2 / 2, sz * (ud / 2 + 0.05)]), post));
  }
  g.push(paint(box(uw + 0.3, 0.6, ud + 0.3, [0, u0 + 0.4 + h2 - 0.3, 0]), post));
  g.push(paint(box(uw + 0.8, 0.8, ud + 0.8, [0, u0 + 0.4 + h2 + 0.3, 0]), band));
  // 上層の屋根(入母屋: 寄棟の上に妻を立て、棟を載せる)
  const r2 = u0 + 0.4 + h2 + 0.7;
  const rh = Math.max(3, H - r2 - 0.8);
  const ridgeHalf = W * 0.3;
  g.push(paint(hipRoof(uw / 2 + (big ? 4 : 2.4), ud / 2 + (big ? 3.6 : 2.2), rh, big ? 1.6 : 0.8, ridgeHalf).translate(0, r2, 0), roof));
  g.push(paint(gableEnds(ridgeHalf * 0.86, ud * 0.22, r2 + rh * 0.62, r2 + rh), wall));
  g.push(paint(box(ridgeHalf * 2 + 1, 0.9, 0.9, [0, r2 + rh + 0.2, 0]), 0x2c2c2e));
  return { parts: [{ name: 'body', geo: merge(g), pivot: [0, 0, 0] }], animate() {} };
}

/** 東大寺大仏殿(間口約57m・高さ約47m)。二重の屋根、正面の唐破風と観相窓、棟の金色の鴟尾。 */
function daibutsudenModel(kit) {
  const { paint, merge, box, sphere } = kit;
  const WALL = 0xeee8da;
  const WOOD = 0x6a4128;
  const ROOF = 0x47494d;
  const g = [];
  g.push(paint(box(64, 12, 58, [0, -4, 0]), STONE)); // 基壇(上面 y = 2)
  // 下層
  g.push(paint(box(54, 12, 47, [0, 8, 0]), WALL));
  const posts = (w, d, y0, h, nx, nz) => {
    for (const x of linspace(-w / 2, w / 2, nx)) for (const sz of [-1, 1]) g.push(paint(box(1.2, h, 0.4, [x, y0 + h / 2, sz * (d / 2 + 0.1)]), WOOD));
    for (const z of linspace(-d / 2, d / 2, nz)) for (const sx of [-1, 1]) g.push(paint(box(0.4, h, 1.2, [sx * (w / 2 + 0.1), y0 + h / 2, z]), WOOD));
    g.push(paint(box(w + 0.6, 0.9, d + 0.6, [0, y0 + h - 0.45, 0]), WOOD));
    g.push(paint(box(w + 0.6, 0.6, d + 0.6, [0, y0 + 0.3, 0]), WOOD));
  };
  posts(54, 47, 2, 12, 9, 7);
  // 正面の扉(開いていて中は暗い)
  g.push(paint(box(11, 8.5, 0.4, [0, 6.25, 23.65]), 0x2a1d14));
  for (const sx of [-1, 1]) g.push(paint(box(5, 7, 0.4, [sx * 15, 5.5, 23.65]), 0x3a2618));
  // 下層の屋根
  g.push(paint(hipRoof(31, 27.5, 4.2, 1.6, 3.5).translate(0, 14, 0), ROOF));
  // 上層
  g.push(paint(box(44, 11, 37, [0, 21.5, 0]), WALL));
  posts(44, 37, 16, 11, 7, 6);
  // 唐破風と観相窓(正面中央の金色の窓)
  g.push(paint(box(9, 4, 0.6, [0, 19.6, 18.75]), GOLD));
  g.push(paint(
    new THREE.CylinderGeometry(5.6, 5.6, 4.5, 20, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2).scale(1, 0.42, 1).translate(0, 22.6, 19.5),
    ROOF
  ));
  // 上層の屋根(寄棟、長い大棟)
  g.push(paint(hipRoof(27, 22.5, 13, 1.8, 14).translate(0, 27, 0), ROOF));
  g.push(paint(box(30, 1.6, 1.6, [0, 40.5, 0]), 0x2c2c2e));
  // 鴟尾(大棟の両端の金色の飾り)
  for (const sx of [-1, 1]) {
    g.push(paint(box(1.2, 3.4, 2.2, [sx * 15.2, 42.8, 0]), GOLD));
    g.push(paint(sphere(1, [sx * 14.8, 43.6, 0], [0.9, 2.2, 1.3], 10), GOLD));
  }
  return { parts: [{ name: 'body', geo: merge(g), pivot: [0, 0, 0] }], animate() {} };
}

/**
 * 清水寺の本堂と「清水の舞台」。本堂は斜面に半分埋め、舞台(+Z = 正面 = 谷側)は格子に組んだ
 * 長い柱(懸造り)で谷へ下ろす。両脇に翼廊の小さな屋根。
 */
function kiyomizuModel(kit) {
  const { paint, merge, box, rod } = kit;
  const WOOD = 0x7a4e32;
  const PILLAR = 0x6e4a2e;
  const ROOF = 0x5b463a; // 檜皮葺
  const g = [];
  g.push(paint(box(30, 18, 22, [0, 1, 0]), WOOD)); // 本堂(y = −8〜10)
  g.push(paint(box(30.4, 0.7, 22.4, [0, 9.6, 0]), 0x4a3020));
  g.push(paint(hipRoof(19, 14, 9.5, 1.4, 9).translate(0, 10, 0), ROOF));
  g.push(paint(gableEnds(7.8, 3.2, 15.9, 19.5), WOOD));
  g.push(paint(box(19, 0.8, 0.8, [0, 19.7, 0]), 0x3b2f28));
  // 舞台
  const stageZ = 11 + 6.5;
  g.push(paint(box(24, 0.6, 13, [0, 1.2, stageZ]), 0xb59466));
  g.push(paint(box(24, 0.18, 0.18, [0, 2.3, 24]), PILLAR));
  for (const sx of [-1, 1]) g.push(paint(box(0.18, 0.18, 13, [sx * 12, 2.3, stageZ]), PILLAR));
  for (const x of linspace(-11.6, 11.6, 9)) g.push(paint(box(0.14, 1.1, 0.14, [x, 1.95, 24]), PILLAR));
  const xs = linspace(-11.2, 11.2, 6);
  const zs = [12, 16, 20, 23.6];
  for (const x of xs) for (const z of zs) g.push(paint(rod([x, 0.9, z], [x, -32, z], 0.42, 0.42, 8), PILLAR));
  // 貫(柱をつなぐ横木)
  for (const y of [-3.5, -9, -14.5, -20, -25.5]) {
    for (const z of zs) g.push(paint(box(23.2, 0.35, 0.3, [0, y, z]), PILLAR));
    for (const x of xs) g.push(paint(box(0.3, 0.35, 12.2, [x, y, stageZ - 0.3]), PILLAR));
  }
  // 翼廊(舞台の両脇の小さな建物)
  for (const sx of [-1, 1]) {
    const x = sx * 15.5;
    g.push(paint(box(7, 9, 12, [x, 2.5, 15]), WOOD));
    g.push(paint(hipRoof(4.6, 7.2, 3.6, 0.6, 0).rotateY(Math.PI / 2).translate(x, 7, 15), ROOF));
    for (const ox of [-3, 3]) for (const oz of [9.5, 20.5]) g.push(paint(rod([x + ox, -1.5, oz], [x + ox, -32, oz], 0.4, 0.4, 8), PILLAR));
  }
  // 斜面の上でも遠くから舞台と分かるよう、実物よりやや大きめに描く
  return { parts: [{ name: 'body', geo: merge(g).scale(1.25, 1.25, 1.25), pivot: [0, 0, 0] }], animate() {} };
}

/** 奈良公園・鷺池の浮見堂(池に浮かぶ六角形のお堂と、岸へ渡る橋)。原点は池の底。正面(+Z)に橋。 */
function ukimidoModel(kit) {
  const { paint, merge, box, rod, sphere } = kit;
  const WOOD = 0x8a6a4a;
  const POST = 0x5a3e2a;
  const ROOF = 0x5b463a;
  const g = [];
  const floorY = 2.6;
  g.push(paint(new THREE.CylinderGeometry(4.2, 4.2, 0.4, 6).translate(0, floorY, 0), WOOD));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.push(paint(rod([Math.sin(a) * 3.6, -2, Math.cos(a) * 3.6], [Math.sin(a) * 3.6, floorY + 3.4, Math.cos(a) * 3.6], 0.16, 0.16, 8), POST));
  }
  g.push(paint(new THREE.CylinderGeometry(3.8, 3.8, 0.12, 6, 1, true).translate(0, floorY + 0.9, 0), POST));
  // 六角の屋根(反りをつけた低い錐)
  const roof = new THREE.ConeGeometry(5.8, 3.0, 6, 4);
  const rp = roof.attributes.position;
  for (let i = 0; i < rp.count; i++) {
    const t = (rp.getY(i) + 1.5) / 3; // 0 = 軒先、1 = 頂点
    rp.setY(i, -1.5 + 3 * Math.pow(t, 1.5));
  }
  roof.computeVertexNormals();
  g.push(paint(roof.translate(0, floorY + 3.4 + 1.5, 0), ROOF));
  g.push(paint(sphere(0.35, [0, floorY + 6.5, 0]), GOLD));
  // 岸へ渡る橋
  g.push(paint(box(2.2, 0.25, 24, [0, floorY - 0.4, 4 + 12]), WOOD));
  for (let z = 6; z <= 28; z += 4) {
    for (const sx of [-1, 1]) g.push(paint(rod([sx * 1.1, -2, z], [sx * 1.1, floorY + 0.5, z], 0.1, 0.1, 6), POST));
  }
  for (const sx of [-1, 1]) g.push(paint(box(0.1, 0.1, 24, [sx * 1.1, floorY + 0.5, 16]), POST));
  return { parts: [{ name: 'body', geo: merge(g), pivot: [0, 0, 0] }], animate() {} };
}

const VERMILION = 0xd24a2a;

/** 名所の種類からテンプレートを作る(該当しなければ null)。 */
export function sightTemplate(kind, kit) {
  switch (kind) {
    case 'pagoda':
      return pagodaModel(kit, {
        storeys: [{ w: 7.6, h: 4.8 }, { w: 6.8, h: 3.6 }, { w: 6.1, h: 3.4 }, { w: 5.4, h: 3.2 }, { w: 4.7, h: 3.0 }],
        wall: 0xece5d4, wood: 0x5c2a1a, roof: 0x3d3c3c, scale: 1.12,
      });
    case 'pagodaRed': // 新倉山浅間公園の忠霊塔(朱塗りの五重塔)
      return pagodaModel(kit, {
        storeys: [{ w: 7.0, h: 4.4 }, { w: 6.3, h: 3.4 }, { w: 5.7, h: 3.2 }, { w: 5.1, h: 3.0 }, { w: 4.5, h: 2.9 }],
        wall: 0xf1ebe0, wood: VERMILION, roof: 0x3b4442, scale: 1.0,
      });
    case 'pagoda3': // 清水寺の三重塔(朱塗り)
      return pagodaModel(kit, {
        storeys: [{ w: 7.2, h: 4.6 }, { w: 6.2, h: 3.6 }, { w: 5.2, h: 3.4 }],
        wall: 0xf1ebe0, wood: VERMILION, roof: 0x4b3b32, scale: 1.05,
      });
    case 'sanmon': // 知恩院の三門・東大寺の南大門(木地の大きな二重門)
      return gateModel(kit, { W: 30, D: 12, H: 25, post: 0x5c3d26, wall: 0x6b4a30, roof: 0x3d3e40, band: 0x7a5a3a, lowerRoof: true });
    case 'romon': // 八坂神社の西楼門・清水寺の仁王門(朱塗りの楼門)
      return gateModel(kit, { W: 12, D: 7, H: 14, post: VERMILION, wall: 0xf2efe6, roof: 0x4b3b32, band: 0xf2efe6, lowerRoof: false });
    case 'daibutsuden':
      return daibutsudenModel(kit);
    case 'kiyomizu':
      return kiyomizuModel(kit);
    case 'ukimido':
      return ukimidoModel(kit);
    default:
      return null;
  }
}
