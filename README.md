# Kestrel Ridge — Smart Trainer Ride

A browser-based indoor cycling app: connects directly to a smart trainer over
Bluetooth LE using FTMS, drives a Three.js 3D rider along a course, and pushes
the course's grade back to the trainer so its resistance matches the terrain.

## Running it

Web Bluetooth requires a secure context (HTTPS or `localhost`) and ES module
imports don't work over `file://`, so serve the folder instead of double-clicking
`index.html`. Any static server works, for example:

```bash
cd ftms-rider
python3 -m http.server 8080
# then open http://localhost:8080 in Chrome or Edge
```

Web Bluetooth is currently supported in Chrome and Edge (desktop and Android),
not in Safari or Firefox. On first load you'll be asked for rider weight, bike weight, and a start
distance, then you can either click **Connect trainer** to pair a real FTMS
device, or press **D** to open the debug panel and ride with mock power/cadence
values (sliders or arrow keys) — useful for developing without hardware nearby.

## Architecture

```
index.html          UI shell: canvas, HUD, dialogs
style.css            All styling
src/main.js          Three.js scene, render loop, UI wiring (main thread)
src/ble.js           Web Bluetooth / FTMS GATT client (main thread only —
                      Web Bluetooth is not exposed inside Web Workers)
src/physicsWorker.js Web Worker: parses raw FTMS bytes + runs the
                      power-to-speed physics simulation, off the main thread
src/course.js         Distance-based course data (length + grade per segment),
                      shared by the tunnel-building code and the physics worker
src/underwater.js     Low-poly ring-tunnel rendering + zone fog/creatures
                      (presentation only — doesn't feed back into physics)
src/audio.js          Synthesized ambient underwater sound (Web Audio API,
                      no external audio files)
src/debugPanel.js     Mock power/cadence generator for development
```

**Why BLE parsing is in the worker but the GATT connection isn't:** the
`navigator.bluetooth` API only exists on the main thread — there's no
`WorkerNavigator.bluetooth`. So `ble.js` does the minimum possible on the main
thread (open the connection, hand each notification's raw bytes to the worker
immediately) and everything CPU-bound — decoding the FTMS flags/fields and
stepping the physics simulation — happens in `physicsWorker.js`. The worker
broadcasts ride state (~10 times/second); `main.js` extrapolates the rider's
position every animation frame using delta time, so motion stays smooth at any
display refresh rate even though updates from the worker arrive less often.

## The visuals: a low-spec-friendly underwater light tunnel

There's no avatar and no water shader. The rider "is" the camera, moving
first-person along the course centerline. The tube itself is a single
`THREE.InstancedMesh` of low-poly rings (one draw call for the whole 6km
course), so it stays cheap even on weak GPUs. Two independent visual layers
react to the ride, matching the original design brief:

- **Zone (position-based):** the course is split into thirds — a bright
  shallow reef, a dark shipwreck zone, and a hydrothermal/volcano zone late in
  the lap — each with its own fog/background color and billboard creatures
  (fish, jellyfish, glowing embers), crossfading smoothly at the boundaries.
  See `zoneColorAtDistance` / `ZONE_CREATURE_RECIPES` in `underwater.js`.
- **Effort (power-based):** the tunnel's rings glow deep blue at recovery
  power, flowing emerald at cruising power, and a fast violet-white pulse
  above ~300W. Only the ~50 rings nearest the rider are recolored each frame
  (the rest sit beyond the fog anyway), which keeps the per-frame cost low
  regardless of how long the course is. See `powerZoneParams` in
  `underwater.js`.

Billboard creatures use `THREE.Sprite` (always faces the camera) with tiny
`<canvas>`-drawn textures instead of any external image/model assets, so the
whole app has zero binary asset dependencies.

## Rider setup

The startup dialog now also asks for a **start distance (km)** — useful for
resuming partway around the loop. It's sent to the worker as
`startDistanceMeters` and wraps automatically if it exceeds the course length
(same modulo logic the course lookup already uses). Nothing is persisted
between sessions.

## Physics model

Speed is derived from power using a standard road-cycling force balance
(rolling resistance + gravity + aerodynamic drag vs. drivetrain power), stepped
with sub-stepped forward Euler integration each simulation tick. Constants used
(`src/physicsWorker.js`): rolling resistance coefficient 0.005, drag area
(CdA) 0.32 m², air density 1.225 kg/m³, drivetrain efficiency 97.5%. These are
reasonable road-bike defaults, not configurable per-rider yet — a natural next
step would be exposing them (or a "bike type" preset) alongside the weight
dialog.

## FTMS notes / things to verify against real hardware

- Indoor Bike Data (`0x2AD2`) parsing follows the flag layout in the Bluetooth
  FTMS spec, but I couldn't test this against a physical trainer here — if
  your device reports odd power/cadence values, check its actual flag
  combination with a BLE sniffer and compare against `parseIndoorBikeData`.
- Sending grade uses the "Set Indoor Bike Simulation Parameters" op code
  (`0x11`) after a Request Control (`0x00`) / Start-or-Resume (`0x07`)
  handshake. Some trainers are stricter about this sequence or the rolling/wind
  resistance coefficients than others; adjust `ble.js` if a specific trainer
  rejects the write.
- The 3-second silence watchdog only arms after a trainer has connected once,
  so it won't fire while you're just using the debug panel without a real
  device.
