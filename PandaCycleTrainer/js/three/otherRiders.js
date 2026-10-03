// 他のライダー(ゴースト・集団)の描画(CityScene / LandscapeScene が使う。上野不忍池は対象外)。
//
// 描画負荷を抑えるため、アバターは createAvatar(vehicle) の形を「マテリアルごとに1つのジオメトリ」へ
// 焼き込み、全員を InstancedMesh で描く(人数が増えても draw call は部品の数だけ):
// - 集団: 通常の見た目。ジャージだけインスタンスカラーで色を変える。影は品質「高」のときだけ落とす
// - ゴースト: 全身を半透明(opacity 0.42、depthWrite なし)の1色にし、自分の色で光らせる(emissive 0.7)。
//   影は落とさない。頭上に名前ラベル(Sprite、1.0×0.25m)。品質「低」ではラベルを出さない
// 車輪(スワンボートは外輪)は回転の中心ごとに別の InstancedMesh にし、各自の速度で回す。
// プールは初めて他のライダーが描画範囲に入ったときに作る(いなければ従来と同じシーン・同じ draw call)。
// 使っていない InstancedMesh・ラベルは visible = false にして、描画にも影にも数えない。

import THREE from './three.js';
import { createAvatar, mergeGeometries } from './sceneKit.js';
import { selectVisibleOthers, ghostLabelText, MAX_PACK, MAX_GHOSTS, LOW_QUALITY_MAX_PACK } from './otherRidersLayout.js';

const GHOST_OPACITY = 0.42;
const GHOST_EMISSIVE_INTENSITY = 0.7;
const LABEL_WIDTH_M = 1.0;
const LABEL_HEIGHT_M = 0.25;
const LABEL_ABOVE_HEAD_M = 0.35;
const LABEL_CANVAS_W = 256;
const LABEL_CANVAS_H = 64;
const FALLBACK_COLOR = 0x9aa0a6;

const _m = new THREE.Matrix4();
const _spin = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _obj = new THREE.Object3D();
_obj.rotation.order = 'YXZ'; // 道路の向き(yaw)→坂(pitch)→傾き(roll)
const _color = new THREE.Color();
const _white = new THREE.Color(0xffffff);

/**
 * アバターの形を焼き込む。メッシュをアバターのグループ基準の座標へ変換し、
 * 集団用はマテリアル(色・粗さ・金属度)ごと、ゴースト用は全部を1つに、それぞれ車輪(回転の中心)ごとに分けて結合する。
 */
function bakeAvatar(vehicle) {
  const av = createAvatar(vehicle);
  const g = av.group;
  g.position.set(0, 0, 0);
  g.rotation.set(0, 0, 0);
  g.updateMatrixWorld(true);
  const spinnerIndex = (obj) => {
    for (let o = obj; o && o !== g; o = o.parent) {
      const i = av.spinners.indexOf(o);
      if (i >= 0) return i;
    }
    return -1;
  };
  const pivots = av.spinners.map((sp) => new THREE.Vector3().setFromMatrixPosition(sp.matrixWorld));
  const byMaterial = new Map();
  const ghostGeos = { statics: [], spin: av.spinners.map(() => []) };
  let topY = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    const mat = o.material;
    const jersey = !!mat.userData.jersey;
    const key = jersey ? 'jersey' : `${mat.color.getHexString()}|${mat.roughness}|${mat.metalness}|${mat.side}`;
    let entry = byMaterial.get(key);
    if (!entry) {
      entry = { material: mat.clone(), jersey, statics: [], spin: av.spinners.map(() => []) };
      if (jersey) entry.material.color.set(0xffffff); // ジャージの色はインスタンスカラーで決める
      byMaterial.set(key, entry);
    }
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    geo.computeBoundingBox();
    topY = Math.max(topY, geo.boundingBox.max.y);
    const si = spinnerIndex(o);
    (si < 0 ? entry.statics : entry.spin[si]).push(geo);
    (si < 0 ? ghostGeos.statics : ghostGeos.spin[si]).push(geo.clone());
  });
  // 元のアバター(テンプレート)は形を取り出したら捨てる
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });

  const packParts = [];
  for (const e of byMaterial.values()) {
    if (e.statics.length) packParts.push({ geometry: mergeGeometries(e.statics), material: e.material, jersey: e.jersey, spinner: -1 });
    e.spin.forEach((list, i) => {
      if (list.length) packParts.push({ geometry: mergeGeometries(list), material: e.material, jersey: e.jersey, spinner: i });
    });
  }
  const ghostParts = [];
  if (ghostGeos.statics.length) ghostParts.push({ geometry: mergeGeometries(ghostGeos.statics), spinner: -1 });
  ghostGeos.spin.forEach((list, i) => {
    if (list.length) ghostParts.push({ geometry: mergeGeometries(list), spinner: i });
  });
  return { packParts, ghostParts, pivots, spinRadiusM: av.spinRadiusM, topY };
}

