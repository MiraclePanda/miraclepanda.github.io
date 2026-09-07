import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.js";
import { COURSE, elevationAtDistance } from "./course.js";
import { FtmsClient } from "./ble.js";
import { DebugPanel } from "./debugPanel.js";
import { buildTunnel, buildCreatures, zoneColorAtDistance } from "./underwater.js";
import { AmbientAudio } from "./audio.js";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const canvas = document.getElementById("scene-canvas");
const weightDialog = document.getElementById("weight-dialog");
const weightForm = document.getElementById("weight-form");
const reconnectDialog = document.getElementById("reconnect-dialog");
const reconnectButton = document.getElementById("reconnect-button");
const connectButton = document.getElementById("connect-button");
const muteButton = document.getElementById("mute-button");
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

  ambientAudio.setIntensity(state.power);
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
// Ambient audio (starts on the same user gesture as the ride, per autoplay policy)
// ---------------------------------------------------------------------------
const ambientAudio = new AmbientAudio();
let muted = false;
muteButton.addEventListener("click", () => {
  muted = !muted;
  ambientAudio.setMuted(muted);
  muteButton.textContent = muted ? "🔇" : "🔊";
  muteButton.setAttribute("aria-pressed", String(muted));
});

// ---------------------------------------------------------------------------
// Rider setup dialog
// ---------------------------------------------------------------------------
weightDialog.showModal();
weightForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const riderWeightKg = Number(document.getElementById("rider-weight").value) || 75;
  const bikeWeightKg = Number(document.getElementById("bike-weight").value) || 9;
  const startDistanceKm = Number(document.getElementById("start-distance").value) || 0;
  const startDistanceMeters = Math.max(0, startDistanceKm) * 1000;

  worker.postMessage({ type: "init", riderWeightKg, bikeWeightKg, startDistanceMeters });
  renderState.distance = startDistanceMeters; // so the very first rendered frame is already in place
  renderState.receivedAt = performance.now();

  weightDialog.close();
  debugPanel.emitInitial();
  ambientAudio.start();
});

// ---------------------------------------------------------------------------
// Three.js scene — a fog-shrouded ring tunnel (see underwater.js). No avatar:
// the camera itself travels the course, first-person, through the tube.
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const initialFogColor = zoneColorAtDistance(renderState.distance);
scene.background = initialFogColor.clone();
scene.fog = new THREE.Fog(initialFogColor.getHex(), 12, 140);

const camera = new THREE.PerspectiveCamera(
  62,
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

// Minimal lighting: dim ambient "filtered sunlight" plus a headlamp on the
// camera so the nearest rings/creatures are never fully unlit.
const ambientLight = new THREE.AmbientLight(0x335577, 0.5);
scene.add(ambientLight);
const headlamp = new THREE.PointLight(0xbfe8ff, 1.1, 18, 2);
camera.add(headlamp);
scene.add(camera);

const { updateRingGlow } = buildTunnel(scene);
buildCreatures(scene);

// ---------------------------------------------------------------------------
// Animation loop — delta-time based so motion is independent of display FPS
// ---------------------------------------------------------------------------
let previousFrameTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - previousFrameTime) / 1000, 0.1); // clamp huge tab-switch gaps
  previousFrameTime = now;

  // Smoothly extrapolate distance between the worker's ~10Hz state updates
  // so camera motion stays fluid even at 60/120Hz displays.
  const elapsedSinceState = (now - renderState.receivedAt) / 1000;
  const visualDistance = renderState.distance + renderState.speed * elapsedSinceState;

  const elevation = elevationAtDistance(visualDistance);
  const aheadElevation = elevationAtDistance(visualDistance + 1.5);
  const pitch = Math.atan2(aheadElevation - elevation, 1.5);

  // First-person camera riding the tube's centerline, eye height above it,
  // pitching gently to match the slope ahead.
  camera.position.set(0, elevation + 1.3, -visualDistance);
  const lookTarget = new THREE.Vector3(
    0,
    elevation + 1.3 + Math.sin(pitch) * 8,
    -visualDistance - Math.cos(pitch) * 8
  );
  camera.lookAt(lookTarget);

  // Zone atmosphere follows position; the tube's glow follows effort.
  const targetFogColor = zoneColorAtDistance(visualDistance);
  scene.background.lerp(targetFogColor, Math.min(1, dt * 1.5));
  scene.fog.color.copy(scene.background);
  updateRingGlow(visualDistance, renderState.power, dt);

  renderer.render(scene, camera);
}
animate();
