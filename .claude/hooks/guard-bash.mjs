#!/usr/bin/env node
// PreToolUse(Bash) フック。本リポジトリは GitHub Pages で即公開されるため、
// 公開・履歴に影響する破壊的な git 操作をエージェントが単独で行わないようにする。

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const cmd = JSON.parse(raw || '{}').tool_input?.command ?? '';

const rules = [
  [/\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/, 'force push は禁止です(main は GitHub Pages の公開ブランチ)。'],
  [/\bgit\s+push\b[^\n]*\bmain\b/, 'main への直接 push は禁止です。ブランチを切って PR を作成してください。'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard は他エージェントの作業を消す恐れがあるため禁止です。'],
  [/\bgit\s+clean\s+-[a-z]*f/, 'git clean -f は禁止です。'],
  [/\bnpm\s+(i|install|init)\b|\byarn\s+add\b|\bpnpm\s+add\b/, 'ビルドツール・npm依存を追加しない方針です(CDN + ESモジュール構成)。必要ならユーザーに確認してください。'],
];

for (const [re, reason] of rules) {
  if (re.test(cmd)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }),
    );
    process.exit(0);
  }
}
