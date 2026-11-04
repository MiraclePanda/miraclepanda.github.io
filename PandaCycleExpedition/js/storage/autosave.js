// 走行中の自動保存(設計書5章): 30秒ごと、出来事の後、ライド終了時。
//
// 保存は TripStore#save に任せ、ここは「いつ保存するか」だけを持つ。保存が重なったときは
// 後から来た分を1回にまとめ(最新の状態だけ保存すればよいため)、失敗しても走行は止めない
// (lastError に残して次の機会にまた保存する)。タイマーは差し替えられる(テスト用)。

export const AUTOSAVE_INTERVAL_MS = 30_000;

export class AutoSaver {
  /**
   * @param {object} o
   * @param {{save:(trip:object, kind:string)=>Promise<any>}} o.store
   * @param {()=>object} o.getTrip 保存する時点の旅の状態を返す
   * @param {number} [o.intervalMs]
   * @param {{setInterval:Function, clearInterval:Function}} [o.timers]
   */
  constructor({ store, getTrip, intervalMs = AUTOSAVE_INTERVAL_MS, timers = globalThis }) {
    this.store = store;
    this.getTrip = getTrip;
    this.intervalMs = intervalMs;
    this.timers = timers;
    this._timer = null;
    this._running = null; // 保存中の Promise
    this._pendingKind = null; // 保存中に頼まれた次の保存の種類
    this.lastSavedAt = null;
    this.lastError = null;
    this.saveCount = 0;
  }

  start() {
    if (this._timer !== null) return;
    this._timer = this.timers.setInterval(() => { this.saveNow('auto'); }, this.intervalMs);
  }

  /** タイマーを止める。最後に保存したいときは stop() の前に saveNow('rideEnd') を待つ。 */
  stop() {
    if (this._timer === null) return;
    this.timers.clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * すぐ保存する(出来事の後は 'event'、ライド終了は 'rideEnd'、その日の終わりは 'dayEnd')。
   * 保存中なら終わった後にもう1回だけ保存する。'auto' より重要な種類を優先して残す。
   * @returns {Promise<void>} この依頼の分が保存し終わったら解決する(失敗しても reject しない)
   */
  saveNow(kind = 'auto') {
    if (this._running) {
      if (!this._pendingKind || rank(kind) > rank(this._pendingKind)) this._pendingKind = kind;
      return this._running.then(() => this._next ?? undefined);
    }
    this._running = this._doSave(kind).finally(() => {
      this._running = null;
      const k = this._pendingKind;
      this._pendingKind = null;
      this._next = k ? this.saveNow(k) : null;
    });
    return this._running;
  }

  async _doSave(kind) {
    try {
      await this.store.save(this.getTrip(), kind);
      this.lastSavedAt = Date.now();
      this.lastError = null;
      this.saveCount++;
    } catch (e) {
      this.lastError = e;
    }
  }
}

const RANKS = { auto: 0, event: 1, rideEnd: 2, dayEnd: 3, import: 3 };
const rank = (k) => RANKS[k] ?? 0;
