import { h } from './h.js';

/**
 * 汎用の確認ダイアログ。ゴール到達確認・終了確認・再接続促進などに使用する。
 */
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, onConfirm, onCancel, danger }) {
  return h(
    'div',
    { className: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { className: 'modal-box' },
      h('h2', { className: 'modal-title' }, title),
      h('p', { className: 'modal-message' }, message),
      h(
        'div',
        { className: 'modal-actions' },
        cancelLabel &&
          h(
            'button',
            { className: 'btn btn-secondary', onClick: onCancel },
            cancelLabel
          ),
        h(
          'button',
          { className: danger ? 'btn btn-danger' : 'btn btn-primary', onClick: onConfirm },
          confirmLabel
        )
      )
    )
  );
}
