# AGENTS.md — エージェント共通ガイド

このリポジトリで作業する全ての AI エージェント(Claude Code / Codex / その他)と人間向けの共通ルール。
Claude Code 固有の設定は `CLAUDE.md` と `.claude/` を参照。

## 1. リポジトリの正体

GitHub Pages (`https://miraclepanda.github.io/`) の公開リポジトリ。**main へのマージ = 即本番公開**。

| パス | 内容 | 構成 |
|---|---|---|
| `index.html` | **DC1 Virtual Ride**(旧版)。1ファイル完結 | 素の JS + Three.js r160 (UMD, jsDelivr) / localStorage |
| `PandaCycleTrainer/` | **PandaCycleTrainer**(新版)。上流 `MiraclePanda/PandaCycleTrainer` のミラー | React 18 UMD(unpkg) + ES モジュール + Three.js r186(ESM, jsDelivr) / IndexedDB |
| `harness/` | エージェント用の検証ハーネス(公開対象外) | Node 22 標準機能のみ |

どちらも CYCPLUS DC1 等の FTMS スマートトレーナーに Web Bluetooth で接続する仮想サイクリングアプリ。
Chrome / Edge(PC・Android)のみ対応、HTTPS か localhost が必須。

> ⚠️ `PandaCycleTrainer/` は上流リポジトリのミラー(README に反映元コミットを記載)。
> 機能変更は原則として上流で行い、ここへは同期する。ここで直接直す場合は README の反映元情報と
> 上流への還元方法をユーザーに確認すること。

## 2. PandaCycleTrainer のアーキテクチャ

```
index.html ─ React/ReactDOM (UMD, グローバル) ─ js/main.js ─ ui/App.js
                                                              │
  ui/  (画面: Setup → Ride → Result / History, Dashboard, CityScene=3D描画)
   │ 依存してよい ↓            ↑ 依存してはならない(verify が検査)
  ble/      FTMS クライアント, Control Point コマンドキュー, DeviceProfile(実機依存値)
  physics/  物理演算(力の釣り合い+時間積分), コース勾配エンジン, コースプロファイル
  three/    Three.js 窓口(three.js), 街並みの決定的生成(cityLayout), 道路標高, マテリアル
  storage/  IndexedDB 履歴, prefs(localStorage), TCX 書き出し
  utils/    format, validation, wakeLock
```

コード中の「要件定義書 N章」は上流リポジトリの要件定義書を指す。コメントの設計根拠を尊重すること。

## 3. 絶対に守る制約

1. **ビルドツールなし**。npm 依存・バンドラ・トランスパイラを導入しない。JSX 禁止 — `ui/h.js` の `h()` (= `React.createElement`) で書く。
2. **importmap 禁止**。一部サンドボックス環境でブロックされるため。外部 CDN URL を直接 import してよいのは `js/three/three.js` だけ。
3. **依存方向**: `ble / physics / three / storage / utils` から `ui/` を import しない。
4. **実機依存値は `ble/deviceProfile.js` に集約**(TODO(要実機確認) 付きの暫定値)。他ファイルに実機固有の数値をハードコードしない。
5. **物理定数は `physics/physicsConstants.js`**。ユーザー入力項目にしない。
6. **TCX に GPS 座標 (`<Position>`) を入れない**(ダミー座標による偽装もしない)。
7. `cityLayout.js` の生成は **seed による決定的生成** を維持する(同じ blockIndex → 同じ結果)。
8. UI 文言・コメントは日本語。既存のコメント密度と文体に合わせる。

## 4. 検証コマンド

```bash
node harness/verify.mjs           # 静的チェック + スモークテスト(必ず完了前に実行)
node harness/verify.mjs --static  # 構文・import解決・依存方向・JSX/importmap 検査のみ(~1秒)
python3 -m http.server 8000       # 実ブラウザ確認: http://localhost:8000/PandaCycleTrainer/
```

- スモークテストは `harness/tests/*.test.mjs`(`node:test`)。DOM/BLE/Three.js に依存しない純粋ロジック
  (physics, course, commandQueue, tcx, format, validation, cityLayout, roadElevation)を対象にする。
- 純粋ロジックを変更・追加したら対応するテストも追加・更新する。
- BLE 実機・3D 描画はヘッドレスでは検証できない。該当変更では「未検証項目」として報告し、手動確認手順を添える。

## 5. マルチエージェント運用

### 所有範囲(並列作業時の衝突回避)

| エージェント | 書き込み可 | 主な責務 |
|---|---|---|
| `ble-ftms-engineer` | `PandaCycleTrainer/js/ble/**` | FTMS プロトコル, コマンドキュー, 接続シーケンス |
| `physics-engineer` | `PandaCycleTrainer/js/physics/**` | 物理演算, コース勾配, コースプロファイル |
| `scene3d-engineer` | `PandaCycleTrainer/js/three/**`, `js/ui/CityScene.js` | 3D 街並み, 描画パフォーマンス |
| `ui-engineer` | `PandaCycleTrainer/js/ui/**`(CityScene除く), `js/main.js`, `css/**`, `PandaCycleTrainer/index.html` | 画面・状態遷移・スタイル |
| `data-engineer` | `PandaCycleTrainer/js/storage/**`, `js/utils/**` | 履歴保存, TCX, 入力検証, 表示フォーマット |
| `legacy-dc1-maintainer` | ルート `index.html` | 旧版 DC1 Virtual Ride の保守 |
| `harness-engineer` | `harness/**`, `.claude/**`, `AGENTS.md`, `CLAUDE.md` | 検証ハーネス・エージェント基盤 |
| `verifier` | (読み取り専用) | 検証の実行と合否報告 |
| `code-reviewer` | (読み取り専用) | 差分レビュー |

- 所有範囲外のファイル変更が必要になったら、**自分で編集せず**オーケストレーターに「インターフェース変更要求」として返す。
- 層をまたぐインターフェース(例: `FtmsClient` のイベント名、`PhysicsEngine.step()` の戻り値、ライド記録 `record` のスキーマ)を変える場合は、
  オーケストレーターが先に契約を決め、各担当に同じ契約を渡してから並列化する。

### 標準フロー

1. **Plan** — オーケストレーター(メインセッション)が要求を所有範囲ごとのタスクに分解し、層間の契約を明文化。
2. **Implement** — 独立タスクは並列、依存があるものは契約確定後に並列/逐次。
3. **Verify** — `verifier` が `node harness/verify.mjs` を実行し、必要ならブラウザ確認手順を列挙。
4. **Review** — `code-reviewer` が差分を制約(§3)と正しさの観点でレビュー。
5. **Integrate** — 指摘を反映 → 再検証 → ブランチ + PR(main 直 push 禁止)。

### 完了報告フォーマット(全エージェント共通)

```
## 結果: 完了 | 一部完了 | ブロック
- 変更ファイル: <path> — <要旨>
- 検証: <実行したコマンドと結果>
- 未検証: <実機BLE・3D描画など、確認できなかった点と手動確認手順>
- 所有範囲外への変更要求: <あれば>
```
