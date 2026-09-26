// Screen Wake Lock APIラッパー。
// 要件定義書5章「走行セッション中(一時停止中は解除)は画面スリープを防止する」に対応。

export class WakeLockManager {
  constructor() {
    this._sentinel = null;
    this._wanted = false;
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  get isSupported() {
    return 'wakeLock' in navigator;
  }

  async enable() {
    this._wanted = true;
    if (!this.isSupported) return;
    try {
      this._sentinel = await navigator.wakeLock.request('screen');
      this._sentinel.addEventListener('release', () => {
        this._sentinel = null;
      });
    } catch (e) {
      // 非表示タブなど取得できない状況では静かに諦める。
      this._sentinel = null;
    }
  }

  async disable() {
    this._wanted = false;
    if (this._sentinel) {
      try {
        await this._sentinel.release();
      } catch (e) {
        /* noop */
      }
      this._sentinel = null;
    }
  }

  async _onVisibilityChange() {
    if (this._wanted && document.visibilityState === 'visible' && !this._sentinel) {
      await this.enable();
    }
  }
}
