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
[`PandaCycleTrainer/`](PandaCycleTrainer/) には、[MiraclePanda/PandaCycleTrainer](https://github.com/MiraclePanda/PandaCycleTrainer) の最新版（React + ESモジュール構成、Three.jsによる3D表示）を配置しています。
GitHub Pages上では `https://miraclepanda.github.io/PandaCycleTrainer/` から利用できます（HTTPS配信のためWeb Bluetoothがそのまま動作します）。
詳しい仕様は上流リポジトリの README を参照してください。

### 主な機能
- **コース**: 平坦（街並み）・丘陵（湖畔）・山岳・熱海サンビーチ・上野不忍池（スワンボートで反時計回りに周回）の3D表示。道路はカーブし、景色も道路形状に沿う
- **実在コース（GPX）**: Strava・RideWithGPS・Garmin Connect などの GPX を読み込んで保存・走行。標高から勾配を計算し、標高断面を表示。走行距離はコース全長まで、景色（街並み・湖畔・山岳）は自動選択・変更可。経路どおりに曲がる道路と、コーナー手前で曲がれる速度まで減速する挙動を再現（トレーナーの負荷は変えない）。位置情報は走行記録・TCX に含めない
- **走行中の表示**: フルスクリーン HUD（コースマップ・標高プロファイル・パワーゾーン・次の500mの勾配・通知）、時間帯（朝/昼/夕方/夜）と天候（晴れ/くもり/雨/霧）、視点（後方/目線/シネマ）、描画品質（自動/高/中/低）
- **対戦・集団走行**: 自己ベストや友人の TCX とのゴースト対戦、仮想の5人の集団走行とドラフティング
- **その他**: デモ走行（トレーナー不要の自動走行）、バイク種別（標準/スワンボート）、詳細設定（転がり抵抗・空気抵抗係数・FTP）、セットアップの選択と負荷率の記憶（変更した時点で保存）

### ミラーについて
- 反映元コミット: `c888b2d`（2026-10-31 上流 PR #23「コース選択のタイル化・熱海の「最高(実験)」描画・走行後も接続を維持」のブランチ。上流マージ後にマージコミットへ更新）
- アプリ本体（`index.html`, `css/`, `js/`）のみを配置しており、テスト・開発用設定は含みません。
- 機能変更は原則として上流で行い、ここへは同期します（手順は `.claude/skills/sync-pandacycletrainer/SKILL.md`）。
- `harness/` はエージェント用の検証ハーネスです（`node harness/verify.mjs`。公開対象外）。