/** ゴーストの半透明マテリアル。発光色(emissive)もインスタンスカラーで各自の色にする。 */
function createGhostMaterial() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.4, transparent: true, opacity: GHOST_OPACITY, depthWrite: false,
    emissive: 0xffffff, emissiveIntensity: GHOST_EMISSIVE_INTENSITY,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  totalEmissiveRadiance *= vColor.rgb;
#endif`
    );
  };
  return material;
}

function instanced(geometry, material, max) {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  for (let i = 0; i < max; i++) mesh.setColorAt(i, _white);
  return mesh;
}

/** 名前ラベル(暗い角丸の板に白文字、左端に本人の色の帯)。文言・色が変わったときだけ描き直す。 */
function drawLabel(label, text, colorHex) {
  const key = `${text}|${colorHex}`;
  if (label.key === key) return;
  label.key = key;
  const c = label.ctx;
  const w = LABEL_CANVAS_W;
  const h = LABEL_CANVAS_H;
  c.clearRect(0, 0, w, h);
  c.fillStyle = 'rgba(12,16,24,0.72)';
  c.beginPath();
  c.roundRect(2, 2, w - 4, h - 4, 14);
  c.fill();
  c.fillStyle = `#${colorHex.toString(16).padStart(6, '0')}`;
  c.fillRect(10, 14, 8, h - 28);
  c.fillStyle = '#ffffff';
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  let size = 30;
  c.font = `bold ${size}px sans-serif`;
  while (size > 14 && c.measureText(text).width > w - 40) {
    size -= 2;
    c.font = `bold ${size}px sans-serif`;
  }
  c.fillText(text, 28, h / 2 + 1);
  label.texture.needsUpdate = true;
}

/**
 * @param {THREE.Object3D} parent アバターを入れる親(シーン、または景色の inner グループ)
 * @param {string} vehicle 'bike' | 'swan'
 * @param {THREE.Texture[]} textures シーンが破棄時に dispose するテクスチャの一覧(ラベルのテクスチャを足す)
 */
