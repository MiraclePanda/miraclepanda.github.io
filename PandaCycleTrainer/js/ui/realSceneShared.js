// 実在の座標に組んだ景色(熱海 AtamiScene・実在の街 RealTownScene)で共通の、道路上の位置の計算・
// ライダー/他のライダー/ハプニングの配置・カメラ。st は各シーンの状態で、route(atamiRealLayout.js の
// createAtamiRoute)・heightAt・sidewalkM・groundFloor(地面の高さの下限: 熱海は海面 0)を持つ。

import { curvatureAtM } from '../three/routeLayout.js';
import { RIDER_X_M, updateRiderAvatar, setCameraFov, setAvatarVisible } from '../three/sceneKit.js';
import {
  riderRollRad, fpCameraRollRad, estimateCadenceRpm, fpBobM, fpFovDeg, CHASE_FOV_DEG,
} from '../three/cameraViews.js';
import { yawFromDir } from '../three/atamiRealLayout.js';

// 車線: 車道の左端からこの距離(m)を走る(左側通行)
const LANE_FROM_EDGE_M = 1.6;
// ハプニング・名所の配置は、半幅 NOMINAL_HALF_WIDTH_M の道路を前提にした横距離で来る
export const NOMINAL_HALF_WIDTH_M = 3.5;
export const OTHERS_BEHIND_M = 60;

const CAM_BACK_M = 6.5;
const CAM_HEIGHT_M = 3.2;
const CAM_LOOKAHEAD_M = 26;
const CAM_LOOKAHEAD_HEIGHT_M = 1.2;
const FP_FORWARD_M = 0.25;
const FP_LOOKAHEAD_M = 20;
const FP_LOOK_HEIGHT_M = 1.25;
const CINE_ROADSIDE_MIN_M = 0.2;
const CINE_ROADSIDE_SPREAD_M = 0.4;
const CINE_HELI_BACK_M = 16;
const CINE_HELI_LATERAL_M = 12;
const CINE_HELI_CLEARANCE_M = 4;
const CINE_LOOK_HEIGHT_M = 1.0;


/** 1周の中の位置 s での車道の半幅(m)。 */
export function halfWidthAt(st, s) {
  return st.route.place(s, 0, _p).hw;
}

const _p = {};

/** 他のライダー・自分の横位置: RIDER_X_M 基準の横距離を、実際の道幅の左車線へずらす。 */
export function riderLateral(st, s, lateralM) {
  return lateralM + (-(halfWidthAt(st, s) - LANE_FROM_EDGE_M) - RIDER_X_M);
}

/** ハプニング・名所の横距離(半幅 3.5m の道路基準)を、実際の道幅に合わせて外へずらす。 */
export function actorLateral(st, s, lateralM) {
  const extra = halfWidthAt(st, s) - NOMINAL_HALF_WIDTH_M;
  return Math.abs(lateralM) > 0.5 ? lateralM + Math.sign(lateralM) * extra : lateralM;
}

/** 道路上の地点(1周の中の位置 s、横距離 d)を other/actor の place の形(シーン座標と向き)で返す。 */
export function placeOnRoad(st, s, d, out) {
  const q = st.route.place(s, d, _p);
  out.x = q.x;
  out.y = q.z;
  out.z = -q.y;
  out.yaw = yawFromDir(q.fx, q.fy);
  out.pitch = pitchAt(st, s);
  out.roll = 0;
  return out;
}

export function pitchAt(st, s) {
  const a = st.route.place(s - 1.5, 0, _pa).z;
  const b = st.route.place(s + 1.5, 0, _pb).z;
  return Math.atan((b - a) / 3);
}
const _pa = {};
const _pb = {};

/** 道路上の地点 (s, d) の地面の、路面からの高さ(歩道 0.15m、それより外は地形。st.groundFloor より下はその高さ)。 */
export function groundAboveRoadM(st, s, d) {
  const q = st.route.place(s, d, _p);
  const roadZ = q.z;
  if (Math.abs(d) <= q.hw) return 0;
  if (Math.abs(d) <= q.hw + st.sidewalkM) return 0.15;
  const g = st.heightAt(q.x, q.y);
  return (st.groundFloor ? st.groundFloor(q.x, q.y, g) : g) - roadZ;
}

