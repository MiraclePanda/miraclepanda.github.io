// underwater.js
// Lightweight "underwater light tunnel" rendering, per the low-spec-friendly
// design brief: no water shader, no avatar — just a fog-shrouded corridor of
// low-poly rings whose color reacts to effort, plus a handful of billboard
// creatures that change with the zone. Everything here is presentational;
// none of it feeds back into the physics/course model in course.js.

import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.js";
import { COURSE_TOTAL_LENGTH, elevationAtDistance } from "./course.js";

// ---- Zone palette (position-based: sets the ambient water color/fog) ------
const ZONES = [
  { name: "reef", color: new THREE.Color(0x1f7a9e) },   // shallow reef, bright blue
  { name: "wreck", color: new THREE.Color(0x060c1c) },  // deep sea / shipwreck, near-black blue
  { name: "volcano", color: new THREE.Color(0x220a06) }, // hydrothermal zone, dark red-orange
];
const ZONE_BLEND_METERS = 300; // crossfade width at zone boundaries

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Which zone index a given lap-distance falls in, plus blend to the next. */
function zoneBlendAtDistance(lapDistance) {
  const third = COURSE_TOTAL_LENGTH / 3;
  const boundaries = [third, third * 2, COURSE_TOTAL_LENGTH];
  for (let i = 0; i < 3; i++) {
    const start = i === 0 ? 0 : boundaries[i - 1];
    const end = boundaries[i];
    if (lapDistance >= start && lapDistance < end) {
      const distToEnd = end - lapDistance;
      if (distToEnd < ZONE_BLEND_METERS && i < 2) {
        const t = smoothstep(ZONE_BLEND_METERS, 0, distToEnd);
        return { color: ZONES[i].color.clone().lerp(ZONES[i + 1].color, t) };
      }
      return { color: ZONES[i].color.clone() };
    }
  }
  return { color: ZONES[2].color.clone() };
}

/** Ambient water/fog color at an absolute course distance (wraps per lap). */
export function zoneColorAtDistance(distanceMeters) {
  let d = distanceMeters % COURSE_TOTAL_LENGTH;
  if (d < 0) d += COURSE_TOTAL_LENGTH;
  return zoneBlendAtDistance(d).color;
}

/** Which zone (0=reef,1=wreck,2=volcano) an absolute distance belongs to. */
function zoneIndexAtDistance(distanceMeters) {
  let d = distanceMeters % COURSE_TOTAL_LENGTH;
  if (d < 0) d += COURSE_TOTAL_LENGTH;
  const third = COURSE_TOTAL_LENGTH / 3;
  if (d < third) return 0;
  if (d < third * 2) return 1;
  return 2;
}

// ---- Power-reactive light gimmick (effort-based, independent of position) -
const POWER_STOPS = [
  { power: 0, color: new THREE.Color(0x123a7a), waveSpeed: 0.4, amplitude: 0.15 },   // recovery: deep blue, slow pulse
  { power: 150, color: new THREE.Color(0x1fd3a0), waveSpeed: 1.2, amplitude: 0.35 }, // cruise: emerald, flowing light
  { power: 300, color: new THREE.Color(0xd6b8ff), waveSpeed: 2.6, amplitude: 0.6 },  // sprint: violet-white, fast flare
];

function powerZoneParams(power) {
  const p = Math.max(0, power);
  if (p <= POWER_STOPS[1].power) {
    const t = p / POWER_STOPS[1].power;
    return lerpStops(POWER_STOPS[0], POWER_STOPS[1], t);
  }
  const t = Math.min(1, (p - POWER_STOPS[1].power) / (POWER_STOPS[2].power - POWER_STOPS[1].power));
  return lerpStops(POWER_STOPS[1], POWER_STOPS[2], t);
}
function lerpStops(a, b, t) {
  return {
    color: a.color.clone().lerp(b.color, t),
    waveSpeed: a.waveSpeed + (b.waveSpeed - a.waveSpeed) * t,
    amplitude: a.amplitude + (b.amplitude - a.amplitude) * t,
  };
}

// ---- Ring tunnel -------------------------------------------------------
const RING_SPACING = 8; // meters between rings
const TOTAL_RINGS = Math.ceil(COURSE_TOTAL_LENGTH / RING_SPACING);
const VISIBLE_WINDOW = 26; // rings updated per frame on either side of the rider

/**
 * Builds the ring tunnel as a single InstancedMesh (one draw call for the
 * whole 6km course — this is the main "keep it light" trick from the brief).
 */
