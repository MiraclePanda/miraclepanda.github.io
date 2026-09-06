import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.js";
import {
  COURSE,
  COURSE_TOTAL_LENGTH,
  elevationAtDistance,
  gradeAtDistance,
} from "./course.js";
import { FtmsClient } from "./ble.js";
import { DebugPanel } from "./debugPanel.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene-canvas");
const weightDialog = document.getElementById("weight-dialog");
const weightForm = document.getElementById("weight-form");
const reconnectDialog = document.getElementById("reconnect-dialog");
const reconnectButton = document.getElementById("reconnect-button");
const connectButton = document.getElementById("connect-button");
const statusPill = document.getElementById("status-pill");
const hud = {
  speed: document.getElementById("hud-speed"),
  power: document.getElementById("hud-power"),
  cadence: document.getElementById("hud-cadence"),
  grade: document.getElementById("hud-grade"),
  gradeFill: document.getElementById("grade-fill"),
  distance: document.getElementById("hud-distance"),
  progressFill: document.getElementById("progress-fill"),
  courseName: document.getElementById("course-name"),
};

hud.courseName.textContent = COURSE.name;

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
const worker = new Worker(new URL("./physicsWorker.js", import.meta.url), {
  type: "module",
});

const renderState = {
  distance: 0,
  speed: 0,
  power: 0,
  cadence: 0,
  grade: 0,
  segmentIndex: -1,
  receivedAt: performance.now(),
};

worker.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "state") {
    renderState.distance = msg.distance;
    renderState.speed = msg.speed;
    renderState.power = msg.power;
    renderState.cadence = msg.cadence;
    renderState.grade = msg.grade;
    renderState.segmentIndex = msg.segmentIndex;
    renderState.receivedAt = performance.now();
    updateHud(msg);
  } else if (msg.type === "grade-change") {
    if (ftms.isConnected) {
      ftms.setSimulationGrade(msg.grade);
    }
  }
};

function updateHud(state) {
  hud.speed.textContent = state.speedKmh.toFixed(1);
  hud.power.textContent = Math.round(state.power);
  hud.cadence.textContent = Math.round(state.cadence);
  const gradeText = (state.grade > 0 ? "+" : "") + state.grade.toFixed(1);
  hud.grade.textContent = `${gradeText}%`;

  // Grade bar: map -12%..+12% to a 0..100% fill, clamped.
  const clamped = Math.max(-12, Math.min(12, state.grade));
  const fillPct = ((clamped + 12) / 24) * 100;
  hud.gradeFill.style.height = `${fillPct}%`;
  hud.gradeFill.classList.toggle("descending", state.grade < 0);

  const lapDistance = state.distance % state.totalLength;
  hud.distance.textContent = `${(lapDistance / 1000).toFixed(2)} km`;
  hud.progressFill.style.width = `${(lapDistance / state.totalLength) * 100}%`;
}

// ---------------------------------------------------------------------------
// Debug (mock sensor) panel
// ---------------------------------------------------------------------------
const debugPanel = new DebugPanel({
  container: document.body,
  onChange: ({ power, cadence }) => {
    worker.postMessage({ type: "mock", power, cadence });
    lastDataAt = performance.now();
  },
});

// ---------------------------------------------------------------------------
// BLE (FTMS) wiring — main thread only, see ble.js for why
// ---------------------------------------------------------------------------
let lastDataAt = performance.now();
let connectionEverEstablished = false;

const ftms = new FtmsClient({
  onRawIndoorBikeData: (buffer) => {
    lastDataAt = performance.now();
    worker.postMessage({ type: "ble-raw", buffer }, [buffer]);
  },
  onDisconnected: () => {
    setStatus("lost");
  },
  onLog: (message) => console.log("[FTMS]", message),
});

async function attemptConnect() {
  try {
    setStatus("connecting");
    const name = await ftms.connect();
    connectionEverEstablished = true;
    lastDataAt = performance.now();
    setStatus("connected", name);
    reconnectDialog.close();
    // Push the rider's current grade immediately so resistance matches
    // the course right away instead of waiting for the next segment change.
    ftms.setSimulationGrade(renderState.grade);
  } catch (err) {
    console.error(err);
    setStatus(connectionEverEstablished ? "lost" : "idle");
  }
}

