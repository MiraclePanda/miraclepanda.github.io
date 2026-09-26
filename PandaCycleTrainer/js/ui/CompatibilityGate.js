import { h } from './h.js';

/**
 * 起動時互換性チェック。
 * 要件定義書1章「navigator.bluetoothの有無を起動時にチェックし、
 * 非対応ブラウザには日本語ガイダンス画面を表示、機能を無効化する」に対応。
 */
export function isBluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export function isSecureContextOk() {
  return typeof window !== 'undefined' && window.isSecureContext;
}

export function UnsupportedGuidance() {
  return h(
    'div',
    { className: 'guidance-screen' },
    h('h1', null, 'PandaCycleTrainer'),
    h('div', { className: 'guidance-box' },
      h('h2', null, 'ご利用のブラウザ・環境では動作できません'),
      !isSecureContextOk() &&
        h(
          'p',
          null,
          'このアプリはHTTPS配信、または localhost での起動が必要です。',
          h('br'),
          'file:// を直接開いた場合は動作しません(Web Bluetooth APIのセキュアコンテキスト制約)。'
        ),
      !isBluetoothSupported() &&
        h(
          'div',
          null,
          h('p', null, 'このブラウザはWeb Bluetooth APIに対応していません。'),
          h('p', null, '以下の環境でお試しください:'),
          h(
            'ul',
            null,
            h('li', null, 'デスクトップ: Windows / macOS / Linux の Google Chrome または Microsoft Edge'),
            h('li', null, 'モバイル: Android の Google Chrome')
          ),
          h(
            'p',
            { className: 'guidance-note' },
            '※ iOS(Safariを含む)は、Web Bluetooth APIに対応していないため非対応です。'
          )
        )
    )
  );
}
