// debugPanel.js
// Lets a developer drive the simulation without a real trainer: sliders for
// power/cadence, plus keyboard shortcuts. Emits the same shape of data the
// worker would derive from real BLE packets, via onChange({power, cadence}).

export class DebugPanel {
  constructor({ container, onChange }) {
    this.onChange = onChange;
    this.power = 150;
    this.cadence = 80;
    this.visible = false;

    this.root = document.createElement("div");
    this.root.className = "debug-panel";
    this.root.hidden = true;
    this.root.innerHTML = `
      <h2>Mock sensor</h2>
      <p class="debug-hint">Up/Down arrows adjust power. Left/Right adjust cadence. Press D to hide this panel.</p>
      <label class="debug-row">
        <span>Power</span>
        <input type="range" min="0" max="500" step="5" value="${this.power}" data-role="power" />
        <output data-role="power-out">${this.power} W</output>
      </label>
      <label class="debug-row">
        <span>Cadence</span>
        <input type="range" min="0" max="150" step="1" value="${this.cadence}" data-role="cadence" />
        <output data-role="cadence-out">${this.cadence} rpm</output>
      </label>
    `;
    container.appendChild(this.root);

    this.powerInput = this.root.querySelector('[data-role="power"]');
    this.cadenceInput = this.root.querySelector('[data-role="cadence"]');
    this.powerOut = this.root.querySelector('[data-role="power-out"]');
    this.cadenceOut = this.root.querySelector('[data-role="cadence-out"]');

    this.powerInput.addEventListener("input", () => {
      this.power = Number(this.powerInput.value);
      this._emit();
    });
    this.cadenceInput.addEventListener("input", () => {
      this.cadence = Number(this.cadenceInput.value);
      this._emit();
    });

    window.addEventListener("keydown", (event) => this._handleKey(event));
  }

  _handleKey(event) {
    if (event.key === "d" || event.key === "D") {
      this.toggle();
      return;
    }
    if (!this.visible) return;

    const step = event.shiftKey ? 25 : 5;
    switch (event.key) {
      case "ArrowUp":
        this.power = Math.min(500, this.power + step);
        break;
      case "ArrowDown":
        this.power = Math.max(0, this.power - step);
        break;
      case "ArrowRight":
        this.cadence = Math.min(150, this.cadence + 2);
        break;
      case "ArrowLeft":
        this.cadence = Math.max(0, this.cadence - 2);
        break;
      default:
        return;
    }
    event.preventDefault();
    this.powerInput.value = String(this.power);
    this.cadenceInput.value = String(this.cadence);
    this._emit();
  }

  _emit() {
    this.powerOut.textContent = `${this.power} W`;
    this.cadenceOut.textContent = `${this.cadence} rpm`;
    this.onChange({ power: this.power, cadence: this.cadence });
  }

  toggle(force) {
    this.visible = force !== undefined ? force : !this.visible;
    this.root.hidden = !this.visible;
  }

  /** Call once when enabled so downstream state has an initial value. */
  emitInitial() {
    this._emit();
  }
}