/** 道路上の地点(1周の中の位置 s・横距離 d・路面からの高さ)のシーン座標。 */
export function worldPoint(st, s, d, heightM) {
  const q = st.route.place(s, d, _p);
  return [q.x, q.z + heightM, -q.y];
}

// ---- 毎フレーム ----

// ---- 毎フレーム ----

/**
 * 1フレーム分のライダー・影の範囲・他のライダー・ハプニング・カメラを動かす(描画はしない)。
 * @param {number} dist 走行距離(m)
 */
export function updateRide(st, dist, speedKmh, cadenceRpm, others, myLaneM, actors) {
  const riderX = riderLateral(st, dist, RIDER_X_M + myLaneM);
  const pos = worldPoint(st, dist, riderX, 0);
  st.rider.group.position.set(pos[0], pos[1], pos[2]);
  st.rider.group.rotation.y = yawFromDir(_p.fx, _p.fy);
  const k = curvatureAtM(st.profile.curve, st.loopM, ((dist % st.loopM) + st.loopM) % st.loopM);
  const roll = riderRollRad(k, speedKmh / 3.6);
  updateRiderAvatar(st.rider, st.clock, speedKmh, pitchAt(st, dist), roll);

  // 影はライダーの周りだけ描けばよいので、影カメラごとライダーに付いていく
  st.sunLight.target.position.set(pos[0], pos[1], pos[2]);
  st.sunLight.position.set(pos[0], pos[1], pos[2]).addScaledVector(st.env.sunDir, 220);

  st.others.update(others, dist, {
    dt: st.rider.dt ?? 0,
    qualityIndex: st.qualityIndex ?? 0,
    riderX: RIDER_X_M,
    behindM: OTHERS_BEHIND_M,
    place(gapM, lateralM, speedMps, out) {
      const s = dist + gapM;
      placeOnRoad(st, s, riderLateral(st, s, lateralM), out);
      out.roll = riderRollRad(curvatureAtM(st.profile.curve, st.loopM, ((s % st.loopM) + st.loopM) % st.loopM), speedMps);
      return out;
    },
  });
  const { pack, ghosts, labels } = st.others.stats;
  const tag = `${pack}/${ghosts}/${labels}`;
  if (st.canvas.dataset.others !== tag) st.canvas.dataset.others = tag;

  st.actorDist = dist;
  st.actors.update(actors, dist, {
    place: st.actorPlace,
    groundAboveRoadM: st.actorGround,
    roadHalfWidthM: NOMINAL_HALF_WIDTH_M,
    dt: st.rider.dt ?? 0,
    qualityIndex: st.qualityIndex ?? 0,
    behindM: OTHERS_BEHIND_M,
  });
  const atag = String(st.actors.stats.count);
  if (st.canvas.dataset.actors !== atag) st.canvas.dataset.actors = atag;

  updateCamera(st, dist, { speedKmh, cadenceRpm, roll, riderX });
}

// 正面を見るカメラに切り替える(TURN_CAMERA_NEAR_M 以内は完全に、TURN_CAMERA_FAR_M までで元に戻す)
const TURN_CAMERA_NEAR_M = 14;
const TURN_CAMERA_FAR_M = 45;

function turnCameraWeight(st, dist) {
  const d = st.route.turnDistanceM(dist);
  const k = Math.min(1, Math.max(0, (TURN_CAMERA_FAR_M - d) / (TURN_CAMERA_FAR_M - TURN_CAMERA_NEAR_M)));
  return k * k * (3 - 2 * k);
}

/** ライダーの位置から、ライダーの向きに沿って前へ ahead・右へ side・高さ up の点(シーン座標)。 */
function headingPoint(st, dist, riderX, ahead, side, up) {
  const q = st.route.place(dist, riderX, _p);
  const x = q.x + q.fx * ahead + q.fy * side;
  const y = q.y + q.fy * ahead - q.fx * side;
  return [x, q.z + up, -y];
}

