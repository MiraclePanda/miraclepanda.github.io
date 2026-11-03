// React.createElement のショートハンド。ビルドツール(JSX変換)を使わない方針のため、
// 本アプリのコンポーネントは全てこのhelperで記述する。
export const h = React.createElement;
export const useState = React.useState;
export const useEffect = React.useEffect;
export const useRef = React.useRef;
export const useCallback = React.useCallback;
export const useMemo = React.useMemo;