connectButton.addEventListener("click", attemptConnect);
reconnectButton.addEventListener("click", attemptConnect);

function setStatus(kind, name) {
  statusPill.dataset.state = kind;
  switch (kind) {
    case "idle":
      statusPill.textContent = "Trainer not connected";
      break;
    case "connecting":
      statusPill.textContent = "Connecting...";
      break;
    case "connected":
      statusPill.textContent = `Connected — ${name}`;
      break;
    case "lost":
      statusPill.textContent = "Connection lost";
      if (!reconnectDialog.open) reconnectDialog.showModal();
      worker.postMessage({ type: "force-zero" });
      break;
    default:
      break;
  }
}
setStatus("idle");

// Watchdog: if no data arrives for 3s while a trainer has connected at least
// once, treat it as a dropped connection — force the simulated power to 0
// and prompt the rider to reconnect.
setInterval(() => {
  if (!connectionEverEstablished) return;
  if (!ftms.isConnected) return; // gattserverdisconnected already handles this path
  const silentFor = performance.now() - lastDataAt;
  if (silentFor > 3000 && statusPill.dataset.state !== "lost") {
    setStatus("lost");
  }
}, 500);

// ---------------------------------------------------------------------------
// Rider setup dialog
// ---------------------------------------------------------------------------
weightDialog.showModal();
weightForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const riderWeightKg = Number(document.getElementById("rider-weight").value) || 75;
  const bikeWeightKg = Number(document.getElementById("bike-weight").value) || 9;
  worker.postMessage({ type: "init", riderWeightKg, bikeWeightKg });
  weightDialog.close();
  debugPanel.emitInitial();
});

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e11);
scene.fog = new THREE.Fog(0x0b0e11, 40, 220);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  500
);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Lighting: a cool, low-angle "early morning" key light plus soft fill.
const hemiLight = new THREE.HemisphereLight(0x8fb8c9, 0x11151a, 0.9);
scene.add(hemiLight);
const sunLight = new THREE.DirectionalLight(0xfff2d6, 1.1);
sunLight.position.set(-30, 40, -20);
scene.add(sunLight);

// Ground: a broad, understated plane so the road doesn't float in the void.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.MeshStandardMaterial({ color: 0x11161a, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05;
scene.add(ground);

// ---- Road ribbon, built from the course profile -----------------------
function buildRoad() {
  const sampleStep = 4; // meters between cross-sections
  const roadHalfWidth = 3;
  const samples = Math.ceil(COURSE_TOTAL_LENGTH / sampleStep) + 1;

  const positions = [];
  const colors = [];
  const indices = [];

  const uphillColor = new THREE.Color(0xff6b57);
  const flatColor = new THREE.Color(0x2a333a);
  const downhillColor = new THREE.Color(0x5eead4);

  for (let i = 0; i < samples; i++) {
    const d = Math.min(i * sampleStep, COURSE_TOTAL_LENGTH);
    const elevation = elevationAtDistance(d);
    const grade = gradeAtDistance(d);

    let color;
    if (grade > 0.5) {
      color = flatColor.clone().lerp(uphillColor, Math.min(grade / 10, 1));
    } else if (grade < -0.5) {
      color = flatColor.clone().lerp(downhillColor, Math.min(-grade / 10, 1));
    } else {
      color = flatColor;
    }

    positions.push(-roadHalfWidth, elevation, -d);
    positions.push(roadHalfWidth, elevation, -d);
    colors.push(color.r, color.g, color.b);
    colors.push(color.r, color.g, color.b);

    if (i < samples - 1) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = i * 2 + 2;
      const dIdx = i * 2 + 3;
      indices.push(a, c, b, b, c, dIdx);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
  });
  return new THREE.Mesh(geometry, material);
}

const road = buildRoad();
scene.add(road);

