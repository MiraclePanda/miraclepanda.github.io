# PandaCycleTrainer

CYCPLUS DC1 などの FTMS 対応スマートトレーナーと Web Bluetooth で接続し、ブラウザ上の3Dコースを走るバーチャルサイクリング Web アプリです。

**▶ アプリを開く: https://miraclepanda.github.io/PandaCycleTrainer/**

## 使い方
1. PC または Android の Google Chrome(または Microsoft Edge)で上の URL を開きます。Web Bluetooth API を使うため、iOS Safari など対応していないブラウザでは動作しません。
2. セットアップ画面でコース・距離・体重などを選び、トレーナーに接続して走り始めます。トレーナーがなくても「デモ」で自動走行を試せます。
3. 走行後は結果画面から記録を保存し、TCX ファイルとして書き出して Strava などへ手動アップロードできます。

## 主な機能
- **トレーナー制御**: BLE FTMS で接続し、仮想コースの勾配に応じて負荷を自動制御(Simulation モード優先、非対応なら ERG モード)。負荷率は走行中に変更可能
- **物理シミュレーション**: 実測パワー・体重・自転車重量・勾配から、重力・転がり抵抗・空気抵抗の釣り合いで仮想速度を計算
- **コース**: 平坦(街並み)・丘陵(湖畔)・山岳・熱海サンビーチ(国道135号の海岸沿いを往復)・観光地(京都・奈良・富士山/河口湖)・竜宮城(海底)・上野不忍池(スワンボートで周回)の3D表示。熱海と観光地は国土交通省 PLATEAU と国土地理院のデータによる実在の街並み・地形
- **実在コース(GPX)**: Strava・RideWithGPS・Garmin Connect などの GPX を読み込んで走行。標高から勾配を計算し、経路どおりに曲がる道路とコーナー手前の減速を再現。位置情報は走行記録・TCX に含めない
- **走行中の表示**: フルスクリーン HUD(コースマップ・標高プロファイル・パワーゾーン・次の500mの勾配・通知)、時間帯と天候、視点(後方/目線/シネマ)、描画品質(自動/高/中/低/最高)
- **対戦・集団走行**: 自己ベストや友人の TCX とのゴースト対戦、仮想の集団走行とドラフティング
- **お楽しみ要素**: 沿道のハプニング、消費カロリーのグルメ換算、累計距離で進む日本縦断マップ、バイク種別(標準/スワンボート/ウミガメ)
- **記録**: 走行履歴の保存(IndexedDB)と TCX 書き出し

## このリポジトリについて
- GitHub Pages(`https://miraclepanda.github.io/`)の公開リポジトリです。`main` へのマージがそのまま本番公開になります。
- [`PandaCycleTrainer/`](PandaCycleTrainer/) は上流リポジトリ [MiraclePanda/PandaCycleTrainer](https://github.com/MiraclePanda/PandaCycleTrainer) のアプリ本体(`index.html`, `css/`, `js/`)のミラーです。テスト・開発用設定は含みません。詳しい仕様は上流の README を参照してください。
- 反映元コミット: `f3d4e12`(2026-11-03「観光地コース(京都・奈良・富士山/河口湖)を実在の街に作り直し、熱海の「実験」表記を外す(#27)」まで)
- 機能変更は原則として上流で行い、ここへは同期します(手順は `.claude/skills/sync-pandacycletrainer/SKILL.md`)。
- 熱海サンビーチと観光地コースの景色のデータ(`PandaCycleTrainer/js/data/*.json`)は上流の生成スクリプトが PLATEAU と国土地理院のデータから作ったもので、画面に出典を表示しています。
- `harness/` はエージェント用の検証ハーネスです(`node harness/verify.mjs`。公開対象外)。
- 開発初期に検証用として作った単一ファイル版「DC1 Virtual Ride」(旧ルート `index.html`)は削除しました。
