#!/usr/bin/env node
// エージェント/人間共通の検証エントリポイント。ビルドツール・npm依存なし(Node 22+ 標準機能のみ)。
//
//   node harness/verify.mjs            # 静的チェック + スモークテスト
//   node harness/verify.mjs --static   # 静的チェックのみ(高速)
//
// 終了コード 0 = 全て合格。失敗時は原因を stderr に出力し 1 で終了する。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PCT = join(ROOT, 'PandaCycleTrainer');
const staticOnly = process.argv.includes('--static');

const failures = [];
const fail = (msg) => failures.push(msg);
const rel = (p) => relative(ROOT, p);

function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

// 1. PandaCycleTrainer の全 .js を ESM として構文チェック
//    注: Node 22 の `node --check x.js` はモジュール自動判定時に構文エラーを見逃すため、
//    stdin + --input-type=module で明示的に ESM としてパースする。
const checkModule = (code) =>
  spawnSync(process.execPath, ['--input-type=module', '--check'], { input: code, encoding: 'utf8' });
const jsFiles = walk(join(PCT, 'js'), (p) => p.endsWith('.js'));
for (const f of jsFiles) {
  const r = checkModule(readFileSync(f, 'utf8'));
  if (r.status !== 0) fail(`構文エラー: ${rel(f)}\n${r.stderr.trim().split('\n').slice(0, 4).join('\n')}`);
}

// 2. 相対 import の解決チェック + 依存方向ルール
//    (ble/physics/storage/utils/three は ui に依存してはならない)
const IMPORT_RE = /^\s*import\s[^'"]*['"]([^'"]+)['"]/gm;
for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  const layer = rel(f).split('/')[2]; // PandaCycleTrainer/js/<layer>/...
  for (const [, spec] of src.matchAll(IMPORT_RE)) {
    if (/^https?:/.test(spec)) {
      if (!rel(f).endsWith('js/three/three.js')) {
        fail(`CDN URL の直接 import は js/three/three.js のみ許可: ${rel(f)} -> ${spec}`);
      }
      continue;
    }
    if (!spec.startsWith('.')) {
      fail(`bare specifier は使用不可(importmap/バンドラなし): ${rel(f)} -> ${spec}`);
      continue;
    }
    const target = resolve(dirname(f), spec);
    if (!existsSync(target)) fail(`import 先が存在しない: ${rel(f)} -> ${spec}`);
    if (layer !== 'ui' && layer !== 'main.js' && rel(target).includes('/js/ui/')) {
      fail(`依存方向違反(${layer} -> ui): ${rel(f)} -> ${spec}`);
    }
  }
  // JSX 禁止(React.createElement = h() で記述する方針)
  if (/return\s*\(\s*<[A-Za-z]/.test(src) || /=\s*<[A-Z][A-Za-z]*[\s/>]/.test(src)) {
    fail(`JSX らしき記述を検出(h() で記述すること): ${rel(f)}`);
  }
}

// 3. importmap 禁止(サンドボックス環境で解決がブロックされるため)
for (const html of [join(PCT, 'index.html')]) {
  if (/type=["']importmap["']/.test(readFileSync(html, 'utf8'))) {
    fail(`importmap は使用禁止: ${rel(html)}`);
  }
}

// 4. ルートの単一ファイル版 (DC1 Virtual Ride) のインラインスクリプト構文チェック
{
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  scripts.forEach((code, i) => {
    const r = spawnSync(process.execPath, ['--input-type=commonjs', '--check'], { input: code, encoding: 'utf8' });
    if (r.status !== 0) fail(`構文エラー: index.html インラインscript #${i}\n${r.stderr.trim().split('\n').slice(0, 4).join('\n')}`);
  });
}

// 5. スモークテスト (node:test)
if (!staticOnly && failures.length === 0) {
  const tests = walk(join(ROOT, 'harness', 'tests'), (p) => p.endsWith('.test.mjs'));
  const r = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) fail(`スモークテスト失敗\n${r.stdout}\n${r.stderr}`);
  else {
    const summary = r.stdout.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l)).join(' / ');
    console.log(`tests: ${summary}`);
  }
}

if (failures.length) {
  console.error(`\n✗ verify 失敗 (${failures.length}件)\n`);
  for (const m of failures) console.error(`- ${m}\n`);
  process.exit(1);
}
console.log(`✓ verify OK (${jsFiles.length} modules${staticOnly ? ', static only' : ''})`);
