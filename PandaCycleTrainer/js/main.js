import { App } from './ui/App.js';
import { prepareGpuBackend } from './three/gpuBackend.js';

// 景色を WebGPU で描けるかを先に調べておく(走行画面を開くまでに決まっているように)
prepareGpuBackend();

const rootEl = document.getElementById('root');
const root = ReactDOM.createRoot(rootEl);
root.render(React.createElement(App));
