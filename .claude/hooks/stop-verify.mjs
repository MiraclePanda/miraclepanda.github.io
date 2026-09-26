#!/usr/bin/env node
// Stop / SubagentStop フック。
// 作業ツリーにアプリソースの未コミット変更がある場合、終了前にフル検証(静的+スモークテスト)を行う。
// 失敗していればブロック(exit 2)して、完了宣言の前に修正させる。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
// 既にこのフックが原因で継続中なら、無限ループを避けて素通しする。
if (input.stop_hook_active) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const status = spawnSync('git', ['status', '--porcelain', '--', 'index.html', 'PandaCycleTrainer', 'harness'], {
  encoding: 'utf8',
  cwd: root,
});
if (status.status !== 0 || status.stdout.trim() === '') process.exit(0);

const r = spawnSync(process.execPath, [join(root, 'harness/verify.mjs')], { encoding: 'utf8', cwd: root });
if (r.status !== 0) {
  process.stderr.write(`[stop-verify] 未コミットの変更が検証に通りません。完了とする前に修正してください。\n${r.stderr}`);
  process.exit(2);
}
