// physicsWorker.js
// Runs entirely off the main thread.
//  1. Parses raw FTMS "Indoor Bike Data" (0x2AD2) notification bytes.
//  2. Steps a power-to-speed physics simulation using the course grade.
//  3. Broadcasts the resulting ride state back to the main thread at a fixed
//     rate, decoupled from render FPS and from the BLE notification rate.

import { gradeAtDistance, segmentAtDistance, COURSE_TOTAL_LENGTH } from "./course.js";

// ---- Physical constants (reasonable road-bike defaults) --------------------
const G = 9.81;                 // m/s^2
const CRR = 0.005;               // rolling resistance coefficient (asphalt tyres)
const CDA = 0.32;                // drag area, m^2 (rider + bike, hoods position)
const AIR_DENSITY = 1.225;       // kg/m^3, sea level
const DRIVETRAIN_EFFICIENCY = 0.975;
const MIN_SPEED_FOR_FORCE = 0.35; // m/s floor to avoid divide-by-zero at a standstill
const TICK_MS = 100;             // physics + broadcast rate (10 Hz)
const SUBSTEPS = 12;             // numerical-integration substeps per tick

// ---- Mutable simulation state ----------------------------------------------
const state = {
  riderWeightKg: 75,
  bikeWeightKg: 9,
  power: 0,        // W, last known instantaneous power
  cadence: 0,       // rpm, last known instantaneous cadence
  speed: 0,         // m/s
  distance: 0,      // m, cumulative along the course (wraps via course module)
  lastSegmentIndex: -1,
  timerId: null,
};

function totalMass() {
  return state.riderWeightKg + state.bikeWeightKg;
}

/** Advances the simulation by dtSeconds using sub-stepped forward Euler. */
function stepPhysics(dtSeconds) {
  const mass = totalMass();
  const subDt = dtSeconds / SUBSTEPS;

  for (let i = 0; i < SUBSTEPS; i++) {
    const grade = gradeAtDistance(state.distance);
    const fraction = grade / 100;
    const theta = Math.atan(fraction);

    const rollingForce = CRR * mass * G * Math.cos(theta);
    const gravityForce = mass * G * Math.sin(theta); // positive = uphill resistance, negative = assists
    const dragForce = 0.5 * AIR_DENSITY * CDA * state.speed * Math.abs(state.speed);

    const drivePower = state.power * DRIVETRAIN_EFFICIENCY;
    const effectiveSpeed = Math.max(state.speed, MIN_SPEED_FOR_FORCE);
    const driveForce = drivePower / effectiveSpeed;

    const netForce = driveForce - rollingForce - gravityForce - dragForce;
    const acceleration = netForce / mass;

    state.speed = Math.max(0, state.speed + acceleration * subDt);
    state.distance += state.speed * subDt;
  }
}

function broadcastState() {
  const { index } = segmentAtDistance(state.distance);
  const grade = gradeAtDistance(state.distance);

  postMessage({
    type: "state",
    speed: state.speed,               // m/s
    speedKmh: state.speed * 3.6,
    distance: state.distance,          // m (wraps at COURSE_TOTAL_LENGTH)
    totalLength: COURSE_TOTAL_LENGTH,
    power: state.power,
    cadence: state.cadence,
    grade,
    segmentIndex: index,
  });

  if (index !== state.lastSegmentIndex) {
    state.lastSegmentIndex = index;
    postMessage({ type: "grade-change", grade });
  }
}

let lastTick = null;
function tick() {
  const now = performance.now();
  const dt = lastTick === null ? TICK_MS / 1000 : (now - lastTick) / 1000;
  lastTick = now;
  stepPhysics(dt);
  broadcastState();
}

function startLoop() {
  if (state.timerId !== null) return;
  lastTick = null;
  state.timerId = setInterval(tick, TICK_MS);
}

// ---- FTMS Indoor Bike Data (0x2AD2) parsing --------------------------------
// Flags bit layout (little-endian uint16), per Bluetooth FTMS spec:
//  bit0 More Data (1 = inst. speed field NOT present)
//  bit1 Average Speed present
//  bit2 Instantaneous Cadence present
//  bit3 Average Cadence present
//  bit4 Total Distance present
//  bit5 Resistance Level present
//  bit6 Instantaneous Power present
//  bit7 Average Power present
//  bit8 Expended Energy present
//  bit9 Heart Rate present
//  bit10 Metabolic Equivalent present
//  bit11 Elapsed Time present
//  bit12 Remaining Time present
function parseIndoorBikeData(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const flags = view.getUint16(offset, true);
  offset += 2;

  const moreDataMeansNoSpeed = (flags & 0x0001) !== 0;
  const hasAvgSpeed = (flags & 0x0002) !== 0;
  const hasInstCadence = (flags & 0x0004) !== 0;
  const hasAvgCadence = (flags & 0x0008) !== 0;
  const hasTotalDistance = (flags & 0x0010) !== 0;
  const hasResistance = (flags & 0x0020) !== 0;
  const hasInstPower = (flags & 0x0040) !== 0;
  const hasAvgPower = (flags & 0x0080) !== 0;
  const hasExpendedEnergy = (flags & 0x0100) !== 0;
  const hasHeartRate = (flags & 0x0200) !== 0;
  const hasMetabolic = (flags & 0x0400) !== 0;
  const hasElapsedTime = (flags & 0x0800) !== 0;
  const hasRemainingTime = (flags & 0x1000) !== 0;

  let instCadence = null;
  let instPower = null;

  if (!moreDataMeansNoSpeed) offset += 2; // instantaneous speed, uint16, 0.01 km/h (unused, we simulate our own)
  if (hasAvgSpeed) offset += 2;
  if (hasInstCadence) {
    instCadence = view.getUint16(offset, true) * 0.5; // resolution 0.5 rpm
    offset += 2;
  }
  if (hasAvgCadence) offset += 2;
  if (hasTotalDistance) offset += 3; // uint24
  if (hasResistance) offset += 2;
  if (hasInstPower) {
    instPower = view.getInt16(offset, true); // signed watts
    offset += 2;
  }
  if (hasAvgPower) offset += 2;
  if (hasExpendedEnergy) offset += 5; // total(2) + per-hour(2) + per-min(1)
  if (hasHeartRate) offset += 1;
  if (hasMetabolic) offset += 1;
  if (hasElapsedTime) offset += 2;
  if (hasRemainingTime) offset += 2;

  return { power: instPower, cadence: instCadence };
}

// ---- Message handling -------------------------------------------------------
onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      state.riderWeightKg = msg.riderWeightKg;
      state.bikeWeightKg = msg.bikeWeightKg;
      startLoop();
      break;
    }
    case "ble-raw": {
      const { power, cadence } = parseIndoorBikeData(msg.buffer);
      if (power !== null) state.power = power;
      if (cadence !== null) state.cadence = cadence;
      break;
    }
    case "mock": {
      state.power = msg.power;
      state.cadence = msg.cadence;
      break;
    }
    case "force-zero": {
      state.power = 0;
      state.cadence = 0;
      break;
    }
    case "reset-distance": {
      state.distance = 0;
      state.lastSegmentIndex = -1;
      break;
    }
    default:
      break;
  }
};
