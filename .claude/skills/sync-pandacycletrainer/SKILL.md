---
name: sync-pandacycletrainer
description: 上流リポジトリ MiraclePanda/PandaCycleTrainer の最新版を PandaCycleTrainer/ ディレクトリへ同期するときに使う。
---

# PandaCycleTrainer ミラー同期

`PandaCycleTrainer/` は上流のアプリ本体(`index.html`, `css/`, `js/`)だけを配置したミラー。テスト・開発用設定は含めない。

## 手順
1. 作業ブランチを作成する(`git switch -c sync/pandacycletrainer-<上流短縮SHA>`)
2. 上流をスクラッチパッドに取得:
   `git clone --depth 20 https://github.com/MiraclePanda/PandaCycleTrainer.git <scratchpad>/pct`
3. `git -C <scratchpad>/pct log --oneline -20` で、`git log --oneline --grep='に同期' -1` の件名にある反映元コミット以降の変更を確認し、ユーザーに要約を示す
4. アプリ本体のみ同期(上流で消えたファイルも消す):
   `rsync -a --delete <scratchpad>/pct/index.html <scratchpad>/pct/css <scratchpad>/pct/js PandaCycleTrainer/`
   ※ 上流の構成が変わっていたら(ディレクトリ追加など)同期対象をユーザーに確認する
5. `js/three/three.js` の CDN URL が本番用(jsDelivr)のままであること、importmap が入っていないことを確認
6. `node harness/verify.mjs` を実行。上流の変更でスモークテストが落ちたら、テスト側の前提が古いのかアプリの不具合かを切り分けて報告
7. コミット件名を「PandaCycleTrainer を上流 <短縮SHA> に同期: <要旨>」にして反映元を記録する。README.md には上流リポジトリの URL・名前や反映元コミットを書かない(上流は非公開)。機能一覧に大きな変化があれば README の「主な機能」だけ更新
8. `git diff --stat` を示し、コミット/PR 作成はユーザーの了承を得てから
