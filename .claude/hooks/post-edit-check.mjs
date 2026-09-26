#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) フック。
// アプリのソース(.js / .html)が編集されたら静的検証を走らせ、失敗時は exit 2 で
// エラー内容をエージェントにフィードバックする(その場で修正させる)。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');
const file = input.tool_input?.file_path ?? '';
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();

const isAppSource = /\/PandaCycleTrainer\/.*\.(js|html)$/.test(file) || file === join(root, 'index.html');
if (!isAppSource) process.exit(0);

const r = spawnSync(process.execPath, [join(root, 'harness/verify.mjs'), '--static'], { encoding: 'utf8', cwd: root });
if (r.status !== 0) {
  process.stderr.write(`[post-edit-check] 静的検証に失敗しました。修正してください。\n${r.stderr}`);
  process.exit(2);
}
