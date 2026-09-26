@AGENTS.md

# Claude Code 固有の設定

## ハーネス (`.claude/settings.json`)

| フック | 動作 |
|---|---|
| PreToolUse(Bash) `guard-bash.mjs` | force push / main への push / `reset --hard` / `clean -f` / npm 依存追加を拒否 |
| PostToolUse(Edit/Write) `post-edit-check.mjs` | アプリソース編集直後に `verify.mjs --static`。失敗時はエラーを返して即修正させる |
| Stop / SubagentStop `stop-verify.mjs` | 未コミット変更があればフル検証。失敗なら完了させない |

フックに止められた場合は回避策を探さず、原因を直すかユーザーに確認する。

## サブエージェント (`.claude/agents/`)

AGENTS.md §5 の所有範囲表に対応する。メインセッションがオーケストレーターを務め、
複数領域にまたがる作業は `/orchestrate` スキルの手順で分解・委譲する。

- 委譲時のプロンプトには **目的・所有範囲・層間の契約・完了条件** を必ず含める(サブエージェントは会話履歴を持たない)。
- 同じファイルを複数のサブエージェントに同時に編集させない。
- サブエージェントの報告は鵜呑みにせず、`node harness/verify.mjs` と `git diff` で確認してからユーザーに伝える。

## スキル (`.claude/skills/`)

- `/orchestrate <要求>` — マルチエージェントでの計画→実装→検証→レビュー
- `/sync-pandacycletrainer` — 上流 PandaCycleTrainer からのミラー同期
- `/browser-check` — ローカルサーバーでの実ブラウザ確認手順
