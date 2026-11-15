import { h } from './h.js';

/**
 * 画面全体の Error Boundary(レビュー Q8)。描画中の例外で画面が真っ白にならないよう、原因と
 * 「再読み込み」を出す。走行中なら、走行の下書き(30秒ごとの途中保存)が残っているので、
 * 再読み込み後にセットアップ画面で保存し直せる。
 * React の Error Boundary はクラス部品でしか書けないので、ここだけ class で書く(JSX は使わない)。
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('画面の表示中にエラーが起きました:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return h(
      'div', { className: 'screen error-screen', role: 'alert' },
      h('h1', null, 'エラーが起きました'),
      h('p', null, '画面を表示できなくなりました。再読み込みしてください。'),
      h('p', { className: 'muted small' }, '走行中だった場合は、30秒ごとに途中保存した記録が残っています。再読み込みのあと、保存するかどうかを尋ねます。'),
      h('pre', { className: 'error-detail' }, String(error?.message ?? error)),
      h('button', { className: 'btn btn-primary', onClick: () => window.location.reload() }, '再読み込み')
    );
  }
}

/**
 * React の外(イベント・Promise)で捕まらなかった例外を記録する。画面は止めない
 * (描画のループや BLE のコールバックの例外で、走行そのものを止めないように)。
 */
export function installGlobalErrorLogging() {
  window.addEventListener('error', (ev) => {
    console.error('捕まらなかったエラー:', ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    console.error('処理されなかった Promise の失敗:', ev.reason);
  });
}
