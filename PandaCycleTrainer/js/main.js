import { App } from './ui/App.js';
import { ErrorBoundary, installGlobalErrorLogging } from './ui/ErrorBoundary.js';
import { prepareGpuBackend } from './three/gpuBackend.js';
import { loadGpuBackend } from './storage/prefs.js';

installGlobalErrorLogging();

// 景色を WebGPU で描くか(設定画面の「描画の方式」。既定は WebGL)を先に決めておく(走行画面を開くまでに決まっているように)
prepareGpuBackend(loadGpuBackend());

const rootEl = document.getElementById('root');
const root = ReactDOM.createRoot(rootEl);
root.render(React.createElement(ErrorBoundary, null, React.createElement(App)));
