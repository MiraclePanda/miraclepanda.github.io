---
name: browser-check
description: UI・3D 描画・画面遷移の変更を実ブラウザで確認するとき、またはユーザー向けの手動確認手順を作るときに使う。
---

# 実ブラウザ確認

ES モジュールは `file://` では読み込めないため、必ずローカル HTTP サーバー経由で開く。localhost はセキュアコンテキスト扱いなので Web Bluetooth も有効。

## 起動
```bash
python3 -m http.server 8000   # リポジトリ直下で。run_in_background を使う
```
- 新版: http://localhost:8000/PandaCycleTrainer/
- 旧版: http://localhost:8000/

## 確認できること(ブラウザ操作ツールがある場合)
- コンソールにエラーがないこと(特に CDN の import 失敗、React の警告)
- セットアップ画面の入力検証(範囲外の体重・距離でメッセージが出る)
- 履歴画面の表示、TCX ダウンロード
- 3D 表示: ネットワーク越しに Three.js を取得するためオフライン環境では失敗する点に注意

## 確認できないこと
- BLE 実機接続(`navigator.bluetooth.requestDevice` はユーザー操作と実機が必要)
  → ユーザー向けに「Chrome で開く → 接続 → DC1 を選択 → ペダルを回して速度/パワー表示と勾配による負荷変化を確認」の手順を報告する

## 後片付け
確認後はサーバーを停止する。