// ---- Avatar: a simple procedural rider so the app has no external asset
// dependencies. Crank rotates in sync with live cadence. --------------------
function buildAvatar() {
  const group = new THREE.Group();

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x5eead4, roughness: 0.4 });
  const riderMat = new THREE.MeshStandardMaterial({ color: 0xe9eef1, roughness: 0.6 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.8 });

  const wheelGeo = new THREE.TorusGeometry(0.35, 0.045, 10, 24);
  const frontWheel = new THREE.Mesh(wheelGeo, wheelMat);
  frontWheel.rotation.y = Math.PI / 2;
  frontWheel.position.set(0, 0.35, -0.55);
  const rearWheel = frontWheel.clone();
  rearWheel.position.set(0, 0.35, 0.55);
  group.add(frontWheel, rearWheel);

  const frameBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 1.1),
    frameMat
  );
  frameBar.position.set(0, 0.5, 0);
  group.add(frameBar);

  const seatPost = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.35, 0.04), frameMat);
  seatPost.position.set(0, 0.68, 0.4);
  group.add(seatPost);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.5, 4, 8), riderMat);
  torso.position.set(0, 1.05, 0.25);
  torso.rotation.x = Math.PI / 2.6;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), riderMat);
  head.position.set(0, 1.35, -0.15);
  group.add(head);

  // Crank + pedals live in their own group so we can rotate just this part.
  const crankGroup = new THREE.Group();
  crankGroup.position.set(0, 0.35, 0.1);
  const crankMat = new THREE.MeshStandardMaterial({ color: 0xf2c94c, roughness: 0.5 });
  const pedalGeo = new THREE.BoxGeometry(0.08, 0.03, 0.14);
  const armGeo = new THREE.BoxGeometry(0.03, 0.18, 0.03);

  const armA = new THREE.Mesh(armGeo, crankMat);
  armA.position.set(0, 0.09, 0);
  const pedalA = new THREE.Mesh(pedalGeo, crankMat);
  pedalA.position.set(0, 0.18, 0);
  const legA = new THREE.Group();
  legA.add(armA, pedalA);
  crankGroup.add(legA);

  const legB = legA.clone();
  legB.rotation.z = Math.PI;
  crankGroup.add(legB);

  group.add(crankGroup);

  return { group, crankGroup };
}

const { group: avatar, crankGroup } = buildAvatar();
scene.add(avatar);

// ---------------------------------------------------------------------------
// Animation loop — delta-time based so motion is independent of display FPS
// ---------------------------------------------------------------------------
let crankAngle = 0;
let previousFrameTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - previousFrameTime) / 1000, 0.1); // clamp huge tab-switch gaps
  previousFrameTime = now;

  // Smoothly extrapolate distance between the worker's ~10Hz state updates
  // so avatar motion stays fluid even at 60/120Hz displays.
  const elapsedSinceState = (now - renderState.receivedAt) / 1000;
  const visualDistance = renderState.distance + renderState.speed * elapsedSinceState;

  const elevation = elevationAtDistance(visualDistance);
  avatar.position.set(0, elevation, -visualDistance);

  // Orient the avatar to face the local slope direction.
  const lookAheadElevation = elevationAtDistance(visualDistance + 1);
  const pitch = Math.atan2(lookAheadElevation - elevation, 1);
  avatar.rotation.x = -pitch;

  // Crank rotation follows live cadence (rpm -> radians/sec).
  const radiansPerSecond = (renderState.cadence / 60) * 2 * Math.PI;
  crankAngle += radiansPerSecond * dt;
  crankGroup.rotation.x = crankAngle;

  // Chase camera: smoothed follow + slight pitch with the road grade.
  const camDistance = 4.2;
  const camHeight = 1.7;
  const desiredCamPos = new THREE.Vector3(
    avatar.position.x + 1.6,
    elevation + camHeight,
    avatar.position.z + camDistance
  );
  const followStrength = 1 - Math.pow(0.001, dt); // frame-rate independent smoothing
  camera.position.lerp(desiredCamPos, followStrength);
  camera.lookAt(avatar.position.x, elevation + 1.0, avatar.position.z - 3);

  renderer.render(scene, camera);
}
animate();
