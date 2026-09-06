// ble.js
// Web Bluetooth is only available on the main thread (there is no
// WorkerNavigator.bluetooth), so the GATT connection necessarily lives here.
// This module's only job is to open the connection, hand raw notification
// bytes off immediately, and write control-point commands. All interpretation
// of the bytes (FTMS flag parsing, physics) happens in physicsWorker.js.

const FTMS_SERVICE = 0x1826;
const CHAR_INDOOR_BIKE_DATA = 0x2ad2;
const CHAR_CONTROL_POINT = 0x2ad9;
const CHAR_MACHINE_STATUS = 0x2ada;

const OPCODE_REQUEST_CONTROL = 0x00;
const OPCODE_START_RESUME = 0x07;
const OPCODE_SET_SIM_PARAMS = 0x11;
const OPCODE_RESPONSE_CODE = 0x80;

export class FtmsClient {
  /**
   * @param {object} callbacks
   * @param {(buffer: ArrayBuffer) => void} callbacks.onRawIndoorBikeData
   * @param {() => void} callbacks.onDisconnected
   * @param {(msg: string) => void} [callbacks.onLog]
   */
  constructor({ onRawIndoorBikeData, onDisconnected, onLog }) {
    this.onRawIndoorBikeData = onRawIndoorBikeData;
    this.onDisconnected = onDisconnected;
    this.onLog = onLog || (() => {});
    this.device = null;
    this.controlPointChar = null;
    this.controlHasBeenGranted = false;
    this._pendingControlResolve = null;
  }

  get isConnected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  get deviceName() {
    return this.device ? this.device.name || "Unnamed trainer" : null;
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error(
        "Web Bluetooth is not available in this browser. Use Chrome or Edge over HTTPS or localhost."
      );
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }],
      optionalServices: [FTMS_SERVICE],
    });

    this.device.addEventListener("gattserverdisconnected", () => {
      this.onLog("Trainer disconnected.");
      this.controlHasBeenGranted = false;
      this.onDisconnected();
    });

    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(FTMS_SERVICE);

    const bikeDataChar = await service.getCharacteristic(CHAR_INDOOR_BIKE_DATA);
    await bikeDataChar.startNotifications();
    bikeDataChar.addEventListener("characteristicvaluechanged", (event) => {
      // Copy the bytes out of the DataView's buffer so we hand the worker a
      // clean, transferable ArrayBuffer rather than a view the browser may reuse.
      const copy = event.target.value.buffer.slice(0);
      this.onRawIndoorBikeData(copy);
    });

    this.controlPointChar = await service.getCharacteristic(CHAR_CONTROL_POINT);
    await this.controlPointChar.startNotifications();
    this.controlPointChar.addEventListener("characteristicvaluechanged", (event) => {
      this._handleControlPointResponse(event.target.value);
    });

    try {
      const statusChar = await service.getCharacteristic(CHAR_MACHINE_STATUS);
      await statusChar.startNotifications();
    } catch {
      // Machine Status characteristic is optional; ignore if unavailable.
    }

    await this._requestControl();

    this.onLog(`Connected to ${this.deviceName}.`);
    return this.deviceName;
  }

  disconnect() {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }

  _handleControlPointResponse(dataView) {
    if (dataView.getUint8(0) !== OPCODE_RESPONSE_CODE) return;
    const requestOpcode = dataView.getUint8(1);
    const resultCode = dataView.getUint8(2); // 1 = success
    if (this._pendingControlResolve) {
      this._pendingControlResolve({ requestOpcode, resultCode });
      this._pendingControlResolve = null;
    }
  }

  _awaitControlResponse(timeoutMs = 2000) {
    return new Promise((resolve) => {
      this._pendingControlResolve = resolve;
      setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
  }

  async _requestControl() {
    if (!this.controlPointChar) return;
    const waiter = this._awaitControlResponse();
    await this.controlPointChar.writeValueWithResponse(
      Uint8Array.of(OPCODE_REQUEST_CONTROL)
    );
    const result = await waiter;
    this.controlHasBeenGranted = !result.timedOut && result.resultCode === 1;

    // Some trainers additionally expect a Start/Resume before they accept
    // simulation parameters; harmless to send even if not required.
    try {
      await this.controlPointChar.writeValueWithResponse(
        Uint8Array.of(OPCODE_START_RESUME)
      );
    } catch {
      // Non-fatal: proceed even if the trainer rejects/ignores this.
    }
  }

  /**
   * Sends the current course grade to the trainer so it can adjust
   * resistance to match. Values follow the FTMS "Set Indoor Bike Simulation
   * Parameters" op code (0x11).
   * @param {number} gradePercent e.g. 6.5 for 6.5% uphill, -3 for -3% downhill
   */
  async setSimulationGrade(gradePercent) {
    if (!this.controlPointChar || !this.isConnected) return;

    const windSpeedMps = 0;
    const rollingResistance = 0.004; // matches typical asphalt Crr used by trainers
    const windResistance = 0.51;     // kg/m, generic CdA-equivalent trainers expect here

    const buffer = new ArrayBuffer(7);
    const view = new DataView(buffer);
    view.setUint8(0, OPCODE_SET_SIM_PARAMS);
    view.setInt16(1, Math.round(windSpeedMps * 1000), true);       // 0.001 m/s
    view.setInt16(3, Math.round(gradePercent * 100), true);        // 0.01 %
    view.setUint8(5, Math.round(rollingResistance * 10000));       // 0.0001
    view.setUint8(6, Math.round(windResistance * 100));            // 0.01 kg/m

    try {
      await this.controlPointChar.writeValueWithResponse(new Uint8Array(buffer));
    } catch (err) {
      this.onLog(`Failed to send grade to trainer: ${err.message}`);
    }
  }
}
