# DC1 Virtual Ride

CYCPLUS DC1（パワー・速度・ケイデンス計測、負荷設定対応のミニエクササイズバイク）用の
バーチャルサイクリングWebアプリです。

## 特徴
- BLE FTMS (Web Bluetooth API) でCYCPLUS DC1と接続
- 仮想コースの勾配に応じた自動負荷制御（FTMS Simulation Parameters）
- 手動負荷制御（0〜100%、ライド中いつでも切替可能）
- 実測パワー・体重・自転車重量・コース勾配から仮想速度を物理シミュレーションで算出
- 2Dコースプロファイル表示 / 3D仮想空間表示（Three.js）
- トレーニング記録の保存（localStorage）・履歴閲覧
- TCXファイル書き出し（Stravaへの手動アップロード用）

## 使い方
`index.html` をダウンロードし、PCまたはAndroidのGoogle Chrome（またはMicrosoft Edge）で直接開いてください。
Web Bluetooth APIを使用するため、iOS Safariなど対応していないブラウザでは動作しません。
## PandaCycleTrainer
[`PandaCycleTrainer/`](PandaCycleTrainer/) には、[MiraclePanda/PandaCycleTrainer](https://github.com/MiraclePanda/PandaCycleTrainer) の最新版（React + ESモジュール構成、Three.jsによるリアルな3D街並み表示）を配置しています。
GitHub Pages上では `https://miraclepanda.github.io/PandaCycleTrainer/` から利用できます（HTTPS配信のためWeb Bluetoothがそのまま動作します）。

- 反映元コミット: `115dbdc`（2026-09-26「Rebuild the 3D city as a realistic streetscape」を含む）
- アプリ本体（`index.html`, `css/`, `js/`）のみを配置しており、テスト・開発用設定は含みません。
