// Control Point操作を直列実行するための汎用コマンドキュー。
// 「コマンド送信方式: Control Point操作はコマンドキュー化し、
//  逐次実行・応答待ちを保証する設計とする」(要件定義書 2章) に対応。
//
// 各コマンドは非同期関数 (async () => result) として登録し、
// 前のコマンドの応答待ちが完了してから次を実行する。
// 失敗時は指定回数までリトライし、それでも失敗したら破棄して次へ進む。

export class CommandQueue {
  /**
   * @param {object} opts
   * @param {number} [opts.maxRetries=3] 失敗時の最大リトライ回数
   * @param {number} [opts.retryDelayMs=250] リトライ間隔
   * @param {(err: Error, attempt: number) => void} [opts.onCommandError]
   * @param {() => void} [opts.onCommandDiscarded] 規定回数失敗しコマンドを破棄した時
   * @param {() => void} [opts.onCommandRecovered] 失敗状態から回復した時
   */
  constructor(opts = {}) {
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 250;
    this.onCommandError = opts.onCommandError ?? (() => {});
    this.onCommandDiscarded = opts.onCommandDiscarded ?? (() => {});
    this.onCommandRecovered = opts.onCommandRecovered ?? (() => {});
    this._queue = [];
    this._running = false;
    this._hadRecentFailure = false;
  }

  /**
   * コマンドをキューに積む。
   * @param {() => Promise<any>} task 実行する非同期処理
   * @param {object} [meta] ログ用のメタ情報
   * @returns {Promise<any>} 成功時はtaskの戻り値、破棄時はrejectする
   */
  enqueue(task, meta = {}) {
    return new Promise((resolve, reject) => {
      this._queue.push({ task, meta, resolve, reject });
      this._pump();
    });
  }

  /**
   * 同じkeyを持つ未実行のコマンドをキューから取り除いてから積む。
   * grade/ERG目標のように「常に最新の値だけ送れればよい」種類のコマンドで使う。
   * 実行中(先頭で応答待ち)のコマンドはキャンセルしない。
   */
  enqueueLatest(key, task, meta = {}) {
    this._queue = this._queue.filter((item) => {
      if (item.meta?.key === key) {
        item.reject(new Error('superseded by newer command'));
        return false;
      }
      return true;
    });
    return this.enqueue(task, { ...meta, key });
  }

  /** 未実行のコマンドを全て破棄する(緊急停止・切断時など) */
  clear() {
    const pending = this._queue.splice(0, this._queue.length);
    for (const p of pending) {
      p.reject(new Error('queue cleared'));
    }
  }

  async _pump() {
    if (this._running) return;
    this._running = true;
    while (this._queue.length > 0) {
      const item = this._queue.shift();
      await this._runWithRetry(item);
    }
    this._running = false;
  }

  async _runWithRetry(item) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await item.task();
        if (this._hadRecentFailure) {
          this._hadRecentFailure = false;
          this.onCommandRecovered();
        }
        item.resolve(result);
        return;
      } catch (err) {
        lastErr = err;
        this.onCommandError(err, attempt);
        if (attempt < this.maxRetries) {
          await delay(this.retryDelayMs);
        }
      }
    }
    // 規定回数失敗。このコマンドは破棄し、次の最新コマンドへ切り替える。
    this._hadRecentFailure = true;
    this.onCommandDiscarded(item.meta, lastErr);
    item.reject(lastErr ?? new Error('command failed'));
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