export function buildTunnel(scene) {
  const ringGeometry = new THREE.TorusGeometry(2.6, 0.06, 5, 10); // low-poly: pentagon cross-section, decagon ring
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const mesh = new THREE.InstancedMesh(ringGeometry, ringMaterial, TOTAL_RINGS);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(TOTAL_RINGS * 3),
    3
  );

  const dummy = new THREE.Object3D();
  const forward = new THREE.Vector3();
  const dimColor = new THREE.Color(0x0a1830);

  for (let i = 0; i < TOTAL_RINGS; i++) {
    const d = i * RING_SPACING;
    const y = elevationAtDistance(d);
    const slope =
      (elevationAtDistance(d + 0.5) - elevationAtDistance(d - 0.5)) / 1.0;
    forward.set(0, slope, -1).normalize();

    dummy.position.set(0, y, -d);
    dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), forward);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, dimColor);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;

  scene.add(mesh);

  let elapsed = 0;

  /** Call every animation frame with the rider's current distance/power/dt. */
  function updateRingGlow(currentDistance, power, dt) {
    elapsed += dt;
    const { color: glowColor, waveSpeed, amplitude } = powerZoneParams(power);
    const centerIndex = Math.round(currentDistance / RING_SPACING);

    for (let offset = -VISIBLE_WINDOW; offset <= VISIBLE_WINDOW; offset++) {
      let idx = (centerIndex + offset) % TOTAL_RINGS;
      if (idx < 0) idx += TOTAL_RINGS;
      const ringDistance = idx * RING_SPACING;
      const phase = ringDistance * 0.05 - elapsed * waveSpeed;
      const brightness = 0.55 + amplitude * (0.5 + 0.5 * Math.sin(phase));
      mesh.setColorAt(idx, glowColor.clone().multiplyScalar(brightness));
    }
    mesh.instanceColor.needsUpdate = true;
  }

  return { mesh, updateRingGlow, ringSpacing: RING_SPACING };
}

// ---- Billboard creatures (always face the camera via THREE.Sprite) --------
function makeCanvasTexture(draw) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  draw(ctx, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function fishTexture(hex) {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.ellipse(s * 0.42, s * 0.5, s * 0.3, s * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(s * 0.14, s * 0.5);
    ctx.lineTo(s * 0.02, s * 0.36);
    ctx.lineTo(s * 0.02, s * 0.64);
    ctx.closePath();
    ctx.fill();
  });
}

function jellyTexture(hex) {
  return makeCanvasTexture((ctx, s) => {
    ctx.fillStyle = hex;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.38, s * 0.26, Math.PI, 0);
    ctx.fill();
    ctx.strokeStyle = hex;
    ctx.lineWidth = s * 0.02;
    for (let i = 0; i < 5; i++) {
      const x = s * (0.3 + i * 0.1);
      ctx.beginPath();
      ctx.moveTo(x, s * 0.4);
      ctx.quadraticCurveTo(x + s * 0.03, s * 0.65, x, s * 0.9);
      ctx.stroke();
    }
  });
}

function glowTexture(hex) {
  return makeCanvasTexture((ctx, s) => {
    const gradient = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gradient.addColorStop(0, hex);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, s, s);
  });
}

const ZONE_CREATURE_RECIPES = [
  { build: () => fishTexture("#7fd8ff"), scale: 0.9, count: 14 },  // reef
  { build: () => jellyTexture("#8be9ff"), scale: 1.1, count: 10 }, // wreck
  { build: () => glowTexture("#ff8a4c"), scale: 1.6, count: 12 },  // volcano
];

/** Scatters zone-appropriate billboard creatures once at startup (static). */
export function buildCreatures(scene) {
  const third = COURSE_TOTAL_LENGTH / 3;
  const ranges = [
    [0, third],
    [third, third * 2],
    [third * 2, COURSE_TOTAL_LENGTH],
  ];

  ranges.forEach(([start, end], zoneIndex) => {
    const recipe = ZONE_CREATURE_RECIPES[zoneIndex];
    const texture = recipe.build();
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    for (let i = 0; i < recipe.count; i++) {
      const sprite = new THREE.Sprite(material);
      const d = start + Math.random() * (end - start);
      const angle = Math.random() * Math.PI * 2;
      const radius = 1.4 + Math.random() * 1.6;
      const y = elevationAtDistance(d) + Math.sin(angle) * radius + 1.2;
      const x = Math.cos(angle) * radius;
      const scale = recipe.scale * (0.7 + Math.random() * 0.6);
      sprite.position.set(x, y, -d);
      sprite.scale.set(scale, scale, scale);
      scene.add(sprite);
    }
  });
}

export { zoneIndexAtDistance };