function mix(a, b, w) {
  return w <= 0 ? a : [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
}

export function updateCamera(st, dist, { speedKmh, cadenceRpm, roll, riderX }) {
  const { view } = st.cam;
  setAvatarVisible(st.rider, view !== 'fp');
  const w = turnCameraWeight(st, dist);
  if (view === 'fp') {
    const bob = fpBobM(st.cam, cadenceRpm ?? estimateCadenceRpm(speedKmh), st.rider.dt ?? 0);
    const eyeUp = st.rider.camera.eyeM + bob;
    const eye = mix(worldPoint(st, dist + FP_FORWARD_M, riderX, eyeUp), headingPoint(st, dist, riderX, FP_FORWARD_M, 0, eyeUp), w);
    st.camera.position.set(eye[0], eye[1], eye[2]);
    const look = mix(worldPoint(st, dist + FP_LOOKAHEAD_M, riderX, FP_LOOK_HEIGHT_M), headingPoint(st, dist, riderX, FP_LOOKAHEAD_M, 0, FP_LOOK_HEIGHT_M), w);
    st.camera.lookAt(look[0], look[1], look[2]);
    st.camera.rotateZ(fpCameraRollRad(roll));
    setCameraFov(st.camera, fpFovDeg(speedKmh / 3.6));
    return;
  }
  if (view === 'cine') {
    updateCineCamera(st, dist, riderX);
    return;
  }
  setCameraFov(st.camera, CHASE_FOV_DEG);
  const { sideM, raiseM, backM } = st.rider.camera;
  const back = CAM_BACK_M + backM;
  const up = CAM_HEIGHT_M + raiseM;
  const cam = mix(worldPoint(st, dist - back, riderX + 0.4 + sideM, up), headingPoint(st, dist, riderX, -back, 0.4 + sideM, up), w);
  // 坂の途中でカメラが地面に埋まらないよう、地形より上に置く
  const groundY = st.heightAt(cam[0], -cam[2]);
  cam[1] = Math.max(cam[1], groundY + 1.5);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const look = mix(
    worldPoint(st, dist + CAM_LOOKAHEAD_M, riderX - 0.8, CAM_LOOKAHEAD_HEIGHT_M),
    headingPoint(st, dist, riderX, CAM_LOOKAHEAD_M, -0.8, CAM_LOOKAHEAD_HEIGHT_M),
    w
  );
  st.camera.lookAt(look[0], look[1], look[2]);
}

/** cine 視点: 沿道の固定カメラ(海側の歩道の上)とヘリ視点から、ライダーを追って映す。 */
function updateCineCamera(st, dist, riderX) {
  const shot = st.cam.director.update(performance.now() / 1000, dist);
  let s;
  let d;
  let up;
  if (shot.type === 'heli') {
    s = dist - CINE_HELI_BACK_M;
    d = riderX + shot.side * CINE_HELI_LATERAL_M;
    up = Math.max(shot.heightM, groundAboveRoadM(st, s, d) + CINE_HELI_CLEARANCE_M);
  } else {
    s = shot.s;
    d = -(halfWidthAt(st, s) + CINE_ROADSIDE_MIN_M + shot.lateralU * CINE_ROADSIDE_SPREAD_M);
    up = Math.max(0, groundAboveRoadM(st, s, d)) + shot.heightM;
  }
  const cam = worldPoint(st, s, d, up);
  st.camera.position.set(cam[0], cam[1], cam[2]);
  const look = worldPoint(st, dist, riderX, CINE_LOOK_HEIGHT_M);
  st.camera.lookAt(look[0], look[1], look[2]);
  setCameraFov(st.camera, shot.fovDeg);
  st.canvas.dataset.cineShot = `${shot.index}:${shot.type}`;
}

// ---- 最高(実験)と出典 ----
