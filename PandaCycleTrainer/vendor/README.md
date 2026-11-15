# vendor/

アプリが読み込む外部ライブラリを、ビルドせずにそのまま同梱している(CDN の障害で起動しなくならないように)。

| ファイル | 版 | ライセンス |
|---|---|---|
| `react.production.min.js` / `react-dom.production.min.js` | React 18.3.1(UMD) | MIT(`LICENSE-react`) |
| `three/three.module.js` / `three/three.core.js` / `three/three.webgpu.js` | three.js r186(0.186.0、`build/`) | MIT(`three/LICENSE`) |

手で書き換えない。版を上げるときは `bash tools/update-vendor.sh <react の版> <three の版>` を実行する。