export function createOtherRiders(parent, vehicle, textures) {
  let pool = null;
  const spinById = new Map();
  const stats = { pack: 0, ghosts: 0, labels: 0 };

  function build() {
    const baked = bakeAvatar(vehicle);
    const pack = baked.packParts.map((p) => ({ ...p, mesh: instanced(p.geometry, p.material, MAX_PACK) }));
    const ghostMaterial = createGhostMaterial();
    const ghosts = baked.ghostParts.map((p) => ({ ...p, mesh: instanced(p.geometry, ghostMaterial, MAX_GHOSTS) }));
    // 透明なゴーストは不透明の集団より後に描く
    for (const p of ghosts) p.mesh.renderOrder = 1;
    const labels = [];
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = LABEL_CANVAS_W;
      canvas.height = LABEL_CANVAS_H;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
      sprite.scale.set(LABEL_WIDTH_M, LABEL_HEIGHT_M, 1);
      sprite.renderOrder = 2;
      sprite.visible = false;
      labels.push({ sprite, texture, ctx: canvas.getContext('2d'), key: null });
    }
    for (const p of [...pack, ...ghosts]) parent.add(p.mesh);
    for (const l of labels) parent.add(l.sprite);
    return { ...baked, pack, ghosts, labels };
  }

  /** 1人分のインスタンス行列を部品ごとに書く(車輪は回転の中心のまわりに spin だけ回す)。 */
  function writeInstance(parts, index, base, spin) {
    for (const part of parts) {
      if (part.spinner < 0) {
        part.mesh.setMatrixAt(index, base);
      } else {
        const p = pool.pivots[part.spinner];
        // base · T(p) · Rx(−spin) · T(−p)。前進で車輪の上端が前へ回る向き(sceneKit の updateRiderAvatar と同じ)
        _spin.makeTranslation(p.x, p.y, p.z).multiply(_tmp.makeRotationX(-spin)).multiply(_tmp.makeTranslation(-p.x, -p.y, -p.z));
        part.mesh.setMatrixAt(index, _m.multiplyMatrices(base, _spin));
      }
    }
  }

  function commit(parts, count, castShadow) {
    for (const part of parts) {
      part.mesh.count = count;
      part.mesh.visible = count > 0;
      part.mesh.castShadow = castShadow;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
  }

  function advanceSpin(id, speedMps, dt, seen) {
    const a = (spinById.get(id) ?? 0) + (Math.max(0, speedMps) / pool.spinRadiusM) * dt;
    const wrapped = a % (Math.PI * 2);
    spinById.set(id, wrapped);
    seen.add(id);
    return wrapped;
  }

  function colorHexOf(other) {
    try {
      return typeof other.color === 'string' && /^#[0-9a-f]{6}$/i.test(other.color) ? _color.set(other.color).getHex() : FALLBACK_COLOR;
    } catch {
      return FALLBACK_COLOR;
    }
  }

  return {
    /** 描画中の人数(テスト・計測用)。 */
    stats,
    /**
     * 毎フレーム呼ぶ。
     * @param {Array} others draw() の others
     * @param {number} myDistanceM
     * @param {object} opts
     * @param {(gapM:number, lateralM:number, speedMps:number, out:object) => object} opts.place
     *   自分からの距離 gapM・道路中心から右へ lateralM の地点の {x, y, z, yaw, pitch, roll}(parent の座標)を out に書く
     * @param {number} opts.dt このフレームの経過時間(s)
     * @param {number} opts.qualityIndex 品質段階(0 = 高, 1 = 中, 2 = 低)
     * @param {number} opts.riderX 自分のアバターの基準の横位置(RIDER_X_M)
     * @param {number} [opts.behindM] 後方の描画範囲(m、既定 40)。道路のない所に置かないよう、シーンの道路の後方範囲に合わせる
     */
    update(others, myDistanceM, { place, dt, qualityIndex, riderX, behindM }) {
      const low = qualityIndex >= 2;
      const sel = selectVisibleOthers(others, myDistanceM, { maxPack: low ? LOW_QUALITY_MAX_PACK : MAX_PACK, maxGhosts: MAX_GHOSTS, behindM });
      if (!pool) {
        if (sel.pack.length === 0 && sel.ghosts.length === 0) return;
        pool = build();
      }
      const seen = new Set();
      const out = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
      const placeMatrix = ({ other, gapM }) => {
        const speedMps = Math.max(0, (other.speedKmh ?? 0) / 3.6);
        place(gapM, riderX + (Number.isFinite(other.laneOffsetM) ? other.laneOffsetM : 0), speedMps, out);
        _obj.position.set(out.x, out.y, out.z);
        _obj.rotation.set(out.pitch, out.yaw, out.roll);
        _obj.updateMatrix();
        return advanceSpin(other.id, speedMps, dt, seen);
      };

      sel.pack.forEach((entry, i) => {
        const spin = placeMatrix(entry);
        writeInstance(pool.pack, i, _obj.matrix, spin);
        _color.setHex(colorHexOf(entry.other));
        for (const part of pool.pack) if (part.jersey) part.mesh.setColorAt(i, _color);
      });
      commit(pool.pack, sel.pack.length, qualityIndex === 0);

      sel.ghosts.forEach((entry, i) => {
        const spin = placeMatrix(entry);
        writeInstance(pool.ghosts, i, _obj.matrix, spin);
        const hex = colorHexOf(entry.other);
        _color.setHex(hex);
        for (const part of pool.ghosts) part.mesh.setColorAt(i, _color);
        const label = pool.labels[i];
        label.sprite.visible = !low;
        if (!low) {
          drawLabel(label, ghostLabelText(entry.other), hex);
          label.sprite.position.set(out.x, out.y + pool.topY + LABEL_ABOVE_HEAD_M, out.z);
        }
      });
      commit(pool.ghosts, sel.ghosts.length, false);
      for (let i = sel.ghosts.length; i < pool.labels.length; i++) pool.labels[i].sprite.visible = false;

      for (const id of spinById.keys()) if (!seen.has(id)) spinById.delete(id);
      stats.pack = sel.pack.length;
      stats.ghosts = sel.ghosts.length;
      stats.labels = low ? 0 : sel.ghosts.length;
    },
  };
}
