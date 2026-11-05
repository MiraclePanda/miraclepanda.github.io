// 遠景: 富士山・箱根・天城・伊豆大島・駿河湾の向こうの山並み(国土地理院の標高、約 500 m 格子)と遠くの海。
//
// 区間の景色(realRoadScene.js)より何十 km も遠くまであるので、別のシーン・別のカメラ(描画距離 300 km)で
// 先に描き、深度を消してから近くの景色を重ねる(1つのカメラで描くと奥行きの精度が足りずにちらつく)。
// 近くの景色がある所は上から塗られるので、遠景を切り抜く必要はない。空(背景)もこのシーンが持つ。
// 地球の丸みで遠くほど低く見える分は、区間の中ほどからの距離で下げておく(60 km 先の富士山で約 250 m)。

import THREE from './three.js';
import { fromLonLat, curvatureDropM } from './sceneryData.js';

const _c = new THREE.Color();

function panoramaColor(h, ny) {
  if (h > 3000) return _c.setHex(0xf4f6f8); // 富士山の冠雪
  if (h > 2300) return _c.setHex(0x8d7f73).lerp(new THREE.Color(0xf4f6f8), (h - 2300) / 700);
  if (h > 1500) return _c.setHex(0x5d6650).lerp(new THREE.Color(0x8d7f73), (h - 1500) / 800);
  if (h < 1) return _c.setHex(0xc9bb94);
  return ny < 0.75 ? _c.setHex(0x4a573e) : _c.setHex(0x3d5a30).lerp(new THREE.Color(0x6f8a4a), h < 80 ? 0.6 : 0);
}

/**
 * @param {object} pano decodePanorama の戻り値
 * @param {object} sc 区間の景色データ(座標の原点と、地球の丸みを測る中心に使う)
 */
export function createPanorama(pano, sc) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd3e6f3, 0.00002);
  const camera = new THREE.PerspectiveCamera(62, 1, 50, 300000);
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x4a5a40, 0.9);
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
  scene.add(hemi, sun);

  // 区間の中ほど(道の点の平均)。ここからの距離で地球の丸みを付ける
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < sc.route.n; k++) {
    cx += sc.route.x[k];
    cy += sc.route.y[k];
  }
  cx /= sc.route.n;
  cy /= sc.route.n;

  const { nx, ny } = pano;
  const pos = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const [x, y] = fromLonLat(sc, pano.lon0 + i * pano.step, pano.lat0 + j * pano.step);
      pos.set([x, pano.h[k] - curvatureDropM(Math.hypot(x - cx, y - cy)), -y], k * 3);
    }
  }
  const idx = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      // 4 点とも海なら面を作らない(海面の板で足りる)
      if (pano.h[a] < 0 && pano.h[a + 1] < 0 && pano.h[a + nx] < 0 && pano.h[a + nx + 1] < 0) continue;
      idx.push(a, a + 1, a + nx, a + 1, a + nx + 1, a + nx);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const nrm = g.attributes.normal.array;
  const col = new Float32Array(nx * ny * 3);
  for (let k = 0; k < nx * ny; k++) {
    const c = panoramaColor(pano.h[k], nrm[k * 3 + 1]);
    col.set([c.r, c.g, c.b], k * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const land = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
  land.frustumCulled = false;
  const seaMat = new THREE.MeshLambertMaterial({ color: 0x1d5a7a });
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(400000, 400000), seaMat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(cx, -1, -cy);
  scene.add(land, sea);

  return {
    scene,
    camera,
    /** 近くの景色のカメラに合わせる。 */
    follow(main) {
      camera.position.copy(main.position);
      camera.quaternion.copy(main.quaternion);
      if (camera.aspect !== main.aspect || camera.fov !== main.fov) {
        camera.aspect = main.aspect;
        camera.fov = main.fov;
        camera.updateProjectionMatrix();
      }
    },
    /** 天気・時刻(霧の色と濃さ、光、海の色)を近くの景色と同じにする。 */
    setAtmosphere({ fogColor, fogDensity, sunDir, sunIntensity, hemiIntensity, seaColor }) {
      scene.fog.color.copy(fogColor);
      scene.fog.density = fogDensity;
      sun.position.copy(sunDir).multiplyScalar(1000);
      sun.intensity = sunIntensity;
      hemi.intensity = hemiIntensity;
      seaMat.color.setHex(seaColor);
    },
    /** 山並みを出すか(低では出さず、空だけ描く)。 */
    setVisible(on) {
      land.visible = on;
      sea.visible = on;
    },
    dispose() {
      g.dispose();
      land.material.dispose();
      sea.geometry.dispose();
      seaMat.dispose();
    },
  };
}
